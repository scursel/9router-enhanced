import { beforeEach, describe, expect, it, vi } from "vitest";

// Kept in its own file so these module mocks cannot leak into the isUsageEligible tests.
const mocks = vi.hoisted(() => ({ getConnection: vi.fn(), getUsage: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getConnection,
  updateProviderConnection: vi.fn(),
}));
vi.mock("open-sse/services/usage.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getUsageForProvider: mocks.getUsage,
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));

const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
const call = () =>
  GET(new Request("http://localhost/api/usage/c1"), { params: Promise.resolve({ connectionId: "c1" }) });

const NOT_AVAILABLE = { message: "Usage not available for this connection" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getUsage.mockResolvedValue({ quotas: {} });
});

describe("usage route eligibility", () => {
  it("accepts a local-balance api-key connection", async () => {
    mocks.getConnection.mockResolvedValue({
      id: "c1",
      provider: "gemini",
      authType: "apikey",
      providerSpecificData: { localBalance: { enabled: true, initialAmount: 100, currency: "USD" } },
    });

    const res = await call();
    const body = await res.json();

    // A 500 (handler threw) must not pass for "eligible".
    expect(res.status).toBe(200);
    expect(body).not.toEqual(NOT_AVAILABLE);
    expect(mocks.getUsage).toHaveBeenCalledTimes(1);
  });

  it("accepts a MiniMax lease connection", async () => {
    mocks.getConnection.mockResolvedValue({
      id: "c1",
      provider: "minimax-code",
      authType: "mcode-lease",
      providerSpecificData: {},
    });

    const res = await call();
    const body = await res.json();

    // A 500 (handler threw) must not pass for "eligible".
    expect(res.status).toBe(200);
    expect(body).not.toEqual(NOT_AVAILABLE);
    expect(mocks.getUsage).toHaveBeenCalledTimes(1);
  });
});
