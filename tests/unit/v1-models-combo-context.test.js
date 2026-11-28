import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogSource } from "../../open-sse/providers/capabilities.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getModelMeta: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/db/repos/modelMetaRepo.js", () => ({ getModelMeta: db.getModelMeta }));
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const syncedLimits = { contextWindow: 180000, maxOutput: 16000 };

async function modelsWithCombo(providerId, modelId, combos) {
  db.getProviderConnections.mockResolvedValue([{
    id: 1,
    provider: providerId,
    isActive: true,
    providerSpecificData: { enabledModels: [modelId] },
  }]);
  db.getCombos.mockResolvedValue(combos);
  setCatalogSource({
    getModalities: () => null,
    getLimits: (provider, model) =>
      provider === providerId && model === modelId ? syncedLimits : null,
  });
  try {
    return await buildModelsList(["llm"]);
  } finally {
    setCatalogSource(null);
  }
}

describe("/v1/models combo limits", () => {
  it.each([
    ["ocg", "opencode-go", "mimo-v2.5"],
    ["xmtp", "xiaomi-tokenplan", "mimo-v2.5"],
    ["ps", "poolside", "custom-model"],
    ["ds", "deepseek", "deepseek-chat"],
  ])("uses the real provider for a %s UI-alias seat", async (uiAlias, providerId, modelId) => {
    const combo = { name: "ui-alias-combo", models: [`${uiAlias}/${modelId}`] };
    const models = await modelsWithCombo(providerId, modelId, [combo]);
    const published = models.find((model) => model.id === combo.name);

    expect(published).toMatchObject({
      context_length: 180000,
      max_completion_tokens: 16000,
      capabilities: { contextWindow: 180000, maxOutput: 16000 },
    });
  });

  it("carries provider-scoped limits through a nested combo", async () => {
    const models = await modelsWithCombo("opencode-go", "mimo-v2.5", [
      { name: "inner-combo", models: ["ocg/mimo-v2.5"] },
      { name: "outer-combo", models: ["inner-combo"] },
    ]);
    const outer = models.find((model) => model.id === "outer-combo");

    expect(outer).toMatchObject({
      context_length: 180000,
      max_completion_tokens: 16000,
      capabilities: { contextWindow: 180000, maxOutput: 16000 },
    });
  });

  it("publishes Devin CLI's 200k limit for a dv combo seat", async () => {
    const models = await modelsWithCombo("devin-cli", "gpt-5.5-high", [
      { name: "devin-combo", models: ["dv/gpt-5.5-high"] },
    ]);
    const combo = models.find((model) => model.id === "devin-combo");

    expect(combo).toMatchObject({
      context_length: 200000,
      capabilities: { contextWindow: 200000 },
    });
  });

  it("ordered Claude+Workhorse advertises primary output and MIN context", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: "cl-1", provider: "claude", isActive: true, providerSpecificData: {}, modelCatalog: null },
      {
        id: "wh-1",
        provider: "openai-compatible-chat-workhorse",
        isActive: true,
        providerSpecificData: { prefix: "workhorse", enabledModels: ["qwen38-gguf-mtp"] },
        modelCatalog: null,
      },
    ]);
    db.getCombos.mockResolvedValue([{
      name: "claude-workhorse",
      models: ["claude/claude-sonnet-5-5", "workhorse/qwen38-gguf-mtp"],
    }]);
    db.getSettings.mockResolvedValue({});
    const models = await buildModelsList(["llm"]);
    const combo = models.find((model) => model.id === "claude-workhorse");
    expect(combo).toMatchObject({
      max_completion_tokens: 128000,
      context_length: 65536,
      capabilities: { maxOutput: 128000, contextWindow: 65536 },
    });
  });
});

describe("Workhorse metadata in visible discovery", () => {
  const provider = "openai-compatible-chat-workhorse";
  const model = "qwen38-gguf-mtp";
  const levels = ["none", "low", "medium", "high", "max"];

  afterEach(() => {
    vi.unstubAllGlobals();
    db.getCustomModels.mockResolvedValue([]);
    db.getModelMeta.mockResolvedValue({});
  });

  function setup(modelCatalog) {
    db.getProviderConnections.mockResolvedValue([{
      id: "workhorse",
      provider,
      apiKey: "test",
      providerSpecificData: {
        prefix: "workhorse",
        baseUrl: "https://workhorse.example/v1",
        enabledModels: [model],
      },
      modelCatalog,
    }]);
    db.getCombos.mockResolvedValue([
      { name: "LOCAL27b", models: [`workhorse/${model}`] },
      { name: "nested", models: ["LOCAL27b"] },
    ]);
    db.getCustomModels.mockResolvedValue([
      { id: `${model}-vision`, providerAlias: "workhorse", upstreamModelId: model, caps: { contextWindow: 65536 } },
    ]);
  }

  async function expectMetadata(context, thinkingLevels, options = {}) {
    const list = await buildModelsList(["llm"], { scope: "visible", ...options });
    for (const id of ["LOCAL27b", "nested", `workhorse/${model}`, `workhorse/${model}-vision`]) {
      expect(list.find((entry) => entry.id === id)).toMatchObject({
        context_length: context,
        max_completion_tokens: 16384,
        capabilities: { contextWindow: context, reasoning: true },
        thinking_levels: thinkingLevels,
      });
    }
    return list;
  }

  it("uses synced capabilities and updates the window after a newer Detect", async () => {
    setup({
      lastSuccessAt: "2026-11-24T00:00:00Z",
      models: [{ id: model, contextLength: 163840, capabilities: { reasoning: true, thinkingLevels: levels } }],
    });
    db.getModelMeta.mockResolvedValue({
      [`${provider}|${model}`]: { contextWindow: 65536, checkedAt: "2026-11-23T00:00:00Z" },
    });
    await expectMetadata(163840, levels);
    db.getModelMeta.mockResolvedValue({
      [`${provider}|${model}`]: { contextWindow: 147456, checkedAt: "2026-11-25T00:00:00Z" },
    });
    await expectMetadata(147456, levels);
  });

  it("reads a compatible node without a synced catalog without exposing extra IDs", async () => {
    setup();
    const listModels = vi.fn(async () => Response.json({ data: [
      { id: model, context_length: 163840, reasoning: true, supported_reasoning_efforts: levels },
      { id: "uncurated" },
    ] }));
    vi.stubGlobal("fetch", listModels);
    const list = await expectMetadata(163840, levels);
    expect(listModels).toHaveBeenCalledWith("https://workhorse.example/v1/models", expect.anything());
    expect(list.some((entry) => entry.id === "workhorse/uncurated")).toBe(false);
  });
});
