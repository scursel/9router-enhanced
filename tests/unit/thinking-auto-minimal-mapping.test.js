import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Claude Code's adaptive thinking ({type:"adaptive"}, or "enabled" with no
// budget) is captured as mode "auto". Neither OpenAI's nor StepFun's
// reasoning_effort enum has "auto", so a combo falling back from Claude to one
// of them got an upstream 400. "auto" means "model decides" → omit the field.
describe("applyThinking: adaptive (auto) never reaches an effort enum as a literal", () => {
  it("openai: adaptive thinking omits reasoning_effort", () => {
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", { thinking: { type: "adaptive" } }, "openai");
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.thinking).toBeUndefined();
  });

  it("openai: enabled without budget omits reasoning_effort", () => {
    const out = applyThinking(FORMATS.OPENAI, "gpt-5", { thinking: { type: "enabled" } }, "openai");
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("step: adaptive thinking omits reasoning_effort", () => {
    const out = applyThinking(FORMATS.OPENAI, "step-3", { thinking: { type: "adaptive" } }, "stepfun");
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("explicit levels still pass through", () => {
    expect(applyThinking(FORMATS.OPENAI, "gpt-5", { reasoning_effort: "low" }, "openai").reasoning_effort).toBe("low");
    expect(applyThinking(FORMATS.OPENAI, "step-3", { reasoning_effort: "high" }, "stepfun").reasoning_effort).toBe("high");
  });
});

// Anthropic's adaptive effort enum starts at "low" — "minimal" is a 400.
// It arrived from a client "minimal", from a small budget (budgetToLevel), and
// from "none" on a model that cannot disable thinking (clamped to minimal).
describe("applyThinking (claude-adaptive): minimal → low", () => {
  it("client reasoning_effort:\"minimal\" → effort low", () => {
    const out = applyThinking(FORMATS.CLAUDE, "claude-sonnet-5", { reasoning_effort: "minimal" }, "claude");
    expect(out.output_config).toEqual({ effort: "low" });
  });

  it("\"none\" on a model that cannot disable (Fable 5.1) → effort low", () => {
    const out = applyThinking(FORMATS.CLAUDE, "claude-fable-5-1", { reasoning_effort: "none" }, "claude");
    expect(out.output_config).toEqual({ effort: "low" });
  });

  it("small budget → effort low", () => {
    const out = applyThinking(FORMATS.CLAUDE, "claude-sonnet-5", { thinking: { type: "enabled", budget_tokens: 256 } }, "claude");
    expect(out.output_config).toEqual({ effort: "low" });
  });
});
