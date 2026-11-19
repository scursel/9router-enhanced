import { afterEach, describe, expect, it, vi } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers.js";
import { buildModelGroups } from "@/shared/utils/selectableModels.js";
import { resolveWebProviderId } from "@/sse/services/webRouting.js";
import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "../../open-sse/handlers/search/normalizers.js";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";
import { buildSystemoneUrl, handleSystemoneCore } from "../../open-sse/handlers/systemoneCore.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { CommandCodeExecutor } from "../../open-sse/executors/commandcode.js";
import {
  isWebSearchSideQuery,
  extractSearchQuery,
  clampNumResults,
  webSearchUrl,
} from "../../open-sse/providers/commandcodeWebSearch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Command Code registry — webSearch, webFetch, and System One (Jev 1.14)", () => {
  const entry = REGISTRY.find((e) => e.id === "commandcode");

  it("declares llm, webSearch, webFetch, and systemone service kinds", () => {
    expect(entry.serviceKinds).toEqual(["llm", "webSearch", "webFetch", "systemone"]);
    expect(AI_PROVIDERS.commandcode?.searchConfig?.baseUrl).toBe("https://api.commandcode.ai/alpha/web-search");
    expect(AI_PROVIDERS.commandcode?.fetchConfig?.baseUrl).toBe("https://api.commandcode.ai/alpha/web-fetch");
    expect(PROVIDER_MEDIA.commandcode?.systemoneConfig?.baseUrl).toBe("https://api.commandcode.ai/provider/v1/systemone");

    expect(getProvidersByKind("webSearch").map((p) => p.id)).toContain("commandcode");
    expect(getProvidersByKind("webFetch").map((p) => p.id)).toContain("commandcode");
    expect(getProvidersByKind("systemone").map((p) => p.id)).toContain("commandcode");
  });

  it("resolves commandcode and cmc aliases for webSearch and webFetch", () => {
    expect(resolveWebProviderId("commandcode", "webSearch")).toEqual({ ok: true, providerId: "commandcode" });
    expect(resolveWebProviderId("cmc", "webSearch")).toEqual({ ok: true, providerId: "commandcode" });
    expect(resolveWebProviderId("cmc/search", "webSearch")).toEqual({ ok: true, providerId: "commandcode" });
    expect(resolveWebProviderId("commandcode", "webFetch")).toEqual({ ok: true, providerId: "commandcode" });
    expect(resolveWebProviderId("cmc/fetch", "webFetch")).toEqual({ ok: true, providerId: "commandcode" });
  });

  it("registers typesafe/jev-1.14.0 and typesafe/jev as systemone models with input-only pricing", () => {
    const byId = Object.fromEntries(entry.models.map((m) => [m.id, m]));
    expect(byId["typesafe/jev-1.14.0"]).toMatchObject({ name: "Jev 1.14", kind: "systemone" });
    expect(byId["typesafe/jev"]).toMatchObject({ name: "Jev (Latest)", kind: "systemone" });

    expect(getPricingForModel("commandcode", "typesafe/jev-1.14.0")).toMatchObject({ input: 0.042, output: 0 });
    expect(getPricingForModel("commandcode", "typesafe/jev")).toMatchObject({ input: 0.042, output: 0 });
  });
});

describe("Command Code WebSearch (/v1/search caller + normalizer)", () => {
  const cfg = { id: "commandcode", ...AI_PROVIDERS.commandcode.searchConfig };

  it("builds POST /alpha/web-search with clamped numResults, domain filters, and CLI headers", () => {
    const req = buildSearchRequest(cfg, {
      query: "commandcode jev 1.14",
      searchType: "web",
      maxResults: 25,
      token: "user_secret_key",
      domainFilter: ["commandcode.ai", "-spam.example"],
    });

    expect(req.url).toBe("https://api.commandcode.ai/alpha/web-search");
    expect(req.init.method).toBe("POST");
    expect(req.init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer user_secret_key",
      "User-Agent": "cli",
      "x-command-code-version": "1.88.5",
      "x-cli-environment": "production",
    });
    expect(JSON.parse(req.init.body)).toEqual({
      query: "commandcode jev 1.14",
      numResults: 10,
      allowedDomains: ["commandcode.ai"],
      blockedDomains: ["spam.example"],
    });
  });

  it("normalizes Command Code search results into unified SearchResult objects", () => {
    const out = normalizeSearchResponse("commandcode", {
      results: [
        {
          title: "Command Code Docs",
          url: "https://commandcode.ai/docs",
          snippet: "System One and Web Search docs",
          publishedDate: "2026-11-01",
        },
      ],
      formatted: "1. Command Code Docs",
    }, "commandcode", "web");

    expect(out.totalResults).toBe(1);
    expect(out.results[0]).toMatchObject({
      title: "Command Code Docs",
      url: "https://commandcode.ai/docs",
      snippet: "System One and Web Search docs",
      published_at: "2026-11-01",
      position: 1,
    });
  });
});

