import { makeKv } from "../helpers/kvStore.js";

// Per provider+model facts measured at the provider, which beat the name-based
// estimates in open-sse/providers/capabilities.js:
//   contextWindow  tokens the provider reports for THIS model on THIS provider
//   reasoning      true/false when known
//   contextSource / reasoningSource  "provider" (its /models list) | "tested" (a real probe)
// Written by the import picker (from the provider list) and by the dashboard's
// per-model "Detect" button. key = `${providerAlias}|${modelId}`.
const metaKv = makeKv("modelMeta");

const key = (providerAlias, modelId) => `${providerAlias}|${modelId}`;

export async function getModelMeta() {
  return metaKv.getAll();
}

export async function getModelMetaFor(providerAlias, modelId) {
  return metaKv.get(key(providerAlias, modelId), null);
}

/**
 * Merge known facts; null/undefined fields leave the stored value alone.
 * @param {{contextWindow?: number|null, reasoning?: boolean|null, source: "provider"|"tested"}} facts
 */
export async function setModelMeta(providerAlias, modelId, { contextWindow, reasoning, source } = {}) {
  if (!providerAlias || !modelId) return null;
  const current = (await getModelMetaFor(providerAlias, modelId)) || {};
  const next = { ...current };
  if (Number.isInteger(contextWindow) && contextWindow > 0) {
    next.contextWindow = contextWindow;
    next.contextSource = source;
  }
  if (typeof reasoning === "boolean") {
    next.reasoning = reasoning;
    next.reasoningSource = source;
  }
  if (Object.keys(next).length === Object.keys(current).length
      && next.contextWindow === current.contextWindow && next.reasoning === current.reasoning) {
    return current;
  }
  next.checkedAt = new Date().toISOString();
  await metaKv.set(key(providerAlias, modelId), next);
  return next;
}
