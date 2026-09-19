import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock all localDb access used by buildModelsList + getComboModels
const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getComboByName: vi.fn(),
  getProviderNodes: vi.fn(),
  getProviderConnectionById: vi.fn(),
  getDisabledModels: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
  getComboByName: mocks.getComboByName,
  getProviderNodes: mocks.getProviderNodes,
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));
// catalogOverride: no models.dev overlay by default
vi.mock("open-sse/providers/catalogOverride.js", () => ({
  getCatalogCost: vi.fn(() => null),
}));

// Live resolvers — keep null unless test needs them
vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/copilotModels.js", () => ({ resolveCopilotModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/clinepassModels.js", () => ({ resolveClinepassModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/grokCliModels.js", () => ({ resolveGrokCliModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/cursorModels.js", () => ({ resolveCursorModels: vi.fn(async () => null) }));
vi.mock("open-sse/shared/zedAuth.js", () => ({ resolveZedModels: vi.fn(async () => null) }));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: vi.fn(async () => {}) }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));

import { buildModelsList } from "../../src/app/api/v1/models/route.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnections.mockResolvedValue([
    { id: "cx-1", provider: "codex", isActive: true, providerSpecificData: {}, modelCatalog: null },
  ]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
});

async function comboEntry(models) {
  mocks.getCombos.mockResolvedValue([{ id: "c1", name: "LUNA", models }]);
  const list = await buildModelsList(["llm"]);
  return list.find((m) => m.id === "LUNA");
}

// A combo advertises the smallest member window. With the Codex base id that is
// the 272K Codex advertises; the opt-in -900k member lifts the combo to 900K.
describe("combo context window with Codex members", () => {
  it("a combo of cx/gpt-5.6-luna advertises Codex's 272K", async () => {
    expect((await comboEntry(["cx/gpt-5.6-luna"])).context_length).toBe(272000);
  });

  it("a combo of cx/gpt-5.6-luna-900k advertises 900K", async () => {
    expect((await comboEntry(["cx/gpt-5.6-luna-900k"])).context_length).toBe(900000);
  });
});
