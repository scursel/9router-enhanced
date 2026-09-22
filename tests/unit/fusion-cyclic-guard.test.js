/**
 * The cyclic-combo guard lives in handleSingleModelChat and reads the chain
 * of combos already expanded from attemptUsage.comboPath. The fusion branch
 * called handleSingleModelChat without it, so the chain reset to [] at every
 * fusion hop: a fusion combo listing itself (legacy rows, synced data) fanned
 * out until the process ran out of memory.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(async () => {}),
  clearAntigravityStrikes: vi.fn(),
  extractApiKey: vi.fn(() => "client-key"),
  isValidApiKey: vi.fn(async () => true),
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getComboByName: vi.fn(async () => null),
  getCombos: vi.fn(async () => []),
  checkAndRefreshToken: vi.fn(async (_p, creds) => creds),
  updateProviderCredentials: vi.fn(async () => {}),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(async () => null),
  getProviderNodes: vi.fn(async () => []),
  handleChatCore: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
  appendRequestLog: mocks.appendRequestLog,
  saveRequestDetail: mocks.saveRequestDetail,
  getUsageHistory: vi.fn(async () => []),
  getUsageStats: vi.fn(async () => ({})),
  getChartData: vi.fn(async () => []),
  getRecentLogs: vi.fn(async () => []),
  getActiveRequests: vi.fn(async () => ({ activeRequests: [], recentRequests: [], errorProvider: "" })),
  trackPendingRequest: vi.fn(),
  statsEmitter: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn(), setMaxListeners: vi.fn() },
  drainPendingUsage: vi.fn(async () => ({ drained: 0 })),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  clearAntigravityStrikes: mocks.clearAntigravityStrikes,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(async () => null),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getComboByName: mocks.getComboByName,
  getCombos: mocks.getCombos,
  getProviderConnectionById: vi.fn(async () => null),
  getModelAliases: vi.fn(async () => ({})),
  getProviderNodes: mocks.getProviderNodes,
}));

vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn((x) => x), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  maskKey: vi.fn(() => "masked"), line: vi.fn(), errorLine: vi.fn(),
  tagForSession: vi.fn(() => "[t]"), nextTag: vi.fn(() => "[t]"),
}));

vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null), getPxpipeTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

import { handleChat } from "@/sse/handlers/chat.js";
import { resetComboRotation } from "../../open-sse/services/combo.js";
import { resetAllCircuitBreakers } from "../../open-sse/utils/circuitBreaker.js";


const jsonOk = (text = "hi") => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }), {
  status: 200, headers: { "Content-Type": "application/json" },
});

const chatRequest = (model) => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
});

const COMBOS = { LOOP: ["LOOP", "glm/glm-4"] };
let comboLookups = 0;

beforeEach(() => {
  vi.clearAllMocks();
  resetComboRotation();
  resetAllCircuitBreakers();
  comboLookups = 0;
  mocks.getSettings.mockResolvedValue({ requireApiKey: false, comboStrategies: { LOOP: { fallbackStrategy: "fusion" } } });
  mocks.getComboModels.mockImplementation(async (m) => {
    // Safety net so a regression fails instead of exhausting the heap.
    if (++comboLookups > 50) throw new Error("runaway combo expansion");
    return COMBOS[m] || null;
  });
  mocks.getModelInfo.mockImplementation(async (m) => {
    if (COMBOS[m]) return { provider: null, model: null };
    const [provider, ...rest] = m.split("/");
    return { provider, model: rest.join("/") };
  });
  mocks.getProviderCredentials.mockImplementation(async (provider, exclude) => {
    const id = `conn-${provider}`;
    if (exclude instanceof Set && exclude.has(id)) return null;
    return { apiKey: "k", connectionId: id, connectionName: id, providerSpecificData: { maxConcurrency: 4 } };
  });
  mocks.checkAndRefreshToken.mockImplementation(async (_p, c) => c);
  mocks.handleChatCore.mockImplementation(async () => ({ success: true, response: jsonOk() }));
});

describe("fusion keeps the cyclic-combo guard", () => {
  it("a fusion combo listing itself terminates", async () => {
    const res = await handleChat(chatRequest("LOOP"));
    expect(res.status).toBe(200);
    expect(comboLookups).toBeLessThan(10);
  });

  it("fusion panel calls are not attributed to a combo usage line", async () => {
    await handleChat(chatRequest("LOOP"));
    for (const [args] of mocks.handleChatCore.mock.calls) expect(args.comboName ?? null).toBe(null);
  });
});
