#!/usr/bin/env node
// Secret-leak guard — exists because of one real incident:
//   commit 61b84a78 bundled `9router-0.5.69.tgz` into git history. The pack
//   embedded build-HOME state: `jwt-secret` (signs dashboard admin sessions),
//   `machine-id`, and `db/data.sqlite`. It was untracked in 8e0617a5 but the
//   blob stays public forever. This script keeps that class of mistake out of
//   new commits.
//
// Usage:
//   node scripts/check-no-secrets.mjs                   # scan STAGED additions (pre-commit mode)
//   node scripts/check-no-secrets.mjs --range A..B      # scan additions between two commits (CI)
//   node scripts/check-no-secrets.mjs <path>...         # scan files/dirs before staging
//
// The pre-commit hook is installed by `npm install` (prepare ->
// scripts/install-hooks.mjs); CI runs --range on every push/PR as the backstop.
//
// False positive? Fix the allowlist below IN THE SAME COMMIT (auditable) —
// there is deliberately no env-var bypass. Lines containing
// `secret-scan:allow` are always skipped.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SKIP_MARKER = "secret-scan:allow";

// Public-by-design identifiers (not secrets). Keep exact values here.
const KNOWN_PUBLIC_KEYS = [
  // Upstream Windsurf Firebase Web API key (src/lib/oauth/constants/oauth.js,
  // open-sse/providers/registry/windsurf.js). Firebase Web keys are client
  // identifiers restricted in the Firebase console, not credentials.
  "AIzaSyDsOl-1XpT5err0Tcn0TFFod1H8gVGIycY",
];

const CONTENT_PATTERNS = [
  { re: /\bsk-(?:proj|ant|svcacct)-[A-Za-z0-9_-]{10,}/, label: "OpenAI/Anthropic-style API key" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, label: "OpenAI-style API key" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key id" },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/, label: "GitHub token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, label: "GitHub fine-grained PAT" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, label: "Slack token" },
  {
    re: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
    label: "GitLab PAT",
    // UI placeholders / fixtures use the documented fake shape `glpat-xxx…`.
    allow: (line) => !/\bglpat-(?!x+\b)[A-Za-z0-9_-]{20,}/.test(line),
  },
  {
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    label: "Google API key",
    allow: (line) => KNOWN_PUBLIC_KEYS.some((k) => line.includes(k)),
  },
  {
    re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
    label: "private key block",
    // Test fixtures embed a fake key whose body is a single filler char
    // ("-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n").
    allow: (line) => {
      const m = line.match(
        /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----([\s\S]*?)-----END (?:[A-Z]+ )*PRIVATE KEY-----/
      );
      if (!m) return false;
      return m[1].replace(/\\n/g, "").trim().length <= 4;
    },
  },
  // .npmrc registry credentials (the file itself is fine: tests/.npmrc only sets flags).
  { re: /(?:^|:)_(?:authToken|auth|password)\s*=\s*\S/, label: "npm registry credential" },
  { re: /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/, label: "JWT / signed token" },
  {
    // A real-looking value assigned to one of the app's own secret env names.
    // Placeholders ("change-me-…") and comments don't match the charset length.
    re: /(?:JWT_SECRET|API_KEY_SECRET|MACHINE_ID_SALT)\s*[=:]\s*["']?[A-Za-z0-9+/=]{32,}/,
    label: "hardcoded value for a security-sensitive env var",
    allow: (line) => /change-me|placeholder|example/i.test(line),
  },
];

const FILENAME_RULES = [
  {
    re: /\.(?:tgz|tar|tar\.gz|zip|7z)$/,
    label: "archive — packs historically embedded HOME state (jwt-secret, db); inspect with `tar tz` and justify in the commit BEFORE staging",
  },
  { re: /(?:^|\/)\.env(?:\.[^/]*)?$/, skip: /(^|\/)\.env\.example$/, label: ".env file (only .env.example may be tracked)" },
  { re: /(?:^|\/)(?:jwt-secret|machine-id)$/, label: "credential state file (DATA_DIR state)" },
  // SQLite sidecars (-wal/-shm/-journal) hold committed pages too.
  { re: /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/, label: "database file" },
  { re: /\.pem$|\.key$|(?:^|\/)id_rsa(?:\..*)?$|(?:^|\/)id_ed25519(?:\..*)?$|\.p12$|\.pfx$|\.jks$|\.keystore$/, label: "key material" },
  { re: /(?:^|\/)\.build-home\//, label: "CLI build HOME state (contains jwt-secret/machine-id/db)" },
  { re: /(?:^|\/)usage\.json$|(?:^|\/)log\.txt$/, label: "runtime state under ~/.9router" },
];

const violations = [];
const warnings = [];
let quiet = false;

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function checkFilename(relPath) {
  // Lowercased: `Backup.TGZ` / `id_rsa.PEM` must not slip past the rules.
  const p = relPath.replaceAll("\\", "/").toLowerCase();
  for (const rule of FILENAME_RULES) {
    if (rule.skip && rule.skip.test(p)) continue;
    if (rule.re.test(p)) {
      violations.push(`${relPath}: ${rule.label}`);
      return;
    }
  }
}

function scanText(relPath, lines, lineOffset) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(SKIP_MARKER)) continue;
    for (const { re, label, allow } of CONTENT_PATTERNS) {
      if (!re.test(line)) continue;
      if (allow && allow(line)) continue;
      const no = lineOffset ? `${lineOffset + i}` : `${i + 1}`;
      violations.push(`${relPath}:${no}: ${label} -> ${line.trim().slice(0, 120)}`);
      break; // one finding per line is enough
    }
  }
}

