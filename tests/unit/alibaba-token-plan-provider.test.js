import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { resolveTransport } from "../../open-sse/services/provider.js";

describe("Alibaba Token Plan provider", () => {
  const entry = REGISTRY.find((e) => e.id === "alitp-intl");

  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(PROVIDERS["alitp-intl"]).toBeDefined();
    expect(PROVIDERS["alitp-intl"].format).toBe("openai");
  });

  it("targets the Singapore Token Plan host in compatible mode", () => {
    // eu-central-1 answers IllegalEndpoint; the plan is Singapore-only.
    expect(PROVIDERS["alitp-intl"].baseUrl).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
  });

  it("routes Anthropic clients to Messages and keeps the account URL for OpenAI clients", () => {
    const executor = new DefaultExecutor("alitp-intl");
    const model = "auto";
    const baseUrl = "https://account.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions";
    const credentials = { providerSpecificData: { baseUrl } };
    const runtimeTransport = resolveTransport("alitp-intl", "claude");
    expect(runtimeTransport?.auth).toMatchObject({ header: "Authorization", scheme: "bearer", anthropicVersion: true });
    expect(executor.buildUrl(model, false, 0, { ...credentials, runtimeTransport })).toBe(
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages",
    );
    expect(resolveTransport("alitp-intl", "openai")).toBeNull();
    expect(executor.buildUrl(model, false, 0, credentials)).toBe(baseUrl);
  });

  it("does not collide with the other three Alibaba key types", () => {
    const hosts = ["alicode", "alicode-intl", "alims-intl", "alitp-intl"]
      .map((id) => new URL(PROVIDERS[id].baseUrl).host);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it("exposes the models the plan actually serves", () => {
    const ids = (PROVIDER_MODELS["alitp-intl"] || []).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([
      "qwen3.8-max",
      "qwen3.8-flash",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-flash",
      "glm-5.2",
      "deepseek-v4-pro",
    ]));
    expect(ids).not.toContain("qwen3.8-max-preview");
  });

  it("keeps every registry id unique after adding the provider", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