describe("Command Code WebFetch (/v1/web/fetch handler)", () => {
  const fetchCfg = AI_PROVIDERS.commandcode.fetchConfig;

  it("posts to /alpha/web-fetch with CLI headers and truncates content client-side", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      url: "https://example.com/article",
      title: "Example Article",
      content: "0123456789abcdef",
      status: 200,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await handleFetchCore({
      url: "https://example.com/article",
      format: "markdown",
      maxCharacters: 6,
      provider: "commandcode",
      providerConfig: fetchCfg,
      credentials: { apiKey: "user_fetch_key" },
    });

    expect(result.success).toBe(true);
    const [reqUrl, init] = global.fetch.mock.calls[0];
    expect(reqUrl).toBe("https://api.commandcode.ai/alpha/web-fetch");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer user_fetch_key",
      "User-Agent": "cli",
      "x-command-code-version": "1.88.5",
      "x-cli-environment": "production",
    });
    expect(JSON.parse(init.body)).toEqual({ url: "https://example.com/article" });
    expect(result.data).toMatchObject({
      provider: "commandcode",
      url: "https://example.com/article",
      title: "Example Article",
      content: { format: "markdown", text: "012345", length: 6 },
    });
  });

  it("propagates upstream status and error message on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "Forbidden" } }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    )));

    const result = await handleFetchCore({
      url: "https://example.com",
      provider: "commandcode",
      providerConfig: fetchCfg,
      credentials: { apiKey: "bad_key" },
    });

    expect(result).toMatchObject({ success: false, status: 403, error: "Forbidden" });
  });

  it("enforces fetchConfig.maxCharacters when client omits maxCharacters", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      url: "https://example.com/long",
      content: "a".repeat(50),
      status: 200,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await handleFetchCore({
      url: "https://example.com/long",
      provider: "commandcode",
      providerConfig: { ...fetchCfg, maxCharacters: 12 },
      credentials: { apiKey: "user_fetch_key" },
    });

    expect(result.success).toBe(true);
    expect(result.data.content.length).toBe(12);
    expect(result.data.content.text).toBe("a".repeat(12));
  });
});

describe("Command Code System One — JEV 1.14 (/v1/systemone)", () => {
  it("joins custom baseUrl overrides cleanly with /provider/v1/systemone", () => {
    const cfg = PROVIDER_MEDIA.commandcode.systemoneConfig;
    expect(buildSystemoneUrl(undefined, cfg)).toBe("https://api.commandcode.ai/provider/v1/systemone");
    expect(buildSystemoneUrl("https://proxy.example", cfg)).toBe("https://proxy.example/provider/v1/systemone");
    expect(buildSystemoneUrl("https://proxy.example/provider/v1", cfg)).toBe("https://proxy.example/provider/v1/systemone");
    expect(buildSystemoneUrl("https://proxy.example/provider/v1/systemone", cfg)).toBe("https://proxy.example/provider/v1/systemone");
  });

  it("forwards JEV 1.14 decision payload to /provider/v1/systemone with Bearer auth and CLI headers", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      model: "typesafe/jev-1.14.0",
      answers: { urgent: { noul: 0.91 } },
      usage: { input_tokens: 120, output_tokens: 0 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleSystemoneCore({
      body: {
        state: "Checkout service returning 500s for 15 minutes",
        questions: {
          urgent: { type: "noul", instructions: "Does this require immediate escalation?" },
        },
      },
      modelInfo: { provider: "commandcode", model: "typesafe/jev-1.14.0" },
      credentials: { apiKey: "user_jev_key" },
    });

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({ prompt_tokens: 120, completion_tokens: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.commandcode.ai/provider/v1/systemone");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer user_jev_key",
      "User-Agent": "cli",
      "x-command-code-version": "1.88.5",
      "x-cli-environment": "production",
    });
    expect(init.headers["x-opencode-session"]).toBeUndefined();
    expect(JSON.parse(init.body).model).toBe("typesafe/jev-1.14.0");
  });
});

