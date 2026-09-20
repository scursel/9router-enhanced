import { getAdapter } from "@/lib/db/driver.js";
import { num, localQuota } from "./quotaShared.js";

const WEEK_MS = 7 * 86400 * 1000;

/** Credits per dollar: the plan sells credits at $0.002 each. */
export const ALIBABA_USD_PER_CREDIT = 0.002;

/**
 * Plan basket rates — USD per 1M tokens.
 *
 * CACHE READS ARE FREE on this plan. Charging them was measured wrong on
 * 2026-09-20 against the vendor console: at 20:53Z the console read
 * "7 Days Usage Limit … Remaining 39.7%" (1,507.5 of 2,500 credits used) while
 * this meter — charging cache reads at the qwen3.8 list rate — already showed
 * 10.8% remaining. One day of a 94.4% cache-hit workload cannot consume a whole
 * 7-day plan, so the cache-read term was the bug. Same rows, cache reads at
 * zero: 1,138.7 credits at that instant.
 *
 * These coefficients are a MODEL-NORMALIZED basket, NOT per-model list prices.
 * The plan states credits are "dynamically determined by model type, token
 * usage, thinking mode and tool calls", and the same reading proves it: pricing
 * those rows with their own list prices (deepseek-v4.1-flash at $0.14/$0.28 per
 * 1M, its share of the traffic) lands near 635 credits — less than half the
 * vendor's 1,507.5. List prices are the wrong ruler here; the normalized basket
 * is the closest single-coefficient fit to the console.
 */
export const ALIBABA_TOKEN_PLAN_RATES = {
  uncachedInput: 2,
  output: 6,
  cacheRead: 0,
};

/**
 * Per-model overrides of the basket rates above, keyed by lowercase model id.
 *
 * Intentionally EMPTY: the vendor does not publish its credit coefficients, and
 * one console reading identifies exactly one unknown, so no per-model
 * coefficient can be derived from it. Every model therefore uses the calibrated
 * basket. Add an entry ONLY from a console measurement of that model in
 * isolation — a guessed coefficient makes the meter look precise while being
 * wrong, which is how the cache-read error survived this long.
 */
export const ALIBABA_TOKEN_PLAN_MODEL_RATES = {};

export function getAlibabaModelRates(model, overrides = ALIBABA_TOKEN_PLAN_MODEL_RATES) {
  const key = String(model || "").trim().toLowerCase();
  const override = key ? overrides?.[key] : null;
  return override ? { ...ALIBABA_TOKEN_PLAN_RATES, ...override } : ALIBABA_TOKEN_PLAN_RATES;
}

/** Timestamp of a usageHistory row, in ms, or NaN when unusable. */
function recordTime(record) {
  if (typeof record?.timestamp === "number") return record.timestamp;
  if (record?.timestamp) return new Date(record.timestamp).getTime();
  return NaN;
}

export function getAlibabaPlanLimits(limits = {}) {
  // Token Plan no longer ships a 5-hour window — quota is weekly only
  // (measured in credits). Lite = 2500 credits / 7d.
  const plans = {
    lite: { name: "Lite", limit7d: 2500 },
    standard: { name: "Standard", limit7d: 10000 },
    pro: { name: "Pro", limit7d: 40000 },
  };
  const key = String(limits.plan || limits.tier || limits.tokenPlan || "lite")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return plans[key] || plans.lite;
}

export function estimateAlibabaCredits(record, rates = ALIBABA_TOKEN_PLAN_RATES) {
  let prompt = num(record?.promptTokens, 0);
  let completion = num(record?.completionTokens, 0);
  let cached = 0;
  let raw = record?.tokens;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (raw && typeof raw === "object") {
    prompt = num(raw.prompt_tokens ?? raw.promptTokens, prompt);
    completion = num(raw.completion_tokens ?? raw.completionTokens, completion);
    cached = num(raw.cached_tokens ?? raw.cachedTokens, 0);
  }
  const uncached = Math.max(0, prompt - cached);
  const basket = {
    uncachedInput: num(rates?.uncachedInput, ALIBABA_TOKEN_PLAN_RATES.uncachedInput),
    output: num(rates?.output, ALIBABA_TOKEN_PLAN_RATES.output),
    cacheRead: num(rates?.cacheRead, ALIBABA_TOKEN_PLAN_RATES.cacheRead),
  };
  const usd =
    (uncached * basket.uncachedInput +
      completion * basket.output +
      cached * basket.cacheRead) /
    1e6;
  return usd / ALIBABA_USD_PER_CREDIT;
}

