// Rate-limit policy — classification and retry-window contract.
//
// Every error string below is a REAL payload captured from the live upstream
// (Cline → OpenRouter), not an invented fixture. They are stored in their exact
// single-escaped wire form on purpose: aggregators re-encode the upstream JSON
// inside their own JSON, so a parser that only understands clean JSON would pass
// a hand-written test and still fail in production.
//
// Regression this locks down: a 5-second upstream throttle must never propagate
// as a multi-minute account lock, and a pool shared by every credential must not
// be treated as an account-specific fault that rotation can clear.
import { describe, expect, it } from "vitest";

import {
  FAILURE_CLASS,
  RATE_LIMIT_POLICY,
  classifyUpstreamFailure,
  getPolicyFor,
  parseRetryHintMs
} from "../../open-sse/services/rateLimitPolicy.js";
import { STRUCTURED_CLASSES } from "../../open-sse/services/accountFallback.js";

// ── Captured wire payloads ──────────────────────────────────────────────────
// Shared-pool saturation: upstream asked for 5s.
const SHARED_POOL = "❌ clinepass [500]: [500]: {\"error\":\"inference request failed: failed to invoke model 'z-ai/glm-5.2:free' from Openrouter: request failed with status 429: {\\\"error\\\":{\\\"message\\\":\\\"Provider returned error\\\",\\\"code\\\":429,\\\"metadata\\\":{\\\"raw\\\":\\\"z-ai/glm-5.2:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations\\\",\\\"provider_name\\\":\\\"Decart\\\",\\\"is_byok\\\":false,\\\"provider_error_code\\\":\\\"overloaded\\\",\\\"limit_source\\\":\\\"upstream_provider_shared_pool\\\",\\\"retry_after_seconds\\\":5,\\\"retry_after_seconds_raw\\\":5}},\\\"user_id\\\":\\\"org_2ue3sRj4x3tXiJ1Dy2aaiheiHnm\\\"}\",\"success\":false}";

// Retired free tier: deterministic, points at the paid slug.
const UNSUPPORTED_FREE = "[clinepass/deepseek/deepseek-v4-flash-0731:free] [500]: {\"error\":\"inference request failed: failed to invoke model 'deepseek/deepseek-v4-flash-0731:free' from Openrouter: request failed with status 404: {\\\"error\\\":{\\\"message\\\":\\\"This model is unavailable for free. The paid version is available now - use this slug instead: deepseek/deepseek-v4-flash-0731\\\",\\\"code\\\":404},\\\"user_id\\\":\\\"org_2ue3sRj4x3tXiJ1Dy2aaiheiHnm\\\"}\",\"success\":false}";

// Per-day credential cap, with the exact reset instant in a header.
const DAILY_RPD = "[clinepass/thinkingmachines/inkling:free] [500]: {\"error\":\"inference request failed: failed to invoke model 'thinkingmachines/inkling:free' from Openrouter: request failed with status 429: {\\\"error\\\":{\\\"message\\\":\\\"Rate limit exceeded: limit_rpd/thinkingmachines/inkling-20260715/89249263-425e-4099-a555-ea5c9698ba76. Daily limit reached for thinkingmachines/inkling:free via Thinking Machines. Credits don't affect this cap.\\\",\\\"code\\\":429,\\\"metadata\\\":{\\\"headers\\\":{\\\"X-RateLimit-Limit\\\":\\\"5000\\\",\\\"X-RateLimit-Remaining\\\":\\\"0\\\",\\\"X-RateLimit-Reset\\\":\\\"1789948800000\\\"},\\\"limit_source\\\":\\\"openrouter_shared_capacity\\\",\\\"provider_name\\\":null}},\\\"user_id\\\":\\\"org_2ue3sRj4x3tXiJ1Dy2aaiheiHnm\\\"}\",\"success\":false}";

