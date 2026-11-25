// Deploy the CLI package (`9router`) to a remote host that runs it as a service.
//
//   npm run deploy:remote -- <ssh-host> [--ssh-key <path>] [--port 20128]
//                            [--unit 9router.service] [--package-root <dir>] [--dry-run]
//
// Why this exists: a hand-run deploy did `npm install -g <tgz>` on the host and
// the package landed in npm's default global prefix (~/.local) while the service
// runs from another prefix (~/.hermes/node). The live service kept the old
// version, a stray install was left behind, and npm's allow-scripts policy
// silently skipped the package's postinstall. Every step here closes one of
// those gaps:
//
//   1. Probe: find the package root the SERVICE uses, via the same
//      ~/.9router/9router-package-root pointer the start script reads (else the
//      `9router` on the remote PATH). The npm prefix is derived from that root,
//      never from npm's default. Fails closed when nothing is found.
//   2. Pack: `npm run cli:pack` with the cutover guard pointed at the REMOTE
//      install (a copy of its package.json), so downgrades still fail closed.
//   3. Inspect: refuse a tarball carrying build-HOME state (jwt-secret,
//      machine-id, sqlite, .env, usage.json, log.txt, nested archives).
//   4. Install: back up the live package, `npm install -g --prefix <prefix>`,
//      and verify the version now in the service root before anything restarts.
//   5. postinstall: run hooks/postinstall.js explicitly (npm may block it).
//   6. Restart the systemd --user unit and wait for /api/version to report the
//      new app version. Prints the rollback command either way.
//
// The host is a parameter (or DEPLOY_HOST): nothing machine-specific lives here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "9router";

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

