// Publish guard: stops a fork build from being published under the official
// npm package name.
//
// `cli/package.json` is named `9router`, which is the OFFICIAL package on npm.
// This fork's CLI versions look like `0.5.119-enhanced.N`. Nothing used to stop
// `npm publish` (or `npm run cli:publish`) from pushing the fork over the
// official name. This guard runs as the first step of `prepublishOnly` in
// `cli/package.json` and fails closed in two cases:
//
//   1. the name is `9router` and the version contains `-enhanced`
//      (a fork build must never go out under the official name, even with the
//      opt-in below);
//   2. the name is `9router` and NINEROUTER_ALLOW_OFFICIAL_PUBLISH !== "1"
//      (publishing under the official name needs an explicit opt-in).
//
// Any other name (for example a renamed or scoped package) is allowed.
//
// Run directly: `node scripts/publish-guard.mjs` checks `cli/package.json`
// relative to this file, so the working directory does not matter.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OFFICIAL_NAME = "9router";
const FORK_MARKER = "-enhanced";
const OPT_IN_ENV = "NINEROUTER_ALLOW_OFFICIAL_PUBLISH";

/**
 * Decide whether publishing `name@version` is allowed.
 * Pure: no I/O, reads only the arguments.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkPublishAllowed({ name, version, env = {} } = {}) {
  if (name !== OFFICIAL_NAME) {
    return { ok: true };
  }

  if (String(version ?? "").includes(FORK_MARKER)) {
    return {
      ok: false,
      reason: `package "${name}" at fork version "${version}" must not be published under the official name. Fork builds (versions containing "${FORK_MARKER}") are never allowed under "${OFFICIAL_NAME}", even with ${OPT_IN_ENV}=1.`,
    };
  }

  if (env?.[OPT_IN_ENV] !== "1") {
    return {
      ok: false,
      reason: `package "${name}" is the official npm package name. Publishing under it requires an explicit opt-in: set ${OPT_IN_ENV}=1.`,
    };
  }

  return { ok: true };
}

const HOW_TO_FIX = [
  "To publish this fork, rename the package in cli/package.json to a name you own",
  "(for example a scoped name such as \"@your-scope/9router\") before running npm publish.",
  "Do not change the name back to \"9router\" for a fork build.",
].join("\n");

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, "..", "cli", "package.json");

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch (err) {
    process.stderr.write(`publish guard: cannot read ${pkgPath}: ${err.message}\n`);
    return 1;
  }

  const result = checkPublishAllowed({
    name: pkg.name,
    version: pkg.version,
    env: process.env,
  });

  if (!result.ok) {
    process.stderr.write(
      [
        "publish guard: BLOCKED",
        `  what: ${pkg.name}@${pkg.version} (${pkgPath})`,
        `  why:  ${result.reason}`,
        `  fix:  ${HOW_TO_FIX.split("\n").join("\n        ")}`,
        "",
      ].join("\n"),
    );
    return 1;
  }

  process.stdout.write("publish guard: ok\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main());
}
