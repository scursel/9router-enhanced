/**
 * Item 1 (account loop) — a client that disconnects before the first byte must
 * release the account semaphore slot exactly once, record no account lock, and
 * stop a combo from dispatching the next member.
 *
 * The chatCore module is mocked here: these assertions are about chat.js's
 * handling of the `clientAborted` result and of `request.signal`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { resetAllCircuitBreakers, getCircuitBreaker, buildAccountBreakerName, STATE } from "../../open-sse/utils/circuitBreaker.js";
import { acquire, resolveAccountSemaphoreKey } from "../../open-sse/services/accountSemaphore.js";

const PROVIDER = "glm";
const MODEL = "glm-4";
const MODEL_STR = `${PROVIDER}/${MODEL}`;
const ACC_1 = "acc-abort-one";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chatRequest({ signal } = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL_STR,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal,
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

async function expectSlotReleasedExactlyOnce(connectionId) {
  const key = resolveAccountSemaphoreKey({ provider: PROVIDER, connectionId });
  const release = await acquire(key, { maxConcurrency: 1, timeoutMs: 50 });
  // A second acquire must NOT fit: a double release would have freed two slots.
  await expect(acquire(key, { maxConcurrency: 1, timeoutMs: 30 })).rejects.toThrow(/capacity/i);
  release();
}

function abortAwareChatCore(calls) {
  return async (args) => {
    calls.push(args.connectionId);
    await new Promise((resolve) => {
      if (args.clientSignal?.aborted) return resolve();
      args.clientSignal?.addEventListener("abort", resolve, { once: true });
      // Never resolves on its own: the test drives the abort.
    });
    return {
      success: false,
      status: 499,
      error: "Request aborted",
      clientAborted: true,
      response: new Response(JSON.stringify({ error: { message: "Request aborted" } }), {
        status: 499,
        headers: { "content-type": "application/json" },
      }),
    };
  };
}

describe("chat.js — client abort releases the account exactly once and records no penalty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllCircuitBreakers();
    process.env.ACCOUNT_CAPACITY_WAIT_MS = "300";
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getModelInfo.mockResolvedValue({ provider: PROVIDER, model: MODEL });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.checkAndRefreshToken.mockImplementation(async (_p, creds) => creds);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
  });

  afterEach(() => {
    delete process.env.ACCOUNT_CAPACITY_WAIT_MS;
  });

  it("passes request.signal down, releases the slot once, and locks nothing", async () => {
    mocks.getProviderCredentials.mockResolvedValue(credentials(ACC_1));
    const calls = [];
    mocks.handleChatCore.mockImplementation(abortAwareChatCore(calls));

    const controller = new AbortController();
    const pending = handleChat(chatRequest({ signal: controller.signal }));
    await sleep(30);
    controller.abort();

    const response = await Promise.race([pending, sleep(1000).then(() => "HUNG")]);
    expect(response).not.toBe("HUNG");
    expect(response.status).toBe(499);
    expect(calls).toEqual([ACC_1]);
    expect(mocks.handleChatCore.mock.calls[0][0].clientSignal).toBeDefined();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    await expectSlotReleasedExactlyOnce(ACC_1);

    const breaker = getCircuitBreaker(buildAccountBreakerName({ provider: PROVIDER, connectionId: ACC_1, model: MODEL }));
    expect(breaker?.getStatus().state ?? STATE.CLOSED).toBe(STATE.CLOSED);
  });

  it("a throw that surfaces after the client left is a 499, not an account failure", async () => {
    mocks.getProviderCredentials.mockImplementation(async (_provider, exclude) => {
      const excluded = exclude instanceof Set ? exclude : new Set();
      return excluded.has(ACC_1) ? null : credentials(ACC_1);
    });
    mocks.handleChatCore.mockImplementation(async (args) => {
      await new Promise((resolve) => {
        if (args.clientSignal?.aborted) return resolve();
        args.clientSignal?.addEventListener("abort", resolve, { once: true });
      });
      throw new Error("socket hang up");
    });

    const controller = new AbortController();
    const pending = handleChat(chatRequest({ signal: controller.signal }));
    await sleep(30);
    controller.abort();

    const response = await Promise.race([pending, sleep(1000).then(() => "HUNG")]);
    expect(response).not.toBe("HUNG");
    expect(response.status).toBe(499);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    await expectSlotReleasedExactlyOnce(ACC_1);
  });

  it("a combo does not dispatch the next member after the client leaves", async () => {
    mocks.getComboModels.mockResolvedValue([`${PROVIDER}/${MODEL}`, `${PROVIDER}/glm-4b`]);
    mocks.getProviderCredentials.mockResolvedValue(credentials(ACC_1));
    const calls = [];
    mocks.handleChatCore.mockImplementation(abortAwareChatCore(calls));

    const controller = new AbortController();
    const pending = handleChat(chatRequest({ signal: controller.signal }));
    await sleep(30);
    controller.abort();

    const response = await Promise.race([pending, sleep(1000).then(() => "HUNG")]);
    expect(response).not.toBe("HUNG");
    expect(response.status).toBe(499);
    // Only the member that was already in flight; the second never dispatches.
    expect(calls).toEqual([ACC_1]);
    await expectSlotReleasedExactlyOnce(ACC_1);
  });
});
