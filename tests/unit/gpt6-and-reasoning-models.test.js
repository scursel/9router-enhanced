import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { convertResponsesApiFormat } from "../../open-sse/translator/formats/responsesApi.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel, aggregateComboCapabilities } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { detectRequiredCapabilities, handleComboChat, reorderByCapabilities } from "../../open-sse/services/combo.js";
import { ROLE, RESPONSES_ITEM } from "../../open-sse/translator/schema/index.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../../open-sse/config/codexInstructions.js";

const silentLog = { info() {}, warn() {}, debug() {}, error() {} };

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Phase 1: Parameter hygiene and reasoning normalization for OpenAI reasoning models", () => {
  it("strips unsupported sampling params for o1, o3, o4 models", () => {
    const models = ["o1", "o1-mini", "o3", "o3-mini", "o4-mini", "openai/o3-mini"];
    for (const model of models) {
      const body = {
        temperature: 0.7,
        top_p: 0.95,
        presence_penalty: 0.5,
        frequency_penalty: 0.5,
        logprobs: true,
        top_logprobs: 5,
        n: 2,
        seed: 42,
        max_tokens: 1000,
        messages: [{ role: "user", content: "hello" }],
      };

      stripUnsupportedParams("openai", model, body);

      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBeUndefined();
      expect(body.presence_penalty).toBeUndefined();
      expect(body.frequency_penalty).toBeUndefined();
      expect(body.logprobs).toBeUndefined();
      expect(body.top_logprobs).toBeUndefined();
      expect(body.n).toBeUndefined();
      expect(body.seed).toBeUndefined();
      expect(body.max_tokens).toBeUndefined();
      expect(body.max_completion_tokens).toBe(1000);
      expect(body.messages).toHaveLength(1);
    }
  });

  it("renames max_output_tokens to max_completion_tokens for openai provider", () => {
    const body = { max_output_tokens: 500, temperature: 0.8 };
    stripUnsupportedParams("openai", "gpt-6.1-sol", body);
    expect(body.max_completion_tokens).toBe(500);
    expect(body.max_output_tokens).toBeUndefined();
    // Non-o series retains temperature
    expect(body.temperature).toBe(0.8);
  });

  it("keeps the Responses→Chat max_output_tokens → max_tokens mapping for every provider", () => {
    // Production credentials carry no provider field; the translator must not switch
    // non-OpenAI reasoning models (deepseek / glm / kimi) to max_completion_tokens.
    for (const model of ["deepseek-reasoner", "glm-5.1", "kimi-k2.7", "o3-mini"]) {
      const responsesReq = {
        model,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        max_output_tokens: 4096,
      };
      const chatReq = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, model, responsesReq, false, { apiKey: "sk-test" });
      expect(chatReq.max_tokens).toBe(4096);
      expect(chatReq.max_completion_tokens).toBeUndefined();
      expect(chatReq.max_output_tokens).toBeUndefined();
    }
  });

  it("renames to max_completion_tokens only on the openai provider executor hop", () => {
    const chatReq = translateRequest(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, "o3-mini", {
      model: "o3-mini",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      max_output_tokens: 4096,
    }, false, { apiKey: "sk-test" });
    const upstream = new DefaultExecutor("openai").transformRequest("o3-mini", chatReq, false, { apiKey: "sk-test" });
    expect(upstream.max_completion_tokens).toBe(4096);
    expect(upstream.max_tokens).toBeUndefined();

    const deepseek = stripUnsupportedParams("deepseek", "deepseek-reasoner", { max_tokens: 4096 });
    expect(deepseek).toEqual({ max_tokens: 4096 });
  });

  it("matches only the o1 / o3 / o4 families (vendor prefix allowed, trailing boundary)", () => {
    for (const model of ["o3x", "o10", "foo-o3", "openai/gpt-5.5", "gpt-4o"]) {
      const body = { temperature: 0.4, seed: 7 };
      stripUnsupportedParams("openai", model, body);
      expect(body.temperature).toBe(0.4);
      expect(body.seed).toBe(7);
    }
    expect(getThinkingLevels("openai", "openai/o3-mini")).toEqual(["low", "medium", "high"]);
    expect(getThinkingLevels("openai", "o4-mini")).toEqual(["low", "medium", "high"]);
    for (const model of ["openai/gpt-5.5", "openai/gpt-6-sol", "gpt-5.5"]) {
      expect(getThinkingLevels("openai", model)).toContain("minimal");
      expect(getThinkingLevels("openai", model)).toContain("xhigh");
    }
  });

  it("clamps thinking levels to official OpenAI limits (low/medium/high)", () => {
    const supportedLevels = ["low", "medium", "high"];
    const testCases = [
      { input: "minimal", expected: "low" },
      { input: "low", expected: "low" },
      { input: "medium", expected: "medium" },
      { input: "high", expected: "high" },
      { input: "xhigh", expected: "high" },
      { input: "max", expected: "high" },
      { input: "ultra", expected: "high" },
    ];

    for (const { input, expected } of testCases) {
      const body = { reasoning_effort: input };
      const out = applyThinking(FORMATS.OPENAI, "o3-mini", body, "openai");
      expect(out.reasoning_effort).toBe(expected);
    }
  });
});

