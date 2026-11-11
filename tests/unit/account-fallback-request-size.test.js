// Request-size / context-window wording under a request-error status is about
// the REQUEST, not the account. The 4xx gate in checkFallbackError lets backoff
// text rules override (official 20a43f5a: genuine rate-limit/quota/capacity
// conditions can arrive as a 4xx), but the bare `capacity` rule also matched
// "context capacity" and rotated every account over a deterministic 400.
import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const REQUEST_SCOPED = { shouldFallback: false, cooldownMs: 0, requestScoped: true };

describe("checkFallbackError — request-size wording is not account capacity", () => {
  it.each([
    // Reported shape: a request-caused 400 rotated the combo and locked every account.
    "Request too large: prompt exceeds the context capacity of this model (max 8192 tokens).",
    "The request is too large for this model's context capacity: 95000 tokens > 8192 tokens.",
    "Your prompt exceeds the model's context capacity. Please reduce the length of the messages.",
    // Realistic OpenAI shape.
    "This model's maximum context length is 128000 tokens. However, you requested 200000 tokens (72000 in the messages, 128000 in the completion). Please reduce the length of the messages or completion.",
    // Realistic Anthropic shape.
    "prompt is too long: 210000 tokens > 200000 maximum",
  ])("400 request-scoped: %s", (message) => {
    expect(checkFallbackError(400, message)).toEqual(REQUEST_SCOPED);
  });

  it("413 oversized body stays request-scoped", () => {
    expect(checkFallbackError(413, "Request body too large. Maximum size is 10 MB.")).toEqual(REQUEST_SCOPED);
  });

  it.each([
    // Genuine account/upstream capacity conditions still rotate with backoff.
    "Selected model is at capacity. Please try a different model.",
    "The server is currently at capacity. Please retry your request shortly.",
    "No capacity available for this model on this account right now.",
    "insufficient capacity for this account",
  ])("400 account capacity still falls back with backoff: %s", (message) => {
    expect(checkFallbackError(400, message)).toEqual({
      shouldFallback: true,
      cooldownMs: 2000,
      newBackoffLevel: 1,
    });
  });

  it("still honours genuine rate-limit wording under a 400", () => {
    expect(checkFallbackError(400, "rate limit reached").shouldFallback).toBe(true);
  });
});
