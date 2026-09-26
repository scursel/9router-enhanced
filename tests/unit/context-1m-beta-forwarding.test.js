/**
 * Claude Code's 1M toggle sends `model: "<id>[1m]"` plus
 * `anthropic-beta: context-1m-2025-08-07`. chat.js strips the marker (it
 * matches no model id) on the assumption that the beta header is "forwarded
 * untouched" — but the claude executor rebuilt Anthropic-Beta from a fixed
 * list, so the 1M flag never reached Anthropic on any route, combo or not.
 * The client's context-1m flags now join the list for opus/sonnet members
 * (the models that accept the long-context beta). Since upstream v0.5.91 the
 * client's other beta flags are merged too (official behavior); the fork keeps
 * only the long-context flag gated to opus/sonnet.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("context-1m beta forwarding", () => {
  let DefaultExecutor;
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("open-sse/executors/default.js");
    DefaultExecutor = mod.DefaultExecutor || mod.default;
  });

  const flags = (headers) => headers["Anthropic-Beta"].split(",").map((s) => s.trim());
  const creds = (beta) => ({ apiKey: "k", rawHeaders: beta ? { "anthropic-beta": beta } : {} });

  it("forwards the client's context-1m flag to an opus/sonnet member", () => {
    const h = new DefaultExecutor("claude").buildHeaders(creds("context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14"), true, undefined, "claude-sonnet-4-5");
    expect(flags(h)).toContain("context-1m-2025-08-07");
    expect(flags(h), "other client flags are merged (upstream v0.5.91)").toContain("fine-grained-tool-streaming-2025-05-14");
  });

  it("does not add it to models that don't take the long-context beta", () => {
    const h = new DefaultExecutor("claude").buildHeaders(creds("context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14"), true, undefined, "claude-haiku-4-5-20251001");
    expect(flags(h)).not.toContain("context-1m-2025-08-07");
    expect(flags(h), "the other client flags still pass").toContain("fine-grained-tool-streaming-2025-05-14");
  });

  it("gates the long-context flag on the plain anthropic provider too", () => {
    const h = new DefaultExecutor("anthropic").buildHeaders(creds("context-1m-2025-08-07,x-flag-2026"), true, undefined, "claude-haiku-4-5-20251001");
    expect(h["Anthropic-Beta"] || "").not.toMatch(/context-1m/);
    expect(h["Anthropic-Beta"]).toContain("x-flag-2026");
  });

  it("is absent when the client did not ask for it", () => {
    const h = new DefaultExecutor("claude").buildHeaders(creds(null), true, undefined, "claude-sonnet-4-5");
    expect(h["Anthropic-Beta"]).not.toMatch(/context-1m/);
  });

  it("reaches anthropic-compatible nodes serving a Claude model too", () => {
    const h = new DefaultExecutor("anthropic-compatible-x").buildHeaders(
      { ...creds("context-1m-2025-08-07"), providerSpecificData: { baseUrl: "https://api.anthropic.com/v1" } },
      true, undefined, "claude-opus-4-1",
    );
    expect(flags(h)).toContain("context-1m-2025-08-07");
  });
});
