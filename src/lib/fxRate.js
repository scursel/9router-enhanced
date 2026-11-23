import { makeKv } from "@/lib/db/helpers/kvStore.js";

const FX_KV_KEY = "USD_BRL";
const FX_TTL_MS = 6 * 60 * 60 * 1000;
const FX_TIMEOUT_MS = 5000;
const FX_MAX_BODY_BYTES = 65536;

const fxKv = makeKv("fx");

if (!globalThis.__9rFxUsdBrlCache) {
  globalThis.__9rFxUsdBrlCache = { entry: null, inflight: null };
}

const FX_SOURCES = [
  {
    name: "frankfurter",
    url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL",
    parse: (data) => Number(data?.rates?.BRL),
  },
  {
    name: "awesomeapi",
    url: "https://economia.awesomeapi.com.br/json/last/USD-BRL",
    parse: (data) => Number(data?.USDBRL?.bid),
  },
];

function isValidRate(rate) {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate < 100;
}

function isFreshEntry(entry, now = Date.now()) {
  if (!entry || !isValidRate(entry.rate)) return false;
  const ts = Date.parse(entry.fetchedAt);
  return Number.isFinite(ts) && now - ts < FX_TTL_MS;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rate = Number(raw.rate);
  if (!isValidRate(rate)) return null;
  const fetchedAt = typeof raw.fetchedAt === "string" && Number.isFinite(Date.parse(raw.fetchedAt))
    ? raw.fetchedAt
    : null;
  if (!fetchedAt) return null;
  return {
    rate,
    fetchedAt,
    source: typeof raw.source === "string" && raw.source ? raw.source : "cache",
  };
}

async function readCachedEntry() {
  const mem = normalizeEntry(globalThis.__9rFxUsdBrlCache.entry);
  if (mem) return mem;
  try {
    const stored = normalizeEntry(await fxKv.get(FX_KV_KEY, null));
    if (stored) {
      globalThis.__9rFxUsdBrlCache.entry = stored;
      return stored;
    }
  } catch {
    // Fail-open if DB is not ready
  }
  return null;
}

async function fetchFromSource(source) {
  const response = await fetch(source.url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FX_TIMEOUT_MS),
  });
  if (!response.ok) return null;

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > FX_MAX_BODY_BYTES) {
    throw new Error(`FX response exceeded ${FX_MAX_BODY_BYTES} bytes`);
  }
  const parsed = JSON.parse(text);
  const rate = source.parse(parsed);
  if (!isValidRate(rate)) return null;

  return {
    rate,
    fetchedAt: new Date().toISOString(),
    source: source.name,
  };
}

/**
 * Synchronous memory-cache lookup for USD -> BRL rate. Zero I/O.
 */
export function getCachedUsdToBrlRate() {
  const entry = normalizeEntry(globalThis.__9rFxUsdBrlCache.entry);
  return entry ? entry.rate : null;
}

/**
 * Load cached USD -> BRL rate from memory or SQLite kv without making network requests.
 */
export async function loadCachedUsdToBrlRate() {
  const entry = await readCachedEntry();
  return entry ? entry.rate : null;
}

/**
 * Fetch USD -> BRL exchange rate from hardcoded HTTPS endpoints with 6h cache
 * and fail-open fallback to the last persisted rate.
 */
export async function fetchUsdToBrlRate({ force = false } = {}) {
  const cached = await readCachedEntry();
  if (!force && isFreshEntry(cached)) {
    return { ...cached, stale: false };
  }

  if (globalThis.__9rFxUsdBrlCache.inflight) {
    return await globalThis.__9rFxUsdBrlCache.inflight;
  }

  const run = (async () => {
    for (const source of FX_SOURCES) {
      try {
        const fresh = await fetchFromSource(source);
        if (fresh) {
          globalThis.__9rFxUsdBrlCache.entry = fresh;
          try {
            await fxKv.set(FX_KV_KEY, fresh);
          } catch {
            // Non-fatal if persistence fails
          }
          return { ...fresh, stale: false };
        }
      } catch {
        // Try fallback source
      }
    }
    return cached ? { ...cached, stale: true } : null;
  })();

  globalThis.__9rFxUsdBrlCache.inflight = run;
  try {
    return await run;
  } finally {
    if (globalThis.__9rFxUsdBrlCache.inflight === run) {
      globalThis.__9rFxUsdBrlCache.inflight = null;
    }
  }
}

export function resetFxRateCacheForTests() {
  globalThis.__9rFxUsdBrlCache = { entry: null, inflight: null };
}
