import { describe, expect, it } from "vitest";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { extractUsage } from "../../open-sse/utils/usageTracking.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { scanSSEBuffer } from "../../open-sse/services/emptyFailover.js";

describe("Worker A - Tarefa 1: response.incomplete e status terminal", () => {
  const incomplete = (reason) => ({
    type: "response.incomplete",
    response: {
      status: "incomplete",
      incomplete_details: { reason },
      usage: { input_tokens: 5, output_tokens: 7 },
    },
  });

  function getFinishWith(terminalEvent, prefixEvents = [{ type: "response.output_text.delta", delta: "hi" }]) {
    const state = {};
    for (const evt of prefixEvents) {
      openaiResponsesToOpenAIResponse(evt, state);
    }
    const chunk = openaiResponsesToOpenAIResponse(terminalEvent, state);
    return chunk?.choices?.[0]?.finish_reason;
  }

  function runWith(terminalEvent, prefixEvents = [{ type: "response.output_text.delta", delta: "hi" }]) {
    const state = {};
    for (const evt of prefixEvents) {
      openaiResponsesToOpenAIResponse(evt, state);
    }
    return {
      chunk: openaiResponsesToOpenAIResponse(terminalEvent, state),
      state,
    };
  }

  it("maps response.incomplete reasons to length and content_filter", () => {
    expect(getFinishWith(incomplete("max_output_tokens"))).toBe("length");
    expect(getFinishWith(incomplete("content_filter"))).toBe("content_filter");
    expect(getFinishWith(incomplete("algo_novo"))).toBe("length");

    // precedido por output_item.added de tool: incompleto vence tool_calls
    const toolPrefix = [
      {
        type: "response.output_item.added",
        item: { id: "fc1", type: "function_call", call_id: "c1", name: "f" },
      },
    ];
    expect(getFinishWith(incomplete("max_output_tokens"), toolPrefix)).toBe("length");

    // usage chega no chunk final
    const { chunk, state } = runWith(incomplete("max_output_tokens"));
    expect(chunk?.usage?.prompt_tokens).toBe(5);
    expect(chunk?.usage?.completion_tokens).toBe(7);
    expect(state.respTerminalSeen).toBe(true);

    // response.done com status manda no resultado
    expect(
      getFinishWith({
        type: "response.done",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        },
      })
    ).toBe("content_filter");
  });

  it("extractUsage reads usage from response.incomplete", () => {
    const chunk = {
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 15, output_tokens: 25 },
      },
    };
    const usage = extractUsage(chunk);
    expect(usage).not.toBeNull();
    expect(usage.prompt_tokens).toBe(15);
    expect(usage.completion_tokens).toBe(25);
  });
});

