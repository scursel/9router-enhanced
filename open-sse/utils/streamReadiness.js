/**
 * Stream readiness gate.
 *
 * An upstream 200 with SSE headers is not yet a success: the stream can still
 * end empty, carry an error as its only payload, or go silent. Once the first
 * byte reaches the client none of that can be undone — the combo / account
 * loop above can no longer fall back. So the stream is held back until it
 * produces real output (text, reasoning, a tool call), and only then handed
 * on, with every byte read so far replayed unchanged in front of the rest.
 *
 * Format-agnostic on purpose: it looks for output-bearing keys in each
 * `data:` JSON payload rather than per-format event names, which covers the
 * OpenAI chat, Claude, Gemini and Responses shapes that reach chatCore.
 * Non-SSE responses (JSON, binary EventStream) pass through untouched.
 */

// Keys whose non-empty value (at any depth under these keys) is model output.
// Wrapper keys (choices, candidates, parts, response, output, message) only
// lead to them; an empty wrapper (`content: []`, `output: []`) is not output.
const OUTPUT_KEYS = [
  "choices", "candidates", "parts", "response", "output", "message", "item",
  "content", "text", "delta", "reasoning_content", "reasoning", "thinking",
  "reasoning_details", "thought", "partial_json", "arguments", "name",
  "tool_calls", "function", "function_call", "functionCall", "content_block",
];

function hasOutput(value, depth = 0) {
  if (depth > 8 || value == null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.some((v) => hasOutput(v, depth + 1));
  if (typeof value !== "object") return false;
  return OUTPUT_KEYS.some((k) => k in value && hasOutput(value[k], depth + 1));
}

function errorMessageOf(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return err.message || err.error?.message || err.type || JSON.stringify(err);
}

// Error text when the payload is an error event, "" otherwise.
function payloadError(payload, eventType) {
  if (!payload || typeof payload !== "object") return eventType === "error" ? "upstream stream error" : "";
  if (payload.error) return errorMessageOf(payload.error) || "upstream stream error";
  if (payload.type === "error" || eventType === "error") return errorMessageOf(payload) || "upstream stream error";
  if (payload.type === "response.failed") {
    return errorMessageOf(payload.response?.error) || "upstream response failed";
  }
  return "";
}

// Resolve a reader.read() or give up after ms. On timeout the caller cancels.
function readWithTimeout(reader, ms) {
  let timer;
  return Promise.race([
    reader.read(),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), Math.max(0, ms)); }),
  ]).finally(() => clearTimeout(timer));
}

function replay(chunks, reader) {
  let i = 0;
  return new ReadableStream({
    async pull(ctrl) {
      if (i < chunks.length) { ctrl.enqueue(chunks[i++]); return; }
      const { done, value } = await reader.read();
      if (done) ctrl.close();
      else ctrl.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

/**
 * Hold an SSE response back until it produces output.
 *
 * @param {Response} response - upstream response (already known to be 2xx)
 * @param {{ timeoutMs: number }} options - budget for the first output; 0/absent disables
 * @returns {Promise<{ok: true, response: Response} | {ok: false, status: number, reason: "empty"|"error"|"timeout", message: string}>}
 */
export async function ensureStreamReadiness(response, { timeoutMs } = {}) {
  const contentType = response?.headers?.get?.("content-type") || "";
  if (!(timeoutMs > 0) || !response?.body || !contentType.toLowerCase().includes("text/event-stream")) {
    return { ok: true, response };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  const deadline = Date.now() + timeoutMs;
  let pending = "";
  let eventType = "";

  const fail = (status, reason, message) => {
    reader.cancel().catch(() => {});
    return { ok: false, status, reason, message };
  };

  // Returns "output" | an error message | "" (nothing decisive yet).
  const inspectLine = (rawLine) => {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") { eventType = ""; return ""; }
    if (line.startsWith("event:")) { eventType = line.slice(6).trim(); return ""; }
    if (!line.startsWith("data:")) return "";
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return "";
    let payload;
    try { payload = JSON.parse(data); } catch { return "output"; } // unknown shape: don't hold it back
    const err = payloadError(payload, eventType);
    if (err) return `error:${err}`;
    return hasOutput(payload) ? "output" : "";
  };

  while (true) {
    const r = await readWithTimeout(reader, deadline - Date.now());
    if (r.timeout) return fail(504, "timeout", `upstream stream produced no output within ${timeoutMs}ms`);
    if (r.done) {
      const verdict = pending ? inspectLine(pending) : "";
      if (verdict === "output") return { ok: true, response: rebuild(response, chunks, reader) };
      if (verdict.startsWith("error:")) return fail(502, "error", verdict.slice(6));
      return fail(502, "empty", "upstream stream ended without any output");
    }
    chunks.push(r.value);
    pending += decoder.decode(r.value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      const verdict = inspectLine(line);
      if (verdict === "output") return { ok: true, response: rebuild(response, chunks, reader) };
      if (verdict.startsWith("error:")) return fail(502, "error", verdict.slice(6));
    }
  }
}

function rebuild(response, chunks, reader) {
  return new Response(replay(chunks, reader), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
