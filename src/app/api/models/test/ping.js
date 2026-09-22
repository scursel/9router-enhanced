import { getApiKeys } from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { unwrapClineEnvelope } from "open-sse/shared/clineEnvelope.js";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const CLI_TOKEN_SALT = "9r-cli-auth";
const PROBE_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Kind fallback chain
//
// A model is regularly registered under a kind its provider does not serve on
// that route: an LLM listed on the embedding page, a chat model on the image
// page, a gateway that only exposes chat. The upstream then answers
// "does not support <capability>", which says nothing about whether the model
// works — the probe just used the wrong route. Testing a model must stay a
// normal call to the model, so every declared kind carries an ordered chain and
// the first kind that really answers wins.
//
// Kinds without a dedicated probe here (tts, music, video, webSearch, webFetch,
// imageToText) start at a chat call rather than guessing a route.
// ---------------------------------------------------------------------------
export const KIND_FALLBACK_CHAINS = {
  llm: ["llm", "embedding", "image"],
  embedding: ["embedding", "llm"],
  image: ["image", "llm"],
  stt: ["stt", "llm"],
  // System One answers only on its own decision endpoint — no chat fallback.
  systemone: ["systemone"],
};

const DEFAULT_KIND_CHAIN = ["llm", "embedding", "image"];

// Own-property lookup: a `kind` of "constructor" or "toString" must not walk the
// prototype chain and hand back a function where a chain array is expected.
const PROBED_KINDS = new Set(Object.keys(KIND_FALLBACK_CHAINS));

/**
 * Ordered kinds to try for a declared kind, declared one first.
 * Exported for unit tests.
 */
export function resolveKindChain(kind) {
  const declared = String(kind || "llm").trim().toLowerCase();
  const chain = PROBED_KINDS.has(declared) ? KIND_FALLBACK_CHAINS[declared] : DEFAULT_KIND_CHAIN;
  const candidates = [...new Set([declared, ...chain])].filter((candidate) => PROBED_KINDS.has(candidate));
  return candidates.length > 0 ? candidates : ["llm"];
}

// Capability/route mismatch wording. Only these failures justify spending
// another upstream call on the next kind — auth, quota and server errors would
// fail identically on every route, and retrying them just multiplies the noise.
const CAPABILITY_MISMATCH_PATTERN =
  /does not support|not supported|unsupported|no such (?:endpoint|route|api)|unknown (?:endpoint|route)|method not allowed/i;

/**
 * True when a failed probe means "wrong route for this model" rather than
 * "this connection is broken". Exported for unit tests.
 */
export function isCapabilityMismatch(result) {
  if (!result || result.ok) return false;
  const status = Number(result.status);
  if (status === 405) return true;
  if (status === 401 || status === 403 || status === 429) return false;
  if (status >= 500 && status <= 599) return false;
  return CAPABILITY_MISMATCH_PATTERN.test(String(result.error || ""));
}

function createSilentWavFile() {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const durationMs = 250;
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  return new Blob([buffer], { type: "audio/wav" });
}

async function getInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    apiKey = keys.find((k) => k.isActive !== false)?.key || null;
  } catch {}

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

