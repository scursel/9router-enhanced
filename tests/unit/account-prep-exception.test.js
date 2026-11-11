/**
 * Item 4 — exceptions while PREPARING one account (credential lookup, token
 * refresh, project-id lookup) used to escape the account loop: they ran before
 * the per-attempt try, so a throw became a 500 for a single model or skipped a
 * whole combo member (including its healthy sibling accounts).
 *
 * Contract: a failure preparing ONE account excludes only that account; the
 * loop continues. A lookup that cannot be attributed to an account (or one we
 * already excluded) ends the loop with the existing 503 instead of spinning.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleChatCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  getProjectIdForConnection: vi.fn(),
  handleAntigravityQuotaError: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getCombos: vi.fn(),
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(async () => {}),
}));

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: mocks.getProjectIdForConnection,
}));

vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
  line: vi.fn(),
  errorLine: vi.fn(),
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: mocks.handleAntigravityQuotaError,
}));

vi.mock("@/lib/pxpipe/loader.js", () => ({
  getTransform: vi.fn(async () => null),
}));

vi.mock("@/lib/pxpipe/events.js", () => ({
  appendPxpipeEvent: vi.fn(),
}));

import { handleChat } from "@/sse/handlers/chat.js";
import { resetAllCircuitBreakers } from "../../open-sse/utils/circuitBreaker.js";

const PROVIDER = "glm";
const MODEL = "glm-4";
const MODEL_STR = `${PROVIDER}/${MODEL}`;
const ACC_1 = "acc-prep-one";
const ACC_2 = "acc-prep-two";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chatRequest(model = MODEL_STR) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
}

function credentials(connectionId) {
  return {
    apiKey: "test-key",
    connectionId,
    connectionName: connectionId,
    providerSpecificData: { maxConcurrency: 1 },
  };
}

function stubTwoAccounts() {
  mocks.getProviderCredentials.mockImplementation(async (_provider, exclude) => {
    const excluded = exclude instanceof Set ? exclude : new Set();
    if (!excluded.has(ACC_1)) return credentials(ACC_1);
    if (!excluded.has(ACC_2)) return credentials(ACC_2);
    return null;
  });
}

describe("chat.js — an exception preparing one account excludes only that account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllCircuitBreakers();
    process.env.ACCOUNT_CAPACITY_WAIT_MS = "300";
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getModelInfo.mockResolvedValue({ provider: PROVIDER, model: MODEL });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.getProjectIdForConnection.mockResolvedValue(null);
    mocks.handleChatCore.mockResolvedValue({ success: true, response: new Response("ok", { status: 200 }) });
  });

  it("token refresh throwing for account 1 → account 2 answers", async () => {
    stubTwoAccounts();
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, creds) => {
      if (creds.connectionId === ACC_1) throw new Error("db write failed");
      return creds;
    });

    const response = await handleChat(chatRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore.mock.calls[0][0].connectionId).toBe(ACC_2);
  });

  it("project-id lookup throwing for account 1 → account 2 answers", async () => {
    stubTwoAccounts();
    mocks.getModelInfo.mockResolvedValue({ provider: "antigravity", model: "gemini-3" });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, creds) => creds);
    mocks.getProjectIdForConnection.mockImplementation(async (connectionId) => {
      if (connectionId === ACC_1) throw new Error("project lookup failed");
      return "proj-2";
    });

    const response = await handleChat(chatRequest("antigravity/gemini-3"));
    expect(response.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore.mock.calls[0][0].connectionId).toBe(ACC_2);
  });

  it("a throwing credential lookup is bounded and answers 503 (never spins)", async () => {
    mocks.getProviderCredentials.mockRejectedValue(new Error("credentials db down"));

    const response = await Promise.race([handleChat(chatRequest()), sleep(1000).then(() => "HUNG")]);
    expect(response).not.toBe("HUNG");
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toContain("credentials db down");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("every account failing preparation → the existing all-accounts-unavailable 503", async () => {
    stubTwoAccounts();
    mocks.checkAndRefreshToken.mockRejectedValue(new Error("refresh exploded"));

    const response = await handleChat(chatRequest());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toContain("refresh exploded");
    // Each account is tried at most once.
    expect(mocks.checkAndRefreshToken).toHaveBeenCalledTimes(2);
  });
});
