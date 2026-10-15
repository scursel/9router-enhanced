import { describe, it, expect } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Nous declares none|low|medium|high (thinkingLevels.js FORMAT_LEVELS.nous) and
// nothing documents minimal/xhigh/max/auto as accepted. Like the generic OpenAI
// path and step/kimi, the nous case must clamp to the declared set instead of
// forwarding the client's raw effort.
const MODEL = "poolside/laguna-s-2.1:free";
const run = (body) => applyThinking(FORMATS.OPENAI, MODEL, body, "nous");

describe("applyThinking: nous reasoning effort stays within declared levels", () => {
  it("declares none/low/medium/high only", () => {
    expect(getThinkingLevels("nous", MODEL)).toEqual(["none", "low", "medium", "high"]);
  });

  it("clamps minimal to low", () => {
    expect(run({ reasoning_effort: "minimal" }).reasoning).toEqual({ enabled: true, effort: "low" });
  });

  it("clamps xhigh and max to high", () => {
    expect(run({ reasoning_effort: "xhigh" }).reasoning).toEqual({ enabled: true, effort: "high" });
    expect(run({ reasoning_effort: "max" }).reasoning).toEqual({ enabled: true, effort: "high" });
  });

  it("never sends auto (adaptive thinking becomes medium)", () => {
    const out = run({ thinking: { type: "adaptive" } });
    expect(out.reasoning).toEqual({ enabled: true, effort: "medium" });
  });

  it("passes declared levels through unchanged", () => {
    for (const level of ["low", "medium", "high"]) {
      expect(run({ reasoning_effort: level }).reasoning).toEqual({ enabled: true, effort: level });
    }
  });

  it("none still omits reasoning", () => {
    expect(run({ reasoning_effort: "none" }).reasoning).toBeUndefined();
  });
});
