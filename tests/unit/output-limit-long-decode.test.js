import { describe, expect, it } from "vitest";
import { clampOutputTokens } from "../../open-sse/handlers/chatCore/outputLimit.js";
import { GEMINI_LONG_DECODE_MAX_OUTPUT } from "../../open-sse/utils/geminiLongDecode.js";

// Models flagged longDecode (gemini-4-hydrogen) run continuation hops up to
// GEMINI_LONG_DECODE_MAX_OUTPUT, so their budget must not be cut to the 64K
// maxOutput of the static entry. Every other model keeps the old clamp.
describe("clampOutputTokens with long-decode models", () => {
  it("clamp keeps a long-decode budget below the long-decode ceiling", () => {
    const body = { generationConfig: { maxOutputTokens: 200000 } };
    clampOutputTokens(body, "gemini", "gemini-4-hydrogen");
    expect(body.generationConfig.maxOutputTokens).toBe(200000);
  });

  it("clamp lowers a long-decode budget to GEMINI_LONG_DECODE_MAX_OUTPUT", () => {
    const body = { generationConfig: { maxOutputTokens: 2000000 } };
    clampOutputTokens(body, "gemini", "gemini-4-hydrogen");
    expect(body.generationConfig.maxOutputTokens).toBe(GEMINI_LONG_DECODE_MAX_OUTPUT);
    expect(GEMINI_LONG_DECODE_MAX_OUTPUT).toBe(1048576);
  });

  it("keeps a long-decode budget in the Antigravity nested request shape", () => {
    const body = { request: { generationConfig: { maxOutputTokens: 200000 } } };
    clampOutputTokens(body, "antigravity", "gemini-4-hydrogen-high");
    expect(body.request.generationConfig.maxOutputTokens).toBe(200000);
  });

  it("still clamps a model without longDecode to its maxOutput", () => {
    const body = { max_tokens: 500000 };
    clampOutputTokens(body, "claude", "claude-opus-5-5");
    expect(body.max_tokens).toBe(128000);
  });
});
