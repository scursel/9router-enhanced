"use client";

import { useState, useEffect, useCallback } from "react";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { ALIAS_TO_ID } from "@/shared/constants/providers";

// Module cache: one /api/models fetch shared by every useModelCaps instance.
let cache = null; // { byFull, byId } | null
let inflight = null;

function buildMaps(models) {
  const byFull = {};
  const byId = {};
  for (const m of models || []) {
    if (!m.caps) continue;
    if (m.fullModel) byFull[m.fullModel] = m.caps;
    if (m.routedModel) byFull[m.routedModel] = m.caps;
    if (m.model) byId[m.model] = m.caps;
  }
  return { byFull, byId };
}

function loadModelCaps() {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/api/models")
    .then(async (res) => {
      if (!res.ok) throw new Error(`models ${res.status}`);
      const data = await res.json();
      cache = buildMaps(data.models);
      return cache;
    })
    .catch(() => {
      // Keep null so a later mount can retry
      return { byFull: {}, byId: {} };
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// Drop the shared cache and re-fetch /api/models, pushing the fresh result to
// every mounted useModelCaps() instance. Callers (Detect button, model import)
// use this after writing new measured facts so the dashboard reflects them
// without a page reload — piggybacks on the same "customModelChanged" bus the
// hook already listens to below, so a single fetch serves every listener.
export function refreshModelCaps() {
  cache = null;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("customModelChanged"));
  }
  return loadModelCaps();
}

// Resolve caps from a "provider/model" string or a bare model id.
// The seat prefix is a UI alias (ocg, cmc, …); the capability tables are keyed
// by provider id (opencode-go, commandcode, …), so map it before the lookup —
// an unmapped alias falls through to the generic patterns and under-reports
// (e.g. any *claude*haiku* id reads as 200k regardless of the provider entry).
export function resolveCaps(byFull, byId, rawKey) {
  if (typeof rawKey !== "string" || !rawKey) return null;
  // A thinking-level suffix such as "(high)" is not part of the model id, and a
  // bare "gpt-5.6-sol(high)" misses the catalog. Exact matches on the raw key
  // come first so a custom id that legitimately ends in parentheses still wins.
  const key = rawKey.replace(/\([^()]+\)\s*$/, "").trim();
  if (!key) return null;
  if (byFull[rawKey]) return byFull[rawKey];
  if (byFull[key]) return byFull[key];
  const rawBare = rawKey.includes("/") ? rawKey.slice(rawKey.indexOf("/") + 1) : rawKey;
  if (byId[rawBare]) return byId[rawBare];
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  if (byId[bare]) return byId[bare];
  const alias = key.includes("/") ? key.slice(0, key.indexOf("/")) : null;
  const provider = alias ? (ALIAS_TO_ID[alias] || alias) : null;
  const c = getCapabilitiesForModel(provider, bare);
  // Mark estimated so combo aggregation can ignore DEFAULT floors when the
  // server did not publish an explicit catalog/measured source.
  return {
    vision: c.vision,
    search: c.search,
    reasoning: c.reasoning,
    contextWindow: c.contextWindow,
    maxOutput: c.maxOutput,
    contextSource: "estimated",
    maxOutputSource: "estimated",
  };
}

/** Sparse override for combo aggregation: only explicit (non-estimated) limits. */
export function sparseComboCapsOverride(caps) {
  if (!caps || typeof caps !== "object") return null;
  const out = {};
  for (const key of ["vision", "pdf", "audioInput", "videoInput", "imageOutput", "audioOutput", "search", "tools", "reasoning", "thinkingLevels", "thinkingFormat"]) {
    if (caps[key] != null) out[key] = caps[key];
  }
  const explicitContext = caps.contextSource && caps.contextSource !== "estimated"
    && Number.isFinite(caps.contextWindow) && caps.contextWindow > 0;
  const explicitOutput = caps.maxOutputSource && caps.maxOutputSource !== "estimated"
    && Number.isFinite(caps.maxOutput) && caps.maxOutput > 0;
  if (explicitContext) out.contextWindow = caps.contextWindow;
  if (explicitOutput) out.maxOutput = caps.maxOutput;
  return Object.keys(out).length ? out : null;
}

export function useModelCaps() {
  const [byFull, setByFull] = useState(() => cache?.byFull || {});
  const [byId, setById] = useState(() => cache?.byId || {});

  useEffect(() => {
    let alive = true;
    const sync = (maps) => {
      if (alive) { setByFull(maps.byFull); setById(maps.byId); }
    };
    if (cache) {
      sync(cache);
    } else {
      loadModelCaps().then(sync);
    }
    // Custom models change at runtime — drop the shared cache and refetch
    const invalidate = () => {
      cache = null;
      loadModelCaps().then(sync);
    };
    window.addEventListener("customModelChanged", invalidate);
    return () => {
      alive = false;
      window.removeEventListener("customModelChanged", invalidate);
    };
  }, []);

  const getCaps = useCallback(
    (key) => resolveCaps(byFull, byId, key),
    [byFull, byId],
  );

  return { getCaps };
}
