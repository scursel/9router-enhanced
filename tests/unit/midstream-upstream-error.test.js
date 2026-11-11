/**
 * Item 5 — a stream that dies after the first byte is an UPSTREAM failure, not
 * a client disconnect. chatCore routed onError to onDisconnect, so chat.js
 * settled the breaker probe as "client disconnect" and never counted a
 * failure: an account whose streams die mid-flight was never penalised and the
 * log blamed the client.
 *
 * Scope: breaker signal + label only. No account lock is added for mid-stream
 * failures (that is a larger behaviour change).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const { createStreamControllerMock, executeMock } = vi.hoisted(() => ({
  createStreamControllerMock: vi.fn(),
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: (options) => {
    createStreamControllerMock(options);
    return {
      signal: new AbortController().signal,
      startTime: Date.now(),
      isConnected: () => true,
      handleDisconnect: vi.fn(),
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      abort: vi.fn(),
    };
  },
}));

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

function coreArgs(overrides = {}) {
  return {
    body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hi" }] },
    modelInfo: { provider: "testprov", model: "m" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    connectionId: "conn-stream-error",
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
    ...overrides,
  };
}

function jsonOk() {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
    headers: { "content-type": "application/json" },
  });
}

describe("chatCore — mid-stream error routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({ response: jsonOk(), url: "https://up.test/x", headers: {}, transformedBody: null });
  });

  it("routes an upstream stream error to onStreamError, not onDisconnect", async () => {
    const onDisconnect = vi.fn();
    const onStreamError = vi.fn();
    await handleChatCore(coreArgs({ onDisconnect, onStreamError }));

    const options = createStreamControllerMock.mock.calls[0][0];
    const error = new Error("socket hang up");
    options.onError(error);

    expect(onStreamError).toHaveBeenCalledWith(error);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("keeps a client abort on the disconnect path", async () => {
    const controller = new AbortController();
    const onDisconnect = vi.fn();
    const onStreamError = vi.fn();
    await handleChatCore(coreArgs({ clientSignal: controller.signal, onDisconnect, onStreamError }));

    const options = createStreamControllerMock.mock.calls[0][0];
    controller.abort();
    const error = new Error("aborted");
    options.onError(error);

    expect(onDisconnect).toHaveBeenCalledWith(error);
    expect(onStreamError).not.toHaveBeenCalled();
  });
});
