import { getAdapter } from "@/lib/db/driver.js";
import { num, quota } from "./quotaShared.js";
import {
  LOCAL_BALANCE_CURRENCIES,
  LOCAL_BALANCE_ENFORCEMENTS,
  LOCAL_BALANCE_FX_MODES,
  computeLocalBalanceSnapshot,
  effectiveFxMultiplier,
  hasLocalBalanceConfigured,
  validateLocalBalancePatch,
} from "./localBalanceMath.js";

export {
  LOCAL_BALANCE_CURRENCIES,
  LOCAL_BALANCE_ENFORCEMENTS,
  LOCAL_BALANCE_FX_MODES,
  computeLocalBalanceSnapshot,
  effectiveFxMultiplier,
  hasLocalBalanceConfigured,
  validateLocalBalancePatch,
};

function toLocalDateKey(msOrIso) {
  const d = new Date(msOrIso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getRetentionDaysFromEnv() {
  const raw = process.env.USAGE_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function parseJsonSafe(raw, fallback = null) {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Sum billable USD cost and unpriced requests for `connectionId` since `sinceIso`.
 * When `USAGE_RETENTION_DAYS` is active and `sinceIso` predates the retention cutoff,
 * older whole local days are summed from `usageDaily.byAccount[connectionId]` and
 * newer days from `usageHistory` with a midnight-aligned split so no day is counted twice.
 */
export function queryLocalBalanceUsageFromDb(db, connectionId, sinceIso, now = Date.now()) {
  if (!db || !connectionId) {
    return { spentUsd: 0, unpricedCount: 0, historyPruned: false };
  }

  const safeSince =
    typeof sinceIso === "string" && Number.isFinite(Date.parse(sinceIso))
      ? new Date(Date.parse(sinceIso)).toISOString()
      : new Date(0).toISOString();

  const retentionDays = getRetentionDaysFromEnv();
  const sinceMs = Date.parse(safeSince);
  const retentionCutoffMs = retentionDays > 0 ? now - retentionDays * 86400000 : NaN;

  let dailySpentUsd = 0;
  let historySinceIso = safeSince;
  let historyPruned = false;

  if (retentionDays > 0 && Number.isFinite(sinceMs) && sinceMs < retentionCutoffMs) {
    const cutoffDate = new Date(retentionCutoffMs);
    const nextLocalMidnight = new Date(
      cutoffDate.getFullYear(),
      cutoffDate.getMonth(),
      cutoffDate.getDate() + 1,
      0,
      0,
      0,
      0
    );
    const splitMs = nextLocalMidnight.getTime();
    const splitDateKey = toLocalDateKey(splitMs);
    const sinceDateKey = toLocalDateKey(sinceMs);

    if (typeof db.all === "function") {
      const dailyRows = db.all(
        `SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? AND dateKey < ?`,
        [sinceDateKey, splitDateKey]
      );
      for (const row of dailyRows) {
        const day = parseJsonSafe(row?.data, {});
        const accountCost = num(day?.byAccount?.[connectionId]?.cost, 0);
        if (accountCost > 0) dailySpentUsd += accountCost;
      }
      if (dailyRows.length > 0) {
        historyPruned = true;
      }
    }

    if (splitMs > sinceMs) {
      historySinceIso = new Date(splitMs).toISOString();
    }
  }

  let historySpentUsd = 0;
  let unpricedCount = 0;
  if (typeof db.get === "function") {
    const row = db.get(
      `SELECT
        COALESCE(SUM(cost), 0) AS spentUsd,
        COALESCE(SUM(CASE WHEN (cost IS NULL OR cost = 0) AND (promptTokens > 0 OR completionTokens > 0) THEN 1 ELSE 0 END), 0) AS unpricedCount
      FROM usageHistory
      WHERE connectionId = ? AND timestamp >= ? AND (status IS NULL OR status NOT LIKE 'error%')`,
      [connectionId, historySinceIso]
    );
    historySpentUsd = Math.max(0, num(row?.spentUsd, 0));
    unpricedCount = Math.max(0, Math.trunc(num(row?.unpricedCount, 0)));
  }

  return {
    spentUsd: dailySpentUsd + historySpentUsd,
    unpricedCount,
    historyPruned,
  };
}

/**
 * Local balance quota meter backed by `usageHistory` (+ `usageDaily` if pruned).
 */
export async function getLocalBalanceUsage(ctx = {}, now = Date.now()) {
  let connId = String(ctx?.connectionId || ctx?.id || "").trim();
  let psd = ctx?.providerSpecificData || null;

  let db = null;
  try {
    db = await getAdapter();
    if (!psd?.localBalance && db && typeof db.get === "function" && connId) {
      const row = db.get("SELECT data FROM providerConnections WHERE id = ?", [connId]);
      const parsed = parseJsonSafe(row?.data, null);
      if (parsed) psd = parsed.providerSpecificData ?? parsed;
    }
  } catch (err) {
    console.warn("[LocalBalance] DB adapter error:", err);
  }

  const config = psd?.localBalance;
  if (!hasLocalBalanceConfigured({ localBalance: config })) {
    return {
      message: "Usage not available for this connection",
      quotas: {},
    };
  }

  let usageTotals = { spentUsd: 0, unpricedCount: 0, historyPruned: false };
  if (db && connId) {
    try {
      usageTotals = queryLocalBalanceUsageFromDb(db, connId, config.since, now);
    } catch (err) {
      console.warn("[LocalBalance] DB query error:", err);
    }
  }

  const snapshot = computeLocalBalanceSnapshot(config, usageTotals.spentUsd, {
    liveRate: ctx?.liveFxRate ?? null,
    unpricedCount: usageTotals.unpricedCount,
    historyPruned: usageTotals.historyPruned,
  });

  const quotaRow = quota(snapshot.spent, snapshot.total, null);

  return {
    plan: snapshot.plan,
    status: "ok",
    source: "router-local",
    fetchedAt: new Date(now).toISOString(),
    ...(snapshot.notice ? { notice: snapshot.notice } : {}),
    quotas: {
      [snapshot.quotaKey]: quotaRow,
    },
  };
}
