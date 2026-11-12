import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { isOwnAppProcess } from "@/lib/appUpdater.js";

const require = createRequire(import.meta.url);
const cli = require("../../cli/cli.js");

const INSTALL = "/opt/npm/lib/node_modules/9router/cli";
const OPTS = { selfPid: 100, ownedPaths: [`${INSTALL}/cli.js`], ownedDirs: [`${INSTALL}/app`, INSTALL], resolveCwd: () => `${INSTALL}/app` };

describe("cwd ownership rule only claims server-like processes", () => {
  for (const cmd of ["-bash", "/bin/zsh -l", "vim notes.txt", "code .", "less README.md"]) {
    it(`does not claim "${cmd}" sitting in the install dir`, () => {
      expect(isOwnAppProcess({ pid: 7, cmd }, OPTS)).toBe(false);
      expect(cli.isOwnAppProcess({ pid: 7, cmd }, OPTS)).toBe(false);
    });
  }
  it("still claims a title-rewritten or node server by cwd", () => {
    for (const cmd of ["next-server (v15.5.4)", "/usr/bin/node server.js"]) {
      expect(isOwnAppProcess({ pid: 8, cmd }, OPTS)).toBe(true);
      expect(cli.isOwnAppProcess({ pid: 8, cmd }, OPTS)).toBe(true);
    }
  });
});
