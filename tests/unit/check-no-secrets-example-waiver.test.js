import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/check-no-secrets.mjs");

function scan(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nosecrets-"));
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, content);
  try {
    return spawnSync(process.execPath, [script, file], { encoding: "utf8", cwd: root });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("check-no-secrets: 'example' word does not waive a real-looking secret", () => {
  const value = "Zq8Lm3Xv0Rt5Yw2Pn7Kc4Bd9Hf1Jg6Sa";
  it("flags JWT_SECRET with a real value even when the line says 'example'", () => {
    expect(scan(`JWT_SECRET=${value} # example\n`).status).not.toBe(0);
  });
  it("still waives an obvious placeholder value", () => {
    expect(scan(`JWT_SECRET=examplexamplexamplexamplexamplexx\n`).status).toBe(0);
  });
});
