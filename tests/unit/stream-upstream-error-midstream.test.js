// Item 1 — an upstream error event that arrives AFTER output started must reach
// the client as an error frame in the CLIENT's format, never as a silent EOF.
//
// Before: translator/response/claude-to-openai.js had no `error` case and
// translator/response/openai-to-claude.js / openai-to-gemini.js returned at the
// `choices` guard before looking at `chunk.error`, so state.streamError (read by
// utils/stream.js emitStreamErrorIfNeeded) was never set. An OpenAI client got
// the text then `data: [DONE]` with no error frame; a Claude client got a
// message that never ended.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function feed(sseText, transform) {
  const input = new Blob([sseText]).stream();
  return drain(input.pipeThrough(transform));
}

const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const oa = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chatChunk = (delta, finish = null) => ({
  id: "chatcmpl-abcdef123456",
  object: "chat.completion.chunk",
  created: 1,
  model: "gpt-x",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const claudeStart = ev("message_start", {
  type: "message_start",
  message: { id: "msg_01abcdefgh", model: "claude-x", usage: { input_tokens: 10, output_tokens: 1 } },
});
const claudeTextStart = ev("content_block_start", {
  type: "content_block_start",
  index: 0,
  content_block: { type: "text", text: "" },
});
const claudeText = (text) =>
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const countDone = (text) => (text.match(/data:\s*\[DONE\]/g) || []).length;

describe("Claude upstream error event → OpenAI client", () => {
  it("forwards an error frame after the partial text and terminates once", async () => {
    const upstream =
      claudeStart +
      claudeTextStart +
      claudeText("Partial answer") +
      ev("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });

    const out = await feed(
      upstream,
      createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "anthropic", null, null, "claude-x")
    );

    expect(out).toContain("Partial answer");
    expect(out).toContain('"error"');
    expect(out).toContain("Overloaded");
    expect(countDone(out)).toBe(1);
    // The error frame must come after the text, not replace it.
    expect(out.indexOf("Partial answer")).toBeLessThan(out.indexOf('"error"'));
    // Never fabricate a successful finish for a failed turn.
    expect(out).not.toContain('"finish_reason":"stop"');
  });
});

describe("OpenAI upstream {error} object → Claude client", () => {
  it("emits event: error and does not close the message as a success", async () => {
    const upstream =
      oa(chatChunk({ role: "assistant", content: "Partial" })) +
      oa({ error: { message: "upstream stalled", type: "server_error" } }) +
      "data: [DONE]\n\n";

    const out = await feed(
      upstream,
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai", null, null, "gpt-x")
    );

    expect(out).toContain("Partial");
    expect(out).toContain("event: error");
    expect(out).toContain("upstream stalled");
    expect(out).not.toContain("event: message_stop");
    expect(out).not.toContain('"type":"message_delta"');
  });
});

describe("OpenAI upstream {error} object → Gemini client", () => {
  it("emits a Gemini error frame and no [DONE] sentinel", async () => {
    const upstream =
      oa(chatChunk({ role: "assistant", content: "Partial" })) +
      oa({ error: { message: "upstream stalled", type: "server_error" } }) +
      "data: [DONE]\n\n";

    const out = await feed(
      upstream,
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.GEMINI, "openai", null, null, "gpt-x")
    );

    expect(out).toContain("Partial");
    expect(out).toContain('"error"');
    expect(out).toContain("upstream stalled");
    expect(countDone(out)).toBe(0);
  });
});

describe("Gemini upstream {error} object → OpenAI client", () => {
  it("forwards an error frame after the partial text and terminates once", async () => {
    const upstream =
      oa({ candidates: [{ content: { parts: [{ text: "Partial" }] } }], responseId: "resp_1", modelVersion: "gemini-3-pro" }) +
      oa({ error: { code: 500, message: "internal failure", status: "INTERNAL" } }) +
      "data: [DONE]\n\n";

    const out = await feed(
      upstream,
      createSSETransformStreamWithLogger(FORMATS.GEMINI, FORMATS.OPENAI, "gemini", null, null, "gemini-3-pro")
    );

    expect(out).toContain("Partial");
    expect(out).toContain('"error"');
    expect(out).toContain("internal failure");
    expect(countDone(out)).toBe(1);
  });
});