describe("Phase 1b: o-series \"none\" and non-o OpenAI pass-through", () => {
  it("clamps a thinking-off request to the lowest o-series level instead of sending none", () => {
    for (const model of ["o3", "o3-mini", "openai/o3-mini", "o4-mini"]) {
      const viaEffort = applyThinking(FORMATS.OPENAI, model, { reasoning_effort: "none" }, "openai");
      expect(viaEffort.reasoning_effort).toBe("low");
      const viaSuffix = applyThinking(FORMATS.OPENAI, `${model}(none)`, {}, "openai");
      expect(viaSuffix.reasoning_effort).toBe("low");
    }
  });

  it("keeps none for OpenAI models that can disable thinking", () => {
    const out = applyThinking(FORMATS.OPENAI, "gpt-5.5", { reasoning_effort: "none" }, "openai");
    expect(out.reasoning_effort).toBe("none");
  });

  it("prefixed non-o OpenAI ids keep the previous minimal / xhigh / max behavior", () => {
    for (const model of ["openai/gpt-5.5", "openai/gpt-6-sol", "gpt-5.5"]) {
      expect(applyThinking(FORMATS.OPENAI, model, { reasoning_effort: "minimal" }, "openai").reasoning_effort).toBe("minimal");
      expect(applyThinking(FORMATS.OPENAI, model, { reasoning_effort: "xhigh" }, "openai").reasoning_effort).toBe("xhigh");
      // L.openai has no "max": the pre-existing clamp sends xhigh (not o-series "high").
      expect(applyThinking(FORMATS.OPENAI, model, { reasoning_effort: "max" }, "openai").reasoning_effort).toBe("xhigh");
    }
  });
});

describe("Phase 2: Sequential instruction and system prompt mapping", () => {
  it("concatenates multiple initial system and developer prompts into instructions", () => {
    const chatReq = {
      model: "gpt-6.1-sol",
      messages: [
        { role: "system", content: "Instruction part 1" },
        { role: "developer", content: "Instruction part 2" },
        { role: "system", content: "Instruction part 3" },
        { role: "user", content: "User query" },
      ],
    };

    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-6.1-sol", chatReq);
    expect(out.instructions).toBe("Instruction part 1\n\nInstruction part 2\n\nInstruction part 3");
    expect(out.input).toHaveLength(1);
    expect(out.input[0].role).toBe("user");
    expect(out.input[0].content[0].text).toBe("User query");
  });

  it("preserves mid-conversation developer messages in input rather than dropping them", () => {
    const chatReq = {
      model: "gpt-6.1-sol",
      messages: [
        { role: "system", content: "Base system instructions" },
        { role: "user", content: "Turn 1" },
        { role: "assistant", content: "Response 1" },
        { role: "developer", content: "Mid-turn updated instructions" },
        { role: "user", content: "Turn 2" },
      ],
    };

    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-6.1-sol", chatReq);
    expect(out.instructions).toBe("Base system instructions");
    expect(out.input).toHaveLength(4);
    expect(out.input[0].role).toBe("user");
    expect(out.input[1].role).toBe("assistant");
    expect(out.input[2].type).toBe(RESPONSES_ITEM.MESSAGE);
    expect(out.input[2].role).toBe(ROLE.DEVELOPER);
    expect(out.input[2].content[0].text).toBe("Mid-turn updated instructions");
    expect(out.input[3].role).toBe("user");
  });
});