describe("Worker A - Tarefa 2: falha e queda viram erro de stream", () => {
  async function runResponsesTransform(inputLines, sourceFormat = FORMATS.OPENAI) {
    const encoder = new TextEncoder();
    const input = Array.isArray(inputLines) ? inputLines.join("\n") : inputLines;
    const stream = new ReadableStream({
      start(controller) {
        if (input) {
          controller.enqueue(encoder.encode(input));
        }
        controller.close();
      },
    });

    const output = stream.pipeThrough(
      createSSETransformStreamWithLogger(
        FORMATS.OPENAI_RESPONSES,
        sourceFormat,
        "codex",
        null,
        null,
        "gpt-5.5"
      )
    );

    const reader = output.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  function countDone(text) {
    const matches = text.match(/data: \[DONE\]/g);
    return matches ? matches.length : 0;
  }

  it("handles text delta and stream EOF without terminal as error", async () => {
    // sourceFormat=OPENAI; delta de texto e fim do stream, sem terminal
    const out = await runResponsesTransform([
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}`,
      "",
    ]);
    expect(out).toContain('"error"');
    expect(out).not.toContain('"finish_reason":"stop"');
    expect(countDone(out)).toBe(1);
  });

  it("handles tool add + partial args delta and stream EOF as error", async () => {
    // add de tool + delta '{"pa' e fim do stream
    const out = await runResponsesTransform([
      "event: response.output_item.added",
      `data: ${JSON.stringify({ type: "response.output_item.added", item: { id: "fc1", type: "function_call", call_id: "c1", name: "f" } })}`,
      "",
      "event: response.function_call_arguments.delta",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc1", delta: '{"pa' })}`,
      "",
    ]);
    expect(out).toContain('"error"');
    expect(out).not.toContain('"finish_reason":"tool_calls"');
  });

  it("handles response.failed with error message without [Error] chunk or finish_reason", async () => {
    // response.failed com error.message "boom"
    const out = await runResponsesTransform([
      "event: response.failed",
      `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: "boom" } } })}`,
      "",
    ]);
    expect(out).toContain("boom");
    expect(out).not.toContain("[Error]");
    expect(out).not.toContain('"finish_reason"');

    // Com delta anterior também não emite finish stop nem [Error]
    const outWithDelta = await runResponsesTransform([
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}`,
      "",
      "event: response.failed",
      `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: "boom" } } })}`,
      "",
    ]);
    expect(outWithDelta).toContain("boom");
    expect(outWithDelta).not.toContain("[Error]");
    expect(outWithDelta).not.toContain('"finish_reason":"stop"');
  });

  it("handles response.failed without error as generic error", async () => {
    // response.failed sem error: erro genérico, não stop
    const out = await runResponsesTransform([
      "event: response.failed",
      `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed" } })}`,
      "",
    ]);
    expect(out).toContain('"error"');
    expect(out).not.toContain('"finish_reason"');
    expect(out).not.toContain("[Error]");

    const outWithDelta = await runResponsesTransform([
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}`,
      "",
      "event: response.failed",
      `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed" } })}`,
      "",
    ]);
    expect(outWithDelta).toContain('"error"');
    expect(outWithDelta).not.toContain('"finish_reason":"stop"');
    expect(outWithDelta).not.toContain("[Error]");
  });

  it("handles event type error and suppresses duplicate response.failed", async () => {
    // evento type:"error": igual, e response.failed logo depois não gera segundo frame
    const out = await runResponsesTransform([
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}`,
      "",
      "event: error",
      `data: ${JSON.stringify({ error: { message: "boom error" } })}`,
      "",
      "event: response.failed",
      `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: "boom error" } } })}`,
      "",
    ]);
    expect(out).toContain("boom error");
    const errorMatches = out.match(/"error"/g);
    expect(errorMatches?.length).toBe(1);
    expect(countDone(out)).toBe(1);
  });

  it("handles sourceFormat=CLAUDE in all three cases without end_turn or [DONE]", async () => {
    // sourceFormat=CLAUDE: nos três casos
    const outTruncated = await runResponsesTransform([
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}`,
      "",
    ], FORMATS.CLAUDE);
    expect(outTruncated).toContain("event: error");
    expect(outTruncated).not.toContain("end_turn");
    expect(outTruncated).not.toContain("[DONE]");

    const outFailed = await runResponsesTransform([
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}`,
      "",
      "event: response.failed",
      `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: "boom" } } })}`,
      "",
    ], FORMATS.CLAUDE);
    expect(outFailed).toContain("event: error");
    expect(outFailed).not.toContain("end_turn");
    expect(outFailed).not.toContain("[DONE]");

    const outError = await runResponsesTransform([
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}`,
      "",
      "event: error",
      `data: ${JSON.stringify({ error: { message: "boom" } })}`,
      "",
    ], FORMATS.CLAUDE);
    expect(outError).toContain("event: error");
    expect(outError).not.toContain("end_turn");
    expect(outError).not.toContain("[DONE]");
  });

  it("error before any content leaves sawContent false in scanSSEBuffer", async () => {
    // erro sem conteúdo anterior
    const out = await runResponsesTransform([
      "event: response.failed",
      `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: "immediate failure" } } })}`,
      "",
    ]);
    expect(scanSSEBuffer(out).sawContent).toBe(false);
  });

  it("normal response.completed produces finish stop and one [DONE]", async () => {
    // response.completed normal: sem erro, finish stop, um [DONE]
    const out = await runResponsesTransform([
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}`,
      "",
    ]);
    expect(out).not.toContain('"error"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(countDone(out)).toBe(1);
  });

  it("empty stream produces current behavior with no new error", async () => {
    // nenhum evento recebido: comportamento atual, sem erro novo
    const out = await runResponsesTransform([]);
    expect(out).not.toContain('"error"');
  });
});

describe("Worker A - Tarefa 3: recuperar saída que veio sem delta", () => {
  const msg = (id, text) => ({
    id,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  });
  const call = {
    id: "fc1",
    type: "function_call",
    call_id: "c1",
    name: "f",
    arguments: '{"a":1}',
  };

  function runChunks(events) {
    const state = {};
    const chunks = [];
    for (const ev of events) {
      const res = openaiResponsesToOpenAIResponse(ev, state);
      if (Array.isArray(res)) chunks.push(...res);
      else if (res) chunks.push(res);
    }
    return { state, chunks };
  }

  it("recovers message only from completed.output: text 'oi' then finish stop", () => {
    const { chunks } = runChunks([
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [msg("m1", "oi")],
        },
      },
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe("oi");
    expect(chunks[1].choices[0].finish_reason).toBe("stop");
  });

  it("recovers call only from completed.output: tool_calls id c1, name f, args '{\"a\":1}', finish tool_calls", () => {
    const { chunks } = runChunks([
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [call],
        },
      },
    ]);
    expect(chunks).toHaveLength(2);
    const tc = chunks[0].choices[0].delta.tool_calls[0];
    expect(tc.id).toBe("c1");
    expect(tc.function.name).toBe("f");
    expect(tc.function.arguments).toBe('{"a":1}');
    expect(chunks[1].choices[0].finish_reason).toBe("tool_calls");
  });

  it("preserves ordering of msg + call: text, tool, finish", () => {
    const { chunks } = runChunks([
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [msg("m1", "oi"), call],
        },
      },
    ]);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].choices[0].delta.content).toBe("oi");
    expect(chunks[1].choices[0].delta.tool_calls[0].id).toBe("c1");
    expect(chunks[2].choices[0].finish_reason).toBe("tool_calls");
  });

  it("recovers from output_item.done with msg, completed with empty output does not duplicate", () => {
    const { chunks } = runChunks([
      {
        type: "response.output_item.done",
        item: msg("m1", "oi"),
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [],
        },
      },
    ]);
    const texts = chunks.filter((c) => c.choices[0].delta.content).map((c) => c.choices[0].delta.content);
    expect(texts).toEqual(["oi"]);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe("stop");
  });

  it("does not duplicate text when deltas 'o','i' were sent and completed.output repeats msg", () => {
    const { chunks } = runChunks([
      { type: "response.output_text.delta", item_id: "m1", delta: "o" },
      { type: "response.output_text.delta", item_id: "m1", delta: "i" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [msg("m1", "oi")],
        },
      },
    ]);
    const texts = chunks.filter((c) => c.choices[0].delta.content).map((c) => c.choices[0].delta.content);
    expect(texts.join("")).toBe("oi");
  });

  it("does not duplicate call when transmitted via added+delta and repeated in completed.output", () => {
    const { chunks } = runChunks([
      {
        type: "response.output_item.added",
        item: { id: "fc1", type: "function_call", call_id: "c1", name: "f" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc1",
        delta: '{"a":1}',
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [call],
        },
      },
    ]);
    let totalArgs = "";
    let callCount = 0;
    for (const c of chunks) {
      for (const tc of c.choices?.[0]?.delta?.tool_calls || []) {
        if (tc.id) callCount++;
        if (tc.function?.arguments) totalArgs += tc.function.arguments;
      }
    }
    expect(callCount).toBe(1);
    expect(totalArgs).toBe('{"a":1}');
  });

  it("recovers custom_tool_call with input in completed.output as args = input", () => {
    const customCall = {
      id: "ctc1",
      type: "custom_tool_call",
      call_id: "c_custom",
      name: "custom_tool",
      input: '{"key":"val"}',
    };
    const { chunks } = runChunks([
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [customCall],
        },
      },
    ]);
    expect(chunks).toHaveLength(2);
    const tc = chunks[0].choices[0].delta.tool_calls[0];
    expect(tc.id).toBe("c_custom");
    expect(tc.function.name).toBe("custom_tool");
    expect(tc.function.arguments).toBe('{"key":"val"}');
  });

  it("does not turn refusal or reasoning content types into text", () => {
    const nonTextMsg = {
      id: "m_refusal",
      type: "message",
      role: "assistant",
      content: [
        { type: "refusal", refusal: "cannot assist" },
        { type: "reasoning", text: "internal chain" },
      ],
    };
    const { chunks } = runChunks([
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [nonTextMsg],
        },
      },
    ]);
    const textChunks = chunks.filter((c) => c.choices[0].delta.content);
    expect(textChunks).toHaveLength(0);
    expect(chunks[0].choices[0].finish_reason).toBe("stop");
  });

  it("does not recover text if anonymous text deltas were seen", () => {
    const { chunks } = runChunks([
      { type: "response.output_text.delta", delta: "anon" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [msg("m1", "more text")],
        },
      },
    ]);
    const texts = chunks.filter((c) => c.choices[0].delta.content).map((c) => c.choices[0].delta.content);
    expect(texts).toEqual(["anon"]);
  });
});
