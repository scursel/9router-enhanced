// /api/auth/oidc/test — stored-secret scoping + SSRF guard.
//
// (a) The stored oidcClientSecret may only be sent to the issuer configured in
//     settings.oidcIssuerUrl. A caller-chosen issuer with no clientSecret in the
//     body must never receive the stored secret.
// (b) The discovery token_endpoint must be https (real IdPs legitimately use a
//     different host for it, e.g. Google accounts.google.com ->
//     oauth2.googleapis.com, so same-origin is too strict) and must pass the
//     shared SSRF guard.
// (c) The issuer itself must pass the same resolved-address SSRF guard before
//     discovery is fetched.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn(
    (body, init = {}) =>
      new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      })
  ),
  cookies: vi.fn(),
  getSettings: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  fetchOidcDiscovery: vi.fn(),
  probeOidcClientSecret: vi.fn(),
  getPublicOrigin: vi.fn(() => "https://dashboard.example.com"),
  assertPublicUrlResolved: vi.fn(),
  fetchPublic: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));
vi.mock("@/lib/auth/oidc", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchOidcDiscovery: mocks.fetchOidcDiscovery,
    probeOidcClientSecret: mocks.probeOidcClientSecret,
    getPublicOrigin: mocks.getPublicOrigin,
  };
});
vi.mock("@/shared/utils/ssrfGuard.js", () => ({
  assertPublicUrlResolved: mocks.assertPublicUrlResolved,
  fetchPublic: mocks.fetchPublic,
}));

const { POST } = await import("../../src/app/api/auth/oidc/test/route.js");

const SETTINGS = {
  requireLogin: false,
  oidcIssuerUrl: "https://idp.example.com/",
  oidcClientId: "client-1",
  oidcClientSecret: "stored-secret-value",
  oidcScopes: "openid profile email",
};

const DISCOVERY = {
  issuer: "https://idp.example.com",
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://oauth2.idp.example.com/token",
  jwks_uri: "https://idp.example.com/jwks",
};

async function post(body) {
  const response = await POST(
    new Request("https://dashboard.example.com/api/auth/oidc/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ ...SETTINGS });
  mocks.fetchOidcDiscovery.mockResolvedValue({ ...DISCOVERY });
  mocks.probeOidcClientSecret.mockResolvedValue({ tested: true, valid: true, message: "ok" });
  mocks.assertPublicUrlResolved.mockReset();
  mocks.assertPublicUrlResolved.mockResolvedValue(undefined);
});

describe("stored client secret is scoped to the configured issuer", () => {
  it("does NOT send the stored secret to a different issuer", async () => {
    await post({ issuerUrl: "https://evil.example.net" });

    expect(mocks.probeOidcClientSecret).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: "" })
    );
  });

  it("does NOT send the stored secret when the issuer path differs", async () => {
    await post({ issuerUrl: "https://idp.example.com/tenant" });

    expect(mocks.probeOidcClientSecret).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: "" })
    );
  });

  it("does NOT send the stored secret when no issuer is configured", async () => {
    mocks.getSettings.mockResolvedValue({ ...SETTINGS, oidcIssuerUrl: "" });

    await post({ issuerUrl: "https://idp.example.com" });

    expect(mocks.probeOidcClientSecret).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: "" })
    );
  });

  it("uses the stored secret for the configured issuer, ignoring trailing slash and host case", async () => {
    await post({ issuerUrl: "https://IDP.EXAMPLE.COM" });

    expect(mocks.probeOidcClientSecret).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: "stored-secret-value" })
    );
  });

  it("uses a caller-supplied secret for a different issuer", async () => {
    await post({ issuerUrl: "https://evil.example.net", clientSecret: "caller-typed-secret" });

    expect(mocks.probeOidcClientSecret).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: "caller-typed-secret" })
    );
  });

  it("honours an explicit empty clientSecret instead of falling back to the stored one", async () => {
    await post({ issuerUrl: "https://idp.example.com", clientSecret: "" });

    expect(mocks.probeOidcClientSecret).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: "" })
    );
  });
});