describe("Phase 3: Extended context variants, capabilities, and pricing", () => {
  it("registers gpt-6.1-sol[1m] and gpt-6.1-terra[1m] with Lite flags and 872k context", () => {
    const codexModels = getModelsByProviderId("codex");

    const sol1m = codexModels.find((m) => m.id === "gpt-6.1-sol[1m]");
    expect(sol1m).toBeDefined();
    expect(sol1m?.upstreamModelId).toBe("gpt-6.1-sol");
    expect(sol1m?.responsesLite).toBe(true);
    expect(sol1m?.thinkingLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);

    const terra1m = codexModels.find((m) => m.id === "gpt-6.1-terra[1m]");
    expect(terra1m).toBeDefined();
    expect(terra1m?.upstreamModelId).toBe("gpt-6.1-terra");
    expect(terra1m?.responsesLite).toBe(true);
    expect(terra1m?.thinkingLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);

    const sol1mCaps = getCapabilitiesForModel("codex", "gpt-6.1-sol[1m]");
    expect(sol1mCaps.contextWindow).toBe(872000);
    expect(sol1mCaps.reasoning).toBe(true);

    const terra1mCaps = getCapabilitiesForModel("codex", "gpt-6.1-terra[1m]");
    expect(terra1mCaps.contextWindow).toBe(872000);
    expect(terra1mCaps.reasoning).toBe(true);
  });

  it("classifies o3-mini as text-only reasoning model (no vision)", () => {
    const o3miniCaps = getCapabilitiesForModel("openai", "o3-mini");
    expect(o3miniCaps.reasoning).toBe(true);
    expect(o3miniCaps.vision).toBe(false);
    expect(o3miniCaps.thinkingFormat).toBe("openai");

    const o3Caps = getCapabilitiesForModel("openai", "o3");
    expect(o3Caps.reasoning).toBe(true);
    expect(o3Caps.vision).toBe(true);
  });

  it("inherits pricing from base models for [1m] and [900k] variants", () => {
    const baseSol = getPricingForModel("codex", "gpt-6.1-sol");
    const sol1m = getPricingForModel("codex", "gpt-6.1-sol[1m]");
    expect(sol1m).toEqual(baseSol);

    const baseTerra = getPricingForModel("codex", "gpt-6.1-terra");
    const terra1m = getPricingForModel("codex", "gpt-6.1-terra[1m]");
    expect(terra1m).toEqual(baseTerra);

    const baseAstra = getPricingForModel("codex", "gpt-6-astra");
    const astra1m = getPricingForModel("codex", "gpt-6-astra[1m]");
    const astra900k = getPricingForModel("codex", "gpt-6-astra-900k");
    expect(astra1m).toEqual(baseAstra);
    expect(astra900k).toEqual(baseAstra);
  });
});

