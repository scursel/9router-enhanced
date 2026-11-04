import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  rows: [],
  settings: {},
  attempted: [],
  core: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  validate: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: state.read,
  updateProviderConnection: state.write,
  validateApiKey: state.validate,
  getSettings: async () => state.settings,
  getProxyPools: async () => [],
  getProviderConnectionById: async (id) =>
    state.rows.find((row) => row.id === id) || null,
  getComboByName: async () => null,
  getCombos: async () => [],
  getModelAliases: async () => ({}),
  getProviderNodes: async () => [],
}));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeyByKey: async () => null,
}));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => [] }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: async () => ({}),
  pickProxyPoolId: () => null,
}));
vi.mock("@/sse/services/model.js", () => ({
  getComboModels: async (model) =>
    model === "account-combo" ? ["openai/primary", "glm/backup"] : null,
  getModelInfo: async (model) => {
    const [provider, ...rest] = model.split("/");
    return rest.length
      ? { provider, model: rest.join("/") }
      : { provider: null, model: null };
  },
}));
vi.mock("@/sse/services/tokenRefresh.js", async (original) => ({
  ...(await original()),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: async () => null,
  clearAntigravityStrikes: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: state.core,
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/pxpipe/loader.js", () => ({
  getTransform: async () => null,
  getPxpipeTransform: async () => null,
}));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({
  request: (value) => value,
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: () => "masked",
  line: vi.fn(),
  errorLine: vi.fn(),
  tagForSession: () => "[test]",
  nextTag: () => "[test]",
}));
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: async () => {},
  appendRequestLog: async () => {},
  saveRequestDetail: async () => {},
  getUsageHistory: async () => [],
  getUsageStats: async () => ({}),
  getChartData: async () => [],
  getRecentLogs: async () => [],
  trackPendingRequest: vi.fn(),
  getActiveRequests: async () => ({
    activeRequests: [],
    recentRequests: [],
    errorProvider: "",
  }),
  drainPendingUsage: async () => ({ drained: 0 }),
  statsEmitter: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
  },
}));
import { handleChat } from "@/sse/handlers/chat.js";
import { getProviderCredentials } from "@/sse/services/auth.js";
import { resetComboRotation } from "../../open-sse/services/combo.js";
import {
  getAllCircuitBreakerStatuses,
  resetAllCircuitBreakers,
} from "../../open-sse/utils/circuitBreaker.js";
import { getAccountSemaphoreStats } from "../../open-sse/services/accountSemaphore.js";
const account = (id, provider, priority) => ({
  id,
  provider,
  priority,
  name: id,
  authType: "apikey",
  apiKey: "k",
  isActive: true,
  providerSpecificData: { maxConcurrency: 1 },
});
const ok = (text) => ({
  success: true,
  response: new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  ),
});
const failed = (status, message) => ({
  success: false,
  status,
  error: message,
  response: new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  }),
});
const request = (model = "account-combo", key = null) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
function responses(map) {
  state.core.mockImplementation(async ({ credentials, onRequestSuccess }) => {
    const id = credentials.connectionId;
    state.attempted.push(id);
    const value = map[id];
    if (value.success) {
      await onRequestSuccess?.();
      return ok(id);
    }
    return failed(value.status, value.message);
  });
}
const unauthorized = { status: 401, message: "Invalid API key provided" },
  success = { success: true },
  unavailable = { status: 503, message: "offline backup unavailable" };
