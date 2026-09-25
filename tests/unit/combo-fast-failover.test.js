// Combo fast failover — end to end against a real local HTTP upstream.
//
// Drives the real combo loop (handleComboChat) + chatCore + DefaultExecutor
// the way src/sse/handlers/chat.js wires them, against a mock provider with
// one failure mode per model. Every scenario is "[broken member, good member]"
// and asserts the client gets the good member's answer, fast.
//
// Measured before this change (same scenarios, production timeouts):
//   503 → 8.2 s (4 calls)   502 → 9.1 s (4 calls)   403 api-key → 3.0 s
//   empty 200 stream / error-in-stream → forwarded to the client, no fallback
//   200 then silence / no headers → stuck > 150 s
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Timeouts are read at import time; shrink them so the hang scenarios are quick.
process.env.COMBO_STREAM_READINESS_TIMEOUT_MS = "400";
process.env.FETCH_CONNECT_TIMEOUT_MS = "400";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9r-combo-failover-"));

const { handleComboChat, resolveMemberDispatchOptions } = await import("open-sse/services/combo.js");
const { handleChatCore } = await import("open-sse/handlers/chatCore.js");

const hits = {};
let server;
let baseUrl;

const chunk = (model, delta) =>
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model, choices: [{ index: 0, delta }] })}\n\n`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let model = "";
      try { model = JSON.parse(raw).model; } catch {}
      hits[model] = (hits[model] || 0) + 1;
      const sse = () => res.writeHead(200, { "content-type": "text/event-stream" });
      const json = (status, message) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message } }));
      };
      switch (model) {
        case "m-ok":
          sse(); res.write(chunk(model, { role: "assistant", content: "" })); res.write(chunk(model, { content: "ok" })); res.end("data: [DONE]\n\n");
          break;
        case "m-slow-ok": // first token after 150 ms — inside the budget, must not be cut
          sse(); res.write(chunk(model, { role: "assistant" }));
          setTimeout(() => { res.write(chunk(model, { content: "hello " })); res.write(chunk(model, { content: "world" })); res.end("data: [DONE]\n\n"); }, 150);
          break;
        case "m-503": json(503, "overloaded"); break;
        case "m-502": json(502, "bad gateway"); break;
        case "m-403": json(403, "Free quota exhausted"); break;
        case "m-empty": sse(); res.write(chunk(model, { role: "assistant", content: "" })); res.end("data: [DONE]\n\n"); break;
        case "m-errstream": sse(); res.end(`data: ${JSON.stringify({ error: { message: "upstream exploded mid-stream" } })}\n\n`); break;
        case "m-stall": sse(); res.write(chunk(model, { role: "assistant" })); break; // headers, then silence
        case "m-hang": break; // never answers
        default: json(404, "unknown model");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

beforeEach(() => { for (const k of Object.keys(hits)) delete hits[k]; });

const provider = "openai-compatible-chat-failovertest";
const log = { info() {}, warn() {}, debug() {}, error() {} };

// Same shape as chat.js: the combo loop owns `attemptUsage`, the member
// handler turns it into dispatch options for chatCore.
async function runCombo(members, { stream = true } = {}) {
  const body = { model: "combo", stream, messages: [{ role: "user", content: "hi" }] };
  const attemptUsage = { comboName: "combo", comboPath: ["combo"] };
  const handleSingleModel = async (b, m) => {
    const model = m.split("/")[1];
    const r = await handleChatCore({
      body: { ...structuredClone(b), model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: { apiKey: "fake", connectionId: "c1", providerSpecificData: { baseUrl } },
      log,
      clientRawRequest: { endpoint: "/v1/chat/completions", body: b, headers: {} },
      connectionId: "c1",
      userAgent: "test",
      ...resolveMemberDispatchOptions(attemptUsage),
    });
    return r.response;
  };
  const t0 = Date.now();
  const res = await handleComboChat({ body, models: members.map((m) => `mock/${m}`), handleSingleModel, log, comboName: "combo", attemptUsage });
  const text = await res.text();
  const content = [...text.matchAll(/"content":"([^"]*)"/g)].map((x) => x[1]).join("");
  return { status: res.status, content, text, ms: Date.now() - t0 };
}

describe("combo fast failover (broken member → good member)", () => {
  it("503: the broken member is called once, not retried", async () => {
    const r = await runCombo(["m-503", "m-ok"]);
    expect(r.content).toBe("ok");
    expect(hits["m-503"]).toBe(1);
    expect(r.ms).toBeLessThan(1500);
  });

  it("502: the broken member is called once, not retried", async () => {
    const r = await runCombo(["m-502", "m-ok"]);
    expect(r.content).toBe("ok");
    expect(hits["m-502"]).toBe(1);
    expect(r.ms).toBeLessThan(1500);
  });

  it("403 on an API-key provider: no refresh backoff", async () => {
    const r = await runCombo(["m-403", "m-ok"]);
    expect(r.content).toBe("ok");
    expect(r.ms).toBeLessThan(1500);
  });

  it("200 with an empty stream falls over instead of answering empty", async () => {
    const r = await runCombo(["m-empty", "m-ok"]);
    expect(r.status).toBe(200);
    expect(r.content).toBe("ok");
  });

  it("an error inside the stream falls over instead of reaching the client", async () => {
    const r = await runCombo(["m-errstream", "m-ok"]);
    expect(r.content).toBe("ok");
    expect(r.text).not.toContain("exploded");
  });

  it("200 then silence falls over once the readiness budget runs out", async () => {
    const r = await runCombo(["m-stall", "m-ok"]);
    expect(r.content).toBe("ok");
    expect(r.ms).toBeLessThan(3000);
  });

  it("an upstream that never sends headers falls over after the connect timeout, once", async () => {
    const r = await runCombo(["m-hang", "m-ok"]);
    expect(r.content).toBe("ok");
    expect(hits["m-hang"]).toBe(1);
    expect(r.ms).toBeLessThan(3000);
  });

  it("a healthy stream is forwarded whole (buffered preamble replayed, nothing lost)", async () => {
    const r = await runCombo(["m-slow-ok", "m-ok"]);
    expect(r.content).toBe("hello world");
    expect(hits["m-ok"]).toBeUndefined();
    expect(r.text).toContain("[DONE]");
  });

  it("non-streaming requests still fail over on 503 without retries", async () => {
    const r = await runCombo(["m-503", "m-ok"], { stream: false });
    expect(r.status).toBe(200);
    expect(hits["m-503"]).toBe(1);
  });
});

describe("resolveMemberDispatchOptions — only a member with a next one to try goes fast", () => {
  it("member with a next member: no upstream retry, short readiness budget", () => {
    expect(resolveMemberDispatchOptions({ hasNextMember: true })).toEqual({ skipUpstreamRetry: true, streamReadinessTimeoutMs: 400 });
  });

  it("last member (or no combo): keeps retries and the default first-chunk budget", () => {
    for (const u of [{ hasNextMember: false }, undefined, null]) {
      const o = resolveMemberDispatchOptions(u);
      expect(o.skipUpstreamRetry).toBe(false);
      expect(o.streamReadinessTimeoutMs).toBeUndefined();
    }
  });

  it("the combo loop flags every member but the last (and inherits a parent's next member)", async () => {
    const seen = [];
    const models = ["a/1", "a/2", "a/3"];
    const fail = () => new Response("{}", { status: 503 });
    const au = { comboName: "c" };
    await handleComboChat({ body: {}, models, log, comboName: "c", attemptUsage: au, handleSingleModel: async () => { seen.push(au.hasNextMember); return fail(); } });
    expect(seen).toEqual([true, true, false]);

    seen.length = 0;
    const nested = { comboName: "inner", parentHasNextMember: true };
    await handleComboChat({ body: {}, models, log, comboName: "inner", attemptUsage: nested, handleSingleModel: async () => { seen.push(nested.hasNextMember); return fail(); } });
    expect(seen).toEqual([true, true, true]);
  });
});
