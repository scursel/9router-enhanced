import { describe, expect, it } from "vitest";
import { applyPassthroughSuffixThinking } from "../../open-sse/handlers/chatCore/passthroughThinking.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// A combo member's thinking suffix was applied on native passthrough only for
// codex; Claude Code → cc/claude-*(high) and gemini-cli passthrough lost it.
describe("applyPassthroughSuffixThinking", () => {
  it("claude passthrough applies the member suffix over the client's thinking", () => {
    const body = { thinking: { type: "adaptive" }, messages: [] };
    applyPassthroughSuffixThinking(body, { sourceFormat: FORMATS.CLAUDE, upstreamModel: "claude-opus-4-1(2048)", provider: "claude" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("claude-adaptive member suffix sets the effort", () => {
    const body = { thinking: { type: "adaptive" }, messages: [] };
    applyPassthroughSuffixThinking(body, { sourceFormat: FORMATS.CLAUDE, upstreamModel: "claude-sonnet-5(low)", provider: "claude" });
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("gemini passthrough applies a budget suffix", () => {
    const body = { contents: [], generationConfig: {} };
    applyPassthroughSuffixThinking(body, { sourceFormat: FORMATS.GEMINI, upstreamModel: "gemini-2.5-flash(1024)", provider: "gemini-cli" });
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(1024);
  });

  it("codex keeps the Responses reasoning.effort shape", () => {
    const body = { reasoning: { summary: "auto" }, input: [] };
    applyPassthroughSuffixThinking(body, { sourceFormat: FORMATS.OPENAI_RESPONSES, upstreamModel: "gpt-5.6-luna(high)", provider: "codex" });
    expect(body.reasoning).toEqual({ summary: "auto", effort: "high" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("no suffix leaves the client's thinking exactly as sent", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 5000 } };
    applyPassthroughSuffixThinking(body, { sourceFormat: FORMATS.CLAUDE, upstreamModel: "claude-opus-4-1", provider: "claude" });
    expect(body).toEqual({ thinking: { type: "enabled", budget_tokens: 5000 } });
  });
});
