import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { resolveModelOptions } from "../../open-sse/executors/deepseek-web.js";

// chat.deepseek.com only has a thinking on/off toggle — no effort levels.
describe("deepseek-web thinking levels (picker)", () => {
  it("offers on/off for ids that do not force thinking", () => {
    for (const id of ["deepseek-v4-flash", "deepseek-v4-flash-search", "deepseek-v4-pro", "DeepSeek-V3.2", "DeepSeek-Search"]) {
      expect(getThinkingLevels("deepseek-web", id), id).toEqual(["none", "thinking"]);
    }
  });

  it("offers only 'thinking' for ids that always think", () => {
    for (const id of ["deepseek-v4-flash-think", "deepseek-v4-pro-think-search", "deepseek-reasoner", "DeepSeek-R1", "DeepSeek-R1-Search"]) {
      expect(getThinkingLevels("deepseek-web", id), id).toEqual(["thinking"]);
    }
  });

  it("leaves the official deepseek provider's levels alone", () => {
    expect(getThinkingLevels("deepseek", "deepseek-v4-flash")).not.toEqual(["none", "thinking"]);
  });
});

describe("deepseek-web resolveModelOptions", () => {
  const thinking = (model, body) => resolveModelOptions(model, body).thinkingEnabled;

  it("turns thinking on for any real effort or an enabled flag", () => {
    expect(thinking("deepseek-v4-flash", { reasoning_effort: "low" })).toBe(true);
    expect(thinking("deepseek-v4-flash", { reasoning_effort: "max" })).toBe(true);
    expect(thinking("deepseek-v4-flash", { thinking: { type: "enabled" } })).toBe(true);
    expect(thinking("deepseek-v4-flash", { thinking_enabled: true })).toBe(true);
  });

  it("keeps thinking off for none / disabled / no hint", () => {
    expect(thinking("deepseek-v4-flash", { reasoning_effort: "none" })).toBe(false);
    expect(thinking("deepseek-v4-flash", { thinking: { type: "disabled" }, reasoning_effort: "high" })).toBe(false);
    expect(thinking("deepseek-v4-flash", {})).toBe(false);
  });

  it("ids that force thinking stay on even when asked to disable", () => {
    expect(thinking("deepseek-v4-flash-think", { reasoning_effort: "none" })).toBe(true);
    expect(thinking("DeepSeek-R1", { thinking: { type: "disabled" } })).toBe(true);
  });

  it("maps pro/expert ids to the expert mode", () => {
    expect(resolveModelOptions("deepseek-v4-pro", {}).modelType).toBe("expert");
    expect(resolveModelOptions("deepseek-v4-flash", {}).modelType).toBe("default");
  });
});
