// Items 2 & 3 — openai→claude stream tail.
//
// Item 2: openai-to-claude.js buffers tool arguments until the finish chunk and
// emits them only in the finish branch. A stream that ends with `[DONE]` and no
// finish_reason lost the buffered args and never sent message_delta/message_stop,
// leaving the Claude client with content_block_start(input:{}) and no close.
//
// Item 3: the standard OpenAI `stream_options.include_usage` trailer
// `{"choices":[],"usage":{...}}` was dropped at the `choices` guard, so the
// message_delta carried the stream.js estimate (estimated:true) and the
// persisted record kept the inflated max(estimate, real).
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

const oa = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chatChunk = (delta, finish = null) => ({
  id: "chatcmpl-abcdef123456",
  object: "chat.completion.chunk",
  created: 1,
  model: "gpt-x",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

// Parse the `data:` payload of every Claude event of one type.
function claudeEvents(text, type) {
  const out = [];
  for (const frame of text.split("\n\n")) {
    if (!frame.includes(`event: ${type}`)) continue;
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine) out.push(JSON.parse(dataLine.slice(6)));
  }
  return out;
}

const body = { model: "gpt-x", messages: [{ role: "user", content: "hi" }] };

describe("Item 2 — stream ends without finish_reason", () => {
  it("flushes buffered tool args, closes the block and terminates the message", async () => {
    const upstream =
      oa(chatChunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "Read", arguments: "" } }],
      })) +
      oa(chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"file_path":"/x"}' } }] })) +
      "data: [DONE]\n\n";

    const out = await feed(
      upstream,
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai", null, null, "gpt-x", null, body)
    );

    const starts = claudeEvents(out, "content_block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].content_block).toMatchObject({ type: "tool_use", id: "call_9", name: "Read" });

    const deltas = claudeEvents(out, "content_block_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta.type).toBe("input_json_delta");
    expect(JSON.parse(deltas[0].delta.partial_json)).toEqual({ file_path: "/x" });

    const stops = claudeEvents(out, "content_block_stop");
    expect(stops).toHaveLength(1);
    expect(stops[0].index).toBe(starts[0].index);

    const messageDeltas = claudeEvents(out, "message_delta");
    expect(messageDeltas).toHaveLength(1);
    expect(messageDeltas[0].delta.stop_reason).toBe("tool_use");
    expect(claudeEvents(out, "message_stop")).toHaveLength(1);
  });
});

describe("Item 3 — usage trailer after finish_reason", () => {
  it("delivers the real usage to the client and the persisted record", async () => {
    let persisted = null;
    const upstream =
      oa(chatChunk({ role: "assistant", content: "Hello there" })) +
      oa(chatChunk({}, "stop")) +
      oa({ id: "chatcmpl-abcdef123456", choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) +
      "data: [DONE]\n\n";

    const out = await feed(
      upstream,
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai", null, null, "gpt-x", null, body,
        (_content, usage) => { persisted = usage; })
    );

    const messageDeltas = claudeEvents(out, "message_delta");
    expect(messageDeltas).toHaveLength(1);
    // 100 real input + the 2000-token client buffer; 50 real output.
    expect(messageDeltas[0].usage).toMatchObject({ input_tokens: 2100, output_tokens: 50 });
    expect(messageDeltas[0].usage.estimated).toBeUndefined();
    expect(claudeEvents(out, "message_stop")).toHaveLength(1);

    expect(persisted).toMatchObject({ input_tokens: 100, output_tokens: 50 });
    expect(persisted.estimated).toBeUndefined();
  });
});
