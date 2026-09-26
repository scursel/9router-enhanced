// Task 2 — server import core + rules. Covers src/lib/modelImport/{internal,candidates,runImport,rules}.js.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fakes = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getProviderConnections: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  addCustomModel: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getApiKeys: fakes.getApiKeys,
  getProviderConnections: fakes.getProviderConnections,
  getCustomModels: fakes.getCustomModels,
  getModelAliases: fakes.getModelAliases,
  addCustomModel: fakes.addCustomModel,
  setModelMeta: vi.fn(async () => ({})),
  getSettings: fakes.getSettings,
  updateSettings: fakes.updateSettings,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => "fake-machine-id"),
}));

const { internalBaseUrl, getInternalHeaders } = await import("@/lib/modelImport/internal.js");
const {
  resolveStorageAlias,
  importPrefixes,
  listImportCandidates,
  MAX_CONNECTION_ATTEMPTS,
} = await import("@/lib/modelImport/candidates.js");
const { runImport, IMPORT_TEST_CONCURRENCY } = await import("@/lib/modelImport/runImport.js");
const {
  getImportRule,
  listImportRules,
  saveImportRule,
  deleteImportRule,
} = await import("@/lib/modelImport/rules.js");

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// internal.js
// ---------------------------------------------------------------------------
describe("internalBaseUrl", () => {
  const originalPort = process.env.PORT;

  it("uses process.env.PORT when set", () => {
    process.env.PORT = "31337";
    try {
      expect(internalBaseUrl()).toBe("http://127.0.0.1:31337");
    } finally {
      if (originalPort === undefined) delete process.env.PORT;
      else process.env.PORT = originalPort;
    }
  });

  it("falls back to UPDATER_CONFIG.appPort when PORT unset", () => {
    delete process.env.PORT;
    try {
      expect(internalBaseUrl()).toBe("http://127.0.0.1:20128");
    } finally {
      if (originalPort !== undefined) process.env.PORT = originalPort;
    }
  });
});

