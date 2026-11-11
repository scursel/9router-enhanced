// SSO sign-in allowlist enforcement in BOTH dashboard callbacks.
//
// The shared pure matcher is covered in sso-allowlist.test.js; these tests prove
// the OIDC callback and the SAML ACS route actually call it before minting the
// dashboard cookie, and that a rejection redirects to /login with an error and
// sets no cookie.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  getSettings: vi.fn(),
  setDashboardAuthCookie: vi.fn(),
  getOidcRuntimeConfig: vi.fn(),
  fetchOidcDiscovery: vi.fn(),
  exchangeOidcCode: vi.fn(),
  verifyOidcIdToken: vi.fn(),
  getPublicOrigin: vi.fn(() => "https://dashboard.example.com"),
  validateSamlResponse: vi.fn(),
  isSamlConfigured: vi.fn(() => true),
  getSamlBaseUrl: vi.fn(() => "https://sp.example.com"),
  pickSamlEmail: vi.fn(),
  pickSamlDisplayName: vi.fn(() => "SAML user"),
  checkLock: vi.fn(() => ({ locked: false })),
  recordFail: vi.fn(),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(() => "203.0.113.9"),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    redirect: vi.fn((url) => ({ status: 307, url: String(url) })),
    json: vi.fn((body, init = {}) => ({ status: init.status || 200, body })),
  },
}));

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));

vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));

vi.mock("@/lib/auth/dashboardSession", () => ({
  setDashboardAuthCookie: mocks.setDashboardAuthCookie,
}));

vi.mock("@/lib/auth/oidc", () => ({
  getOidcRuntimeConfig: mocks.getOidcRuntimeConfig,
  fetchOidcDiscovery: mocks.fetchOidcDiscovery,
  exchangeOidcCode: mocks.exchangeOidcCode,
  verifyOidcIdToken: mocks.verifyOidcIdToken,
  getPublicOrigin: mocks.getPublicOrigin,
  pickOidcDisplayName: (payload = {}) => payload.name || payload.email || "OIDC user",
  pickOidcEmail: (payload = {}) => payload.email || "",
}));

vi.mock("@/lib/auth/saml.js", () => ({
  getSamlBaseUrl: mocks.getSamlBaseUrl,
  isSamlConfigured: mocks.isSamlConfigured,
  pickSamlDisplayName: mocks.pickSamlDisplayName,
  pickSamlEmail: mocks.pickSamlEmail,
  validateSamlResponse: mocks.validateSamlResponse,
}));

vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: mocks.checkLock,
  recordFail: mocks.recordFail,
  recordSuccess: mocks.recordSuccess,
  getClientIp: mocks.getClientIp,
}));

const { GET: oidcCallback } = await import("../../src/app/api/auth/oidc/callback/route.js");
const { POST: samlAcs } = await import("../../src/app/api/auth/saml/acs/route.js");

const SAML_SETTINGS = {
  samlEntryPoint: "https://idp.example.com/sso",
  samlCert: "fake-cert",
  samlIssuer: "urn:9router:sp",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  ssoAllowedEmails: [],
  ssoAllowedEmailDomains: [],
};

function makeCookieStore() {
  const values = {
    oidc_state: "state-1",
    oidc_nonce: "nonce-1",
    oidc_code_verifier: "verifier-1",
    saml_state: "req-1",
  };
  return {
    get: vi.fn((name) => (values[name] ? { value: values[name] } : undefined)),
    set: vi.fn(),
    delete: vi.fn(),
  };
}

function oidcRequest() {
  return new Request("https://dashboard.example.com/api/auth/oidc/callback?code=code-1&state=state-1");
}

function oidcConfig(overrides = {}) {
  return {
    issuerUrl: "https://idp.example.com",
    clientId: "client-1",
    clientSecret: "fake-secret",
    scopes: "openid profile email",
    ssoAllowedEmails: [],
    ssoAllowedEmailDomains: [],
    ...overrides,
  };
}

function samlRequest() {
  const request = new Request("https://sp.example.com/api/auth/saml/acs", { method: "POST" });
  request.formData = async () => new Map([["SAMLResponse", "ZmFrZQ=="]]);
  return request;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue(makeCookieStore());
  mocks.getOidcRuntimeConfig.mockResolvedValue(oidcConfig());
  mocks.fetchOidcDiscovery.mockResolvedValue({
    issuer: "https://idp.example.com",
    token_endpoint: "https://idp.example.com/token",
    jwks_uri: "https://idp.example.com/jwks",
  });
  mocks.exchangeOidcCode.mockResolvedValue({ id_token: "fake.id.token" });
  mocks.verifyOidcIdToken.mockResolvedValue({ sub: "sub-1", email: "user@example.com" });
  mocks.getSettings.mockResolvedValue({ ...SAML_SETTINGS });
  mocks.validateSamlResponse.mockResolvedValue({ email: "user@example.com" });
  mocks.pickSamlEmail.mockImplementation((profile = {}) => profile.email || "");
});

