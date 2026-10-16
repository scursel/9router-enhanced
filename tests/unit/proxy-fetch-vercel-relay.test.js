import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("proxyAwareFetch — Vercel relay", () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;

    for (const key of [
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "no_proxy",
      "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "CF_ACCESS_RELAY_HOSTS",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("preserves Headers instance values and relay metadata without CF Access env", async () => {
    const relayFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    // proxyFetch captures the native fetch at import time.
    globalThis.fetch = relayFetch;
    vi.resetModules();
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

    await proxyAwareFetch(
      "https://api.example.test/v1/messages?stream=true",
      {
        method: "POST",
        headers: new Headers({
          Authorization: "Bearer fixture-token",
          "Content-Type": "application/json",
        }),
        body: "{}",
      },
      { vercelRelayUrl: "https://relay.example/deploy" },
    );

    expect(relayFetch).toHaveBeenCalledOnce();
    const [relayUrl, relayOptions] = relayFetch.mock.calls[0];
    expect(relayUrl).toBe("https://relay.example/deploy");
    expect(relayOptions.headers).toMatchObject({
      authorization: "Bearer fixture-token",
      "content-type": "application/json",
      "x-relay-target": "https://api.example.test",
      "x-relay-path": "/v1/messages?stream=true",
    });
    expect(relayOptions.headers["CF-Access-Client-Id"]).toBeUndefined();
    expect(relayOptions.headers["CF-Access-Client-Secret"]).toBeUndefined();
    expect(relayOptions).toMatchObject({ method: "POST", body: "{}" });
  });

  it("includes CF-Access-Client-Id and CF-Access-Client-Secret when env vars are set for Cloudflare relays", async () => {
    process.env.CF_ACCESS_CLIENT_ID = "cf-id-123.access";
    process.env.CF_ACCESS_CLIENT_SECRET = "cf-secret-456";

    const relayFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = relayFetch;
    vi.resetModules();
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

    await proxyAwareFetch(
      "https://api.tokenharbor.test/v1/chat/completions",
      {
        method: "POST",
        redirect: "follow",
        headers: { Authorization: "Bearer th-key" },
        body: "{}",
      },
      { vercelRelayUrl: "https://relay-1a07d643fc4-2.scursel.workers.dev" },
    );

    expect(relayFetch).toHaveBeenCalledOnce();
    const [relayUrl, relayOptions] = relayFetch.mock.calls[0];
    expect(relayUrl).toBe("https://relay-1a07d643fc4-2.scursel.workers.dev");
    expect(relayOptions.redirect).toBe("manual");
    expect(relayOptions.headers).toMatchObject({
      Authorization: "Bearer th-key",
      "x-relay-target": "https://api.tokenharbor.test",
      "x-relay-path": "/v1/chat/completions",
      "CF-Access-Client-Id": "cf-id-123.access",
      "CF-Access-Client-Secret": "cf-secret-456",
    });
  });

  it("does not leak CF-Access credentials to non-Cloudflare PaaS relay hosts, trailing-dot hosts, unrelated workers.dev tenants, or plain HTTP", async () => {
    process.env.CF_ACCESS_CLIENT_ID = "cf-id-123.access";
    process.env.CF_ACCESS_CLIENT_SECRET = "cf-secret-456";

    const relayFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = relayFetch;
    vi.resetModules();
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

    const untrustedRelays = [
      "https://my-relay.vercel.app/api/relay",
      "https://my-relay.vercel.app./api/relay",
      "https://other-tenant.someone.workers.dev",
      "https://arbitrary.example.com/relay",
      "http://relay-1a07d643fc4-2.scursel.workers.dev",
    ];

    for (const vercelRelayUrl of untrustedRelays) {
      await proxyAwareFetch(
        "https://api.example.test/v1/chat/completions",
        { method: "POST", body: "{}" },
        { vercelRelayUrl },
      );
    }

    expect(relayFetch).toHaveBeenCalledTimes(untrustedRelays.length);
    for (const [, relayOptions] of relayFetch.mock.calls) {
      expect(relayOptions.headers["CF-Access-Client-Id"]).toBeUndefined();
      expect(relayOptions.headers["CF-Access-Client-Secret"]).toBeUndefined();
      expect(relayOptions.redirect).toBe("manual");
    }
  });

  it("respects custom CF_ACCESS_RELAY_HOSTS allowlist with trailing-dot normalization over HTTPS", async () => {
    process.env.CF_ACCESS_CLIENT_ID = "cf-id-123.access";
    process.env.CF_ACCESS_CLIENT_SECRET = "cf-secret-456";
    process.env.CF_ACCESS_RELAY_HOSTS = ".custom-relay.example.com";

    const relayFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = relayFetch;
    vi.resetModules();
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

    await proxyAwareFetch(
      "https://api.example.test/v1/chat/completions",
      { method: "POST", body: "{}" },
      { vercelRelayUrl: "https://edge.custom-relay.example.com./v1" },
    );

    expect(relayFetch).toHaveBeenCalledOnce();
    const [, relayOptions] = relayFetch.mock.calls[0];
    expect(relayOptions.headers["CF-Access-Client-Id"]).toBe("cf-id-123.access");
    expect(relayOptions.headers["CF-Access-Client-Secret"]).toBe("cf-secret-456");
  });

  it("throws an explicit error when the relay response is redirected to Cloudflare Access login", async () => {
    const fakeLoginResponse = {
      ok: false,
      status: 302,
      url: "https://relay-1a07d643fc4-2.scursel.workers.dev",
      headers: new Headers({
        location: "https://yellow-base-f94b.cloudflareaccess.com/cdn-cgi/access/login/relay-1a07d643fc4-2.scursel.workers.dev?kid=abc",
      }),
      body: { cancel: vi.fn() },
    };
    const relayFetch = vi.fn().mockResolvedValue(fakeLoginResponse);
    globalThis.fetch = relayFetch;
    vi.resetModules();
    const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

    await expect(
      proxyAwareFetch(
        "https://api.tokenharbor.test/v1/chat/completions",
        { method: "POST", body: "{}" },
        { vercelRelayUrl: "https://relay-1a07d643fc4-2.scursel.workers.dev" },
      )
    ).rejects.toThrow(/Cloudflare Access blocked relay request/);
    expect(fakeLoginResponse.body.cancel).toHaveBeenCalledOnce();
  });

  it("strips cf-access-* headers and CF_Authorization cookie in RELAY_WORKER_CODE while preserving upstream headers", async () => {
    const fs = await import("node:fs");
    const routeSrc = fs.readFileSync(
      new URL("../../src/app/api/proxy-pools/cloudflare-deploy/route.js", import.meta.url),
      "utf8"
    );
    const match = routeSrc.match(/const RELAY_WORKER_CODE = `([\s\S]*?)`;/);
    expect(match).toBeTruthy();

    const workerBody = match[1]
      .replace(/\\\\\//g, "\\/")
      .replace(/export default\s*\{/, "return {");
    const worker = new Function(workerBody)();

    const upstreamFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    globalThis.fetch = upstreamFetch;

    const req = new Request("https://relay-mtrmx7oe.scursel.workers.dev/", {
      method: "POST",
      headers: {
        "x-relay-target": "https://api.tokenharbor.test",
        "x-relay-path": "/v1/chat/completions",
        Authorization: "Bearer upstream-secret",
        "cf-access-client-id": "cf-id",
        "cf-access-client-secret": "cf-secret",
        "cf-access-jwt-assertion": "jwt-token",
        "cf-access-authenticated-user-identity": "svc-identity",
        Cookie: "CF_Authorization=jwt1; session=keepme; CF_Authorization=jwt2",
      },
      body: '{"hello":"world"}',
    });

    const res = await worker.fetch(req);
    expect(res.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = upstreamFetch.mock.calls[0];
    expect(calledUrl).toBe("https://api.tokenharbor.test/v1/chat/completions");
    expect(calledInit.headers.get("authorization")).toBe("Bearer upstream-secret");
    expect(calledInit.headers.get("cf-access-client-id")).toBeNull();
    expect(calledInit.headers.get("cf-access-client-secret")).toBeNull();
    expect(calledInit.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(calledInit.headers.get("cf-access-authenticated-user-identity")).toBeNull();
    expect(calledInit.headers.get("cookie")).toBe("session=keepme");
  });

  it("testVercelRelay rejects 204, text/plain, invalid JSON/array payloads, and Access redirects, and accepts valid 200 JSON", async () => {
    process.env.CF_ACCESS_CLIENT_ID = "cf-id-123.access";
    process.env.CF_ACCESS_CLIENT_SECRET = "cf-secret-456";

    const mockUndiciFetch = vi.fn();
    vi.resetModules();
    vi.doMock("@/models", () => ({ getProxyPoolById: vi.fn(), updateProxyPool: vi.fn() }));
    vi.doMock("@/lib/network/proxyTest", () => ({ testProxyUrl: vi.fn() }));

    const { testVercelRelay } = await import("../../src/app/api/proxy-pools/[id]/test/route.js");

    // 1. 204 No Content -> rejected
    mockUndiciFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      statusText: "No Content",
      url: "https://relay-1a07d643fc4-2.scursel.workers.dev",
      headers: new Headers(),
      body: { cancel: vi.fn() },
    });
    const r204 = await testVercelRelay("https://relay-1a07d643fc4-2.scursel.workers.dev", 10000, mockUndiciFetch);
    expect(r204.ok).toBe(false);
    expect(r204.error).toMatch(/status 204/);

    // 2. 200 text/plain -> rejected
    mockUndiciFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://relay-1a07d643fc4-2.scursel.workers.dev",
      headers: new Headers({ "content-type": "text/plain" }),
      body: { cancel: vi.fn() },
    });
    const rPlain = await testVercelRelay("https://relay-1a07d643fc4-2.scursel.workers.dev", 10000, mockUndiciFetch);
    expect(rPlain.ok).toBe(false);
    expect(rPlain.error).toMatch(/unexpected content-type/);

    // 3. 302 Access login redirect -> rejected
    mockUndiciFetch.mockResolvedValueOnce({
      ok: false,
      status: 302,
      statusText: "Found",
      url: "https://relay-1a07d643fc4-2.scursel.workers.dev",
      headers: new Headers({
        location: "https://yellow-base-f94b.cloudflareaccess.com/cdn-cgi/access/login/...",
      }),
      body: { cancel: vi.fn() },
    });
    const r302 = await testVercelRelay("https://relay-1a07d643fc4-2.scursel.workers.dev", 10000, mockUndiciFetch);
    expect(r302.ok).toBe(false);
    expect(r302.error).toMatch(/Cloudflare Access/);

    // 4. 200 application/json with invalid/array JSON payload -> rejected
    mockUndiciFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://relay-1a07d643fc4-2.scursel.workers.dev",
      headers: new Headers({ "content-type": "application/json" }),
      json: vi.fn().mockResolvedValue([1, 2, 3]),
    });
    const rArray = await testVercelRelay("https://relay-1a07d643fc4-2.scursel.workers.dev", 10000, mockUndiciFetch);
    expect(rArray.ok).toBe(false);
    expect(rArray.error).toMatch(/invalid JSON payload/);

    // 5. 200 application/json with valid JSON object -> accepted
    mockUndiciFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://relay-1a07d643fc4-2.scursel.workers.dev",
      headers: new Headers({ "content-type": "application/json" }),
      json: vi.fn().mockResolvedValue({ url: "https://httpbin.org/get", headers: {} }),
    });
    const r200 = await testVercelRelay("https://relay-1a07d643fc4-2.scursel.workers.dev", 10000, mockUndiciFetch);
    expect(r200.ok).toBe(true);
    expect(r200.status).toBe(200);
  });
});