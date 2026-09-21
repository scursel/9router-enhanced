/**
 * Upstream rate-limit / failure policy — the single place that decides what an
 * upstream error MEANS and how long the affected account+model must wait.
 *
 * Why this exists
 * ---------------
 * Routers that sit in front of an aggregator (Cline → OpenRouter, and any
 * OpenAI-compatible gateway that re-exports a shared free pool) receive errors
 * that are already classified: the upstream tells you the exact retry window
 * (`retry_after_seconds`, `X-RateLimit-Reset`), the limit that tripped
 * (`limit_rpd`, `limit_rpm`, `upstream_provider_shared_pool`) and whether the
 * cap belongs to the credential or to a shared pool nobody can retry around.
 *
 * The previous behaviour threw all of that away and asked one question —
 * "does the message text contain 'rate limit'?" — then answered it with
 * exponential backoff capped at `BACKOFF_CONFIG.max` (5 min, top level). A
 * 5-second upstream throttle therefore propagated as up to a 5-minute account
 * lock, and because a shared-pool throttle is identical for every credential,
 * rotating accounts could not help either: the combo burned all of its
 * candidates and surfaced "all N accounts locked" for a condition that every
 * account shared.
 *
 * Scope
 * -----
 * Pure and side-effect free: it classifies and computes numbers, never touching
 * the DB, the network, or logs. Cancellation is *represented* here and performed
 * by the caller (`accountFallback.js` → `src/sse/services/auth.js`).
 *
 * Signals are matched textually rather than by unescaping the body: aggregators
 * re-encode the upstream JSON inside their own JSON, so the same field arrives
 * escaped at one depth and plain at another. Text matching stays correct at
 * every depth and degrades to the historical behaviour when nothing matches.
 */

/**
 * Failure classes. Each maps to exactly one policy row in POLICY below.
 *
 * - unsupported_model  upstream says this model will not serve this account,
 *                      and asking again will not change that (free tier retired,
 *                      model gated, permanent 404). Rotating accounts is useless.
 * - daily_quota        a per-day cap belonging to the credential (`limit_rpd`),
 *                      or an explicit reset timestamp. Wait until the reset.
 * - shared_pool        capacity owned by a pool shared across all users of the
 *                      aggregation service. Rotating accounts is useless: the
 *                      condition is identical for every credential.
 * - account_rate_limit a per-credential throttle (rpm/tpm, no pool marker). The
 *                      only class where rotating to another account genuinely
 *                      helps and where backoff escalation is deserved.
 * - auth               credential rejected. Owned by the token-refresh flow.
 * - request            the request itself is at fault: no account change helps.
 * - server             upstream transient fault (5xx, timeouts, network).
 */
export const FAILURE_CLASS = {
  unsupportedModel: "unsupported_model",
  dailyQuota: "daily_quota",
  sharedPool: "shared_pool",
  accountRateLimit: "account_rate_limit",
  auth: "auth",
  request: "request",
  server: "server"
};

// ── Policy table ────────────────────────────────────────────────────────────
// cooldownMs      fixed wait, or null when the class derives it from a hint
// backoff         true → escalate the exponential ladder (account's own fault)
// rotateUseful    true → another account may succeed for the same model
// maxCooldownMs   ceiling applied to any hint-derived wait
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export const RATE_LIMIT_POLICY = {
  [FAILURE_CLASS.unsupportedModel]: {
    cooldownMs: 30 * MINUTE_MS,
    backoff: false,
    rotateUseful: false,
    maxCooldownMs: HOUR_MS
  },
  [FAILURE_CLASS.dailyQuota]: {
    cooldownMs: 5 * MINUTE_MS,
    backoff: false,
    rotateUseful: true,
    maxCooldownMs: 6 * HOUR_MS
  },
  [FAILURE_CLASS.sharedPool]: {
    cooldownMs: null,
    // Default used when the pool reports no retry window at all.
    defaultCooldownMs: 30 * 1000,
    backoff: false,
    rotateUseful: false,
    maxCooldownMs: MINUTE_MS
  },
  [FAILURE_CLASS.accountRateLimit]: {
    cooldownMs: null,
    defaultCooldownMs: null, // falls through to the caller's backoff ladder
    backoff: true,
    rotateUseful: true,
    maxCooldownMs: 30 * MINUTE_MS
  },
  [FAILURE_CLASS.auth]: {
    cooldownMs: 0,
    backoff: false,
    rotateUseful: false,
    maxCooldownMs: HOUR_MS
  },
  [FAILURE_CLASS.request]: {
    cooldownMs: 0,
    backoff: false,
    rotateUseful: false,
    maxCooldownMs: HOUR_MS
  },
  [FAILURE_CLASS.server]: {
    cooldownMs: 30 * 1000,
    backoff: false,
    rotateUseful: true,
    maxCooldownMs: HOUR_MS
  }
};

