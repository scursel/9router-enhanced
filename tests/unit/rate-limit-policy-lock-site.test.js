// Rate-limit policy — end-to-end through the REAL account-lock call site.
//
// The unit tests in rate-limit-policy.test.js cover classification. This file
// covers the consequence: what the combo loop and the DB actually do when an
// aggregator reports a pooled throttle.
//
// The regression being locked down, captured from the live log:
//
//   ⚠️ [AUTH] Hermes locked modelLock_z-ai/glm-5.2:free for 300s [500]
//
// ...for an upstream that had asked for `retry_after_seconds: 5`. Measured with
// a real capture: a 5s upstream window must not become a multi-minute lock, must
// not inflate the backoff ladder, and must not burn the remaining accounts.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

// Real capture (Cline → OpenRouter, shared pool). Single-escaped wire form.
const SHARED_POOL_500 =
  "[clinepass/z-ai/glm-5.2:free] [500]: {\"error\":\"inference request failed: failed to invoke model 'z-ai/glm-5.2:free' from Openrouter: request failed with status 429: {\\\"error\\\":{\\\"message\\\":\\\"Provider returned error\\\",\\\"code\\\":429,\\\"metadata\\\":{\\\"raw\\\":\\\"z-ai/glm-5.2:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits\\\",\\\"provider_name\\\":\\\"Decart\\\",\\\"is_byok\\\":false,\\\"limit_source\\\":\\\"upstream_provider_shared_pool\\\",\\\"retry_after_seconds\\\":5}},\\\"user_id\\\":\\\"org_2ue3sRj4x3tXiJ1Dy2aaiheiHnm\\\"}\",\"success\":false}";

// Real capture: the credential's own daily budget (`limit_rpd`), reset stated.
const DAILY_CAP_500 =
  "[clinepass/thinkingmachines/inkling:free] [500]: {\"error\":\"failed to invoke model 'thinkingmachines/inkling:free' from Openrouter: request failed with status 429: {\\\"error\\\":{\\\"message\\\":\\\"Rate limit exceeded: limit_rpd/thinkingmachines/inkling-20260715/89249263. Daily limit reached for thinkingmachines/inkling:free via Thinking Machines.\\\",\\\"code\\\":429,\\\"metadata\\\":{\\\"headers\\\":{\\\"X-RateLimit-Limit\\\":\\\"5000\\\",\\\"X-RateLimit-Remaining\\\":\\\"0\\\"},\\\"limit_source\\\":\\\"openrouter_shared_capacity\\\"}}}\",\"success\":false}";

// Real capture: the free tier was retired and the upstream points at the paid
// slug, so asking again — on this credential or any sibling — changes nothing.
const UNSUPPORTED_FREE_500 =
  "[clinepass/deepseek/deepseek-v4-flash-0731:free] [500]: {\"error\":\"inference request failed: failed to invoke model 'deepseek/deepseek-v4-flash-0731:free' from Openrouter: request failed with status 404: {\\\"error\\\":{\\\"message\\\":\\\"This model is unavailable for free. The paid version is available now - use this slug instead: deepseek/deepseek-v4-flash-0731\\\",\\\"code\\\":404},\\\"user_id\\\":\\\"org_2ue3sRj4x3tXiJ1Dy2aaiheiHnm\\\"}\",\"success\":false}";

describe("checkFallbackError — every rotation-free class is actually gated", () => {
  it("a retired free tier does NOT burn the combo (was: fallback + 30s transient)", () => {
    // Regression: `unsupported_model` was classified and then dropped by the
    // gate, so the class existed in the policy table but was unreachable — the
    // single case the class was written to prevent (rotating over a model that
    // will never serve) kept happening, with a SHORTER cooldown than before.
    const result = checkFallbackError(500, UNSUPPORTED_FREE_500, 0);
    expect(result.applyCooldownOnly).toBe(true);
    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(30 * 60 * 1000);
  });

  it("a pooled throttle and a retired tier are both rotation-free", () => {
    for (const payload of [SHARED_POOL_500, UNSUPPORTED_FREE_500]) {
      const result = checkFallbackError(500, payload, 0);
      expect(result.shouldFallback, payload.slice(0, 40)).toBe(false);
      expect(result.applyCooldownOnly).toBe(true);
    }
  });

  it("applyCooldownOnly never arrives together with shouldFallback: true", () => {
    // The invariant auth.js and combo.js rely on, asserted across the classes.
    const payloads = [
      SHARED_POOL_500,
      UNSUPPORTED_FREE_500,
      DAILY_CAP_500,
      "rate limit exceeded",
      '{"retry_after_seconds":2}',
      "Internal Server Error",
      "context_length_exceeded"
    ];
    for (const [status, payload] of [
      [500, payloads[0]], [500, payloads[1]], [500, payloads[2]],
      [429, payloads[3]], [429, payloads[4]], [500, payloads[5]], [400, payloads[6]]
    ]) {
      const result = checkFallbackError(status, payload, 0);
      expect(
        result.shouldFallback && result.applyCooldownOnly,
        `${status} / ${payload.slice(0, 40)}`
      ).toBeFalsy();
    }
  });

  it("a literal 404 keeps its historical 2-minute per-model lock", () => {
    // A body marker must not promote a real 404 into the 30-minute
    // unsupported-model tier: the length of an existing lock is not something a
    // body marker gets to change.
    //
    // Note on discrimination: the pre-fix code reached this same 120000 through
    // the status rule. What the guard changes is the ROUTE, so assert the route's
    // fingerprint too — the structured block would have returned
    // `applyCooldownOnly`, and the policy table would have said 30 minutes.
    const withMarker = checkFallbackError(404, '{"limit_source":"upstream_provider_shared_pool"}', 0);
    expect(withMarker).toEqual({ shouldFallback: true, cooldownMs: 120000 });
    expect(withMarker.applyCooldownOnly).toBeUndefined();

    expect(checkFallbackError(404, "The model `gpt-9` does not exist", 0)).toEqual({
      shouldFallback: true,
      cooldownMs: 120000
    });
  });
});

