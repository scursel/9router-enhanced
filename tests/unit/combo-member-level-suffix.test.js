import { describe, expect, it } from "vitest";
import { aggregateComboCapabilities } from "../../open-sse/providers/capabilities.js";
import { resolveCaps } from "../../src/shared/hooks/useModelCaps.js";
import { makeComboMemberResolver } from "../../src/shared/utils/comboMemberResolver.js";

// Combo members may carry a thinking-level suffix, e.g. "cx/gpt-5.6-sol(high)".
// The suffix is not part of the model id, so the resolver must strip it before
// the capability lookup; otherwise the member falls back to the 1M default.
describe("combo member resolver strips a thinking-level suffix", () => {
  it("resolves the model without the level suffix", () => {
    const resolveMember = makeComboMemberResolver([], {});
    expect(resolveMember("cx/gpt-5.6-sol(high)")).toEqual({ provider: "codex", model: "gpt-5.6-sol" });
  });

  it("aggregates the codex context window for a suffixed member", () => {
    const resolveMember = makeComboMemberResolver([], {});
    const caps = aggregateComboCapabilities(["cx/gpt-5.6-sol(high)"], null, { resolveMember });
    expect(caps.contextWindow).toBe(372000);
  });
});

// Dashboard path: useModelCaps.resolveCaps is the resolveCaps override the
// combo card passes to aggregateComboCapabilities with the raw member string.
describe("dashboard resolveCaps strips a thinking-level suffix", () => {
  it("resolves the suffixed key to the codex catalog window", () => {
    expect(resolveCaps({}, {}, "cx/gpt-5.6-sol(high)").contextWindow).toBe(372000);
  });

  it("keeps the codex window end-to-end through the combo aggregate", () => {
    const resolveMember = makeComboMemberResolver([], {});
    const caps = aggregateComboCapabilities(["cx/gpt-5.6-sol(high)"], null, {
      resolveMember,
      resolveCaps: (k) => resolveCaps({}, {}, k),
    });
    expect(caps.contextWindow).toBe(372000);
  });
});