describe("Phase 4: Tool unpacking and reasoning streaming", () => {
  // These cases pin the fork's opt-in layout (system text folded into
  // instructions). The default is upstream's; see codex-system-prompt-layout.test.js.
  const savedLayout = process.env.CODEX_SYSTEM_PROMPT_LAYOUT;
  beforeEach(() => { process.env.CODEX_SYSTEM_PROMPT_LAYOUT = "instructions"; });
  afterEach(() => {
    if (savedLayout === undefined) delete process.env.CODEX_SYSTEM_PROMPT_LAYOUT;
    else process.env.CODEX_SYSTEM_PROMPT_LAYOUT = savedLayout;
  });

  it("merges additional_tools in convertResponsesApiFormat", () => {
    const body = {
      model: "gpt-6.1-sol",
      tools: [{ type: "function", name: "tool1" }],
      input: [
        { type: "additional_tools", tools: [{ type: "function", name: "tool2" }, { type: "function", name: "tool3" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "call tool" }] },
      ],
    };

    const converted = convertResponsesApiFormat(body);
    expect(converted.tools).toEqual([
      { type: "function", name: "tool1" },
      { type: "function", name: "tool2" },
      { type: "function", name: "tool3" },
    ]);
  });

  it("does not duplicate tools already present when merging additional_tools", () => {
    const converted = convertResponsesApiFormat({
      model: "gpt-6.1-sol",
      tools: [{ type: "function", name: "tool1" }],
      input: [
        { type: "additional_tools", tools: [{ type: "function", name: "tool1" }, { type: "function", name: "tool2" }] },
        { type: "additional_tools", tools: [{ type: "function", name: "tool2" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "call tool" }] },
      ],
    });
    expect(converted.tools.map((t) => t.name)).toEqual(["tool1", "tool2"]);
  });

  it("unpacks additional_tools and prefix developer messages for non-Lite Codex models (gpt-6-astra)", () => {
    const executor = new CodexExecutor();
    const tool = { type: "function", name: "fetchData", parameters: { type: "object", properties: {} } };
    const body = {
      model: "gpt-6-astra",
      input: [
        { type: "additional_tools", role: "developer", tools: [tool] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "You are an Astra agent." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
    };

    const transformed = executor.transformRequest("gpt-6-astra", body, true, { connectionId: "cx", accessToken: "t" });
    expect(transformed.tools).toBeDefined();
    expect(transformed.tools?.some((t) => t.name === "fetchData" || t.function?.name === "fetchData")).toBe(true);
    expect(transformed.instructions).toContain("You are an Astra agent.");
    expect(transformed.input.some((item) => item.type === "additional_tools")).toBe(false);
    expect(transformed.input.some((item) => item.role === "developer")).toBe(false);
    expect(transformed.input[0].role).toBe("user");
  });

  it("non-Lite native Codex body keeps the default instructions and appends folded developer text", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "gpt-6-astra",
      instructions: "",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "PERMISSIONS" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
    };
    const out = executor.transformRequest("gpt-6-astra", body, true, { connectionId: "cx", accessToken: "t" });
    expect(out.instructions.startsWith(CODEX_DEFAULT_INSTRUCTIONS)).toBe(true);
    expect(out.instructions.endsWith("\n\nPERMISSIONS")).toBe(true);
    expect(out.input.map((item) => item.role)).toEqual(["user"]);
  });

  it("appends folded developer text to client instructions on any non-Lite model", () => {
    const executor = new CodexExecutor();
    const out = executor.transformRequest("gpt-5.3-codex", {
      model: "gpt-5.3-codex",
      instructions: "BASE",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "PERMS" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    }, true, { connectionId: "cx", accessToken: "t" });
    expect(out.instructions).toBe("BASE\n\nPERMS");
  });

  it("folds a leading system item exactly like a developer item", () => {
    const executor = new CodexExecutor();
    const mk = (role) => executor.transformRequest("gpt-6-astra", {
      model: "gpt-6-astra",
      instructions: "BASE",
      input: [
        { type: "message", role, content: [{ type: "input_text", text: "RULES" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    }, true, { connectionId: "cx", accessToken: "t" });
    const viaSystem = mk("system");
    const viaDeveloper = mk("developer");
    expect(viaSystem.instructions).toBe("BASE\n\nRULES");
    expect(viaSystem.instructions).toBe(viaDeveloper.instructions);
    expect(viaSystem.input).toEqual(viaDeveloper.input);
    expect(viaSystem.input.some((item) => item.role === "system" || item.role === "developer")).toBe(false);
  });

  it("does not drop multimodal developer content and keeps mid-history developer messages in input", () => {
    const executor = new CodexExecutor();
    const image = { type: "input_image", image_url: "https://example.test/diagram.png" };
    const out = executor.transformRequest("gpt-6-astra", {
      model: "gpt-6-astra",
      instructions: "BASE",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "TEXT RULES" }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "see diagram" }, image] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "LATER" }] },
      ],
    }, true, { connectionId: "cx", accessToken: "t" });
    expect(out.instructions).toBe("BASE\n\nTEXT RULES");
    expect(out.input[0].role).toBe("developer");
    expect(out.input[0].content).toEqual([{ type: "input_text", text: "see diagram" }, image]);
    expect(out.input[1].role).toBe("user");
    expect(out.input[2]).toMatchObject({ role: "developer", content: [{ type: "input_text", text: "LATER" }] });
  });

  it("Lite models keep the additional_tools + developer input prefix unchanged", () => {
    const executor = new CodexExecutor();
    const tool = { type: "function", name: "fetchData", parameters: { type: "object", properties: {} } };
    const out = executor.transformRequest("gpt-6.1-sol", {
      model: "gpt-6.1-sol",
      instructions: "BASE",
      tools: [tool],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }, true, { connectionId: "cx", accessToken: "t" });
    expect(out.instructions).toBe("");
    expect(out.tools).toBeNull();
    expect(out.input[0]).toMatchObject({ type: "additional_tools", role: "developer" });
    expect(out.input[1]).toMatchObject({ role: "developer", content: [{ type: "input_text", text: "BASE" }] });
  });

  it("captures response.reasoning_text.delta in stream translator", () => {
    const state = { chatId: "chat-1", created: 12345, model: "o3-mini" };
    const chunk = openaiResponsesToOpenAIResponse(
      { type: "response.reasoning_text.delta", delta: "Let me think about this step by step." },
      state
    );

    expect(chunk).toBeDefined();
    expect(chunk.choices[0].delta.reasoning_content).toBe("Let me think about this step by step.");
  });

  it("captures response.reasoning_summary_text.delta in stream translator", () => {
    const state = { chatId: "chat-2", created: 12345, model: "o3-mini" };
    const chunk = openaiResponsesToOpenAIResponse(
      { type: "response.reasoning_summary_text.delta", delta: "Thinking summary..." },
      state
    );

    expect(chunk).toBeDefined();
    expect(chunk.choices[0].delta.reasoning_content).toBe("Thinking summary...");
  });
});