/**
 * The plan's 7-day counter resets on a FIXED weekly cadence — it is not a
 * window anchored on the first request the router happens to see. On 2026-09-20
 * the console read "Reset time 2026-09-26 15:05:00" while the local rows only
 * began at 19:03Z that same day, so anchoring locally both moved the reset
 * ~1.3 days late and let a previous bucket's traffic count in the new one.
 *
 * One observed instant projects every later bucket (reset + k·7d), which keeps
 * the window correct week after week without the vendor exposing a quota API.
 */
export function resolveAlibabaWeeklyBucket(resetHint, now = Date.now()) {
  // `new Date(null).getTime()` is 0, not NaN — a missing hint must return null
  // (fall back to the anchored window), never an epoch-gridded bucket.
  if (resetHint == null || resetHint === "" || typeof resetHint === "boolean") return null;
  const hinted = typeof resetHint === "number" ? resetHint : new Date(resetHint).getTime();
  if (!Number.isFinite(hinted) || hinted <= 0 || !Number.isFinite(now)) return null;
  let end = hinted;
  if (end <= now) end += (Math.floor((now - end) / WEEK_MS) + 1) * WEEK_MS;
  // A hint far in the future (typo, or a reset read from a different plan)
  // must still yield the bucket that CONTAINS now — never an empty future one,
  // which would silently meter zero usage.
  while (end - WEEK_MS > now) end -= WEEK_MS;
  return { start: end - WEEK_MS, end };
}

/** Reset hint accepted from the connection's providerSpecificData. */
function resetHintOf(limits) {
  return limits?.alitpResetAt ?? limits?.quotaResetAt ?? limits?.resetAtHint ?? null;
}

/** Credits/tokens recorded inside a known weekly bucket. */
export function alibabaBucketMeta(records, bucket, useCredits, now = Date.now()) {
  let used = 0;
  if (Array.isArray(records) && bucket) {
    for (const record of records) {
      const t = recordTime(record);
      if (!Number.isFinite(t) || t < bucket.start || t >= bucket.end || t > now) continue;
      used += useCredits
        ? estimateAlibabaCredits(record, getAlibabaModelRates(record?.model))
        : num(record?.promptTokens, 0) + num(record?.completionTokens, 0);
    }
  }
  return { used, start: bucket?.start ?? null, end: bucket?.end ?? null };
}

export function alibabaWindowMeta(records, windowMs, now, useCredits) {
  const items = [];
  if (Array.isArray(records)) {
    for (const r of records) {
      const t = recordTime(r);
      if (!Number.isFinite(t) || t > now) continue;
      const amount = useCredits
        ? estimateAlibabaCredits(r, getAlibabaModelRates(r?.model))
        : num(r?.promptTokens, 0) + num(r?.completionTokens, 0);
      items.push({ t, amount });
    }
  }
  items.sort((a, b) => a.t - b.t);
  let start = null;
  let end = null;
  for (const item of items) {
    if (start === null || item.t >= end) {
      start = item.t;
      end = item.t + windowMs;
    }
  }
  if (start === null || now >= end) return { used: 0, start: null, end: null };
  let used = 0;
  for (const item of items) {
    if (item.t >= start && item.t < end) used += item.amount;
  }
  return { used, start, end };
}

export function alibabaWindowUsage(records, windowMs, now, useCredits) {
  return alibabaWindowMeta(records, windowMs, now, useCredits).used;
}