describe("OIDC callback allowlist", () => {
  it("sets the dashboard cookie when no allowlist is configured (backward compatible)", async () => {
    const response = await oidcCallback(oidcRequest());

    expect(response.url).toBe("https://dashboard.example.com/dashboard");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledTimes(1);
    expect(mocks.setDashboardAuthCookie.mock.calls[0][2]).toMatchObject({
      oidc: true,
      oidcEmail: "user@example.com",
    });
  });

  it("rejects an e-mail outside a configured allowlist and sets no cookie", async () => {
    mocks.getOidcRuntimeConfig.mockResolvedValue(oidcConfig({ ssoAllowedEmails: ["admin@example.com"] }));
    mocks.verifyOidcIdToken.mockResolvedValue({ sub: "sub-1", email: "intruder@example.com" });

    const response = await oidcCallback(oidcRequest());

    expect(response.url).toBe("https://dashboard.example.com/login?error=sso_email_not_allowed");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("admits an e-mail in an allowed domain", async () => {
    mocks.getOidcRuntimeConfig.mockResolvedValue(oidcConfig({ ssoAllowedEmailDomains: ["example.com"] }));

    const response = await oidcCallback(oidcRequest());

    expect(response.url).toBe("https://dashboard.example.com/dashboard");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledTimes(1);
  });

  it("does NOT admit a sub-domain of an allowed parent domain", async () => {
    mocks.getOidcRuntimeConfig.mockResolvedValue(oidcConfig({ ssoAllowedEmailDomains: ["example.com"] }));
    mocks.verifyOidcIdToken.mockResolvedValue({ sub: "sub-1", email: "user@sub.example.com" });

    const response = await oidcCallback(oidcRequest());

    expect(response.url).toBe("https://dashboard.example.com/login?error=sso_email_not_allowed");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("rejects a missing e-mail when an allowlist is configured", async () => {
    mocks.getOidcRuntimeConfig.mockResolvedValue(oidcConfig({ ssoAllowedEmails: ["admin@example.com"] }));
    mocks.verifyOidcIdToken.mockResolvedValue({ sub: "sub-1" });

    const response = await oidcCallback(oidcRequest());

    expect(response.url).toBe("https://dashboard.example.com/login?error=sso_email_not_allowed");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("rejects email_verified:false when an allowlist is configured", async () => {
    mocks.getOidcRuntimeConfig.mockResolvedValue(oidcConfig({ ssoAllowedEmails: ["user@example.com"] }));
    mocks.verifyOidcIdToken.mockResolvedValue({ sub: "sub-1", email: "user@example.com", email_verified: false });

    const response = await oidcCallback(oidcRequest());

    expect(response.url).toBe("https://dashboard.example.com/login?error=sso_email_not_allowed");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("ignores email_verified:false when no allowlist is configured (backward compatible)", async () => {
    mocks.verifyOidcIdToken.mockResolvedValue({ sub: "sub-1", email: "user@example.com", email_verified: false });

    const response = await oidcCallback(oidcRequest());

    expect(response.url).toBe("https://dashboard.example.com/dashboard");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledTimes(1);
  });
});

describe("SAML ACS allowlist", () => {
  it("sets the dashboard cookie when no allowlist is configured (backward compatible)", async () => {
    const response = await samlAcs(samlRequest());

    expect(response.url).toBe("https://sp.example.com/dashboard");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledTimes(1);
    expect(mocks.recordSuccess).toHaveBeenCalledWith("203.0.113.9");
  });

  it("rejects an e-mail outside a configured allowlist and sets no cookie", async () => {
    mocks.getSettings.mockResolvedValue({ ...SAML_SETTINGS, ssoAllowedEmails: ["admin@example.com"] });
    mocks.validateSamlResponse.mockResolvedValue({ email: "intruder@example.com" });

    const response = await samlAcs(samlRequest());

    expect(response.url).toBe("https://sp.example.com/login?error=sso_email_not_allowed");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    expect(mocks.recordSuccess).not.toHaveBeenCalled();
    expect(mocks.recordFail).toHaveBeenCalledWith("203.0.113.9");
  });

  it("admits an e-mail in an allowed domain", async () => {
    mocks.getSettings.mockResolvedValue({ ...SAML_SETTINGS, ssoAllowedEmailDomains: ["example.com"] });

    const response = await samlAcs(samlRequest());

    expect(response.url).toBe("https://sp.example.com/dashboard");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledTimes(1);
  });

  it("does NOT admit a sub-domain of an allowed parent domain", async () => {
    mocks.getSettings.mockResolvedValue({ ...SAML_SETTINGS, ssoAllowedEmailDomains: ["example.com"] });
    mocks.validateSamlResponse.mockResolvedValue({ email: "user@sub.example.com" });

    const response = await samlAcs(samlRequest());

    expect(response.url).toBe("https://sp.example.com/login?error=sso_email_not_allowed");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });

  it("rejects a missing e-mail when an allowlist is configured", async () => {
    mocks.getSettings.mockResolvedValue({ ...SAML_SETTINGS, ssoAllowedEmails: ["admin@example.com"] });
    mocks.validateSamlResponse.mockResolvedValue({});

    const response = await samlAcs(samlRequest());

    expect(response.url).toBe("https://sp.example.com/login?error=sso_email_not_allowed");
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
  });
});
