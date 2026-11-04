import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function makeStream(raw) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });
}

const conv = (raw) => convertResponsesStreamToJson(makeStream(raw));

const incomplete = (reason, usage = { input_tokens: 5, output_tokens: 7, total_tokens: 12 }) => [
  `event: response.incomplete`,
  `data: ${JSON.stringify({
    type: "response.incomplete",
    response: {
      id: "resp_inc",
      status: "incomplete",
      incomplete_details: { reason },
      usage,
    },
  })}`,
  "",
].join("\n");

const failed = (message) => [
  `event: response.failed`,
  `data: ${JSON.stringify({
    type: "response.failed",
    response: {
      id: "resp_fail",
      status: "failed",
      error: { message },
    },
  })}`,
  "",
].join("\n");

const deltaSemTerminal = [
  `event: response.created`,
  `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_created" } })}`,
  "",
  `event: response.output_item.done`,
  `data: ${JSON.stringify({
    output_index: 0,
    item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] },
  })}`,
  "",
].join("\n");

function makeCtx({ raw, sourceFormat = FORMATS.OPENAI, onRequestSuccess = vi.fn() }) {
  return {
    providerResponse: new Response(makeStream(raw), {
      headers: { "content-type": "text/event-stream" },
    }),
    sourceFormat,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    provider: "codex",
    model: "gpt-5.5",
    body: { model: "gpt-5.5", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test-conn",
    clientRawRequest: { endpoint: sourceFormat === FORMATS.OPENAI_RESPONSES ? "/v1/responses" : "/v1/chat/completions" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    onRequestSuccess,
  };
}

describe("convertResponsesStreamToJson", () => {
  it("converts response.incomplete with status incomplete, details and usage", async () => {
    const res = await conv(incomplete("max_output_tokens", { input_tokens: 11, output_tokens: 22, total_tokens: 33 }));
    expect(res.status).toBe("incomplete");
    expect(res.incomplete_details?.reason).toBe("max_output_tokens");
    expect(res.usage).toEqual({ input_tokens: 11, output_tokens: 22, total_tokens: 33 });
  });

  it("marks stream without terminal event as failed with message", async () => {
    const res = await conv(deltaSemTerminal);
    expect(res.status).toBe("failed");
    expect(res.error?.message).toBe("stream closed before response.completed");
  });

  it("converts response.failed with status failed and error message", async () => {
    const res = await conv(failed("boom"));
    expect(res.status).toBe("failed");
    expect(res.error?.message).toBe("boom");
  });

  it("populates completed.output when present and does not duplicate output_item.done items", async () => {
    const raw = [
      `event: response.output_item.done`,
      `data: ${JSON.stringify({
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      })}`,
      "",
      `event: response.completed`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_c",
          status: "completed",
          output: [
            { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
            { id: "call_1", type: "function_call", call_id: "c1", name: "fn", arguments: '{"a":1}' },
          ],
        },
      })}`,
      "",
    ].join("\n");

    const res = await conv(raw);
    expect(res.status).toBe("completed");
    expect(res.output).toHaveLength(2);
    expect(res.output[0].id).toBe("msg_1");
    expect(res.output[1].id).toBe("call_1");
  });

  it("recovers function_call delivered only in completed.output", async () => {
    const raw = [
      `event: response.completed`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_c",
          status: "completed",
          output: [
            { id: "call_1", type: "function_call", call_id: "c1", name: "fn", arguments: '{"a":1}' },
          ],
        },
      })}`,
      "",
    ].join("\n");

    const res = await conv(raw);
    expect(res.output).toHaveLength(1);
    expect(res.output[0].type).toBe("function_call");
    expect(res.output[0].name).toBe("fn");
  });
});

describe("handleForcedSSEToJson terminal fidelity", () => {
  it("maps incomplete(max_output_tokens) to length for Chat client", async () => {
    const onRequestSuccess = vi.fn();
    const result = await handleForcedSSEToJson(makeCtx({
      raw: incomplete("max_output_tokens"),
      sourceFormat: FORMATS.OPENAI,
      onRequestSuccess,
    }));
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("length");
    expect(onRequestSuccess).toHaveBeenCalledOnce();
  });

  it("maps incomplete(content_filter) to content_filter for Chat client", async () => {
    const result = await handleForcedSSEToJson(makeCtx({
      raw: incomplete("content_filter"),
      sourceFormat: FORMATS.OPENAI,
    }));
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("content_filter");
  });

  it("prioritizes incomplete finish reason over tool_calls when tools are present", async () => {
    const raw = [
      `event: response.output_item.done`,
      `data: ${JSON.stringify({
        output_index: 0,
        item: { type: "function_call", call_id: "c1", name: "fn", arguments: "{}" },
      })}`,
      "",
      incomplete("max_output_tokens"),
    ].join("\n");

    const result = await handleForcedSSEToJson(makeCtx({
      raw,
      sourceFormat: FORMATS.OPENAI,
    }));
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("length");
  });

  it("returns 502 with error message and skips onRequestSuccess for failed response", async () => {
    const onRequestSuccess = vi.fn();
    const ctx = makeCtx({
      raw: failed("boom"),
      sourceFormat: FORMATS.OPENAI,
      onRequestSuccess,
    });
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.response.status).toBe(502);
    const json = await result.response.json();
    expect(json.error.message).toBe("boom");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("returns 502 with error message and skips onRequestSuccess for stream without terminal", async () => {
    const onRequestSuccess = vi.fn();
    const ctx = makeCtx({
      raw: deltaSemTerminal,
      sourceFormat: FORMATS.OPENAI,
      onRequestSuccess,
    });
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.response.status).toBe(502);
    const json = await result.response.json();
    expect(json.error.message).toBe("stream closed before response.completed");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("allows incomplete through with 200 and status incomplete for Responses client", async () => {
    const onRequestSuccess = vi.fn();
    const ctx = makeCtx({
      raw: incomplete("max_output_tokens"),
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      onRequestSuccess,
    });
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    const json = await result.response.json();
    expect(json.status).toBe("incomplete");
    expect(json.incomplete_details?.reason).toBe("max_output_tokens");
    expect(onRequestSuccess).toHaveBeenCalledOnce();
  });

  it("returns 502 for failed and stream without terminal for Responses client", async () => {
    const onRequestSuccess = vi.fn();
    const ctxFailed = makeCtx({
      raw: failed("boom"),
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      onRequestSuccess,
    });
    const resFailed = await handleForcedSSEToJson(ctxFailed);
    expect(resFailed.success).toBe(false);
    expect(resFailed.status).toBe(502);
    expect(onRequestSuccess).not.toHaveBeenCalled();

    const ctxNoTerm = makeCtx({
      raw: deltaSemTerminal,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      onRequestSuccess,
    });
    const resNoTerm = await handleForcedSSEToJson(ctxNoTerm);
    expect(resNoTerm.success).toBe(false);
    expect(resNoTerm.status).toBe(502);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("preserves completed behavior", async () => {
    const raw = [
      `event: response.output_item.done`,
      `data: ${JSON.stringify({
        output_index: 0,
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      })}`,
      "",
      `event: response.completed`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_c",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      })}`,
      "",
    ].join("\n");

    const onRequestSuccess = vi.fn();
    const result = await handleForcedSSEToJson(makeCtx({
      raw,
      sourceFormat: FORMATS.OPENAI,
      onRequestSuccess,
    }));
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.choices[0].message.content).toBe("hello");
    expect(onRequestSuccess).toHaveBeenCalledOnce();
  });
});
