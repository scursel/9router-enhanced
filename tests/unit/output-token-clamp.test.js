import { describe, expect, it } from "vitest";
import { clampOutputTokens } from "../../open-sse/handlers/chatCore/outputLimit.js";

// Only the Claude target clamped max_tokens to the model's maxOutput; a combo
// falling back from Opus (128k) to gpt-4o (16k) sent max_tokens 128000 → 400.
describe("clampOutputTokens", () => {
  it("clamps OpenAI chat fields to the model maximum", () => {
    const body = { max_tokens: 128000, max_completion_tokens: 128000 };
    clampOutputTokens(body, "openai", "gpt-4o");
    expect(body).toEqual({ max_tokens: 16384, max_completion_tokens: 16384 });
  });

  it("clamps Responses and Gemini (plain and wrapped) fields", () => {
    const resp = { max_output_tokens: 999999 };
    clampOutputTokens(resp, "openai", "gpt-4o");
    expect(resp.max_output_tokens).toBe(16384);

    const gem = { generationConfig: { maxOutputTokens: 999999 } };
    clampOutputTokens(gem, "gemini", "gemini-2.5-pro");
    expect(gem.generationConfig.maxOutputTokens).toBe(65536);

    const wrapped = { request: { generationConfig: { maxOutputTokens: 999999 } } };
    clampOutputTokens(wrapped, "gemini-cli", "gemini-2.5-pro");
    expect(wrapped.request.generationConfig.maxOutputTokens).toBe(65536);
  });

  it("never raises a smaller request", () => {
    const body = { max_tokens: 1000 };
    clampOutputTokens(body, "openai", "gpt-4o");
    expect(body.max_tokens).toBe(1000);
  });

  it("leaves uncatalogued models alone (the default floor is a guess)", () => {
    const body = { max_tokens: 200000 };
    clampOutputTokens(body, "custom", "some-unknown-model-zz");
    expect(body.max_tokens).toBe(200000);
  });
});
