// The shared OIDC helpers default to the global fetch (start/callback behaviour
// unchanged) but must honour an injected fetch so the settings test route can
// pass the SSRF guard's redirect-safe fetchPublic.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));

const { fetchOidcDiscovery, probeOidcClientSecret } = await import("../../src/lib/auth/oidc.js");

describe("fetchOidcDiscovery fetchImpl", () => {
  it("uses the provided fetch implementation instead of global fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://idp.example.com",
        token_endpoint: "https://idp.example.com/token",
      }),
    });

    const discovery = await fetchOidcDiscovery("https://idp.example.com/", { fetchImpl });

    expect(discovery.issuer).toBe("https://idp.example.com");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://idp.example.com/.well-known/openid-configuration",
      { cache: "no-store" }
    );
  });

  it("still rejects a non-ok discovery response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await expect(fetchOidcDiscovery("https://idp.example.com", { fetchImpl })).rejects.toThrow(
      /Failed to load OIDC discovery/
    );
  });
});

describe("probeOidcClientSecret fetchImpl", () => {
  it("uses the provided fetch implementation for the token POST", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant", error_description: "bad code" }),
    });

    const result = await probeOidcClientSecret({
      tokenEndpoint: "https://idp.example.com/token",
      clientId: "client-1",
      clientSecret: "fake-secret",
      redirectUri: "https://dashboard.example.com/api/auth/oidc/callback",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://idp.example.com/token",
      expect.objectContaining({ method: "POST" })
    );
    expect(result).toMatchObject({ tested: true, valid: true });
  });

  it("skips the fetch entirely when no secret is provided", async () => {
    const fetchImpl = vi.fn();

    const result = await probeOidcClientSecret({
      tokenEndpoint: "https://idp.example.com/token",
      clientId: "client-1",
      clientSecret: "",
      redirectUri: "https://dashboard.example.com/api/auth/oidc/callback",
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.tested).toBe(false);
  });
});
