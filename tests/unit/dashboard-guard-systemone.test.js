import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  hasTrustedPeerHeaders: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

vi.mock("@/lib/auth/trustedPeer", () => ({
  hasTrustedPeerHeaders: mocks.hasTrustedPeerHeaders,
}));

const { proxy, __test__ } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";

function request(pathname, headers = {}) {
  const normalizedHeaders = new Headers(headers);
  return {
    method: "POST",
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
  };
}

// A request that actually came through custom-server.js: peer IP stamped from the TCP
// socket and proven by the per-process secret.
function localRequest(pathname, headers = {}) {
  return request(pathname, { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "127.0.0.1", ...headers });
}

// A remote request (no trusted peer headers)
function remoteRequest(pathname, headers = {}) {
  return request(pathname, headers);
}

describe("dashboardGuard /systemone route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: true, requireLogin: false });
    mocks.hasTrustedPeerHeaders.mockReturnValue(false);
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.validateApiKey.mockResolvedValue(true);
  });

  describe("PUBLIC_PREFIXES constant", () => {
    it("should include /systemone", () => {
      const PUBLIC_PREFIXES = __test__.PUBLIC_PREFIXES;
      expect(PUBLIC_PREFIXES).toContain("/systemone");
    });

    it("should include other rewritten roots", () => {
      const PUBLIC_PREFIXES = __test__.PUBLIC_PREFIXES;
      expect(PUBLIC_PREFIXES).toContain("/v1");
      expect(PUBLIC_PREFIXES).toContain("/v1beta");
      expect(PUBLIC_PREFIXES).toContain("/api/v1");
      expect(PUBLIC_PREFIXES).toContain("/api/v1beta");
      expect(PUBLIC_PREFIXES).toContain("/codex");
      expect(PUBLIC_PREFIXES).toContain("/responses");
    });
  });

  describe("proxy() behavior for /systemone", () => {
    it("remote without API key → rejected", async () => {
      // Remote request (no trusted peer) without valid API key
      mocks.validateApiKey.mockResolvedValue(false);
      
      const result = await proxy(request("/systemone", { host: "router.example.com" }));
      
      // Should be rejected (401 or 403)
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(mocks.jsonResponse).toHaveBeenCalled();
    });

    it("remote with valid API key → allowed", async () => {
      // Remote request with valid API key
      mocks.validateApiKey.mockResolvedValue(true);
      
      const result = await proxy(request("/systemone", { 
        host: "router.example.com",
        "x-api-key": "valid-key",
      }));
      
      // Should pass through (next() called)
      expect(result).toBe(mocks.nextResponse);
    });

    it("local → allowed", async () => {
      // Local request (trusted peer with loopback Host)
      mocks.hasTrustedPeerHeaders.mockReturnValue(true);
      process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
      
      const result = await proxy(localRequest("/systemone", { host: "localhost:20128" }));
      
      // Should pass through (next() called)
      expect(result).toBe(mocks.nextResponse);
    });
  });

  describe("isPublicLlmApi for /systemone", () => {
    it("should treat /systemone as public LLM API", () => {
      const isPublicLlmApi = __test__.isPublicLlmApi;
      expect(isPublicLlmApi("/systemone")).toBe(true);
      expect(isPublicLlmApi("/systemone/")).toBe(true);
      expect(isPublicLlmApi("/systemone/chat")).toBe(true);
    });
  });
});
