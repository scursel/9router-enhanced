import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-model-routing-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const { createProviderNode } = await import("@/models/index.js");
  const { getModelInfo } = await import("@/sse/services/model.js");
  const { addCustomModel } = await import("@/lib/db/repos/aliasRepo.js");

  return {
    createProviderNode,
    getModelInfo,
    addCustomModel,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("model routing", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("keeps built-in provider aliases ahead of compatible node prefixes", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-test",
      type: "openai-compatible",
      name: "Compatible CF Collision",
      prefix: "cf",
      apiType: "chat",
      baseUrl: "https://compatible.test/v1",
    });

    await expect(ctx.getModelInfo("cf/@cf/black-forest-labs/flux-2-klein-9b"))
      .resolves.toEqual({
        provider: "cloudflare-ai",
        model: "@cf/black-forest-labs/flux-2-klein-9b",
      });
  });

  it("still routes non-reserved compatible node prefixes", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-test",
      type: "openai-compatible",
      name: "Compatible OCT",
      prefix: "oct",
      apiType: "chat",
      baseUrl: "https://compatible.test/v1",
    });

    await expect(ctx.getModelInfo("oct/gpt-image-1"))
      .resolves.toEqual({
        provider: "openai-compatible-chat-test",
        model: "gpt-image-1",
      });
  });

  it("preserves the requested identity when a custom chat model has an upstream id", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;
    const provider = "openai-compatible-chat-test";
    await ctx.createProviderNode({
      id: provider,
      type: "openai-compatible",
      name: "Workhorse",
      prefix: "workhorse",
      apiType: "chat",
      baseUrl: "https://compatible.test/v1",
    });
    await ctx.addCustomModel({
      providerAlias: "workhorse",
      id: "qwen38-gguf-mtp-vision",
      upstreamModelId: "qwen38-gguf-mtp",
    });

    await expect(ctx.getModelInfo("workhorse/qwen38-gguf-mtp-vision"))
      .resolves.toEqual({ provider, model: "qwen38-gguf-mtp-vision" });
    for (const prefix of ["workhorse", provider]) {
      await expect(ctx.getModelInfo(`${prefix}/qwen38-gguf-mtp-vision(high)`, { resolveUpstreamId: true }))
        .resolves.toEqual({ provider, model: "qwen38-gguf-mtp-vision(high)", upstreamModelId: "qwen38-gguf-mtp(high)" });
    }
    await expect(ctx.getModelInfo("workhorse/qwen38-gguf-mtp", { resolveUpstreamId: true }))
      .resolves.toEqual({ provider, model: "qwen38-gguf-mtp" });
  });
});
