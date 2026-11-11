// Item 6 — passthrough flush glued `data: [DONE]` onto an unterminated JSON
// line when the upstream was cut mid-event:
//   data: {"id":"…","choices":[{"delta":{"con  +  data: [DONE]
// → the client received one corrupted SSE line (`…"condata: [DONE]`).
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");

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

const oa = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chatChunk = (delta, finish = null) => ({
  id: "chatcmpl-abcdef123456",
  object: "chat.completion.chunk",
  created: 1,
  model: "gpt-x",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

describe("passthrough flush — unterminated tail", () => {
  it("never glues [DONE] onto a truncated JSON event", async () => {
    const upstream =
      oa(chatChunk({ content: "Partial" })) +
      'data: {"id":"chatcmpl-abcdef123456","choices":[{"delta":{"con';

    const out = await feed(upstream, createPassthroughStreamWithLogger("openai", null, "gpt-x", null, null));

    expect(out).not.toContain("condata: [DONE]");
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // The truncated payload is unusable — it must not reach the client as a
    // (still malformed) data line.
    expect(out).not.toContain('"choices":[{"delta":{"con');
  });

  it("forwards a complete tail event that only lost its trailing newline", async () => {
    const complete = JSON.stringify(chatChunk({ content: "tail-ok" }));
    const upstream = `data: ${complete}`;

    const out = await feed(upstream, createPassthroughStreamWithLogger("openai", null, "gpt-x", null, null));

    expect(out).toContain("tail-ok");
    // Terminated as a complete SSE event, followed by the sentinel on its own line.
    expect(out).toContain(`data: ${complete}\n\n`);
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});
