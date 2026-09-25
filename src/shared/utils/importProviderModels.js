import { classifyTier } from "@/shared/utils/modelTier.js";

// Providers whose provider page shows the LIVE /models list (not the static
// suggested-models catalog) as their built-in model list once one is
// available. listImportCandidates() must fold that same live list into
// existingIds for these providers, or every live model shows as "new" in the
// import picker and re-importing duplicates it.
export const LIVE_CATALOG_PROVIDERS = new Set(["cursor", "zed"]);

export const IMPORT_KINDS = ["llm", "image", "embedding", "tts", "stt"];
export const IMPORT_TIERS = ["free", "paid", "credits", "unknown"];
export const DEFAULT_IMPORT_FILTERS = {
  search: "",
  tiers: [],
  kinds: [],
  onlyNew: true,
  minContext: 0,
  include: "",
  exclude: "",
};

export function stripProviderPrefix(modelId, prefixes = []) {
  const id = String(modelId || "").trim();
  if (!id) return "";
  for (const prefix of prefixes) {
    if (!prefix) continue;
    const needle = `${prefix}/`;
    if (id.startsWith(needle)) return id.slice(needle.length);
  }
  return id;
}

export function buildImportCandidates({
  models = [],
  existingIds = new Set(),
  prefixes = [],
  providerId = null,
} = {}) {
  const out = [];
  const seen = new Set();

  for (const model of models) {
    const rawId = model?.id || model?.name || model?.model;
    const id = stripProviderPrefix(rawId, prefixes);

    if (!id || seen.has(id)) continue;
    seen.add(id);

    const name = model?.name || id;
    const kind = IMPORT_KINDS.includes(model?.kind) ? model?.kind : "llm";

    // Determine tier
    let tier = model?.tier;
    if (!IMPORT_TIERS.includes(tier)) {
      tier = classifyTier({ ...model, id }, { providerId }).tier;
    }

    // Extract context length (first finite positive from contextLength, context_length,
    // context_window) — accepts a numeric string ("128000") too, since some catalogs
    // serialize it that way; anything else (bool, object, NaN, non-positive) is skipped.
    let contextLength = null;
    for (const field of [model?.contextLength, model?.context_length, model?.context_window]) {
      if (typeof field !== "number" && typeof field !== "string") continue;
      const num = Number(field);
      if (Number.isFinite(num) && num > 0) {
        contextLength = num;
        break;
      }
    }

    // Extract pricing
    let pricing = null;
    const promptRaw = model?.pricing?.prompt ?? model?.input_price;
    const completionRaw = model?.pricing?.completion ?? model?.output_price;
    const prompt = promptRaw !== undefined ? Number(promptRaw) : null;
    const completion = completionRaw !== undefined ? Number(completionRaw) : null;

    if (prompt !== null || completion !== null) {
      pricing = {
        prompt: Number.isFinite(prompt) ? prompt : null,
        completion: Number.isFinite(completion) ? completion : null,
      };
      // If both are null, set pricing to null
      if (pricing.prompt === null && pricing.completion === null) {
        pricing = null;
      }
    }

    const alreadyImported = existingIds.has(id);

    out.push({
      id,
      name,
      kind,
      tier,
      contextLength,
      pricing,
      alreadyImported,
    });
  }

  return out;
}

export function normalizeImportFilters(raw) {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_IMPORT_FILTERS };
  }

  const filters = { ...DEFAULT_IMPORT_FILTERS };

  // Normalize string fields: trim and cap at 500 chars
  for (const key of ["search", "include", "exclude"]) {
    let val = raw[key];
    if (typeof val !== "string") {
      val = "";
    } else {
      val = val.trim().slice(0, 500);
    }
    filters[key] = val;
  }

  // Normalize tiers: keep only known values, dedup
  if (Array.isArray(raw.tiers)) {
    filters.tiers = [...new Set(raw.tiers.filter((t) => IMPORT_TIERS.includes(t)))];
  }

  // Normalize kinds: keep only known values, dedup
  if (Array.isArray(raw.kinds)) {
    filters.kinds = [...new Set(raw.kinds.filter((k) => IMPORT_KINDS.includes(k)))];
  }

  // Normalize onlyNew: must be boolean, default true
  if (typeof raw.onlyNew === "boolean") {
    filters.onlyNew = raw.onlyNew;
  } else {
    filters.onlyNew = true;
  }

  // Normalize minContext: non-negative integer, invalid → 0
  if (typeof raw.minContext === "number" && Number.isFinite(raw.minContext)) {
    filters.minContext = Math.max(0, Math.floor(raw.minContext));
  } else {
    filters.minContext = 0;
  }

  return filters;
}

