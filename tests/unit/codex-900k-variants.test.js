import { describe, expect, it } from "vitest";

import { getModelUpstreamId, getProviderModels } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

// Codex OAuth advertises 272K for these models but accepts ~900K (Hermes, verified
// live 2026-09-04: 920,043 input tokens OK, 1,000,043 rejected). The larger window
// is opt-in through a "-900k" model id: the base ids keep the advertised value so
// clients do not silently burn more subscription usage before compacting.
const VARIANTS = [
  ["gpt-5.6-sol-900k", "gpt-5.6-sol"],
  ["gpt-5.6-terra-900k", "gpt-5.6-terra"],
  ["gpt-5.6-luna-900k", "gpt-5.6-luna"],
  ["gpt-6-astra-900k", "gpt-6-astra"],
];

describe("Codex -900k context variants", () => {
  it.each(VARIANTS)("%s is listed as a Codex model", (id) => {
    expect(getProviderModels("cx").some((model) => model.id === id)).toBe(true);
  });

  it.each(VARIANTS)("%s advertises a 900K window", (id) => {
    expect(getCapabilitiesForModel("codex", id).contextWindow).toBe(900000);
  });

  it.each(VARIANTS)("%s goes upstream as %s", (id, upstream) => {
    expect(getModelUpstreamId("cx", id)).toBe(upstream);
    const body = new CodexExecutor().transformRequest(id, { model: id, input: [] }, true, {});
    expect(body.model).toBe(upstream);
  });

  it("keeps the base ids at the advertised window", () => {
    expect(getCapabilitiesForModel("codex", "gpt-5.6-luna").contextWindow).toBe(272000);
    expect(getCapabilitiesForModel("codex", "gpt-6-astra").contextWindow).toBe(272000);
  });

  it("keeps the base id as the default Codex model", () => {
    expect(getProviderModels("cx")[0].id).toBe("gpt-6-astra");
  });
});
