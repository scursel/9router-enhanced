import { describe, it, expect, vi } from "vitest";

describe("responseShowsReasoning", async () => {
  const { responseShowsReasoning } = await import("@/lib/modelMeta/detect.js");
  it("sees reasoning text, reasoning details, thinking parts or counted reasoning tokens", () => {
    expect(responseShowsReasoning({ choices: [{ message: { content: "391", reasoning_content: "17*23..." } }] })).toBe(true);
    expect(responseShowsReasoning({ choices: [{ message: { content: "391", reasoning: "17*20=340..." } }] })).toBe(true);
    expect(responseShowsReasoning({ choices: [{ message: { content: [{ type: "thinking", thinking: "x" }] } }] })).toBe(true);
    expect(responseShowsReasoning({ choices: [{ message: { content: "391" } }], usage: { completion_tokens_details: { reasoning_tokens: 12 } } })).toBe(true);
    expect(responseShowsReasoning({ choices: [{ message: { content: "391" } }], usage: { completion_tokens_details: { reasoning_tokens: 0 } } })).toBe(false);
  });
});

describe("probeReasoning", async () => {
  const { probeReasoning } = await import("@/lib/modelMeta/detect.js");
  const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const opts = (fetchImpl) => ({ fetchImpl, baseUrl: "http://x", headers: {} });

  it("reasoning present → true; absent → false", async () => {
    expect((await probeReasoning("p/m", opts(async () => res(200, { choices: [{ message: { reasoning_content: "hm", content: "391" } }] })))).reasoning).toBe(true);
    expect((await probeReasoning("p/m", opts(async () => res(200, { choices: [{ message: { content: "391" } }] })))).reasoning).toBe(false);
  });

  it("a model that rejects the reasoning parameter is 'no reasoning' once a plain call works", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(400, { error: { message: "Unrecognized request argument: reasoning_effort" } }))
      .mockResolvedValueOnce(res(200, { choices: [{ message: { content: "391" } }] }));
    const r = await probeReasoning("p/m", opts(fetchImpl));
    expect(r.reasoning).toBe(false);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).reasoning_effort).toBeUndefined();
  });

  it("an outage is unknown (null), never 'no reasoning'", async () => {
    const r = await probeReasoning("p/m", opts(async () => res(503, { error: { message: "overloaded" } })));
    expect(r.reasoning).toBeNull();
    expect(r.error).toContain("overloaded");
    expect((await probeReasoning("p/m", opts(async () => { throw new Error("ECONNRESET"); }))).reasoning).toBeNull();
  });
});

describe("detectModelMeta", async () => {
  const { detectModelMeta } = await import("@/lib/modelMeta/detect.js");
  it("context from the provider list, reasoning from the probe (tested wins over the list)", async () => {
    const save = vi.fn(async () => ({}));
    const out = await detectModelMeta({
      providerId: "openrouter", modelId: "m1",
      deps: {
        listImportCandidates: async () => ({ candidates: [{ id: "m1", contextLength: 262144, reasoning: false }] }),
        probeReasoning: async () => ({ reasoning: true, status: 200, error: null }),
        setModelMeta: save,
      },
    });
    expect(out).toMatchObject({ contextWindow: 262144, contextSource: "provider", reasoning: true, reasoningSource: "tested", listed: true });
    expect(save).toHaveBeenCalledWith("openrouter", "m1", { contextWindow: 262144, source: "provider" });
    expect(save).toHaveBeenCalledWith("openrouter", "m1", { reasoning: true, source: "tested" });
  });

  it("falls back to the list's reasoning when the probe cannot tell, stores nothing unknown", async () => {
    const save = vi.fn(async () => ({}));
    const out = await detectModelMeta({
      providerId: "openrouter", modelId: "m2",
      deps: {
        listImportCandidates: async () => ({ candidates: [{ id: "m2", contextLength: null, reasoning: true }] }),
        probeReasoning: async () => ({ reasoning: null, status: 503, error: "down" }),
        setModelMeta: save,
      },
    });
    expect(out.reasoning).toBe(true);
    expect(out.reasoningSource).toBe("provider");
    expect(out.contextWindow).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("modelMetaRepo (temp DATA_DIR)", async () => {
  it("merges facts and keeps the other field", async () => {
    const repo = await import("@/lib/db/repos/modelMetaRepo.js");
    await repo.setModelMeta("tp", "mm", { contextWindow: 128000, source: "provider" });
    await repo.setModelMeta("tp", "mm", { reasoning: true, source: "tested" });
    const m = await repo.getModelMetaFor("tp", "mm");
    expect(m).toMatchObject({ contextWindow: 128000, contextSource: "provider", reasoning: true, reasoningSource: "tested" });
    await repo.setModelMeta("tp", "mm", { contextWindow: null, reasoning: undefined, source: "tested" });
    expect((await repo.getModelMetaFor("tp", "mm")).contextWindow).toBe(128000);
  });
});
