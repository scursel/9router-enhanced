import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { LIVE_CATALOG_PROVIDERS } from "@/shared/utils/selectableModels.js";

describe("live catalog provider lists agree between pickers", () => {
  it("selectableModels covers every provider the model modal fetches live", () => {
    const src = fs.readFileSync(
      new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url),
      "utf-8",
    );
    const match = src.match(/const LIVE_CATALOG_PROVIDERS\s*=\s*\[([^\]]+)\]/);
    const modal = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect([...LIVE_CATALOG_PROVIDERS].sort()).toEqual(modal);
  });
});
