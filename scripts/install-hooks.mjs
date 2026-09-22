#!/usr/bin/env node
// Installs scripts/check-no-secrets.mjs as the git pre-commit hook.
// Runs from `npm install` (prepare). Must never fail the install: outside a
// git checkout (Docker build, tarball install) it is a silent no-op.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, lstatSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";

const MARKER = "# managed-by: scripts/install-hooks.mjs";
const HOOK = `#!/bin/sh
${MARKER}
exec node "$(git rev-parse --show-toplevel)/scripts/check-no-secrets.mjs"
`;

try {
  const hooksDir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const target = path.join(hooksDir, "pre-commit");

  if (existsSync(target) || isDanglingLink(target)) {
    const st = lstatSync(target);
    const ours = st.isSymbolicLink()
      ? true // the old documented install was a symlink to our script
      : readFileSync(target, "utf8").includes(MARKER);
    if (!ours) {
      console.warn(`install-hooks: ${target} exists and is not ours — left alone. Chain scripts/check-no-secrets.mjs from it.`);
      process.exit(0);
    }
    unlinkSync(target);
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(target, HOOK);
  chmodSync(target, 0o755);
} catch {
  // not a git checkout / git missing — nothing to install
}

function isDanglingLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
