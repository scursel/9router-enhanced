// video_url content parts must reach OpenAI-compatible providers (cline `cl/`,
// openrouter, …) intact. filterToOpenAIFormat used to drop them because
// "video_url" was missing from VALID_OPENAI_CONTENT_TYPES, so the model answered
// "I can't see the video". An image_url carrying a data:video/* URI is rewritten
// to video_url for OpenAI targets (OpenRouter-style video input). Gemini targets
// keep turning both into inlineData.
import { describe, it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const VIDEO = "data:video/mp4;base64,AAAAGGZ0eXBtcDQy";
const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

function body(part) {
  return {
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "describe" }, part] }],
  };
}

const userParts = (r) => r.messages.find((m) => m.role === "user").content;

describe.each(["cline", "openrouter"])("video_url passthrough to OpenAI-compatible provider %s", (provider) => {
  it("keeps a video_url part intact", () => {
    const part = { type: "video_url", video_url: { url: VIDEO } };
    const r = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "m", body(part), false, null, provider);
    expect(userParts(r)).toEqual([{ type: "text", text: "describe" }, part]);
  });

  it("rewrites image_url with a data:video/* URI to video_url", () => {
    const r = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "m", body({ type: "image_url", image_url: { url: VIDEO } }), false, null, provider);
    expect(userParts(r)[1]).toEqual({ type: "video_url", video_url: { url: VIDEO } });
  });

  it("leaves a real image_url untouched", () => {
    const part = { type: "image_url", image_url: { url: IMAGE, detail: "low" } };
    const r = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "m", body(part), false, null, provider);
    expect(userParts(r)[1]).toEqual(part);
  });
});

describe("Gemini targets still receive video as inlineData", () => {
  const inline = { inlineData: { mime_type: "video/mp4", data: "AAAAGGZ0eXBtcDQy" } };
  const geminiParts = (r) => r.contents.find((c) => c.role === "user").parts;

  it("image_url data:video → inlineData (existing path, unchanged)", () => {
    const r = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "gemini-3.7-flash", body({ type: "image_url", image_url: { url: VIDEO } }), false, null, "gemini");
    expect(geminiParts(r)).toContainEqual(inline);
  });

  it("video_url data:video → inlineData (so a mixed combo can send one payload)", () => {
    const r = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "gemini-3.7-flash", body({ type: "video_url", video_url: { url: VIDEO } }), false, null, "gemini");
    expect(geminiParts(r)).toContainEqual(inline);
  });

  it("antigravity envelope carries the video too", () => {
    const r = translateRequest(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, "gemini-3.7-flash-high", body({ type: "video_url", video_url: { url: VIDEO } }), false, null, "antigravity");
    const parts = r.request.contents.find((c) => c.role === "user").parts;
    expect(parts).toContainEqual(inline);
  });
});
