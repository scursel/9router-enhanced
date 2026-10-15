/**
 * refreshNousToken — failure classification (F26/RH3 discipline).
 *
 * A 400 invalid_grant means the refresh token is dead/rotated: the refresher
 * must return a classified sentinel (recognised by isUnrecoverableRefreshError)
 * so the pipeline never treats it as transient and re-POSTs the dead token.
 * 5xx / network errors stay plain `null` (transient). Same convention as
 * refreshCodexToken / refreshMiniMaxCodeToken.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

function res(status, payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(typeof payload === "string" ? JSON.parse(payload) : payload),
    text: () => Promise.resolve(text),
  };
}

let seq = 0;
const freshRt = () => `rt_fake_${++seq}_xxx`; // unique per test: dedupRefresh caches by token

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

async function load() {
  const providers = await import("open-sse/services/tokenRefresh/providers.js");
  const svc = await import("open-sse/services/tokenRefresh.js");
  return { refreshNousToken: providers.refreshNousToken, isUnrecoverableRefreshError: svc.isUnrecoverableRefreshError };
}

describe("refreshNousToken", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { global.fetch = originalFetch; });

  it("400 invalid_grant -> classified unrecoverable sentinel, not null", async () => {
    const fm = vi.fn().mockResolvedValue(
      res(400, { error: "invalid_grant", error_description: "Refresh token has been used" }),
    );
    global.fetch = fm;
    const { refreshNousToken, isUnrecoverableRefreshError } = await load();
    const log = makeLog();
    const rt = freshRt();

    const out = await refreshNousToken(rt, log);

    expect(out).not.toBeNull();
    expect(isUnrecoverableRefreshError(out)).toBe(true);
    expect(out.accessToken).toBeUndefined();
    expect(fm).toHaveBeenCalledTimes(1); // no agent-key mint after a failed token call
    // never leak the refresh token into logs
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(rt);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(rt);
  });

  it("other permanent markers (refresh_token_reused) are also classified", async () => {
    global.fetch = vi.fn().mockResolvedValue(res(401, { error: "refresh_token_reused" }));
    const { refreshNousToken, isUnrecoverableRefreshError } = await load();
    expect(isUnrecoverableRefreshError(await refreshNousToken(freshRt(), makeLog()))).toBe(true);
  });

  it("400 with an unrelated error (not a dead-token marker) stays transient null", async () => {
    global.fetch = vi.fn().mockResolvedValue(res(400, { error: "temporarily_unavailable" }));
    const { refreshNousToken } = await load();
    expect(await refreshNousToken(freshRt(), makeLog())).toBeNull();
  });

  it("500 -> null (transient)", async () => {
    global.fetch = vi.fn().mockResolvedValue(res(500, "upstream exploded"));
    const { refreshNousToken } = await load();
    expect(await refreshNousToken(freshRt(), makeLog())).toBeNull();
  });

  it("network error -> null (transient)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const { refreshNousToken } = await load();
    expect(await refreshNousToken(freshRt(), makeLog())).toBeNull();
  });

  it("missing refresh token -> null without calling fetch", async () => {
    const fm = vi.fn();
    global.fetch = fm;
    const { refreshNousToken } = await load();
    expect(await refreshNousToken("", makeLog())).toBeNull();
    expect(fm).not.toHaveBeenCalled();
  });

  it("success path unchanged: rotates tokens and mints an agent key", async () => {
    const fm = vi.fn()
      .mockResolvedValueOnce(res(200, { access_token: "at_fake_1", refresh_token: "rt_fake_rotated", expires_in: 3600 }))
      .mockResolvedValueOnce(res(200, { api_key: "ak_fake_1", key_id: "kid_1", expires_at: "2099-01-01T00:00:00Z" }));
    global.fetch = fm;
    const { refreshNousToken, isUnrecoverableRefreshError } = await load();
    const rt = freshRt();

    const out = await refreshNousToken(rt, makeLog());

    expect(isUnrecoverableRefreshError(out)).toBe(false);
    expect(out.accessToken).toBe("at_fake_1");
    expect(out.refreshToken).toBe("rt_fake_rotated");
    expect(out.expiresIn).toBe(3600);
    expect(out.apiKey).toBe("ak_fake_1");
    expect(out.providerSpecificData).toEqual({ agentKeyId: "kid_1", agentKeyExpiresAt: "2099-01-01T00:00:00Z" });
    expect(fm).toHaveBeenCalledTimes(2);
  });

  it("success without agent key falls back to access_token as apiKey", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(res(200, { access_token: "at_fake_2", expires_in: 60 }))
      .mockResolvedValueOnce(res(503, "nope"));
    const { refreshNousToken } = await load();
    const rt = freshRt();
    const out = await refreshNousToken(rt, makeLog());
    expect(out.apiKey).toBe("at_fake_2");
    expect(out.refreshToken).toBe(rt);
  });
});
