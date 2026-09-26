import { describe, it, expect } from "vitest";
import { describeProviderError, ERROR_REASONS } from "@/shared/utils/errorReason.js";

// Raw errors as they are stored today (connection lastError / errorCode, model
// test results, request logs). Real shapes from the live DB, values anonymized.
const reasonOf = (input, status) => describeProviderError(input, status)?.reason;

describe("describeProviderError", () => {
  it("returns null when there is no error", () => {
    expect(describeProviderError(null)).toBeNull();
    expect(describeProviderError("")).toBeNull();
  });

  it("credits exhausted — JSON body, even under a 429", () => {
    expect(reasonOf('[402]: {"error": "the provider for model nemotron-3-ultra-fp4 has exhausted its credits and cannot process requests"}')).toBe("no_credits");
    expect(reasonOf('[429]: {"error":{"data":{"code":14018,"msg":"Credits exhausted. Please visit the link below to purchase add-on packs"}}}')).toBe("no_credits");
    expect(reasonOf("credit insufficient balance: balance=47 required=56")).toBe("no_credits");
    expect(reasonOf("Payment required", 402)).toBe("no_credits");
  });

  it("provider-wide free pool vs this account's free quota (live log texts)", () => {
    expect(reasonOf('{"error":{"message":"The site-wide free-model capacity is currently full. This is not your personal quota."}}')).toBe("upstream_down");
    expect(reasonOf('{"error":{"message":"The free quota has been exhausted. To continue accessing the model on a paid basis, please add funds."}}')).toBe("no_credits");
    expect(reasonOf('{"error":{"code":"no_available_channel","message":"The model x-free cannot be served at the moment"}}')).toBe("upstream_down");
  });

  it("plan / usage limit", () => {
    expect(reasonOf("This request exceeds your plan's set usage limit. Please upgrade your plan or contact support@example.com")).toBe("quota_exceeded");
    expect(reasonOf("Monthly limit reached for this workspace")).toBe("quota_exceeded");
    // OpenAI's insufficient_quota text is a billing problem, so it reads as credits.
    expect(reasonOf("You exceeded your current quota, please check your plan and billing details")).toBe("no_credits");
  });

  it("rate limit", () => {
    expect(reasonOf("[429]: Too Many Requests")).toBe("rate_limited");
    expect(reasonOf("Rate limit reached for requests", 429)).toBe("rate_limited");
    expect(reasonOf("something odd", 429)).toBe("rate_limited");
  });

  it("invalid or expired credentials", () => {
    expect(reasonOf("[401]: Invalid API key provided")).toBe("invalid_key");
    expect(reasonOf("No access token")).toBe("invalid_key");
    expect(reasonOf("HTTP 401: Missing API key")).toBe("invalid_key");
    expect(reasonOf("Could not verify credentials — Validation failed")).toBe("invalid_key");
    expect(reasonOf("token has expired", 400)).toBe("invalid_key");
  });

  it("model problems win over the credential wrapper around them", () => {
    expect(reasonOf("Could not verify credentials — Model not supported by provider hf-inference", 502)).toBe("model_not_supported");
    expect(reasonOf('HTTP 400: [400]: {"error":{"message":"nonexistent/fake-model-xyz is not a valid model ID","code":400}}')).toBe("model_not_found");
    expect(reasonOf("The model `gpt-9` does not exist")).toBe("model_not_found");
    expect(reasonOf("not found", 404)).toBe("model_not_found");
  });

  it("HTML error pages are read by their title", () => {
    const html = "<html>\n<head><title>403 Forbidden</title></head>\n<body><center><h1>403 Forbidden</h1></center><hr><center>openresty</center></body></html>";
    const d = describeProviderError(html, 400);
    expect(d.reason).toBe("forbidden");
    expect(d.detail).toBe("403 Forbidden");
    expect(reasonOf("<html><head><title>502 Bad Gateway</title></head></html>")).toBe("upstream_down");
  });

  it("access denied", () => {
    expect(reasonOf("Request not allowed", 403)).toBe("forbidden");
    expect(reasonOf("This service is not available in your region")).toBe("forbidden");
  });

  it("context too long", () => {
    expect(reasonOf("This model's maximum context length is 131072 tokens. However, you requested 200000 tokens")).toBe("context_too_long");
    expect(reasonOf("prompt is too long: 250000 tokens > 200000 maximum", 400)).toBe("context_too_long");
  });

  it("content filter", () => {
    expect(reasonOf("The response was filtered due to the prompt triggering content management policy")).toBe("content_filtered");
  });

  it("provider down, timeout and network are told apart", () => {
    expect(reasonOf("Overloaded", 529)).toBe("upstream_down");
    expect(reasonOf("upstream error", 503)).toBe("upstream_down");
    expect(reasonOf("[FETCH_FAILED]: fetch failed (cause: ECONNRESET: socket hang up)")).toBe("network");
    expect(reasonOf("getaddrinfo ENOTFOUND api.example.com")).toBe("network");
    expect(reasonOf("The operation was aborted due to timeout")).toBe("timeout");
    expect(reasonOf("gateway timeout", 504)).toBe("timeout");
  });

  it("subscription, model outage and wrong endpoint (seen in the live logs)", () => {
    expect(reasonOf('{"code":"InvalidParameter","message":"The product is not activated, please confirm that you have activated products"}')).toBe("subscription_required");
    expect(reasonOf("Upstream request failed: An active OpenCode Go subscription is required to use Go models.")).toBe("subscription_required");
    expect(reasonOf("Access restricted. Deposit required to unlock premium models.")).toBe("subscription_required");
    expect(reasonOf('{"error":{"message":"your current account does not have access to this model"}}')).toBe("model_not_supported");
    expect(reasonOf('{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}')).toBe("model_unavailable");
    expect(reasonOf('{"error":{"code":"model_maintenance","message":"GLM 5.3 Flash is in maintenance for 24 hours."}}')).toBe("model_unavailable");
    expect(reasonOf("404 page not found")).toBe("endpoint_not_found");
    expect(reasonOf("upstream stream produced no output within 60000ms")).toBe("timeout");
  });

  it("outdated client", () => {
    expect(reasonOf("Your Command Code CLI is out of date. Run `cmd update` or `npm i -g command-code` to upgrade.")).toBe("client_outdated");
  });

  it("generic 400 is 'rejected', unknown text stays unclassified", () => {
    expect(reasonOf("bad field foo", 400)).toBe("bad_request");
    expect(reasonOf("Provider error")).toBeNull();
    expect(describeProviderError("Provider error").raw).toBe("Provider error");
  });

  it("reads the status from the stored prefixes and from objects", () => {
    expect(describeProviderError("[402]: out").status).toBe(402);
    expect(describeProviderError("HTTP 429: slow").status).toBe(429);
    expect(describeProviderError({ status: 401, message: "nope" }).reason).toBe("invalid_key");
    expect(describeProviderError({ error: { message: "Rate limit exceeded", code: 429 } }).reason).toBe("rate_limited");
  });

  it("every reason has a title and a hint", () => {
    for (const [key, info] of Object.entries(ERROR_REASONS)) {
      expect(info.title, key).toBeTruthy();
      expect(info.hint, key).toBeTruthy();
    }
  });
});
