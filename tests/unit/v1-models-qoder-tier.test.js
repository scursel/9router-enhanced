// Qoder publishes per-account promo pricing on its live catalog (`is_free` plus
// a zeroed `price_factor` — Qwen3.8-Flash and DeepSeek-Flash today), and
// models.dev has no cost entry for the opaque keys, so the route's cost
// fallback can never classify them. /v1/models must take the tier from the live
// catalog instead, or the free models stay invisible to the `?tier=free` filter
// and to free-first combos.
//
// Qoder is deliberately NOT in LIVE_CATALOG_PROVIDERS: the advertised id list
// stays on the static registry so an account whose catalog fetch fails still
// advertises something. The live call enriches tier only.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));
// Keep routableQoderModels real so the is_free hop through it is covered too.
vi.mock("open-sse/services/qoderModels.js", async (importActual) => {
  const actual = await importActual();
  return { ...actual, resolveQoderModels: vi.fn() };
});

import { buildModelsList } from "@/app/api/v1/models/route.js";
import { getProviderConnections } from "@/lib/localDb";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";

const QODER_CONNECTION = {
  id: "conn-qoder-1",
  provider: "qoder",
  isActive: true,
  accessToken: "dt-test",
  providerSpecificData: { userId: "u1", machineId: "m1" },
};

// Shape resolveQoderModels returns: { models, rawConfigs }.
const CATALOG = {
  models: [
    { id: "qfmodel", name: "Qwen3.8-Flash", contextLength: 180000, is_free: true, priceFactor: 0 },
    { id: "gmodel", name: "GLM-5.3", contextLength: 180000, is_free: false, priceFactor: 0.8 },
  ],
  rawConfigs: new Map([
    ["qfmodel", { key: "qfmodel", enable: true, is_free: true, price_factor: 0 }],
    ["gmodel", { key: "gmodel", enable: true, price_factor: 0.8 }],
    // Hidden (enable:false) but free — chat still routes it, so it must tier too.
    ["dfmodel", { key: "dfmodel", enable: false, display_name: "DeepSeek-Flash", is_free: true, price_factor: 0 }],
  ]),
  fetched: true,
};

async function qdModels() {
  const list = await buildModelsList(["llm"], { scope: "visible" });
  const byId = Object.fromEntries((list || []).map((m) => [m.id, m]));
  return { list, byId };
}

beforeEach(() => {
  vi.mocked(getProviderConnections).mockResolvedValue([QODER_CONNECTION]);
  vi.mocked(resolveQoderModels).mockResolvedValue(CATALOG);
});

describe("/v1/models — qoder live tier", () => {
  it("marks the upstream free promo model tier=free", async () => {
    const { byId } = await qdModels();
    expect(byId["qd/qfmodel"]?.tier).toBe("free");
    expect(byId["qd/qfmodel"]?.tier_source).toBe("live-catalog");
  });

  it("leaves a paid model untiered instead of guessing", async () => {
    const { byId } = await qdModels();
    expect(byId["qd/gmodel"]).toBeDefined();
    expect(byId["qd/gmodel"].tier).toBeUndefined();
  });

  it("keeps advertising the static registry ids on the visible scope", async () => {
    const { byId } = await qdModels();
    // Tier enrichment must not turn into a catalog replacement: `performance`
    // is absent from the live catalog but stays advertised.
    expect(byId["qd/performance"]).toBeDefined();
    expect(byId["qd/qfmodel"]).toBeDefined();
  });

  it("falls back to the static list with no tier when the catalog fetch fails", async () => {
    vi.mocked(resolveQoderModels).mockResolvedValueOnce(null);
    const { byId } = await qdModels();
    expect(byId["qd/qfmodel"]).toBeDefined();
    expect(byId["qd/qfmodel"].tier).toBeUndefined();
  });

  it("still tiers a curated account whose enabledModels gate the id list", async () => {
    // Curated ids carry no pricing, so gating the resolver on curation would
    // leave those accounts with no tier at all. Curation must gate only the id
    // replacement.
    vi.mocked(getProviderConnections).mockResolvedValueOnce([{
      ...QODER_CONNECTION,
      providerSpecificData: {
        ...QODER_CONNECTION.providerSpecificData,
        enabledModels: ["qoder/qfmodel"],
      },
    }]);

    const { list, byId } = await qdModels();
    expect(byId["qd/qfmodel"]?.tier).toBe("free");
    // The curated account advertises its own list, not the whole registry.
    expect(list.map((m) => m.id)).toContain("qd/qfmodel");
    expect(byId["qd/performance"]).toBeUndefined();
  });
});