export function alibabaUntracked7d(limits, windowStart) {
  const extra = num(limits?.untrackedCredits7d ?? limits?.quotaUsed7dOffset, 0);
  if (extra <= 0) return 0;
  const raw = limits?.untrackedCredits7dWindowStart ?? limits?.quotaUsed7dWindowStart;
  if (raw == null || raw === "") return extra;
  const hintedStart = typeof raw === "number" ? raw : new Date(raw).getTime();
  if (!Number.isFinite(hintedStart) || !Number.isFinite(windowStart)) return 0;
  return Math.abs(hintedStart - windowStart) < 2000 ? extra : 0;
}

export function calcSlidingWindowUsage(records, now = Date.now(), limits = {}) {
  const cutoff7d = now - WEEK_MS;
  const useCredits = String(limits?.unit || "").toLowerCase() === "credits";
  const plan = getAlibabaPlanLimits(limits);
  // A known vendor reset instant makes the weekly bucket exact; without one the
  // meter falls back to the older anchored window (first record seen starts it).
  const bucket = resolveAlibabaWeeklyBucket(resetHintOf(limits), now);

  let sevenDayUsed = 0;
  let sevenDayEnd = null;
  if (useCredits) {
    const meta = bucket
      ? alibabaBucketMeta(records, bucket, true, now)
      : alibabaWindowMeta(records, WEEK_MS, now, true);
    sevenDayUsed = meta.used + alibabaUntracked7d(limits, meta.start);
    sevenDayEnd = meta.end;
  } else if (bucket) {
    const meta = alibabaBucketMeta(records, bucket, false, now);
    sevenDayUsed = meta.used;
    sevenDayEnd = meta.end;
  } else if (Array.isArray(records)) {
    for (const r of records) {
      const t = recordTime(r);
      if (!Number.isFinite(t) || t < cutoff7d || t > now) continue;
      sevenDayUsed += num(r?.promptTokens, 0) + num(r?.completionTokens, 0);
    }
  }

  const limit7d = num(
    limits?.limit7d || limits?.quotaLimit7d || limits?.sevenDayLimit,
    useCredits ? plan.limit7d : 0,
  );
  const name7d = useCredits ? "Créditos 7d (estimado)" : "Consumo 7d (medido local)";
  const quota7d = localQuota(sevenDayUsed, limit7d);
  if (sevenDayEnd) quota7d.resetAt = new Date(sevenDayEnd).toISOString();
  const quotas = {
    [name7d]: quota7d,
  };

  return {
    plan: useCredits
      ? `Alibaba Token Plan ${plan.name} (créditos estimados)`
      : "Alibaba Token Plan (medido pelo router)",
    status: "ok",
    source: "router-local",
    fetchedAt: new Date(now).toISOString(),
    quotas,
  };
}

