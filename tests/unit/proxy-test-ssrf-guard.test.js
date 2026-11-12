// /api/settings/proxy-test makes the gateway open a connection to a caller-chosen
// proxy and URL. A remote caller must not be able to aim it at internal hosts; a
// request from the host itself keeps testing local proxies (127.0.0.1:7890).
import { describe, it, expect, vi, beforeEach } from "vitest";

const guard = vi.hoisted(() => ({ local: false }));
const testProxyUrl = vi.hoisted(() => vi.fn(async () => ({ ok: true, status: 200 })));

vi.mock("@/dashboardGuard", () => ({ isLocalRequest: () => guard.local }));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl }));

const { POST } = await import("@/app/api/settings/proxy-test/route.js");

function post(body) {
  return POST(new Request("http://gateway.example/api/settings/proxy-test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("proxy-test SSRF guard", () => {
  beforeEach(() => {
    guard.local = false;
    testProxyUrl.mockClear();
  });

  it.each([
    ["a loopback proxy", { proxyUrl: "http://127.0.0.1:7890" }],
    ["the cloud metadata address as proxy", { proxyUrl: "http://169.254.169.254" }],
    ["a private-network proxy", { proxyUrl: "http://10.0.0.5:3128" }],
    ["an internal test URL", { proxyUrl: "http://proxy.example:8080", testUrl: "http://169.254.169.254/latest/meta-data/" }],
    ["a malformed URL", { proxyUrl: "not a url" }],
  ])("refuses %s from a remote caller", async (_label, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(testProxyUrl).not.toHaveBeenCalled();
  });

  it("lets a remote caller test a public proxy", async () => {
    const res = await post({ proxyUrl: "http://proxy.example:8080" });

    expect(res.status).toBe(200);
    expect(testProxyUrl).toHaveBeenCalledOnce();
  });

  it("lets the host itself test a local proxy", async () => {
    guard.local = true;

    const res = await post({ proxyUrl: "http://127.0.0.1:7890" });

    expect(res.status).toBe(200);
    expect(testProxyUrl).toHaveBeenCalledOnce();
  });
});

describe("providers/validate SSRF guard", () => {
  it("refuses a compatible node on an internal host for a remote caller", async () => {
    vi.resetModules();
    vi.doMock("@/models", () => ({
      getProviderNodeById: vi.fn(async () => ({ baseUrl: "http://169.254.169.254/v1" })),
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const { POST: validate } = await import("@/app/api/providers/validate/route.js");
    guard.local = false;

    const res = await validate(new Request("http://gateway.example/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai-compatible-node1", apiKey: "k" }),
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("URL not allowed");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
