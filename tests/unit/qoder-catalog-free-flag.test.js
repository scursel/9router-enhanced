// The catalog fetcher is where upstream's promo pricing enters 9Router:
// /algo/api/v2/model/list flags free models with `is_free` and a zeroed
// `price_factor`. Dropping either here makes the model untierable downstream
// (models.dev has no cost entry for the opaque keys), so the flag has to
// survive the raw-entry → model mapping.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", async (importActual) => {
  const actual = await importActual();
  return { ...actual, proxyAwareFetch: vi.fn() };
});

import {
  resolveQoderModels,
  clearQoderCatalog,
} from "../../open-sse/services/qoderModels.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

const CREDS = {
  provider: "qoder",
  accessToken: "dt-test",
  email: "user@example.com",
  providerSpecificData: { userId: "u1", machineId: "m1", authMethod: "oauth" },
};

const UPSTREAM = {
  chat: [
    {
      key: "qfmodel", enable: true, display_name: "Qwen3.8-Flash",
      is_vl: true, is_reasoning: true,
      is_free: true, price_factor: 0, original_price_factor: 0.1,
      max_input_tokens: 180000,
    },
    {
      key: "gmodel", enable: true, display_name: "GLM-5.3",
      is_vl: true, is_reasoning: true, price_factor: 0.8, max_input_tokens: 180000,
    },
    // No price_factor at all (tier alias) — must NOT read as free.
    { key: "auto", enable: true, display_name: "Auto", max_input_tokens: 200000 },
    // Zeroed factor without an explicit is_free still means "costs no credits".
    {
      key: "dfmodel", enable: true, display_name: "DeepSeek-Flash",
      price_factor: 0, max_input_tokens: 1000000,
    },
    // An explicitly null/empty factor means "no price published", not "free".
    { key: "performance", enable: true, display_name: "Performance", price_factor: null, max_input_tokens: 200000 },
    { key: "lite", enable: true, display_name: "Lite", price_factor: "", max_input_tokens: 200000 },
  ],
};

beforeEach(() => {
  clearQoderCatalog();
  vi.mocked(proxyAwareFetch).mockResolvedValue({ ok: true, json: async () => UPSTREAM });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("qoder catalog fetcher — free flag", () => {
  it("carries is_free and price_factor off the raw entries", async () => {
    const result = await resolveQoderModels(CREDS, { forceRefresh: true });
    expect(result).toBeTruthy();
    const byId = Object.fromEntries(result.models.map((m) => [m.id, m]));

    expect(byId.qfmodel.is_free).toBe(true);
    expect(byId.qfmodel.priceFactor).toBe(0);

    // Zeroed factor alone counts as free even without the explicit flag.
    expect(byId.dfmodel.is_free).toBe(true);
    expect(byId.dfmodel.priceFactor).toBe(0);

    expect(byId.gmodel.is_free).toBe(false);
    expect(byId.gmodel.priceFactor).toBe(0.8);
  });

  it("does not treat a missing price_factor as free", async () => {
    const result = await resolveQoderModels(CREDS, { forceRefresh: true });
    const auto = result.models.find((m) => m.id === "auto");
    expect(auto.is_free).toBe(false);
    expect(auto.priceFactor).toBeNull();
  });

  it("does not treat a null or empty price_factor as free", async () => {
    // Number(null) and Number("") are both 0, so without the guard an
    // unpriced tier alias would be tiered free and leak into ?tier=free.
    const result = await resolveQoderModels(CREDS, { forceRefresh: true });
    const byId = Object.fromEntries(result.models.map((m) => [m.id, m]));
    expect(byId.performance.is_free).toBe(false);
    expect(byId.performance.priceFactor).toBeNull();
    expect(byId.lite.is_free).toBe(false);
    expect(byId.lite.priceFactor).toBeNull();
  });

  it("keeps the pre-existing catalog fields intact", async () => {
    const result = await resolveQoderModels(CREDS, { forceRefresh: true });
    const qf = result.models.find((m) => m.id === "qfmodel");
    expect(qf).toMatchObject({
      id: "qfmodel",
      name: "Qwen3.8-Flash",
      contextLength: 180000,
      isVL: true,
      isReasoning: true,
    });
  });
});