export async function pingModelByKind(model, kind, baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`) {
  const headers = await getInternalHeaders();
  const start = Date.now();

  if (kind === "embedding") {
    const res = await fetch(`${baseUrl}/api/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: "test" }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }
    const hasEmbedding = Array.isArray(parsed?.data) && parsed.data.length > 0 && Array.isArray(parsed.data[0]?.embedding);
    if (!hasEmbedding) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no embedding data" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "image") {
    const res = await fetch(`${baseUrl}/api/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt: "test" }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const hasImages = Array.isArray(parsed?.data) && parsed.data.length > 0;
    if (!hasImages) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no image data for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "stt") {
    const form = new FormData();
    const sampleAudio = createSilentWavFile();
    form.append("file", sampleAudio, "test.wav");
    form.append("model", model);

    const res = await fetch(`${baseUrl}/api/v1/audio/transcriptions`, {
      method: "POST",
      headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type")),
      body: form,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const text = typeof parsed?.text === "string" ? parsed.text : "";
    if (!text.trim()) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no transcription text for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "systemone") {
    const res = await fetch(`${baseUrl}/api/v1/systemone`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        state: "Customer: I was charged twice for my order this morning.",
        questions: {
          probe: { type: "noul", instructions: "Is the customer reporting a billing problem?" },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const hasAnswers = parsed?.answers && typeof parsed.answers === "object" && Object.keys(parsed.answers).length > 0;
    if (!hasAnswers) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no answers for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  const res = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      // 1024 tokens: reasoning models (ClinePass/kimi-k3, deepseek-v4-pro, etc.) spend
      // their budget on chain-of-thought before emitting an answer. A tiny probe like
      // max_tokens:16 starves the answer and yields a false "no choices" failure.
      // See issue #3010.
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const latencyMs = Date.now() - start;

  const rawText = await res.text().catch(() => "");
  let parsed = null;
  try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

  // Unwrap before the choices checks below. No-op for providers that do not
  // opt in via transport.quirks.clineEnvelope.
  const providerId = resolveProviderId(String(model).split("/")[0]);
  parsed = unwrapClineEnvelope(parsed, providerId);

  if (!res.ok) {
    const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
    return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 500)}` : ""}`, status: res.status };
  }

  const providerStatus = parsed?.status;
  const providerMsg = parsed?.msg || parsed?.message;
  const hasProviderErrorStatus = providerStatus !== undefined
    && providerStatus !== null
    && String(providerStatus) !== "200"
    && String(providerStatus) !== "0";
  if (hasProviderErrorStatus && providerMsg) {
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: `Provider status ${providerStatus}: ${String(providerMsg).slice(0, 240)}`,
    };
  }

  if (parsed?.error) {
    const providerError = parsed?.error?.message || parsed?.error || "Provider returned an error";
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: String(providerError).slice(0, 240),
    };
  }

  const hasChoices = Array.isArray(parsed?.choices) && parsed.choices.length > 0;

  // Soft-pass (issue #3010): a reasoning model may burn its whole budget on
  // chain-of-thought and return finish_reason:"length" with empty content but
  // non-empty reasoning/thinking. That's a successful connection, not a failure.
  const firstChoice = parsed?.choices?.[0] || {};
  const hasReasoning =
    firstChoice.message?.reasoning ||
    firstChoice.message?.reasoning_content ||
    firstChoice.message?.thinking ||
    firstChoice.message?.thinking_content;
  const contentEmpty = !String(firstChoice.message?.content || "").trim();
  if (hasChoices && firstChoice.finish_reason === "length" && contentEmpty && hasReasoning) {
    return { ok: true, latencyMs, error: null, status: res.status, note: "reasoning-only response (length-limited)" };
  }

  if (!hasChoices) {
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: "Provider returned no completion choices for this model",
    };
  }

  return { ok: true, latencyMs, error: null, status: res.status };
}

/**
 * Test a model by trying the declared kind first and then each fallback kind
 * from `resolveKindChain`, stopping at the first decisive answer.
 *
 * A kind that is merely not served on that route (see `isCapabilityMismatch`)
 * is not a verdict on the model, so the next kind runs. Any other failure —
 * bad key, quota, upstream 5xx, empty completion — is decisive and returned as
 * is, exactly like a single-kind probe.
 *
 * The returned object extends the `pingModelByKind` shape with `kind` (the kind
 * that produced the result), `declaredKind`, and `attempts` (one entry per probe
 * tried) so the dashboard can explain what actually happened.
 */
export async function pingModelWithFallback(model, kind, baseUrl) {
  const chain = resolveKindChain(kind);
  const declaredKind = chain[0];
  const attempts = [];
  let firstFailure = null;

  for (const candidate of chain) {
    const result = await pingModelByKind(model, candidate, baseUrl);
    attempts.push({
      kind: candidate,
      ok: result.ok,
      status: result.status ?? null,
      latencyMs: result.latencyMs ?? null,
      error: result.error ?? null,
    });

    if (result.ok) {
      return {
        ...result,
        kind: candidate,
        declaredKind,
        attempts,
        ...(candidate === declaredKind
          ? {}
          : { note: `answered as ${candidate} (declared kind: ${declaredKind})` }),
      };
    }

    if (!firstFailure) firstFailure = result;
    if (!isCapabilityMismatch(result)) {
      return { ...result, kind: candidate, declaredKind, attempts };
    }
  }

  // Every kind was rejected as unsupported. The declared kind's message is the
  // most representative one, so report that and list what else was tried.
  const tried = chain.join(", ");
  return {
    ...firstFailure,
    kind: declaredKind,
    declaredKind,
    attempts,
    error: chain.length > 1 ? `${firstFailure.error} (tried: ${tried})` : firstFailure.error,
  };
}
