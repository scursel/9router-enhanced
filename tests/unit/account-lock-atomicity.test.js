// Audit items 1-3 (routing engine, account lock bookkeeping).
//
//  * item 1 — a short cooldown must never shorten an existing, still-active
//    model lock for the same key (an in-flight 5xx used to rewrite a 1 h quota
//    lock down to ~2 s, so the exhausted account was retried immediately);
//  * item 2 — the backoff level must be derived from the stored row inside the
//    write transaction: never lower the stored level, and escalate at most once
//    per active lock window (a burst must not walk the ladder N steps);
//  * item 3 — clearAccountError must decide what to clear from the row as it is
//    at write time, not from the request-time `credentials._connection` snapshot,
//    and a success on one model must not clear an active account-wide lock.
//
// The localDb mock below emulates the repo's atomic merge: the real
// updateProviderConnection resolves a function patch against the row it reads
// inside its synchronous transaction, then applies resetHealthStateOnActivation
// (the F27/RM5 activation contract). Both behaviours are reproduced here so the
// assertions describe what actually lands in the database.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetHealthStateOnActivation } from "../../src/lib/db/repos/connectionsRepo.js";

const state = vi.hoisted(() => ({ rows: [], writes: [] }));

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable, clearAccountError } = await import("../../src/sse/services/auth.js");

const future = (ms) => new Date(Date.now() + ms).toISOString();
const past = (ms) => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.writes = [];

  dbMocks.getProviderConnections.mockImplementation(async ({ provider } = {}) =>
    state.rows
      .filter((row) => !provider || row.provider === provider)
      .map((row) => ({ ...row })));

  dbMocks.updateProviderConnection.mockImplementation(async (id, patch) => {
    const row = state.rows.find((candidate) => candidate.id === id);
    if (!row) return null;
    const resolved = typeof patch === "function" ? patch({ ...row }) : patch;
    if (!resolved) return row;
    const normalized = resetHealthStateOnActivation({ ...row }, resolved);
    Object.assign(row, normalized);
    state.writes.push({ id, patch: resolved });
    return row;
  });
});

describe("item 1 — a model lock is never shortened", () => {
  it("keeps a 1 h lock when a transient 5xx proposes a 30 s one", async () => {
    const longUntil = future(60 * 60 * 1000);
    state.rows = [{ id: "acc-1", provider: "p", backoffLevel: 0, modelLock_M: longUntil }];

    await markAccountUnavailable("acc-1", 500, "Internal Server Error", "p", "M");

    expect(state.rows[0].modelLock_M).toBe(longUntil);
  });

  it("extends an active lock when the new wait reaches further", async () => {
    const soon = future(1000);
    state.rows = [{ id: "acc-1", provider: "p", backoffLevel: 0, modelLock_M: soon }];

    await markAccountUnavailable("acc-1", 500, "Internal Server Error", "p", "M");

    expect(new Date(state.rows[0].modelLock_M).getTime()).toBeGreaterThan(Date.now() + 25_000);
  });
});

