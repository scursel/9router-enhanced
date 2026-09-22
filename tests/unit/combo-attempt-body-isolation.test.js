/**
 * A combo retries the SAME client body on every member (and every account of a
 * member). chatCore's normalizers write into nested objects in place —
 * stripUnsupportedModalities reassigns msg.content, prepareClaudeRequest
 * deletes cache_control / injects thinking placeholders, applyThinking edits
 * generationConfig. With only a shallow `{ ...body }` per attempt, whatever
 * member A did to `messages` reached member B: a non-vision member that failed
 * left image placeholders for the vision fallback. Each attempt must get its
 * own deep copy.
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

const COMBO = "cb2-plumbing";

// Combo table for this file. Lookups are keyed by string and never include a
// combo as one of its own members, so the nested branch below is exactly one
// level deep (an unbounded mock here makes chat.js recurse until the heap dies).
const COMBOS = {
  [COMBO]: ["grok/grok-3", "glm/glm-4"],
  "outer-combo": ["inner-combo", "glm/glm-4"],
  "inner-combo": ["grok/grok-3"],
};

const chatRequest = (model) => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
});

const jsonOk = () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }), {
  status: 200, headers: { "Content-Type": "application/json" },
});

const failCore = (status, error = "boom") => ({
  success: false, status, error, response: new Response(error, { status }),
});

beforeEach(() => {
  vi.clearAllMocks();
  resetComboRotation();
  resetAllCircuitBreakers();
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.getComboModels.mockImplementation(async (m) => COMBOS[m] || null);
  mocks.getModelInfo.mockImplementation(async (m) => {
    if (COMBOS[m]) return { provider: null, model: null };
    const [provider, ...rest] = m.split("/");
    return { provider, model: rest.join("/") };
  });
  // Real semantics: an excluded connection must NOT be handed back, otherwise
  // chat.js's account loop would re-pick it forever.
  mocks.getProviderCredentials.mockImplementation(async (provider, exclude) => {
    const id = `conn-${provider}`;
    if (exclude instanceof Set && exclude.has(id)) return null;
    return {
      apiKey: "k", accessToken: "t", connectionId: id,
      connectionName: `acc-${id}`, providerSpecificData: { maxConcurrency: 4 },
    };
  });
  mocks.checkAndRefreshToken.mockImplementation(async (_p, c) => c);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
});


const imageRequest = (model) => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "https://x/y.png" } }] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "and now?" },
    ],
    generationConfig: { thinkingConfig: { thinkingBudget: 32768 } },
  }),
});

describe("combo attempts do not share nested body state", () => {
  it("member A's in-place edits never reach member B", async () => {
    const seen = [];
    mocks.handleChatCore.mockImplementation(async ({ body, modelInfo }) => {
      seen.push(JSON.parse(JSON.stringify({ messages: body.messages, generationConfig: body.generationConfig })));
      if (modelInfo.provider === "grok") {
        // what the real normalizers do to a non-vision / non-thinking member
        body.messages[0].content = [{ type: "text", text: "[Previous image omitted]" }];
        body.generationConfig.thinkingConfig = {};
        return failCore(503, "upstream 503");
      }
      return { success: true, response: jsonOk() };
    });

    const res = await handleChat(imageRequest(COMBO));
    expect(res.status).toBe(200);
    expect(seen.length).toBe(2);
    expect(seen[1], "member B sees the client's body, not member A's leftovers").toEqual(seen[0]);
    expect(seen[1].messages[0].content[1].type).toBe("image_url");
    expect(seen[1].generationConfig.thinkingConfig.thinkingBudget).toBe(32768);
  });

  it("account retries of the same member also start from the client's body", async () => {
    let n = 0;
    const seen = [];
    mocks.getProviderCredentials.mockImplementation(async (provider, exclude) => {
      const id = exclude?.has?.("conn-a") ? "conn-b" : "conn-a";
      if (exclude?.has?.(id)) return null;
      return { apiKey: "k", connectionId: id, connectionName: id, providerSpecificData: { maxConcurrency: 4 } };
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.handleChatCore.mockImplementation(async ({ body }) => {
      seen.push(JSON.stringify(body.messages));
      if (n++ === 0) {
        body.messages[0].content = "mutated";
        return failCore(429, "rate limited");
      }
      return { success: true, response: jsonOk() };
    });

    const res = await handleChat(imageRequest("glm/glm-4"));
    expect(res.status).toBe(200);
    expect(seen.length).toBe(2);
    expect(seen[1]).toBe(seen[0]);
  });
});
