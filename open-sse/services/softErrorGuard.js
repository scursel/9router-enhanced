/**
 * Soft-error guard: a 2xx whose assistant text is an upstream error notice.
 *
 * Used as the combo loop's `shouldContinueOnSuccess` policy for chat combos:
 * a match makes the combo try its next member instead of handing the notice
 * to the client. The response the client finally gets is untouched — the
 * guard only reads a clone.
 *
 * Streams are peeked: the guard reads the first `leadChars` of text (or the
 * whole answer if it ends sooner) and stops at the first reasoning/tool-call
 * signal, which only a working model sends. Fail-open: any error, timeout or
 * unknown shape means "not a soft error".
 */
import { SOFT_ERROR_GUARD, SOFT_ERROR_PATTERNS } from "../config/softErrorConfig.js";

const COMPILED = SOFT_ERROR_PATTERNS.map(([label, source]) => ({ label, re: new RegExp(source, "i") }));
const TIMED_OUT = Symbol("timedOut");

/**
 * @param {string} text - assistant text (content only, never reasoning)
 * @param {{complete?: boolean}} [opts] - complete=false when only a prefix was read
 * @returns {{pattern: string, snippet: string} | null}
 */
export function detectSoftError(text, { complete = true } = {}) {
  if (typeof text !== "string" || !text) return null;
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  const anywhere = complete && flat.length < SOFT_ERROR_GUARD.maxChars;
  let best = null;
  for (const { label, re } of COMPILED) {
    const match = re.exec(flat);
    if (!match || (!anywhere && match.index > SOFT_ERROR_GUARD.leadChars)) continue;
    if (!best || match.index < best.index) best = { index: match.index, label };
  }
  if (!best) return null;
  const start = Math.max(0, best.index - 40);
  return { pattern: best.label, snippet: flat.slice(start, start + SOFT_ERROR_GUARD.snippetChars) };
}

function partsText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((p) => (p && typeof p.text === "string" && (!p.type || p.type === "text" || p.type === "output_text") ? p.text : "")).join("");
}

/**
 * Visible text of one response document or stream event, in any client
 * format the router emits (OpenAI chat, Claude messages, Responses, Gemini).
 * `other` flags reasoning / tool calls; `done` flags a terminal event.
 */
export function extractVisibleText(obj) {
  const none = { text: "", other: false, done: false };
  if (!obj || typeof obj !== "object") return none;

  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  if (choice && typeof choice === "object") {
    const m = choice.delta || choice.message || {};
    const other = !!(m.reasoning_content || m.reasoning || (Array.isArray(m.tool_calls) && m.tool_calls.length) || m.function_call);
    return { text: partsText(m.content), other, done: !!choice.finish_reason };
  }

  switch (obj.type) {
    case "content_block_start": {
      const kind = obj.content_block?.type;
      return { text: kind === "text" ? obj.content_block.text || "" : "", other: !!kind && kind !== "text", done: false };
    }
    case "content_block_delta": {
      const kind = obj.delta?.type;
      return { text: kind === "text_delta" ? obj.delta.text || "" : "", other: !!kind && kind !== "text_delta", done: false };
    }
    case "message_stop":
      return { ...none, done: true };
    case "message_delta":
      return { ...none, done: !!obj.delta?.stop_reason };
    case "message":
      if (Array.isArray(obj.content)) {
        return {
          text: partsText(obj.content),
          other: obj.content.some((b) => b?.type && b.type !== "text"),
          done: true,
        };
      }
      return none;
    case "response.output_text.delta":
      return { text: typeof obj.delta === "string" ? obj.delta : "", other: false, done: false };
    default:
      break;
  }
  if (typeof obj.type === "string" && obj.type.startsWith("response.")) {
    return { text: "", other: /reasoning|function_call|tool/.test(obj.type), done: obj.type === "response.completed" };
  }

  if (obj.object === "response" && Array.isArray(obj.output)) {
    const other = obj.output.some((item) => item?.type && item.type !== "message");
    const text = obj.output.filter((item) => item?.type === "message").map((item) => partsText(item.content)).join("");
    return { text, other, done: true };
  }

  const candidate = Array.isArray(obj.candidates) ? obj.candidates[0] : null;
  if (candidate && typeof candidate === "object") {
    const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    return {
      text: parts.filter((p) => !p?.thought && typeof p?.text === "string").map((p) => p.text).join(""),
      other: parts.some((p) => p?.thought || p?.functionCall),
      done: !!candidate.finishReason,
    };
  }
  return none;
}

async function readWithin(reader, ms) {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Read the start of an SSE clone: text so far, whether it is the whole answer. */
async function peekStream(response) {
  const reader = response.clone().body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + SOFT_ERROR_GUARD.peekMaxMs;
  let buffer = "";
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await readWithin(reader, Math.max(0, deadline - Date.now()));
      if (chunk === TIMED_OUT) return { text, complete: false, other: false };
      if (chunk.done) return { text, complete: true, other: false };
      bytes += chunk.value.byteLength;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return { text, complete: true, other: false };
        let event;
        try { event = JSON.parse(payload); } catch { continue; }
        const seen = extractVisibleText(event);
        if (seen.other) return { text, complete: false, other: true };
        text += seen.text;
        if (seen.done) return { text, complete: true, other: false };
      }
      if (text.length >= SOFT_ERROR_GUARD.leadChars || bytes >= SOFT_ERROR_GUARD.peekMaxBytes) {
        return { text, complete: false, other: false };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** @returns {Promise<{pattern: string, snippet: string} | null>} */
export async function inspectSoftError(response) {
  try {
    if (!response?.body) return null;
    const type = response.headers?.get?.("content-type") || "";
    if (type.includes("text/event-stream")) {
      const seen = await peekStream(response);
      return seen.other ? null : detectSoftError(seen.text, { complete: seen.complete });
    }
    if (type.includes("json")) {
      const seen = extractVisibleText(await response.clone().json());
      return seen.other ? null : detectSoftError(seen.text, { complete: true });
    }
  } catch {
    // fail-open
  }
  return null;
}

/**
 * `shouldContinueOnSuccess` for handleComboChat. Checks the kill switch on
 * every call so it can be turned off without a restart.
 */
export function createSoftErrorContinuePolicy({ log } = {}) {
  return async (response, { modelStr } = {}) => {
    if (String(process.env[SOFT_ERROR_GUARD.disableEnv] || "").toLowerCase() === "off") return false;
    const hit = await inspectSoftError(response);
    if (!hit) return false;
    log?.warn?.("COMBO", `Model ${modelStr} answered 2xx with an upstream error notice [${hit.pattern}]: ${hit.snippet}`);
    return true;
  };
}
