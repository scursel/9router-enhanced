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

  it("preserves Headers instance values and relay metadata", async () => {
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
    expect(relayOptions).toMatchObject({ method: "POST", body: "{}" });
  });
});