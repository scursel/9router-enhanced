import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLongContextTier,
  calculateCostFromTokens,
  getPricingForModel,
} from "../../open-sse/providers/pricing.js";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-pricing-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("OmniRoute long_context pricing + Gemini API tariffs", () => {
  it("applies long_context strictly above threshold by default and >= when inclusive is true", () => {
    const base = {
      input: 1.25,
      output: 10,
      cached: 0.125,
      reasoning: 10,
      cache_creation: 1.25,
      long_context: {
        threshold: 200_000,
        input: 2.5,
        output: 15,
        cached: 0.25,
        reasoning: 15,
        cache_creation: 2.5,
      },
    };

    expect(applyLongContextTier(base, 200_000)).toBe(base);
    expect(applyLongContextTier(base, 200_001).input).toBe(2.5);
    expect(applyLongContextTier(base, 200_001).output).toBe(15);

    const inclusive = {
      ...base,
      long_context: { ...base.long_context, inclusive: true },
    };
    expect(applyLongContextTier(inclusive, 200_000).input).toBe(2.5);
  });

  it("ignores malformed long_context tiers safely", () => {
    const base = { input: 2, output: 12 };
    expect(applyLongContextTier({ ...base, long_context: null }, 300_000)).toEqual({
      ...base,
      long_context: null,
    });
    expect(applyLongContextTier({ ...base, long_context: [] }, 300_000)).toEqual({
      ...base,
      long_context: [],
    });
    expect(
      applyLongContextTier({ ...base, long_context: { threshold: 0, input: 99 } }, 300_000).input
    ).toBe(2);
    expect(
      applyLongContextTier({ ...base, long_context: { threshold: -5, input: 99 } }, 300_000).input
    ).toBe(2);
  });

  it("bills gemini-2.5-pro and gemini-3.1-pro-preview at <=200k and >200k paid rates", () => {
    const p25 = getPricingForModel("gemini", "gemini-2.5-pro");
    expect(p25).toBeTruthy();

    // <= 200k: 100k total input (20k cached, 80k uncached), 1k output, 500 reasoning
    const low25 = calculateCostFromTokens(
      {
        prompt_tokens: 100_000,
        cached_tokens: 20_000,
        completion_tokens: 1_000,
        reasoning_tokens: 500,
      },
      p25
    );
    // 80k * 1.25/1M + 20k * 0.125/1M + 1k * 10/1M + 500 * 10/1M = 0.1 + 0.0025 + 0.01 + 0.005
    expect(low25).toBeCloseTo(0.1175, 10);

    // > 200k: 250k total input (50k cached, 200k uncached), 2k output, 1k reasoning
    const high25 = calculateCostFromTokens(
      {
        prompt_tokens: 250_000,
        cached_tokens: 50_000,
        completion_tokens: 2_000,
        reasoning_tokens: 1_000,
      },
      p25
    );
    // 200k * 2.50/1M + 50k * 0.25/1M + 2k * 15/1M + 1k * 15/1M = 0.5 + 0.0125 + 0.03 + 0.015
    expect(high25).toBeCloseTo(0.5575, 10);

    const p31 = getPricingForModel("gemini", "gemini-3.1-pro-preview");
    const low31 = calculateCostFromTokens(
      { prompt_tokens: 200_000, cached_tokens: 100_000, completion_tokens: 1_000 },
      p31
    );
    // 100k * 2/1M + 100k * 0.20/1M + 1k * 12/1M = 0.20 + 0.02 + 0.012
    expect(low31).toBeCloseTo(0.232, 10);

    const high31 = calculateCostFromTokens(
      { prompt_tokens: 200_001, cached_tokens: 100_000, completion_tokens: 1_000 },
      p31
    );
    // 100001 * 4/1M + 100000 * 0.40/1M + 1000 * 18/1M = 0.400004 + 0.04 + 0.018
    expect(high31).toBeCloseTo(0.458004, 10);

    // Provider-scoped: vertex / default MODEL_PRICING keeps original fallback rates
    expect(getPricingForModel("vertex", "gemini-2.5-pro").input).toBe(2.0);
  });

  it("prices Gemini non-LLM models explicitly without falling through to LLM globs", () => {
    const emb = getPricingForModel("gemini", "gemini-embedding-001");
    expect(emb).toMatchObject({ input: 0.15, output: 0 });
    expect(calculateCostFromTokens({ prompt_tokens: 1_000_000, completion_tokens: 0 }, emb)).toBeCloseTo(0.15, 10);

    const tts = getPricingForModel("gemini", "gemini-2.5-flash-preview-tts");
    expect(tts).toMatchObject({ input: 0.5, output: 10 });

    const img = getPricingForModel("gemini", "gemini-2.5-flash-image");
    expect(img).toMatchObject({ input: 0.3, output: 30 });
  });

  it("supports GET -> PATCH /api/pricing round-trip with long_context and rejects malformed tiers (A1)", async () => {
    const { GET, PATCH } = await import("@/app/api/pricing/route.js");

    const getRes = await GET();
    expect(getRes.status).toBe(200);
    const snapshot = await getRes.json();
    expect(snapshot.gemini["gemini-2.5-pro"].long_context.threshold).toBe(200_000);

    // PricingModal sends the entire merged snapshot back on Save
    snapshot.gemini["gemini-2.5-pro"].input = 1.5;
    const patchRes = await PATCH(
      new Request("http://localhost/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      })
    );
    expect(patchRes.status).toBe(200);

    // Invalid long_context payloads must still return 400
    for (const badTier of [
      "nope",
      [],
      { threshold: 0, input: 2 },
      { threshold: 200_000, inclusive: "yes" },
      { threshold: 200_000, unknown: 1 },
      { threshold: 200_000, input: -1 },
    ]) {
      const badRes = await PATCH(
        new Request("http://localhost/api/pricing", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gemini: {
              "gemini-2.5-pro": { input: 1.25, output: 10, long_context: badTier },
            },
          }),
        })
      );
      expect(badRes.status).toBe(400);
    }
  });

  it("preserves built-in long_context in pricingRepo.getPricingForModel when user override omits it (A2)", async () => {
    const { updatePricing, getPricingForModel: repoGetPricing } = await import(
      "@/lib/db/repos/pricingRepo.js"
    );

    await updatePricing({
      gemini: {
        "gemini-2.5-pro": {
          input: 1.5,
          output: 10.0,
          cached: 0.15,
          reasoning: 10.0,
          cache_creation: 1.5,
        },
      },
    });

    const merged = await repoGetPricing("gemini", "gemini-2.5-pro");
    expect(merged.input).toBe(1.5);
    expect(merged.long_context).toMatchObject({
      threshold: 200_000,
      input: 2.5,
      output: 15.0,
    });
    expect(
      calculateCostFromTokens({ prompt_tokens: 250_000, completion_tokens: 1_000 }, merged)
    ).toBeCloseTo(250_000 * (2.5 / 1e6) + 1_000 * (15 / 1e6), 10);
  });
});