beforeEach(() => {
  vi.clearAllMocks();
  resetComboRotation();
  resetAllCircuitBreakers();
  state.rows = [
    account("A", "openai", 1),
    account("B", "openai", 2),
    account("C", "glm", 1),
  ];
  state.settings = {
    requireApiKey: false,
    fallbackStrategy: "fill-first",
    comboStrategy: "fallback",
  };
  state.attempted = [];
  state.read.mockImplementation(async ({ provider, isActive } = {}) =>
    state.rows.filter(
      (row) =>
        (!provider || row.provider === provider) &&
        (isActive === undefined || row.isActive === isActive),
    ),
  );
  state.write.mockImplementation(async (id, patch) => {
    const row = state.rows.find((candidate) => candidate.id === id);
    Object.assign(row, patch);
    return row;
  });
  state.validate.mockResolvedValue(false);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected external call");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each(["openai/primary", "account-combo"])(
  "tries healthy sibling before backup for %s",
  async (model) => {
    responses({ A: unauthorized, B: success, C: unavailable });
    const response = await handleChat(request(model));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"content":"B"');
    expect(state.attempted).toEqual(["A", "B"]);
    expect(state.rows[0].modelLock_primary).toBeTruthy();
    expect(state.rows[1].modelLock_primary).toBeUndefined();
  },
);
it.each([
  [success, 200],
  [unavailable, 503],
])("exhausts both invalid accounts before backup", async (backup, status) => {
  responses({ A: unauthorized, B: unauthorized, C: backup });
  const response = await handleChat(request());
  expect(response.status).toBe(status);
  expect(state.attempted).toEqual(["A", "B", "C"]);
  if (status === 503) expect(await response.text()).toContain("primary");
});
it("exhausting all invalid accounts terminates with an unavailable error", async () => {
  responses({ A: unauthorized, B: unauthorized });
  const response = await handleChat(request("openai/primary"));
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("Invalid API key");
  expect(state.attempted).toEqual(["A", "B"]);
  for (const breaker of getAllCircuitBreakerStatuses()) {
    expect(breaker.failureCount).toBe(0);
    expect(breaker.state).toBe("CLOSED");
  }
});
it("scopes and expires cooldown, and releases semaphores", async () => {
  responses({ A: unauthorized, B: success, C: unavailable });
  await handleChat(request("openai/primary"));
  await handleChat(request("openai/primary"));
  expect(state.attempted).toEqual(["A", "B", "B"]);
  expect(
    (await getProviderCredentials("openai", new Set(), "other")).connectionId,
  ).toBe("A");
  const expiry = new Date(state.rows[0].modelLock_primary).getTime();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(expiry + 1);
  expect(
    (await getProviderCredentials("openai", new Set(), "primary")).connectionId,
  ).toBe("A");
  for (const gate of Object.values(getAccountSemaphoreStats())) {
    expect(gate.running).toBe(0);
    expect(gate.queued).toBe(0);
  }
});
it("rejects missing and invalid client keys before selecting providers", async () => {
  state.settings.requireApiKey = true;
  expect((await handleChat(request())).status).toBe(401);
  expect(
    (await handleChat(request("account-combo", "client-invalid"))).status,
  ).toBe(401);
  expect(state.core).not.toHaveBeenCalled();
  expect(state.read).not.toHaveBeenCalled();
  expect(state.write).not.toHaveBeenCalled();
});
it.each([
  ["openai/primary", 400, ["A"]],
  ["account-combo", 200, ["A", "C"]],
])(
  "request-scoped 400 does not rotate accounts for %s",
  async (model, status, tried) => {
    responses({
      A: { status: 400, message: "Invalid messages" },
      B: success,
      C: success,
    });
    expect((await handleChat(request(model))).status).toBe(status);
    expect(state.attempted).toEqual(tried);
    expect(state.rows[0].modelLock_primary).toBeUndefined();
    expect(state.rows[1].modelLock_primary).toBeUndefined();
  },
);
it("refresh callback preserves another model's lock", async () => {
  state.rows[0].authType = "oauth";
  state.rows[0].modelLock_other = new Date(Date.now() + 60000).toISOString();
  const lock = state.rows[0].modelLock_other;
  state.core.mockImplementation(
    async ({ credentials, onCredentialsRefreshed, onRequestSuccess }) => {
      state.attempted.push(credentials.connectionId);
      await onCredentialsRefreshed(
        { accessToken: "AT-fresh" },
        { model: "primary" },
      );
      await onRequestSuccess?.();
      return ok("A");
    },
  );
  expect((await handleChat(request("openai/primary"))).status).toBe(200);
  expect(state.attempted).toEqual(["A"]);
  expect(state.rows[0].modelLock_other).toBe(lock);
  expect(
    state.write.mock.calls.every(([, patch]) => patch.testStatus !== "active"),
  ).toBe(true);
});
