import { ensureDirs, DATA_FILE } from "./paths.js";
import { stripNullBytes } from "./helpers/nullBytes.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false, gen: 0 };
const state = global._dbAdapter;
// Hot-reload compat: an older global may predate the `gen` field.
if (typeof state.gen !== "number") state.gen = 0;

async function tryBunSqlite() {
  // Bun runtime only — built-in, no install needed
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] bun:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function tryBetterSqlite() {
  // Skip on Bun — better-sqlite3 native bindings unsupported
  if (process.versions.bun) return null;
  // Skip on Node >= 24: the native addon SIGSEGVs on load there, which is a
  // process-level crash the try/catch below cannot recover from. node:sqlite covers it.
  const [nodeMajor] = process.versions.node.split(".").map(Number);
  if (nodeMajor >= 24) return null;
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] better-sqlite3 unavailable: ${e.message}`);
    return null;
  }
}

async function tryNodeSqlite() {
  // Built-in since Node 22.5.0 — no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] node:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function trySqlJs() {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] sql.js unavailable: ${e.message}`);
    return null;
  }
}

/**
 * Make every bound string NUL-safe, once, for all drivers.
 *
 * SQLite stores TEXT as a NUL-terminated C string, so a bound string with an
 * embedded NUL is rejected by better-sqlite3 ("String contains null byte") and
 * silently truncated by node:sqlite. Values that carry raw bytes — a model id
 * or endpoint from the request, tool output, a diff — can contain one, and the
 * write then either aborts the flush worker or loses the tail without a
 * trace. Sanitising at the binding boundary covers every driver and every
 * column type with a single rule, instead of one call site at a time.
 *
 * @param {object} adapter
 * @returns {object} adapter with NUL-safe run/get/all
 */
function withNullByteSafeParams(adapter) {
  const clean = (params) => (Array.isArray(params) ? params.map(stripNullBytes) : params);
  return {
    ...adapter,
    run: (sql, params = []) => adapter.run(sql, clean(params)),
    get: (sql, params = []) => adapter.get(sql, clean(params)),
    all: (sql, params = []) => adapter.all(sql, clean(params)),
  };
}

async function initAdapter() {
  ensureDirs();
  // Order per runtime:
  //   Bun:  bun:sqlite → sql.js
  //   Node: better-sqlite3 → node:sqlite (≥22.5) → sql.js
  let adapter = await tryBunSqlite();
  if (!adapter) adapter = await tryBetterSqlite();
  if (!adapter) adapter = await tryNodeSqlite();
  if (!adapter) adapter = await trySqlJs();
  if (!adapter) throw new Error("[DB] No SQLite driver available (bun/better/node/sql.js all failed)");

  adapter = withNullByteSafeParams(adapter);

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  // If migration fails the adapter is already open — close it, otherwise the
  // handle (plus WAL checkpoint timers / beforeExit listeners) leaks forever
  // and every retry opens yet another one over the same file.
  try {
    const { runMigrationOnce } = await import("./migrate.js");
    await runMigrationOnce(adapter);
  } catch (e) {
    try {
      if (typeof adapter.close === "function") adapter.close();
    } catch { /* best effort */ }
    throw e;
  }
  return adapter;
}

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (!state.initPromise) {
    // Generation of THIS init attempt. closeAdapter() bumps state.gen, which
    // invalidates an in-flight init: its adapter is closed as an orphan
    // instead of being published (fixes the getAdapter × closeAdapter race).
    const gen = state.gen;
    const promise = initAdapter().then(
      (adapter) => {
        if (state.gen !== gen) {
          try { if (typeof adapter.close === "function") adapter.close(); } catch { /* best effort */ }
          throw new Error("[DB] adapter closed during initialization — call getAdapter() again");
        }
        state.instance = adapter;
        if (state.initPromise === promise) state.initPromise = null;
        return adapter;
      },
      (err) => {
        // A *transient* init failure must not poison the whole process: drop
        // the rejected promise so the next getAdapter() retries from scratch.
        // Only clear it if it is still OUR promise (a newer init may own it).
        if (state.initPromise === promise) state.initPromise = null;
        throw err;
      }
    );
    state.initPromise = promise;
  }
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}

export async function closeAdapter() {
  // Invalidate any in-flight init FIRST (gen bump + promise drop), whether or
  // not an adapter was ever published. The pending init's .then will close its
  // adapter as an orphan and reject instead of publishing it.
  state.gen += 1;
  state.initPromise = null;
  state.logged = false;
  const adapter = state.instance;
  state.instance = null;
  if (!adapter) return;
  try {
    if (typeof adapter.close === "function") {
      adapter.close();
    }
  } catch (e) {
    console.warn(`[DB] Error closing adapter: ${e?.message || e}`);
  }
}
