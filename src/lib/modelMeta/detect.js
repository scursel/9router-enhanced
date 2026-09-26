// Dashboard "Detect" for one provider+model: reads the context window from the
// provider's own /models list and finds out whether the model reasons with one
// small real request that asks for reasoning. Results are stored as measured
// facts (modelMetaRepo) and override the name-based estimates.
import { setModelMeta } from "@/lib/db/index.js";
import { listImportCandidates, resolveStorageAlias } from "@/lib/modelImport/candidates.js";
import { internalBaseUrl, getInternalHeaders } from "@/lib/modelImport/internal.js";

const PROBE_TIMEOUT_MS = 60_000;
const PROBE_PROMPT = "What is 17 * 23? Think it through step by step, then reply with the number only.";

function parseJsonBody(text) {
  // Some routes answer a JSON body followed by a stray "data: [DONE]".
  const clean = String(text || "").split("\ndata:")[0].trim();
  try { return JSON.parse(clean); } catch { return null; }
}

/** true when the completion carries reasoning (text or counted reasoning tokens). */
export function responseShowsReasoning(body) {
  const message = body?.choices?.[0]?.message || {};
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) return true;
  if (typeof message.reasoning === "string" && message.reasoning.trim()) return true;
  if (Array.isArray(message.reasoning_details) && message.reasoning_details.length) return true;
  if (Array.isArray(message.content) && message.content.some((p) => p?.type === "thinking" || p?.type === "reasoning")) return true;
  const tokens = body?.usage?.completion_tokens_details?.reasoning_tokens ?? body?.usage?.reasoning_tokens;
  return Number(tokens) > 0;
}

/**
 * One real call with reasoning requested.
 * @returns {{reasoning: boolean|null, status: number|null, error: string|null}}
 *   reasoning null when the call itself failed (unknown, nothing is stored).
 */
export async function probeReasoning(model, { fetchImpl = fetch, baseUrl = internalBaseUrl(), headers } = {}) {
  const hdrs = headers || await getInternalHeaders();
  const call = async (extra) => {
    const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ model, stream: false, max_tokens: 600, messages: [{ role: "user", content: PROBE_PROMPT }], ...extra }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { res, body: parseJsonBody(await res.text()) };
  };
  try {
    let { res, body } = await call({ reasoning_effort: "low" });
    // A model that rejects the reasoning parameter outright does not reason;
    // retry plain so a real outage is still told apart from "no reasoning".
    if (!res.ok && res.status === 400 && /reason|think|effort/i.test(JSON.stringify(body || {}))) {
      ({ res, body } = await call({}));
      if (res.ok) return { reasoning: false, status: res.status, error: null };
    }
    if (!res.ok) {
      const error = body?.error?.message || body?.error || `HTTP ${res.status}`;
      return { reasoning: null, status: res.status, error: String(error).slice(0, 300) };
    }
    return { reasoning: responseShowsReasoning(body), status: res.status, error: null };
  } catch (error) {
    return { reasoning: null, status: null, error: String(error?.message || error).slice(0, 300) };
  }
}

/**
 * @returns {{contextWindow: number|null, reasoning: boolean|null, contextSource: string|null,
 *            reasoningSource: string|null, listed: boolean, probe: object}}
 */
export async function detectModelMeta({ providerId, modelId, deps = {} }) {
  const list = deps.listImportCandidates || listImportCandidates;
  const probe = deps.probeReasoning || probeReasoning;
  const save = deps.setModelMeta || ((...a) => setModelMeta(...a));
  const storageAlias = resolveStorageAlias(providerId);

  let listedContext = null;
  let listedReasoning = null;
  let listed = false;
  try {
    const { candidates } = await list(providerId);
    const hit = (candidates || []).find((c) => c.id === modelId);
    if (hit) {
      listed = true;
      listedContext = hit.contextLength || null;
      listedReasoning = typeof hit.reasoning === "boolean" ? hit.reasoning : null;
    }
  } catch { /* list unavailable: the probe still answers reasoning */ }

  const probeResult = await probe(`${storageAlias}/${modelId}`);

  if (listedContext) await save(storageAlias, modelId, { contextWindow: listedContext, source: "provider" });
  if (typeof probeResult.reasoning === "boolean") {
    await save(storageAlias, modelId, { reasoning: probeResult.reasoning, source: "tested" });
  } else if (typeof listedReasoning === "boolean") {
    await save(storageAlias, modelId, { reasoning: listedReasoning, source: "provider" });
  }

  const reasoning = typeof probeResult.reasoning === "boolean" ? probeResult.reasoning : listedReasoning;
  return {
    contextWindow: listedContext,
    contextSource: listedContext ? "provider" : null,
    reasoning,
    reasoningSource: typeof probeResult.reasoning === "boolean" ? "tested" : (typeof listedReasoning === "boolean" ? "provider" : null),
    listed,
    probe: probeResult,
  };
}
