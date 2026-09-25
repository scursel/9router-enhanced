// Stream readiness gate: an upstream SSE response is only handed to the client
// once it has produced real output. Until then a 200 can still turn out to be
// empty, an error, or silence — and while nothing was forwarded the combo /
// account loop can still fall back to another target.
import { describe, it, expect } from "vitest";
import { ensureStreamReadiness } from "../../open-sse/utils/streamReadiness.js";

const enc = new TextEncoder();

// Build an SSE Response from frames; `gapMs` delays each frame after the first.
function sse(frames, { gapMs = 0, hangAfter = false, contentType = "text/event-stream" } = {}) {
  let i = 0;
  const body = new ReadableStream({
    async pull(ctrl) {
      if (i >= frames.length) {
        if (hangAfter) return new Promise(() => {}); // never closes
        ctrl.close();
        return;
      }
      if (i > 0 && gapMs) await new Promise((r) => setTimeout(r, gapMs));
      ctrl.enqueue(enc.encode(frames[i++]));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

const data = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const openaiChunk = (delta) => data({ object: "chat.completion.chunk", choices: [{ index: 0, delta }] });

describe("ensureStreamReadiness — accepts streams that produce output", () => {
  it("openai: role-only preamble then content → ok, and forwards every byte unchanged", async () => {
    const frames = [openaiChunk({ role: "assistant", content: "" }), openaiChunk({ content: "hel" }), openaiChunk({ content: "lo" }), "data: [DONE]\n\n"];
    const r = await ensureStreamReadiness(sse(frames), { timeoutMs: 1000 });
    expect(r.ok).toBe(true);
    expect(await r.response.text()).toBe(frames.join(""));
  });

  it("openai: reasoning-only first chunk counts as output", async () => {
    const r = await ensureStreamReadiness(sse([openaiChunk({ reasoning_content: "thinking" })]), { timeoutMs: 1000 });
    expect(r.ok).toBe(true);
  });

  it("openai: tool-call-only stream counts as output", async () => {
    const frames = [openaiChunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "ls", arguments: "" } }] }), "data: [DONE]\n\n"];
    const r = await ensureStreamReadiness(sse(frames), { timeoutMs: 1000 });
    expect(r.ok).toBe(true);
  });

  it("claude: message_start + ping, then a text delta → ok", async () => {
    const frames = [
      `event: message_start\n${data({ type: "message_start", message: { id: "m", role: "assistant", content: [] } })}`,
      `event: ping\n${data({ type: "ping" })}`,
      `event: content_block_delta\n${data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}`,
    ];
    const r = await ensureStreamReadiness(sse(frames), { timeoutMs: 1000 });
    expect(r.ok).toBe(true);
    expect(await r.response.text()).toBe(frames.join(""));
  });

  it("gemini: candidates[].content.parts[].text → ok", async () => {
    const r = await ensureStreamReadiness(sse([data({ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] })]), { timeoutMs: 1000 });
    expect(r.ok).toBe(true);
  });

  it("responses: response.created preamble, then output_text.delta → ok", async () => {
    const frames = [
      `event: response.created\n${data({ type: "response.created", response: { id: "r", output: [], text: { format: { type: "text" } }, error: null } })}`,
      `event: response.output_text.delta\n${data({ type: "response.output_text.delta", delta: "hi" })}`,
    ];
    const r = await ensureStreamReadiness(sse(frames), { timeoutMs: 1000 });
    expect(r.ok).toBe(true);
  });

  it("a slow first chunk inside the budget is still accepted", async () => {
    const frames = [openaiChunk({ role: "assistant" }), openaiChunk({ content: "late" })];
    const r = await ensureStreamReadiness(sse(frames, { gapMs: 150 }), { timeoutMs: 2000 });
    expect(r.ok).toBe(true);
  });

  it("non-SSE responses pass through untouched", async () => {
    const res = new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    const r = await ensureStreamReadiness(res, { timeoutMs: 1000 });
    expect(r.ok).toBe(true);
    expect(r.response).toBe(res);
  });

  it("unknown (non-JSON) data lines are not held back", async () => {
    const r = await ensureStreamReadiness(sse(["data: plain text token\n\n"]), { timeoutMs: 1000 });
    expect(r.ok).toBe(true);
  });
});

describe("ensureStreamReadiness — rejects streams that never produce output", () => {
  it("openai: [DONE] with no content → empty failure", async () => {
    const r = await ensureStreamReadiness(sse([openaiChunk({ role: "assistant", content: "" }), "data: [DONE]\n\n"]), { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(r.reason).toBe("empty");
  });

  it("claude: message_start then message_stop with no blocks → empty failure", async () => {
    const frames = [
      `event: message_start\n${data({ type: "message_start", message: { id: "m", content: [] } })}`,
      `event: message_stop\n${data({ type: "message_stop" })}`,
    ];
    const r = await ensureStreamReadiness(sse(frames), { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("empty");
  });

  it("an error payload before any output → error failure carrying the upstream message", async () => {
    const r = await ensureStreamReadiness(sse([data({ error: { message: "upstream exploded" } })]), { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("error");
    expect(r.message).toContain("upstream exploded");
  });

  it("claude `event: error` → error failure", async () => {
    const r = await ensureStreamReadiness(sse([`event: error\n${data({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}`]), { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("error");
    expect(r.message).toContain("Overloaded");
  });

  it("responses `response.failed` → error failure", async () => {
    const r = await ensureStreamReadiness(sse([data({ type: "response.failed", response: { error: { message: "quota" } } })]), { timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("error");
    expect(r.message).toContain("quota");
  });

  it("headers then silence → timeout failure within the budget (504)", async () => {
    const t0 = Date.now();
    const r = await ensureStreamReadiness(sse([openaiChunk({ role: "assistant" })], { hangAfter: true }), { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("timeout");
    expect(r.status).toBe(504);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("a null / zero timeout disables the gate", async () => {
    const res = sse([], { hangAfter: true });
    const r = await ensureStreamReadiness(res, { timeoutMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.response).toBe(res);
  });
});