function isBinary(buf) {
  const head = buf.subarray(0, 8000);
  for (const b of head) if (b === 0) return true;
  return false;
}

function walkFiles(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    if (path.basename(p) === "node_modules") return [];
    return readdirSync(p).flatMap((e) => walkFiles(path.join(p, e)));
  }
  return [p];
}

// ---------- diff mode (staged / commit range) ----------
// `diffArgs` selects what to compare: ["--cached"] or ["A", "B"].
function scanDiff(diffArgs, emptyMsg) {
  const files = sh("git", ["diff", ...diffArgs, "--name-only", "--diff-filter=ACMR"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (files.length === 0) {
    console.log(`check-no-secrets: ${emptyMsg} — clean.`);
    quiet = true;
    return;
  }

  for (const f of files) checkFilename(f);

  // Binary files: numstat reports "-\t-\tpath". Taken from here rather than the
  // patch because a binary diff carries no `+++ b/` line to name the file.
  // -z avoids path quoting; --no-renames keeps one path per record.
  const numstat = sh("git", ["diff", ...diffArgs, "--numstat", "-z", "--no-renames", "--diff-filter=ACM"]);
  for (const rec of numstat.split("\0")) {
    const m = rec.match(/^-\t-\t(.+)$/s);
    if (m) warnings.push(`${m[1]}: binary file — content not scannable, review it manually`);
  }

  // Added lines only, with real line numbers, parsed from `git diff -U0`.
  const diff = sh("git", ["diff", ...diffArgs, "--unified=0"]);
  let current = null;
  let addLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      current = null;
      continue;
    }
    if (raw.startsWith("+++ b/")) {
      current = raw.slice(6).replace(/^"(.*)"$/, "$1");
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      addLine = parseInt(hunk[1], 10);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+")) {
      scanText(current, [raw.slice(1)], addLine);
      addLine++;
    } else if (raw.startsWith(" ")) {
      addLine++; // context lines advance the new-file counter; deletions don't
    }
  }
}

// ---------- explicit paths mode ----------
function scanPaths(paths) {
  for (const p of paths) {
    for (const f of walkFiles(p)) {
      const rel = path.relative(process.cwd(), f);
      checkFilename(rel);
      let buf;
      try {
        buf = readFileSync(f);
      } catch {
        continue;
      }
      if (isBinary(buf)) {
        warnings.push(`${rel}: binary file — content not scannable, review it manually`);
        continue;
      }
      scanText(rel, buf.toString("utf8").split("\n"), 0);
    }
  }
}

// ---------- main ----------
const args = process.argv.slice(2);
if (args[0] === "--range") {
  const range = args[1] || "";
  const [from, to] = range.split("..");
  if (!from || !to) {
    console.error("check-no-secrets: --range needs A..B");
    process.exit(2);
  }
  scanDiff([from, to], `nothing added in ${range}`);
} else if (args.length > 0) scanPaths(args);
else scanDiff(["--cached"], "nothing staged");

if (warnings.length) {
  console.warn("check-no-secrets: warnings");
  for (const w of warnings) console.warn(`  ! ${w}`);
}
if (violations.length) {
  console.error(`\ncheck-no-secrets: BLOCKED — ${violations.length} potential secret/artifact finding(s):\n`);
  for (const v of violations) console.error(`  x ${v}`);
  console.error(
    `\nNever commit this. If it is a real credential that was already pushed: rotate it first,\n` +
      `then purge history (git filter-repo) — untracking alone leaves the blob public forever.\n` +
      `False positive? Extend the allowlist in scripts/check-no-secrets.mjs IN THE SAME COMMIT\n` +
      `(or add a ${SKIP_MARKER} comment on the line). No bypass flag exists by design.`
  );
  process.exit(1);
}
if (warnings.length === 0 && !quiet) console.log("check-no-secrets: clean.");
