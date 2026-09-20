#!/usr/bin/env node
/**
 * Re-anchor the Alibaba Token Plan local credit meter against the vendor console.
 *
 * The plan has no quota API and no rate-limit headers (probed live: the
 * /compatible-mode/v1 endpoints answer with x-request-id and req-* only), so the
 * card can only ESTIMATE. The estimate is calibrated from a console reading:
 * the console's drawdown minus what the router can see is the "untracked" gap
 * (foreign clients on the same key, plus the vendor's unpublished per-model
 * coefficients). That gap is stored on the connection as
 * `untrackedCredits7d` + `untrackedCredits7dWindowStart`, so it clears itself
 * when the weekly bucket rolls over.
 *
 * Usage:
 *   node scripts/alitp-calibrate.mjs --remaining 39.7 --reset "2026-09-26 15:05:00"
 *   node scripts/alitp-calibrate.mjs --connection e9868390-… --remaining 39.7 \
 *     --reset "2026-09-26 15:05:00" --at 2026-09-20T20:53:00Z --write
 *
 * Flags:
 *   --connection <id>   providerConnections.id (default: the only alitp-intl row)
 *   --remaining <pct>   "Remaining" as the console shows it
 *   --total <credits>   plan size (default 2500 = Lite)
 *   --reset <instant>   console "Reset time" (UTC; accepts "YYYY-MM-DD HH:MM:SS")
 *   --at <instant>      when the console was read (default: now)
 *   --write             persist the hints (a copy of the old row is saved first)
 */
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The meter imports through the Next alias (@/lib/...); map it for plain node.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) {
      return next(new URL(`../src/${spec.slice(2)}`, import.meta.url).href, ctx);
    }
    return next(spec, ctx);
  },
});

const {
  getAlibabaTokenPlanUsage,
  resolveAlibabaWeeklyBucket,
} = await import("../open-sse/services/usage/alibabaTokenPlan.js");

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

/** Console instants print as UTC without a zone; accept both that and ISO. */
function parseInstant(value) {
  if (!value) return null;
  const naive = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (naive) return Date.parse(`${naive[1]}-${naive[2]}-${naive[3]}T${naive[4]}:${naive[5]}:${naive[6] || "00"}Z`);
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const remaining = Number(flag("remaining"));
const total = Number(flag("total", "2500"));
const readAt = parseInstant(flag("at")) ?? Date.now();
const resetAt = parseInstant(flag("reset"));
if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) {
  console.error("--remaining <pct> is required (0-100)");
  process.exit(2);
}

const dbPath = join(homedir(), ".9router", "db", "data.sqlite");
const db = new DatabaseSync(dbPath);
const wanted = flag("connection");
const rows = wanted
  ? db.prepare("SELECT id, data FROM providerConnections WHERE id = ?").all(wanted)
  : db.prepare("SELECT id, data FROM providerConnections WHERE provider = 'alitp-intl'").all();
if (!rows.length) {
  console.error(wanted ? `no connection ${wanted}` : "no alitp-intl connection found");
  process.exit(2);
}
if (rows.length > 1) {
  console.error(`several alitp-intl connections (${rows.map((r) => r.id).join(", ")}) — pass --connection`);
  process.exit(2);
}

const row = rows[0];
const data = JSON.parse(row.data);
const psd = { ...(data.providerSpecificData || {}) };
// A console reset read now is also the new bucket anchor; keep the stored one
// when the flag is absent so a re-anchor inside the same week is a no-op there.
if (resetAt) psd.alitpResetAt = new Date(resetAt).toISOString();

// Measure the BASE (no offset): re-anchoring must not compound an existing gap.
const basePsd = { ...psd };
for (const key of [
  "untrackedCredits7d",
  "quotaUsed7dOffset",
  "untrackedCredits7dWindowStart",
  "quotaUsed7dWindowStart",
]) {
  delete basePsd[key];
}

const usage = await getAlibabaTokenPlanUsage(
  { connectionId: row.id, providerSpecificData: basePsd },
  readAt,
);
const quotas = Object.values(usage.quotas || {});
const quota = quotas[0];
if (!quota) {
  console.error("meter returned no quota row");
  process.exit(1);
}
if (quota.total !== total) {
  console.warn(`warning: plan size mismatch — meter says ${quota.total}, --total is ${total}`);
}

const bucket = resolveAlibabaWeeklyBucket(psd.alitpResetAt, readAt);
const consoleUsed = ((100 - remaining) / 100) * total;
const gap = Math.round((consoleUsed - quota.used) * 10) / 10;

console.log(
  [
    `connection       ${row.id}`,
    `console reading  ${remaining}% remaining of ${total} => ${consoleUsed} credits used`,
    `read at          ${new Date(readAt).toISOString()}`,
    `meter sees       ${Math.round(quota.used * 10) / 10} credits (base, no offset)`,
    `bucket           ${bucket ? `${new Date(bucket.start).toISOString()} -> ${new Date(bucket.end).toISOString()}` : "unknown (set --reset)"}`,
    `untracked gap    ${gap} credits`,
  ].join("\n"),
);

if (!bucket) {
  console.error("\nRefusing to write without a bucket: pass --reset from the console.");
  process.exit(2);
}

const hints = {
  alitpResetAt: psd.alitpResetAt,
  untrackedCredits7d: gap,
  untrackedCredits7dWindowStart: new Date(bucket.start).toISOString(),
};
console.log(`\nproviderSpecificData hints:\n${JSON.stringify(hints, null, 2)}`);

if (!has("write")) {
  console.log("\n(dry run — re-run with --write to persist)");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = join(homedir(), ".9router", `alitp-connection-${stamp}.json`);
writeFileSync(backup, row.data);
db.prepare(
  `UPDATE providerConnections SET data = json_set(data,
     '$.providerSpecificData.alitpResetAt', ?,
     '$.providerSpecificData.untrackedCredits7d', ?,
     '$.providerSpecificData.untrackedCredits7dWindowStart', ?),
   updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id = ?`,
).run(hints.alitpResetAt, hints.untrackedCredits7d, hints.untrackedCredits7dWindowStart, row.id);
console.log(`\nwritten. backups: ${backup} (+ .sqlite)`);