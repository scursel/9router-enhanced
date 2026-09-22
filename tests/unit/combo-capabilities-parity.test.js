/**
 * /v1/models and the dashboard combo cards used two different merges (the
 * dashboard took reasoning from the first member and the MAX output; the API
 * required every member to reason and took the MIN), so a combo showed
 * "reasoning, max 128k" in the UI while clients got "no reasoning, max 16k".
 * Both now call aggregateComboCapabilities with the same member resolver.
 */
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
import { aggregateComboCapabilities } from "../../open-sse/providers/capabilities.js";
import { makeComboMemberResolver } from "../../src/shared/utils/comboMemberResolver.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnections.mockResolvedValue([
    { id: "cx-1", provider: "codex", isActive: true, providerSpecificData: {}, modelCatalog: null },
  ]);
  mocks.getCustomModels.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue({});
});


const CONNECTIONS = [
  { id: "cx-1", provider: "codex", isActive: true, providerSpecificData: {}, modelCatalog: null },
  { id: "cl-1", provider: "claude", isActive: true, providerSpecificData: { prefix: "work" }, modelCatalog: null },
  { id: "oa-1", provider: "openai", isActive: true, providerSpecificData: {}, modelCatalog: null },
];
const ALIASES = { quick: "openai/gpt-4o-mini" };

async function entryFor(name, models, combos = []) {
  mocks.getCombos.mockResolvedValue([{ id: "c1", name, models }, ...combos]);
  const list = await buildModelsList(["llm"]);
  return list.find((m) => m.id === name);
}

describe("/v1/models combo capabilities match the dashboard", () => {
  beforeEach(() => {
    mocks.getProviderConnections.mockResolvedValue(CONNECTIONS);
    mocks.getModelAliases.mockResolvedValue(ALIASES);
  });

  const cases = [
    ["reasoning primary + non-reasoning fallback", ["work/claude-sonnet-5", "quick"]],
    ["custom connection prefix + alias + nested combo", ["inner", "quick"]],
    ["only non-reasoning", ["openai/gpt-4o-mini"]],
  ];

  for (const [label, models] of cases) {
    it(label, async () => {
      const inner = { id: "c2", name: "inner", models: ["work/claude-sonnet-5"] };
      const entry = await entryFor("PARITY", models, [inner]);
      const dashboard = aggregateComboCapabilities(models, { PARITY: models, inner: inner.models }, {
        resolveMember: makeComboMemberResolver(CONNECTIONS, ALIASES),
      });
      expect(entry.capabilities).toEqual({ ...dashboard });
      expect(entry.context_length).toBe(dashboard.contextWindow);
      expect(entry.max_completion_tokens).toBe(dashboard.maxOutput);
    });
  }

  it("a reasoning primary with a non-reasoning fallback is advertised as reasoning, limits at the minimum", async () => {
    const entry = await entryFor("MIX", ["work/claude-sonnet-5", "quick"]);
    expect(entry.capabilities.reasoning).toBe(true);
    expect(entry.context_length).toBe(128000);
    expect(entry.max_completion_tokens).toBe(16384);
  });
});
