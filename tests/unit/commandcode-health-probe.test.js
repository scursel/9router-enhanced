import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  testProxyUrl: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/lib/network/proxyTest", () => ({
  testProxyUrl: mocks.testProxyUrl,
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));

const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
const { PROVIDERS } = await import("open-sse/config/providers.js");
const { getDefaultModel } = await import("open-sse/config/providerModels.js");
const { ROLE, OPENAI_BLOCK } = await import("open-sse/translator/schema/index.js");

const upgrade = { code: "upgrade_required", message: "Your Command Code CLI is out of date", minVersion: "0.18.10" };
const originalFetch = global.fetch;
let cancelled;
function response(body, status = 200) {
  cancelled = vi.fn();
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); },
    cancel: cancelled,
  }), { status });
}
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status });
}
async function probe(res) {
  global.fetch = vi.fn().mockResolvedValue(res);
  return testSingleConnection("commandcode-fake");
}

describe("Command Code credential health probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.updateProviderConnection.mockResolvedValue(undefined);
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "commandcode-fake", provider: "commandcode", authType: "apikey",
      apiKey: "user_xxxxxxxx", providerSpecificData: {},
    });
  });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("sends registry version headers and the native minimal envelope with a fresh session", async () => {
    await probe(response('{"type":"finish"}\n'));
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(PROVIDERS.commandcode.baseUrl);
    expect(options.headers).toMatchObject({ ...PROVIDERS.commandcode.headers,
      Authorization: "Bearer user_xxxxxxxx", "Content-Type": "application/json" });
    expect(options.headers["x-session-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const payload = JSON.parse(options.body);
    expect(payload).toMatchObject({ threadId: expect.any(String), memory: "", config: expect.any(Object),
      params: { model: getDefaultModel("commandcode"), max_tokens: 1, stream: true,
        messages: [{ role: ROLE.USER, content: [{ type: OPENAI_BLOCK.TEXT, text: "ping" }] }] } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    await probe(response('{"type":"finish"}\n'));
    expect(global.fetch.mock.calls[0][1].headers["x-session-id"]).not.toBe(options.headers["x-session-id"]);
  });

  it.each(["start", "text-delta", "reasoning-delta", "finish"])("accepts a healthy %s event and cancels the body", async (type) => {
    const result = await probe(response(JSON.stringify({ type, delta: "pong" }) + "\n"));
    expect(result).toMatchObject({ valid: true, error: null });
    expect(cancelled).toHaveBeenCalled();
  });

  it.each([401, 403, 400, 500])("rejects HTTP %s with the provider message", async (status) => {
    const result = await probe(jsonResponse({ error: { message: "fake rejection" } }, status));
    expect(result).toMatchObject({ valid: false, error: "fake rejection" });
  });

  it("surfaces upgrade_required as a soft warning including minVersion", async () => {
    const result = await probe(jsonResponse({ error: upgrade }, 403));
    expect(result.valid).toBe(true);
    expect(result.error).toContain(upgrade.message);
    expect(result.error).toContain(upgrade.minVersion);
    expect(result.error).not.toContain("Invalid API key");
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("commandcode-fake",
      expect.objectContaining({ testStatus: "active", lastError: result.error }));
  });

  it("keeps upgrade_required a soft warning with no version suffix when minVersion is absent", async () => {
    const result = await probe(jsonResponse({ error: { code: "upgrade_required", message: upgrade.message } }, 403));
    expect(result).toMatchObject({ valid: true, error: upgrade.message });
    expect(result.error).not.toMatch(/minimum CLI version/);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("commandcode-fake",
      expect.objectContaining({ testStatus: "active", lastError: upgrade.message }));
  });

  it("reports a non-JSON error body as its raw text and rejects the credential", async () => {
    const result = await probe(new Response("<html>bad gateway</html>", { status: 502 }));
    expect(result).toMatchObject({ valid: false, error: "<html>bad gateway</html>" });
  });

  it.each([402, 432])("keeps HTTP %s quota exhaustion as a soft warning", async (status) => {
    expect(await probe(jsonResponse({ error: { message: "quota exhausted" } }, status)))
      .toMatchObject({ valid: true, error: "quota exhausted" });
  });

  it.each([400, 401, 403, 402, 432, 503])("classifies an in-stream %s error and cancels the body", async (statusCode) => {
    const result = await probe(response(JSON.stringify({ type: "error", error: { statusCode, message: "fake stream failure" } }) + "\n"));
    expect(result.valid).toBe([402, 432].includes(statusCode));
    expect(result.error).toContain("fake stream failure");
    expect(cancelled).toHaveBeenCalled();
  });

  it("rejects an empty successful response", async () => {
    expect((await probe(new Response(null, { status: 204 }))).valid).toBe(false);
  });

  it("accepts a well-formed event with a type this probe does not know", async () => {
    const result = await probe(response('{"type":"some-future-event"}\n'));
    expect(result).toMatchObject({ valid: true, error: null });
    expect(cancelled).toHaveBeenCalled();
  });

  it("rejects an event without a string type instead of declaring the credential healthy", async () => {
    expect((await probe(response('{"unexpected":"fake"}\n'))).valid).toBe(false);
    expect(cancelled).toHaveBeenCalled();
  });

  it.each(['42', '"just a string"', "null", '{"type":""}', '{"type":42}'])(
    "rejects a parsed first line that is not an object with a string type: %s",
    async (line) => {
      expect((await probe(response(`${line}\n`))).valid).toBe(false);
      expect(cancelled).toHaveBeenCalled();
    },
  );

  it("bounds a stalled stream and cancels its body", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cancel = vi.fn();
    const res = new Response(new ReadableStream({ cancel }));
    global.fetch = vi.fn().mockImplementation(() => {
      queueMicrotask(() => controller.abort(new Error("fake timeout")));
      return res;
    });
    const result = await testSingleConnection("commandcode-fake");
    expect(timeout).toHaveBeenCalledWith(15000);
    expect(result).toMatchObject({ valid: false, error: "fake timeout" });
    expect(cancel).toHaveBeenCalled();
  });

  it("settles and cancels the body when the signal aborts before any chunk arrives", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cancel = vi.fn();
    // The body never yields a chunk, so the read stays pending until the abort.
    const res = new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel }));
    global.fetch = vi.fn().mockImplementation(() => {
      setTimeout(() => controller.abort(new Error("fake abort before first chunk")), 0);
      return res;
    });
    const result = await testSingleConnection("commandcode-fake");
    expect(timeout).toHaveBeenCalledWith(15000);
    expect(result).toMatchObject({ valid: false, error: "fake abort before first chunk" });
    expect(cancel).toHaveBeenCalled();
  });

  it("uses the connection proxy for the native request", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ vercelRelayUrl: "https://relay.example" });
    mocks.proxyAwareFetch.mockResolvedValue(response('{"type":"finish"}\n'));
    global.fetch = vi.fn();
    expect((await testSingleConnection("commandcode-fake")).valid).toBe(true);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(PROVIDERS.commandcode.baseUrl,
      expect.objectContaining({ method: "POST" }), { vercelRelayUrl: "https://relay.example" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalled();
  });

  it("preserves an in-stream upgrade reason", async () => {
    const result = await probe(response(JSON.stringify({ type: "error", statusCode: 403, error: upgrade }) + "\n"));
    expect(result.valid).toBe(true);
    expect(result.error).toContain(upgrade.minVersion);
    expect(cancelled).toHaveBeenCalled();
  });
});
