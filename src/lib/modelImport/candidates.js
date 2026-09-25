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
import {
  buildImportCandidates,
  stripProviderPrefix,
  LIVE_CATALOG_PROVIDERS,
} from "@/shared/utils/importProviderModels.js";
import { internalBaseUrl, getInternalHeaders } from "./internal.js";

// Fetch an internal API endpoint with auth headers and throw on non-OK response.
async function fetchInternalEndpoint(url, fetchImpl = fetch) {
  const headers = await getInternalHeaders();
  const res = await fetchImpl(url, { headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

// Custom (openai-compatible-*/anthropic-compatible-*) connections store their
// custom models under the connection's own provider id, not a registry alias
// — everything else uses the registry alias as its storage key.
export function resolveStorageAlias(providerId) {
  return isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId)
    ? providerId
    : getProviderAlias(providerId);
}

// Account health values (credentialHealth/tokenHealth) that mean "don't try first".
const UNHEALTHY_STATUSES = new Set(["error", "expired", "unavailable"]);
export const MAX_CONNECTION_ATTEMPTS = 3;

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
  const activeConnections = connections
    .filter((c) => c.isActive !== false)
    // Stable sort: keeps priority order within the healthy and unhealthy groups.
    .sort((a, b) => Number(UNHEALTHY_STATUSES.has(a.testStatus)) - Number(UNHEALTHY_STATUSES.has(b.testStatus)));

  let source = "none";
  let connectionId = null;
  let models = [];
  let warning;

  if (activeConnections.length > 0) {
    source = "connection";
    // Account pools (zed, kimchi) hold 100+ accounts and the first one may have a
    // dead token: /models then answers 200 with an empty list and a warning.
    // Try a few accounts, healthiest first, before calling the provider empty.
    let lastError = null;
    let answered = false;
    for (const conn of activeConnections.slice(0, MAX_CONNECTION_ATTEMPTS)) {
      let body;
      try {
        body = await fetchInternalEndpoint(`${internalBaseUrl()}/api/providers/${conn.id}/models`, fetchImpl);
      } catch (error) {
        lastError = error;
        continue;
      }
      answered = true;
      connectionId = conn.id;
      models = body.models || [];
      warning = models.length > 0 ? undefined : body.warning;
      if (models.length > 0) break;
    }
    if (!answered) throw lastError;
  } else {
    const fetcher = AI_PROVIDERS[providerId]?.modelsFetcher;
    if (fetcher?.url && fetcher?.type) {
      source = "catalog";
      const params = new URLSearchParams({ url: fetcher.url, type: fetcher.type });
      const body = await fetchInternalEndpoint(
        `${internalBaseUrl()}/api/providers/suggested-models?${params}`,
        fetchImpl,
      );
      models = body.data || [];
    }
  }

  const existingIds = new Set();
  for (const model of getModelsByProviderId(providerId)) {
    if (model?.id) existingIds.add(model.id);
  }

  // cursor/zed's provider page shows the live /models list (not the static
  // catalog) as its built-in model list once one is available — fold those
  // same ids into existingIds so they don't show as "new" in the picker.
  if (source === "connection" && LIVE_CATALOG_PROVIDERS.has(providerId)) {
    for (const model of models) {
      const rawId = model?.id || model?.name || model?.model;
      const id = stripProviderPrefix(rawId, prefixes);
      if (id) existingIds.add(id);
    }
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

  return { providerId, storageAlias, source, connectionId, candidates, ...(warning ? { warning } : {}) };
}
