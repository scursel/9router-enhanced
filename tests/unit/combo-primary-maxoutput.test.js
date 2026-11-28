import { describe, expect, it } from "vitest";
import { aggregateComboCapabilities, getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { makeComboMemberResolver } from "../../src/shared/utils/comboMemberResolver.js";
import { clampOutputTokens } from "../../open-sse/handlers/chatCore/outputLimit.js";

const resolveMember = (m) => {
  const i = m.indexOf("/");
  return i === -1 ? { provider: null, model: m } : { provider: m.slice(0, i), model: m.slice(i + 1) };
};

const primary = (models, lookup = null, extra = {}) =>
  aggregateComboCapabilities(models, lookup, { resolveMember, outputPolicy: "primary", ...extra });

const minPolicy = (models, lookup = null, extra = {}) =>
  aggregateComboCapabilities(models, lookup, { resolveMember, outputPolicy: "min", ...extra });

describe("aggregateComboCapabilities outputPolicy: primary", () => {
  it("ordered Claude+Workhorse advertises Claude output and MIN context", () => {
    const caps = primary(["cc/claude-sonnet-5-5", "workhorse/qwen38-gguf-mtp"]);
    expect(caps.maxOutput).toBe(getCapabilitiesForModel("claude", "claude-sonnet-5-5").maxOutput);
    expect(caps.contextWindow).toBe(65536);
  });

  it("reversed order advertises Workhorse output (proves primary, not MAX)", () => {
    const caps = primary(["workhorse/qwen38-gguf-mtp", "cc/claude-sonnet-5-5"]);
    expect(caps.maxOutput).toBe(16384);
    expect(caps.contextWindow).toBe(65536);
  });

  it("strips (high) via the real combo member resolver", () => {
    const resolve = makeComboMemberResolver([], {});
    const caps = aggregateComboCapabilities(
      ["cc/claude-sonnet-5-5", "workhorse/qwen38-gguf-mtp(high)"],
      null,
      { resolveMember: resolve, outputPolicy: "primary" },
    );
    expect(caps.maxOutput).toBe(128000);
    expect(caps.contextWindow).toBe(65536);
  });

  it("nested Claude-only first seat keeps Claude output with Workhorse sibling", () => {
    const lookup = { inner: ["cc/claude-sonnet-5-5"] };
    const caps = primary(["inner", "workhorse/qwen38-gguf-mtp"], lookup);
    expect(caps.maxOutput).toBe(128000);
    expect(caps.contextWindow).toBe(65536);
  });

  it("unknown primary then nested Claude+Workhorse uses the nested MIN output", () => {
    const lookup = { child: ["cc/claude-sonnet-5-5", "workhorse/qwen38-gguf-mtp"] };
    const caps = primary(["custom/totally-unknown-zz", "child"], lookup);
    expect(caps.maxOutput).toBe(16384);
  });

  it("nested child whose first leaf is unknown does not promote walk-fallback as parent primary", () => {
    const lookup = { child: ["custom/totally-unknown-zz", "cc/claude-sonnet-5-5"] };
    // Child alone walks to Claude (128k), but first-leaf primaryOutput is null.
    expect(primary(["child"], lookup).maxOutput).toBe(128000);
    // Parent ordered with that child first must fall through to Workhorse (16k).
    expect(primary(["child", "workhorse/qwen38-gguf-mtp"], lookup).maxOutput).toBe(16384);
  });

  it("round-robin child keeps MIN even when the parent is ordered primary", () => {
    const lookup = { rr: ["cc/claude-sonnet-5-5", "workhorse/qwen38-gguf-mtp"] };
    const caps = aggregateComboCapabilities(["rr"], lookup, {
      resolveMember,
      outputPolicy: "primary",
      comboStrategies: { rr: { fallbackStrategy: "round-robin" } },
      globalStrategy: "fallback",
    });
    expect(caps.maxOutput).toBe(16384);
  });

  it("Workhorse-only combo still advertises 16384", () => {
    expect(primary(["workhorse/qwen38-gguf-mtp"]).maxOutput).toBe(16384);
  });

  it("invalid resolveCaps limits do not wipe defaults on an unknown member", () => {
    const caps = aggregateComboCapabilities(
      ["custom/all-unknown-zz"],
      null,
      {
        resolveMember,
        outputPolicy: "primary",
        resolveCaps: () => ({ contextWindow: 0, maxOutput: Number.NaN }),
      },
    );
    expect(caps.contextWindow).toBe(200000);
    expect(caps.maxOutput).toBe(64000);
  });

  it("context-only resolveCaps on a later member does not drag primary output to DEFAULT 64000", () => {
    const caps = primary(
      ["cc/claude-sonnet-5-5", "custom/obscure-zz"],
      null,
      {
        resolveCaps: (_m, { model }) => (model === "obscure-zz" ? { contextWindow: 32000 } : null),
      },
    );
    expect(caps.maxOutput).toBe(128000);
    expect(caps.contextWindow).toBe(32000);
  });

  it("output-only resolveCaps marks output known without requiring context", () => {
    const caps = primary(
      ["custom/out-only-zz", "workhorse/qwen38-gguf-mtp"],
      null,
      {
        resolveCaps: (_m, { model }) => (model === "out-only-zz" ? { maxOutput: 99000 } : null),
      },
    );
    expect(caps.maxOutput).toBe(99000);
  });
});

describe("aggregateComboCapabilities outputPolicy: min (dynamic strategies)", () => {
  it("Claude+Workhorse stays at Workhorse output under min policy", () => {
    const caps = minPolicy(["cc/claude-sonnet-5-5", "workhorse/qwen38-gguf-mtp"]);
    expect(caps.maxOutput).toBe(16384);
    expect(caps.contextWindow).toBe(65536);
  });

  it("default policy without option remains conservative MIN", () => {
    const caps = aggregateComboCapabilities(
      ["cc/claude-sonnet-5-5", "workhorse/qwen38-gguf-mtp"],
      null,
      { resolveMember },
    );
    expect(caps.maxOutput).toBe(16384);
  });
});

describe("Workhorse clamp unchanged", () => {
  it("floors a 100k client budget to 16384 on the Workhorse member", () => {
    const body = { max_tokens: 100000 };
    clampOutputTokens(body, "openai-compatible-chat-workhorse", "qwen38-gguf-mtp");
    expect(body.max_tokens).toBe(16384);
  });
});

describe("cycle nesting does not throw", () => {
  it("A↔B with rootComboName seeded matches chat: B cannot re-enter A", () => {
    const lookup = {
      A: ["B", "cc/claude-sonnet-5-5"],
      B: ["A", "workhorse/qwen38-gguf-mtp"],
    };
    // Pass member list + rootComboName (same shape as /v1/models), so B skips A.
    const caps = aggregateComboCapabilities(lookup.A, lookup, {
      resolveMember,
      outputPolicy: "primary",
      rootComboName: "A",
    });
    expect(caps.maxOutput).toBe(16384);
    expect(caps.contextWindow).toBe(65536);
  });
});