describe("getInternalHeaders", () => {
  it("includes bearer token from first active api key and the cli token header", async () => {
    fakes.getApiKeys.mockResolvedValue([
      { key: "inactive-key", isActive: false },
      { key: "active-key", isActive: true },
    ]);
    const headers = await getInternalHeaders();
    expect(headers["Authorization"]).toBe("Bearer active-key");
    expect(headers["x-9r-cli-token"]).toBe("fake-machine-id");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("omits Authorization when no api keys exist", async () => {
    fakes.getApiKeys.mockResolvedValue([]);
    const headers = await getInternalHeaders();
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("fails open when getApiKeys throws", async () => {
    fakes.getApiKeys.mockRejectedValue(new Error("db down"));
    const headers = await getInternalHeaders();
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["x-9r-cli-token"]).toBe("fake-machine-id");
  });
});

// ---------------------------------------------------------------------------
// candidates.js
// ---------------------------------------------------------------------------
describe("resolveStorageAlias", () => {
  it("returns the provider id verbatim for openai-compatible connections", () => {
    expect(resolveStorageAlias("openai-compatible-foo")).toBe("openai-compatible-foo");
  });

  it("returns the provider id verbatim for anthropic-compatible connections", () => {
    expect(resolveStorageAlias("anthropic-compatible-foo")).toBe("anthropic-compatible-foo");
  });

  it("returns the provider alias for a regular registry provider", () => {
    // opencode's alias is "oc" in the registry (differs from its id)
    expect(resolveStorageAlias("opencode")).toBe("oc");
  });
});

describe("importPrefixes", () => {
  it("dedupes storageAlias, providerId, and alias", () => {
    const prefixes = importPrefixes("opencode");
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes).toContain("opencode");
    expect(prefixes).toContain("oc");
  });

  it("adds qoder/qoder-cn cross prefixes for qoder", () => {
    const prefixes = importPrefixes("qoder");
    expect(prefixes).toContain("qoder");
    expect(prefixes).toContain("qoder-cn");
  });

  it("adds qoder/qoder-cn cross prefixes for qoder-cn", () => {
    const prefixes = importPrefixes("qoder-cn");
    expect(prefixes).toContain("qoder");
    expect(prefixes).toContain("qoder-cn");
  });

  it("does not add qoder prefixes for unrelated providers", () => {
    const prefixes = importPrefixes("openrouter");
    expect(prefixes).not.toContain("qoder");
  });
});

describe("listImportCandidates", () => {
  beforeEach(() => {
    fakes.getProviderConnections.mockResolvedValue([]);
    fakes.getCustomModels.mockResolvedValue([]);
    fakes.getModelAliases.mockResolvedValue({});
    fakes.getApiKeys.mockResolvedValue([]);
  });

  it("uses the active connection's /models route when one exists", async () => {
    fakes.getProviderConnections.mockResolvedValue([
      { id: "conn-inactive", isActive: false },
      { id: "conn-active", isActive: true },
    ]);
    fakes.getApiKeys.mockResolvedValue([{ key: "test-key", isActive: true }]);
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toContain("/api/providers/conn-active/models");
      // Verify internal headers are sent
      expect(init?.headers).toBeDefined();
      expect(init.headers["x-9r-cli-token"]).toBe("fake-machine-id");
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ id: "openrouter/model-a", name: "Model A" }] }),
      };
    });

    const result = await listImportCandidates("openrouter", { fetchImpl });
    expect(result.source).toBe("connection");
    expect(result.connectionId).toBe("conn-active");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.candidates.map((c) => c.id)).toEqual(["model-a"]);
  });

  it("tries healthy accounts first and falls through an empty list to the next account", async () => {
    fakes.getProviderConnections.mockResolvedValue([
      { id: "conn-dead", isActive: true, testStatus: "error" },
      { id: "conn-empty", isActive: true, testStatus: "active" },
      { id: "conn-good", isActive: true, testStatus: "active" },
    ]);
    const calls = [];
    const fetchImpl = vi.fn(async (url) => {
      const id = String(url).match(/providers\/([^/]+)\/models/)[1];
      calls.push(id);
      const models = id === "conn-good" ? [{ id: "model-a" }] : [];
      return { ok: true, status: 200, json: async () => ({ models, warning: id === "conn-empty" ? "no models" : undefined }) };
    });

    const result = await listImportCandidates("openrouter", { fetchImpl });
    expect(calls).toEqual(["conn-empty", "conn-good"]);
    expect(result.connectionId).toBe("conn-good");
    expect(result.candidates.map((c) => c.id)).toEqual(["model-a"]);
    expect(result.warning).toBeUndefined();
  });

  it("stops after MAX_CONNECTION_ATTEMPTS accounts and reports the last warning", async () => {
    fakes.getProviderConnections.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({ id: `conn-${i}`, isActive: true })),
    );
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [], warning: "Failed to fetch Zed models: Invalid Authorization header" }),
    }));

    const result = await listImportCandidates("zed", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_CONNECTION_ATTEMPTS);
    expect(result.candidates).toEqual([]);
    expect(result.warning).toBe("Failed to fetch Zed models: Invalid Authorization header");
  });

  it("uses a later account when an earlier one errors, but throws when every attempt errors", async () => {
    fakes.getProviderConnections.mockResolvedValue([
      { id: "conn-1", isActive: true },
      { id: "conn-2", isActive: true },
    ]);
    const okSecond = vi.fn(async (url) => String(url).includes("conn-1")
      ? { ok: false, status: 401, json: async () => ({ error: "expired" }) }
      : { ok: true, status: 200, json: async () => ({ models: [{ id: "model-b" }] }) });
    const result = await listImportCandidates("openrouter", { fetchImpl: okSecond });
    expect(result.connectionId).toBe("conn-2");

    const allFail = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: "expired" }) }));
    await expect(listImportCandidates("openrouter", { fetchImpl: allFail })).rejects.toThrow("expired");
  });

  it("throws when the connection's /models route responds non-OK", async () => {
    fakes.getProviderConnections.mockResolvedValue([{ id: "conn-1", isActive: true }]);
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    }));

    await expect(listImportCandidates("openrouter", { fetchImpl })).rejects.toThrow("boom");
  });

  it("falls back to HTTP status when non-OK body has no error field", async () => {
    fakes.getProviderConnections.mockResolvedValue([{ id: "conn-1", isActive: true }]);
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));

    await expect(listImportCandidates("openrouter", { fetchImpl })).rejects.toThrow("HTTP 503");
  });

  it("falls back to the suggested-models catalog when no active connection but modelsFetcher exists", async () => {
    fakes.getProviderConnections.mockResolvedValue([]);
    fakes.getApiKeys.mockResolvedValue([{ key: "test-key", isActive: true }]);
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toContain("/api/providers/suggested-models?");
      expect(String(url)).toContain("url=");
      expect(String(url)).toContain("type=");
      // Verify internal headers are sent
      expect(init?.headers).toBeDefined();
      expect(init.headers["x-9r-cli-token"]).toBe("fake-machine-id");
      return { ok: true, status: 200, json: async () => ({ data: [{ id: "model-b", name: "Model B" }] }) };
    });

    // alicode has a modelsFetcher in the registry (url + type "openai")
    const result = await listImportCandidates("alicode", { fetchImpl });
    expect(result.source).toBe("catalog");
    expect(result.connectionId).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws when the suggested-models catalog responds non-OK", async () => {
    fakes.getProviderConnections.mockResolvedValue([]);
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "unauthorized" }),
    }));

    await expect(listImportCandidates("alicode", { fetchImpl })).rejects.toThrow("unauthorized");
  });

  it("falls back to HTTP status when catalog body has no error field", async () => {
    fakes.getProviderConnections.mockResolvedValue([]);
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));

    await expect(listImportCandidates("alicode", { fetchImpl })).rejects.toThrow("HTTP 503");
  });

  it("reports source none with no connection and no modelsFetcher", async () => {
    fakes.getProviderConnections.mockResolvedValue([]);
    const fetchImpl = vi.fn();

    // groq has no active connection and (per registry) no modelsFetcher entry
    const result = await listImportCandidates("groq", { fetchImpl });
    expect(result.source).toBe("none");
    expect(result.candidates).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("folds the live /models list into existingIds for cursor/zed so none show as new", async () => {
    fakes.getProviderConnections.mockResolvedValue([{ id: "conn-1", isActive: true }]);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { id: "cursor-fast", name: "Cursor Fast" },
          { id: "cursor-slow", name: "Cursor Slow" },
        ],
      }),
    }));

    const result = await listImportCandidates("cursor", { fetchImpl });
    expect(result.source).toBe("connection");
    expect(result.candidates.every((c) => c.alreadyImported)).toBe(true);
  });

  it("does not fold the live /models list into existingIds for a non-live-catalog provider", async () => {
    fakes.getProviderConnections.mockResolvedValue([{ id: "conn-1", isActive: true }]);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ id: "some-model", name: "Some Model" }] }),
    }));

    const result = await listImportCandidates("openrouter", { fetchImpl });
    expect(result.candidates.find((c) => c.id === "some-model").alreadyImported).toBe(false);
  });

  it("unions existingIds from static catalog, custom models, and prefixed aliases", async () => {
    fakes.getProviderConnections.mockResolvedValue([{ id: "conn-1", isActive: true }]);
    fakes.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "already-custom" },
      { providerAlias: "other-provider", id: "not-this-one" },
    ]);
    fakes.getModelAliases.mockResolvedValue({
      someAlias: "oc/already-aliased",
      otherAlias: "unrelated/other-model",
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { id: "opencode/already-custom", name: "Already Custom" },
          { id: "opencode/already-aliased", name: "Already Aliased" },
          { id: "opencode/brand-new", name: "Brand New" },
        ],
      }),
    }));

    // opencode's storage alias is "oc" (differs from its id), exercising the
    // storageAlias-based existingIds union (custom models + prefixed aliases).
    const result = await listImportCandidates("opencode", { fetchImpl });
    const byId = Object.fromEntries(result.candidates.map((c) => [c.id, c]));
    expect(byId["already-custom"].alreadyImported).toBe(true);
    expect(byId["already-aliased"].alreadyImported).toBe(true);
    expect(byId["brand-new"].alreadyImported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runImport.js
// ---------------------------------------------------------------------------
describe("runImport", () => {
  it("without testFirst, imports all models sequentially without pinging", async () => {
    const addModel = vi.fn(async () => true);
    const ping = vi.fn();

    const result = await runImport({
      storageAlias: "oc",
      models: [{ id: "m1", kind: "llm", name: "M1" }, { id: "m2", kind: "llm", name: "M2" }],
      testFirst: false,
      deps: { ping, addModel },
    });

    expect(ping).not.toHaveBeenCalled();
    expect(addModel).toHaveBeenCalledTimes(2);
    expect(result.imported).toEqual(["m1", "m2"]);
    expect(result.failed).toEqual([]);
  });

  it("dedupes models by id", async () => {
    const addModel = vi.fn(async () => true);
    const result = await runImport({
      storageAlias: "oc",
      models: [{ id: "m1", kind: "llm", name: "M1" }, { id: "m1", kind: "llm", name: "dup" }],
      testFirst: false,
      deps: { ping: vi.fn(), addModel },
    });
    expect(addModel).toHaveBeenCalledTimes(1);
    expect(result.imported).toEqual(["m1"]);
  });

  it("reports addModel failure without testFirst", async () => {
    const addModel = vi.fn(async ({ id }) => {
      if (id === "bad") throw new Error("insert failed");
      return true;
    });
    const result = await runImport({
      storageAlias: "oc",
      models: [{ id: "good", kind: "llm", name: "Good" }, { id: "bad", kind: "llm", name: "Bad" }],
      testFirst: false,
      deps: { ping: vi.fn(), addModel },
    });
    expect(result.imported).toEqual(["good"]);
    expect(result.failed).toEqual([{ id: "bad", error: "insert failed" }]);
  });

  it("with testFirst, only imports models that ping ok", async () => {
    const addModel = vi.fn(async () => true);
    const ping = vi.fn(async (model) => {
      if (model.endsWith("bad")) return { ok: false, status: 500, error: "nope" };
      return { ok: true, status: 200, kind: "llm", latencyMs: 12 };
    });

    const result = await runImport({
      storageAlias: "oc",
      models: [
        { id: "good1", kind: "llm", name: "Good1" },
        { id: "bad", kind: "llm", name: "Bad" },
        { id: "good2", kind: "llm", name: "Good2" },
      ],
      testFirst: true,
      deps: { ping, addModel },
    });

    expect(result.imported.sort()).toEqual(["good1", "good2"]);
    expect(result.failed).toEqual([{ id: "bad", error: "nope" }]);
    expect(addModel).toHaveBeenCalledTimes(2);
  });

  it("pings the first model alone as a warm-up before the rest start", async () => {
    const order = [];
    const addModel = vi.fn(async () => true);
    const ping = vi.fn(async (model) => {
      order.push(`start:${model}`);
      // Yield so concurrent calls would interleave here if they were running.
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${model}`);
      return { ok: true, status: 200, kind: "llm" };
    });

    await runImport({
      storageAlias: "oc",
      models: [
        { id: "first", kind: "llm", name: "First" },
        { id: "second", kind: "llm", name: "Second" },
        { id: "third", kind: "llm", name: "Third" },
      ],
      testFirst: true,
      deps: { ping, addModel },
    });

    // The warm-up ping for "first" must fully complete (start+end) before any
    // other ping starts.
    const firstEndIndex = order.indexOf("end:oc/first");
    const secondStartIndex = order.indexOf("start:oc/second");
    const thirdStartIndex = order.indexOf("start:oc/third");
    expect(firstEndIndex).toBeGreaterThanOrEqual(0);
    expect(secondStartIndex).toBeGreaterThan(firstEndIndex);
    expect(thirdStartIndex).toBeGreaterThan(firstEndIndex);
  });

  it("respects the concurrency bound for the pool after warm-up", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const addModel = vi.fn(async () => true);
    const ping = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return { ok: true, status: 200, kind: "llm" };
    });

    const models = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, kind: "llm", name: `M${i}` }));
    await runImport({
      storageAlias: "oc",
      models,
      testFirst: true,
      concurrency: 3,
      deps: { ping, addModel },
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("uses the ping result's kind, falling back to the model's declared kind", async () => {
    const addModel = vi.fn(async () => true);
    const ping = vi.fn(async () => ({ ok: true, status: 200, kind: "embedding" }));

    await runImport({
      storageAlias: "oc",
      models: [{ id: "m1", kind: "llm", name: "M1" }],
      testFirst: true,
      deps: { ping, addModel },
    });

    expect(addModel).toHaveBeenCalledWith(
      expect.objectContaining({ providerAlias: "oc", id: "m1", type: "embedding", name: "M1" }),
    );
  });

  it("reports a ping throw as a failure with the thrown message", async () => {
    const addModel = vi.fn(async () => true);
    const ping = vi.fn(async () => {
      throw new Error("network exploded");
    });

    const result = await runImport({
      storageAlias: "oc",
      models: [{ id: "m1", kind: "llm", name: "M1" }],
      testFirst: true,
      deps: { ping, addModel },
    });

    expect(result.imported).toEqual([]);
    expect(result.failed).toEqual([{ id: "m1", error: "network exploded" }]);
    expect(addModel).not.toHaveBeenCalled();
  });

  it("emits lifecycle events and swallows onEvent exceptions", async () => {
    const addModel = vi.fn(async () => true);
    const ping = vi.fn(async () => ({ ok: true, status: 200, kind: "llm", latencyMs: 3 }));
    const events = [];
    const onEvent = vi.fn((event) => {
      events.push(event);
      throw new Error("listener blew up");
    });

    const result = await runImport({
      storageAlias: "oc",
      models: [{ id: "m1", kind: "llm", name: "M1" }],
      testFirst: true,
      onEvent,
      deps: { ping, addModel },
    });

    expect(result.imported).toEqual(["m1"]);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("testing");
    expect(types).toContain("tested");
    expect(types).toContain("imported");
    expect(types[types.length - 1]).toBe("done");
  });

  it("exports IMPORT_TEST_CONCURRENCY as 4", () => {
    expect(IMPORT_TEST_CONCURRENCY).toBe(4);
  });

  it("forceKind overrides the stored type regardless of the model's own kind or the ping result's kind", async () => {
    const addModel = vi.fn(async () => true);
    const ping = vi.fn(async () => ({ ok: true, status: 200, kind: "embedding" }));

    await runImport({
      storageAlias: "oc",
      models: [{ id: "m1", kind: "llm", name: "M1" }],
      testFirst: true,
      forceKind: "llm",
      deps: { ping, addModel },
    });

    expect(addModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m1", type: "llm" }),
    );
  });

  it("forceKind also applies without testFirst", async () => {
    const addModel = vi.fn(async () => true);

    await runImport({
      storageAlias: "oc",
      models: [{ id: "m1", kind: "image", name: "M1" }],
      testFirst: false,
      forceKind: "llm",
      deps: { ping: vi.fn(), addModel },
    });

    expect(addModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m1", type: "llm" }),
    );
  });

  it("stops starting new models once the signal is aborted, but still emits done (testFirst)", async () => {
    const controller = new AbortController();
    const addModel = vi.fn(async () => true);
    let calls = 0;
    const ping = vi.fn(async () => {
      calls += 1;
      // Abort right after the warm-up ping (for m0) so nothing else starts.
      if (calls === 1) controller.abort();
      return { ok: true, status: 200, kind: "llm" };
    });

    const models = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, kind: "llm", name: `M${i}` }));
    const events = [];
    const result = await runImport({
      storageAlias: "oc",
      models,
      testFirst: true,
      concurrency: 1,
      signal: controller.signal,
      onEvent: (e) => events.push(e),
      deps: { ping, addModel },
    });

    // Only the warm-up model (m0) is pinged — nothing else starts after abort.
    expect(ping).toHaveBeenCalledTimes(1);
    expect(result.imported).toEqual(["m0"]);
    expect(events[events.length - 1].type).toBe("done");
  });

  it("stops starting new models once aborted before the run begins (no testFirst)", async () => {
    const controller = new AbortController();
    controller.abort();
    const addModel = vi.fn(async () => true);

    const result = await runImport({
      storageAlias: "oc",
      models: [{ id: "m1", kind: "llm", name: "M1" }, { id: "m2", kind: "llm", name: "M2" }],
      testFirst: false,
      signal: controller.signal,
      deps: { ping: vi.fn(), addModel },
    });

    expect(addModel).not.toHaveBeenCalled();
    expect(result.imported).toEqual([]);
  });

  it("with testFirst, fails tts models locally without pinging (ping.js has no tts probe)", async () => {
    const addModel = vi.fn(async () => true);
    const ping = vi.fn(async () => ({ ok: true, status: 200, kind: "llm" }));

    const result = await runImport({
      storageAlias: "oc",
      models: [{ id: "voice-1", kind: "tts", name: "Voice 1" }],
      testFirst: true,
      deps: { ping, addModel },
    });

    expect(ping).not.toHaveBeenCalled();
    expect(addModel).not.toHaveBeenCalled();
    expect(result.imported).toEqual([]);
    expect(result.failed).toEqual([
      { id: "voice-1", error: "Can't test TTS models — import with 'Test before import' off" },
    ]);
  });

  it("without testFirst, tts models import normally (no probe involved either way)", async () => {
    const addModel = vi.fn(async () => true);

    const result = await runImport({
      storageAlias: "oc",
      models: [{ id: "voice-1", kind: "tts", name: "Voice 1" }],
      testFirst: false,
      deps: { ping: vi.fn(), addModel },
    });

    expect(result.imported).toEqual(["voice-1"]);
    expect(addModel).toHaveBeenCalledWith(expect.objectContaining({ id: "voice-1", type: "tts" }));
  });
});

// ---------------------------------------------------------------------------
// rules.js
// ---------------------------------------------------------------------------
describe("import auto rules", () => {
  it("round-trips a saved rule through getImportRule", async () => {
    let stored = { autoModelImportRules: {} };
    fakes.getSettings.mockImplementation(async () => ({ ...stored }));
    fakes.updateSettings.mockImplementation(async (updates) => {
      stored = { ...stored, ...updates };
      return stored;
    });

    expect(await getImportRule("openrouter")).toBeNull();

    const saved = await saveImportRule("openrouter", {
      filters: { onlyNew: false, tiers: ["free"] },
      testFirst: true,
    });

    expect(saved.testFirst).toBe(true);
    expect(saved.filters.onlyNew).toBe(false);
    expect(saved.filters.tiers).toEqual(["free"]);
    expect(typeof saved.updatedAt).toBe("string");

    const fetched = await getImportRule("openrouter");
    expect(fetched).toEqual(saved);

    const all = await listImportRules();
    expect(Object.keys(all)).toEqual(["openrouter"]);
  });

  it("only touches the given provider's key when read-modify-writing", async () => {
    let stored = {
      autoModelImportRules: {
        existing: { filters: {}, testFirst: false, updatedAt: "2020-01-01T00:00:00.000Z" },
      },
    };
    fakes.getSettings.mockImplementation(async () => ({ ...stored }));
    fakes.updateSettings.mockImplementation(async (updates) => {
      stored = { ...stored, ...updates };
      return stored;
    });

    await saveImportRule("new-provider", { filters: {}, testFirst: false });
    const all = await listImportRules();
    expect(Object.keys(all).sort()).toEqual(["existing", "new-provider"]);
    expect(all.existing.updatedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("deleteImportRule removes only the targeted provider", async () => {
    let stored = {
      autoModelImportRules: {
        a: { filters: {}, testFirst: false, updatedAt: "x" },
        b: { filters: {}, testFirst: false, updatedAt: "y" },
      },
    };
    fakes.getSettings.mockImplementation(async () => ({ ...stored }));
    fakes.updateSettings.mockImplementation(async (updates) => {
      stored = { ...stored, ...updates };
      return stored;
    });

    await deleteImportRule("a");
    const all = await listImportRules();
    expect(Object.keys(all)).toEqual(["b"]);
  });

  it("getImportRule returns null for prototype-property-shaped ids like 'constructor'", async () => {
    fakes.getSettings.mockResolvedValue({ autoModelImportRules: {} });
    expect(await getImportRule("constructor")).toBeNull();
    expect(await getImportRule("toString")).toBeNull();
    expect(await getImportRule("hasOwnProperty")).toBeNull();
  });

  it("normalizes filters through normalizeImportFilters on save", async () => {
    let stored = { autoModelImportRules: {} };
    fakes.getSettings.mockImplementation(async () => ({ ...stored }));
    fakes.updateSettings.mockImplementation(async (updates) => {
      stored = { ...stored, ...updates };
      return stored;
    });

    const saved = await saveImportRule("p", { filters: { tiers: ["bogus", "free"] }, testFirst: "yes" });
    expect(saved.filters.tiers).toEqual(["free"]);
    expect(saved.testFirst).toBe(false);
  });
});

describe("runImport — provider metadata", () => {
  it("saves the context window and reasoning the provider list reported", async () => {
    const { runImport } = await import("@/lib/modelImport/runImport.js");
    const saveMeta = vi.fn(async () => ({}));
    const addModel = vi.fn(async () => true);
    await runImport({
      storageAlias: "openrouter",
      models: [
        { id: "a", kind: "llm", name: "A", contextLength: 200000, reasoning: true },
        { id: "b", kind: "llm", name: "B", contextLength: null, reasoning: null },
      ],
      deps: { addModel, saveMeta },
    });
    expect(saveMeta).toHaveBeenCalledTimes(1);
    expect(saveMeta).toHaveBeenCalledWith("openrouter", "a", { contextWindow: 200000, reasoning: true, source: "provider" });
  });
});

