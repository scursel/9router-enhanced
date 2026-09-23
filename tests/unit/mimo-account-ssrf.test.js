import { afterEach, describe, expect, it, vi } from "vitest";
const TEST_SECRET = "unit-test-only-mimo-ssrf";

vi.stubEnv("JWT_SECRET", TEST_SECRET);
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
const { getMimoAccountCookie, invalidateMimoAccountCookieCache } = await import("../../open-sse/shared/mimoAccount.js");

afterEach(() => {
  vi.restoreAllMocks();
  invalidateMimoAccountCookieCache();
});

describe("MiMo account SSO redirect confinement", () => {
  it("does not send clientSign to a serviceLogin location on an unapproved host", async () => {
    const raw = `&&&START&&&${JSON.stringify({
      code: 0,
      location: "https://attacker.example/collect",
      nonce: 123,
      ssecurity: "fixture-ss",
    })}`;
    proxyAwareFetch.mockResolvedValueOnce(new Response(raw, {
      status: 200,
      headers: { "set-cookie": "", "content-type": "application/json" },
    }));

    const result = await getMimoAccountCookie({ mimoPassToken: "fixture-pass-token", region: "cn" });

    expect(result).toBeNull();
    expect(proxyAwareFetch).toHaveBeenCalledOnce();
    expect(String(proxyAwareFetch.mock.calls[0][0])).toBe("https://account.xiaomi.com/pass/serviceLogin?_locale=zh_CN&_snsNone=true&sid=mimopc&_json=true");
  });

  it("rejects a protocol-relative redirect with an explicit default port", async () => {
    const raw = `&&&START&&&${JSON.stringify({
      code: 0,
      location: "https://account.xiaomi.com/pass/continue",
      nonce: 123,
      ssecurity: "fixture-ss",
    })}`;
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(raw, {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "//account.xiaomi.com:443/explicit-port-should-not-be-fetched" },
      }));

    const result = await getMimoAccountCookie({ mimoPassToken: "fixture-pass-token", region: "cn" });

    expect(result).toBeNull();
    expect(proxyAwareFetch.mock.calls.some(([url]) => String(url).includes("explicit-port-should-not-be-fetched"))).toBe(false);
  });

  it("rejects backslash-normalized explicit-port redirects", async () => {
    const raw = `&&&START&&&${JSON.stringify({
      code: 0,
      location: "https://account.xiaomi.com/pass/continue",
      nonce: 123,
      ssecurity: "fixture-ss",
    })}`;
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(raw, { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: String.raw`\\account.xiaomi.com:443/backslash-port-should-not-be-fetched` },
      }));

    const result = await getMimoAccountCookie({ mimoPassToken: "fixture-pass-token", region: "cn" });

    expect(result).toBeNull();
    expect(proxyAwareFetch.mock.calls.some(([url]) => String(url).includes("backslash-port-should-not-be-fetched"))).toBe(false);
  });

  it("rejects whitespace-wrapped signed SSO locations", async () => {
    const raw = `&&&START&&&${JSON.stringify({
      code: 0,
      location: " https://account.xiaomi.com/pass/whitespace-secret \n",
      nonce: 123,
      ssecurity: "fixture-ss",
    })}`;
    proxyAwareFetch.mockResolvedValueOnce(new Response(raw, { status: 200, headers: { "content-type": "application/json" } }));

    const result = await getMimoAccountCookie({ mimoPassToken: "fixture-pass-token", region: "cn" });

    expect(result).toBeNull();
    expect(proxyAwareFetch.mock.calls.some(([url]) => String(url).includes("whitespace-secret"))).toBe(false);
  });

  it("does not follow a post-signature redirect to an unapproved host", async () => {
    const raw = `&&&START&&&${JSON.stringify({
      code: 0,
      location: "https://account.xiaomi.com/pass/continue",
      nonce: 123,
      ssecurity: "fixture-ss",
    })}`;
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(raw, {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/collect" },
      }));

    const result = await getMimoAccountCookie({ mimoPassToken: "fixture-pass-token", region: "cn" });

    expect(result).toBeNull();
    expect(proxyAwareFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(proxyAwareFetch.mock.calls.every(([url]) => new URL(String(url)).hostname === "account.xiaomi.com")).toBe(true);
    expect(proxyAwareFetch.mock.calls.some(([url]) => new URL(String(url)).hostname === "attacker.example")).toBe(false);
  });
});
