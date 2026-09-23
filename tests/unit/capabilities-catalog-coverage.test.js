// Catalog coverage guard: every chat model a first-party provider exposes must
// resolve to real limits, not the DEFAULT_CAPABILITIES floor (200k / 64k, no
// reasoning). A model nobody catalogued resolves silently to that floor, which
// then drives the output-token clamp and combo capabilities. Upstream syncs add
// models (claude-opus-5-5 in v0.5.86) — this test is what notices.
import { describe, it, expect } from "vitest";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { hasKnownLimits } from "open-sse/providers/capabilities.js";

const PROVIDERS = ["claude", "codex"];

// Uncovered on purpose. Every entry needs a reason; the test fails if an entry
// goes stale (model removed, or now covered), so the list cannot silently grow.
const ALLOWLIST = {
  codex: {
    // Codex CLI's auto-review virtual model: forwarded verbatim and backed by
    // whatever model Codex picks server-side, so there are no limits to declare.
    "codex-auto-review": "virtual model, backing model chosen by Codex",
  },
};

// Image-generation entries (kind: "image") are not chat models; context and
// output limits do not apply to them.
const chatModels = (provider) =>
  getModelsByProviderId(provider).filter((m) => !m.kind || m.kind === "llm");

describe("capability catalog coverage", () => {
  for (const provider of PROVIDERS) {
    it(`every ${provider} chat model has known limits`, () => {
      const models = chatModels(provider);
      expect(models.length).toBeGreaterThan(0);
      const allowed = ALLOWLIST[provider] || {};
      const uncovered = models
        .map((m) => m.id)
        .filter((id) => !allowed[id] && !hasKnownLimits(provider, id));
      expect(uncovered, `add these to open-sse/providers/capabilities.js`).toEqual([]);
    });

    it(`${provider} allowlist has no stale entries`, () => {
      const ids = new Set(chatModels(provider).map((m) => m.id));
      for (const id of Object.keys(ALLOWLIST[provider] || {})) {
        expect(ids.has(id), `${id} is no longer in the registry`).toBe(true);
        expect(hasKnownLimits(provider, id), `${id} is covered now — drop it from ALLOWLIST`).toBe(false);
      }
    });
  }

  it("the criterion flags an uncatalogued id", () => {
    expect(hasKnownLimits("claude", "claude-foo-9")).toBe(false);
    expect(hasKnownLimits("codex", "gpt-foo-9")).toBe(false);
  });
});
