/**
 * Item 5 (account loop) — chat.js must count a mid-stream upstream failure
 * toward the account breaker and label it as an upstream error, while a real
 * client close still settles as "client disconnect" and counts nothing.
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
  updateProviderCredentials: vi.fn(),
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
import * as log from "@/sse/utils/logger.js";
import {
  getCircuitBreaker,
  buildAccountBreakerName,
  resetAllCircuitBreakers,
  shouldRecordBreakerFailure,
  STATE,
} from "../../open-sse/utils/circuitBreaker.js";

const PROVIDER = "glm";
const MODEL = "glm-4";
const MODEL_STR = `${PROVIDER}/${MODEL}`;
const ACC_1 = "acc-stream-error";

function chatRequest() {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL_STR, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
}

function credentials() {
  return {
    apiKey: "test-key",
    connectionId: ACC_1,
    connectionName: ACC_1,
    providerSpecificData: { maxConcurrency: 1 },
  };
}

function breakerOpts(overrides = {}) {
  return {
    failureThreshold: 1,
    resetTimeout: 30_000,
    failureWindowMs: 120_000,
    isFailure: (err) => shouldRecordBreakerFailure(err?.statusCode),
    ...overrides,
  };
}

describe("chat.js — mid-stream upstream error counts toward the breaker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllCircuitBreakers();
    process.env.ACCOUNT_CAPACITY_WAIT_MS = "300";
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getModelInfo.mockResolvedValue({ provider: PROVIDER, model: MODEL });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.checkAndRefreshToken.mockImplementation(async (_p, creds) => creds);
    // One account only: a missing onStreamError must fail the assertion, not
    // spin the loop on the same credential.
    mocks.getProviderCredentials.mockImplementation(async (_provider, exclude) => {
      const excluded = exclude instanceof Set ? exclude : new Set();
      return excluded.has(ACC_1) ? null : credentials();
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
  });

  it("onStreamError records a breaker failure and logs it as an upstream error", async () => {
    const name = buildAccountBreakerName({ provider: PROVIDER, connectionId: ACC_1, model: MODEL });
    getCircuitBreaker(name, breakerOpts());
    mocks.handleChatCore.mockImplementation(async (args) => {
      args.onStreamError(new Error("socket hang up"));
      return { success: true, response: new Response("sse", { headers: { "Content-Type": "text/event-stream" } }) };
    });

    const response = await handleChat(chatRequest());
    expect(response.status).toBe(200);
    expect(getCircuitBreaker(name).getStatus().state).toBe(STATE.OPEN);

    const warned = log.warn.mock.calls.flat().join("\n");
    expect(warned).toContain("upstream stream error");
    expect(warned).toContain("socket hang up");
  });

  it("onDisconnect (real client close) records no breaker failure", async () => {
    const name = buildAccountBreakerName({ provider: PROVIDER, connectionId: ACC_1, model: MODEL });
    getCircuitBreaker(name, breakerOpts());
    mocks.handleChatCore.mockImplementation(async (args) => {
      args.onDisconnect();
      return { success: true, response: new Response("sse", { headers: { "Content-Type": "text/event-stream" } }) };
    });

    await handleChat(chatRequest());
    expect(getCircuitBreaker(name).getStatus().state).toBe(STATE.CLOSED);
    expect(getCircuitBreaker(name).getStatus().failureCount).toBe(0);
  });
});
