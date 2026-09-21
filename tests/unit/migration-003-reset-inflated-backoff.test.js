// Migration 003 — clears backoff ladders inflated by the pre-policy heuristic.
//
// The code fix stops new escalation; this migration removes the ladder already
// stored on the credentials. Without it the fix would be live while the accounts
// still behaved as if it were not: a stored level of 15 prices the NEXT failure
// at the 5-minute tier.
import { describe, expect, it, vi } from "vitest";

import migration, {
  resetInflatedClineBackoff
} from "../../src/lib/db/migrations/003-reset-inflated-cline-backoff.js";

/**
 * Minimal adapter surface the migration uses (matches src/lib/db/migrate.js).
 * Honours the `provider IN (?, ?)` binding like a real engine: a double that
 * returns every row regardless of the WHERE clause cannot prove the provider
 * scoping, and would let a broken predicate pass.
 */
function fakeDb(rows) {
  const updates = [];
  return {
    updates,
    all: vi.fn((sql, params = []) => {
      const wanted = new Set(params);
      return rows.filter((r) => wanted.size === 0 || wanted.has(r.provider));
    }),
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

  it("scopes the SELECT to the Cline providers via bound params", () => {
    const db = fakeDb([]);
    migration.up(db);
    const [sql, params] = db.all.mock.calls[0];
    expect(sql).toContain("provider IN (?, ?)");
    expect(params).toEqual(["cline", "clinepass"]);
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

  it("a failing UPDATE does not abort the boot (driver.js re-throws escapes)", () => {
    // The whole point of the second pass in migrate.js is a schema-fix; a disk
    // error must leave one row inflated, never take the process down.
    const db = {
      all: vi.fn(() => [row("acc-1", "clinepass", { backoffLevel: 15 })]),
      run: vi.fn(() => {
        throw new Error("simulated disk I/O error on UPDATE");
      })
    };
    expect(() => migration.up(db)).not.toThrow();
    expect(db.run).toHaveBeenCalledTimes(1);
  });

  it("reports how many connections it reset, so migrate.js can log it", () => {
    const db = fakeDb([
      row("acc-1", "clinepass", { backoffLevel: 15 }),
      row("acc-2", "clinepass", { backoffLevel: 2 })
    ]);
    expect(resetInflatedClineBackoff(db)).toBe(1);
  });
});

// ── The adapter contract, against a real SQLite engine ──────────────────────
// fakeDb cannot prove `all(sql, params)` / `run(sql, params)` work on the real
// adapter surface the versioned chain uses, and a silent mismatch there would
// make the reset quietly do nothing (the SELECT is inside a try/catch).
describe("migration 003 — real adapter (node:sqlite)", () => {
  it("resets the ladder, preserves sibling fields, and is idempotent", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    const adapter = {
      all: (sql, params = []) => db.prepare(sql).all(...params),
      run: (sql, params = []) => db.prepare(sql).run(...params),
      exec: (sql) => db.exec(sql)
    };

    adapter.exec(
      "CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, data TEXT NOT NULL)"
    );
    adapter.run("INSERT INTO providerConnections(id, provider, data) VALUES(?, ?, ?)", [
      "acc-1",
      "clinepass",
      JSON.stringify({ backoffLevel: 15, email: "scursel@gmail.com", modelLock_old: STALE })
    ]);
    adapter.run("INSERT INTO providerConnections(id, provider, data) VALUES(?, ?, ?)", [
      "acc-2",
      "dahl",
      JSON.stringify({ backoffLevel: 15 })
    ]);

    expect(resetInflatedClineBackoff(adapter)).toBe(1);

    const row1 = JSON.parse(
      adapter.all("SELECT data FROM providerConnections WHERE id = ?", ["acc-1"])[0].data
    );
    const row2 = JSON.parse(
      adapter.all("SELECT data FROM providerConnections WHERE id = ?", ["acc-2"])[0].data
    );
    expect(row1.backoffLevel).toBe(0);
    expect(row1.email).toBe("scursel@gmail.com");
    expect(row1.modelLock_old).toBe(STALE);
    expect(row2.backoffLevel).toBe(15);

    // Second pass: nothing left to do.
    expect(resetInflatedClineBackoff(adapter)).toBe(0);
    db.close();
  });
});