export function matchesIdPattern(id, patternText) {
  const idLower = String(id || "").toLowerCase();

  // Split on commas and newlines, trim, drop empties
  const tokens = String(patternText || "")
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return false;

  // Check if any token matches the id
  for (const token of tokens) {
    const patternLower = token.toLowerCase();

    // Escape regex metacharacters except *
    const escaped = patternLower
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");

    const regex = new RegExp(`^${escaped}$`);
    if (regex.test(idLower)) {
      return true;
    }
  }

  return false;
}

export function applyImportFilters(candidates = [], filters = {}) {
  if (!Array.isArray(candidates)) {
    return [];
  }

  const normalizedFilters = normalizeImportFilters(filters);

  let result = candidates;

  // Filter by search (case-insensitive substring of id or name)
  if (normalizedFilters.search) {
    const search = normalizedFilters.search.toLowerCase();
    result = result.filter(
      (c) => c.id.toLowerCase().includes(search) || c.name.toLowerCase().includes(search),
    );
  }

  // Filter by tiers
  if (normalizedFilters.tiers.length > 0) {
    result = result.filter((c) => normalizedFilters.tiers.includes(c.tier));
  }

  // Filter by kinds
  if (normalizedFilters.kinds.length > 0) {
    result = result.filter((c) => normalizedFilters.kinds.includes(c.kind));
  }

  // Filter by onlyNew
  if (normalizedFilters.onlyNew) {
    result = result.filter((c) => !c.alreadyImported);
  }

  // Filter by minContext
  if (normalizedFilters.minContext > 0) {
    result = result.filter(
      (c) => c.contextLength !== null && c.contextLength >= normalizedFilters.minContext,
    );
  }

  // Filter by include pattern
  if (normalizedFilters.include) {
    result = result.filter((c) => matchesIdPattern(c.id, normalizedFilters.include));
  }

  // Filter by exclude pattern
  if (normalizedFilters.exclude) {
    result = result.filter((c) => !matchesIdPattern(c.id, normalizedFilters.exclude));
  }

  return result;
}

// Minimum-context select options for the import picker's filter bar
// ("Any" / 32k / 128k / 200k / 1M), in display order.
export const MIN_CONTEXT_OPTIONS = [
  { value: 0, label: "Any" },
  { value: 32000, label: "32k" },
  { value: 128000, label: "128k" },
  { value: 200000, label: "200k" },
  { value: 1000000, label: "1M" },
];

// Display formatter for a context length: "128k" / "1M" / "1.5M" style,
// rounded (never more than one decimal). Returns null for missing/invalid
// values so callers can hide the field entirely.
export function formatContextLength(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;

  if (num >= 1_000_000) {
    const millions = Math.round((num / 1_000_000) * 10) / 10;
    const str = millions % 1 === 0 ? String(millions) : millions.toFixed(1);
    return `${str}M`;
  }
  if (num >= 1000) {
    return `${Math.round(num / 1000)}k`;
  }
  return String(Math.round(num));
}

// Display formatter for a per-token price as "per 1M tokens": scales by 1e6
// and keeps up to 2 decimals with trailing zeros trimmed. Returns null for
// missing/non-finite values so callers can hide the price entirely (the
// route already nulls out pricing when both prompt/completion are absent).
export function formatPricePerMillion(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num * 1_000_000 * 100) / 100;
  return String(rounded);
}

export function connectionCanSyncCatalog({
  modelsFetcher = null,
  baseUrl = null,
} = {}) {
  if (typeof modelsFetcher?.url === "string" && modelsFetcher.url.trim()) return true;
  return typeof baseUrl === "string" && baseUrl.trim().length > 0;
}

