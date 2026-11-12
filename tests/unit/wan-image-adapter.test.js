import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { getImageAdapter, isImageProvider } from "../../open-sse/handlers/imageProviders/index.js";
import { isAlibabaWanRequest } from "../../open-sse/handlers/imageProviders/alibabaWan.js";

const PROVIDER_ID = "openai-compatible-test-node";
const INTL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const CN = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const ctx = (model, baseUrl) => ({ model, credentials: { providerSpecificData: { baseUrl } } });
const PATH = "/compatible-mode/v1/chat/completions";

describe("Alibaba Wan Image Adapter", () => {
  it("selects the adapter by host + model for any node id", () => {
    for (const id of [PROVIDER_ID, "openai-compatible-chat-another-node"]) {
      expect(isImageProvider(id, ctx("wan2.6-t2i", INTL))).toBe(true);
      const adapter = getImageAdapter(id, ctx("wan-2.1", CN));
      expect(typeof adapter.buildUrl).toBe("function");
      expect(typeof adapter.buildHeaders).toBe("function");
      expect(typeof adapter.buildBody).toBe("function");
      expect(typeof adapter.normalize).toBe("function");
    }
    expect(isAlibabaWanRequest("wan-2.1", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1")).toBe(true);
  });

  it("does not route a DashScope node with a non-Wan model", () => {
    expect(getImageAdapter(PROVIDER_ID, ctx("qwen-max", INTL))).toBeNull();
  });

  it("does not route a non-DashScope node with a wan model", () => {
    for (const url of [
      "https://api.example.com/v1",
      "https://dashscope.aliyuncs.com.evil.com/v1",
      "https://evildashscope.aliyuncs.com/v1",
      "http://dashscope.aliyuncs.com/v1",
      "https://dashscope.aliyuncs.com:8443/v1",
      "",
      undefined,
    ]) {
      expect(getImageAdapter(PROVIDER_ID, ctx("wan-2.1", url))).toBeNull();
    }
    expect(getImageAdapter(PROVIDER_ID)).toBeNull();
    expect(getImageAdapter("openai", ctx("wan-2.1", INTL))).not.toBeNull(); // builtin untouched
    expect(getImageAdapter("some-other-provider", ctx("wan-2.1", INTL))).toBeNull();
  });

  it("buildUrl targets the node's own origin (intl and mainland) with the fixed path", () => {
    const adapter = getImageAdapter(PROVIDER_ID, ctx("wan-2.1", INTL));
    expect(adapter.buildUrl("wan-2.1", ctx("wan-2.1", INTL).credentials)).toBe(`https://dashscope-intl.aliyuncs.com${PATH}`);
    expect(adapter.buildUrl("wan-2.1", ctx("wan-2.1", CN).credentials)).toBe(`https://dashscope.aliyuncs.com${PATH}`);
    // user-supplied path/query never leaks into the call
    expect(adapter.buildUrl("wan-2.1", ctx("wan-2.1", `${CN}/../x?a=b`).credentials)).toBe(`https://dashscope.aliyuncs.com${PATH}`);
  });

  it("buildUrl refuses non-Alibaba or non-https base URLs", () => {
    const adapter = getImageAdapter(PROVIDER_ID, ctx("wan-2.1", INTL));
    expect(() => adapter.buildUrl("wan-2.1", ctx("x", "https://evil.example.com").credentials)).toThrow();
    expect(() => adapter.buildUrl("wan-2.1", ctx("x", "http://dashscope.aliyuncs.com").credentials)).toThrow();
    expect(() => adapter.buildUrl("wan-2.1", null)).toThrow();
  });

  it("the old hardcoded node id is gone", () => {
    const src = readFileSync(new URL("../../open-sse/handlers/imageProviders/index.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/openai-compatible-chat-[0-9a-f]{8}-/);
  });

  it("buildHeaders includes Authorization Bearer header", () => {
    const adapter = getImageAdapter(PROVIDER_ID, ctx("wan-2.1", INTL));
    expect(adapter.buildHeaders({ apiKey: "key-123" })).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer key-123",
    });
    expect(adapter.buildHeaders({ accessToken: "token-456" })).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer token-456",
    });
    expect(adapter.buildHeaders(null)).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer ",
    });
  });

  it("buildBody maps sizes (4K, 2K, 1K), caps reference images at 4, and sets parameters", () => {
    const adapter = getImageAdapter(PROVIDER_ID, ctx("wan-2.1", INTL));

    // 4K mapping
    const body4K = adapter.buildBody("wan-model", { prompt: "a sunset", size: "4096x4096" });
    expect(body4K.parameters.size).toBe("4K");
    expect(body4K.parameters.watermark).toBe(false);

    // 2K mapping
    const body2K_1 = adapter.buildBody("wan-model", { prompt: "a sunset", size: "2048x2048" });
    expect(body2K_1.parameters.size).toBe("2K");
    const body2K_2 = adapter.buildBody("wan-model", { prompt: "a sunset", size: "1536x1024" });
    expect(body2K_2.parameters.size).toBe("2K");

    // 1K default mapping
    const body1K = adapter.buildBody("wan-model", { prompt: "a sunset", size: "1024x1024" });
    expect(body1K.parameters.size).toBe("1K");

    // Images ref capping at 4 + parameter passing
    const bodyComplex = adapter.buildBody("wan-model", {
      prompt: "landscape",
      size: "1024x1024",
      watermark: true,
      image: "http://example.com/single.jpg",
      images: [
        "http://example.com/1.jpg",
        "http://example.com/2.jpg",
        "http://example.com/3.jpg",
        "http://example.com/4.jpg",
        "http://example.com/5.jpg",
        null,
        123,
      ],
      negative_prompt: "blurry",
      prompt_extend: true,
      seed: 42,
      enable_interleave: false,
    });

    expect(bodyComplex.model).toBe("wan-model");
    expect(bodyComplex.messages).toHaveLength(1);
    expect(bodyComplex.messages[0].role).toBe("user");

    const content = bodyComplex.messages[0].content;
    expect(content[0]).toEqual({ text: "landscape" });
    // First ref is body.images[0..], then body.image -> total sliced to 4
    expect(content.slice(1)).toHaveLength(4);
    expect(content.slice(1)).toEqual([
      { image: "http://example.com/1.jpg" },
      { image: "http://example.com/2.jpg" },
      { image: "http://example.com/3.jpg" },
      { image: "http://example.com/4.jpg" },
    ]);

    expect(bodyComplex.parameters).toEqual({
      size: "1K",
      watermark: true,
      negative_prompt: "blurry",
      prompt_extend: true,
      seed: 42,
      enable_interleave: false,
    });
  });

  it("normalize extracts b64_json and URLs and deduplicates items", () => {
    const adapter = getImageAdapter(PROVIDER_ID, ctx("wan-2.1", INTL));

    const mockPayload = {
      id: "chatcmpl-123",
      choices: [
        {
          message: {
            content: "Here is the image:",
            images: [
              "https://example.com/img1.png",
              "https://example.com/img1.png", // duplicate
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            ],
          },
        },
      ],
      output: {
        b64_json: "b64string123",
        data: [
          { b64_json: "b64string123" }, // duplicate b64
          { url: "https://example.com/img2.png" },
        ],
      },
    };

    const result = adapter.normalize(mockPayload);
    expect(result.created).toBeGreaterThan(0);
    // Traversal order of keys: ["url", "image_url", "image", "data", "output", "choices", "message", "content", "images"]
    // "output" is checked before "choices", so output.b64_json and output.data are extracted first.
    expect(result.data).toEqual([
      { b64_json: "b64string123" },
      { url: "https://example.com/img2.png" },
      { url: "https://example.com/img1.png" },
      { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
    ]);
  });
});
