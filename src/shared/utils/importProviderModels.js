import { classifyTier } from "@/shared/utils/modelTier.js";

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

    // Extract context length (first finite positive from contextLength, context_length, context_window)
    let contextLength = null;
    for (const field of [model?.contextLength, model?.context_length, model?.context_window]) {
      if (typeof field === "number" && Number.isFinite(field) && field > 0) {
        contextLength = field;
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

export function collectImportableModels({
  models = [],
  existingIds = new Set(),
  prefixes = [],
  freeOnly = false,
  providerId = null,
} = {}) {
  const out = [];
  const seen = new Set(existingIds);
  for (const model of models) {
    const rawId = model?.id || model?.name || model?.model;
    const id = stripProviderPrefix(rawId, prefixes);
    if (!id || seen.has(id)) continue;
    if (freeOnly) {
      const tier = model?.tier || classifyTier({ ...model, id }, { providerId }).tier;
      if (tier !== "free") continue;
    }
    seen.add(id);
    const kind = ["image", "embedding", "tts", "stt"].includes(model?.kind) ? model.kind : "llm";
    out.push({ id, kind, name: model?.name || id });
  }
  return out;
}

export function connectionCanSyncCatalog({
  modelsFetcher = null,
  baseUrl = null,
} = {}) {
  if (typeof modelsFetcher?.url === "string" && modelsFetcher.url.trim()) return true;
  return typeof baseUrl === "string" && baseUrl.trim().length > 0;
}

export function providerCanImportModels({
  modelsFetcher = null,
  hasActiveConnection = false,
  isCompatible = false,
  baseUrl = null,
} = {}) {
  if (typeof modelsFetcher?.url === "string" && modelsFetcher.url.trim()) return true;
  if (!hasActiveConnection) return false;
  if (isCompatible) return true;
  return connectionCanSyncCatalog({ modelsFetcher, baseUrl });
}
