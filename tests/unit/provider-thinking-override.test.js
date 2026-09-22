import { describe, expect, it } from "vitest";
import { applyProviderThinkingOverride } from "../../open-sse/handlers/chatCore/providerThinking.js";

// Legacy "on"/"off" used to fall through to `reasoning_effort = mode` whenever
// the client had already sent `thinking` (Claude Code always does), shipping
// reasoning_effort:"on" upstream — a 400 on every effort enum.
describe("applyProviderThinkingOverride", () => {
  const clientThinking = { thinking: { type: "enabled", budget_tokens: 4000 } };

  it("legacy on/off never become reasoning_effort", () => {
    for (const mode of ["on", "off"]) {
      const out = applyProviderThinkingOverride(clientThinking, { mode });
      expect(out.reasoning_effort).toBeUndefined();
      expect(out.thinking).toEqual(clientThinking.thinking);
    }
  });

  it("legacy on/off still apply when the client sent no thinking", () => {
    expect(applyProviderThinkingOverride({}, { mode: "on" }).thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(applyProviderThinkingOverride({}, { mode: "off" }).thinking).toEqual({ type: "disabled" });
  });

  it("an effort level is injected unless the client set reasoning_effort", () => {
    expect(applyProviderThinkingOverride(clientThinking, { mode: "high" }).reasoning_effort).toBe("high");
    expect(applyProviderThinkingOverride({ reasoning_effort: "low" }, { mode: "high" }).reasoning_effort).toBe("low");
  });

  it("auto / missing config is a no-op and does not copy the body", () => {
    const body = { a: 1 };
    expect(applyProviderThinkingOverride(body, { mode: "auto" })).toBe(body);
    expect(applyProviderThinkingOverride(body, null)).toBe(body);
  });
});
