// Migration 003 — clears backoff ladders inflated by the pre-policy heuristic.
//
// The code fix stops new escalation; this migration removes the ladder already
// stored on the credentials. Without it the fix would be live while the accounts
// still behaved as if it were not: a stored level of 15 prices the NEXT failure
// at the 5-minute tier.
import { describe, expect, it, vi } from "vitest";

import migration from "../../src/lib/db/migrations/003-reset-inflated-cline-backoff.js";

/** Minimal adapter surface the migration uses (matches src/lib/db/migrate.js). */
function fakeDb(rows) {
  const updates = [];
  return {
    updates,
    all: vi.fn(() => rows),
    run: vi.fn((sql, params) => updates.push({ sql, params }))
  };
}

const row = (id, provider, data) => ({ id, provider, data: JSON.stringify(data) });

const STALE = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const RECENT = new Date(Date.now() - 30 * 1000).toISOString();

describe("migration 003 — reset inflated Cline backoff ladders", () => {
  it("registers as version 3 with a stable name", () => {
    expect(migration.version).toBe(3);
    expect(migration.name).toBe("reset-inflated-cline-backoff");
  });

  it("resets a stale inflated ladder and preserves the rest of the row", () => {
    const lockKey = "modelLock_z-ai/glm-5.2:free";
    const db = fakeDb([
      row("acc-1", "clinepass", {
        backoffLevel: 15,
        lastErrorAt: STALE,
        email: "scursel@gmail.com",
        [lockKey]: STALE
      })
    ]);

    migration.up(db);

    expect(db.updates).toHaveLength(1);
    const written = JSON.parse(db.updates[0].params[0]);
    expect(written.backoffLevel).toBe(0);
    // Untouched fields survive the round-trip.
    expect(written.email).toBe("scursel@gmail.com");
    expect(written[lockKey]).toBe(STALE);
    expect(db.updates[0].params[1]).toBe("acc-1");
  });

  it("leaves a level below the threshold alone (a genuine ladder is respected)", () => {
    const db = fakeDb([row("acc-1", "clinepass", { backoffLevel: 3, lastErrorAt: STALE })]);
    migration.up(db);
    expect(db.updates).toHaveLength(0);
  });

  it("resets a ladder whose locks have all expired, however recent the last attempt", () => {
    // lastErrorAt is rewritten on every attempt (health probes included), so a
    // recency window never closes on a busy account. Lock expiry is the honest
    // discriminator: no active lock ⇒ residual ladder.
    const expiredLockKey = "modelLock_some/model";
    const db = fakeDb([
      row("acc-1", "clinepass", {
        backoffLevel: 15,
        lastErrorAt: RECENT,
        [expiredLockKey]: STALE
      }),
      row("acc-2", "clinepass", { backoffLevel: 15, lastErrorAt: RECENT })
    ]);
    migration.up(db);
    expect(db.updates).toHaveLength(2);
    for (const update of db.updates) {
      expect(JSON.parse(update.params[0]).backoffLevel).toBe(0);
    }
  });

  it("leaves a ladder with a live lock alone (that cooldown is meant)", () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const liveLockKey = "modelLock_z-ai/glm-5.2:free";
    const db = fakeDb([
      row("acc-1", "clinepass", {
        backoffLevel: 15,
        lastErrorAt: STALE,
        [liveLockKey]: future
      })
    ]);
    migration.up(db);
    expect(db.updates).toHaveLength(0);
  });

  it("resets when the failure timestamp is missing or unparseable", () => {
    const db = fakeDb([
      row("acc-1", "clinepass", { backoffLevel: 15 }),
      row("acc-2", "clinepass", { backoffLevel: 12, lastErrorAt: "not-a-date" })
    ]);
    migration.up(db);
    expect(db.updates).toHaveLength(2);
    for (const update of db.updates) {
      expect(JSON.parse(update.params[0]).backoffLevel).toBe(0);
    }
  });

  it("never touches a different provider's ladder", () => {
    const db = fakeDb([
      row("acc-antigravity", "antigravity", { backoffLevel: 15, lastErrorAt: STALE }),
      row("acc-codex", "codex", { backoffLevel: 15, lastErrorAt: STALE })
    ]);
    migration.up(db);
    expect(db.updates).toHaveLength(0);
  });

  it("survives an unreadable row without writing anything", () => {
    const db = fakeDb([{ id: "acc-broken", provider: "clinepass", data: "{not json" }]);
    expect(() => migration.up(db)).not.toThrow();
    expect(db.updates).toHaveLength(0);
  });

  it("scopes the SELECT to the two Cline providers", () => {
    const db = fakeDb([]);
    migration.up(db);
    expect(db.all.mock.calls[0][0]).toContain("provider IN ('cline', 'clinepass')");
  });

  it("is a no-op on a legacy DB with no connection table yet (never fails the boot)", () => {
    // The versioned chain runs BEFORE the schema is synced, so on an old
    // database this SELECT legitimately throws "no such table". Regression
    // caught by unit/usage-event-identity.test.js (f2).
    const db = {
      all: vi.fn(() => {
        throw new Error("no such table: providerConnections");
      }),
      run: vi.fn()
    };
    expect(() => migration.up(db)).not.toThrow();
    expect(db.run).not.toHaveBeenCalled();
  });

  it("tolerates an adapter that returns a non-array", () => {
    const db = { all: vi.fn(() => undefined), run: vi.fn() };
    expect(() => migration.up(db)).not.toThrow();
    expect(db.run).not.toHaveBeenCalled();
  });

  it("is idempotent: a second run has nothing left to reset", () => {
    const first = fakeDb([row("acc-1", "clinepass", { backoffLevel: 15, lastErrorAt: STALE })]);
    migration.up(first);
    expect(first.updates).toHaveLength(1);

    const resetState = JSON.parse(first.updates[0].params[0]);
    const second = fakeDb([{ id: "acc-1", provider: "clinepass", data: JSON.stringify(resetState) }]);
    migration.up(second);
    expect(second.updates).toHaveLength(0);
  });
});