describe("issuer SSRF guard", () => {
  it("blocks an internal issuer before discovery is fetched", async () => {
    mocks.assertPublicUrlResolved.mockRejectedValueOnce(new Error("Blocked URL: internal host"));

    const result = await post({ issuerUrl: "http://127.0.0.1:8080" });

    expect(result.status).toBe(400);
    expect(result.body.error).toContain("Blocked URL");
    expect(mocks.fetchOidcDiscovery).not.toHaveBeenCalled();
  });

  it("runs the issuer through the resolved-address guard", async () => {
    await post({ issuerUrl: "https://idp.example.com" });

    expect(mocks.assertPublicUrlResolved).toHaveBeenNthCalledWith(1, "https://idp.example.com");
  });

  it("fetches discovery through the redirect-safe guard fetch", async () => {
    await post({ issuerUrl: "https://idp.example.com" });

    expect(mocks.fetchOidcDiscovery).toHaveBeenCalledWith("https://idp.example.com", {
      fetchImpl: mocks.fetchPublic,
    });
  });

  it("maps a redirect blocked by the guard fetch to 400", async () => {
    mocks.fetchOidcDiscovery.mockRejectedValueOnce(new Error("Blocked URL: redirect target is internal"));

    const result = await post({ issuerUrl: "https://idp.example.com" });

    expect(result.status).toBe(400);
    expect(result.body.error).toContain("Blocked URL");
  });
});

describe("token endpoint guard", () => {
  it("requires an https token endpoint", async () => {
    mocks.fetchOidcDiscovery.mockResolvedValue({
      ...DISCOVERY,
      token_endpoint: "http://oauth2.idp.example.com/token",
    });

    const result = await post({ issuerUrl: "https://idp.example.com" });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/https/i);
    expect(mocks.probeOidcClientSecret).not.toHaveBeenCalled();
  });

  it("blocks an internal token endpoint", async () => {
    mocks.fetchOidcDiscovery.mockResolvedValue({
      ...DISCOVERY,
      token_endpoint: "https://169.254.169.254/latest/meta-data",
    });
    mocks.assertPublicUrlResolved.mockImplementation(async (url) => {
      if (String(url).includes("169.254.169.254")) throw new Error("Blocked URL: internal host");
    });

    const result = await post({ issuerUrl: "https://idp.example.com" });

    expect(result.status).toBe(400);
    expect(result.body.error).toContain("Blocked URL");
    expect(mocks.probeOidcClientSecret).not.toHaveBeenCalled();
  });

  it("runs the token endpoint through the resolved-address guard", async () => {
    await post({ issuerUrl: "https://idp.example.com" });

    expect(mocks.assertPublicUrlResolved).toHaveBeenNthCalledWith(2, "https://oauth2.idp.example.com/token");
  });

  it("probes the secret through the redirect-safe guard fetch", async () => {
    await post({ issuerUrl: "https://idp.example.com" });

    expect(mocks.probeOidcClientSecret).toHaveBeenCalledWith(
      expect.objectContaining({ fetchImpl: mocks.fetchPublic })
    );
  });

  it("rejects a discovery document without a token endpoint", async () => {
    mocks.fetchOidcDiscovery.mockResolvedValue({ issuer: "https://idp.example.com" });

    const result = await post({ issuerUrl: "https://idp.example.com" });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/token_endpoint/i);
    expect(mocks.probeOidcClientSecret).not.toHaveBeenCalled();
  });

  it("allows a cross-origin token endpoint on https (Google-style IdP)", async () => {
    const result = await post({ issuerUrl: "https://idp.example.com" });

    expect(result.status).toBe(200);
    expect(mocks.probeOidcClientSecret).toHaveBeenCalledTimes(1);
  });
});
