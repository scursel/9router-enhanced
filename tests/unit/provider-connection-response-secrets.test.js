import { describe, it, expect } from "vitest";
import { toProviderConnectionResponse } from "../../src/lib/providerConnectionResponse";

// Mock for PUT round-trip test
vi.mock("@/models", () => ({
  getProviderConnectionById: vi.fn(),
  getProxyPoolById: vi.fn(),
  updateProviderConnection: vi.fn(),
  deleteProviderConnection: vi.fn(),
}));

describe("toProviderConnectionResponse secrets redaction", () => {
  it("should redact cookie from providerSpecificData", () => {
    const connection = {
      id: "test-1",
      provider: "iflow",
      apiKey: "test-key",
      providerSpecificData: {
        cookie: "secret-cookie-value",
        baseUrl: "https://api.iflow.com",
      },
    };
    const result = toProviderConnectionResponse(connection);
    expect(result.providerSpecificData).toBeDefined();
    expect(result.providerSpecificData.cookie).toBeUndefined();
    expect(result.providerSpecificData.baseUrl).toBe("https://api.iflow.com");
  });

  it("should redact quotaCookie from providerSpecificData", () => {
    const connection = {
      id: "test-2",
      provider: "xiaomi-mimo",
      apiKey: "test-key",
      providerSpecificData: {
        quotaCookie: "secret-quota-cookie",
        uid: "user-123",
      },
    };
    const result = toProviderConnectionResponse(connection);
    expect(result.providerSpecificData.quotaCookie).toBeUndefined();
    expect(result.providerSpecificData.uid).toBe("user-123");
  });

  it("should redact clientSecret from providerSpecificData", () => {
    const connection = {
      id: "test-3",
      provider: "kiro",
      apiKey: "test-key",
      providerSpecificData: {
        clientSecret: "secret-client-secret",
        clientId: "client-123",
        region: "us-east-1",
      },
    };
    const result = toProviderConnectionResponse(connection);
    expect(result.providerSpecificData.clientSecret).toBeUndefined();
    expect(result.providerSpecificData.clientId).toBe("client-123");
    expect(result.providerSpecificData.region).toBe("us-east-1");
  });

  it("should redact copilotToken from providerSpecificData", () => {
    const connection = {
      id: "test-4",
      provider: "github",
      apiKey: "test-key",
      providerSpecificData: {
        copilotToken: "secret-copilot-token",
        copilotTokenExpiresAt: 1234567890,
        githubUserId: "user-123",
      },
    };
    const result = toProviderConnectionResponse(connection);
    expect(result.providerSpecificData.copilotToken).toBeUndefined();
    expect(result.providerSpecificData.copilotTokenExpiresAt).toBe(1234567890);
    expect(result.providerSpecificData.githubUserId).toBe("user-123");
  });

  it("should keep connectionProxyUrl for UI display", () => {
    const connection = {
      id: "test-5",
      provider: "openai",
      apiKey: "test-key",
      providerSpecificData: {
        connectionProxyUrl: "http://user:pass@proxy.com:8080",
        connectionProxyEnabled: true,
        connectionNoProxy: "localhost",
      },
    };
    const result = toProviderConnectionResponse(connection);
    // connectionProxyUrl is NOT a secret - UI needs it for display (masked)
    expect(result.providerSpecificData.connectionProxyUrl).toBe("http://user:pass@proxy.com:8080");
    expect(result.providerSpecificData.connectionProxyEnabled).toBe(true);
    expect(result.providerSpecificData.connectionNoProxy).toBe("localhost");
  });

  it("should redact mimoPassToken but keep mimoUserId and mimoCUserId", () => {
    const connection = {
      id: "test-6",
      provider: "xiaomi-mimo",
      apiKey: "test-key",
      providerSpecificData: {
        mimoPassToken: "secret-pass-token",
        mimoUserId: "user-123",
        mimoCUserId: "cuser-456",
        uid: "user-789",
        baseUrl: "https://api.xiaomimimo.com",
      },
    };
    const result = toProviderConnectionResponse(connection);
    expect(result.providerSpecificData.mimoPassToken).toBeUndefined();
    // These are NOT secrets and should be preserved for UI matching
    expect(result.providerSpecificData.mimoUserId).toBe("user-123");
    expect(result.providerSpecificData.mimoCUserId).toBe("cuser-456");
    expect(result.providerSpecificData.uid).toBe("user-789");
    expect(result.providerSpecificData.baseUrl).toBe("https://api.xiaomimimo.com");
  });

  it("should keep non-secret fields in providerSpecificData", () => {
    const connection = {
      id: "test-7",
      provider: "kiro",
      apiKey: "test-key",
      providerSpecificData: {
        profileArn: "arn:aws:iam::123456789012:user/test",
        region: "us-east-1",
        authMethod: "api_key",
        uid: "user-123",
        baseUrl: "https://api.kiro.ai",
      },
    };
    const result = toProviderConnectionResponse(connection);
    expect(result.providerSpecificData.profileArn).toBe("arn:aws:iam::123456789012:user/test");
    expect(result.providerSpecificData.region).toBe("us-east-1");
    expect(result.providerSpecificData.authMethod).toBe("api_key");
    expect(result.providerSpecificData.uid).toBe("user-123");
    expect(result.providerSpecificData.baseUrl).toBe("https://api.kiro.ai");
  });

  it("should still redact sessionToken for AWS providers", () => {
    const connection = {
      id: "test-8",
      provider: "bedrock",
      apiKey: "test-key",
      accessToken: "access-token",
      providerSpecificData: {
        sessionToken: "secret-session-token",
        region: "us-east-1",
      },
    };
    const result = toProviderConnectionResponse(connection);
    expect(result.accessToken).toBeUndefined();
    expect(result.apiKey).toBeUndefined();
    expect(result.providerSpecificData.sessionToken).toBeUndefined();
    expect(result.providerSpecificData.region).toBe("us-east-1");
  });

  it("should handle null providerSpecificData", () => {
    const connection = {
      id: "test-9",
      provider: "openai",
      apiKey: "test-key",
      providerSpecificData: null,
    };
    const result = toProviderConnectionResponse(connection);
    expect(result.providerSpecificData).toBeUndefined();
  });

  it("should handle missing providerSpecificData", () => {
    const connection = {
      id: "test-10",
      provider: "openai",
      apiKey: "test-key",
    };
    const result = toProviderConnectionResponse(connection);
    expect(result.providerSpecificData).toBeUndefined();
  });
  it("PUT round-trip should not wipe stored secrets when client sends record back without them", async () => {
    // Configure the top-level mock for this test
    const { getProviderConnectionById, updateProviderConnection } = await import("@/models");
    getProviderConnectionById.mockResolvedValue({
      id: "test-id",
      provider: "iflow",
      providerSpecificData: {
        cookie: "stored-secret-cookie",
        baseUrl: "https://api.iflow.com",
      },
    });
    updateProviderConnection.mockImplementation((id, data) => ({ ...data, id }));
    
    // Import the PUT handler
    const { PUT } = await import("../../src/app/api/providers/[id]/route.js");
    
    // Simulate a PUT request where client sends only non-secret fields (cookie was redacted)
    const request = {
      json: async () => ({
        providerSpecificData: {
          baseUrl: "https://api.iflow.com/v2",
        },
      }),
    };
    
    await PUT(request, { params: { id: "test-id" } });
    
    // Verify that updateProviderConnection was called with the merged data
    // The stored cookie should be preserved
    expect(updateProviderConnection).toHaveBeenCalledWith(
      "test-id",
      expect.objectContaining({
        providerSpecificData: expect.objectContaining({
          cookie: "stored-secret-cookie",
          baseUrl: "https://api.iflow.com/v2",
        }),
      })
    );
  });
});
