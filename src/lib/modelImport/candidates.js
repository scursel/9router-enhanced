// Builds the importable-model candidate list for a provider: fetches the raw
// model list (from the active connection's /models route, or the static
// suggested-models catalog when there's no connection yet) and hands it to
// Task 1's buildImportCandidates() with the right existingIds/prefixes.
import {
  getProviderConnections,
  getCustomModels,
  getModelAliases,
} from "@/lib/db/index.js";
import {
  AI_PROVIDERS,
  getProviderAlias,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
} from "@/shared/constants/providers";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { buildImportCandidates } from "@/shared/utils/importProviderModels.js";
import { internalBaseUrl, getInternalHeaders } from "./internal.js";

// Custom (openai-compatible-*/anthropic-compatible-*) connections store their
// custom models under the connection's own provider id, not a registry alias
// — everything else uses the registry alias as its storage key.
export function resolveStorageAlias(providerId) {
  return isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId)
    ? providerId
    : getProviderAlias(providerId);
}

export function importPrefixes(providerId) {
  const prefixes = [resolveStorageAlias(providerId), providerId, getProviderAlias(providerId)];
  if (providerId === "qoder" || providerId === "qoder-cn") {
    prefixes.push("qoder-cn", "qoder");
  }
  return [...new Set(prefixes.filter(Boolean))];
}

export async function listImportCandidates(providerId, { fetchImpl = fetch } = {}) {
  const storageAlias = resolveStorageAlias(providerId);
  const prefixes = importPrefixes(providerId);

  const connections = await getProviderConnections({ provider: providerId });
  const activeConnection = connections.find((c) => c.isActive !== false) || null;

  let source = "none";
  let connectionId = null;
  let models = [];

  if (activeConnection) {
    source = "connection";
    connectionId = activeConnection.id;
    const headers = await getInternalHeaders();
    const res = await fetchImpl(`${internalBaseUrl()}/api/providers/${activeConnection.id}/models`, { headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    models = body.models || [];
  } else {
    const fetcher = AI_PROVIDERS[providerId]?.modelsFetcher;
    if (fetcher?.url && fetcher?.type) {
      source = "catalog";
      const params = new URLSearchParams({ url: fetcher.url, type: fetcher.type });
      const res = await fetchImpl(`${internalBaseUrl()}/api/providers/suggested-models?${params}`);
      const body = await res.json().catch(() => ({}));
      models = body.data || [];
    }
  }

  const existingIds = new Set();
  for (const model of getModelsByProviderId(providerId)) {
    if (model?.id) existingIds.add(model.id);
  }

  const customModels = await getCustomModels();
  for (const model of customModels) {
    if (model?.providerAlias === storageAlias && model?.id) existingIds.add(model.id);
  }

  const aliases = await getModelAliases();
  const aliasPrefix = `${storageAlias}/`;
  for (const value of Object.values(aliases)) {
    if (typeof value === "string" && value.startsWith(aliasPrefix)) {
      existingIds.add(value.slice(aliasPrefix.length));
    }
  }

  const candidates = buildImportCandidates({ models, existingIds, prefixes, providerId });

  return { providerId, storageAlias, source, connectionId, candidates };
}
