import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { LIVE_CATALOG_PROVIDERS } from "@/shared/utils/selectableModels.js";

describe("live catalog provider lists agree between pickers", () => {
  it("the model modal imports the single LIVE_CATALOG_PROVIDERS from selectableModels", () => {
    const src = fs.readFileSync(
      new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url),
      "utf-8",
    );
    // No local copy: a second literal is how the two pickers drifted apart before.
    expect(src).not.toMatch(/const LIVE_CATALOG_PROVIDERS\s*=/);
    expect(src).toMatch(
      /import\s*\{[^}]*\bLIVE_CATALOG_PROVIDERS\b[^}]*\}\s*from\s*["']@\/shared\/utils\/selectableModels["']/,
    );
    expect(LIVE_CATALOG_PROVIDERS.length).toBeGreaterThan(0);
  });
});
