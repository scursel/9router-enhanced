import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } });
    },
  },
}));
vi.mock("@/models", () => ({ getProviderNodeById: vi.fn() }));
const guard = vi.hoisted(() => ({ local: false }));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: () => guard.local }));

const { POST } = await import("@/app/api/providers/validate/route.js");
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; guard.local = false; });

const req = (azureEndpoint) => ({
  json: async () => ({ provider: "azure", apiKey: "k", providerSpecificData: { azureEndpoint } }),
  headers: new Headers(),
});

describe("providers/validate azure branch SSRF guard", () => {
  it("remote caller cannot aim the api-key at an internal endpoint", async () => {
    global.fetch = vi.fn();
    const res = await POST(req("http://169.254.169.254"));
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("local caller may still use a self-hosted endpoint", async () => {
    guard.local = true;
    global.fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const res = await POST(req("http://10.0.0.5"));
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