describe("parseRetryHintMs — reads the upstream's own retry window", () => {
  it("reads retry_after_seconds out of escaped aggregator JSON", () => {
    expect(parseRetryHintMs(SHARED_POOL)).toBe(5000);
  });

  it("reads a future X-RateLimit-Reset epoch", () => {
    const future = Date.now() + 90_000;
    const body = `{"metadata":{"headers":{"X-RateLimit-Reset":"${Math.round(future)}"}}}`;
    const hint = parseRetryHintMs(body);
    expect(hint).toBeGreaterThan(80_000);
    expect(hint).toBeLessThanOrEqual(90_000);
  });

  it("ignores an X-RateLimit-Reset that already passed", () => {
    const past = Date.now() - 60_000;
    expect(parseRetryHintMs(`{"X-RateLimit-Reset":"${Math.round(past)}"}`)).toBeNull();
  });

  it("supports the millisecond spelling", () => {
    expect(parseRetryHintMs('{"error":{"retry_after_ms":7500}}')).toBe(7500);
  });

  it("returns null when the upstream gave no window at all", () => {
    expect(parseRetryHintMs("Service temporarily unavailable")).toBeNull();
    expect(parseRetryHintMs("")).toBeNull();
    expect(parseRetryHintMs(null)).toBeNull();
  });

  // A wrong-but-plausible window is worse than no window: a present hint also
  // freezes the backoff ladder, so a misread value silently under-waits.
  it("reads scientific notation as the JSON number it is", () => {
    // `1e3` is valid JSON for 1000 seconds. Rejecting it would degrade to the
    // ladder exactly when the upstream uses that format; truncating it to `1`
    // (the pre-fix behaviour) under-waits by three orders of magnitude.
    expect(parseRetryHintMs('{"retry_after_seconds":1e3}')).toBe(1_000_000);
    expect(parseRetryHintMs('{"retry_after_seconds":1E3}')).toBe(1_000_000);
    expect(parseRetryHintMs('{"retry_after_seconds":5e2}')).toBe(500_000);
    expect(parseRetryHintMs('{"retry_after_ms":1e3}')).toBe(1000);
  });

  it("rejects a malformed number instead of parseFloat-ing a prefix", () => {
    expect(parseRetryHintMs('{"retry_after_seconds":1.2.3}')).toBeNull();
    expect(parseRetryHintMs('{"retry_after_seconds":5abc}')).toBeNull();
    expect(parseRetryHintMs('{"retry_after_seconds":-5}')).toBeNull();
    expect(parseRetryHintMs('{"retry_after_seconds":1e400}')).toBeNull();
  });

  it("still accepts an integer and a decimal", () => {
    expect(parseRetryHintMs('{"retry_after_seconds":5}')).toBe(5000);
    expect(parseRetryHintMs('{"retry_after_seconds":2.5}')).toBe(2500);
  });

  it("falls back to retry_after_seconds_raw when the primary value is not numeric", () => {
    expect(parseRetryHintMs('{"retry_after_seconds":null,"retry_after_seconds_raw":8}')).toBe(8000);
    expect(parseRetryHintMs('{"retry_after_seconds":"soon","retry_after_seconds_raw":8}')).toBe(8000);
  });

  it("reads the retry window through two levels of JSON escaping", () => {
    // Aggregators nest the upstream body; the class must not depend on depth.
    const inner = JSON.stringify({ limit_source: "upstream_provider_shared_pool", retry_after_seconds: 5 });
    const depth2 = JSON.parse(JSON.stringify(JSON.stringify(inner)));
    expect(parseRetryHintMs(depth2)).toBe(5000);
    expect(classifyUpstreamFailure(500, depth2).class).toBe(FAILURE_CLASS.sharedPool);
  });

  // Regression: the first version of the depth fix removed EVERY backslash, which
  // joins its neighbours — `C:\share\d_pool` collapsed to `C:shared_pool` and a
  // generic 500 was classified as a saturated pool, stopping credential rotation
  // for a condition that did not exist. Only escape SEQUENCES may be folded.
  it("never invents a marker by folding a lone backslash", () => {
    const windowsPath = String.raw`{"error":{"message":"scan the log dir C:\\share\\d_pool for details","code":500}}`;
    expect(windowsPath).not.toContain("shared_pool");
    expect(classifyUpstreamFailure(500, windowsPath).class).not.toBe(FAILURE_CLASS.sharedPool);

    const singleBackslash = String.raw`{"error":{"message":"path C:\share\d_pool is unwritable","code":500}}`;
    expect(singleBackslash).not.toContain("shared_pool");
    expect(classifyUpstreamFailure(500, singleBackslash).class).not.toBe(FAILURE_CLASS.sharedPool);

    const splitWord = String.raw`{"error":{"message":"model unavailabl\\e for free today","code":500}}`;
    expect(splitWord).not.toContain("unavailable for free");
    expect(classifyUpstreamFailure(500, splitWord).class).not.toBe(FAILURE_CLASS.unsupportedModel);
  });

  it("still finds a REAL marker that is genuinely escaped", () => {
    // The fold must keep working where it matters, or the fix above would just be
    // a different way of not detecting anything.
    const escaped = String.raw`{"error":{"message":"pool saturated","limit_source":"upstream_provider_shared_pool"}}`;
    expect(classifyUpstreamFailure(500, escaped).class).toBe(FAILURE_CLASS.sharedPool);
  });
});

