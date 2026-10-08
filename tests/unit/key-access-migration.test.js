// Per-API-key access control: a DB written by the previous schema (apiKeys
// without the access columns, schemaVersion 1) upgrades in place; every existing
// key stays unrestricted. Backup export/import carries access, and older backups restore
// as unrestricted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

function writeLegacyDb(dir) {
  // The apiKeys DDL as it was before the access columns + a stamped v1 _meta.
  fs.mkdirSync(path.join(dir, "db"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "db", "data.sqlite"));
  db.exec(`CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`INSERT INTO _meta(key, value) VALUES ('schemaVersion', '1'), ('backupSchemaVersion', '1')`);
  db.exec(`CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)`);
  const ins = db.prepare(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run("k1", "sk-legacy-one", "Default Key", "m", 1, "2026-09-01T00:00:00.000Z");
  ins.run("k2", "sk-legacy-two", "paused", "m", 0, "2026-09-02T00:00:00.000Z");
  db.close();
}

async function boot() {
  delete global._dbAdapter;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  return { db, adapter: await getAdapter() };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-access-"));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("apiKeys access columns: upgrade from the previous schema", () => {
  it("adds the columns, keeps every row, and reads every existing key as unrestricted", async () => {
    writeLegacyDb(tempDir);
    const { db, adapter } = await boot();

    const cols = adapter.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["accessRestricted", "accessAllow"]));

    const keys = await db.getApiKeys();
    expect(keys.map((k) => [k.id, k.name, k.isActive, k.access])).toEqual([
      ["k1", "Default Key", true, { restricted: false, allow: [] }],
      ["k2", "paused", false, { restricted: false, allow: [] }],
    ]);
    expect(await db.validateApiKey("sk-legacy-one")).toBe(true);
    expect((await db.getApiKeyByKey("sk-legacy-one")).access.restricted).toBe(false);

    // The schema bump took the pre-change safety backup.
    const backups = fs.readdirSync(path.join(tempDir, "db", "backups"));
    expect(backups.some((d) => d.startsWith("schema-1-to-3"))).toBe(true);
  });

  it("persists access through update, new keys default to unrestricted", async () => {
    writeLegacyDb(tempDir);
    const { db } = await boot();
    const updated = await db.updateApiKey("k1", { access: { restricted: true, allow: ["Main", "cx/gpt-5"] } });
    expect(updated.access).toEqual({ restricted: true, allow: ["Main", "cx/gpt-5"] });
    expect((await db.getApiKeyById("k1")).access).toEqual({ restricted: true, allow: ["Main", "cx/gpt-5"] });
    // Unrelated updates (pause/resume) keep the access.
    await db.updateApiKey("k1", { isActive: false });
    expect((await db.getApiKeyById("k1")).access.restricted).toBe(true);

    const created = await db.createApiKey("fresh", "machine-1");
    expect(created.access).toEqual({ restricted: false, allow: [] });
    expect((await db.getApiKeyById(created.id)).access).toEqual({ restricted: false, allow: [] });
  });

  it("export/import round-trips access; a backup without access restores unrestricted; malformed access is refused", async () => {
    writeLegacyDb(tempDir);
    const { db } = await boot();
    await db.updateApiKey("k1", { access: { restricted: true, allow: ["Main"] } });
    const dump = await db.exportDb();
    expect(dump.apiKeys.find((k) => k.id === "k1").access).toEqual({ restricted: true, allow: ["Main"] });

    await db.importDb(dump);
    expect((await db.getApiKeyById("k1")).access).toEqual({ restricted: true, allow: ["Main"] });

    const legacy = { ...dump, apiKeys: dump.apiKeys.map(({ access, ...rest }) => rest) };
    await db.importDb(legacy);
    expect((await db.getApiKeyById("k1")).access).toEqual({ restricted: false, allow: [] });

    const bad = { ...dump, apiKeys: [{ ...dump.apiKeys[0], access: { restricted: "yes", allow: [] } }] };
    await expect(db.importDb(bad)).rejects.toThrow(/access/);
    // The failed import rolled back: the previous rows are still there.
    expect((await db.getApiKeys()).length).toBe(2);
  });

  it("upgrades a v2 DB to v3, takes pre-schema backup schema-2-to-3, adds access columns, and verifies plaintext key lookup", async () => {
    fs.mkdirSync(path.join(tempDir, "db"), { recursive: true });
    const dbFile = new DatabaseSync(path.join(tempDir, "db", "data.sqlite"));
    dbFile.exec(`CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    dbFile.exec(`INSERT INTO _meta(key, value) VALUES ('schemaVersion', '2'), ('backupSchemaVersion', '2')`);
    dbFile.exec(`CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)`);
    const ins = dbFile.prepare(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?)`);
    ins.run("k-v2", "sk-v2-plain-key-12345", "V2 Key", "m", 1, "2026-09-01T00:00:00.000Z");
    dbFile.close();

    const { db, adapter } = await boot();
    const cols = adapter.all(`PRAGMA table_info(apiKeys)`).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["accessRestricted", "accessAllow"]));

    // Check plaintext key lookup in apiKeys table (plain key vs usage hash)
    const key = await db.getApiKeyByKey("sk-v2-plain-key-12345");
    expect(key).toBeDefined();
    expect(key.id).toBe("k-v2");
    expect(key.key).toBe("sk-v2-plain-key-12345");
    expect(key.access).toEqual({ restricted: false, allow: [] });

    const backups = fs.readdirSync(path.join(tempDir, "db", "backups"));
    expect(backups.some((d) => d.startsWith("schema-2-to-3"))).toBe(true);
  });
});
