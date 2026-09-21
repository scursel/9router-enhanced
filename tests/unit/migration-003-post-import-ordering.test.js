// Migration 003 × legacy JSON import — the ordering hole.
//
// `runVersionedMigrations` (src/lib/db/migrate.js) runs the versioned chain BEFORE
// the legacy `db.json` import, and the import writes `backoffLevel` straight from
// the legacy connection object (`...rest` spread) into the `data` column. A
// database that arrives from JSON therefore gets its inflated ladder AFTER the
// chain has already run — and stamped version 3, so the chain never revisits it.
//
// Regression this locks down (observed live): a pre-fix router left the Cline
// accounts at `backoffLevel: 15`; a JSON-origin database would keep that ladder
// forever, because the only cleanup ran on a boot where the table was empty.
//
// The fix is the second call site: `migrate.js` invokes
// `resetInflatedClineBackoff(adapter)` right after a successful import. This file
// proves the SEQUENCE (chain on an empty table → import → reset) actually ends
// with a clean ladder, which is what an in-process integration test of the real
// runner would assert by a longer route.
import { describe, expect, it } from "vitest";

import migration, {
  resetInflatedClineBackoff
} from "../../src/lib/db/migrations/003-reset-inflated-cline-backoff.js";

async function makeAdapter() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  return {
    all: (sql, params = []) => db.prepare(sql).all(...params),
    run: (sql, params = []) => db.prepare(sql).run(...params),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    raw: db
  };
}

describe("migration 003 — a JSON-origin database ends up clean", () => {
  it("cleans the ladder the legacy import introduces after the chain has run", async () => {
    const adapter = await makeAdapter();
    adapter.exec(
      "CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT, name TEXT, email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1, data TEXT NOT NULL, createdAt TEXT, updatedAt TEXT)"
    );

    // 1. The versioned chain runs first, on an EMPTY table (nothing to clean).
    migration.up(adapter);
    expect(adapter.all("SELECT COUNT(*) AS c FROM providerConnections")[0].c).toBe(0);

    // 2. The legacy import then writes the connection verbatim — `...rest`
    //    carries the inflated ladder into the data JSON.
    const legacyConnection = {
      id: "hermes",
      provider: "clinepass",
      authType: "apikey",
      name: "Hermes",
      email: "hermes@example.com",
      backoffLevel: 15,
      lastErrorAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      "modelLock_z-ai/glm-5.2:free": new Date(Date.now() - 60 * 1000).toISOString()
    };
    const { id, provider, authType, name, email, ...rest } = legacyConnection;
    adapter.run(
      "INSERT INTO providerConnections(id, provider, authType, name, email, data) VALUES(?, ?, ?, ?, ?, ?)",
      [id, provider, authType, name, email, JSON.stringify(rest)]
    );

    // Sanity: the import alone leaves the ladder at 15 — this is the bug.
    const before = JSON.parse(
      adapter.all("SELECT data FROM providerConnections WHERE id = ?", ["hermes"])[0].data
    );
    expect(before.backoffLevel).toBe(15);

    // 3. The post-import pass (migrate.js) is the one that matters here.
    const reset = resetInflatedClineBackoff(adapter);
    expect(reset).toBe(1);

    const after = JSON.parse(
      adapter.all("SELECT data FROM providerConnections WHERE id = ?", ["hermes"])[0].data
    );
    expect(after.backoffLevel).toBe(0);
    expect(after.lastErrorAt).toBe(legacyConnection.lastErrorAt);
    // `email` lives in its own column (the import destructures it out of the
    // JSON), so the reset must leave both the row and its columns intact.
    expect(
      adapter.all("SELECT email FROM providerConnections WHERE id = ?", ["hermes"])[0].email
    ).toBe("hermes@example.com");
    adapter.close();
  });

  it("leaves a live lock alone even on the post-import pass", async () => {
    const adapter = await makeAdapter();
    adapter.exec(
      "CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, data TEXT NOT NULL)"
    );
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    adapter.run("INSERT INTO providerConnections(id, provider, data) VALUES(?, ?, ?)", [
      "acc-live",
      "clinepass",
      JSON.stringify({ backoffLevel: 15, "modelLock_x": future })
    ]);

    expect(resetInflatedClineBackoff(adapter)).toBe(0);
    adapter.close();
  });

  it("is a silent no-op when the import never ran (table present, no Cline rows)", async () => {
    const adapter = await makeAdapter();
    adapter.exec(
      "CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, data TEXT NOT NULL)"
    );
    adapter.run("INSERT INTO providerConnections(id, provider, data) VALUES(?, ?, ?)", [
      "x",
      "openai",
      JSON.stringify({ backoffLevel: 15 })
    ]);

    expect(resetInflatedClineBackoff(adapter)).toBe(0);
    adapter.close();
  });
});