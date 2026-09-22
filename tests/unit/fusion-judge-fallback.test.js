import { describe, it, expect, vi } from "vitest";
import { handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

function jsonResponse(json, { ok = true, status = 200 } = {}) {
  const make = () => ({ ok, status, clone: make, json: async () => json });
  return make();
}
const chat = (content) => jsonResponse({ choices: [{ message: { role: "assistant", content } }] });
const fail = (status) => jsonResponse({ error: { message: "boom" } }, { ok: false, status });

const judgePrompt = (handleSingleModel) => {
  const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
  return JSON.stringify(judgeCall[0].messages.at(-1));
};

// A judge failure (400 context overflow — its prompt is the whole conversation
// plus every panel answer — or a 5xx) used to be returned as-is, discarding
// the good panel answers. It now answers directly with a panel model instead.
describe("fusion judge failure", () => {
  it.each([400, 503])("judge %i → answers directly with a successful panel model", async (status) => {
    const handleSingleModel = vi.fn(async (body, model) => (model === "p/judge" ? fail(status) : chat(`ans-${model}`)));
    const body = { messages: [{ role: "user", content: "Q" }], stream: true };
    const res = await handleFusionChat({ body, models: ["p/a", "p/b"], handleSingleModel, log, judgeModel: "p/judge" });

    expect(res.ok).toBe(true);
    const last = handleSingleModel.mock.calls.at(-1);
    expect(["p/a", "p/b"]).toContain(last[1]);
    expect(last[0], "the client's own body, not the judge prompt").toBe(body);
  });

  it("a judge that throws is handled the same way", async () => {
    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "p/judge") throw new Error("socket hang up");
      return chat(`ans-${model}`);
    });
    const res = await handleFusionChat({ body: { messages: [{ role: "user", content: "Q" }] }, models: ["p/a", "p/b"], handleSingleModel, log, judgeModel: "p/judge" });
    expect(res.ok).toBe(true);
  });

  it("a healthy judge is returned untouched", async () => {
    const judgeRes = chat("FINAL");
    const handleSingleModel = vi.fn(async (body, model) => (model === "p/judge" ? judgeRes : chat("x")));
    const res = await handleFusionChat({ body: { messages: [{ role: "user", content: "Q" }] }, models: ["p/a", "p/b"], handleSingleModel, log, judgeModel: "p/judge" });
    expect(res).toBe(judgeRes);
  });
});

// Panel reasoning must not become "Source N" text the judge weighs.
describe("fusion panel text excludes reasoning", () => {
  it("Gemini thought parts are skipped", async () => {
    const gem = (text) => jsonResponse({ candidates: [{ content: { parts: [{ text: "SECRET-THOUGHT", thought: true }, { text }] } }] });
    const handleSingleModel = vi.fn(async (body, model) => (model === "p/judge" ? chat("F") : gem(`ans-${model}`)));
    await handleFusionChat({ body: { messages: [{ role: "user", content: "Q" }] }, models: ["p/a", "p/b"], handleSingleModel, log, judgeModel: "p/judge" });
    const prompt = judgePrompt(handleSingleModel);
    expect(prompt).toContain("ans-p/a");
    expect(prompt).not.toContain("SECRET-THOUGHT");
  });

  it("Responses reasoning items are skipped", async () => {
    const resp = (text) => jsonResponse({ output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "SECRET-REASONING" }], summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    ] });
    const handleSingleModel = vi.fn(async (body, model) => (model === "p/judge" ? chat("F") : resp(`ans-${model}`)));
    await handleFusionChat({ body: { input: [{ role: "user", content: "Q" }] }, models: ["p/a", "p/b"], handleSingleModel, log, judgeModel: "p/judge" });
    const call = handleSingleModel.mock.calls.find(([, m]) => m === "p/judge");
    const prompt = JSON.stringify(call[0].input.at(-1));
    expect(prompt).toContain("ans-p/a");
    expect(prompt).not.toContain("SECRET-REASONING");
  });
});
