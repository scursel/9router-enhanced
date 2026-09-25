// Reactive 401/403 refresh only runs when the executor can actually refresh.
//
// Found while comparing combo fallback speed: an API-key provider answering
// 403 "Free quota exhausted" went through refreshWithRetry, whose refresh
// always returns null for such credentials — 3 attempts, 0+1+2 s of backoff
// burned before the combo could move on (measured live: 9.6 s for a 4 s 403).
import { describe, it, expect, vi, beforeEach } from "vitest";

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
const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { VertexExecutor } = await import("../../open-sse/executors/vertex.js");

function forbidden() {
  return new Response(JSON.stringify({ error: { message: "Free quota exhausted" } }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

function chatArgs(credentials) {
  return {
    body: { model: "glm", stream: false, messages: [{ role: "user", content: "hi" }] },
    modelInfo: { provider: "refreshcap", model: "glm" },
    credentials,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    connectionId: "conn-rc",
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
  };
}

describe("chatCore — 401/403 refresh gated by executor.canRefreshCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockImplementation(async () => ({ response: forbidden(), url: "https://up/x", headers: {}, transformedBody: null }));
    refreshMock.mockResolvedValue(null);
  });

  it("skips the refresh (and its backoff) when the executor cannot refresh these credentials", async () => {
    canRefreshMock.mockReturnValue(false);
    const t0 = Date.now();
    const r = await handleChatCore(chatArgs({ apiKey: "k", connectionId: "conn-rc" }));
    expect(r.success).toBe(false);
    expect(r.status).toBe(403);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it("still refreshes when the executor can", async () => {
    canRefreshMock.mockReturnValue(true);
    refreshMock.mockResolvedValue(null);
    await handleChatCore(chatArgs({ accessToken: "a", refreshToken: "r", connectionId: "conn-rc" }));
    expect(refreshMock).toHaveBeenCalled();
  });
});

describe("executor.canRefreshCredentials", () => {
  it("BaseExecutor never can (its refreshCredentials always returns null)", () => {
    expect(new BaseExecutor("x", { baseUrl: "https://x" }).canRefreshCredentials({ apiKey: "k" })).toBe(false);
  });

  it("DefaultExecutor: only with a refresh token", () => {
    const ex = new DefaultExecutor("openai-compatible-chat-abc");
    expect(ex.canRefreshCredentials({ apiKey: "k" })).toBe(false);
    expect(ex.canRefreshCredentials({ accessToken: "a", refreshToken: "r" })).toBe(true);
  });

  it("an executor with its own refresh keeps refreshing (vertex refreshes from the SA key)", () => {
    expect(new VertexExecutor().canRefreshCredentials({ apiKey: "{}" })).toBe(true);
  });
});
