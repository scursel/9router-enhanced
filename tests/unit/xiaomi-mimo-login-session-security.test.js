/**
 * Security invariants of the server-assisted MiMo login proxy
 * (src/lib/mimoLoginSession.js):
 *  - credentials bound to 9router's own origin are never forwarded upstream
 *  - upstream Set-Cookie is never replayed onto the app's own cookie jar
 */
import { createHmac } from "node:crypto";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getMimoAccountCookie } from "../../open-sse/shared/mimoAccount.js";
import { describe, it, expect, afterEach, vi } from "vitest";

const TEST_SECRET = "unit-test-only-mimo-session-secret";
vi.stubEnv("JWT_SECRET", TEST_SECRET);
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      const headers = new Headers(init.headers);
      return {
        status: init.status || 200,
        headers,
        cookies: { set(name, value, options = {}) {
          headers.append("Set-Cookie", `${name}=${value}; Path=${options.path || "/"}; HttpOnly; SameSite=${options.sameSite || "lax"}${options.secure ? "; Secure" : ""}${options.maxAge === undefined ? "" : `; Max-Age=${options.maxAge}`}`);
        } },
        json: async () => body,
      };
    },
  },
}));
const { __test__, absorbSetCookies, attachSessionCookie, beginSession, decodeSessionCookie, encodeSessionCookie, loginUpstreamFetch, proxyAccountRequest } = await import("../../src/lib/mimoLoginSession.js");
const { POST: startLogin } = await import("../../src/app/api/oauth/xiaomi-mimo/login/start/route.js");
const { GET: loginStatus } = await import("../../src/app/api/oauth/xiaomi-mimo/login/status/route.js");
const { STRIP_UPSTREAM_HEADERS, buildBrowserResponse } = __test__;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const signedSession = (claims, { issuer = "9router", audience = "mimo-login-session" } = {}) => {
  const expiresAt = claims.t + 15 * 60_000;
  const payload = btoa(JSON.stringify({
    ...claims,
    iss: issuer,
    aud: audience,
    e: expiresAt,
    iat: Math.floor(claims.t / 1000),
    exp: Math.floor(expiresAt / 1000),
  })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const signature = createHmac("sha256", TEST_SECRET).update(`v3.${payload}`).digest("base64url");
  return `v3.${payload}.${signature}`;
};

const validClaims = () => ({
  s: "session-state",
  r: "sgp",
  t: Date.now(),
  p: "",
  j: [],
  purpose: "mimo-login-session",
});

describe("mimo login proxy security", () => {
  it("rejects tampering with proxy URL or cookie jar in the signed session", async () => {
    const sess = beginSession("sgp");
    sess.proxyUrl = "http://127.0.0.1:7890";
    sess.jar.set("passToken|account.xiaomi.com|/", {
      name: "passToken", value: "trusted-token", domain: "account.xiaomi.com", path: "/",
    });
    const cookie = await encodeSessionCookie(sess);
    const [, payloadPart, signature] = /^v3\.([^.]+)\.([^.]+)$/.exec(cookie);
    for (const [key, value] of [["p", "http://attacker.example:8080"], ["j", []]]) {
      const payload = JSON.parse(atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - payloadPart.length % 4) % 4)));
      payload[key] = value;
      const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(await decodeSessionCookie(`v3.${encoded}.${signature}`)).toBeNull();
    }
  });

  it("rejects unsigned legacy formats and requires the login-session purpose", async () => {
    const payload = btoa(JSON.stringify(validClaims())).replace(/=+$/, "");
    expect(await decodeSessionCookie(`v1.${encodeURIComponent(JSON.stringify(validClaims()))}`)).toBeNull();
    expect(await decodeSessionCookie(`v2.${payload}`)).toBeNull();
    expect(await decodeSessionCookie(`${signedSession({ ...validClaims(), purpose: "dashboard-auth" })}`)).toBeNull();
    expect(await decodeSessionCookie(signedSession(validClaims(), { issuer: "other" }))).toBeNull();
    expect(await decodeSessionCookie(signedSession(validClaims(), { audience: "other" }))).toBeNull();
  });

  it("rejects expired, future-dated, and structurally invalid session claims", async () => {
    expect(await decodeSessionCookie(signedSession({ ...validClaims(), t: Date.now() - 16 * 60 * 1000 }))).toBeNull();
    expect(await decodeSessionCookie(signedSession({ ...validClaims(), t: Date.now() + 60_000 }))).toBeNull();
    expect(await decodeSessionCookie(signedSession({ ...validClaims(), j: "not-a-cookie-jar" }))).toBeNull();
  });

  it("emits Secure for direct HTTPS, forwarded HTTPS and origin-string cookies", async () => {
    const sess = beginSession("cn");
    const response = new Response("ok");
    const directHttps = await attachSessionCookie(response, sess, new Request("https://localhost/"));
    const https = await attachSessionCookie(response, sess, new Request("http://localhost/", { headers: { "x-forwarded-proto": "https, http" } }));
    const httpsOrigin = await attachSessionCookie(response, sess, "https://localhost:20131");
    const http = await attachSessionCookie(response, sess, new Request("http://localhost/"));
    expect(directHttps.headers.getSetCookie()[0]).toContain("; Secure;");
    expect(https.headers.getSetCookie()[0]).toContain("; Secure;");
    expect(httpsOrigin.headers.getSetCookie()[0]).toContain("; Secure;");
    expect(http.headers.getSetCookie()[0]).not.toContain("Secure");
  });

  it("rejects lookalike SSO and page redirect URLs before following upstream", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://account.xiaomi.com.attacker.example/pass/serviceLogin" },
    }));
    const response = await startLogin(new Request("http://localhost/api/oauth/xiaomi-mimo/login/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ region: "sgp" }),
    }));
    expect(response.status).toBe(502);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(upstreamFetch.mock.calls[0][0]).toContain("mimo-server-sgp");
  });

  it.each([
    "https://account.xiaomi.com.attacker.example/fe/service/login",
    "https://user@account.xiaomi.com/fe/service/login",
    "https://account.xiaomi.com:443/fe/service/login",
    "\\\\account.xiaomi.com:443/fe/service/login",
    "http://account.xiaomi.com/fe/service/login",
    "//account.xiaomi.com/fe/service/login",
  ])("rejects unsafe SPA redirect %s", async (pageLoc) => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://account.xiaomi.com/pass/serviceLogin" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: pageLoc } }));
    const response = await startLogin(new Request("http://localhost/api/oauth/xiaomi-mimo/login/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ region: "cn" }),
    }));
    expect(response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses a valid configured egress proxy ahead of local detection", async () => {
    vi.stubEnv("MIMO_LOGIN_PROXY", "http://proxy.example:7890");
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    proxyAwareFetch
      .mockResolvedValueOnce(new Response(null, {
        status: 302, headers: { location: "https://account.xiaomi.com/pass/serviceLogin" },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302, headers: { location: "https://account.xiaomi.com/fe/service/login" },
      }));
    const response = await startLogin(new Request("https://localhost/api/oauth/xiaomi-mimo/login/start", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ region: "sgp" }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()[0]).toContain("Secure");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(proxyAwareFetch.mock.calls[0][2]).toMatchObject({ enabled: true, strictProxy: true, url: "http://proxy.example:7890/" });
    expect(proxyAwareFetch.mock.calls[1][2]).toMatchObject({ enabled: true, strictProxy: true, url: "http://proxy.example:7890/" });
  });

  it("keeps CN cluster direct even when a proxy is configured", async () => {
    vi.stubEnv("MIMO_LOGIN_PROXY", "http://proxy.example:7890");
    const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {
      status: 302, headers: { location: "https://account.xiaomi.com.attacker.example/pass/serviceLogin" },
    }));
    const response = await startLogin(new Request("http://localhost/api/oauth/xiaomi-mimo/login/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ region: "cn" }),
    }));
    expect(response.status).toBe(502);
    expect(globalFetch).toHaveBeenCalledOnce();
    expect(globalFetch.mock.calls[0][0]).toContain("mimo-server-cn");
  });

  it("rejects invalid configured proxy without probing or connecting direct", async () => {
    vi.stubEnv("MIMO_LOGIN_PROXY", "not-a-valid-proxy-url");
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const response = await startLogin(new Request("http://localhost/api/oauth/xiaomi-mimo/login/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ region: "sgp" }),
    }));
    expect(response.status).toBe(500);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("does not fall back direct after a valid explicitly configured proxy fails", async () => {
    vi.stubEnv("MIMO_LOGIN_PROXY", "http://proxy.example:7890");
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    proxyAwareFetch.mockRejectedValue(new Error("proxy connection failed"));
    const response = await startLogin(new Request("http://localhost/api/oauth/xiaomi-mimo/login/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ region: "sgp" }),
    }));
    expect(response.status).toBe(500);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("does not clear an HTTPS one-shot session cookie without Secure", async () => {
    const sess = beginSession("cn");
    sess.jar.set("passToken|account.xiaomi.com|/", { name: "passToken", value: "pt", domain: "account.xiaomi.com", path: "/" });
    const cookie = await encodeSessionCookie(sess);
    const response = await loginStatus(new Request("https://localhost/api/oauth/xiaomi-mimo/login/status?state=" + sess.state, {
      headers: { cookie: `9r_mimo_login=${cookie}`, "x-forwarded-proto": "https" },
    }));
    expect(response.headers.getSetCookie().some((entry) => entry.includes("Max-Age=0") && entry.includes("Secure"))).toBe(true);
  });

  it.each([
    "http://account.xiaomi.com/pass/continue",
    "https://account.xiaomi.com:8443/pass/continue",
    "https://user@account.xiaomi.com/pass/continue",
  ])("refuses unsafe account redirect authority %s before forwarding jar cookies", async (location) => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location },
    }));
    const sess = beginSession("cn");
    sess.jar.set("passToken|account.xiaomi.com|/", {
      name: "passToken", value: "fixture-xiaomi-token", domain: "account.xiaomi.com", path: "/", hostOnly: true,
    });
    const req = new Request("https://router.example/fe/service/login", { headers: { host: "router.example" } });

    await proxyAccountRequest(sess, req, "https://router.example");

    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it("does not log sensitive SSO response bodies on failed service login", async () => {
    const logger = vi.spyOn(console, "log").mockImplementation(() => {});
    const secretBody = `&&&START&&&${JSON.stringify({ code: 401, ssecurity: "fixture-ssecurity-secret", nonce: 123, notificationUrl: "https://account.xiaomi.com/callback?token=fixture-query-secret" })}`;
    vi.mocked(proxyAwareFetch).mockResolvedValue(new Response(secretBody, {
      status: 401,
      headers: { "content-type": "application/json" },
    }));

    await getMimoAccountCookie({ mimoPassToken: "fixture-pass-token", region: "cn" });

    const logged = logger.mock.calls.flat().join(" ");
    expect(logged).not.toContain("fixture-ssecurity-secret");
    expect(logged).not.toContain("fixture-query-secret");
    expect(logged).not.toContain(secretBody);
  });

  it("does not accept Domain=com cookies from account.xiaomi.com", async () => {
    const upstream = new Response("ok", { headers: { "set-cookie": "passToken=fixture-cross-host; Domain=com; Path=/" } });
    const sess = beginSession("cn");

    absorbSetCookies(sess, upstream, "https://account.xiaomi.com/pass/serviceLogin");

    expect([...sess.jar.values()]).toEqual([]);
  });

  it("does not select account host-only cookies for the MiMo service host", () => {
    const sess = beginSession("sgp");
    sess.jar.set("passToken|account.xiaomi.com|/", {
      name: "passToken", value: "fixture-account-token", domain: "account.xiaomi.com", path: "/", hostOnly: true,
    });

    expect(__test__.cookieHeaderFor(sess, "https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions")).toBe("");
  });

  it("rejects an explicit default port on a regional MiMo redirect", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "https://mimo-server-cn.xiaomimimo.com:443/api/user/xiaomi/me" },
    }));
    const sess = beginSession("cn");
    const req = new Request("https://router.example/fe/service/login", { headers: { host: "router.example" } });

    const response = await proxyAccountRequest(sess, req, "https://router.example");

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it("rejects a backslash-normalized account redirect", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: String.raw`\\account.xiaomi.com:443/account-backslash-secret` },
    }));
    const sess = beginSession("cn");
    const req = new Request("https://router.example/fe/service/login", { headers: { host: "router.example" } });

    const response = await proxyAccountRequest(sess, req, "https://router.example");

    expect(response.status).toBe(502);
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it("rejects a backslash-normalized regional MiMo redirect", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: String.raw`https:\\mimo-server-cn.xiaomimimo.com:443/backslash-port-should-not-be-fetched` },
    }));
    const sess = beginSession("cn");
    const req = new Request("https://router.example/fe/service/login", { headers: { host: "router.example" } });

    const response = await proxyAccountRequest(sess, req, "https://router.example");

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it("does not pass unapproved cross-host redirects through to the browser", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "https://account.xiaomi.com.attacker.example/callback?state=secret" },
    }));
    const sess = beginSession("cn");
    const req = new Request("https://router.example/fe/service/login", { headers: { host: "router.example" } });

    const response = await proxyAccountRequest(sess, req, "https://router.example");

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refreshes the Xiaomi cookie jar between same-host redirect hops", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: {
          location: "https://account.xiaomi.com/pass/continue",
          "set-cookie": "stepToken=fixture-next-hop; Domain=account.xiaomi.com; Path=/",
        },
      }))
      .mockResolvedValueOnce(new Response("ok", { headers: { "content-type": "text/plain" } }));
    const sess = beginSession("cn");
    const req = new Request("https://router.example/fe/service/login", { headers: { host: "router.example" } });

    await proxyAccountRequest(sess, req, "https://router.example");

    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(new Headers(upstreamFetch.mock.calls[0][1].headers).get("cookie")).toBeNull();
    expect(new Headers(upstreamFetch.mock.calls[1][1].headers).get("cookie")).toBe("stepToken=fixture-next-hop");
  });

  it("follows protocol-relative redirects to the exact secure account host", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "//account.xiaomi.com/pass/continue" } }))
      .mockResolvedValueOnce(new Response("ok", { headers: { "content-type": "text/plain" } }));
    const sess = beginSession("cn");
    const req = new Request("https://router.example/fe/service/login", { headers: { host: "router.example" } });

    await proxyAccountRequest(sess, req, "https://router.example");

    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(String(upstreamFetch.mock.calls[1][0])).toBe("https://account.xiaomi.com/pass/continue");
  });

  it("rejects account redirects with an explicit default port", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "https://account.xiaomi.com:443/pass/continue" },
    }));
    const sess = beginSession("cn");
    sess.jar.set("passToken|account.xiaomi.com|/", {
      name: "passToken", value: "fixture-xiaomi-token", domain: "account.xiaomi.com", path: "/", hostOnly: true,
    });
    const req = new Request("https://router.example/fe/service/login", { headers: { host: "router.example" } });

    const response = await proxyAccountRequest(sess, req, "https://router.example");

    expect(response.status).toBe(502);
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it("never forwards Xiaomi jar cookies to a downgraded HTTP account redirect", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "http://account.xiaomi.com/pass/continue" },
      }))
      .mockResolvedValueOnce(new Response("ok", { headers: { "content-type": "text/plain" } }));
    const sess = beginSession("cn");
    sess.jar.set("passToken|account.xiaomi.com|/", {
      name: "passToken", value: "fixture-xiaomi-token", domain: "account.xiaomi.com", path: "/", hostOnly: true,
    });
    const req = new Request("https://router.example/fe/service/login", { headers: { host: "router.example" } });

    await proxyAccountRequest(sess, req, "https://router.example");

    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(String(upstreamFetch.mock.calls[0][0])).toMatch(/^https:\/\/account\.xiaomi\.com\//);
    expect(new Headers(upstreamFetch.mock.calls[0][1].headers).get("cookie")).toBe("passToken=fixture-xiaomi-token");
    expect(upstreamFetch.mock.calls.every(([url]) => new URL(String(url)).protocol === "https:")).toBe(true);
  });

  it("does not forward 9router browser cookies when the upstream jar is empty", async () => {
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    const sess = beginSession("cn");
    const req = new Request("http://localhost:20128/fe/service/login", {
      headers: { cookie: "auth_token=router-session; 9r_mimo_login=encoded-session" },
    });

    await proxyAccountRequest(sess, req, "http://localhost:20128");

    expect(upstreamFetch).toHaveBeenCalledOnce();
    const forwardedHeaders = new Headers(upstreamFetch.mock.calls[0][1].headers);
    expect(forwardedHeaders.get("cookie")).toBeNull();
  });

  it("rewrites redirects from every configured MiMo cluster back through the proxy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://mimo-server-ams.xiaomimimo.com/api/login/callback" },
      }),
    );
    const sess = beginSession("ams");
    const req = new Request("http://localhost:20128/fe/service/login");

    const response = await proxyAccountRequest(sess, req, "http://localhost:20128");

    expect(response.headers.get("location")).toBe(
      "http://localhost:20128/__mimo_login/mimo/api/login/callback",
    );
  });

  it("strips auth credentials and session cookies before forwarding upstream", () => {
    for (const h of ["authorization", "proxy-authorization", "cookie", "host"]) {
      expect(STRIP_UPSTREAM_HEADERS.has(h)).toBe(true);
    }
  });

  it("does not replay upstream Set-Cookie onto the app origin", async () => {
    const upstream = new Response("ok", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "set-cookie": "userId=123; Path=/", // plain object header: visible via getSetCookie
      },
    });
    const out = await buildBrowserResponse({ jar: new Map() }, upstream, "http://localhost:20128", "/pass/");
    expect(out.headers.getSetCookie()).toEqual([]);
  });

  it("does not log upstream response bodies or query secrets on account errors", async () => {
    const logger = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ code: 401, message: "fixture-upstream-response-secret" }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    const sess = beginSession("cn");
    const req = new Request("https://router.example/pass/service/login?token=fixture-query-secret", {
      headers: { host: "router.example" },
    });

    await proxyAccountRequest(sess, req, "https://router.example");

    const logged = logger.mock.calls.flat().join(" ");
    expect(logged).not.toContain("fixture-upstream-response-secret");
    expect(logged).not.toContain("fixture-query-secret");
  });

  it("keeps ordinary response headers intact", async () => {
    const upstream = new Response("<html></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const out = await buildBrowserResponse({ jar: new Map() }, upstream, "http://localhost:20128", "/fe/");
    expect(out.status).toBe(200);
    expect(out.headers.get("content-type")).toBe("text/html");
  });
});
