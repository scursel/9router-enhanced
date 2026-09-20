import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getAlibabaTokenPlanUsage,
  calcSlidingWindowUsage,
  getAlibabaPlanLimits,
  estimateAlibabaCredits,
  getAlibabaModelRates,
  alibabaWindowMeta,
  alibabaBucketMeta,
  resolveAlibabaWeeklyBucket,
  alibabaUntracked7d,
  parseAlibabaResetAt,
  alibabaQuotaExhaustion,
  applyAlibabaQuotaExhaustion,
} from "open-sse/services/usage/alibabaTokenPlan.js";
import { getAdapter } from "@/lib/db/driver.js";

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(),
}));

describe("Alibaba Token Plan Local Usage Meter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("getAlibabaPlanLimits", () => {
    it("returns Lite tier limits by default or for unknown plans", () => {
      expect(getAlibabaPlanLimits()).toEqual({ name: "Lite", limit7d: 2500 });
      expect(getAlibabaPlanLimits({ plan: "unknown" })).toEqual({ name: "Lite", limit7d: 2500 });
    });

    it("returns Standard tier limits for standard plan", () => {
      expect(getAlibabaPlanLimits({ plan: "Standard" })).toEqual({
        name: "Standard",
        limit7d: 10000,
      });
    });

    it("returns Pro tier limits for pro plan", () => {
      expect(getAlibabaPlanLimits({ plan: "Pro" })).toEqual({
        name: "Pro",
        limit7d: 40000,
      });
    });
  });

  describe("estimateAlibabaCredits", () => {
    it("calculates estimated credits correctly from prompt and completion tokens", () => {
      // 1,000,000 prompt tokens (uncached) + 100,000 completion tokens
      // USD = 1e6 * 2e-6 + 1e5 * 6e-6 = 2.0 + 0.6 = 2.6
      // credits = 2.6 / 0.002 = 1300
      const record = { promptTokens: 1000000, completionTokens: 100000 };
      expect(estimateAlibabaCredits(record)).toBe(1300);
    });

    it("handles cached tokens without charging for the cache read", () => {
      // 1,000,000 total prompt tokens, 800,000 cached => 200,000 uncached
      // uncached USD = 2e5 * 2e-6 = 0.4
      // cached USD = 0 (cache reads are free on this plan — see the console
      // regression below; charging 0.25e-6 here is the bug that read 11% of a
      // 2,500-credit week as remaining while the console said 39.7%)
      // completion USD = 1e5 * 6e-6 = 0.6
      // Total USD = 1.0 => credits = 1.0 / 0.002 = 500
      const record = {
        tokens: JSON.stringify({
          prompt_tokens: 1000000,
          completion_tokens: 100000,
          cached_tokens: 800000,
        }),
      };
      expect(estimateAlibabaCredits(record)).toBe(500);
    });

    it("costs a fully cached prompt nothing no matter how large the cache read is", () => {
      const record = {
        tokens: { prompt_tokens: 16632320, completion_tokens: 0, cached_tokens: 16632320 },
      };
      expect(estimateAlibabaCredits(record)).toBe(0);
    });

    it("applies per-model overrides only to the model they are keyed by", () => {
      const overrides = { "deepseek-v4.1-flash": { cacheRead: 0.25 } };
      const record = {
        tokens: { prompt_tokens: 1000000, completion_tokens: 0, cached_tokens: 1000000 },
      };
      expect(estimateAlibabaCredits({ ...record, model: "qwen3.8-max" }, undefined)).toBe(0);
      expect(
        estimateAlibabaCredits(
          { ...record, model: "deepseek-v4.1-flash" },
          getAlibabaModelRates("deepseek-v4.1-flash", overrides),
        ),
      ).toBe(125); // 1e6 * 0.25e-6 / 0.002
      expect(getAlibabaModelRates("qwen3.8-max", overrides).cacheRead).toBe(0);
    });
  });

  describe("resolveAlibabaWeeklyBucket (vendor reset cadence)", () => {
    it("projects a past reset instant forward to the bucket that contains now", () => {
      const now = Date.parse("2026-09-20T20:53:00Z");
      // The console read "Reset time 2026-09-26 15:05:00" for a plan whose
      // previous bucket therefore started 2026-09-19 15:05:00.
      const bucket = resolveAlibabaWeeklyBucket("2026-09-26T15:05:00Z", now);
      expect(bucket.start).toBe(Date.parse("2026-09-19T15:05:00Z"));
      expect(bucket.end).toBe(Date.parse("2026-09-26T15:05:00Z"));
    });

    it("keeps rolling the same instant week after week", () => {
      const bucket = resolveAlibabaWeeklyBucket(
        "2026-09-26T15:05:00Z",
        Date.parse("2026-10-10T00:00:00Z"),
      );
      expect(new Date(bucket.end).toISOString()).toBe("2026-10-10T15:05:00.000Z");
      expect(new Date(bucket.start).toISOString()).toBe("2026-10-03T15:05:00.000Z");
    });

    it("rejects missing, zero and unparsable hints so the callers fall back", () => {
      const now = Date.now();
      for (const hint of [null, undefined, "", 0, false, "not-a-date"]) {
        expect(resolveAlibabaWeeklyBucket(hint, now)).toBeNull();
      }
    });

    it("still yields a bucket containing now when the hint is far in the future", () => {
      const now = Date.parse("2026-09-20T20:53:00Z");
      const bucket = resolveAlibabaWeeklyBucket("2026-11-01T00:00:00Z", now);
      expect(bucket.start).toBeLessThanOrEqual(now);
      expect(bucket.end).toBeGreaterThan(now);
    });

    it("counts only rows inside the bucket and never rows from the future", () => {
      const bucket = { start: 1000, end: 2000 };
      const meta = alibabaBucketMeta(
        [
          { timestamp: 999, promptTokens: 1000000, completionTokens: 0 }, // before
          { timestamp: 1000, promptTokens: 1000000, completionTokens: 0 }, // counted
          { timestamp: 1999, promptTokens: 1000000, completionTokens: 0 }, // after now
          { timestamp: 2000, promptTokens: 1000000, completionTokens: 0 }, // half-open end
        ],
        bucket,
        true,
        1499,
      );
      expect(meta.used).toBe(1000);
      expect(meta.start).toBe(1000);
      expect(meta.end).toBe(2000);
    });
  });

  describe("console-anchored calibration (2026-09-20)", () => {
    // Real traffic of connection e9868390 (alitp-intl) at the instant the
    // console was read, aggregated per model from ~/.9router/db/data.sqlite:
    //   glm-5.3              12 req  504,042 prompt  358,912 cached  4,543 out
    //   qwen3.8-max          20 req 2,164,862 prompt 2,125,824 cached 30,535 out
    //   deepseek-v4.1-flash  77 req 6,861,697 prompt 6,240,640 cached 76,092 out
    // Console at 20:53Z: "Remaining 39.7%", total 2,500 => 1,507.5 used.
    const CONSOLE_USED = 0.603 * 2500;
    const RESET_AT = "2026-09-26T15:05:00Z";
    const NOW = Date.parse("2026-09-20T20:53:00Z");
    const row = (t, model, prompt, cached, completion) => ({
      timestamp: new Date(t).toISOString(),
      model,
      promptTokens: prompt,
      completionTokens: completion,
      tokens: JSON.stringify({
        prompt_tokens: prompt,
        completion_tokens: completion,
        cached_tokens: cached,
      }),
    });
    const rows = [
      // Traffic from the PREVIOUS bucket (09-11, still inside the 7-day SQL
      // fetch) must not be counted into the current bucket.
      row("2026-09-11T16:15:15Z", "qwen3.8-max", 2190302, 2100000, 25278),
      row("2026-09-20T19:03:09Z", "glm-5.3", 504042, 358912, 4543),
      row("2026-09-20T19:34:29Z", "qwen3.8-max", 2164862, 2125824, 30535),
      row("2026-09-20T20:51:22Z", "deepseek-v4.1-flash", 6861697, 6240640, 76092),
    ];

    it("lands far below exhaustion where the cache-charged meter read 11% left", () => {
      const result = calcSlidingWindowUsage(rows, NOW, {
        unit: "credits",
        plan: "Lite",
        alitpResetAt: RESET_AT,
      });
      const quota = result.quotas["Créditos 7d (estimado)"];
      expect(quota.total).toBe(2500);
      expect(quota.used).toBeCloseTo(1138.7, 1);
      // Pre-fix this was 2,229.4 used (10.8% left, and 0% ten minutes later).
      expect(quota.used).toBeLessThan(2500);
      expect(quota.remainingPercentage).toBeGreaterThan(30);
      // The reset is the vendor's weekly instant, not first-request + 7d.
      expect(quota.resetAt).toBe("2026-09-26T15:05:00.000Z");
    });

    it("matches the console exactly once the window carries its measured offset", () => {
      // The console counts drawdown this router cannot see (foreign clients on
      // the same key, and the vendor's unpublished per-model coefficients).
      // untrackedCredits7d is that measured gap, pinned to the bucket start.
      const result = calcSlidingWindowUsage(rows, NOW, {
        unit: "credits",
        alitpResetAt: RESET_AT,
        untrackedCredits7d: CONSOLE_USED - 1138.7,
        untrackedCredits7dWindowStart: "2026-09-19T15:05:00Z",
      });
      const quota = result.quotas["Créditos 7d (estimado)"];
      expect(quota.used).toBeCloseTo(CONSOLE_USED, 0);
      expect(quota.remainingPercentage).toBeCloseTo(39.7, 0);
    });

    it("drops the offset once its window start no longer matches", () => {
      const result = calcSlidingWindowUsage(rows, NOW, {
        unit: "credits",
        alitpResetAt: RESET_AT,
        untrackedCredits7d: 368.8,
        untrackedCredits7dWindowStart: "2026-09-13T15:05:00Z",
      });
      expect(result.quotas["Créditos 7d (estimado)"].used).toBeCloseTo(1138.7, 1);
    });

    it("uses the fresh 429 reset as the bucket when providerSpecificData has none", async () => {
      const now = Date.parse("2026-09-12T13:26:00Z");
      getAdapter.mockResolvedValue({
        all: vi.fn().mockReturnValue([
          row("2026-09-11T16:15:15Z", "qwen3.8-max", 2190302, 2100000, 25278),
          row("2026-09-12T12:00:00Z", "glm-5.3", 504042, 358912, 4543),
        ]),
        get: vi.fn(),
      });

      const result = await getAlibabaTokenPlanUsage(
        {
          connectionId: "conn-alitp",
          providerSpecificData: { plan: "Lite" },
          lastError:
            '[429]: {"error":{"message":"Your token-plan 1-week quota has been exhausted. The quota will reset at 09-18 16:04:00 UTC."}}',
          lastErrorAt: "2026-09-12T13:22:00Z",
        },
        now,
      );

      // Bucket = 09-11 16:04 → 09-18 16:04: the 09-12 row counts, the earlier
      // 09-11 16:15 row is inside it too, and the vendor reset is reported.
      const quota = result.quotas["Créditos 7d (estimado)"];
      expect(quota.resetAt).toBe("2026-09-18T16:04:00.000Z");
      expect(quota.used).toBe(2500); // 429 still fills the ceiling
    });
  });

  describe("alibabaWindowMeta (Anchored Sliding Window)", () => {
    it("anchors window start to the first item timestamp and aggregates until end", () => {
      const now = 10000000;
      const windowMs = 5 * 3600 * 1000; // 5 hours = 18,000,000 ms
      const records = [
        { timestamp: now - 1000000, promptTokens: 1000000, completionTokens: 0 },
        { timestamp: now - 500000, promptTokens: 1000000, completionTokens: 0 },
      ];
      // Both records fall into window starting at (now - 1000000)
      const meta = alibabaWindowMeta(records, windowMs, now, true);
      expect(meta.start).toBe(now - 1000000);
      expect(meta.end).toBe(now - 1000000 + windowMs);
      expect(meta.used).toBe(2000); // 1000 credits each
    });

    it("creates a new anchor when an item exceeds previous window end", () => {
      const windowMs = 10000; // 10s
      const now = 25000; // Within Window 2 (20000 to 30000)
      const records = [
        { timestamp: 1000, promptTokens: 1000000, completionTokens: 0 }, // Window 1: 1000 to 11000
        { timestamp: 20000, promptTokens: 1000000, completionTokens: 0 }, // Window 2: 20000 to 30000
      ];
      const meta = alibabaWindowMeta(records, windowMs, now, true);
      // Last active window anchored at 20000
      expect(meta.start).toBe(20000);
      expect(meta.end).toBe(30000);
      expect(meta.used).toBe(1000);
    });
  });

  describe("alibabaUntracked7d", () => {
    it("includes untracked credits when window start matches hint within 2000ms", () => {
      const limits = {
        untrackedCredits7d: 500,
        untrackedCredits7dWindowStart: 10000,
      };
      expect(alibabaUntracked7d(limits, 10500)).toBe(500);
    });

    it("returns 0 when window start differs from hint by more than 2000ms", () => {
      const limits = {
        untrackedCredits7d: 500,
        untrackedCredits7dWindowStart: 10000,
      };
      expect(alibabaUntracked7d(limits, 15000)).toBe(0);
    });

    it("returns extra when no window start hint is provided", () => {
      const limits = { untrackedCredits7d: 500 };
      expect(alibabaUntracked7d(limits, 10000)).toBe(500);
    });
  });

  describe("calcSlidingWindowUsage (Exact Quota Names & Structure)", () => {
    it("produces correct credit quota structure and exact Portuguese names", () => {
      const now = Date.now();
      const records = [
        { timestamp: now - 1000, promptTokens: 1000000, completionTokens: 0 },
      ];
      const result = calcSlidingWindowUsage(records, now, { plan: "Lite", unit: "credits" });

      expect(result.plan).toBe("Alibaba Token Plan Lite (créditos estimados)");
      expect(result.status).toBe("ok");
      expect(result.source).toBe("router-local");
      expect(result.fetchedAt).toBe(new Date(now).toISOString());
      expect(result.quotas["Créditos 7d (estimado)"]).toBeDefined();
      expect(result.quotas["Créditos 7d (estimado)"].used).toBe(1000);
      expect(result.quotas["Créditos 7d (estimado)"].total).toBe(2500);
      expect(result.quotas["Créditos 7d (estimado)"].resetAt).toBe(
        new Date(now - 1000 + 7 * 86400 * 1000).toISOString()
      );
      expect(result.quotas["Créditos 5h (estimado)"]).toBeUndefined();
    });

    it("produces raw token quota names when unit is not credits", () => {
      const now = Date.now();
      const records = [
        { timestamp: now - 1000, promptTokens: 500, completionTokens: 500 },
      ];
      const result = calcSlidingWindowUsage(records, now, { unit: "tokens" });

      expect(result.plan).toBe("Alibaba Token Plan (medido pelo router)");
      expect(result.quotas["Consumo 7d (medido local)"]).toBeDefined();
      expect(result.quotas["Consumo 7d (medido local)"].used).toBe(1000);
      expect(result.quotas["Consumo 5h (medido local)"]).toBeUndefined();
    });
  });

  describe("getAlibabaTokenPlanUsage (Isolated DB queries)", () => {
    it("fetches usageHistory by connectionId when connectionId is provided", async () => {
      const now = Date.now();
      const mockAll = vi.fn().mockReturnValue([
        { promptTokens: 1000000, completionTokens: 0, timestamp: now - 5000 },
      ]);
      const mockDb = { all: mockAll, get: vi.fn() };
      getAdapter.mockResolvedValue(mockDb);

      const ctx = {
        connectionId: "conn-abc-123",
        providerSpecificData: { plan: "Standard" },
      };

      const result = await getAlibabaTokenPlanUsage(ctx, now);

      expect(getAdapter).toHaveBeenCalledTimes(1);
      expect(mockAll).toHaveBeenCalledWith(
        expect.stringContaining("WHERE connectionId = ? AND timestamp >= ?"),
        ["conn-abc-123", expect.any(String)]
      );
      // D13/REV-D: combo attempt-failure rows (status 'error:*') must never
      // anchor the sliding 7d window; removing the clause must fail here.
      expect(mockAll.mock.calls[0][0]).toContain("status NOT LIKE 'error%'");
      expect(result.plan).toBe("Alibaba Token Plan Standard (créditos estimados)");
      expect(result.quotas["Créditos 7d (estimado)"].used).toBe(1000);
    });

    it("resolves connectionId from apiKey via providerConnections when connectionId is missing", async () => {
      const now = Date.now();
      const mockGet = vi.fn().mockReturnValue({ id: "resolved-conn-456" });
      const mockAll = vi.fn().mockReturnValue([
        { promptTokens: 1000000, completionTokens: 0, timestamp: now - 2000 },
      ]);
      const mockDb = { get: mockGet, all: mockAll };
      getAdapter.mockResolvedValue(mockDb);

      const ctx = {
        apiKey: "sk-alitp-secret-key",
        providerSpecificData: { plan: "Pro" },
      };

      const result = await getAlibabaTokenPlanUsage(ctx, now);

      expect(mockGet).toHaveBeenCalledWith(
        expect.stringContaining("FROM providerConnections"),
        ["sk-alitp-secret-key"]
      );
      expect(mockAll).toHaveBeenCalledWith(
        expect.stringContaining("WHERE connectionId = ? AND timestamp >= ?"),
        ["resolved-conn-456", expect.any(String)]
      );
      expect(result.plan).toBe("Alibaba Token Plan Pro (créditos estimados)");
    });

    it("reads lastError from the connection row, not the narrowed dispatcher ctx", async () => {
      const now = Date.parse("2026-09-12T13:26:00Z");
      const row = {
        data: JSON.stringify({
          lastError:
            '[429]: {"error":{"message":"Your token-plan 1-week quota has been exhausted. The quota will reset at 09-18 16:04:00 UTC."}}',
          lastErrorAt: "2026-09-12T13:22:00Z",
        }),
      };
      const mockGet = vi.fn().mockReturnValue(row);
      getAdapter.mockResolvedValue({
        get: mockGet,
        all: vi.fn().mockReturnValue([
          { promptTokens: 1000000, completionTokens: 0, timestamp: now - 7200000 },
        ]),
      });

      // getUsageForProvider builds this ctx: connectionId only, no error fields.
      const result = await getAlibabaTokenPlanUsage(
        { connectionId: "conn-alitp", providerSpecificData: { plan: "Lite" } },
        now,
      );

      expect(mockGet).toHaveBeenCalledWith(
        expect.stringContaining("SELECT data FROM providerConnections WHERE id = ?"),
        ["conn-alitp"],
      );
      expect(result.quotas["Créditos 7d (estimado)"].used).toBe(2500);
      expect(result.quotas["Créditos 7d (estimado)"].resetAt).toBe("2026-09-18T16:04:00.000Z");
    });

    it("handles DB errors gracefully and returns valid result with zero usage", async () => {
      getAdapter.mockRejectedValue(new Error("Database disk I/O error"));

      const ctx = { connectionId: "conn-err" };
      const result = await getAlibabaTokenPlanUsage(ctx);

      expect(result.status).toBe("ok");
      expect(result.source).toBe("router-local");
      expect(result.quotas["Créditos 7d (estimado)"].used).toBe(0);
    });
  });

  describe("vendor 429 exhaustion (authoritative over the local estimate)", () => {
    const EXHAUSTED =
      '[429]: {"error":{"message":"Your token-plan 1-week quota has been exhausted. The quota will reset at 09-18 16:04:00 UTC.","type":"insufficient_quota"}}';

    it("parses the reset instant the vendor prints without a year", () => {
      const now = Date.parse("2026-09-12T13:26:00Z");
      expect(parseAlibabaResetAt(EXHAUSTED, now)).toBe("2026-09-18T16:04:00.000Z");
    });

    it("rolls the reset to the next year when the printed date is behind us", () => {
      const now = Date.parse("2026-12-30T00:00:00Z");
      expect(parseAlibabaResetAt(EXHAUSTED, now)).toBe("2027-09-18T16:04:00.000Z");
    });

    it("ignores errors that are not a quota exhaustion, or are stale", () => {
      const now = Date.parse("2026-09-12T13:26:00Z");
      expect(alibabaQuotaExhaustion("[500]: upstream exploded", now, now)).toBeNull();
      expect(alibabaQuotaExhaustion(EXHAUSTED, "2026-09-01T00:00:00Z", now)).toBeNull();
      expect(alibabaQuotaExhaustion(EXHAUSTED, "2026-09-12T13:22:00Z", now)).toEqual({
        at: Date.parse("2026-09-12T13:22:00Z"),
        resetAt: "2026-09-18T16:04:00.000Z",
      });
    });

    it("fills the weekly quota to the ceiling with the vendor resetAt", () => {
      const now = Date.parse("2026-09-12T13:26:00Z");
      const result = calcSlidingWindowUsage([], now, { plan: "Lite", unit: "credits" });
      applyAlibabaQuotaExhaustion(
        result,
        { lastError: EXHAUSTED, lastErrorAt: "2026-09-12T13:22:00Z" },
        [],
        now,
      );

      const quota = result.quotas["Créditos 7d (estimado)"];
      expect(quota.used).toBe(2500);
      expect(quota.total).toBe(2500);
      expect(quota.remainingPercentage).toBe(0);
      expect(quota.resetAt).toBe("2026-09-18T16:04:00.000Z");
    });

    it("stops reporting exhaustion once a call succeeds after the 429", () => {
      const now = Date.parse("2026-09-12T13:26:00Z");
      const result = calcSlidingWindowUsage(
        [{ timestamp: now - 1000, promptTokens: 1000000, completionTokens: 0 }],
        now,
        { unit: "credits" },
      );
      applyAlibabaQuotaExhaustion(
        result,
        { lastError: EXHAUSTED, lastErrorAt: "2026-09-12T13:00:00Z" },
        [{ timestamp: now - 1000, promptTokens: 1000000, completionTokens: 0 }],
        now,
      );

      expect(result.quotas["Créditos 7d (estimado)"].used).toBe(1000);
    });

    it("surfaces the vendor state through getAlibabaTokenPlanUsage", async () => {
      const now = Date.parse("2026-09-12T13:26:00Z");
      getAdapter.mockResolvedValue({
        all: vi.fn().mockReturnValue([
          { promptTokens: 1000000, completionTokens: 0, timestamp: now - 7200000 },
        ]),
        get: vi.fn(),
      });

      const result = await getAlibabaTokenPlanUsage(
        {
          connectionId: "conn-alitp",
          providerSpecificData: { plan: "Lite" },
          lastError: EXHAUSTED,
          lastErrorAt: "2026-09-12T13:22:00Z",
        },
        now,
      );

      expect(result.quotas["Créditos 7d (estimado)"].remainingPercentage).toBe(0);
      expect(result.quotas["Créditos 7d (estimado)"].resetAt).toBe("2026-09-18T16:04:00.000Z");
    });
  });
});
