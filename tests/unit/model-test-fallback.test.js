import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeys: mocks.getApiKeys,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const originalFetch = global.fetch;

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const chatOk = () => jsonRes({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] });

async function postModelTest(payload) {
  const { POST } = await import("../../src/app/api/models/test/route.js");
  const res = await POST(new Request("http://localhost/api/models/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }));
  return res.json();
}

describe("model test kind fallback chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiKeys.mockResolvedValue([{ key: "sk-internal", isActive: true }]);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("keeps the declared kind first and appends the fallbacks after it", async () => {
    const { resolveKindChain } = await import("../../src/app/api/models/test/ping.js");

    expect(resolveKindChain("embedding")).toEqual(["embedding", "llm"]);
    expect(resolveKindChain("image")).toEqual(["image", "llm"]);
    expect(resolveKindChain("stt")).toEqual(["stt", "llm"]);
    expect(resolveKindChain("llm")).toEqual(["llm", "embedding", "image"]);
    expect(resolveKindChain("EMBEDDING")).toEqual(["embedding", "llm"]);
  });

  it("starts at a normal chat call for kinds with no dedicated probe", async () => {
    const { resolveKindChain } = await import("../../src/app/api/models/test/ping.js");

    expect(resolveKindChain("music")).toEqual(["llm", "embedding", "image"]);
    expect(resolveKindChain("webSearch")).toEqual(["llm", "embedding", "image"]);
    expect(resolveKindChain(undefined)).toEqual(["llm", "embedding", "image"]);
  });

  it("never walks the prototype chain for an object-shaped kind", async () => {
    const { resolveKindChain } = await import("../../src/app/api/models/test/ping.js");

    expect(resolveKindChain("constructor")).toEqual(["llm", "embedding", "image"]);
    expect(resolveKindChain("toString")).toEqual(["llm", "embedding", "image"]);
    expect(resolveKindChain("__proto__")).toEqual(["llm", "embedding", "image"]);
  });

  it("retries only route/capability rejections, never auth, quota or server failures", async () => {
    const { isCapabilityMismatch } = await import("../../src/app/api/models/test/ping.js");

    expect(isCapabilityMismatch({
      ok: false,
      status: 400,
      error: "HTTP 400: Provider 'github' does not support image generation",
    })).toBe(true);
    expect(isCapabilityMismatch({ ok: false, status: 400, error: "HTTP 400: unsupported_api_for_model" })).toBe(true);
    expect(isCapabilityMismatch({ ok: false, status: 405, error: "HTTP 405: Method Not Allowed" })).toBe(true);

    expect(isCapabilityMismatch({ ok: false, status: 401, error: "HTTP 401: invalid api key" })).toBe(false);
    expect(isCapabilityMismatch({ ok: false, status: 403, error: "HTTP 403: Access denied" })).toBe(false);
    expect(isCapabilityMismatch({ ok: false, status: 429, error: "HTTP 429: rate limited" })).toBe(false);
    expect(isCapabilityMismatch({ ok: false, status: 503, error: "upstream unavailable" })).toBe(false);
    expect(isCapabilityMismatch({ ok: false, status: 200, error: "Provider returned no completion choices for this model" })).toBe(false);
    expect(isCapabilityMismatch({ ok: true, status: 200 })).toBe(false);
  });

  it("stays a single call when the declared kind answers", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonRes({ data: [{ embedding: [0.1, 0.2] }] }));

    const body = await postModelTest({ model: "voyage/voyage-3-large", kind: "embedding" });

    expect(body.ok).toBe(true);
    expect(body.kind).toBe("embedding");
    expect(body.declaredKind).toBe("embedding");
    expect(body.note).toBeUndefined();
    expect(body.attempts).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the next kind when the declared one is not served, and says so", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(jsonRes({ error: { message: "Provider 'github' does not support image generation" } }, 400))
      .mockResolvedValueOnce(chatOk());

    const body = await postModelTest({ model: "github/gpt-4o", kind: "image" });

    expect(body.ok).toBe(true);
    expect(body.kind).toBe("llm");
    expect(body.declaredKind).toBe("image");
    expect(body.note).toMatch(/answered as llm \(declared kind: image\)/);
    expect(body.attempts.map((attempt) => attempt.kind)).toEqual(["image", "llm"]);
    expect(global.fetch.mock.calls[0][0]).toContain("/api/v1/images/generations");
    expect(global.fetch.mock.calls[1][0]).toContain("/api/v1/chat/completions");
  });

  it("does not retry on an auth failure — the next kind would fail the same way", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonRes({ error: { message: "invalid api key" } }, 401));

    const body = await postModelTest({ model: "voyage/voyage-3-large", kind: "embedding" });

    expect(body.ok).toBe(false);
    expect(body.error).toContain("HTTP 401");
    expect(body.error).not.toMatch(/tried:/);
    expect(body.attempts).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("reports the declared kind's error plus what was tried when every kind is rejected", async () => {
    // Fresh Response per call: a body can only be read once.
    global.fetch = vi.fn().mockImplementation(() =>
      jsonRes({ error: { message: "Provider 'x' does not support this capability" } }, 400)
    );

    const body = await postModelTest({ model: "x/model", kind: "embedding" });

    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/does not support this capability/);
    expect(body.error).toMatch(/tried: embedding, llm/);
    expect(body.attempts.map((attempt) => attempt.kind)).toEqual(["embedding", "llm"]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a decisive provider error from the declared kind without rewriting it", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonRes({ error: { message: "bad upstream" } }, 502));

    const body = await postModelTest({ model: "voyage/voyage-3-large", kind: "embedding" });

    expect(body.ok).toBe(false);
    expect(body.error).toBe("HTTP 502: bad upstream");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
