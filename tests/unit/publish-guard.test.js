import { describe, it, expect } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkPublishAllowed } from "../../scripts/publish-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/publish-guard.mjs");
const OPT_IN = { NINEROUTER_ALLOW_OFFICIAL_PUBLISH: "1" };

describe("publish-guard: checkPublishAllowed", () => {
  it("blocks a fork version under the official name even with the opt-in", () => {
    const r = checkPublishAllowed({ name: "9router", version: "0.5.119-enhanced.4", env: OPT_IN });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fork/);
  });

  it("blocks the official name without the opt-in", () => {
    const r = checkPublishAllowed({ name: "9router", version: "0.5.119", env: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/NINEROUTER_ALLOW_OFFICIAL_PUBLISH=1/);
  });

  it("allows the official name with a plain version and opt-in '1'", () => {
    expect(checkPublishAllowed({ name: "9router", version: "0.5.119", env: OPT_IN })).toEqual({ ok: true });
  });

  it("allows a scoped name with a fork version", () => {
    expect(
      checkPublishAllowed({ name: "@someone/9router", version: "0.5.119-enhanced.4", env: {} }),
    ).toEqual({ ok: true });
  });
});

describe("publish-guard: script run against the real cli/package.json", () => {
  it("exits 1 and names 9router on stderr for the fork package", () => {
    const res = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, NINEROUTER_ALLOW_OFFICIAL_PUBLISH: "" },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/BLOCKED/);
    expect(res.stderr).toMatch(/9router/);
  });
});
