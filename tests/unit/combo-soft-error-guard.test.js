// Soft-error guard for chat combos (open-sse/services/softErrorGuard.js).
//
// Some free upstreams answer HTTP 200 with their error notice as the assistant
// text. Before the guard, the combo returned that notice as a success and never
// tried the next member (seen 2026-09-28 on the `leve` combo, served to users).
import { afterEach, describe, expect, it } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";
import {
  createSoftErrorContinuePolicy,
  detectSoftError,
  extractVisibleText,
  inspectSoftError,
} from "../../open-sse/services/softErrorGuard.js";
import { SOFT_ERROR_GUARD } from "../../open-sse/config/softErrorConfig.js";

// Verbatim aihubmix answer captured 2026-09-28 (HTTP 200).
const HB_NOTICE = "Sorry, to prevent abuse of free resources, accounts that have not been recharged can only "
  + "try 10 times. You can increase the free quota after recharging; https://console.aihubmix.com/topup";

const log = { info: () => {}, warn: () => {}, error: () => {} };

const json = (doc) => new Response(JSON.stringify(doc), { status: 200, headers: { "Content-Type": "application/json" } });
const chatJson = (content) => json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] });

function sse(events, { hang = false } = {}) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`));
      if (!hang) controller.close();
    },
    cancel() { cancelled = true; },
  });
  const response = new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  Object.defineProperty(response, "wasCancelled", { get: () => cancelled });
  return response;
}
const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
const chatStream = (...pieces) => sse([delta({ role: "assistant", content: "" }), ...pieces.map((c) => delta({ content: c })), delta({}, "stop"), "data: [DONE]\n\n"]);

afterEach(() => { delete process.env[SOFT_ERROR_GUARD.disableEnv]; });

describe("detectSoftError", () => {
  it("flags the real aihubmix notice", () => {
    expect(detectSoftError(HB_NOTICE)).toMatchObject({ pattern: "prevent abuse" });
  });

  it("leaves normal answers alone, including ones that talk about limits", () => {
    expect(detectSoftError("OK")).toBeNull();
    expect(detectSoftError("A rate limit caps how many requests a client may send per minute.")).toBeNull();
    expect(detectSoftError("Unauthorized")).toBeNull();
    expect(detectSoftError("Batteries that are rechargeable last longer.")).toBeNull();
  });

  it("only looks at the lead of a long or partial answer", () => {
    const long = "Here is a long answer. ".repeat(20) + "Your quota exceeded yesterday.";
    expect(detectSoftError(long)).toBeNull();
    expect(detectSoftError("Error: quota exceeded for this key. " + "x ".repeat(200))).toMatchObject({ pattern: "quota exceeded" });
    // Partial read (stream still going): only the lead counts, even if short so far.
    const partial = "A perfectly normal opening sentence that keeps going, and then: insufficient balance";
    expect(detectSoftError(partial, { complete: false })).toBeNull();
    expect(detectSoftError(partial, { complete: true })).toMatchObject({ pattern: "insufficient balance" });
  });

  it("matches the Chinese notices", () => {
    expect(detectSoftError("余额不足，请充值")).toMatchObject({ pattern: "余额不足" });
  });
});

describe("extractVisibleText — every client format", () => {
  it("OpenAI chat JSON and deltas; reasoning and tool calls are 'other'", () => {
    expect(extractVisibleText({ choices: [{ message: { content: "hi" } }] }).text).toBe("hi");
    expect(extractVisibleText(delta({ reasoning_content: "thinking" })).other).toBe(true);
    expect(extractVisibleText(delta({ tool_calls: [{ id: "1" }] })).other).toBe(true);
    expect(extractVisibleText(delta({}, "stop")).done).toBe(true);
  });

  it("Claude messages JSON and stream events", () => {
    expect(extractVisibleText({ type: "message", content: [{ type: "text", text: "hi" }] }).text).toBe("hi");
    expect(extractVisibleText({ type: "content_block_delta", delta: { type: "text_delta", text: "a" } }).text).toBe("a");
    expect(extractVisibleText({ type: "content_block_start", content_block: { type: "thinking" } }).other).toBe(true);
    expect(extractVisibleText({ type: "message_stop" }).done).toBe(true);
  });

  it("Responses API and Gemini", () => {
    expect(extractVisibleText({ type: "response.output_text.delta", delta: "a" }).text).toBe("a");
    expect(extractVisibleText({ type: "response.reasoning_summary_text.delta" }).other).toBe(true);
    expect(extractVisibleText({ object: "response", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] }).text).toBe("hi");
    expect(extractVisibleText({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] })).toMatchObject({ text: "hi", done: true });
  });
});

describe("inspectSoftError", () => {
  it("JSON: flags the notice, and the response body stays readable", async () => {
    const response = chatJson(HB_NOTICE);
    expect(await inspectSoftError(response)).toMatchObject({ pattern: "prevent abuse" });
    expect((await response.json()).choices[0].message.content).toBe(HB_NOTICE);
  });

  it("SSE: flags a notice split across deltas, and the original stream is untouched", async () => {
    const response = chatStream("Sorry, to prevent ", "abuse of free resources, accounts that have not been recharged.");
    expect(await inspectSoftError(response)).toMatchObject({ pattern: "prevent abuse" });
    expect(await response.text()).toContain("abuse of free resources");
  });

  it("SSE: a normal answer is released after the lead, without waiting for the end", async () => {
    const response = sse([delta({ content: "x".repeat(SOFT_ERROR_GUARD.leadChars) })], { hang: true });
    const started = Date.now();
    expect(await inspectSoftError(response)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("SSE: reasoning first means a working model — no hold-back", async () => {
    const response = sse([delta({ reasoning_content: "Let me think" })], { hang: true });
    expect(await inspectSoftError(response)).toBeNull();
  });

  it("SSE: Claude-format stream with the notice", async () => {
    const response = sse([
      { type: "message_start", message: {} },
      { type: "content_block_start", content_block: { type: "text", text: "" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "余额不足，请充值" } },
      { type: "message_stop" },
    ]);
    expect(await inspectSoftError(response)).toMatchObject({ pattern: "余额不足" });
  });

  it("fail-open on garbage", async () => {
    const response = new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } });
    expect(await inspectSoftError(response)).toBeNull();
    expect(await inspectSoftError(null)).toBeNull();
  });
});

describe("handleComboChat with the soft-error policy", () => {
  const policy = createSoftErrorContinuePolicy({ log });

  it("skips a member whose 200 is an error notice and serves the next one", async () => {
    const tried = [];
    const noticeStream = chatStream(HB_NOTICE);
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["Hb/notice-free", "good/model"],
      handleSingleModel: async (_b, m) => { tried.push(m); return m === "good/model" ? chatStream("Olá!") : noticeStream; },
      log,
      comboName: "soft",
      comboStrategy: "none",
      shouldContinueOnSuccess: policy,
    });
    expect(tried).toEqual(["Hb/notice-free", "good/model"]);
    expect(await response.text()).toContain("Olá!");
    expect(noticeStream.wasCancelled, "the skipped upstream stream is released").toBe(true);
  });

  it("when every member answers with a notice, the last one is returned (no worse than before)", async () => {
    const response = await handleComboChat({
      body: { messages: [] },
      models: ["a", "b"],
      handleSingleModel: async () => chatJson(HB_NOTICE),
      log,
      comboName: "soft-all",
      comboStrategy: "none",
      shouldContinueOnSuccess: policy,
    });
    expect(response.status).toBe(200);
  });

  it("COMBO_SOFT_ERROR_GUARD=off restores the old behaviour", async () => {
    process.env[SOFT_ERROR_GUARD.disableEnv] = "off";
    const tried = [];
    await handleComboChat({
      body: { messages: [] },
      models: ["Hb/notice-free", "good/model"],
      handleSingleModel: async (_b, m) => { tried.push(m); return chatJson(HB_NOTICE); },
      log,
      comboName: "soft-off",
      comboStrategy: "none",
      shouldContinueOnSuccess: policy,
    });
    expect(tried).toEqual(["Hb/notice-free"]);
  });
});
