import { describe, it, expect, vi } from "vitest";

const store = vi.hoisted(() => ({ settings: {} }));
vi.mock("@/lib/db/index.js", () => ({
  getSettings: async () => { await new Promise((r) => setTimeout(r, 5)); return JSON.parse(JSON.stringify(store.settings)); },
  updateSettings: async (u) => { await new Promise((r) => setTimeout(r, 5)); store.settings = { ...store.settings, ...u }; return store.settings; },
}));

const { saveImportRule, deleteImportRule, listImportRules } = await import("@/lib/modelImport/rules.js");

describe("autoModelImportRules concurrent writes", () => {
  it("keeps both rules when two providers save at the same time", async () => {
    await Promise.all([saveImportRule("prov-a", {}), saveImportRule("prov-b", {})]);
    expect(Object.keys(await listImportRules()).sort()).toEqual(["prov-a", "prov-b"]);
    await Promise.all([deleteImportRule("prov-a"), saveImportRule("prov-c", {})]);
    expect(Object.keys(await listImportRules()).sort()).toEqual(["prov-b", "prov-c"]);
  });
});
