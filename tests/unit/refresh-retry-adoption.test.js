/**
 * Item 2 — after a successful token refresh the retry's response must be
 * adopted whatever its status. Before the fix only `retryResult.response.ok`
 * was adopted, so refresh-OK + retry-503 classified the account by the stale
 * 401 (2-minute auth lock) and lost the retry's status/body/headers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const { executeMock, refreshMock, canRefreshMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  refreshMock: vi.fn(),
  canRefreshMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: false,
    execute: executeMock,
    refreshCredentials: refreshMock,
    canRefreshCredentials: canRefreshMock,
    needsRefresh: () => false,
  }),
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

function chatArgs(credentials) {
  return {
    body: { model: "glm", stream: false, messages: [{ role: "user", content: "hi" }] },
    modelInfo: { provider: "refreshretry", model: "glm" },
    credentials,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    connectionId: "conn-refresh-retry",
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
  };
}

describe("chatCore — the refreshed-token retry result is authoritative", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canRefreshMock.mockReturnValue(true);
    refreshMock.mockResolvedValue({ accessToken: "AT-fresh", refreshToken: "RT-fresh" });
  });

  it("refresh OK + retry 503 → the 503 drives classification, and the stale 401 body is cancelled", async () => {
    let staleBodyCancelled = false;
    executeMock
      .mockImplementationOnce(async () => ({
        response: new Response(new ReadableStream({
          // Closes shortly after: the old path reads it (getting an empty 401
          // body); the fix cancels it before that, which is what we observe.
          start(controller) { setTimeout(() => { try { controller.close(); } catch { /* cancelled */ } }, 50); },
          cancel() { staleBodyCancelled = true; },
        }), { status: 401, headers: { "content-type": "application/json" } }),
        url: "https://provider.test/chat",
        headers: {},
        transformedBody: null,
      }))
      .mockImplementationOnce(async () => ({
        response: new Response(JSON.stringify({ error: { message: "upstream overloaded" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
        url: "https://provider.test/chat",
        headers: {},
        transformedBody: null,
      }));

    const result = await handleChatCore(chatArgs({ accessToken: "AT-stale", refreshToken: "RT-stale" }));

    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toContain("upstream overloaded");
    // The response that is not returned must not keep its body open.
    expect(staleBodyCancelled).toBe(true);
  });

  it("refresh OK + retry 200 still adopts the retry (unchanged)", async () => {
    let staleBodyCancelled = false;
    executeMock
      .mockImplementationOnce(async () => ({
        response: new Response(new ReadableStream({
          // Closes shortly after: the old path reads it (getting an empty 401
          // body); the fix cancels it before that, which is what we observe.
          start(controller) { setTimeout(() => { try { controller.close(); } catch { /* cancelled */ } }, 50); },
          cancel() { staleBodyCancelled = true; },
        }), { status: 401, headers: { "content-type": "application/json" } }),
        url: "https://provider.test/chat",
        headers: {},
        transformedBody: null,
      }))
      .mockImplementationOnce(async () => ({
        response: new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
          headers: { "content-type": "application/json" },
        }),
        url: "https://provider.test/chat",
        headers: {},
        transformedBody: null,
      }));

    const result = await handleChatCore(chatArgs({ accessToken: "AT-stale", refreshToken: "RT-stale" }));

    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    expect(staleBodyCancelled).toBe(true);
  });
});
