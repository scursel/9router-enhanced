import { describe, expect, it } from "vitest";
import { buildLifecycleIndex } from "@/shared/utils/modelLifecycleIndex.js";

describe("buildLifecycleIndex", () => {
  const list = [
    { id: "aa/gpt-x", lifecycle: "retired" },
    { id: "bb/gpt-x" },
    { id: "bb/other", lifecycle: "deprecated" },
  ];
  it("does not let another provider's lifecycle leak onto a bare id", () => {
    const idx = buildLifecycleIndex(list, ["bb"]);
    expect(idx["gpt-x"]).toBeUndefined();
    expect(idx["aa/gpt-x"]).toBe("retired");
    expect(idx["other"]).toBe("deprecated");
  });
  it("indexes bare ids of the card's own provider", () => {
    expect(buildLifecycleIndex(list, ["aa"])["gpt-x"]).toBe("retired");
  });
});
