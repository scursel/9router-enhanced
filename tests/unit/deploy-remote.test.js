import { describe, it, expect } from "vitest";
import {
  prefixFromPackageRoot,
  scanPackEntries,
  parseKeyValues,
  buildProbeScript,
  buildInstallScript,
  parseArgs,
} from "../../scripts/deploy-remote.mjs";

describe("deploy-remote", () => {
  describe("prefixFromPackageRoot", () => {
    it("derives the npm prefix the service's package lives under", () => {
      // The incident: `npm install -g` used the host's default prefix (~/.local)
      // while the service ran from ~/.hermes/node. The prefix must come from the
      // live package root, never from npm's default.
      expect(prefixFromPackageRoot("/home/u/.hermes/node/lib/node_modules/9router")).toBe("/home/u/.hermes/node");
      expect(prefixFromPackageRoot("/usr/local/lib/node_modules/9router/")).toBe("/usr/local");
    });

    it("refuses a root that is not a global npm install of 9router", () => {
      expect(prefixFromPackageRoot("/home/u/src/9router")).toBeNull();
      expect(prefixFromPackageRoot("/home/u/.local/lib/node_modules/other")).toBeNull();
      expect(prefixFromPackageRoot("relative/lib/node_modules/9router")).toBeNull();
      expect(prefixFromPackageRoot("")).toBeNull();
      expect(prefixFromPackageRoot(undefined)).toBeNull();
    });
  });

  describe("scanPackEntries", () => {
    it("passes ordinary package contents", () => {
      expect(
        scanPackEntries([
          "package/cli.js",
          "package/app/src/sse/services/backgroundTokenRefresh.js",
          "package/app/node_modules/@aws-sdk/credential-provider-env/dist-cjs/index.js",
          "package/app/.env.example",
        ]),
      ).toEqual([]);
    });

    it("blocks build-HOME state that leaked once (jwt-secret, machine-id, db)", () => {
      const v = scanPackEntries([
        "package/app/.build-home/.9router/jwt-secret",
        "package/machine-id",
        "package/app/db/data.sqlite",
        "package/app/data.sqlite-wal",
        "package/app/.env",
        "package/app/usage.json",
        "package/app/log.txt",
        "package/9router-0.5.69.tgz",
      ]);
      expect(v).toHaveLength(8);
    });

    it("blocks key material outside node_modules but tolerates dependency fixtures", () => {
      expect(scanPackEntries(["package/app/server.key"])).toHaveLength(1);
      expect(scanPackEntries(["package/app/node_modules/some-dep/test/fixture.pem"])).toEqual([]);
    });
  });

  describe("parseKeyValues", () => {
    it("reads key=value lines and ignores noise", () => {
      expect(parseKeyValues("root=/a/b\nversion=1.2.3\nnoise line\nunit=\n")).toEqual({
        root: "/a/b",
        version: "1.2.3",
        unit: "",
      });
    });

    it("keeps '=' inside values", () => {
      expect(parseKeyValues("x=a=b")).toEqual({ x: "a=b" });
    });
  });

  describe("buildProbeScript", () => {
    it("prefers the package-root state file the start script reads", () => {
      const s = buildProbeScript({ unit: "9router.service" });
      expect(s.indexOf("9router-package-root")).toBeLessThan(s.indexOf("command -v 9router"));
    });

    it("honours an explicit package root over discovery", () => {
      const s = buildProbeScript({ packageRoot: "/opt/x/lib/node_modules/9router", unit: "9router.service" });
      expect(s).toContain("'/opt/x/lib/node_modules/9router'");
    });
  });

  describe("buildInstallScript", () => {
    const base = {
      prefix: "/home/u/.hermes/node",
      packageRoot: "/home/u/.hermes/node/lib/node_modules/9router",
      remoteTarball: "/tmp/9router-deploy.abc/9router-1.0.0.tgz",
      fromVersion: "0.9.0",
      cliVersion: "1.0.0",
    };

    it("installs into the service prefix, not npm's default", () => {
      const s = buildInstallScript(base);
      expect(s).toMatch(/install -g --prefix "\$PREFIX"/);
      expect(s).toContain("PREFIX='/home/u/.hermes/node'");
    });

    it("verifies the install landed in the service root before anything restarts", () => {
      const s = buildInstallScript(base);
      expect(s.indexOf("install landed elsewhere")).toBeGreaterThan(-1);
      expect(s.indexOf("install landed elsewhere")).toBeLessThan(s.indexOf("hooks/postinstall.js"));
    });

    it("runs the package postinstall explicitly (npm may block it via allow-scripts)", () => {
      expect(buildInstallScript(base)).toContain("node hooks/postinstall.js");
    });

    it("backs up the live package before replacing it", () => {
      const s = buildInstallScript(base);
      expect(s.indexOf("tar czf")).toBeLessThan(s.indexOf("install -g"));
    });

    it("shell-quotes interpolated values", () => {
      const s = buildInstallScript({ ...base, prefix: "/home/o'neil/node" });
      expect(s).toContain(`PREFIX='/home/o'\\''neil/node'`);
    });
  });

  describe("parseArgs", () => {
    it("takes the host positionally and options by flag", () => {
      expect(parseArgs(["box", "--ssh-key", "~/.ssh/k", "--port", "3000", "--dry-run"], {})).toMatchObject({
        host: "box",
        sshKey: "~/.ssh/k",
        port: "3000",
        dryRun: true,
        unit: "9router.service",
      });
    });

    it("falls back to env and defaults", () => {
      expect(parseArgs([], { DEPLOY_HOST: "h", DEPLOY_SSH_KEY: "k" })).toMatchObject({
        host: "h",
        sshKey: "k",
        port: "20128",
        dryRun: false,
      });
    });

    it("rejects unknown flags", () => {
      expect(() => parseArgs(["h", "--bogus"], {})).toThrow(/unknown option/);
    });
  });
});