// Retry windows are rounded values produced by a remote clock: waiting exactly
// as long as asked reliably lands just before the window opens.
const HINT_GRACE_MS = 1000;

// ── Textual signal matching ─────────────────────────────────────────────────

const text = (value) => (typeof value === "string" ? value : value == null ? "" : String(value));

/**
 * Remove JSON escaping so one flat query works at every depth.
 *
 * An aggregator nests the upstream body inside its own, so the same field
 * arrives as `"retry_after_seconds":5` at the top level, `\"…\"` one level down
 * and `\\\"…\\\"` two levels down. Stripping every backslash (not just the pairs
 * a single pass would fold) collapses all of those into one spelling, which is
 * what keeps the patterns below depth-independent. The result is never parsed as
 * JSON — it is only searched — so a partial unescape is safe, and a payload
 * whose own text contained a literal backslash would only lose that byte.
 */
function stripBackslashes(source) {
  return source.replace(/\\/g, "");
}

/**
 * Read a numeric JSON field, accepting only a well-formed number.
 *
 * The digits must form the WHOLE token: `1e3` (scientific notation, which the
 * upstream could legitimately use for 1000 seconds) and `1.2.3` (malformed) are
 * rejected rather than silently truncated to `1`. A wrong-but-plausible window
 * is worse than no window, because a present hint also freezes the backoff
 * ladder — so "unreadable" must degrade to the policy default, never to a
 * smaller number than the upstream asked for.
 */
