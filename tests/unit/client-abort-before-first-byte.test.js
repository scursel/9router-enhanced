/**
 * Item 1 — a client that disconnects before the first byte must abort the
 * upstream call instead of leaving it running through the 60–200 s readiness
 * wait. Before the fix the route never passed request.signal down, so the
 * executor only saw the stream controller's signal (aborted from the response
 * body's cancel()) and a client that left during readiness left the fetch
 * running.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function coreArgs(overrides = {}) {
  return {
    body: { model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] },
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    connectionId: "conn-abort",
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
    ...overrides,
  };
}

/** A fetch that never settles until its signal aborts (like a slow upstream). */
function hangingFetch() {
  return vi.fn((_url, opts) => new Promise((_resolve, reject) => {
    const signal = opts?.signal;
    if (!signal) return; // never settles: the old behaviour
    const onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }));
}

/** An SSE response whose body never produces a byte. */
function silentSse() {
  return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("chatCore — client abort before the first byte", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("aborts the in-flight upstream call and answers 499", async () => {
    const fetchMock = hangingFetch();
    executeMock.mockImplementation(({ signal }) => fetchMock("https://upstream.test/v1/chat/completions", { signal }));
    const controller = new AbortController();

    const pending = handleChatCore(coreArgs({ clientSignal: controller.signal }));
    await sleep(20);
    controller.abort();

    const result = await Promise.race([pending, sleep(500).then(() => "HUNG")]);
    expect(result).not.toBe("HUNG");
    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(result.clientAborted).toBe(true);
    // The executor really saw the client's abort, not a private controller.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("stops waiting for the first byte when the client leaves during stream readiness", async () => {
    executeMock.mockResolvedValue({
      response: silentSse(),
      url: "https://upstream.test/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
    const controller = new AbortController();

    const pending = handleChatCore(coreArgs({
      clientSignal: controller.signal,
      // Long enough that the old code would sit here for the whole budget.
      streamReadinessTimeoutMs: 5_000,
    }));
    await sleep(30);
    controller.abort();

    const result = await Promise.race([pending, sleep(500).then(() => "HUNG")]);
    expect(result).not.toBe("HUNG");
    expect(result.status).toBe(499);
    expect(result.clientAborted).toBe(true);
  });

  it("does not start an upstream call when the client was already gone", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await handleChatCore(coreArgs({ clientSignal: controller.signal }));
    expect(result.status).toBe(499);
    expect(result.clientAborted).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