describe("checkFallbackError — a pooled throttle is settled from the upstream's own numbers", () => {
  it("uses the 5s upstream window instead of the 5-minute ladder ceiling", () => {
    // backoffLevel 9 is the observed worst case on the user's accounts; the old
    // ladder answered a 5s upstream window with a 300s lock at this level.
    const result = checkFallbackError(500, SHARED_POOL_500, 9);
    expect(result.applyCooldownOnly, "must not consume the other accounts").toBe(true);
    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(6000);
    expect(result.cooldownMs).toBeLessThan(60_000);
  });

  it("does not inflate the backoff ladder on a bounded upstream throttle", () => {
    const result = checkFallbackError(500, SHARED_POOL_500, 9);
    expect(result.newBackoffLevel).toBe(9);
  });

  it("a daily credential cap stays rotatable (separate accounts own separate days)", () => {
    const result = checkFallbackError(500, DAILY_CAP_500, 9);
    expect(result.shouldFallback).toBe(true);
    expect(result.applyCooldownOnly).toBeUndefined();
    expect(result.cooldownMs).toBeGreaterThan(0);
    expect(result.newBackoffLevel).toBe(9);
  });
});

// ── The real call site: markAccountUnavailable (src/sse/services/auth.js) ───
const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

describe("markAccountUnavailable — pooled throttle stops rotation but still records the wait", () => {
  // Three credentials at the ladder ceiling, exactly as observed live.
  const ACCOUNTS = [
    { id: "acc-bkp", provider: "clinepass", name: "bkp", backoffLevel: 15 },
    { id: "acc-hermes", provider: "clinepass", name: "Hermes", backoffLevel: 15 },
    { id: "acc-oauth", provider: "clinepass", name: "scursel", backoffLevel: 15 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getProviderConnections.mockResolvedValue(ACCOUNTS);
    dbMocks.updateProviderConnection.mockResolvedValue(undefined);
  });

  // Mirrors chat.js: the loop continues to the next account ONLY while
  // shouldFallback is true.
  async function simulateComboLoop(status, errorText, model) {
    const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
    let tried = 0;
    for (const acc of ACCOUNTS) {
      tried++;
      const { shouldFallback } = await markAccountUnavailable(
        acc.id, status, errorText, "clinepass", model
      );
      if (!shouldFallback) break;
    }
    return tried;
  }

  it("a pooled throttle does not burn the two sibling accounts (was 3 attempts)", async () => {
    const tried = await simulateComboLoop(500, SHARED_POOL_500, "z-ai/glm-5.2:free");
    expect(tried).toBe(1);
  });

  it("the account is still paused for the upstream's window, not hammered", async () => {
    await simulateComboLoop(500, SHARED_POOL_500, "z-ai/glm-5.2:free");
    expect(dbMocks.updateProviderConnection).toHaveBeenCalledTimes(1);

    const [, update] = dbMocks.updateProviderConnection.mock.calls[0];
    const lockKey = Object.keys(update).find((k) => k.startsWith("modelLock_"));
    expect(lockKey).toBe("modelLock_z-ai/glm-5.2:free");

    const lockUntilMs = new Date(update[lockKey]).getTime() - Date.now();
    // Bounded by the upstream window (~6s), nowhere near the old 300s ceiling.
    expect(lockUntilMs).toBeGreaterThan(0);
    expect(lockUntilMs).toBeLessThan(60_000);
    expect(update.backoffLevel, "ladder must not escalate").toBe(15);
  });

  it("a daily credential cap still rotates through the other accounts", async () => {
    const tried = await simulateComboLoop(500, DAILY_CAP_500, "thinkingmachines/inkling:free");
    expect(tried).toBe(ACCOUNTS.length);
    // Discriminating assertion: rotating is only useful if each credential gets
    // its own bounded cooldown written. A loop that "rotated" without recording
    // anything would satisfy the count above and hammer the upstream.
    expect(dbMocks.updateProviderConnection).toHaveBeenCalledTimes(ACCOUNTS.length);
    for (const [, update] of dbMocks.updateProviderConnection.mock.calls) {
      const lockUntil = new Date(update[Object.keys(update).find((k) => k.startsWith("modelLock_"))]).getTime();
      expect(lockUntil).toBeGreaterThan(Date.now());
    }
  });

  it("a retired free tier does not walk the combo at all", async () => {
    const tried = await simulateComboLoop(500, UNSUPPORTED_FREE_500, "deepseek/deepseek-v4-flash-0731:free");
    expect(tried).toBe(1);
    expect(dbMocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const [, update] = dbMocks.updateProviderConnection.mock.calls[0];
    const lockKey = Object.keys(update).find((k) => k.startsWith("modelLock_"));
    const lockUntilMs = new Date(update[lockKey]).getTime() - Date.now();
    // The 30-minute tier, not the 30-second transient default.
    expect(lockUntilMs).toBeGreaterThan(29 * 60 * 1000);
  });
});