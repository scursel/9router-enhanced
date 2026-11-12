import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = fs.readFileSync(path.join(root, "next.config.mjs"), "utf8");

describe("next.config.mjs outputFileTracingIncludes", () => {
  it("is declared once (a duplicate object key silently drops the first)", () => {
    expect(src.match(/^\s*outputFileTracingIncludes\s*:/gm)).toHaveLength(1);
  });
  it("ships both undici and the deepseek PoW worker", () => {
    expect(src).toContain("./node_modules/undici/**/*");
    expect(src).toContain("./open-sse/lib/deepseek-pow-hash.js");
  });
});
