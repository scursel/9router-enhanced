import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { getOpenRouterUsage, parseOpenRouter } from "../../open-sse/services/usage/openrouter.js";
import { getCommandCodeUsage, parseCommandCode, commandCodeMonthlyTotal } from "../../open-sse/services/usage/commandcode.js";
import { getXiaomiMimoUsage, parseMimo } from "../../open-sse/services/usage/xiaomiMimo.js";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Quota Collectors - Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("registry flags so Enhanced collector cards appear on /quota", () => {
    it.each(["commandcode", "openrouter", "xiaomi-mimo", "clinepass"])(
      "exposes usage + usageApikey for %s",
      (provider) => {
        expect(USAGE_SUPPORTED_PROVIDERS).toContain(provider);
        expect(USAGE_APIKEY_PROVIDERS).toContain(provider);
      },
    );
  });

  describe("OpenRouter Usage Collector", () => {
    it("returns error message when API key is missing", async () => {
      const res = await getOpenRouterUsage(null);
      expect(res).toEqual({
        message: "OpenRouter API key not available.",
        quotas: {},
      });
    });

    it("fetches credits first and parses total_credits / total_usage", async () => {
      proxyAwareFetch.mockResolvedValueOnce(
        jsonResponse({
          total_credits: 100,
          total_usage: 25,
        }),
      );

      const res = await getOpenRouterUsage("sk-or-v1-testkey");

      expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
      expect(proxyAwareFetch).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/credits",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-or-v1-testkey",
          }),
        }),
        undefined,
      );

      expect(res).toEqual({
        plan: "Credits",
        quotas: {
          "Credits (USD)": {
            used: 25,
            total: 100,
            remainingPercentage: 75,
            resetAt: null,
            unlimited: false,
          },
        },
      });
    });

    it("falls back to /auth/key when /credits returns null parse", async () => {
      // /credits returns 404 or empty json
      proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "Not found" }, 404));
      // /auth/key returns key limit data
      proxyAwareFetch.mockResolvedValueOnce(
        jsonResponse({
          data: {
            limit: 50,
            usage: 10,
            is_free_tier: false,
            limit_reset: "2026-09-01T00:00:00Z",
          },
        }),
      );

      const res = await getOpenRouterUsage("sk-or-v1-testkey");

      expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
      expect(res.plan).toBe("API key");
      expect(res.quotas["Key limit (USD)"]).toEqual({
        used: 10,
        total: 50,
        remainingPercentage: 80,
        resetAt: "2026-09-01T00:00:00.000Z",
        unlimited: false,
      });
    });

    it("returns 401 error message when both endpoints fail with 401", async () => {
      proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));
      proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));

      const res = await getOpenRouterUsage("invalid-key");
      expect(res).toEqual({
        message: "OpenRouter quota API error (401).",
        quotas: {},
      });
    });
  });

  describe("CommandCode Usage Collector", () => {
    it("returns error message when API key is missing", async () => {
      const res = await getCommandCodeUsage(null);
      expect(res).toEqual({
        message: "CommandCode API key not available.",
        quotas: {},
      });
    });

    it("calculates used = total - remaining using planId and parses 5h and 7d windows", async () => {
      proxyAwareFetch.mockImplementation(async (url) => {
        if (url.includes("/billing/credits")) {
          return jsonResponse({
            credits: {
              monthlyCredits: 60,
              purchasedCredits: 10,
              freeCredits: 5,
            },
            windowLimits: {
              fiveHour: { used: 2, cap: 20, resetAt: "2026-08-29T15:00:00Z" },
              weekly: { used: 15, cap: 50, resetAt: "2026-09-05T00:00:00Z" },
            },
          });
        }
        if (url.includes("/billing/subscriptions")) {
          return jsonResponse({
            data: {
              planId: "individual-pro",
              currentPeriodEnd: "2026-09-15T00:00:00Z",
            },
          });
        }
        return jsonResponse({}, 404);
      });

      const res = await getCommandCodeUsage("cc-key");

      expect(commandCodeMonthlyTotal("individual-pro")).toBe(80);
      expect(res.plan).toBe("Pro");
      expect(res.quotas).toHaveProperty("Monthly credits (USD) - renews 15/09/2026");
      expect(res.quotas["Monthly credits (USD) - renews 15/09/2026"]).toEqual({
        used: 20, // 80 - 60
        total: 80,
        remainingPercentage: 75,
        resetAt: "2026-09-15T00:00:00.000Z",
        unlimited: false,
      });
      expect(res.quotas["Purchased credits (USD)"]).toEqual({
        used: 0,
        total: 10,
        remainingPercentage: 100,
        resetAt: null,
        unlimited: false,
      });
      expect(res.quotas["Free credits (USD)"]).toEqual({
        used: 0,
        total: 5,
        remainingPercentage: 100,
        resetAt: null,
        unlimited: false,
      });
      expect(res.quotas["5 hour window (USD)"]).toEqual({
        used: 2,
        total: 20,
        remainingPercentage: 90,
        resetAt: "2026-08-29T15:00:00.000Z",
        unlimited: false,
      });
      expect(res.quotas["7 day window (USD)"]).toEqual({
        used: 15,
        total: 50,
        remainingPercentage: 70,
        resetAt: "2026-09-05T00:00:00.000Z",
        unlimited: false,
      });
    });
  });

  describe("Xiaomi MiMo Usage Collector", () => {
    it("returns exact error message when cookie is missing", async () => {
      const originalEnv = process.env.MIMO_QUOTA_COOKIE;
      delete process.env.MIMO_QUOTA_COOKIE;

      const res = await getXiaomiMimoUsage({});
      expect(res).toEqual({
        message:
          "MiMo balance requires the console cookie in MIMO_QUOTA_COOKIE or providerSpecificData.quotaCookie.",
        quotas: {},
      });

      process.env.MIMO_QUOTA_COOKIE = originalEnv;
    });

    it("fetches balance using providerSpecificData.quotaCookie and parses balances", async () => {
      proxyAwareFetch.mockResolvedValueOnce(
        jsonResponse({
          data: {
            balance: 50,
            currency: "USD",
            cashBalance: 40,
            giftBalance: 10,
          },
        }),
      );

      const res = await getXiaomiMimoUsage({ quotaCookie: "sess=abc123xyz" });

      expect(proxyAwareFetch).toHaveBeenCalledWith(
        "https://platform.xiaomimimo.com/api/v1/balance",
        expect.objectContaining({
          headers: expect.objectContaining({
            Cookie: "sess=abc123xyz",
            Origin: "https://platform.xiaomimimo.com",
          }),
        }),
        undefined,
      );

      expect(res.plan).toBe("API balance");
      expect(res.quotas["Available balance (USD)"]).toEqual({
        used: 0,
        total: 50,
        remainingPercentage: 100,
        resetAt: null,
        unlimited: false,
      });
      expect(res.quotas["Paid balance (USD)"]).toEqual({
        used: 0,
        total: 40,
        remainingPercentage: 100,
        resetAt: null,
        unlimited: false,
      });
      expect(res.quotas["Granted balance (USD)"]).toEqual({
        used: 0,
        total: 10,
        remainingPercentage: 100,
        resetAt: null,
        unlimited: false,
      });
    });
  });

  // OpenCode Go usage collector: replaced by official open-sse/services/usage/opencode-go.js
  // (covered by tests/unit/opencode-go-usage.test.js).

  describe("getUsageForProvider integration with USAGE_HANDLERS", () => {
    it("routes openrouter via getUsageForProvider", async () => {
      proxyAwareFetch.mockResolvedValueOnce(
        jsonResponse({ total_credits: 50, total_usage: 10 }),
      );

      const res = await getUsageForProvider({
        provider: "openrouter",
        apiKey: "sk-or-key",
      });

      expect(res.quotas["Credits (USD)"].total).toBe(50);
    });

    it("routes commandcode via getUsageForProvider", async () => {
      proxyAwareFetch.mockImplementation(async (url) => {
        if (url.includes("/billing/credits")) {
          return jsonResponse({ credits: { monthlyCredits: 10 } });
        }
        return jsonResponse({ data: { planId: "individual-go" } });
      });

      const res = await getUsageForProvider({
        provider: "commandcode",
        apiKey: "cc-key",
      });

      expect(res.quotas["Monthly credits (USD)"].total).toBe(10);
    });

    it("routes xiaomi-mimo via getUsageForProvider", async () => {
      proxyAwareFetch.mockResolvedValueOnce(
        jsonResponse({ data: { balance: 100, currency: "USD" } }),
      );

      const res = await getUsageForProvider({
        provider: "xiaomi-mimo",
        providerSpecificData: { quotaCookie: "cookie123" },
      });

      expect(res.quotas["Available balance (USD)"].total).toBe(100);
    });

    it("routes clinepass via getUsageForProvider", async () => {
      // Official collector (upstream v0.5.119): one usage-limits call, percent windows.
      proxyAwareFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, data: { limits: [{ type: "five_hour", percentUsed: 25, resetsAt: null }] } }),
      );

      const res = await getUsageForProvider({
        provider: "clinepass",
        apiKey: "cline-key",
      });

      expect(res.quotas["Session (5h)"].used).toBe(25);
    });

    it("routes opencode-go via getUsageForProvider", async () => {
      proxyAwareFetch.mockResolvedValueOnce(
        jsonResponse({ usage: { rolling: { percent: 50 } } }),
      );

      const res = await getUsageForProvider({
        provider: "opencode-go",
        apiKey: "og-key-dispatch-" + Date.now(),
      });

      // Official collector labels the window "Rolling" (see opencode-go-usage.test.js).
      expect(res.quotas.Rolling.used).toBe(50);
    });
  });
});
