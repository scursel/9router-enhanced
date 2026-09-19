// Combo TARGET-level fallback on 4xx (F25/RH2 follow-up).
//
// Account-level policy is unchanged: a request-shaped 4xx (400/406/413/422) or
// a 401 never locks/cools an account, because every account of the same
// provider would answer the same (RH2). But the combo loop is target-level
// orchestration: a 4xx from ONE upstream — "Model is unavailable",
// "insufficient credits" — must not take the whole combo down while other
// members can still serve. The loop must try the next member; the final block
// reports the same status/message pairing plus the tried-trail.
import { describe, expect, it } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };

const failing = (status, message) => new Response(
  JSON.stringify({ error: { message } }),
  { status, headers: { "Content-Type": "application/json" } },
);

const ok = (model) => new Response(
  JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "OK" } }], model }),
  { status: 200, headers: { "Content-Type": "application/json" } },
);

describe("handleComboChat — a 4xx from one member falls through to the next (target-level)", () => {
  it("400 'Model is unavailable' on the first member: healthy member serves the request", async () => {
    const tried = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["dead/model-a", "alive/model-b"],
      handleSingleModel: async (_body, modelStr) => {
        tried.push(modelStr);
        return modelStr === "dead/model-a" ? failing(400, "Model is unavailable") : ok("alive/model-b");
      },
      log,
      comboName: "t4xx",
      comboStrategy: "none",
    });

    expect(tried, "the dead member must not stop the chain").toEqual(["dead/model-a", "alive/model-b"]);
    expect(response.status).toBe(200);
  });

  it("401 on the first member also falls through (refresh flow owns the account, not the combo)", async () => {
    const tried = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["revoked/model-a", "alive/model-b"],
      handleSingleModel: async (_body, modelStr) => {
        tried.push(modelStr);
        return modelStr === "revoked/model-a" ? failing(401, "Invalid API key provided") : ok("alive/model-b");
      },
      log,
      comboName: "t401",
      comboStrategy: "none",
    });

    expect(tried).toEqual(["revoked/model-a", "alive/model-b"]);
    expect(response.status).toBe(200);
  });

  it("a lone member's 400 keeps its original status and message", async () => {
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["dead/only-member"],
      handleSingleModel: async () => failing(400, "Model is unavailable"),
      log,
      comboName: "t-solo",
      comboStrategy: "none",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    const message = body?.error?.message || body?.error || "";
    expect(message).toBe("Model is unavailable");
  });

  it("all members 400: status preserved, last message plus the tried-trail", async () => {
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["a/one", "b/two"],
      handleSingleModel: async () => failing(400, "Model is unavailable"),
      log,
      comboName: "t-all-4xx",
      comboStrategy: "none",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    const message = body?.error?.message || body?.error || "";
    expect(message).toContain("Model is unavailable");
    expect(message).toContain("a/one:400");
    expect(message).toContain("b/two:400");
  });

  it("does not cool down or lock anything: repeated calls keep trying the same members", async () => {
    const tried = [];
    const run = () => handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["dead/model-a", "alive/model-b"],
      handleSingleModel: async (_body, modelStr) => {
        tried.push(modelStr);
        return modelStr === "dead/model-a" ? failing(400, "Model is unavailable") : ok("alive/model-b");
      },
      log,
      comboName: "t-nocool",
      comboStrategy: "none",
    });

    await run();
    await run();

    expect(tried).toEqual([
      "dead/model-a", "alive/model-b",
      "dead/model-a", "alive/model-b",
    ]);
  });
});
