import { describe, it, expect } from "vitest";
import { detectRequiredCapabilities, reorderByCapabilities } from "../../open-sse/services/combo.js";

// Video sent to a non-video member is dropped by the provider (or its executor)
// and the model answers "I didn't get a video" — a 200 the combo can't fall
// back from. So video routes only to members that read video, when it has any.

describe("detectRequiredCapabilities — video carried as image_url", () => {
  it("image_url with data:video/* -> videoInput, not vision", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:video/mp4;base64,AAAA" } },
    ] }] });
    expect(r.has("videoInput")).toBe(true);
    expect(r.has("vision")).toBe(false);
  });

  it("string-form image_url with data:video/* -> videoInput", () => {
    const r = detectRequiredCapabilities({ input: [{ role: "user", content: [
      { type: "input_image", image_url: "data:video/webm;base64,AAAA" },
    ] }] });
    expect(r.has("videoInput")).toBe(true);
    expect(r.has("vision")).toBe(false);
  });

  it("image_url with data:image/* stays vision", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ] }] });
    expect(r.has("vision")).toBe(true);
    expect(r.has("videoInput")).toBe(false);
  });
});

describe("reorderByCapabilities — videoInput", () => {
  it("drops members that can't read video when another member can", () => {
    const models = ["deepseek/deepseek-chat", "zai/glm-4.6v", "anthropic/claude-sonnet-4.6"];
    expect(reorderByCapabilities(models, new Set(["videoInput"]))).toEqual(["zai/glm-4.6v"]);
  });

  it("keeps nested combo references (no provider prefix) — they route video themselves", () => {
    const models = ["deepseek/deepseek-chat", "Gemini3.7", "zai/glm-4.6v"];
    expect(reorderByCapabilities(models, new Set(["videoInput"]))).toEqual(["zai/glm-4.6v", "Gemini3.7"]);
  });

  it("keeps every member when none can read video (no worse than before)", () => {
    const models = ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6"];
    expect(reorderByCapabilities(models, new Set(["videoInput"]))).toEqual(models);
  });

  it("vision still only reorders (never drops)", () => {
    const models = ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6"];
    expect(reorderByCapabilities(models, new Set(["vision"]))).toEqual([
      "anthropic/claude-sonnet-4.6", "deepseek/deepseek-chat",
    ]);
  });
});
