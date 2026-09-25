// Task 4 — daily auto-import runner + scheduler. Covers
// src/lib/modelImport/{autoImport,scheduler}.js.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isAutoImportDue,
  runAutoImportForProvider,
  runAllAutoImports,
} from "../../src/lib/modelImport/autoImport.js";

// ---------------------------------------------------------------------------
// isAutoImportDue — pure predicate
// ---------------------------------------------------------------------------
describe("isAutoImportDue", () => {
  it("is false when the rule is disabled", () => {
    const cfg = { enabled: false, hour: 4, lastRunAt: null };
    expect(isAutoImportDue(cfg, new Date(2026, 0, 1, 10, 0))).toBe(false);
  });

  it("is false before the configured hour, even with no prior run", () => {
    const cfg = { enabled: true, hour: 4, lastRunAt: null };
    expect(isAutoImportDue(cfg, new Date(2026, 0, 1, 3, 59))).toBe(false);
  });

  it("is false when already run today (same local calendar day, later hour)", () => {
    const cfg = { enabled: true, hour: 4, lastRunAt: new Date(2026, 0, 1, 5, 0).toISOString() };
    expect(isAutoImportDue(cfg, new Date(2026, 0, 1, 20, 0))).toBe(false);
  });

  it("is true once the local day has rolled over since the last run", () => {
    const cfg = { enabled: true, hour: 4, lastRunAt: new Date(2026, 0, 1, 5, 0).toISOString() };
    expect(isAutoImportDue(cfg, new Date(2026, 0, 2, 4, 0))).toBe(true);
  });

  it("is true at/after the configured hour when lastRunAt is null", () => {
    const cfg = { enabled: true, hour: 4, lastRunAt: null };
    expect(isAutoImportDue(cfg, new Date(2026, 0, 1, 4, 0))).toBe(true);
    expect(isAutoImportDue(cfg, new Date(2026, 0, 1, 23, 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runAutoImportForProvider
// ---------------------------------------------------------------------------
describe("runAutoImportForProvider", () => {
  it("forces onlyNew regardless of the rule's own filter, and passes rule.testFirst through", async () => {
    const candidates = [
      { id: "a", name: "A", kind: "llm", tier: "free", alreadyImported: false },
      { id: "b", name: "B", kind: "llm", tier: "free", alreadyImported: true },
    ];
    const listImportCandidates = vi.fn(async () => ({ storageAlias: "oc", candidates }));
    const runImport = vi.fn(async () => ({ imported: ["a"], failed: [] }));

    // The saved rule explicitly asks for onlyNew: false — the auto sweep must
    // still exclude "b" (already imported).
    const rule = { filters: { onlyNew: false }, testFirst: true };
    const result = await runAutoImportForProvider("opencode", rule, { listImportCandidates, runImport });

    expect(listImportCandidates).toHaveBeenCalledWith("opencode", {});
    expect(runImport).toHaveBeenCalledWith({
      storageAlias: "oc",
      models: [{ id: "a", kind: "llm", name: "A" }],
      testFirst: true,
    });
    expect(result).toEqual({ providerId: "opencode", imported: 1, failed: 0 });
  });

  it("skips runImport and reports zero when nothing survives filtering", async () => {
    const listImportCandidates = vi.fn(async () => ({
      storageAlias: "oc",
      candidates: [{ id: "a", name: "A", kind: "llm", tier: "free", alreadyImported: true }],
    }));
    const runImport = vi.fn();

    const result = await runAutoImportForProvider(
      "opencode",
      { filters: {}, testFirst: false },
      { listImportCandidates, runImport },
    );

    expect(runImport).not.toHaveBeenCalled();
    expect(result).toEqual({ providerId: "opencode", imported: 0, failed: 0 });
  });

  it("reports imported/failed counts from runImport", async () => {
    const listImportCandidates = vi.fn(async () => ({
      storageAlias: "oc",
      candidates: [
        { id: "a", name: "A", kind: "llm", tier: "free", alreadyImported: false },
        { id: "b", name: "B", kind: "llm", tier: "free", alreadyImported: false },
      ],
    }));
    const runImport = vi.fn(async () => ({ imported: ["a"], failed: [{ id: "b", error: "nope" }] }));

    const result = await runAutoImportForProvider(
      "opencode",
      { filters: {}, testFirst: false },
      { listImportCandidates, runImport },
    );

    expect(result).toEqual({ providerId: "opencode", imported: 1, failed: 1 });
  });

  it("captures a thrown error on the result instead of throwing (candidate lookup fails)", async () => {
    const listImportCandidates = vi.fn(async () => {
      throw new Error("connection down");
    });

    const result = await runAutoImportForProvider(
      "opencode",
      { filters: {}, testFirst: false },
      { listImportCandidates },
    );

    expect(result).toEqual({ providerId: "opencode", imported: 0, failed: 0, error: "connection down" });
  });

  it("captures a thrown error on the result instead of throwing (runImport fails)", async () => {
    const listImportCandidates = vi.fn(async () => ({
      storageAlias: "oc",
      candidates: [{ id: "a", name: "A", kind: "llm", tier: "free", alreadyImported: false }],
    }));
    const runImport = vi.fn(async () => {
      throw new Error("db write failed");
    });

    const result = await runAutoImportForProvider(
      "opencode",
      { filters: {}, testFirst: false },
      { listImportCandidates, runImport },
    );

    expect(result).toEqual({ providerId: "opencode", imported: 0, failed: 0, error: "db write failed" });
  });
});

// ---------------------------------------------------------------------------
// runAllAutoImports
// ---------------------------------------------------------------------------
describe("runAllAutoImports", () => {
  it("runs every rule, captures a per-provider error without stopping the sweep, and persists lastRunAt/lastResult", async () => {
    const rules = {
      good: { filters: {}, testFirst: false },
      bad: { filters: {}, testFirst: false },
    };
    const listImportRules = vi.fn(async () => rules);
    const listImportCandidates = vi.fn(async (providerId) => {
      if (providerId === "bad") throw new Error("connection down");
      return {
        storageAlias: providerId,
        candidates: [{ id: "m1", name: "M1", kind: "llm", tier: "free", alreadyImported: false }],
      };
    });
    const runImport = vi.fn(async () => ({ imported: ["m1"], failed: [] }));

    let stored = { autoModelImport: { enabled: true, hour: 4, lastRunAt: null, lastResult: null } };
    const getSettings = vi.fn(async () => ({ ...stored }));
    const updateSettings = vi.fn(async (patch) => {
      stored = { ...stored, ...patch };
      return stored;
    });

    const result = await runAllAutoImports({
      listImportRules,
      listImportCandidates,
      runImport,
      getSettings,
      updateSettings,
    });

    expect(result.busy).toBe(false);
    expect(result.providers).toEqual([
      { providerId: "good", imported: 1, failed: 0 },
      { providerId: "bad", imported: 0, failed: 0, error: "connection down" },
    ]);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(typeof result.at).toBe("string");
    expect(stored.autoModelImport.lastRunAt).toBe(result.at);
    expect(stored.autoModelImport.lastResult).toEqual({ at: result.at, providers: result.providers });
    // Never removes models: the sweep only reports imported/failed counts.
    expect(result.providers.every((p) => !("removed" in p))).toBe(true);
  });

  it("single-flight: a call made while a sweep is in progress returns {busy: true} and does not touch settings", async () => {
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const listImportRules = vi.fn(async () => {
      await gate;
      return {};
    });
    const getSettings = vi.fn(async () => ({
      autoModelImport: { enabled: true, hour: 4, lastRunAt: null, lastResult: null },
    }));
    const updateSettings = vi.fn(async () => {});

    const first = runAllAutoImports({ listImportRules, getSettings, updateSettings });
    const second = runAllAutoImports({ listImportRules, getSettings, updateSettings });

    await expect(second).resolves.toEqual({ busy: true });

    releaseFirst();
    const firstResult = await first;
    expect(firstResult.busy).toBe(false);
    expect(updateSettings).toHaveBeenCalledTimes(1);

    // The lock releases after completion — a subsequent call runs normally.
    const third = await runAllAutoImports({ listImportRules: vi.fn(async () => ({})), getSettings, updateSettings });
    expect(third.busy).toBe(false);
  });

  it("releases the single-flight lock even when a collaborator throws", async () => {
    const listImportRules = vi.fn(async () => {
      throw new Error("db unreachable");
    });
    const getSettings = vi.fn(async () => ({
      autoModelImport: { enabled: true, hour: 4, lastRunAt: null, lastResult: null },
    }));
    const updateSettings = vi.fn(async () => {});

    // First call with failing listImportRules returns a fail-open result.
    const first = await runAllAutoImports({ listImportRules, getSettings, updateSettings });
    expect(first.busy).toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();

    // The lock is released, so the second call runs normally (not {busy: true}).
    const second = await runAllAutoImports({
      listImportRules: vi.fn(async () => ({})),
      getSettings,
      updateSettings,
    });
    expect(second.busy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scheduler.js — startAutoModelImport / stopAutoModelImport
// ---------------------------------------------------------------------------
describe("startAutoModelImport / stopAutoModelImport", () => {
  const dbModulePath = "../../src/lib/db/index.js";
  const autoImportModulePath = "../../src/lib/modelImport/autoImport.js";

  let getSettingsMock;
  let isAutoImportDueMock;
  let runAllAutoImportsMock;

  beforeEach(() => {
    vi.useFakeTimers();
    getSettingsMock = vi.fn(async () => ({
      autoModelImport: { enabled: true, hour: 4, lastRunAt: null, lastResult: null },
    }));
    isAutoImportDueMock = vi.fn(() => true);
    runAllAutoImportsMock = vi.fn(async () => ({ busy: false, at: "2026-01-01T00:00:00.000Z", providers: [] }));

    vi.doMock(dbModulePath, () => ({ getSettings: getSettingsMock }));
    vi.doMock(autoImportModulePath, () => ({
      isAutoImportDue: isAutoImportDueMock,
      runAllAutoImports: runAllAutoImportsMock,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock(dbModulePath);
    vi.doUnmock(autoImportModulePath);
    vi.resetModules();
  });

  async function fresh() {
    vi.resetModules();
    return import("../../src/lib/modelImport/scheduler.js");
  }

  it("does nothing before the startup delay elapses", async () => {
    const mod = await fresh();
    mod.startAutoModelImport({ tickMs: 10_000, startupDelayMs: 500 });

    await vi.advanceTimersByTimeAsync(100);
    expect(getSettingsMock).not.toHaveBeenCalled();

    mod.stopAutoModelImport();
  });

  it("runs a sweep after the startup delay when due", async () => {
    const mod = await fresh();
    mod.startAutoModelImport({ tickMs: 60_000, startupDelayMs: 500 });

    await vi.advanceTimersByTimeAsync(500);

    expect(getSettingsMock).toHaveBeenCalledTimes(1);
    expect(isAutoImportDueMock).toHaveBeenCalledTimes(1);
    expect(runAllAutoImportsMock).toHaveBeenCalledTimes(1);

    mod.stopAutoModelImport();
  });

  it("skips runAllAutoImports when isAutoImportDue says no", async () => {
    isAutoImportDueMock.mockReturnValue(false);
    const mod = await fresh();
    mod.startAutoModelImport({ tickMs: 60_000, startupDelayMs: 500 });

    await vi.advanceTimersByTimeAsync(500);

    expect(getSettingsMock).toHaveBeenCalledTimes(1);
    expect(runAllAutoImportsMock).not.toHaveBeenCalled();

    mod.stopAutoModelImport();
  });

  it("never throws out of a tick even when getSettings rejects", async () => {
    getSettingsMock.mockRejectedValue(new Error("db down"));
    const mod = await fresh();
    mod.startAutoModelImport({ tickMs: 60_000, startupDelayMs: 500 });

    // The tick's own try/catch must swallow the rejection — advancing timers
    // must not itself throw or leave an unhandled rejection.
    await vi.advanceTimersByTimeAsync(500);
    expect(runAllAutoImportsMock).not.toHaveBeenCalled();

    mod.stopAutoModelImport();
  });

  it("is idempotent: a second start before stop is a no-op, and unrefs both timers", async () => {
    const mod = await fresh();
    expect(mod.startAutoModelImport({ tickMs: 60_000, startupDelayMs: 500 })).toBe(true);
    expect(mod.startAutoModelImport({ tickMs: 60_000, startupDelayMs: 500 })).toBe(false);
    expect(vi.getTimerCount()).toBe(2); // startup timeout + interval

    mod.stopAutoModelImport();
    expect(vi.getTimerCount()).toBe(0);

    expect(mod.startAutoModelImport({ tickMs: 60_000, startupDelayMs: 500 })).toBe(true);
    mod.stopAutoModelImport();
  });

  it("does not arm timers during next build (NEXT_PHASE=phase-production-build)", async () => {
    const originalPhase = process.env.NEXT_PHASE;
    try {
      process.env.NEXT_PHASE = "phase-production-build";
      const mod = await fresh();
      expect(mod.startAutoModelImport({ tickMs: 60_000, startupDelayMs: 500 })).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (originalPhase !== undefined) {
        process.env.NEXT_PHASE = originalPhase;
      } else {
        delete process.env.NEXT_PHASE;
      }
    }
  });
});
