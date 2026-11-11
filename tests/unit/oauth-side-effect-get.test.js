import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock NextResponse first
const mockNextResponseJson = vi.fn((data, init) => ({
  status: init?.status || 200,
  data,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: mockNextResponseJson,
  },
}));

// Mock all the dependencies
vi.mock("@/lib/oauth/utils/server", () => ({
  startCodexProxy: vi.fn().mockResolvedValue({ success: true, callbackUrl: "http://localhost:8080", port: 8080 }),
  stopCodexProxy: vi.fn().mockResolvedValue({ success: true }),
  startXaiProxy: vi.fn().mockResolvedValue({ success: true, callbackUrl: "http://localhost:8081", port: 8081 }),
  stopXaiProxy: vi.fn().mockResolvedValue({ success: true }),
  startTraeProxy: vi.fn().mockResolvedValue({ success: true, callbackUrl: "http://localhost:8082", port: 8082 }),
  stopTraeProxy: vi.fn().mockResolvedValue({ success: true }),
  startWindsurfProxy: vi.fn().mockResolvedValue({ success: true, callbackUrl: "http://localhost:8083", port: 8083 }),
  stopWindsurfProxy: vi.fn().mockResolvedValue({ success: true }),
  startZedProxy: vi.fn().mockResolvedValue({ success: true, callbackUrl: "http://localhost:8084", port: 8084 }),
  stopZedProxy: vi.fn().mockResolvedValue({ success: true }),
  startXiaomiMimoProxy: vi.fn().mockResolvedValue({ success: true, callbackUrl: "http://localhost:8085", port: 8085 }),
  stopXiaomiMimoProxy: vi.fn().mockResolvedValue({ success: true }),
  registerCodexSession: vi.fn().mockReturnValue(true),
  registerXaiSession: vi.fn().mockReturnValue(true),
  getCodexSessionStatus: vi.fn().mockReturnValue(null),
  getXaiSessionStatus: vi.fn().mockReturnValue(null),
  getTraeSessionStatus: vi.fn().mockReturnValue(null),
  getWindsurfSessionStatus: vi.fn().mockReturnValue(null),
  getZedSessionStatus: vi.fn().mockReturnValue(null),
  getXiaomiMimoSessionStatus: vi.fn().mockReturnValue(null),
  clearCodexSession: vi.fn(),
  clearXaiSession: vi.fn(),
  clearTraeSession: vi.fn(),
  clearWindsurfSession: vi.fn(),
  clearZedSession: vi.fn(),
  clearXiaomiMimoSession: vi.fn(),
  registerXiaomiMimoSession: vi.fn(),
}));

vi.mock("@/lib/oauth/providers", () => ({
  generateAuthData: vi.fn().mockResolvedValue({ authUrl: "http://auth.example.com", state: "test-state" }),
  exchangeTokens: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));

vi.mock("@/models", () => ({
  createProviderConnection: vi.fn().mockResolvedValue({ id: "test-id", provider: "test-provider" }),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn().mockResolvedValue([]),
}));

vi.mock("open-sse/services/minimaxCodeLease.js", () => ({
  requestLease: vi.fn(),
  requestStatus: vi.fn(),
  resolveLeaseEndpoint: vi.fn(),
  resolveMcodeDataDir: vi.fn(),
  AuthLeaseError: class AuthLeaseError extends Error {},
}));

vi.mock("open-sse/shared/mimoAccount.js", () => ({
  readDesktopPassToken: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/oauth/utils/ideDetect", () => ({
  detectIdeInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/oauth/constants/oauth", () => ({
  ZED_HOSTED_CONFIG: { defaultNativeAppPort: 58443 },
}));

describe("OAuth routes - side-effecting GET", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("start-proxy action", () => {
    it("GET /api/oauth/codex/start-proxy should return 405", async () => {
      // Import after mocking
      const { GET } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
      
      const request = {
        method: "GET",
        url: "http://localhost:20128/api/oauth/codex/start-proxy",
        nextUrl: new URL("http://localhost:20128/api/oauth/codex/start-proxy"),
      };
      
      const result = await GET(request, { params: { provider: "codex", action: "start-proxy" } });
      
      expect(result.status).toBe(405);
    });

    it("POST /api/oauth/codex/start-proxy should work", async () => {
      const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
      
      const request = {
        method: "POST",
        url: "http://localhost:20128/api/oauth/codex/start-proxy?app_port=8080",
        nextUrl: new URL("http://localhost:20128/api/oauth/codex/start-proxy?app_port=8080"),
        json: vi.fn().mockResolvedValue({}),
      };
      
      const result = await POST(request, { params: { provider: "codex", action: "start-proxy" } });
      
      // Should call startCodexProxy and return success
      expect(result.status).toBe(200);
    });
  });

  describe("stop-proxy action", () => {
    it("GET /api/oauth/codex/stop-proxy should return 405", async () => {
      const { GET } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
      
      const request = {
        method: "GET",
        url: "http://localhost:20128/api/oauth/codex/stop-proxy",
        nextUrl: new URL("http://localhost:20128/api/oauth/codex/stop-proxy"),
      };
      
      const result = await GET(request, { params: { provider: "codex", action: "stop-proxy" } });
      
      expect(result.status).toBe(405);
    });

    it("POST /api/oauth/codex/stop-proxy should work", async () => {
      const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
      
      const request = {
        method: "POST",
        url: "http://localhost:20128/api/oauth/codex/stop-proxy",
        nextUrl: new URL("http://localhost:20128/api/oauth/codex/stop-proxy"),
        json: vi.fn().mockResolvedValue({}),
      };
      
      const result = await POST(request, { params: { provider: "codex", action: "stop-proxy" } });
      
      // Should call stopCodexProxy and return success
      expect(result.status).toBe(200);
    });
  });

  describe("other actions should still work with GET", () => {
    it("GET /api/oauth/codex/authorize should NOT return 405", async () => {
      const { GET } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
      
      const request = {
        method: "GET",
        url: "http://localhost:20128/api/oauth/codex/authorize?redirect_uri=http://localhost:8080/callback",
        nextUrl: new URL("http://localhost:20128/api/oauth/codex/authorize?redirect_uri=http://localhost:8080/callback"),
      };
      
      const result = await GET(request, { params: { provider: "codex", action: "authorize" } });
      
      // Should work (not 405)
      expect(result.status).not.toBe(405);
    });

    it("GET /api/oauth/codex/device-code should NOT return 405", async () => {
      const { GET } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
      
      const request = {
        method: "GET",
        url: "http://localhost:20128/api/oauth/codex/device-code",
        nextUrl: new URL("http://localhost:20128/api/oauth/codex/device-code"),
      };
      
      const result = await GET(request, { params: { provider: "codex", action: "device-code" } });
      
      // Should work (not 405)
      expect(result.status).not.toBe(405);
    });

    it("GET /api/oauth/codex/poll-status should NOT return 405", async () => {
      const { GET } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
      
      const request = {
        method: "GET",
        url: "http://localhost:20128/api/oauth/codex/poll-status?state=test-state",
        nextUrl: new URL("http://localhost:20128/api/oauth/codex/poll-status?state=test-state"),
      };
      
      const result = await GET(request, { params: { provider: "codex", action: "poll-status" } });
      
      // Should work (not 405)
      expect(result.status).not.toBe(405);
    });
  });
});
