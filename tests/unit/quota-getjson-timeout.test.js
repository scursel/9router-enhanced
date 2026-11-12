import { describe, expect, it, vi, afterEach } from "vitest";

const proxyAwareFetch = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const { getJson } = await import("../../open-sse/services/usage/quotaShared.js");

afterEach(() => {
  proxyAwareFetch.mockReset();
});

describe("quotaShared.getJson timeout", () => {
  it("gives the request an abort signal (a hung endpoint must not wait on undici's minutes-long default)", async () => {
    proxyAwareFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await getJson("https://quota.example.test/usage", "tok", null);
    const signal = proxyAwareFetch.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("reports an aborted (timed-out) request as timeout", async () => {
    proxyAwareFetch.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(getJson("https://quota.example.test/usage", "tok", null)).resolves.toEqual({ ok: false, status: 0, error: "timeout" });
  });

  it("still returns the body for a normal response", async () => {
    proxyAwareFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ a: 1 }) });
    await expect(getJson("https://quota.example.test/usage", null, null)).resolves.toEqual({ ok: true, status: 200, body: { a: 1 } });
  });
});
