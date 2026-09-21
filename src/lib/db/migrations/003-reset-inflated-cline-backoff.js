/**
 * Clear backoff ladders inflated by the pre-policy text heuristic.
 *
 * Before rateLimitPolicy.js existed, `checkFallbackError` answered every message
 * containing "rate limit" / "overloaded" / "capacity" with the exponential
 * ladder, capped at BACKOFF_CONFIG.maxLevel. Aggregators that re-wrap an
 * upstream 429 inside their own 500 tripped that heuristic on every pooled
 * throttle, so an ordinary congestion spike walked credentials up the ladder:
 * observed live at level 15 — one failure away from a 5-minute lock — on two of
 * three Cline accounts, for an upstream that had asked for 5 seconds.
 *
 * The code fix stops the escalation for bounded and pooled throttles. This
 * migration removes the ladder already accumulated, because the stored level
 * would otherwise keep pricing the NEXT unrelated failure at the inflated tier:
 * the fix would be live while the accounts still behaved as if it were not.
 *
 * Scoped deliberately:
 *   • only the Cline aggregator (where the misclassification was observed),
 *   • only levels at or above LADDER_RESET_THRESHOLD, which no single genuine
 *     throttle can reach from a clean state;
 *   • never touches a credential that is currently inside an active lock — that
 *     is live cooldown state, and the new policy only ever writes a lock for a
 *     credential-scoped throttle, so an active lock means the level is meant.
 *
 * The discriminator is the ACTIVE LOCK, not how recently the credential failed.
 * `lastErrorAt` is rewritten on every attempt (including plain health probes), so
 * a recency window never closes on a busy account and the cleanup would silently
 * never run. Lock expiry states exactly what matters: a ladder whose locks have
 * all expired is residual, a ladder with a live lock is a decision the new code
 * made and means to keep.
 *
 * NOTE for operators: two gaps are worth knowing about.
 *   • This migration is version-gated, so a database that already recorded
 *     version 3 will not re-run the chain. Apply the reset by hand there.
 *   • The versioned chain runs BEFORE the legacy `db.json` import (migrate.js),
 *     so rows that arrive from that import are not covered by the chain at all —
 *     they land on a boot that has just stamped version 3. `migrate.js` therefore
 *     calls `resetInflatedClineBackoff()` again right after a successful import;
 *     that second call is the one that matters for a JSON-origin database.
 *
 * Resetting can only make an account more willing to be tried. A credential
 * that is genuinely throttled re-escalates from level 1 (a 2s cooldown) on its
 * next failure, so no real protection is lost.
 */

const LADDER_RESET_THRESHOLD = 8;

export const INFLATED_LADDER_PROVIDERS = ["cline", "clinepass"];

/**
 * Reset the inflated ladders. Exported because a versioned migration alone
 * cannot cover the whole surface: `migrate.js` runs the versioned chain BEFORE
 * the legacy `db.json` import, and that import writes `backoffLevel` straight
 * into the `data` JSON — so it re-introduces the very state this cleans, on a
 * boot that has already stamped version 3 and will therefore never re-run the
 * chain. `migrate.js` calls this again after a successful import.
 *
 * Returns the number of rows reset, and never throws: a failed UPDATE must not
 * abort the boot (driver.js closes the adapter and re-throws).
 *
 * @param {{all: Function, run: Function}} db adapter (see src/lib/db/migrate.js)
 * @returns {number} how many connections were reset
 */
export function resetInflatedClineBackoff(db) {
  let rows;
  try {
    // The versioned chain runs on legacy databases too, where this table may not
    // exist yet (the schema is synced AFTER the chain). Migrations must be safe
    // on any starting shape — 002 guards the same way with PRAGMA table_info.
    rows = db.all(
      `SELECT id, provider, data FROM providerConnections WHERE provider IN (${INFLATED_LADDER_PROVIDERS.map(() => "?").join(", ")})`,
      INFLATED_LADDER_PROVIDERS
    );
  } catch {
    return 0; // no connection table yet: nothing to clean, and never fail the boot
  }
  if (!Array.isArray(rows)) return 0;

  const now = Date.now();
  let reset = 0;

  for (const row of rows) {
    let data;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue; // unreadable row: leave it untouched rather than corrupting it
    }
    if (!data || typeof data !== "object") continue;

    const level = Number(data.backoffLevel) || 0;
    if (level < LADDER_RESET_THRESHOLD) continue;

    // An unexpired lock means the credential is cooling down for a reason the
    // new policy considers real: that is live state, not residue.
    const hasActiveLock = Object.entries(data).some(([key, value]) => {
      if (!key.startsWith("modelLock_") || typeof value !== "string") return false;
      const until = Date.parse(value);
      return Number.isFinite(until) && until > now;
    });
    if (hasActiveLock) continue;

    data.backoffLevel = 0;
    try {
      db.run("UPDATE providerConnections SET data = ? WHERE id = ?", [
        JSON.stringify(data),
        row.id
      ]);
      reset++;
    } catch (e) {
      // Log and continue: leaving one row inflated is recoverable, aborting the
      // boot is not. driver.js re-throws anything that escapes a migration.
      console.warn(
        `[DB][migrate] WARNING reset-inflated-cline-backoff could not update ${row.id}: ${e.message}`
      );
    }
  }

  return reset;
}

export default {
  version: 3,
  name: "reset-inflated-cline-backoff",
  up(db) {
    resetInflatedClineBackoff(db);
  }
};