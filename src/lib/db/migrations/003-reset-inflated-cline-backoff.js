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
 * NOTE for operators: this migration is version-gated, so a database that already
 * recorded version 3 will not re-run it. Apply the same reset by hand for the
 * accounts that already accumulated a ladder under the old code.
 *
 * Resetting can only make an account more willing to be tried. A credential
 * that is genuinely throttled re-escalates from level 1 (a 2s cooldown) on its
 * next failure, so no real protection is lost.
 */

const LADDER_RESET_THRESHOLD = 8;

const AFFECTED_PROVIDERS = new Set(["cline", "clinepass"]);

export default {
  version: 3,
  name: "reset-inflated-cline-backoff",
  up(db) {
    // The versioned chain runs on legacy databases too, where this table may not
    // exist yet (the schema is synced AFTER the chain). Migrations must be safe
    // on any starting shape — 002 guards the same way with PRAGMA table_info.
    let rows;
    try {
      rows = db.all(
        "SELECT id, provider, data FROM providerConnections WHERE provider IN ('cline', 'clinepass')"
      );
    } catch {
      return; // no connection table yet: nothing to clean, and never fail the boot
    }
    if (!Array.isArray(rows)) return;

    const now = Date.now();

    for (const row of rows) {
      let data;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue; // unreadable row: leave it untouched rather than corrupting it
      }
      if (!data || typeof data !== "object") continue;
      if (!AFFECTED_PROVIDERS.has(row.provider)) continue;

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
      db.run("UPDATE providerConnections SET data = ? WHERE id = ?", [
        JSON.stringify(data),
        row.id
      ]);
    }
  }
};