describe("classifyUpstreamFailure — pooled throttles do not blame the account", () => {
  it("shared-pool 429 with a 5s hint → short bounded cooldown, no escalation", () => {
    const result = classifyUpstreamFailure(500, SHARED_POOL);
    expect(result.class).toBe(FAILURE_CLASS.sharedPool);
    expect(result.retryHintMs).toBe(5000);
    // 5s asked + grace, never the old 5-minute ceiling.
    expect(result.cooldownMs).toBe(6000);
    expect(result.backoff).toBe(false);
    expect(result.rotateUseful).toBe(false);
    expect(result.limitSource).toBe("upstream_provider_shared_pool");
  });

  it("shared-pool ceiling holds even when the pool reports a long window", () => {
    const body = '{"limit_source":"upstream_provider_shared_pool","retry_after_seconds":3600}';
    const result = classifyUpstreamFailure(429, body);
    expect(result.class).toBe(FAILURE_CLASS.sharedPool);
    expect(result.cooldownMs).toBe(RATE_LIMIT_POLICY[FAILURE_CLASS.sharedPool].maxCooldownMs);
  });

  it("shared-pool without any hint falls back to the bounded default, not backoff", () => {
    const result = classifyUpstreamFailure(503, '{"limit_source":"openrouter_shared_capacity"}');
    expect(result.class).toBe(FAILURE_CLASS.sharedPool);
    expect(result.cooldownMs).toBe(30_000);
    expect(result.backoff).toBe(false);
  });
});

