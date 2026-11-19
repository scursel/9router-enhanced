/**
 * Command Code Web Search helper — supports both:
 *  1. Direct /v1/search & /v1/web/fetch header/parameter helpers
 *  2. Anthropic web_search server tool → Command Code /alpha/web-search
 *
 * Claude Code sends a separate /v1/messages side-query carrying the Anthropic
 * server tool {"type":"web_search_20250305","name":"web_search"} and expects
 * server_tool_use + web_search_tool_result blocks back. /alpha/generate
 * cannot execute server tools, so routing these side-queries to
 * POST /alpha/web-search uses Command Code's dedicated websearch quota without
 * spending chat tokens.
 */
import crypto from "crypto";
import { PROVIDERS } from "../config/providers.js";

export const COMMANDCODE_WEB_SEARCH_URL = "https://api.commandcode.ai/alpha/web-search";
export const COMMANDCODE_WEB_FETCH_URL = "https://api.commandcode.ai/alpha/web-fetch";

const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
const MIN_QUERY = 2;
const DEFAULT_TIMEOUT_MS = 15000;

export const WEB_SEARCH_TOOL_TYPE = /^web_search(_|$)/;

/**
 * Clean auth + CLI identity headers for /alpha/web-search and /alpha/web-fetch.
 * Intentionally omits chat-only headers (x-session-id, x-project-slug, x-taste-learning).
 */
export function buildCommandCodeWebHeaders(apiKey) {
  const staticHeaders = PROVIDERS.commandcode?.headers || {};
  return {
    "Content-Type": "application/json",
    "User-Agent": staticHeaders["User-Agent"] || "cli",
    "x-command-code-version": staticHeaders["x-command-code-version"] || "1.88.5",
    "x-cli-environment": staticHeaders["x-cli-environment"] || "production",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

export function findWebSearchServerTool(tools) {
  if (!Array.isArray(tools)) return null;
  return tools.find((t) => typeof t?.type === "string" && WEB_SEARCH_TOOL_TYPE.test(t.type)) || null;
}

/**
 * Match Claude Code's web_search side-query on structure: declares the server
 * tool and forces it via tool_choice, or sends it as the sole tool.
 */
export function isWebSearchSideQuery(body) {
  const tool = findWebSearchServerTool(body?.tools);
  if (!tool) return null;
  const forced = body?.tool_choice?.name === tool.name;
  if (!forced && body.tools.length !== 1) return null;
  return tool;
}

export function extractSearchQuery(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = typeof m.content === "string"
      ? m.content
      : (Array.isArray(m.content) ? m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "");
    const trimmed = (text || "").trim();
    if (!trimmed) continue;
    const m1 = /web search for the query:\s*([\s\S]+)/i.exec(trimmed)
      || /search (?:the web )?for:?\s*([\s\S]+)/i.exec(trimmed);
    return (m1 ? m1[1] : trimmed).trim();
  }
  return "";
}

export const clampNumResults = (n) =>
  n === undefined || n === null || !Number.isFinite(Number(n))
    ? DEFAULT_RESULTS
    : Math.min(MAX_RESULTS, Math.max(1, Math.round(Number(n))));

export const webSearchUrl = (generateUrl) =>
  generateUrl
    ? String(generateUrl).replace(/\/alpha\/generate\/?$/, "/alpha/web-search")
    : COMMANDCODE_WEB_SEARCH_URL;

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function buildResultParts({ query, results, error }) {
  const toolUseId = `srvtoolu_${crypto.randomBytes(12).toString("hex")}`;
  const messageId = `msg_${crypto.randomBytes(12).toString("hex")}`;

  const resultBlock = error
    ? {
        type: "web_search_tool_result",
        tool_use_id: toolUseId,
        content: { type: "web_search_tool_result_error", error_code: "unavailable" },
      }
    : {
        type: "web_search_tool_result",
        tool_use_id: toolUseId,
        content: (results || []).map((r) => ({
          type: "web_search_result",
          url: r.url,
          title: r.title,
          encrypted_content: r.snippet || "",
          page_age: r.publishedDate || null,
        })),
      };

  const snippets = (!error && (results || []).length)
    ? results
        .map((r, i) => [
          `${i + 1}. ${r.title}`,
          `   ${r.url}`,
          r.snippet ? `   ${r.snippet}` : null,
        ].filter(Boolean).join("\n"))
        .join("\n\n")
    : "";

  return { toolUseId, messageId, resultBlock, snippets };
}

/**
 * Build the Anthropic SSE response Claude Code expects from a server-tool search.
 */
export function buildWebSearchSse({ model, query, results, error }) {
  const { toolUseId, messageId, resultBlock, snippets } = buildResultParts({ query, results, error });
  const TOOL_IDX = snippets ? 1 : 0;

  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    // Emit readable snippets before server_tool_use so Claude Code preserves them.
    ...(snippets ? [
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: snippets } }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    ] : []),
    sse("content_block_start", {
      type: "content_block_start",
      index: TOOL_IDX,
      content_block: { type: "server_tool_use", id: toolUseId, name: "web_search", input: {} },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: TOOL_IDX,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: TOOL_IDX }),
    sse("content_block_start", { type: "content_block_start", index: TOOL_IDX + 1, content_block: resultBlock }),
    sse("content_block_stop", { type: "content_block_stop", index: TOOL_IDX + 1 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
}

/**
 * Build a non-streaming Anthropic Message JSON response for stream:false clients.
 */
export function buildWebSearchJson({ model, query, results, error }) {
  const { toolUseId, messageId, resultBlock, snippets } = buildResultParts({ query, results, error });
  const content = [
    ...(snippets ? [{ type: "text", text: snippets }] : []),
    { type: "server_tool_use", id: toolUseId, name: "web_search", input: { query } },
    resultBlock,
  ];
  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function buildTimeoutSignal(signal, timeoutMs) {
  if (typeof AbortSignal?.timeout !== "function") return signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal?.any === "function") {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  return signal;
}

/**
 * Execute Command Code /alpha/web-search and return raw results + status metadata.
 * Auth/quota failures (401/403/429) expose upstreamStatus so callers can trigger
 * account fallback; other failures surface as error:true for graceful tool error.
 */
export async function executeWebSearch({
  url = COMMANDCODE_WEB_SEARCH_URL,
  headers,
  query,
  numResults,
  allowedDomains,
  blockedDomains,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  if (!query || query.length < MIN_QUERY) {
    return { results: [], error: true, upstreamStatus: null, errorText: "Query too short" };
  }

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query,
        numResults: clampNumResults(numResults),
        ...(allowedDomains?.length ? { allowedDomains } : {}),
        ...(blockedDomains?.length ? { blockedDomains } : {}),
      }),
      signal: buildTimeoutSignal(signal, timeoutMs),
    });
    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      return { results: [], error: true, upstreamStatus: res.status, errorText };
    }
    const json = await res.json().catch(() => null);
    const results = Array.isArray(json?.results) ? json.results : [];
    return { results, error: false, upstreamStatus: res.status, errorText: null };
  } catch (err) {
    return { results: [], error: true, upstreamStatus: null, errorText: err?.message || String(err) };
  }
}

/**
 * Execute Command Code /alpha/web-search and return Anthropic SSE.
 */
export async function runWebSearch(opts) {
  const { results, error } = await executeWebSearch(opts);
  return buildWebSearchSse({ model: opts.model, query: opts.query, results, error });
}
