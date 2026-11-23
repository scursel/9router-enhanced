import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

function pricingFromCatalogCost(cost) {
  if (!cost || typeof cost !== "object") return null;
  const input = cost.input == null ? null : Number(cost.input);
  const output = cost.output == null ? null : Number(cost.output);
  const hasInput = Number.isFinite(input);
  const hasOutput = Number.isFinite(output);
  if (!hasInput && !hasOutput) return null;
  const inRate = hasInput ? input : 0;
  const outRate = hasOutput ? output : 0;
  return {
    input: inRate,
    output: outRate,
    // Catalog only ships input/output; reuse input for cache hits/writes and
    // output for reasoning so calculateCostFromTokens stays well-defined.
    cached: inRate,
    reasoning: outRate,
    cache_creation: inRate,
  };
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();
  const { getPricingForModel: resolveConst } = await import("open-sse/providers/pricing.js");
  const resolved = resolveConst(provider, model);

  // Merge user overrides over built-in defaults so a flat-rate override (e.g. from
  // PricingModal) does not silently strip `long_context` unless explicitly replaced.
  const userOverride = provider ? userPricing[provider]?.[model] : null;
  if (userOverride) {
    return resolved ? { ...resolved, ...userOverride } : userOverride;
  }
  if (resolved) return resolved;

  // Static tables miss → models.dev / OpenRouter catalog (provider first, then
  // universal OpenRouter fallback inside getCatalogCost).
  try {
    const { getCatalogCost } = await import("open-sse/providers/catalogOverride.js");
    return pricingFromCatalogCost(getCatalogCost(provider, model));
  } catch {
    return null;
  }
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