describe("classifyUpstreamFailure — deterministic failures stop burning candidates", () => {
  it("free tier retired → unsupported_model, no account rotation", () => {
    const result = classifyUpstreamFailure(500, UNSUPPORTED_FREE);
    expect(result.class).toBe(FAILURE_CLASS.unsupportedModel);
    expect(result.rotateUseful).toBe(false);
    expect(result.backoff).toBe(false);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("per-day cap honours the reset instant and keeps rotation (separate accounts, separate days)", () => {
    // The reset instant is generated RELATIVE to now rather than read from the
    // captured epoch: the fixture's literal 1789948800000 is 2026-09-21T00:00Z, so
    // an assertion tied to it silently starts measuring the NO-HINT path once that
    // instant is in the past (which is exactly how this test first passed while
    // asserting the wrong branch). The escaping shape is covered by the captured
    // payloads and by the depth tests above, so this case keeps the marker text
    // and states the window plainly.
    const resetAt = Date.now() + 3 * 60 * 60 * 1000;
    const payload = `{"error":{"message":"Rate limit exceeded: limit_rpd/thinkingmachines/inkling/abc. Daily limit reached.","code":429,"metadata":{"headers":{"X-RateLimit-Limit":"5000","X-RateLimit-Reset":"${resetAt}"},"limit_source":"openrouter_shared_capacity"}}}`;

    const result = classifyUpstreamFailure(500, payload);
    expect(result.class).toBe(FAILURE_CLASS.dailyQuota);
    expect(result.rotateUseful).toBe(true);
    expect(result.dailyLimit).toBe(5000);
    // Derived from the header (~3h), not from a blind exponential step nor from
    // the class default (5 min).
    expect(result.cooldownMs).toBeGreaterThan(2 * 60 * 60 * 1000);
    expect(result.cooldownMs).toBeLessThanOrEqual(
      RATE_LIMIT_POLICY[FAILURE_CLASS.dailyQuota].maxCooldownMs
    );
  });
});

describe("classifyUpstreamFailure — credential-scoped throttles keep escalating", () => {
  it("a plain 429 with no pool marker stays account-scoped and escalating", () => {
    const result = classifyUpstreamFailure(429, "rate limit exceeded");
    expect(result.class).toBe(FAILURE_CLASS.accountRateLimit);
    expect(result.backoff).toBe(true);
    expect(result.rotateUseful).toBe(true);
    expect(result.cooldownMs).toBeNull();
  });

  it("a 429 with a retry window uses that window instead of escalating", () => {
    const result = classifyUpstreamFailure(429, '{"error":{"retry_after_seconds":2}}');
    expect(result.class).toBe(FAILURE_CLASS.accountRateLimit);
    expect(result.cooldownMs).toBe(3000);
    expect(result.backoff).toBe(false);
  });

  it("rpm/tpm markers are credential-scoped", () => {
    const result = classifyUpstreamFailure(429, '{"message":"Rate limit exceeded: limit_rpm/qwen/qwen3.8-27b/abc"}');
    expect(result.class).toBe(FAILURE_CLASS.accountRateLimit);
    expect(result.rotateUseful).toBe(true);
  });
});

describe("classifyUpstreamFailure — auth and request errors stay caller-owned", () => {
  it("401 → auth, zero cooldown (token refresh owns it)", () => {
    const result = classifyUpstreamFailure(401, "Unauthorized: Please make sure you're using the latest version of Cline");
    expect(result.class).toBe(FAILURE_CLASS.auth);
    expect(result.cooldownMs).toBe(0);
    expect(result.rotateUseful).toBe(false);
  });

  it("400 blown context → request class", () => {
    const result = classifyUpstreamFailure(400, "context_length_exceeded: maximum context length is 8192 tokens");
    expect(result.class).toBe(FAILURE_CLASS.request);
    expect(result.cooldownMs).toBe(0);
  });
});

describe("policy table is total", () => {
  it("every failure class resolves to a policy row", () => {
    for (const failureClass of Object.values(FAILURE_CLASS)) {
      const policy = getPolicyFor(failureClass);
      expect(policy, failureClass).toBeTruthy();
      expect(typeof policy.rotateUseful).toBe("boolean");
      expect(policy.maxCooldownMs).toBeGreaterThan(0);
    }
  });

  it("an unknown class degrades to the transient policy instead of throwing", () => {
    expect(getPolicyFor("no_such_class")).toBe(RATE_LIMIT_POLICY[FAILURE_CLASS.server]);
  });
});

// ── The gate is complete by test, not by comment ─────────────────────────────
// `unsupported_model` shipped classified-but-ungated: it was in the policy table,
// in neither gate flag, and the tests only exercised the classifier. These two
// assertions turn the "conscious decision" that the comment asks for into a check
// that fails on a recurrence.
describe("STRUCTURED_CLASSES — every structured class is actually reachable", () => {
  it("every rotation-free class is gated, or answered by an early guard", () => {
    // `auth` and `request` are settled BEFORE the structured block (the RH2 gates
    // and the token-refresh flow own them), so they are legitimately absent.
    const answeredEarly = new Set([FAILURE_CLASS.auth, FAILURE_CLASS.request]);
    for (const [name, policy] of Object.entries(RATE_LIMIT_POLICY)) {
      if (policy.rotateUseful) continue;
      if (answeredEarly.has(name)) continue;
      expect(STRUCTURED_CLASSES.has(name), `${name} must be reachable through the gate`).toBe(true);
    }
  });

  it("holds no class without a policy row", () => {
    for (const name of STRUCTURED_CLASSES) {
      expect(RATE_LIMIT_POLICY[name], `${name} has no policy row`).toBeTruthy();
    }
  });

  it("keeps daily_quota rotatable while gated (the two are independent)", () => {
    expect(STRUCTURED_CLASSES.has(FAILURE_CLASS.dailyQuota)).toBe(true);
    expect(RATE_LIMIT_POLICY[FAILURE_CLASS.dailyQuota].rotateUseful).toBe(true);
  });
});