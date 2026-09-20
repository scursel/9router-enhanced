import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS, ERROR_TYPES } from "../config/errorConfig.js";
import {
  FAILURE_CLASS,
  classifyUpstreamFailure,
  getPolicyFor
} from "./rateLimitPolicy.js";

/**
 * Statuses that errorConfig.js already models as client-side request failures
 * (`invalid_request_error`). No account change fixes these, so they must never
 * trigger account fallback or lock anyone (RH2). 404 is excluded on purpose via
 * its `model_not_found` code: "model missing on this account" is account/model
 * state, not a broken request, and keeps the existing ERROR_RULES behaviour
 * (fallback + per-model cooldown).
 * 413/422 are request-shaped failures (payload too large / semantic validation)
 * that errorConfig's tables do not model; they are the only literals here.
 */
const REQUEST_ERROR_STATUSES = new Set([
  ...Object.entries(ERROR_TYPES)
    .filter(([, t]) => t.type === "invalid_request_error" && t.code !== "model_not_found")
    .map(([status]) => Number(status)),
  413,
  422
]);

/**
 * Auth statuses (derived from ERROR_TYPES `authentication_error`). A 401 is
 * decided by the token-refresh flow in chatCore/handlers (refresh + retry),
 * never by locking the whole account here: an expired access token must not
 * take the combo down (RH2 — `if (!shouldFallback)` in auth.js was dead code).
 */
const AUTH_ERROR_STATUSES = new Set(
  Object.entries(ERROR_TYPES)
    .filter(([, t]) => t.type === "authentication_error")
    .map(([status]) => Number(status))
);

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 *
 * Classification (RH2 fix), in priority order:
 *  1. Auth statuses (401) → shouldFallback:false, cooldownMs:0: credential
 *     refresh is decided upstream (chatCore refresh flow), not by locking here.
 *  2. Request-caused statuses (REQUEST_ERROR_STATUSES: 400/406/413/422) → same
 *     non-locking answer — deterministic client errors: every account returns
 *     the same error, so fallback would only self-DoS the combo. Exception:
 *     rate-limit / quota / capacity wording, which is account state.
 *  3. Everything else keeps the historical ERROR_RULES behaviour: rate/quota/
 *     upstream/transient → shouldFallback:true with a cooldown (429 backoff,
 *     5xx and unmatched → transient; 404 stays per-model 2-min lock by design;
 *     any other unmatched 4xx is request-scoped → no fallback, no lock).
 *
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number,
 *            applyCooldownOnly?: boolean }} `applyCooldownOnly` asks the caller to
 *   record the cooldown without rotating to another account: the failure was not
 *   this credential's fault and every sibling would answer identically.
 */
export function checkFallbackError(status, errorText, backoffLevel = 0) {
  // Request-caused error: propagate immediately, no account fallback, no lock.
  // Checked before text rules because the HTTP status is the authoritative
  // origin signal (text substrings are heuristics that can co-occur with 4xx).
  const code = Number.isFinite(Number(status)) ? Number(status) : null;
  if (code !== null && AUTH_ERROR_STATUSES.has(code)) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  if (code !== null && REQUEST_ERROR_STATUSES.has(code)) {
    // Rate-limit / quota / capacity wording describes the account or upstream,
    // not the request, even when a provider reports it under a 4xx (official
    // 20a43f5a). Only those backoff rules may override the request-status gate.
    const accountRule = ERROR_RULES.find(r => r.backoff && r.text && lowerError.includes(r.text));
    if (!accountRule) return { shouldFallback: false, cooldownMs: 0 };
  }

  // Structured policy, applied before the text rules below.
  //
  // The rules loop answers "does the message mention a rate limit?" and pays for
  // it with the exponential ladder (up to BACKOFF_CONFIG.max = 5 min). That is
  // the right answer for a credential's own throttle and the wrong one for the
  // two classes an aggregator makes unambiguous:
  //
  //   • shared_pool — the cap belongs to a pool every credential shares, so the
  //     text heuristic matched and escalated for a condition no retry could
  //     clear. Observed live: upstream asked for 5s, the account was locked for
  //     300s, and rotating burned every candidate.
  //   • daily_quota — the upstream states the exact instant the window reopens;
  //     waiting longer than advertised is pure downtime.
  //
  // Both carry an explicit upstream window, so they are classified and settled
  // here from the upstream's own numbers instead of a blind ladder.
  const failure = classifyUpstreamFailure(code, errorText);
  const isRateLimitClass =
    failure.class === FAILURE_CLASS.accountRateLimit ||
    failure.class === FAILURE_CLASS.dailyQuota;
  const hintDerived =
    (isRateLimitClass || failure.class === FAILURE_CLASS.sharedPool) && failure.retryHintMs !== null;
  const structuredStandalone =
    failure.class === FAILURE_CLASS.sharedPool || failure.class === FAILURE_CLASS.dailyQuota;

  if (structuredStandalone || hintDerived) {
    const policy = getPolicyFor(failure.class);
    let cooldownMs = failure.cooldownMs ?? policy.defaultCooldownMs ?? policy.cooldownMs ?? 0;
    cooldownMs = Math.min(cooldownMs, policy.maxCooldownMs);

    if (!policy.rotateUseful) {
      // Every credential hits this identically, so consuming the rest of the
      // combo only delays the honest error: stop the account loop and propagate
      // the upstream message. The cooldown is still recorded (`applyCooldownOnly`)
      // because skipping the write entirely would leave the account hammering the
      // same saturated pool with no wait at all — the caller must stop rotating
      // AND the state must still respect the window.
      return {
        shouldFallback: false,
        cooldownMs,
        applyCooldownOnly: true,
        newBackoffLevel: backoffLevel
      };
    }

    // A throttle the upstream already bounded must not also inflate the ladder:
    // keeping the level means one bad window no longer leaves the account one
    // failure away from the maximum lock.
    if (!policy.backoff) {
      return { shouldFallback: true, cooldownMs, newBackoffLevel: backoffLevel };
    }
    return { shouldFallback: true, cooldownMs };
  }

  for (const rule of ERROR_RULES) {
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
  }

  // Request-scoped client errors that matched no rule above: a 400 caused by the
  // request itself (context overflow, malformed body, unsupported parameter) says
  // nothing about the credential, so cooling the account down only removes a
  // healthy connection from rotation. With a single connection it is worse: every
  // later request in the window fails with a copy of this very error
  // ("all 1 accounts locked for <model> | lastError=[400]: ..."), which hides the
  // real cause from the caller and makes unrelated sessions look like they hit the
  // same limit. Hand the upstream error back for this request instead.
  // Account-scoped statuses keep their rules above (402/403/404/429; 401 is left
  // to the refresh flow at the top), and the text rules still win for
  // rate-limit / quota / capacity wording.
  if (status >= 400 && status < 500 && status !== 401 && status !== 402 && status !== 403 && status !== 429) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}
