import { describe, expect, it } from "vitest";
import {
  collectImportableModels,
  connectionCanSyncCatalog,
  providerCanImportModels,
  stripProviderPrefix,
  IMPORT_KINDS,
  IMPORT_TIERS,
  DEFAULT_IMPORT_FILTERS,
  buildImportCandidates,
  normalizeImportFilters,
  matchesIdPattern,
  applyImportFilters,
  formatContextLength,
  formatPricePerMillion,
  MIN_CONTEXT_OPTIONS,
} from "@/shared/utils/importProviderModels.js";
import REGISTRY from "open-sse/providers/registry/index.js";

describe("stripProviderPrefix", () => {
  it("strips the provider alias or id prefix from a listed model id", () => {
    expect(stripProviderPrefix("cl/anthropic/claude-sonnet-4.6", ["cl", "cline"])).toBe(
      "anthropic/claude-sonnet-4.6",
    );
    expect(stripProviderPrefix("qoder/auto", ["qo", "qoder"])).toBe("auto");
    expect(stripProviderPrefix("anthropic/claude-sonnet-4.6", ["cl", "cline"])).toBe(
      "anthropic/claude-sonnet-4.6",
    );
  });
});

describe("collectImportableModels", () => {
  const prefixes = ["cl", "cline"];
  const existingIds = new Set(["already-there"]);

  it("returns every listed id that is not already added", () => {
    const models = [
      { id: "anthropic/claude-sonnet-4.6" },
      { id: "already-there" },
      { id: "openai/gpt-5.4", pricing: { prompt: "0.001", completion: "0.002" } },
    ];
    expect(collectImportableModels({ models, existingIds, prefixes }).map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-4.6",
      "openai/gpt-5.4",
    ]);
  });

  it("keeps only free models when freeOnly is set", () => {
    const models = [
      { id: "openrouter/free-model:free" },
      { id: "paid/model", pricing: { prompt: "0.001", completion: "0.002" } },
      { id: "zero-price", pricing: { prompt: "0", completion: "0" } },
      { id: "flagged", is_free: true },
    ];
    expect(
      collectImportableModels({
        models,
        existingIds: new Set(),
        prefixes,
        freeOnly: true,
        providerId: "cline",
      }).map((m) => m.id),
    ).toEqual(["openrouter/free-model:free", "zero-price", "flagged"]);
  });

  it("does not treat unknown-price models as free", () => {
    const models = [{ id: "mystery-model" }, { id: "known:free" }];
    expect(
      collectImportableModels({
        models,
        existingIds: new Set(),
        prefixes,
        freeOnly: true,
      }).map((m) => m.id),
    ).toEqual(["known:free"]);
  });
});

describe("providerCanImportModels", () => {
  it("is true when the provider exposes a modelsFetcher", () => {
    expect(
      providerCanImportModels({ modelsFetcher: { url: "https://api.cline.bot/api/v1/models" } }),
    ).toBe(true);
  });

  it("is true for an active OpenAI/Anthropic-compatible node", () => {
    expect(providerCanImportModels({ hasActiveConnection: true, isCompatible: true })).toBe(true);
  });

  it("is true for an active connection with a chat baseUrl that can list /models", () => {
    expect(
      providerCanImportModels({
        hasActiveConnection: true,
        baseUrl: "https://api.example.com/v1",
      }),
    ).toBe(true);
  });

  it("is false for a random active connection that cannot list models", () => {
    expect(providerCanImportModels({ hasActiveConnection: true })).toBe(false);
  });

  it("is false with neither a fetcher nor a connection", () => {
    expect(providerCanImportModels({})).toBe(false);
  });
});

describe("connectionCanSyncCatalog", () => {
  it("is true when the provider has a modelsFetcher", () => {
    expect(
      connectionCanSyncCatalog({ modelsFetcher: { url: "https://api.cline.bot/api/v1/models" } }),
    ).toBe(true);
  });

  it("is true when the account has a baseUrl", () => {
    expect(connectionCanSyncCatalog({ baseUrl: "https://api.example.com/v1" })).toBe(true);
  });

  it("is false when neither a fetcher nor a baseUrl exists", () => {
    expect(connectionCanSyncCatalog({})).toBe(false);
  });
});

describe("Cline catalog", () => {
  it("points modelsFetcher at Cline's own /v1/models, same host as chat", () => {
    const cline = REGISTRY.find((r) => r.id === "cline");
    expect(cline.modelsFetcher).toEqual({
      url: "https://api.cline.bot/api/v1/models",
      type: "openai",
    });
    expect(cline.transport.baseUrl).toContain("api.cline.bot");
  });

  it("keeps ClinePass on the same Cline models URL", () => {
    const clinepass = REGISTRY.find((r) => r.id === "clinepass");
    expect(clinepass.modelsFetcher.url).toBe("https://api.cline.bot/api/v1/models");
  });
});

