import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  LIVE_CATALOG_PROVIDERS,
  liveModelCaps,
  buildModelGroups,
} from "../../src/shared/utils/selectableModels.js";
import { ANTIGRAVITY_QUOTA_MODELS } from "../../open-sse/services/usage/google.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { isUsageEligible } from "../../src/lib/usageEligibility.js";

// Pins the conflict decisions of the upstream v0.5.123 sync. Red until the merge lands.
describe("upstream v0.5.123 sync decisions", () => {
  it("live catalog list is the union", () => {
    expect([...LIVE_CATALOG_PROVIDERS].sort()).toEqual(
      ["claude", "cline", "clinepass", "commandcode", "cursor", "qoder", "qoder-cn", "zed"].sort()
    );
  });

  it("ModelSelectModal has no local copy of the list", () => {
    const file = path.resolve(import.meta.dirname, "../../src/shared/components/ModelSelectModal.js");
    const source = fs.readFileSync(file, "utf8");
    expect(source).not.toMatch(/const LIVE_CATALOG_PROVIDERS\s*=/);
  });

  it("liveModelCaps maps live row fields", () => {
    expect(liveModelCaps({ isVL: true, contextLength: 1000 })).toEqual({
      vision: true,
      reasoning: false,
      contextWindow: 1000,
      maxOutput: undefined,
    });
    expect(liveModelCaps({ id: "x" })).toBeUndefined();
  });

  it("passthrough providers use the live catalog", () => {
    const connection = { id: "c1", provider: "commandcode", isActive: true };
    const groups = buildModelGroups({
      connections: [connection],
      allConnections: [connection],
      modelAliases: {},
      customModels: [],
      disabledModels: {},
      liveModels: { commandcode: [{ id: "live-only-model" }] },
    });
    const values = (groups.commandcode?.models || []).map((m) => m.value);
    expect(values.some((v) => v.endsWith("/live-only-model"))).toBe(true);
  });

  it("antigravity quota covers Hydrogen/Neon and Claude 5.5 max", () => {
    expect(ANTIGRAVITY_QUOTA_MODELS.has("gemini-4-hydrogen-xhigh")).toBe(true);
    expect(ANTIGRAVITY_QUOTA_MODELS.has("gemini-4-neon-low")).toBe(true);
    expect(ANTIGRAVITY_QUOTA_MODELS.has("claude-opus-5-5-max")).toBe(true);
    expect(ANTIGRAVITY_QUOTA_MODELS.has("gemini-4-carbon-high")).toBe(true);
  });

  it("thinking levels keep both sides", () => {
    expect(getThinkingLevels("antigravity", "gemini-4-hydrogen")).toContain("xhigh");
    expect(getThinkingLevels("ag", "claude-opus-5-5")).toEqual(["low", "medium", "high", "max"]);
    expect(getThinkingLevels("openai", "o3-mini")).toEqual(["low", "medium", "high"]);
    expect(getThinkingLevels("deepseek-web", "deepseek-r1")).toEqual(["thinking"]);
  });

  it("usage eligibility honours lease and local balance", () => {
    expect(isUsageEligible({ provider: "minimax-code", authType: "mcode-lease" })).toBe(true);
    expect(
      isUsageEligible({
        provider: "gemini",
        authType: "apikey",
        providerSpecificData: { localBalance: { enabled: true, initialAmount: 100, currency: "USD" } },
      })
    ).toBe(true);
    expect(isUsageEligible({ provider: "openai", authType: "apikey", providerSpecificData: {} })).toBe(false);
  });
});
