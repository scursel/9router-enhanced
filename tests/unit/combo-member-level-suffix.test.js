import { describe, expect, it } from "vitest";
import { aggregateComboCapabilities } from "../../open-sse/providers/capabilities.js";
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