/** Single-quote a value for POSIX sh. */
export function shq(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** `<prefix>/lib/node_modules/9router` → `<prefix>`; anything else → null. */
export function prefixFromPackageRoot(root) {
  if (typeof root !== "string" || !root.startsWith("/")) return null;
  const clean = root.replace(/\/+$/, "");
  const suffix = `/lib/node_modules/${PACKAGE_NAME}`;
  if (!clean.endsWith(suffix)) return null;
  const prefix = clean.slice(0, -suffix.length);
  return prefix || null;
}

// Mirrors the filename rules of scripts/check-no-secrets.mjs, applied to pack
// entries. Key material is only flagged outside node_modules: dependencies ship
// test fixtures, and a state leak comes from our own build, not from a dep.
const STATE_RULES = [
  { re: /(?:^|\/)(?:jwt-secret|machine-id)$/, label: "credential state file" },
  { re: /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/, label: "database file" },
  { re: /(?:^|\/)\.env(?:\.[^/]*)?$/, skip: /(?:^|\/)\.env\.example$/, label: ".env file" },
  { re: /(?:^|\/)\.build-home\//, label: "CLI build HOME state" },
  { re: /(?:^|\/)usage\.json$|(?:^|\/)log\.txt$/, label: "runtime state under ~/.9router" },
  { re: /\.(?:tgz|tar|tar\.gz|zip|7z)$/, label: "nested archive" },
];
const KEY_RULE = {
  re: /\.pem$|\.key$|(?:^|\/)id_rsa(?:\..*)?$|(?:^|\/)id_ed25519(?:\..*)?$|\.p12$|\.pfx$|\.jks$|\.keystore$/,
  label: "key material",
};

export function scanPackEntries(entries) {
  const violations = [];
  for (const entry of entries) {
    const p = String(entry).trim().replaceAll("\\", "/").toLowerCase();
    if (!p || p.endsWith("/")) continue;
    let hit = STATE_RULES.find((r) => !(r.skip && r.skip.test(p)) && r.re.test(p));
    if (!hit && !p.includes("/node_modules/") && KEY_RULE.re.test(p)) hit = KEY_RULE;
    if (hit) violations.push(`${entry}: ${hit.label}`);
  }
  return violations;
}

export function parseKeyValues(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = /^([a-zA-Z_][\w]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const VERSION_SED = `sed -n 's/^[[:space:]]*"version":[[:space:]]*"\\([^"]*\\)".*/\\1/p'`;

/** Remote sh script: where does the service's package live, and what runs there. */
export function buildProbeScript({ packageRoot = "", unit }) {
  return `set -u
root=${shq(packageRoot)}; source=flag
if [ -z "$root" ] && [ -f "$HOME/.9router/9router-package-root" ]; then
  root=$(head -n1 "$HOME/.9router/9router-package-root"); source=state-file
fi
if [ -z "$root" ] && bin=$(command -v 9router 2>/dev/null); then
  root=$(dirname "$(readlink -f "$bin")"); source=path
fi
echo "root=$root"
echo "source=$source"
if [ -n "$root" ] && [ -f "$root/package.json" ]; then
  echo "version=$(${VERSION_SED} "$root/package.json" | head -n1)"
fi
if systemctl --user cat ${shq(unit)} >/dev/null 2>&1; then echo "unit=present"; else echo "unit=missing"; fi
echo "arch=$(uname -m)"
`;
}

/** Remote bash script: back up, install into the service prefix, verify, postinstall. */
export function buildInstallScript({ prefix, packageRoot, remoteTarball, fromVersion, cliVersion }) {
  return `set -euo pipefail
PREFIX=${shq(prefix)}
ROOT_DIR=${shq(packageRoot)}
TGZ=${shq(remoteTarball)}
WANT=${shq(cliVersion)}
export PATH="$PREFIX/bin:$PATH"
NPM="$PREFIX/bin/npm"; [ -x "$NPM" ] || NPM=npm

mkdir -p "$HOME/.9router/backups"
BACKUP="$HOME/.9router/backups/${PACKAGE_NAME}-"${shq(fromVersion)}"-pre-"${shq(cliVersion)}"-$(date +%Y%m%d-%H%M%S).tgz"
tar czf "$BACKUP" -C "$(dirname "$ROOT_DIR")" "$(basename "$ROOT_DIR")"
echo "backup=$BACKUP"

"$NPM" install -g --prefix "$PREFIX" --no-audit --no-fund "$TGZ"

GOT=$(${VERSION_SED} "$ROOT_DIR/package.json" | head -n1)
if [ "$GOT" != "$WANT" ]; then
  echo "error: install landed elsewhere — $ROOT_DIR has $GOT, expected $WANT" >&2
  exit 3
fi
echo "installed=$GOT"

(cd "$ROOT_DIR" && node hooks/postinstall.js)
rm -rf "$(dirname "$TGZ")"
`;
}

export function parseArgs(argv, env = process.env) {
  const opts = {
    host: env.DEPLOY_HOST || "",
    sshKey: env.DEPLOY_SSH_KEY || "",
    port: env.NINE_ROUTER_PORT || "20128",
    unit: "9router.service",
    packageRoot: "",
    dryRun: false,
  };
  const valueFlags = { "--ssh-key": "sshKey", "--port": "port", "--unit": "unit", "--package-root": "packageRoot" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (valueFlags[arg]) {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      opts[valueFlags[arg]] = argv[++i];
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else opts.host = arg;
  }
  return opts;
}

// ── side effects ──────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[deploy] ${msg}`);
}

function expandHome(p) {
  return p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function sshBase(opts) {
  const base = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
  if (opts.sshKey) base.push("-i", expandHome(opts.sshKey));
  return base;
}

/** Run a script on the remote host via stdin (no quoting through argv). */
function remote(opts, script, { shell = "sh", inherit = false } = {}) {
  return execFileSync("ssh", [...sshBase(opts), opts.host, shell, "-s"], {
    input: script,
    encoding: "utf8",
    stdio: ["pipe", inherit ? "inherit" : "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function readJsonVersion(file) {
  return JSON.parse(fs.readFileSync(file, "utf8")).version;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.host) {
    console.error(
      "usage: npm run deploy:remote -- <ssh-host> [--ssh-key <path>] [--port 20128] [--unit 9router.service] [--package-root <dir>] [--dry-run]",
    );
    process.exit(2);
  }

  const cliVersion = readJsonVersion(path.join(ROOT, "cli", "package.json"));
  const appVersion = readJsonVersion(path.join(ROOT, "package.json"));

  // 1. Probe
  const probe = parseKeyValues(remote(opts, buildProbeScript(opts)));
  const prefix = prefixFromPackageRoot(probe.root);
  log(`remote package root: ${probe.root || "(none)"} [${probe.source}]`);
  if (!probe.root || !probe.version) {
    throw new Error("no installed 9router found on the host; pass --package-root <prefix>/lib/node_modules/9router");
  }
  if (!prefix) throw new Error(`${probe.root} is not <prefix>/lib/node_modules/${PACKAGE_NAME}; refusing to guess the npm prefix`);
  if (probe.arch !== os.arch().replace("x64", "x86_64").replace("arm64", "aarch64")) {
    log(`note: remote arch ${probe.arch} differs from local ${os.arch()} (native deps install remotely via postinstall)`);
  }
  log(`installed ${probe.version} → candidate ${cliVersion} (app ${appVersion}), npm prefix ${prefix}`);
  log(`systemd --user unit ${opts.unit}: ${probe.unit}`);

  if (opts.dryRun) {
    log("dry run: nothing packed, copied, installed or restarted");
    return;
  }
  if (probe.unit !== "present") throw new Error(`systemd --user unit ${opts.unit} not found; pass --unit`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "9router-deploy-"));
  try {
    // 2. Pack, guarded against the REMOTE install
    const guardRoot = path.join(work, "remote-installed");
    fs.mkdirSync(guardRoot);
    fs.writeFileSync(
      path.join(guardRoot, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: probe.version }, null, 2),
    );
    if (!fs.existsSync(path.join(ROOT, "cli", "node_modules"))) {
      log("installing cli/ dependencies (needed to build the pack)");
      execFileSync("npm", ["--prefix", "cli", "install", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
    }
    log("packing CLI");
    execFileSync("npm", ["run", "cli:pack"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, NINE_ROUTER_PACKAGE_ROOT: guardRoot },
    });
    const tgzName = `${PACKAGE_NAME}-${cliVersion}.tgz`;
    const tgz = path.join(work, tgzName);
    fs.renameSync(path.join(ROOT, tgzName), tgz); // never leave an archive in the tree

    // 3. Inspect
    const entries = execFileSync("tar", ["tzf", tgz], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");
    const violations = scanPackEntries(entries);
    if (violations.length) {
      throw new Error(`pack carries state that must never ship:\n  ${violations.join("\n  ")}`);
    }
    log(`pack clean (${entries.filter(Boolean).length} entries)`);

    // 4–5. Copy, back up, install into the service prefix, verify, postinstall
    const remoteDir = remote(opts, "mktemp -d /tmp/9router-deploy.XXXXXX").trim();
    const remoteTarball = `${remoteDir}/${tgzName}`;
    execFileSync("scp", ["-q", ...sshBase(opts), tgz, `${opts.host}:${remoteTarball}`], { stdio: "inherit" });
    log("installing on host");
    const install = parseKeyValues(
      remote(
        opts,
        buildInstallScript({ prefix, packageRoot: probe.root, remoteTarball, fromVersion: probe.version, cliVersion }),
        { shell: "bash" },
      ),
    );
    const rollback = `rm -rf ${shq(probe.root)} && tar xzf ${shq(install.backup)} -C ${shq(path.posix.dirname(probe.root))} && systemctl --user restart ${shq(opts.unit)}`;
    log(`backup: ${install.backup}`);

    // 6. Restart and wait for the new version
    log(`restarting ${opts.unit}`);
    const live = remote(
      opts,
      `systemctl --user restart ${shq(opts.unit)}
for i in $(seq 1 90); do
  v=$(curl -fsS --max-time 2 http://127.0.0.1:${opts.port}/api/version 2>/dev/null || true)
  case "$v" in *'"currentVersion":"'${shq(appVersion)}'"'*) echo "live=ok"; echo "after=$i"; exit 0;; esac
  sleep 1
done
echo "live=timeout"; echo "last=$v"
systemctl --user status ${shq(opts.unit)} --no-pager -n 20 >&2 || true
`,
    );
    const status = parseKeyValues(live);
    if (status.live !== "ok") {
      console.error(`[deploy] FAILED: service did not report ${appVersion} within 90s (last: ${status.last || "no answer"})`);
      console.error(`[deploy] rollback: ssh ${opts.host} ${shq(rollback)}`);
      process.exit(1);
    }
    log(`live: ${appVersion} answering on :${opts.port} after ${status.after}s`);
    log(`rollback if needed: ssh ${opts.host} ${shq(rollback)}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[deploy] ${err.message}`);
    process.exit(1);
  });
}