describe("Combo failover with reasoning models", () => {
  it("aggregates capabilities correctly when a combo contains a reasoning model", () => {
    const comboMembers = ["openai/o3-mini", "openai/gpt-4o"];
    const caps = aggregateComboCapabilities(comboMembers);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("openai");
    expect(caps.contextWindow).toBe(128000);
  });

  it("preserves request body isolation across combo member failover", () => {
    const originalBody = {
      model: "combo-reasoning",
      temperature: 0.7,
      top_p: 0.9,
      messages: [{ role: "user", content: "test query" }],
    };

    // Deep copy simulating what combo executor does before each member attempt
    const attempt1Body = structuredClone(originalBody);
    stripUnsupportedParams("openai", "o3-mini", attempt1Body);

    // Member 1 (o3-mini) had sampling params stripped
    expect(attempt1Body.temperature).toBeUndefined();
    expect(attempt1Body.top_p).toBeUndefined();

    // Member 2 attempt receives a clean isolated clone of the original body
    const attempt2Body = structuredClone(originalBody);
    stripUnsupportedParams("openai", "gpt-4o", attempt2Body);

    // Member 2 (gpt-4o) retains sampling params
    expect(attempt2Body.temperature).toBe(0.7);
    expect(attempt2Body.top_p).toBe(0.9);
    expect(originalBody.temperature).toBe(0.7);
  });

  it("fails over from a 503 on cx/gpt-6.1-sol to a sanitized openai/o3-mini call", async () => {
    const openai = new DefaultExecutor("openai");
    const called = [];
    const clientBody = {
      model: "reasoning-mix",
      temperature: 0.7,
      top_p: 0.9,
      presence_penalty: 0.2,
      max_tokens: 256,
      messages: [{ role: "user", content: "test query" }],
    };

    const res = await handleComboChat({
      body: clientBody,
      models: ["cx/gpt-6.1-sol", "openai/o3-mini"],
      comboName: "reasoning-mix",
      log: silentLog,
      handleSingleModel: async (body, modelStr) => {
        const slash = modelStr.indexOf("/");
        const provider = modelStr.slice(0, slash);
        const model = modelStr.slice(slash + 1);
        // chat.js deep-copies before chatCore; the executor then sanitizes that copy.
        const attempt = { ...structuredClone(body), model: `${provider}/${model}` };
        if (provider === "cx") {
          called.push({ modelStr, temperature: attempt.temperature });
          return jsonResponse(503, { error: { message: "overloaded" } });
        }
        const upstream = openai.transformRequest(model, attempt, false, { apiKey: "sk-test" });
        called.push({
          modelStr,
          model: upstream.model,
          temperature: upstream.temperature,
          top_p: upstream.top_p,
          presence_penalty: upstream.presence_penalty,
          max_tokens: upstream.max_tokens,
          max_completion_tokens: upstream.max_completion_tokens,
        });
        return jsonResponse(200, {
          id: "chatcmpl-o3",
          choices: [{ message: { role: "assistant", content: "ok from o3-mini" } }],
        });
      },
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.choices[0].message.content).toBe("ok from o3-mini");
    expect(called.map((entry) => entry.modelStr)).toEqual(["cx/gpt-6.1-sol", "openai/o3-mini"]);
    expect(called[0].temperature).toBe(0.7);
    expect(called[1]).toMatchObject({
      model: "openai/o3-mini",
      max_completion_tokens: 256,
    });
    expect(called[1].temperature).toBeUndefined();
    expect(called[1].top_p).toBeUndefined();
    expect(called[1].presence_penalty).toBeUndefined();
    expect(called[1].max_tokens).toBeUndefined();
    expect(clientBody.temperature).toBe(0.7);
  });

  it("auto-switches an image request from text-only o3-mini to gpt-6-sol", async () => {
    const imageBody = {
      model: "vision-mix",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "https://example.test/cat.png" } },
        ],
      }],
    };
    const required = detectRequiredCapabilities(imageBody);
    expect(required.has("vision")).toBe(true);
    expect(reorderByCapabilities(["openai/o3-mini", "cx/gpt-6-sol"], required)[0]).toBe("cx/gpt-6-sol");

    const imageCalls = [];
    const imageRes = await handleComboChat({
      body: imageBody,
      models: ["openai/o3-mini", "cx/gpt-6-sol"],
      comboName: "vision-mix",
      log: silentLog,
      handleSingleModel: async (_body, modelStr) => {
        imageCalls.push(modelStr);
        return jsonResponse(200, {
          choices: [{ message: { role: "assistant", content: "a cat" } }],
        });
      },
    });
    expect(imageRes.status).toBe(200);
    expect(imageCalls).toEqual(["cx/gpt-6-sol"]);

    const textCalls = [];
    await handleComboChat({
      body: { model: "vision-mix", messages: [{ role: "user", content: "just text" }] },
      models: ["openai/o3-mini", "cx/gpt-6-sol"],
      comboName: "vision-mix-text",
      log: silentLog,
      handleSingleModel: async (_body, modelStr) => {
        textCalls.push(modelStr);
        return jsonResponse(200, {
          choices: [{ message: { role: "assistant", content: "text ok" } }],
        });
      },
    });
    expect(textCalls).toEqual(["openai/o3-mini"]);
  });
});