describe("item 2 — the backoff level comes from the stored row", () => {
  it("never lowers the stored level when the request-time snapshot is stale", async () => {
    state.rows = [{ id: "acc-1", provider: "p", backoffLevel: 5 }];
    // The caller's snapshot was read before another request escalated the row.
    dbMocks.getProviderConnections.mockResolvedValueOnce([{ id: "acc-1", provider: "p", backoffLevel: 2 }]);

    await markAccountUnavailable("acc-1", 429, "rate limit exceeded", "p", "M");

    // New window (no active lock) → one escalation from the STORED level.
    expect(state.rows[0].backoffLevel).toBe(6);
    expect(new Date(state.rows[0].modelLock_M).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("does not escalate again inside an active lock window", async () => {
    const activeLock = future(60 * 1000);
    state.rows = [{ id: "acc-1", provider: "p", backoffLevel: 2, modelLock_M: activeLock }];
    // Stale snapshot: level 0 and no lock, as if read before the first failure.
    dbMocks.getProviderConnections.mockResolvedValueOnce([{ id: "acc-1", provider: "p", backoffLevel: 0 }]);

    await markAccountUnavailable("acc-1", 429, "rate limit exceeded", "p", "M");

    expect(state.rows[0].backoffLevel).toBe(2);
    expect(new Date(state.rows[0].modelLock_M).getTime()).toBeGreaterThanOrEqual(new Date(activeLock).getTime());
  });

  it("a burst of concurrent failures escalates once", async () => {
    state.rows = [{ id: "acc-1", provider: "p", backoffLevel: 0 }];

    await Promise.all([1, 2, 3].map(() =>
      markAccountUnavailable("acc-1", 429, "rate limit exceeded", "p", "M")));

    expect(state.rows[0].backoffLevel).toBe(1);
  });

  it("an upstream-stated reset keeps its exact window and restarts the ladder", async () => {
    const resetAt = Date.now() + 5 * 60 * 1000;
    state.rows = [{ id: "acc-1", provider: "p", backoffLevel: 4 }];

    await markAccountUnavailable("acc-1", 429, "rate limit exceeded", "p", "M", resetAt);

    expect(state.rows[0].backoffLevel).toBe(0);
    expect(Math.abs(new Date(state.rows[0].modelLock_M).getTime() - resetAt)).toBeLessThan(100);
  });
});

describe("item 3 — clearAccountError decides from the stored row", () => {
  it("does not reset error state while a fresh lock written after the snapshot is active", async () => {
    const fresh = future(10 * 60 * 1000);
    state.rows = [{
      id: "acc-1",
      provider: "p",
      testStatus: "unavailable",
      lastError: "boom",
      errorCode: 429,
      backoffLevel: 3,
      modelLock_other: fresh,
    }];
    // Request-time credentials snapshot: it never saw the lock above.
    const snapshot = { testStatus: "unavailable", lastError: "boom", backoffLevel: 3 };

    await clearAccountError("acc-1", { _connection: snapshot }, "M");

    expect(state.rows[0].testStatus).toBe("unavailable");
    expect(state.rows[0].backoffLevel).toBe(3);
    expect(state.rows[0].modelLock_other).toBe(fresh);
  });

  it("a success on one model does not clear an active account-wide lock", async () => {
    const monthly = future(20 * 24 * 60 * 60 * 1000);
    const modelLock = future(1000);
    state.rows = [{
      id: "acc-1",
      provider: "p",
      testStatus: "unavailable",
      lastError: "You've reached your additional usage limit for your plan.",
      backoffLevel: 0,
      modelLock___all: monthly,
      modelLock_M: modelLock,
    }];
    const snapshot = { ...state.rows[0] };

    await clearAccountError("acc-1", { _connection: snapshot }, "M");

    expect(state.rows[0].modelLock___all).toBe(monthly);
    expect(state.rows[0].modelLock_M).toBe(null);
    expect(state.rows[0].testStatus).toBe("unavailable");
  });

  it("clears the succeeded model and expired locks, then resets when nothing active remains", async () => {
    const active = future(60 * 1000);
    const expired = past(60 * 1000);
    state.rows = [{
      id: "acc-1",
      provider: "p",
      testStatus: "unavailable",
      lastError: "boom",
      backoffLevel: 2,
      modelLock_M: active,
      modelLock_old: expired,
    }];
    const snapshot = { ...state.rows[0] };

    await clearAccountError("acc-1", { _connection: snapshot }, "M");

    expect(state.rows[0].modelLock_M).toBe(null);
    expect(state.rows[0].modelLock_old).toBe(null);
    expect(state.rows[0].testStatus).toBe("active");
    expect(state.rows[0].backoffLevel).toBe(0);
  });

  it("lazily clears an expired lock the snapshot never saw", async () => {
    const expired = past(60 * 1000);
    state.rows = [{
      id: "acc-1",
      provider: "p",
      testStatus: "unavailable",
      lastError: "boom",
      modelLock_old: expired,
    }];
    // The snapshot reports the error state but predates the expired lock.
    const snapshot = { testStatus: "unavailable", lastError: "boom" };

    await clearAccountError("acc-1", { _connection: snapshot }, "M");

    expect(state.rows[0].modelLock_old).toBe(null);
    expect(state.rows[0].testStatus).toBe("active");
  });
});
