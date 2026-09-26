import { describe, expect, it } from "vitest";
import { resolveProviderDisplayName } from "../../src/shared/utils/providerDisplayName.js";

describe("resolveProviderDisplayName", () => {
  it("prefers custom node names", () => {
    expect(resolveProviderDisplayName(
      "openai-compatible-chat-16c9fdba-a535-48cf-a6d6-5e707b8497b5",
      { "openai-compatible-chat-16c9fdba-a535-48cf-a6d6-5e707b8497b5": "GONKA" },
    )).toBe("GONKA");
  });

  it("uses registry display names", () => {
    expect(resolveProviderDisplayName("bai")).toBe("B.AI"); // upstream v0.5.91 registry name
    expect(resolveProviderDisplayName("dahl")).toBe("Dahl Inference");
    expect(resolveProviderDisplayName("openrouter")).toMatch(/openrouter/i);
  });

  it("shortens deleted openai-compatible UUID nodes", () => {
    expect(resolveProviderDisplayName(
      "openai-compatible-chat-a88931b7-325c-47f5-ac6c-6cc1669d0eb0",
    )).toBe("Custom OpenAI (a88931b7)");
  });

  it("humanizes slug custom nodes without a stored name", () => {
    expect(resolveProviderDisplayName(
      "openai-compatible-chat-hf-qwen-obliterated",
    )).toBe("Custom OpenAI (hf qwen obliterated)");
  });
});
