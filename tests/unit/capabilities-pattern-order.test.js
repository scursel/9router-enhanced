import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel as caps } from "../../open-sse/providers/capabilities.js";

// Pattern-table ordering bugs: the first matching glob wins, so a generic
// family pattern placed before a specific one silently decides thinking format,
// limits, and whether `thinking` is sent at all.
describe("capabilities pattern order", () => {
  it.each(["claude-3-5-haiku-20241022", "claude-3-opus-20240229", "claude-3.5-sonnet"])(
    "%s has no reasoning (thinking is a 400 before 3.7)", (id) => {
      const c = caps(null, id);
      expect(c.reasoning).toBe(false);
      expect(c.maxOutput).toBe(8192);
    });

  it("claude-3-7 keeps budget thinking", () => {
    expect(caps(null, "claude-3-7-sonnet-20250219")).toMatchObject({ reasoning: true, thinkingFormat: "claude-budget" });
  });

  it.each(["claude-opus-4-6-20260101", "claude-sonnet-4-7", "claude-opus-4-7-thinking", "claude-opus-4.6-20260101"])(
    "%s resolves like its exact 4.6+ entry (adaptive, 1M/128k)", (id) => {
      expect(caps(null, id)).toMatchObject({ thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 });
    });

  it.each(["claude-fable-5.1", "claude-fable-5-1-20260801"])("%s is adaptive-only like claude-fable-5-1", (id) => {
    const exact = caps(null, "claude-fable-5-1");
    expect(caps(null, id)).toMatchObject({
      thinkingFormat: exact.thinkingFormat, thinkingCanDisable: exact.thinkingCanDisable,
    });
  });

  it("older Claude 4.x stay on budget thinking", () => {
    expect(caps(null, "claude-sonnet-4-5").thinkingFormat).toBe("claude-budget");
    expect(caps(null, "claude-opus-4-1").thinkingFormat).toBe("claude-budget");
  });

  it("gemini-2.5 Pro cannot disable thinking and allows 32768; Flash is unchanged", () => {
    expect(caps(null, "gemini-2.5-pro")).toMatchObject({ thinkingCanDisable: false, thinkingRange: { min: 128, max: 32768 } });
    expect(caps(null, "gemini-2.5-flash")).toMatchObject({ thinkingCanDisable: true, thinkingRange: { min: 0, max: 24576 } });
  });

  it("o-series patterns are anchored to the model id", () => {
    for (const id of ["o1", "o1-mini", "o3", "o3-mini", "o3-pro", "o4-mini", "openai/o3"]) {
      expect(caps(null, id).thinkingFormat, id).toBe("openai");
    }
    expect(caps(null, "yolo4").reasoning).toBe(false);
    expect(caps(null, "qwen-turbo4").thinkingFormat).not.toBe("openai");
  });
});
