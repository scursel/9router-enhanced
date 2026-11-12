import { describe, expect, it } from "vitest";
import {
  CONNECTIONS_PAGE_SIZE,
  ACCOUNT_PAGE_SIZE_MAX,
  shouldShowQuotaCard,
  sortVisibleConnections,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers.js";
import { USAGE_IMPLEMENTED_PROVIDERS } from "open-sse/services/usage.js";
import REGISTRY from "open-sse/providers/registry/index.js";

describe("quota tracker list", () => {
  describe("shouldShowQuotaCard", () => {
    it("hides a loaded card whose only content is Usage API not implemented", () => {
      expect(
        shouldShowQuotaCard({
          loading: false,
          error: null,
          quota: { quotas: [], message: "Usage API not implemented for dahl" },
        }),
      ).toBe(false);
    });

    it("keeps a card whose only content is a provider message explaining the missing quota", () => {
      for (const message of [
        "Kiro quota API authentication expired. Chat may still work.",
        "Groq authentication failed. Check the API key.",
      ]) {
        expect(
          shouldShowQuotaCard({ loading: false, error: null, quota: { quotas: [], message } }),
        ).toBe(true);
      }
    });

    it("hides a loaded card with no visible quota rows", () => {
      expect(
        shouldShowQuotaCard({
          loading: false,
          error: null,
          quota: { quotas: [], message: "Usage not available for this connection" },
        }),
      ).toBe(false);
    });

    it("keeps cards that have at least one visible quota row", () => {
      expect(
        shouldShowQuotaCard({
          loading: false,
          error: null,
          quota: {
            quotas: [{ name: "Weekly", used: 10, total: 100 }],
            message: null,
          },
        }),
      ).toBe(true);
    });

    it("keeps cards that are still loading", () => {
      expect(
        shouldShowQuotaCard({
          loading: true,
          error: null,
          quota: null,
        }),
      ).toBe(true);
    });

    it("keeps cards that failed to fetch so the error stays visible", () => {
      expect(
        shouldShowQuotaCard({
          loading: false,
          error: "Failed to fetch quota",
          quota: { quotas: [] },
        }),
      ).toBe(true);
    });

    it("does not bring an empty card back while it refreshes", () => {
      expect(
        shouldShowQuotaCard({
          loading: true,
          error: null,
          quota: { quotas: [], message: "Usage API not implemented for dahl" },
        }),
      ).toBe(false);
    });
  });

  describe("same-provider accounts stay adjacent", () => {
    const mixed = [
      { id: "c1", provider: "claude", name: "Claude 1" },
      { id: "g1", provider: "github", name: "GitHub 1" },
      { id: "c2", provider: "claude", name: "Claude 2" },
      { id: "x1", provider: "codex", name: "Codex 1" },
      { id: "g2", provider: "github", name: "GitHub 2" },
      { id: "c3", provider: "claude", name: "Claude 3" },
    ];

    function providerRuns(connections) {
      const runs = [];
      for (const conn of connections) {
        const last = runs[runs.length - 1];
        if (last && last.provider === conn.provider) last.count += 1;
        else runs.push({ provider: conn.provider, count: 1 });
      }
      return runs;
    }

    it("groups mixed accounts so every provider occupies one contiguous run", () => {
      const sorted = sortVisibleConnections(mixed, {}, false, "all", "default");
      expect(sorted.map((c) => c.provider)).toEqual([
        "claude",
        "claude",
        "claude",
        "github",
        "github",
        "codex",
      ]);
      expect(providerRuns(sorted).map((run) => run.provider)).toEqual([
        "claude",
        "github",
        "codex",
      ]);
    });

    it("still keeps same-provider accounts together when sorting by earliest reset", () => {
      const quotaData = {
        c1: { quotas: [{ resetAt: "2099-01-03T00:00:00Z" }] },
        c2: { quotas: [{ resetAt: "2099-01-01T00:00:00Z" }] },
        c3: { quotas: [{ resetAt: "2099-01-02T00:00:00Z" }] },
        g1: { quotas: [{ resetAt: "2099-01-01T00:00:00Z" }] },
        g2: { quotas: [{ resetAt: "2099-01-04T00:00:00Z" }] },
        x1: { quotas: [{ resetAt: "2099-01-02T00:00:00Z" }] },
      };

      const sorted = sortVisibleConnections(mixed, quotaData, true, "all", "default");
      const runs = providerRuns(sorted);
      expect(runs.map((run) => run.provider).sort()).toEqual([
        "claude",
        "codex",
        "github",
      ]);
      expect(runs.find((run) => run.provider === "claude").count).toBe(3);
      expect(runs.find((run) => run.provider === "github").count).toBe(2);
      expect(sorted.filter((c) => c.provider === "claude").map((c) => c.id)).toEqual([
        "c2",
        "c3",
        "c1",
      ]);
    });
  });

  describe("quota page size", () => {
    it("does not default to a 20-account cap", () => {
      expect(CONNECTIONS_PAGE_SIZE).toBeGreaterThan(20);
      expect(CONNECTIONS_PAGE_SIZE).toBe(ACCOUNT_PAGE_SIZE_MAX);
    });
  });

  describe("usage-flagged providers", () => {
    it("does not list gateway providers that have no quota collector", () => {
      expect(USAGE_SUPPORTED_PROVIDERS).not.toContain("dahl");
      expect(USAGE_SUPPORTED_PROVIDERS).not.toContain("bai");
      expect(USAGE_SUPPORTED_PROVIDERS).not.toContain("orcarouter");
      expect(USAGE_SUPPORTED_PROVIDERS).not.toContain("trae");
    });

    it("only flags providers that actually implement a usage collector", () => {
      const flagged = REGISTRY.filter((r) => r.features?.usage).map((r) => r.id);
      for (const id of flagged) {
        expect(USAGE_IMPLEMENTED_PROVIDERS, id).toContain(id);
        expect(USAGE_SUPPORTED_PROVIDERS, id).toContain(id);
      }
      expect(flagged).not.toContain("dahl");
    });
  });
});
