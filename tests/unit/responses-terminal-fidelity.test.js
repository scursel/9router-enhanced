import { describe, expect, it } from "vitest";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { extractUsage } from "../../open-sse/utils/usageTracking.js";

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