describe("Command Code Claude Code web_search side-query interception", () => {
  it("detects web_search_20250305 side-queries and extracts the query", () => {
    const body = {
      model: "cmc/claude-sonnet-5-5",
      tools: [{ type: "web_search_20250305", name: "web_search", allowed_domains: ["docs.anthropic.com"] }],
      messages: [{ role: "user", content: "Perform a web search for the query: Claude Code MCP" }],
    };
    expect(isWebSearchSideQuery(body)?.name).toBe("web_search");
    expect(extractSearchQuery(body.messages)).toBe("Claude Code MCP");
    expect(clampNumResults(50)).toBe(10);
    expect(clampNumResults(0)).toBe(1);
    expect(clampNumResults(undefined)).toBe(5);
    expect(webSearchUrl("https://api.commandcode.ai/alpha/generate")).toBe("https://api.commandcode.ai/alpha/web-search");
  });

  it("routes _commandCodeWebSearch in CommandCodeExecutor to /alpha/web-search and emits Anthropic SSE", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { title: "Anthropic", url: "https://anthropic.com", snippet: "AI safety company" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const executor = new CommandCodeExecutor();
    const res = await executor.execute({
      model: "claude-sonnet-5-5",
      stream: true,
      credentials: { apiKey: "user_ws_key" },
      fetchImpl: fetchMock,
      body: {
        _commandCodeWebSearch: {
          query: "anthropic",
          model: "claude-sonnet-5-5",
          allowedDomains: ["anthropic.com"],
        },
      },
    });

    expect(res.responseFormat).toBe("claude");
    expect(res.url).toBe("https://api.commandcode.ai/alpha/web-search");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sseText = await res.response.text();
    expect(sseText).toContain('"type":"server_tool_use"');
    expect(sseText).toContain('"type":"web_search_tool_result"');
    expect(sseText).toContain("AI safety company");
  });

  it("returns Anthropic JSON message when _commandCodeWebSearch.stream is false", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { title: "Docs", url: "https://docs.example", snippet: "Non-stream snippet" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const executor = new CommandCodeExecutor();
    const res = await executor.execute({
      model: "claude-sonnet-5-5",
      stream: true,
      credentials: { apiKey: "user_ws_key" },
      fetchImpl: fetchMock,
      body: {
        _commandCodeWebSearch: {
          query: "docs",
          model: "claude-sonnet-5-5",
          stream: false,
        },
      },
    });

    expect(res.responseFormat).toBe("claude");
    expect(res.response.headers.get("content-type")).toContain("application/json");
    const json = await res.response.json();
    expect(json.type).toBe("message");
    expect(json.content.map((b) => b.type)).toEqual(["text", "server_tool_use", "web_search_tool_result"]);
    expect(json.content[0].text).toContain("Non-stream snippet");
  });

  it("propagates 401/429 errors from /alpha/web-search so account fallback can trigger", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));

    const executor = new CommandCodeExecutor();
    const res = await executor.execute({
      model: "claude-sonnet-5-5",
      stream: true,
      credentials: { apiKey: "user_ws_key" },
      fetchImpl: fetchMock,
      body: {
        _commandCodeWebSearch: {
          query: "anthropic",
          model: "claude-sonnet-5-5",
          stream: true,
        },
      },
    });

    expect(res.response.ok).toBe(false);
    expect(res.response.status).toBe(429);
  });
});

describe("UI pickers — curated LLM enabledModels must not hide webSearch/webFetch/systemone", () => {
  const curatedConnection = {
    id: "conn-cmc-1",
    provider: "commandcode",
    isActive: true,
    providerSpecificData: {
      enabledModels: ["claude-sonnet-5-5", "deepseek/deepseek-v4-pro"],
    },
  };

  it("keeps Command Code visible in webSearch and webFetch combo pickers", () => {
    const searchGroups = buildModelGroups({
      connections: [curatedConnection],
      kindFilter: "webSearch",
    });
    expect(searchGroups.commandcode?.models).toEqual([
      { id: "commandcode", name: "Command Code", value: "commandcode" },
    ]);

    const fetchGroups = buildModelGroups({
      connections: [curatedConnection],
      kindFilter: "webFetch",
    });
    expect(fetchGroups.commandcode?.models).toEqual([
      { id: "commandcode", name: "Command Code", value: "commandcode" },
    ]);
  });

  it("keeps Jev 1.14 visible in System One picker when enabledModels only curates LLM models", () => {
    const sysoneGroups = buildModelGroups({
      connections: [curatedConnection],
      kindFilter: "systemone",
    });
    const ids = (sysoneGroups.commandcode?.models || []).map((m) => m.id);
    expect(ids).toContain("typesafe/jev-1.14.0");
    expect(ids).toContain("typesafe/jev");
  });

  it("still applies enabledModels filtering for the LLM picker", () => {
    const llmGroups = buildModelGroups({
      connections: [curatedConnection],
      kindFilter: null,
    });
    const ids = (llmGroups.commandcode?.models || []).map((m) => m.id);
    expect(ids).toEqual(["deepseek/deepseek-v4-pro"]);
  });
});