function numericField(source, name) {
  const pattern = new RegExp(`"${name}"\\s*:\\s*"?\\s*(\\d+(?:\\.\\d+)?)\\s*(["},\\s]|$)`, "i");
  const match = pattern.exec(source);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Read a string JSON field, tolerating escapes inside the value. */
function stringField(source, name) {
  const pattern = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i");
  const match = pattern.exec(source);
  return match ? stripBackslashes(match[1]) : null;
}

/**
 * Wait the upstream explicitly asked for, in ms.
 *
 * Accepts the shapes seen in the wild:
 *  - OpenRouter inside Cline: `"retry_after_seconds":5`
 *  - millisecond variants:    `"retry_after_ms":5000`
 *  - rate-limit headers:      `"X-RateLimit-Reset":"1789948800000"` (epoch ms)
 * The header form is only trusted when it points into the future.
 */
export function parseRetryHintMs(errorText) {
  const source = stripBackslashes(text(errorText));
  if (!source) return null;

  const seconds = numericField(source, "retry_after_seconds")
    ?? numericField(source, "retry_after_seconds_raw");
  if (seconds !== null) return Math.round(seconds * 1000);

  const millis = numericField(source, "retry_after_ms");
  if (millis !== null) return Math.round(millis);

  const resetEpochMs = numericField(source, "X-RateLimit-Reset");
  if (resetEpochMs !== null) {
    const waitMs = resetEpochMs - Date.now();
    if (waitMs > 0) return waitMs;
  }

  return null;
}

/**
 * True when the throttle belongs to a pool shared by every user of the
 * aggregation service — retrying on another credential cannot clear it.
 * Seen as OpenRouter `limit_source` values and in the human-readable hint.
 */
export function isSharedPoolSignal(errorText) {
  const source = stripBackslashes(text(errorText)).toLowerCase();
  return (
    source.includes("upstream_provider_shared_pool") ||
    source.includes("openrouter_shared_capacity") ||
    source.includes("shared_pool") ||
    source.includes("shared pool")
  );
}

/** Per-day cap marker: OpenRouter emits `limit_rpd/<model>/<id>`. */
const isDailyQuotaSignal = (source) =>
  /limit[_-]?rpd/i.test(source) || /daily limit reached/i.test(source);

/** Per-minute/per-token throttle markers (credential-scoped, not pooled). */
const isPerMinuteSignal = (source) => /limit[_-]?(rpm|tpm|rph)/i.test(source);

/**
 * Upstream states the model will not serve this (free) tier and points at a
 * different slug — a deterministic answer, not a temporary one.
 */
const isUnsupportedModelSignal = (source) =>
  /unavailable for free/i.test(source) ||
  /not available for free/i.test(source) ||
  /is not available on the free tier/i.test(source);

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Turn an upstream status + already-extracted message into the class, the retry
 * window the upstream asked for, and actionable context.
 *
 * `status` is the status the ROUTER will report, which for aggregators may be a
 * wrapper code (Cline answers 500 while `code:429` sits in the body). The body
 * markers are therefore given priority for rate-limit classes, and `status` is
 * used for the classes that only make sense as a status (auth/request/5xx).
 *
 * @param {number|null} status HTTP status reported by the router
 * @param {string} errorText Error message, possibly containing nested JSON
 * @returns {{ class: string, cooldownMs: number|null, retryHintMs: number|null,
 *            rotateUseful: boolean, backoff: boolean, limitSource: string|null,
 *            dailyLimit: number|null, reason: string }}
 */
export function classifyUpstreamFailure(status, errorText) {
  const source = stripBackslashes(text(errorText));
  const lower = source.toLowerCase();
  const code = Number.isFinite(Number(status)) ? Number(status) : null;
  const retryHintMs = parseRetryHintMs(source);

  const limitSource = stringField(source, "limit_source");
  const dailyLimit = numericField(source, "X-RateLimit-Limit") ??
    numericField(source, "daily_limit");

  const base = {
    class: FAILURE_CLASS.server,
    cooldownMs: null,
    retryHintMs,
    rotateUseful: true,
    backoff: false,
    limitSource,
    dailyLimit,
    reason: ""
  };

  // 1. A model that will not serve this account, whatever the wrapper status is.
  if (isUnsupportedModelSignal(source)) {
    return {
      ...base,
      class: FAILURE_CLASS.unsupportedModel,
      cooldownMs: RATE_LIMIT_POLICY[FAILURE_CLASS.unsupportedModel].cooldownMs,
      rotateUseful: false,
      reason: "model unavailable on this upstream tier"
    };
  }

  // 2. A per-day cap: wait for the reset rather than hammering a window that
  //    cannot reopen sooner. Checked BEFORE the shared-pool branch because a
  //    payload can carry both markers (OpenRouter reports `limit_rpd` — the
  //    credential's own daily budget — together with a `…shared_capacity`
  //    limit_source naming where the counter is drawn from). The daily cap is
  //    the more precise signal: it states the scope (this credential, this
  //    model) and usually the exact instant the window reopens, and it still
  //    rewards account rotation, since separate credentials own separate days.
  if (isDailyQuotaSignal(source)) {
    const policy = RATE_LIMIT_POLICY[FAILURE_CLASS.dailyQuota];
    const waitMs = retryHintMs === null ? policy.cooldownMs : retryHintMs + HINT_GRACE_MS;
    return {
      ...base,
      class: FAILURE_CLASS.dailyQuota,
      cooldownMs: Math.min(waitMs, policy.maxCooldownMs),
      reason: "daily quota exhausted upstream"
    };
  }

  // 3. Pooled capacity: retrying elsewhere cannot clear it. Checked before the
  //    credential-scoped classes because a shared pool also reports rpm/tpm-like
  //    text and a retry hint.
  if (isSharedPoolSignal(source) || (limitSource && /shared/i.test(limitSource))) {
    const policy = RATE_LIMIT_POLICY[FAILURE_CLASS.sharedPool];
    const waitMs = retryHintMs === null
      ? policy.defaultCooldownMs
      : retryHintMs + HINT_GRACE_MS;
    return {
      ...base,
      class: FAILURE_CLASS.sharedPool,
      cooldownMs: Math.min(waitMs, policy.maxCooldownMs),
      rotateUseful: false,
      backoff: false,
      reason: "upstream pool saturated (shared across credentials)"
    };
  }

  // 4. Credential-scoped throttle: the one class worth escalating and rotating.
  if (isPerMinuteSignal(source) || code === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return {
      ...base,
      class: FAILURE_CLASS.accountRateLimit,
      cooldownMs: retryHintMs === null ? null : retryHintMs + HINT_GRACE_MS,
      backoff: retryHintMs === null,
      reason: "credential rate limit"
    };
  }

  // 5. Quota/capacity wording that is neither pooled nor per-day: historical
  //    behaviour (account-scoped, escalating) is the honest default here.
  if (lower.includes("quota exceeded") || lower.includes("overloaded") || lower.includes("capacity")) {
    return {
      ...base,
      class: FAILURE_CLASS.accountRateLimit,
      cooldownMs: retryHintMs === null ? null : retryHintMs + HINT_GRACE_MS,
      backoff: retryHintMs === null,
      reason: "quota/capacity wording"
    };
  }

  if (code === 401 || code === 403) {
    return {
      ...base,
      class: FAILURE_CLASS.auth,
      cooldownMs: 0,
      rotateUseful: false,
      reason: "credential rejected"
    };
  }

  if (code !== null && code >= 400 && code < 500) {
    return {
      ...base,
      class: FAILURE_CLASS.request,
      cooldownMs: 0,
      rotateUseful: false,
      reason: "request-caused"
    };
  }

  return { ...base, class: FAILURE_CLASS.server, reason: "upstream transient" };
}

/** Policy row for a class (never null for a class from classifyUpstreamFailure). */
export function getPolicyFor(failureClass) {
  return RATE_LIMIT_POLICY[failureClass] ?? RATE_LIMIT_POLICY[FAILURE_CLASS.server];
}

export { HINT_GRACE_MS };