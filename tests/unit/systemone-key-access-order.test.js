import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCustomModels: vi.fn(async () => []),
  enforceKeyAccessResolved: vi.fn(),
  getProviderCredentials: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getCustomModels: mocks.getCustomModels,
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "opencode", model: "jev-1.13-free" }),
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => ({}),
  enforceKeyAccessResolved: mocks.enforceKeyAccessResolved,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
}));

const { handleSystemone } = await import("../../src/sse/handlers/systemone.js");

describe("System One handler key access", () => {
  it("systemone checks key access before reading custom models", async () => {
    const denied = new Response("forbidden", { status: 403 });
    mocks.enforceKeyAccessResolved.mockResolvedValue(denied);

    const response = await handleSystemone(new Request("http://localhost/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opencode/jev-1.13-free", state: {}, questions: { q: "?" } }),
    }));

    expect(response).toBe(denied);
    expect(mocks.enforceKeyAccessResolved).toHaveBeenCalledTimes(1);
    expect(mocks.getCustomModels).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });
});