describe("buildImportCandidates, normalizeImportFilters, matchesIdPattern, applyImportFilters", () => {
  describe("IMPORT_KINDS", () => {
    it("exports correct kinds", () => {
      expect(IMPORT_KINDS).toEqual(["llm", "image", "embedding", "tts", "stt"]);
    });
  });

  describe("IMPORT_TIERS", () => {
    it("exports correct tiers", () => {
      expect(IMPORT_TIERS).toEqual(["free", "paid", "credits", "unknown"]);
    });
  });

  describe("DEFAULT_IMPORT_FILTERS", () => {
    it("exports correct default filters", () => {
      expect(DEFAULT_IMPORT_FILTERS).toEqual({
        search: "",
        tiers: [],
        kinds: [],
        onlyNew: true,
        minContext: 0,
        include: "",
        exclude: "",
      });
    });
  });

  describe("buildImportCandidates", () => {
    it("builds candidate objects with required fields", () => {
      const candidates = buildImportCandidates({
        models: [{ id: "gpt-4", name: "GPT-4", kind: "llm", tier: "paid" }],
      });
      expect(candidates[0]).toMatchObject({
        id: "gpt-4",
        name: "GPT-4",
        kind: "llm",
        tier: "paid",
        contextLength: null,
        pricing: null,
        alreadyImported: false,
      });
    });

    it("preserves input order and deduplicates by stripped id (first wins)", () => {
      const candidates = buildImportCandidates({
        models: [
          { id: "cl/model-a", name: "First A" },
          { id: "model-a", name: "Second A" }, // same stripped id, should be skipped
          { id: "model-b", name: "B" },
        ],
        prefixes: ["cl"],
      });
      expect(candidates.map((c) => c.name)).toEqual(["First A", "B"]);
    });

    it("uses model.id, fallback to model.name, fallback to model.model", () => {
      const candidates = buildImportCandidates({
        models: [{ name: "name-only" }, { model: "model-field" }],
      });
      expect(candidates.map((c) => c.id)).toEqual(["name-only", "model-field"]);
    });

    it("skips empty ids", () => {
      const candidates = buildImportCandidates({
        models: [{ id: "" }, { id: "   " }, { name: "valid" }],
      });
      expect(candidates.map((c) => c.id)).toEqual(["valid"]);
    });

    it("sets name to model.name or id", () => {
      const candidates = buildImportCandidates({
        models: [
          { id: "model1", name: "Custom Name" },
          { id: "model2" }, // no name, should use id
        ],
      });
      expect(candidates[0].name).toBe("Custom Name");
      expect(candidates[1].name).toBe("model2");
    });

    it("validates kind against IMPORT_KINDS, defaults to 'llm'", () => {
      const candidates = buildImportCandidates({
        models: [
          { id: "m1", kind: "image" },
          { id: "m2", kind: "invalid-kind" },
          { id: "m3" }, // no kind
        ],
      });
      expect(candidates[0].kind).toBe("image");
      expect(candidates[1].kind).toBe("llm");
      expect(candidates[2].kind).toBe("llm");
    });

    it("uses model.tier if in IMPORT_TIERS, else classifies from price/provider", () => {
      const candidates = buildImportCandidates({
        models: [
          { id: "m1", tier: "paid" }, // valid tier
          { id: "m2", tier: "invalid" }, // invalid tier, should classify
          { id: "m3", pricing: { prompt: "0.01", completion: "0.02" } }, // paid by price
          { id: "m4", pricing: { prompt: "0", completion: "0" } }, // free by price
        ],
        providerId: "openai",
      });
      expect(candidates[0].tier).toBe("paid");
      expect(candidates[1].tier).toBe("unknown"); // classifyTier returns unknown for invalid
      expect(candidates[2].tier).toBe("paid");
      expect(candidates[3].tier).toBe("free");
    });

    it("extracts contextLength from model.contextLength, model.context_length, or model.context_window", () => {
      const candidates = buildImportCandidates({
        models: [
          { id: "m1", contextLength: 4096 },
          { id: "m2", context_length: 8192 },
          { id: "m3", context_window: 16384 },
          { id: "m4" }, // no context
        ],
      });
      expect(candidates[0].contextLength).toBe(4096);
      expect(candidates[1].contextLength).toBe(8192);
      expect(candidates[2].contextLength).toBe(16384);
      expect(candidates[3].contextLength).toBeNull();
    });

    it("prefers first finite positive contextLength", () => {
      const candidates = buildImportCandidates({
        models: [
          { id: "m1", contextLength: 0, context_length: 1024 }, // 0 is not positive
          { id: "m2", contextLength: -100, context_window: 2048 }, // negative not positive
          { id: "m3", contextLength: null, context_length: 4096 }, // null not finite
        ],
      });
      expect(candidates[0].contextLength).toBe(1024);
      expect(candidates[1].contextLength).toBe(2048);
      expect(candidates[2].contextLength).toBe(4096);
    });

    it("extracts pricing as { prompt, completion }, each Number(...) or null", () => {
      const candidates = buildImportCandidates({
        models: [
          { id: "m1", pricing: { prompt: "0.01", completion: "0.02" } },
          { id: "m2", input_price: "0.001", output_price: "0.002" },
          { id: "m3", pricing: { prompt: null, completion: undefined } },
          { id: "m4", pricing: {} }, // both null
        ],
      });
      expect(candidates[0].pricing).toEqual({ prompt: 0.01, completion: 0.02 });
      expect(candidates[1].pricing).toEqual({ prompt: 0.001, completion: 0.002 });
      expect(candidates[2].pricing).toBeNull(); // both null
      expect(candidates[3].pricing).toBeNull(); // both null
    });

    it("returns null for pricing when both prompt and completion are null", () => {
      const candidates = buildImportCandidates({
        models: [
          { id: "m1" }, // no pricing
          { id: "m2", pricing: { prompt: "invalid" } }, // invalid number
        ],
      });
      expect(candidates[0].pricing).toBeNull();
      expect(candidates[1].pricing).toBeNull();
    });

    it("marks alreadyImported based on existingIds set", () => {
      const candidates = buildImportCandidates({
        models: [
          { id: "model-a" },
          { id: "model-b" },
          { id: "model-c" },
        ],
        existingIds: new Set(["model-b", "model-c"]),
      });
      expect(candidates[0].alreadyImported).toBe(false);
      expect(candidates[1].alreadyImported).toBe(true);
      expect(candidates[2].alreadyImported).toBe(true);
    });

    it("strips provider prefix from id before dedup/existing check", () => {
      const candidates = buildImportCandidates({
        models: [
          { id: "openai/gpt-4" },
          { id: "gpt-4" }, // duplicate after strip
        ],
        prefixes: ["openai"],
        existingIds: new Set(["gpt-4"]),
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].alreadyImported).toBe(true);
    });
  });

  describe("normalizeImportFilters", () => {
    it("returns default filters for undefined/null", () => {
      expect(normalizeImportFilters(null)).toEqual(DEFAULT_IMPORT_FILTERS);
      expect(normalizeImportFilters(undefined)).toEqual(DEFAULT_IMPORT_FILTERS);
    });

    it("trims string fields and caps at 500 chars", () => {
      const result = normalizeImportFilters({
        search: "  test  ",
        include: "x".repeat(600),
      });
      expect(result.search).toBe("test");
      expect(result.include).toBe("x".repeat(500));
    });

    it("converts non-strings to empty strings", () => {
      const result = normalizeImportFilters({
        search: 123,
        exclude: [],
      });
      expect(result.search).toBe("");
      expect(result.exclude).toBe("");
    });

    it("keeps only known values in tiers and kinds, deduplicates", () => {
      const result = normalizeImportFilters({
        tiers: ["free", "paid", "invalid", "free"],
        kinds: ["llm", "image", "invalid"],
      });
      expect(result.tiers).toEqual(["free", "paid"]);
      expect(result.kinds).toEqual(["llm", "image"]);
    });

    it("converts onlyNew to boolean, defaults to true for invalid", () => {
      expect(normalizeImportFilters({ onlyNew: true }).onlyNew).toBe(true);
      expect(normalizeImportFilters({ onlyNew: false }).onlyNew).toBe(false);
      expect(normalizeImportFilters({ onlyNew: 1 }).onlyNew).toBe(true); // invalid
      expect(normalizeImportFilters({ onlyNew: null }).onlyNew).toBe(true); // invalid
    });

    it("converts minContext to non-negative integer, invalid → 0", () => {
      expect(normalizeImportFilters({ minContext: 1024 }).minContext).toBe(1024);
      expect(normalizeImportFilters({ minContext: -100 }).minContext).toBe(0);
      expect(normalizeImportFilters({ minContext: "abc" }).minContext).toBe(0);
      expect(normalizeImportFilters({ minContext: 10.5 }).minContext).toBe(10); // floor
    });

    it("only returns keys from DEFAULT_IMPORT_FILTERS", () => {
      const result = normalizeImportFilters({
        search: "test",
        extraField: "ignored",
      });
      expect(Object.keys(result).sort()).toEqual(Object.keys(DEFAULT_IMPORT_FILTERS).sort());
    });
  });

  describe("matchesIdPattern", () => {
    it("splits on commas and newlines, trims tokens", () => {
      expect(matchesIdPattern("model-a", "model-a, other-model\nmodel-b")).toBe(true);
      expect(matchesIdPattern("other-model", "model-a, other-model\nmodel-b")).toBe(true);
    });

    it("drops empty tokens", () => {
      expect(matchesIdPattern("model-a", "model-a, , \nmodel-b")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(matchesIdPattern("Model-A", "model-a")).toBe(true);
      expect(matchesIdPattern("GPT-4", "gpt-4")).toBe(true);
    });

    it("supports glob matching where * matches any run of chars", () => {
      expect(matchesIdPattern("gpt-4-turbo", "gpt-*-turbo")).toBe(true);
      expect(matchesIdPattern("gpt-4-turbo", "gpt-*")).toBe(true);
      expect(matchesIdPattern("gpt-4-turbo", "*-turbo")).toBe(true);
      expect(matchesIdPattern("gpt-4-turbo", "*")).toBe(true);
    });

    it("matches whole id only, not substring", () => {
      expect(matchesIdPattern("gpt-4", "gpt")).toBe(false); // substring doesn't match
      expect(matchesIdPattern("gpt-4", "gpt-4")).toBe(true); // exact match
    });

    it("escapes regex metachars so gpt-4.1 doesn't match gpt-4x1", () => {
      expect(matchesIdPattern("gpt-4.1", "gpt-4.1")).toBe(true);
      expect(matchesIdPattern("gpt-4x1", "gpt-4.1")).toBe(false);
      expect(matchesIdPattern("gpt-4x1", "gpt-4?1")).toBe(false); // ? literal, not regex
    });

    it("returns false when there are no tokens", () => {
      expect(matchesIdPattern("model-a", "")).toBe(false);
      expect(matchesIdPattern("model-a", "  , , \n")).toBe(false);
    });

    it("returns true if any token matches", () => {
      expect(matchesIdPattern("model-b", "model-a, model-b, model-c")).toBe(true);
    });
  });

  describe("applyImportFilters", () => {
    const sampleCandidates = [
      {
        id: "gpt-4",
        name: "GPT-4",
        kind: "llm",
        tier: "paid",
        contextLength: 8192,
        pricing: { prompt: 0.03, completion: 0.06 },
        alreadyImported: false,
      },
      {
        id: "gpt-3.5-turbo",
        name: "GPT-3.5 Turbo",
        kind: "llm",
        tier: "paid",
        contextLength: 4096,
        pricing: { prompt: 0.0005, completion: 0.0015 },
        alreadyImported: true,
      },
      {
        id: "free-model",
        name: "Free Model",
        kind: "llm",
        tier: "free",
        contextLength: null,
        pricing: null,
        alreadyImported: false,
      },
      {
        id: "dall-e-3",
        name: "DALL-E 3",
        kind: "image",
        tier: "paid",
        contextLength: null,
        pricing: { prompt: 0.02, completion: null },
        alreadyImported: false,
      },
    ];

    it("normalizes filters first", () => {
      const result = applyImportFilters(sampleCandidates, {
        search: "  free  ",
        tiers: ["free"],
        onlyNew: false,
      });
      // should apply normalized filters
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].id).toBe("free-model");
    });

    it("filters by search (case-insensitive substring of id or name)", () => {
      const result = applyImportFilters(sampleCandidates, { search: "gpt", onlyNew: false });
      expect(result).toContainEqual(expect.objectContaining({ id: "gpt-4" }));
      expect(result).toContainEqual(expect.objectContaining({ id: "gpt-3.5-turbo" }));
      expect(result).not.toContainEqual(expect.objectContaining({ id: "dall-e-3" }));
    });

    it("filters by tiers (empty = no restriction)", () => {
      const result = applyImportFilters(sampleCandidates, { tiers: ["free"], onlyNew: false });
      expect(result).toEqual([expect.objectContaining({ tier: "free" })]);

      const resultNoFilter = applyImportFilters(sampleCandidates, { tiers: [], onlyNew: false });
      expect(resultNoFilter.length).toBe(sampleCandidates.length);
    });

    it("filters by kinds (empty = no restriction)", () => {
      const result = applyImportFilters(sampleCandidates, { kinds: ["image"], onlyNew: false });
      expect(result).toEqual([expect.objectContaining({ kind: "image" })]);

      const resultNoFilter = applyImportFilters(sampleCandidates, { kinds: [], onlyNew: false });
      expect(resultNoFilter.length).toBe(sampleCandidates.length);
    });

    it("drops alreadyImported when onlyNew is true", () => {
      const result = applyImportFilters(sampleCandidates, { onlyNew: true });
      expect(result).not.toContainEqual(expect.objectContaining({ alreadyImported: true }));
    });

    it("keeps alreadyImported when onlyNew is false", () => {
      const result = applyImportFilters(sampleCandidates, { onlyNew: false });
      expect(result).toContainEqual(expect.objectContaining({ alreadyImported: true }));
    });

    it("filters by minContext (requires contextLength !== null && contextLength >= minContext)", () => {
      const result = applyImportFilters(sampleCandidates, { minContext: 8000, onlyNew: false });
      expect(result).toEqual([expect.objectContaining({ id: "gpt-4" })]);

      const resultZero = applyImportFilters(sampleCandidates, { minContext: 0, onlyNew: false });
      expect(resultZero.length).toBe(sampleCandidates.length);
    });

    it("requires include pattern match when non-empty", () => {
      const result = applyImportFilters(sampleCandidates, { include: "gpt-*", onlyNew: false });
      expect(result).toContainEqual(expect.objectContaining({ id: "gpt-4" }));
      expect(result).toContainEqual(expect.objectContaining({ id: "gpt-3.5-turbo" }));
      expect(result).not.toContainEqual(expect.objectContaining({ id: "free-model" }));
    });

    it("drops exclude pattern matches", () => {
      const result = applyImportFilters(sampleCandidates, { exclude: "*-turbo", onlyNew: false });
      expect(result).toContainEqual(expect.objectContaining({ id: "gpt-4" }));
      expect(result).not.toContainEqual(expect.objectContaining({ id: "gpt-3.5-turbo" }));
    });

    it("returns empty array when candidates is not an array", () => {
      expect(applyImportFilters(null, {})).toEqual([]);
      expect(applyImportFilters(undefined, {})).toEqual([]);
    });

    it("combines multiple filters (AND logic)", () => {
      const result = applyImportFilters(sampleCandidates, {
        kinds: ["llm"],
        tiers: ["paid"],
        search: "gpt",
        onlyNew: true,
      });
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("gpt-4");
    });
  });
});

