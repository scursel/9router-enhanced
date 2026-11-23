import { getAdapter } from "@/lib/db/driver.js";
import { loadCachedUsdToBrlRate } from "@/lib/fxRate.js";
import {
  computeLocalBalanceSnapshot,
  queryLocalBalanceUsageFromDb,
} from "open-sse/services/usage/localBalance.js";

function parseJsonSafe(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getGuardState() {
  if (!globalThis.__9rLocalBalanceGuard) {
    globalThis.__9rLocalBalanceGuard = {
      spentUsd: new Map(),
      loadedSince: new Map(),
    };
  }
  return globalThis.__9rLocalBalanceGuard;
}

/**
 * Preload DB spend totals and cached FX rate for any active connection under
 * `providerId` that uses `localBalance` with `enforcement === "block"`.
 * Must run BEFORE `selectionMutex` so hot-path selection performs zero I/O.
 */
export async function preloadLocalBalanceGuard(providerId) {
  if (!providerId) return { liveRate: null };

  let db;
  let rows = [];
  try {
    db = await getAdapter();
    if (db && typeof db.all === "function") {
      rows = db.all(
        `SELECT id, data FROM providerConnections WHERE provider = ? AND isActive = 1`,
        [providerId]
      );
    }
  } catch {
    return { liveRate: null };
  }

  const blocking = [];
  for (const row of rows) {
    const rowData = parseJsonSafe(row?.data);
    const lb = rowData?.providerSpecificData?.localBalance ?? rowData?.localBalance;
    if (lb?.enabled === true && lb?.enforcement === "block") {
      blocking.push({ id: row.id, lb });
    }
  }

  if (blocking.length === 0) {
    return { liveRate: null };
  }

  const state = getGuardState();
  const stale = blocking.filter(({ id, lb }) => {
    const since = String(lb?.since || "");
    return !state.spentUsd.has(id) || state.loadedSince.get(id) !== since;
  });

  if (stale.length > 0) {
    try {
      for (const { id, lb } of stale) {
        const since = String(lb?.since || "");
        const { spentUsd } = queryLocalBalanceUsageFromDb(db, id, since);
        state.spentUsd.set(id, spentUsd);
        state.loadedSince.set(id, since);
      }
    } catch {
      // Fail-open if DB read fails during preload
    }
  }

  const needsLiveBrl = blocking.some(
    ({ lb }) => lb?.currency === "BRL" && lb?.fxMode === "auto"
  );

  const liveRate = needsLiveBrl ? await loadCachedUsdToBrlRate() : null;
  return { liveRate };
}

/**
 * Synchronous local-balance check safe to call inside `auth.js` selectionMutex.
 */
export function isConnectionLocalBalanceExhaustedSync(connection, liveRate = null) {
  const lb = connection?.providerSpecificData?.localBalance;
  if (!(lb?.enabled === true && lb?.enforcement === "block")) {
    return { exhausted: false };
  }

  const state = getGuardState();
  const spentUsd = state.spentUsd.get(connection.id) ?? 0;
  const snapshot = computeLocalBalanceSnapshot(lb, spentUsd, { liveRate });
  return {
    exhausted: snapshot.exhausted,
    summary: snapshot.summary,
    snapshot,
  };
}

/**
 * Increment the in-memory spend cache for a connection after a billable row is inserted.
 */
export function recordLocalBalanceSpend(connectionId, costUsd) {
  if (!connectionId || typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd <= 0) {
    return;
  }
  const state = getGuardState();
  if (state.spentUsd.has(connectionId)) {
    state.spentUsd.set(connectionId, state.spentUsd.get(connectionId) + costUsd);
  }
}

/**
 * Invalidate one connection (e.g. after PUT / calibrate / topup) or the entire cache (e.g. after retention).
 */
export function invalidateLocalBalanceCache(connectionId = null) {
  const state = getGuardState();
  if (!connectionId) {
    state.spentUsd.clear();
    state.loadedSince.clear();
    return;
  }
  state.spentUsd.delete(connectionId);
  state.loadedSince.delete(connectionId);
}
