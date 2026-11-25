import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/models", () => ({
  getProviderConnections: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

// Keep sync hermetic: no DNS resolution in unit tests. The wrapper forwards
// to the per-test global fetch stub.
vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  assertPublicUrl: vi.fn(),
  fetchPublic: (...args) => globalThis.fetch(...args),
}));
import {
  catalogStatus,
  classifyTier,
  getConnectionCatalog,
  isConnectionCatalogStale,
  normalizedModels,
  resolveModelsUrl,
  listConnectionModels,
  syncConnectionCatalog,
} from "../../src/lib/modelSync/connectionCatalog.js";
import {
  getProviderConnections,
  getProviderConnectionById,
  updateProviderConnection,
} from "@/models";

const OPENAI_LIST = (ids) => ({
  data: ids.map((id) => (typeof id === "string" ? { id } : id)),
});

function installFetch(handler) {
  globalThis.fetch = vi.fn(async (...args) => handler(...args));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("classifyTier", () => {
  it("marks explicit :free suffix and -free suffix as free", () => {
    expect(classifyTier({ id: "x/model:free" }).tier).toBe("free");
    expect(classifyTier({ id: "muse-spark-1.2-free" }).tier).toBe("free");
  });

  it("marks provider free flags as free", () => {
    expect(classifyTier({ id: "m", free: true }).tier).toBe("free");
    expect(classifyTier({ id: "m", is_free: true }).tier).toBe("free");
  });

  it("marks zero provider prices as free", () => {
    expect(classifyTier({ id: "m", pricing: { prompt: "0", completion: "0" } }).tier).toBe("free");
    expect(classifyTier({ id: "m", pricing: { prompt: 0, completion: 0 } }).tier).toBe("free");
  });

  it("marks nonzero provider prices as paid", () => {
    const out = classifyTier({ id: "m", pricing: { prompt: "0.000001", completion: "0.000005" } });
    expect(out.tier).toBe("paid");
    expect(out.tierSource).toBe("provider-price");
  });

  it("marks per-request pricing without token prices as credits, not paid", () => {
    const out = classifyTier({ id: "img-model", pricing: { request: "0.02" } });
    expect(out.tier).toBe("credits");
  });

  it("leaves models without any price signal as unknown, never paid", () => {
    const out = classifyTier({ id: "mystery-model" });
    expect(out.tier).toBe("unknown");
    expect(out.tier).not.toBe("paid");
  });

  it("applies curated rules only for the matching provider", () => {
    expect(classifyTier({ id: "orcarouter/free" }, { providerId: "orcarouter" }).tier).toBe("free");
    expect(classifyTier({ id: "orcarouter/free" }, { providerId: "other" }).tier).toBe("unknown");
  });

  // Precedence (MODEL_SYNC_CATALOG.md): price → markers → curated → unknown.
  // models.dev overlay fills unknowns later at the /v1/models route layer.
  it("lets provider price beat :free/-free suffix and free flags", () => {
    expect(classifyTier({ id: "x:free", pricing: { prompt: 0.01, completion: 0.03 } })).toEqual({
      tier: "paid",
      tierSource: "provider-price",
    });
    expect(classifyTier({ id: "muse-spark-1.2-free", pricing: { prompt: 1, completion: 1 } }).tier).toBe("paid");
    expect(classifyTier({ id: "m", free: true, pricing: { prompt: 1, completion: 1 } }).tier).toBe("paid");
    expect(classifyTier({ id: "m", is_free: true, pricing: { prompt: 0.5, completion: 0.5 } }).tier).toBe("paid");
  });

  it("lets provider price beat curated free ids", () => {
    expect(
      classifyTier(
        { id: "orcarouter/free", pricing: { prompt: 0.01, completion: 0.02 } },
        { providerId: "orcarouter" },
      ).tier,
    ).toBe("paid");
  });

  it("treats half-zero token prices as paid, not free", () => {
    expect(classifyTier({ id: "m", pricing: { prompt: 0, completion: 0.01 } })).toEqual({
      tier: "paid",
      tierSource: "provider-price",
    });
    expect(classifyTier({ id: "m", pricing: { prompt: 0.01, completion: 0 } }).tier).toBe("paid");
  });

  it("classifies prompt:0 + per-request pricing as credits", () => {
    expect(classifyTier({ id: "img", pricing: { prompt: 0, request: "0.02" } })).toEqual({
      tier: "credits",
      tierSource: "provider-price",
    });
  });

  it("still uses markers when there is no price signal", () => {
    expect(classifyTier({ id: "x:free" }).tier).toBe("free");
    expect(classifyTier({ id: "m", free: true }).tier).toBe("free");
  });
});

describe("resolveModelsUrl", () => {
  it("strips chat/completions (and messages/responses) before appending /models", () => {
    expect(resolveModelsUrl({
      provider: "alicode-intl",
      providerSpecificData: {
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
      },
    })).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models");

    expect(resolveModelsUrl({
      provider: "custom",
      providerSpecificData: { baseUrl: "https://example.com/v1/messages" },
    })).toBe("https://example.com/v1/models");

    expect(resolveModelsUrl({
      provider: "custom",
      providerSpecificData: { baseUrl: "https://example.com/v1/responses" },
    })).toBe("https://example.com/v1/models");
  });

  it("falls back to registry modelsFetcher when no per-account baseUrl", () => {
    const url = resolveModelsUrl({ provider: "bai", providerSpecificData: {} });
    expect(url).toMatch(/\/models$/);
  });

  it("syncs openrouter-free and opencode-free fetcher types (OpenAI-shaped lists)", () => {
    expect(resolveModelsUrl({ provider: "openrouter", providerSpecificData: {} }))
      .toBe("https://openrouter.ai/api/v1/models");
    expect(resolveModelsUrl({ provider: "opencode", providerSpecificData: {} }))
      .toBe("https://opencode.ai/zen/v1/models");
  });

  it("syncs clinepass and nvidia model listings", () => {
    expect(resolveModelsUrl({ provider: "clinepass", providerSpecificData: {} }))
      .toBe("https://api.cline.bot/api/v1/models");
    expect(resolveModelsUrl({ provider: "nvidia", providerSpecificData: {} }))
      .toBe("https://integrate.api.nvidia.com/v1/models");
  });

  it("lists Cline models from the same Cline /v1/models host as chat", () => {
    expect(resolveModelsUrl({ provider: "cline", providerSpecificData: {} }))
      .toBe("https://api.cline.bot/api/v1/models");
  });
});

describe("listConnectionModels", () => {
  it("fetches the registry modelsFetcher URL with the connection token", async () => {
    installFetch(async (url, init) => {
      expect(String(url)).toBe("https://api.cline.bot/api/v1/models");
      expect(init.headers.Authorization).toBe("Bearer cline-token");
      return new Response(JSON.stringify({
        data: [
          { id: "anthropic/claude-sonnet-4.6", pricing: { prompt: "0", completion: "0" } },
          { id: "openai/gpt-5.4", pricing: { prompt: "0.001", completion: "0.002" } },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const result = await listConnectionModels({
      id: "conn-cline",
      provider: "cline",
      accessToken: "cline-token",
      providerSpecificData: {},
    });

    expect(result.error).toBeUndefined();
    expect(result.models.map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-4.6",
      "openai/gpt-5.4",
    ]);
    expect(result.models[0].tier).toBe("free");
    expect(result.models[1].tier).toBe("paid");
  });
});

describe("normalizedModels", () => {
  it("builds a new catalog from an OpenAI-style list", () => {
    const models = normalizedModels(OPENAI_LIST(["a", "b"]), { providerId: "bai" });
    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
    expect(models.every((m) => m.availability === undefined)).toBe(true);
  });

  it("preserves top-level context and advertised reasoning effort levels", () => {
    const [model] = normalizedModels({ data: [{
      id: "qwen38-gguf-mtp",
      context_length: 163840,
      reasoning: true,
      supported_reasoning_efforts: ["none", "low", "medium", "high", "max"],
    }] });
    expect(model).toMatchObject({
      contextLength: 163840,
      capabilities: { reasoning: true, thinkingLevels: ["none", "low", "medium", "high", "max"] },
    });
  });

  it("never announces image/embedding ids as chat: kind is preserved", () => {
    const models = normalizedModels(
      OPENAI_LIST(["flux-pro", "text-embedding-3-small", "chat-model"]),
      { providerId: "bai" },
    );
    const byId = new Map(models.map((m) => [m.id, m.kind]));
    expect(byId.get("flux-pro")).toBe("image");
    expect(byId.get("text-embedding-3-small")).toBe("embedding");
    expect(byId.get("chat-model")).toBe("llm");
  });
});

describe("syncConnectionCatalog", () => {
  const conn = (overrides = {}) => ({
    id: "conn-1",
    provider: "bai",
    apiKey: "secret-key",
    providerSpecificData: {},
    ...overrides,
  });

  it("stores a new catalog with availability available and a success timestamp", async () => {
    installFetch(async () => new Response(JSON.stringify(OPENAI_LIST(["m1", "m2"])), { status: 200 }));
    const saved = [];
    updateProviderConnection.mockImplementation(async (id, data) => {
      saved.push(data);
      return null;
    });

    const result = await syncConnectionCatalog(conn());
    expect(result.updated).toBe(true);
    expect(result.available).toBe(2);
    const catalog = saved[0].modelCatalog;
    expect(catalog.lastSuccessAt).toBeTruthy();
    expect(catalog.lastError).toBeNull();
    expect(catalog.models.map((m) => m.availability)).toEqual(["available", "available"]);
  });

  it("preserves capabilities/context the provider did not resend on update", async () => {
    installFetch(async () => new Response(JSON.stringify(OPENAI_LIST([{ id: "m1" }])), { status: 200 }));
    const saved = [];
    updateProviderConnection.mockImplementation(async (id, data) => {
      saved.push(data);
      return null;
    });

    const previous = {
      models: [{ id: "m1", capabilities: { vision: true }, contextLength: 200000 }],
      lastSuccessAt: new Date(Date.now() - 1000).toISOString(),
      lastError: null,
    };
    await syncConnectionCatalog(conn({ modelCatalog: previous }));
    const merged = saved[0].modelCatalog.models.find((m) => m.id === "m1");
    expect(merged.capabilities).toEqual({ vision: true });
    expect(merged.contextLength).toBe(200000);
  });

  it("keeps the previous catalog on network failure and records the error", async () => {
    installFetch(async () => {
      throw new Error("boom");
    });
    const saved = [];
    updateProviderConnection.mockImplementation(async (id, data) => {
      saved.push(data);
      return null;
    });

    const previous = {
      models: [{ id: "m1", availability: "available", missingSyncs: 0 }],
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
    };
    const result = await syncConnectionCatalog(conn({ modelCatalog: previous }));
    expect(result.updated).toBe(false);
    expect(saved[0].modelCatalog.models.map((m) => m.id)).toEqual(["m1"]);
    expect(saved[0].modelCatalog.lastError).toBeTruthy();
  });

  it("marks a model absent once as temporarily-absent, unavailable after two consecutive valid syncs", async () => {
    const saved = [];
    updateProviderConnection.mockImplementation(async (id, data) => {
      saved.push(data);
      return null;
    });

    installFetch(async () => new Response(JSON.stringify(OPENAI_LIST(["m1"])), { status: 200 }));
    const previous = {
      models: [
        { id: "m1", availability: "available", missingSyncs: 0 },
        { id: "m2", availability: "available", missingSyncs: 0 },
      ],
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
    };
    await syncConnectionCatalog(conn({ modelCatalog: previous }));
    const first = saved[0].modelCatalog.models.find((m) => m.id === "m2");
    expect(first.availability).toBe("temporarily-absent");
    expect(first.missingSyncs).toBe(1);

    saved.length = 0;
    await syncConnectionCatalog(conn({ modelCatalog: saved[0]?.modelCatalog || {
      models: [
        { id: "m1", availability: "available", missingSyncs: 0 },
        { id: "m2", availability: "temporarily-absent", missingSyncs: 1 },
      ],
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
    } }));
    const second = saved[0].modelCatalog.models.find((m) => m.id === "m2");
    expect(second.availability).toBe("unavailable");
    expect(second.missingSyncs).toBe(2);
  });

  it("never wipes the catalog on an empty 200 list", async () => {
    installFetch(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const saved = [];
    updateProviderConnection.mockImplementation(async (id, data) => {
      saved.push(data);
      return null;
    });
    const previous = {
      models: [{ id: "m1", availability: "available", missingSyncs: 0 }],
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
    };
    const result = await syncConnectionCatalog(conn({ modelCatalog: previous }));
    expect(result.updated).toBe(false);
    expect(saved[0].modelCatalog.models.map((m) => m.id)).toEqual(["m1"]);
  });

  it("does not send the api key in a loggable form: auth travels as a header only", async () => {
    let seenHeaders = null;
    installFetch(async (url, init) => {
      seenHeaders = init?.headers;
      return new Response(JSON.stringify(OPENAI_LIST(["m1"])), { status: 200 });
    });
    updateProviderConnection.mockImplementation(async () => null);
    await syncConnectionCatalog(conn());
    expect(seenHeaders?.Authorization).toBe("Bearer secret-key");
  });

  it("syncs by account id, resolving the connection first", async () => {
    installFetch(async () => new Response(JSON.stringify(OPENAI_LIST(["m1"])), { status: 200 }));
    getProviderConnectionById.mockResolvedValue(conn());
    updateProviderConnection.mockResolvedValue(null);
    const result = await syncConnectionCatalog("conn-1");
    expect(getProviderConnectionById).toHaveBeenCalledWith("conn-1");
    expect(result.updated).toBe(true);
  });

  it("skips providers whose fetcher is not OpenAI-shaped instead of erroring", async () => {
    installFetch(async () => { throw new Error("must not be called"); });
    updateProviderConnection.mockImplementation(async () => null);
    const result = await syncConnectionCatalog(conn({ provider: "mimo-free" }));
    expect(result.skipped).toBe(true);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe("catalog status helpers", () => {
  it("distinguishes never-synced, error, stale and ok", () => {
    expect(catalogStatus({})).toBe("never-synced");
    expect(catalogStatus({ modelCatalog: { models: [], lastError: "x" } })).toBe("error");
    expect(
      catalogStatus({ modelCatalog: { models: [{ id: "m" }], lastSuccessAt: new Date().toISOString(), lastError: "x" } }),
    ).toBe("stale");
    expect(
      catalogStatus({ modelCatalog: { models: [{ id: "m" }], lastSuccessAt: new Date().toISOString(), lastError: null } }),
    ).toBe("ok");
  });

  it("treats missing or day-old success timestamps as stale", () => {
    expect(isConnectionCatalogStale({})).toBe(true);
    expect(
      isConnectionCatalogStale({ modelCatalog: { lastSuccessAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() } }),
    ).toBe(true);
    expect(
      isConnectionCatalogStale({ modelCatalog: { lastSuccessAt: new Date().toISOString() } }),
    ).toBe(false);
  });

  it("getConnectionCatalog defaults safely", () => {
    expect(getConnectionCatalog(null)).toEqual({ models: [], lastSuccessAt: null, lastError: null });
    expect(getProviderConnections).toBeDefined();
  });
});