describe("formatContextLength", () => {
  it("returns null for missing/non-positive values", () => {
    expect(formatContextLength(null)).toBe(null);
    expect(formatContextLength(undefined)).toBe(null);
    expect(formatContextLength(0)).toBe(null);
    expect(formatContextLength(-5)).toBe(null);
  });

  it("formats thousands as k, rounding to the nearest whole k", () => {
    expect(formatContextLength(32000)).toBe("32k");
    expect(formatContextLength(128000)).toBe("128k");
    expect(formatContextLength(200000)).toBe("200k");
    expect(formatContextLength(8192)).toBe("8k");
  });

  it("formats millions as M, keeping one decimal only when needed", () => {
    expect(formatContextLength(1000000)).toBe("1M");
    expect(formatContextLength(2000000)).toBe("2M");
    expect(formatContextLength(1500000)).toBe("1.5M");
  });

  it("leaves sub-1k values as a plain number", () => {
    expect(formatContextLength(512)).toBe("512");
  });
});

describe("formatPricePerMillion", () => {
  it("returns null when the value is null/undefined/not finite", () => {
    expect(formatPricePerMillion(null)).toBe(null);
    expect(formatPricePerMillion(undefined)).toBe(null);
    expect(formatPricePerMillion(NaN)).toBe(null);
  });

  it("scales a per-token price to per-1M and trims trailing zeros", () => {
    expect(formatPricePerMillion(0.000003)).toBe("3");
    expect(formatPricePerMillion(0.0000005)).toBe("0.5");
    expect(formatPricePerMillion(0)).toBe("0");
  });

  it("keeps at most two decimals", () => {
    expect(formatPricePerMillion(0.0000015)).toBe("1.5");
    expect(formatPricePerMillion(0.00000012345)).toBe("0.12");
  });
});

describe("MIN_CONTEXT_OPTIONS", () => {
  it("exposes the Any/32k/128k/200k/1M picker options in order", () => {
    expect(MIN_CONTEXT_OPTIONS.map((o) => o.value)).toEqual([0, 32000, 128000, 200000, 1000000]);
  });
});