// The plan's credit coefficients are not published (the console says credits
// "are dynamically determined by model type, token usage, thinking mode and
// tool calls"), so the local estimate can land far below the real drawdown —
// e.g. a plan the vendor already paused read 22% used here. A fresh vendor 429
// is therefore authoritative: it proves the 7-day window is exhausted and
// carries the reset instant.
const QUOTA_EXHAUSTED_RE = /token-plan[^"]*quota has been exhausted/i;
const QUOTA_RESET_RE = /reset at (\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC/i;

export function parseAlibabaResetAt(message, now = Date.now()) {
  const m = QUOTA_RESET_RE.exec(String(message || ""));
  if (!m) return null;
  const [, mm, dd, hh, mi, ss] = m;
  const year = new Date(now).getUTCFullYear();
  const build = (y) => Date.UTC(y, Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
  // The vendor prints no year: a reset that is already behind us belongs to the
  // next one.
  return new Date(build(year) > now - 86400000 ? build(year) : build(year + 1)).toISOString();
}

export function alibabaQuotaExhaustion(lastError, lastErrorAt, now = Date.now()) {
  const message = String(lastError || "");
  if (!QUOTA_EXHAUSTED_RE.test(message)) return null;
  const at =
    typeof lastErrorAt === "number"
      ? lastErrorAt
      : lastErrorAt
        ? new Date(lastErrorAt).getTime()
        : NaN;
  if (!Number.isFinite(at) || at > now) return null;
  if (now - at > WEEK_MS) return null;
  return { at, resetAt: parseAlibabaResetAt(message, now) };
}

export function applyAlibabaQuotaExhaustion(result, ctx = {}, records = [], now = Date.now()) {
  const signal = alibabaQuotaExhaustion(ctx?.lastError, ctx?.lastErrorAt, now);
  if (!signal) return result;
  // A call that succeeded after the 429 means the account was restored (plan
  // upgrade, Extra Bundle, vendor quota reset) — stop reporting it exhausted.
  if (
    Array.isArray(records) &&
    records.some((r) => {
      const t = recordTime(r);
      return (
        Number.isFinite(t) &&
        t > signal.at &&
        num(r?.promptTokens, 0) + num(r?.completionTokens, 0) > 0
      );
    })
  ) {
    return result;
  }
  const quota = result?.quotas?.[Object.keys(result.quotas)[0]];
  if (!quota || !(quota.total > 0)) return result;
  quota.used = quota.total;
  quota.remainingPercentage = 0;
  if (signal.resetAt) quota.resetAt = signal.resetAt;
  return result;
}

function parseConnectionData(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function getAlibabaTokenPlanUsage(ctx = {}, now = Date.now()) {
  let connId = String(ctx?.connectionId || ctx?.id || "").trim();
  const psd = ctx?.providerSpecificData || {};
  const cutoff7dIso = new Date(now - WEEK_MS).toISOString();

  let rows = [];
  let connData = null;
  try {
    const db = await getAdapter();
    if (db && typeof db.get === "function") {
      // The dispatcher hands handlers a narrowed ctx, so read the vendor error
      // (lastError/lastErrorAt) straight from the connection row.
      const connRow = connId
        ? db.get("SELECT data FROM providerConnections WHERE id = ?", [connId])
        : ctx?.apiKey
          ? db.get(
              "SELECT id, data FROM providerConnections WHERE provider IN ('alitp-intl', 'qwen-cloud-token-plan') AND json_extract(data, '$.apiKey') = ?",
              [String(ctx.apiKey)]
            )
          : null;
      connId = String(connRow?.id || connId).trim();
      connData = parseConnectionData(connRow?.data);
    }
    if (db && typeof db.all === "function" && connId) {
      rows = db.all(
        // Combo attempt-failure rows (D13) live in usageHistory too: zero
        // tokens, but their timestamp could ANCHOR the 7d window start. Same
        // NULL-safe twin of usageRepo's isFailureUsageStatus gate (open-sse
        // must not import src/lib — duplicated clause by boundary, as in
        // src/lib/comboStats/aggregate.js).
        "SELECT promptTokens, completionTokens, tokens, timestamp, model FROM usageHistory WHERE connectionId = ? AND timestamp >= ? AND (status IS NULL OR status NOT LIKE 'error%')",
        [connId, cutoff7dIso]
      );
    }
  } catch (err) {
    console.warn("[LocalQuotaMeter] DB query error:", err);
  }

  const lastError = ctx?.lastError ?? connData?.lastError;
  const lastErrorAt = ctx?.lastErrorAt ?? connData?.lastErrorAt;
  // The vendor's own reset instant is the only source of truth for the weekly
  // bucket: it comes from providerSpecificData when someone read it off the
  // console, or from a FRESH 429 (a stale one would project the wrong week, so
  // it goes through the same freshness gate the exhaustion path uses).
  const resetAtHint =
    resetHintOf(psd) ?? alibabaQuotaExhaustion(lastError, lastErrorAt, now)?.resetAt ?? null;

  const result = calcSlidingWindowUsage(rows, now, {
    ...psd,
    unit: psd.unit || psd.quotaUnit || "credits",
    resetAtHint,
  });
  return applyAlibabaQuotaExhaustion(result, { lastError, lastErrorAt }, rows, now);
}
