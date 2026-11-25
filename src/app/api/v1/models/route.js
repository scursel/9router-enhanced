import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelKind } from "@/shared/constants/models";
import {
  ALIAS_TO_ID,
  AI_PROVIDERS,
  FREE_PROVIDERS,
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { getProviderConnections, getCombos, getCustomModels, getModelAliases } from "@/lib/localDb";
import { getModelMeta } from "@/lib/db/repos/modelMetaRepo.js";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { classifyTier } from "@/shared/utils/modelTier.js";
import { getKeyAccessContext, filterModelsListForKey } from "@/sse/services/keyAccess.js";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels } from "open-sse/services/qoderModels.js";
import { resolveCopilotModels } from "open-sse/services/copilotModels.js";
import { resolveClinepassModels, resolveClineModels } from "open-sse/services/clinepassModels.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import { resolveCommandCodeModels } from "open-sse/services/commandcodeModels.js";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { aggregateComboCapabilities, capabilitiesFromServiceKind, getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getCatalogCost, getCatalogLifecycle } from "open-sse/providers/catalogOverride.js";
import { makeComboMemberResolver } from "@/shared/utils/comboMemberResolver";
import { LIVE_CATALOG_PROVIDERS, readListedCapabilities } from "@/shared/utils/importProviderModels";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";

// Qoder shares one live resolver across intl (qoder) and CN (qoder-cn); the
// credentials carry the provider id so qoderModels picks the right region's
// catalog endpoint.
async function resolveQoderLiveModels(conn, provider) {
  const result = await resolveQoderModels({
    provider,
    accessToken: conn.accessToken,
    // PAT (pt-...) connections keep the token in apiKey; without it the live
    // catalog silently fails and /v1/models falls back to the static list.
    apiKey: conn.apiKey,
    refreshToken: conn.refreshToken,
    email: conn.email,
    displayName: conn.displayName,
    providerSpecificData: conn.providerSpecificData || {}
  });
  // IDE-visible catalog only. enable:false entries and the static Sonus/Cantus
  // fallbacks stay routable in chat, but they are not the list the account
  // currently publishes — advertising them is how discontinued models linger.
  const models = Array.isArray(result?.models) ? result.models : [];
  if (!models.length) return null;
  // is_free rides along so classifyTier can mark the promo models (Qwen3.8-Flash,
  // DeepSeek-Flash) as tier "free" — models.dev has no entry for the opaque keys.
  return { models: models.map((m) => ({ id: m.id, name: m.name, is_free: m.is_free === true })) };
}

// Combo seats use UI aliases; the model registry also has transport aliases.
// Capability overrides and catalog limits are keyed by provider id.
const ALIAS_TO_PROVIDER_ID = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
  ),
  ...ALIAS_TO_ID,
};

// Per-provider live model resolvers. Each receives a connection record and
// returns { models: [{ id, name? }, ...] } | null on failure.
// Adding a provider here makes /v1/models prefer the live catalog for it.
//
// LIVE_TIER_PROVIDERS still run on a curated account, where id replacement is
// off, so the curated ids can pick up per-account promo tier. Qoder is also in
// LIVE_CATALOG_PROVIDERS: an uncurated visible listing replaces the static
// registry with the live catalog, and a failed fetch leaves the registry in place.
const LIVE_TIER_PROVIDERS = new Set(["qoder", "qoder-cn"]);

const LIVE_MODEL_RESOLVERS = {
  opencode: async (conn) => {
    try {
      const res = await fetch("https://opencode.ai/zen/v1/models", {
        headers: { "x-opencode-client": "desktop" },
        cache: "no-store",
      });
      if (!res.ok) return null;
      const data = await res.json();
      const raw = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : [];
      const KNOWN_FREE = new Set(["big-pickle"]);
      const DEAD = new Set(["deepseek-v4-flash-free"]);
      const models = raw
        .filter((m) => {
          const id = m?.id || m?.name;
          if (typeof id !== "string") return false;
          return id.endsWith("-free") || KNOWN_FREE.has(id);
        })
        .filter((m) => !DEAD.has(m?.id || m?.name))
        .map((m) => {
          const id = m.id || m.name;
          const caps = {};
          if (m.limit?.context) caps.contextWindow = m.limit.context;
          if (m.limit?.output) caps.maxOutput = m.limit.output;
          if (m.capabilities?.reasoning?.supported) caps.reasoning = true;
          if (m.capabilities?.tools?.supported) caps.tools = true;
          return { id, name: m.name || id, capabilities: Object.keys(caps).length ? caps : undefined };
        });
      return models.length ? { models } : null;
    } catch {
      return null;
    }
  },
  kiro: async (conn) => {
    const result = await resolveKiroModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  qoder: async (conn) => resolveQoderLiveModels(conn, "qoder"),
  "qoder-cn": async (conn) => resolveQoderLiveModels(conn, "qoder-cn"),
  kimchi: async (conn) => {
    const result = await resolveKimchiModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  github: async (conn) => {
    const result = await resolveCopilotModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, {
      log: console,
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          copilotToken: refreshed.copilotToken,
          copilotTokenExpiresAt: refreshed.copilotTokenExpiresAt,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  clinepass: async (conn) => {
    const result = await resolveClinepassModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cline: async (conn) => {
    const result = await resolveClineModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  "grok-cli": async (conn) => {
    const proxy = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
    const result = await resolveGrokCliModels({
      ...conn,
      connectionId: conn.id,
    }, {
      log: console,
      proxyOptions: {
        connectionProxyEnabled: proxy.connectionProxyEnabled === true,
        connectionProxyUrl: proxy.connectionProxyUrl || "",
        connectionNoProxy: proxy.connectionNoProxy || "",
        vercelRelayUrl: proxy.vercelRelayUrl || "",
        strictProxy: proxy.strictProxy === true,
      },
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          ...refreshed,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cursor: async (conn) => {
    const result = await resolveCursorModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  zed: async (conn) => {
    const result = await resolveZedModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    });
    if (!result?.models?.length) return null;
    return {
      models: result.models
        .filter((m) => !m.isDisabled)
        .map((m) => ({
          id: m.id,
          name: m.name,
          capabilities: m.supportsTools ? { tools: true } : undefined,
        })),
    };
  },
  // CommandCode's catalog is public and account-independent, so no per-connection
  // credentials are needed — the connection only has to exist and be active.
  commandcode: async () => {
    const result = await resolveCommandCodeModels();
    if (!result?.models?.length) return null;
    // GET /provider/v1/models?view=client omits System One decision models
    // (typesafe/jev-1.14.0, typesafe/jev), so preserve static non-LLM models
    // from the registry alongside the live chat catalog.
    const staticNonLlm = (PROVIDER_MODELS.commandcode || [])
      .filter((m) => m?.id && m.kind && m.kind !== "llm")
      .map((m) => ({ id: m.id, name: m.name, kind: m.kind }));
    return {
      models: [
        ...result.models.map(({ id, name }) => ({ id, name })),
        ...staticNonLlm,
      ],
    };
  },
};

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

// Header sent by fetchCompatibleModels to detect cross-instance /models fetches
// and break recursive loops between 9router instances connected to each other.
const INTERNAL_MODELS_FETCH_HEADER = "x-9r-internal-models-fetch";

// LLM kind sentinel — combos/models with no explicit kind default to LLM
const LLM_KIND = "llm";

// Map per-model `type` field (in PROVIDER_MODELS) to service kind.
// Models without `type` are treated as LLM.
const MODEL_TYPE_TO_KIND = {
  image: "image",
  tts: "tts",
  embedding: "embedding",
  stt: "stt",
  imageToText: "imageToText",
  video: "video",
  systemone: "systemone",
};

function modelKind(model) {
  const k = model?.kind || model?.type;
  if (!k) return LLM_KIND;
  return MODEL_TYPE_TO_KIND[k] || LLM_KIND;
}

// For dynamic/unknown model IDs (compatible providers, alias map, custom models)
// fall back to provider-level kind matching when per-model type is unavailable.
function inferKindFromUnknownModelId(modelId) {
  const lower = String(modelId).toLowerCase();
  if (/embed/.test(lower)) return "embedding";
  if (/tts|speech|audio|voice/.test(lower)) return "tts";
  if (/image|imagen|dall-?e|flux|sdxl|sd-|stable-diffusion/.test(lower)) return "image";
  return LLM_KIND;
}

// models.dev lifecycle read, fail-open on purpose: test harnesses partially
// mock catalogOverride (a missing export throws on access), and a catalog file
// written before the lifecycle section existed simply has no data — in either
// case the feed abstains: everything stays listed, un-annotated.
function catalogLifecycleFor(providerId, modelId) {
  try {
    return getCatalogLifecycle(providerId, modelId);
  } catch {
    return null;
  }
}

async function fetchCompatibleModels(connection) {
  if (!connection?.apiKey) return [];

  const baseUrl = typeof connection?.providerSpecificData?.baseUrl === "string"
    ? connection.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
    : "";

  if (!baseUrl) return [];

  let url = `${baseUrl}/models`;
  const headers = {
    "Content-Type": "application/json",
  };

  if (isOpenAICompatibleProvider(connection.provider)) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else if (isAnthropicCompatibleProvider(connection.provider)) {
    if (url.endsWith("/messages/models")) {
      url = url.slice(0, -9);
    } else if (url.endsWith("/messages")) {
      url = `${url.slice(0, -9)}/models`;
    }
    headers["x-api-key"] = connection.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else {
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: "GET",
      headers: { ...headers, [INTERNAL_MODELS_FETCH_HEADER]: "1" },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) return [];

    const data = await response.json();
    const rows = parseOpenAIStyleModels(data);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

// Provider matches kindFilter when its serviceKinds intersect the requested kinds.
// LLM is the default kind for providers missing serviceKinds.
function providerMatchesKinds(providerId, kindFilter) {
  const provider = AI_PROVIDERS[providerId];
  const kinds = Array.isArray(provider?.serviceKinds) && provider.serviceKinds.length > 0
    ? provider.serviceKinds
    : [LLM_KIND];
  return kindFilter.some((k) => kinds.includes(k));
}

// Combo matches kindFilter when its `kind` field is in the list.
// Combos with no kind are treated as LLM.
function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

// Discovery scope. "visible" (the /v1/models default) advertises what each
// provider page shows under its models — the built-in list minus disabled ids
// (live list only where the page shows it live), curated enabledModels,
// custom models and aliases — plus the combos. "all" also lists every id an
// account's synced catalogue, a live resolver or a compatible node's own
// /models reports: hundreds per aggregator, almost none of them curated, but
// tooling that audits routability (combo pruner, reconcilers) needs them.
// (Upstream v0.5.95 also publishes combo context/max-output limits here via
// comboSeatLimits(); our aggregateComboCapabilities already does that with a
// richer resolver — custom connection prefixes + model aliases — so the fork
// block below is kept and upstream's static-seat helpers are not ported.)
export const MODELS_SCOPE_VISIBLE = "visible";
export const MODELS_SCOPE_ALL = "all";

export function modelsScopeFromRequest(request) {
  const url = request?.nextUrl || (request?.url ? new URL(request.url) : null);
  return url?.searchParams?.get("scope") === MODELS_SCOPE_ALL ? MODELS_SCOPE_ALL : MODELS_SCOPE_VISIBLE;
}

/**
 * Build OpenAI-format models list filtered by service kinds.
 * @param {string[]} kindFilter - List of service kinds to include (e.g. ["llm"], ["webSearch","webFetch"]).
 * @param {{ scope?: "visible"|"all", skipDynamicFetch?: boolean }} [options] - scope defaults to "all".
 */
export async function buildModelsList(kindFilter, options = {}) {
  const includeCatalog = options.scope !== MODELS_SCOPE_VISIBLE;
  // When this header is present, the /v1/models request came from another
  // 9router instance's fetchCompatibleModels — skip dynamic fetch to break
  // cross-instance recursive loops.
  const skipDynamicFetch = options.skipDynamicFetch === true;
  let connections = [];
  try {
    connections = await getProviderConnections();
    connections = connections.filter(c => c.isActive !== false);
  } catch (e) {
    console.log("Could not fetch providers, returning all models");
  }

  let combos = [];
  try {
    combos = await getCombos();
  } catch (e) {
    console.log("Could not fetch combos");
  }

  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch (e) {
    console.log("Could not fetch custom models");
  }

  let modelAliases = {};
  try {
    modelAliases = await getModelAliases();
  } catch (e) {
    console.log("Could not fetch model aliases");
  }

  let disabledByAlias = {};
  try {
    disabledByAlias = await getDisabledModels();
  } catch (e) {
    console.log("Could not fetch disabled models");
  }
  const isDisabled = (alias, modelId) => Array.isArray(disabledByAlias[alias]) && disabledByAlias[alias].includes(modelId);

  const connectionsByProvider = new Map();
  const activeConnectionByProvider = new Map();
  for (const conn of connections) {
    if (!conn?.provider) continue;
    if (!connectionsByProvider.has(conn.provider)) connectionsByProvider.set(conn.provider, []);
    connectionsByProvider.get(conn.provider).push(conn);
    if (!activeConnectionByProvider.has(conn.provider)) activeConnectionByProvider.set(conn.provider, conn);
  }

  // Include no-auth free providers (e.g. opencode) so their models are exposed in /v1/models
  for (const [id, provider] of Object.entries(FREE_PROVIDERS || {})) {
    if (provider?.noAuth && !activeConnectionByProvider.has(id)) {
      activeConnectionByProvider.set(id, {
        id: "noauth",
        provider: id,
        isActive: true,
      });
    }
  }

  const models = [];
  // Only LLM combos are nestable targets: a web combo answers a different kind
  // of request and has no member limits to inherit.
  const comboMembersByName = {};
  for (const combo of combos) {
    if (typeof combo?.name !== "string") continue;
    if ((combo.kind || LLM_KIND) !== LLM_KIND) continue;
    if (!(combo.name in comboMembersByName)) comboMembersByName[combo.name] = combo.models || [];
  }
  const resolveComboMember = makeComboMemberResolver(connections, modelAliases);

  const comboProviders = new Set(Object.values(comboMembersByName).flat()
    .filter((member) => typeof member === "string" && member.trim())
    .map((member) => resolveComboMember(member.trim())?.provider));
  const providerMetadata = new Map();
  let modelMeta = {};
  try {
    modelMeta = await getModelMeta();
  } catch (error) {
    console.log("Could not fetch measured model metadata:", error.message);
  }
  const resolveComboCaps = (_member, { provider, model }, defaults) => {
    const measured = providerMetadata.get(provider)?.(model);
    const caps = { ...defaults, ...measured };
    return { ...measured, thinkingLevels: getThinkingLevels(provider, model, caps) };
  };

  if (connections.length === 0) {
    // DB unavailable -> return static models, filtered by per-model kind
    for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
      const providerId = ALIAS_TO_PROVIDER_ID[alias] || alias;
      if (!providerMatchesKinds(providerId, kindFilter)) continue;
      for (const model of providerModels) {
        if (!kindFilter.includes(modelKind(model))) continue;
        if (isDisabled(alias, model.id) || isDisabled(providerId, model.id)) continue;
        // No connections at all -> no live account evidence to contradict the
        // models.dev feed, so a retired/EOL id in the hand-written table stops
        // being advertised without anyone committing the removal (T-D).
        const lifecycle = catalogLifecycleFor(providerId, model.id);
        if (lifecycle === "retired") continue;
        const entry = {
          id: `${alias}/${model.id}`,
          object: "model",
          owned_by: alias,
          capabilities: getCapabilitiesForModel(alias, model.id),
        };
        if (lifecycle) entry.lifecycle = lifecycle;
        models.push(entry);
      }
    }

    for (const customModel of customModels) {
      if (!customModel?.id || (customModel.type && customModel.type !== "llm")) continue;
      // Custom models without active connection are LLM-only by current schema
      if (!kindFilter.includes(LLM_KIND)) continue;
      const providerAlias = customModel.providerAlias;
      if (!providerAlias) continue;

      const modelId = String(customModel.id).trim();
      if (!modelId) continue;

      models.push({
        id: `${providerAlias}/${modelId}`,
        object: "model",
        owned_by: providerAlias,
      });
    }
  } else {
    for (const [providerId, conn] of activeConnectionByProvider.entries()) {
      if (!providerMatchesKinds(providerId, kindFilter)) continue;

      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = (
        conn?.providerSpecificData?.prefix
        || getProviderAlias(providerId)
        || staticAlias
      ).trim();
      const providerModels = PROVIDER_MODELS[staticAlias] || [];
      const isCompatibleProvider =
        isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      // Build kind lookup for static models so we can filter even when only IDs are exposed
      const staticModelKindById = new Map(
        providerModels.map((m) => [m.id, modelKind(m)])
      );
      let liveModelKindById = new Map();
      let liveCapabilitiesById = new Map();
      let liveTierById = new Map();

      // Multi-account union for enabledModels (docs/MODEL_SYNC_CATALOG.md):
      // the curated list is stored PER ACCOUNT, but discovery answers for the
      // whole provider, so EVERY active connection contributes its curated ids
      // — the provider advertises a curated model while any account that
      // lists it has not confirmed it gone. Within one account the synced
      // catalogue still decides status: `unavailable` removes the id from
      // that account's contribution, `temporarily-absent` keeps it (one
      // absence is not removal).
      const providerConnections = connectionsByProvider.get(providerId) || [];
      const stripProviderPrefix = (modelId) => {
        if (modelId.startsWith(`${outputAlias}/`)) return modelId.slice(outputAlias.length + 1);
        if (modelId.startsWith(`${staticAlias}/`)) return modelId.slice(staticAlias.length + 1);
        if (modelId.startsWith(`${providerId}/`)) return modelId.slice(providerId.length + 1);
        return modelId;
      };
      const accountViews = providerConnections.map((c) => {
        const raw = c?.providerSpecificData?.enabledModels;
        const enabled = Array.isArray(raw)
          ? raw
              .filter((id) => typeof id === "string" && id.trim() !== "")
              .map((id) => id.trim())
          : [];
        const catalogModels = Array.isArray(c?.modelCatalog?.models) ? c.modelCatalog.models : [];
        const available = new Set();
        const unavailable = new Set();
        for (const model of catalogModels) {
          const id = typeof model?.id === "string" && model.id.trim() !== ""
            ? stripProviderPrefix(model.id.trim())
            : null;
          if (!id) continue;
          if (model.availability === "unavailable") {
            if (!available.has(id)) unavailable.add(id);
          } else {
            available.add(id);
            unavailable.delete(id);
          }
        }
        return { enabled, available, unavailable, hasCatalog: catalogModels.length > 0 };
      });
      // Live account evidence for the models.dev lifecycle (T-D): every id at
      // least one account's synced catalogue still lists (anything but
      // `unavailable` counts, including temporarily-absent) OR any active
      // account curates in its enabledModels (F35, REV-B nit 3). The feed may
      // hide a model, but never one an account still claims — symmetric with
      // the "missing from 2 syncs" rule. Gateway-prefixed catalogue ids also
      // match on their last segment.
      const accountListedIds = new Set();
      const addLiveEvidence = (rawIds) => {
        for (const raw of rawIds || []) {
          if (typeof raw !== "string" || raw.trim() === "") continue;
          const id = stripProviderPrefix(raw.trim());
          if (!id) continue;
          accountListedIds.add(id);
          if (id.includes("/")) accountListedIds.add(id.split("/").pop());
        }
      };
      for (const view of accountViews) {
        addLiveEvidence(view.available);
        // F35 (REV-B nit 3): a curated enabledModels id is listing evidence
        // even without a synced catalogue — revoked only by that SAME
        // account's own `unavailable` entry, the same exclusion the curated
        // union below applies. Conservative rule intact: feed retired +
        // NO account listing it = still hidden.
        addLiveEvidence(view.enabled.filter((id) => !view.unavailable.has(stripProviderPrefix(id))));
      }
      const hasExplicitEnabledModels = accountViews.some((v) => v.enabled.length > 0);

      let rawModelIds;
      if (hasExplicitEnabledModels) {
        const added = new Set();
        rawModelIds = [];
        const pushCurated = (modelId) => {
          const key = stripProviderPrefix(modelId);
          if (!key || added.has(key)) return;
          added.add(key);
          rawModelIds.push(modelId);
        };
        for (const view of accountViews) {
          if (view.enabled.length > 0) {
            for (const modelId of view.enabled) {
              if (view.unavailable.has(stripProviderPrefix(modelId))) continue;
              pushCurated(modelId);
            }
          } else if (view.hasCatalog) {
            // Sibling account without curation: its synced catalogue is its
            // own list of available models, so it joins the union too.
            for (const modelId of view.available) pushCurated(modelId);
          }
          // An account with neither curated ids nor a synced catalogue lists
          // nothing of its own — it must not resurrect ids the others curated
          // away, and it must not hide the others' (static seed is a
          // per-provider fallback for the no-data case below, not evidence).
        }
        // Curated enabledModels come from the LLM provider page; preserve static
        // non-LLM models (e.g. systemone/Jev) when requested by kindFilter and
        // none of the curated IDs belong to that kind.
        for (const reqKind of kindFilter) {
          if (reqKind === LLM_KIND) continue;
          const hasCuratedOfKind = rawModelIds.some(
            (id) => staticModelKindById.get(stripProviderPrefix(id)) === reqKind
          );
          if (!hasCuratedOfKind) {
            for (const m of providerModels) {
              if (m?.id && modelKind(m) === reqKind) pushCurated(m.id);
            }
          }
        }
      } else {
        rawModelIds = providerModels.map((model) => model.id);
      }

      // Account catalogues are authoritative when a provider publishes /models.
      // Unlike the static seed they can add new provider models without a
      // 9Router release. The union across every active account of this
      // provider decides: a model stays advertised while any account still
      // lists it as available (removal needs two consecutive confirmed
      // absences per account — see connectionCatalog.js). Entries retained
      // only for audit stay out of discovery, but remain in stored combos.
      const syncedModels = (connectionsByProvider.get(providerId) || [])
        .flatMap((c) => (Array.isArray(c?.modelCatalog?.models) ? c.modelCatalog.models : []));
      const tierById = new Map();
      const tierPricingById = new Map();
      const syncedKindById = new Map();
      // Tier/kind/pricing enrichment from the synced catalogues runs for both
      // modes: even when an account curated its ids, the catalogue entries
      // are the authoritative source for tier and service kind (a synced
      // non-LLM kind must not leak into the chat list).
      for (const model of syncedModels) {
        const modelId = model?.id;
        if (typeof modelId !== "string" || modelId.trim() === "") continue;
        const incomingTier = typeof model?.tier === "string" ? model.tier : null;
        const storedTier = tierById.get(modelId);
        // Merge policy: free wins over everything; paid/credits overwrite
        // unknown; never downgrade free to paid/credits/unknown.
        const shouldTakeTier = incomingTier && (
          !storedTier
          || incomingTier === "free"
          || (storedTier === "unknown" && incomingTier !== "unknown")
        );
        if (shouldTakeTier) {
          tierById.set(modelId, incomingTier);
          if (model?.pricing) tierPricingById.set(modelId, model.pricing);
          else tierPricingById.delete(modelId);
          if (model?.kind) syncedKindById.set(modelId, model.kind);
        }
      }
      if (includeCatalog && !hasExplicitEnabledModels && syncedModels.length > 0) {
        const added = new Set();
        rawModelIds = [];
        for (const model of syncedModels) {
          const modelId = model?.id;
          if (typeof modelId !== "string" || modelId.trim() === "") continue;
          if (model?.availability === "unavailable") continue;
          if (added.has(modelId)) continue;
          added.add(modelId);
          rawModelIds.push(modelId);
        }
      }
      const hasSyncedModels = syncedModels.length > 0;

      // Compatible nodes used by a combo can lack a sync catalog (e.g. a
      // local server). Reuse direct discovery for metadata in visible scope.
      const listedById = new Map();
      if (isCompatibleProvider && !skipDynamicFetch && (
        (includeCatalog && rawModelIds.length === 0)
        || (!hasSyncedModels && comboProviders.has(providerId))
      )) {
        const listed = await fetchCompatibleModels(conn);
        for (const row of listed) {
          const id = row?.id || row?.name || row?.model;
          if (typeof id === "string" && id.trim()) listedById.set(stripProviderPrefix(id.trim()), row);
        }
        if (includeCatalog && rawModelIds.length === 0) {
          rawModelIds = [...listedById.keys()];
          addLiveEvidence(rawModelIds);
        }
      }

      const syncedById = new Map();
      for (const account of providerConnections) {
        const rows = account.modelCatalog?.models;
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          if (typeof row?.id !== "string" || row.availability === "unavailable") continue;
          const id = stripProviderPrefix(row.id);
          const timestamp = Date.parse(account.modelCatalog.lastSuccessAt) || 0;
          if (!syncedById.has(id) || timestamp > syncedById.get(id).timestamp) {
            syncedById.set(id, { row, timestamp });
          }
        }
      }

      const customById = new Map(customModels
        .filter((model) => model?.id && (!model.type || model.type === "llm" || model.type === "imageToText")
          && [providerId, staticAlias, outputAlias].includes(model.providerAlias))
        .map((model) => [model.id, model]));
      const readMetadata = (modelId) => {
        const custom = customById.get(modelId);
        const upstreamId = custom?.upstreamModelId || modelId;
        const facts = { ...custom?.caps };
        const measurements = [];
        // Apply upstream facts to custom variants, then take the latest
        // persisted measurement for each field. A current listing wins.
        for (const id of new Set([modelId, upstreamId])) {
          for (const alias of new Set([outputAlias, staticAlias, getProviderAlias(providerId), providerId])) {
            const meta = modelMeta[`${alias}|${id}`];
            if (!meta) continue;
            measurements.push({
              timestamp: Date.parse(meta.checkedAt) || 0,
              caps: { contextWindow: meta.contextWindow, reasoning: meta.reasoning },
            });
          }
        }
        const synced = syncedById.get(upstreamId) || syncedById.get(modelId);
        if (synced) measurements.push({
          timestamp: synced.timestamp,
          caps: { ...synced.row.capabilities, contextWindow: synced.row.contextLength ?? synced.row.capabilities?.contextWindow },
        });
        for (const { caps } of measurements.sort((a, b) => a.timestamp - b.timestamp)) {
          applyFacts(caps);
        }
        const live = listedById.get(upstreamId) || listedById.get(modelId);
        if (live) applyFacts({
          ...readListedCapabilities(live),
          contextWindow: Number(live.context_length ?? live.contextLength ?? live.capabilities?.contextWindow),
        });
        return facts;

        function applyFacts({ contextWindow, reasoning, ...caps }) {
          Object.assign(facts, caps);
          if (Number.isInteger(contextWindow) && contextWindow > 0) facts.contextWindow = contextWindow;
          if (typeof reasoning === "boolean") facts.reasoning = reasoning;
        }
      };
      providerMetadata.set(providerId, readMetadata);

      // Config-driven live catalog override (e.g. Kiro returns dynamic
      // -thinking/-agentic variants per account). On failure, fall back to
      // whatever rawModelIds already holds.
      const liveResolver = LIVE_MODEL_RESOLVERS[providerId];
      // Curated enabledModels decide which ids are advertised, but they carry no
      // pricing — a tier-only provider still needs its live catalog to tier the
      // curated ids. So curation gates the id replacement, not the resolver.
      const liveReplacesIds =
        !hasExplicitEnabledModels && (includeCatalog || LIVE_CATALOG_PROVIDERS.has(providerId));
      if (liveResolver && (liveReplacesIds || LIVE_TIER_PROVIDERS.has(providerId))) {
        try {
          const live = await liveResolver(conn);
          if (live?.models?.length) {
            if (liveReplacesIds) {
              rawModelIds = live.models.map((m) => m.id);
              addLiveEvidence(rawModelIds);
              liveModelKindById = new Map(
                live.models
                  .filter((m) => m?.id)
                  .map((m) => [m.id, modelKind(m)])
              );
              liveCapabilitiesById = new Map(
                live.models
                  .filter((m) => m?.id && m.capabilities)
                  .map((m) => [m.id, m.capabilities])
              );
            }
            // Only a positive classification is kept — "unknown" must not
            // shadow the models.dev cost fallback further down.
            liveTierById = new Map(
              live.models
                .filter((m) => m?.id)
                .map((m) => [m.id, classifyTier(m, { providerId }).tier])
                .filter(([, tier]) => tier && tier !== "unknown")
            );
          }
        } catch (err) {
          console.log(`Live model fetch failed for ${providerId}: ${err?.message || err}`);
        }
      }

      const modelIds = rawModelIds
        .map((modelId) => {
          if (modelId.startsWith(`${outputAlias}/`)) {
            return modelId.slice(outputAlias.length + 1);
          }
          if (modelId.startsWith(`${staticAlias}/`)) {
            return modelId.slice(staticAlias.length + 1);
          }
          if (modelId.startsWith(`${providerId}/`)) {
            return modelId.slice(providerId.length + 1);
          }
          return modelId;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const customModelKindById = new Map();
      const customModelIds = customModels
        .filter((m) => {
          if (!m?.id) return false;
          const kind = getModelKind(m) || LLM_KIND;
          // imageToText custom models are vision-capable chat models: expose them
          // both in the default LLM list and in /v1/models/image-to-text.
          if (!kindFilter.includes(kind) && !(kind === "imageToText" && kindFilter.includes(LLM_KIND))) return false;
          const alias = m.providerAlias;
          return alias === staticAlias || alias === outputAlias || alias === providerId;
        })
        .map((m) => {
          const modelId = String(m.id).trim();
          if (modelId) customModelKindById.set(modelId, getModelKind(m) || LLM_KIND);
          return modelId;
        })
        .filter((modelId) => modelId !== "");

      const aliasModelIds = Object.values(modelAliases || {})
        .filter((fullModel) => {
          if (typeof fullModel !== "string" || !fullModel.includes("/")) return false;
          return (
            fullModel.startsWith(`${outputAlias}/`) ||
            fullModel.startsWith(`${staticAlias}/`) ||
            fullModel.startsWith(`${providerId}/`)
          );
        })
        .map((fullModel) => {
          if (fullModel.startsWith(`${outputAlias}/`)) {
            return fullModel.slice(outputAlias.length + 1);
          }
          if (fullModel.startsWith(`${staticAlias}/`)) {
            return fullModel.slice(staticAlias.length + 1);
          }
          if (fullModel.startsWith(`${providerId}/`)) {
            return fullModel.slice(providerId.length + 1);
          }
          return fullModel;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const mergedModelIds = Array.from(new Set([...modelIds, ...customModelIds, ...aliasModelIds]));
      // Custom and alias ids are the user's own curation — the feed never
      // gets to revoke them, only models the tables/syncs advertise.
      const userDeclaredIds = new Set([...customModelIds, ...aliasModelIds]);

      for (const modelId of mergedModelIds) {
        // Resolve kind: prefer custom/live/synced metadata, then static, then ID heuristics.
        // Synced non-LLM kinds (embedding/tts/image) must never leak into the chat list.
        const customKind = customModelKindById.get(modelId);
        const liveKind = liveModelKindById.get(modelId);
        const syncedKind = hasSyncedModels ? syncedKindById.get(modelId) : null;
        const kind = customKind || liveKind || syncedKind || staticModelKindById.get(modelId) || inferKindFromUnknownModelId(modelId);
        // imageToText custom models stay in the LLM list (vision-capable chat models)
        const allowAsLlm = kind === "imageToText" && kindFilter.includes(LLM_KIND);
        if (!kindFilter.includes(kind) && !allowAsLlm) continue;
        if (isDisabled(outputAlias, modelId) || isDisabled(staticAlias, modelId) || isDisabled(providerId, modelId)) continue;
        // models.dev lifecycle (T-D): retired/EOL is not advertised — but only
        // while no live account evidence contradicts the feed, and never for a
        // user-declared id. deprecated/alpha/beta keep working and gain the
        // `lifecycle` metadata instead of silent removal.
        const lifecycle = catalogLifecycleFor(providerId, modelId);
        if (lifecycle === "retired" && !userDeclaredIds.has(modelId)
          && !accountListedIds.has(modelId)
          && !accountListedIds.has(modelId.includes("/") ? modelId.split("/").pop() : modelId)) {
          continue;
        }
        const model = {
          id: `${outputAlias}/${modelId}`,
          object: "model",
          owned_by: outputAlias,
        };
        // Live-catalog resolvers (kiro/qoder/github/clinepass) mostly only return
        // { id, name } — no per-model capability data. Fall back to the same
        // pattern-matched capabilities the dashboard uses (useModelCaps.js) so
        // dynamically-discovered LLM models still surface vision/reasoning/search/tools.
        const liveCaps = liveCapabilitiesById.get(modelId);
        const serviceCaps = capabilitiesFromServiceKind(customKind || liveKind);
        const baseCaps = liveCaps || serviceCaps || (kind === LLM_KIND ? getCapabilitiesForModel(providerId, modelId) : null);
        const caps = kind === LLM_KIND || allowAsLlm
          ? { ...baseCaps, ...readMetadata(modelId) }
          : baseCaps;
        if (caps) model.capabilities = caps;
        // Tier: synced account tier wins, then the provider's own live catalog
        // flag (Qoder publishes is_free/price_factor per account), then the
        // models.dev cost fills whatever is still unknown.
        let syncedTier = tierById.get(modelId);
        let tierNote = null;
        if (!syncedTier || syncedTier === "unknown") {
          const liveTier = liveTierById.get(modelId);
          if (liveTier && liveTier !== "unknown") {
            syncedTier = liveTier;
            tierNote = "live-catalog";
          }
        }
        if ((!syncedTier || syncedTier === "unknown") && (kind === LLM_KIND || allowAsLlm)) {
          try {
            const cost = getCatalogCost(providerId, modelId);
            if (cost && (cost.input !== undefined || cost.output !== undefined)) {
              const zero = (v) => v === 0 || v === "0";
              if (zero(cost.input) && (cost.output === undefined || cost.output === null || zero(cost.output))) syncedTier = "free";
              else if (cost.input !== null || cost.output !== null) syncedTier = "paid";
              if (syncedTier && syncedTier !== "unknown") tierNote = "models.dev";
            }
          } catch {}
        }
        if (syncedTier && syncedTier !== "unknown") {
          model.tier = syncedTier;
          if (tierNote) model.tier_source = tierNote;
          const syncedPricing = tierPricingById.get(modelId);
          if (syncedPricing) model.pricing = syncedPricing;
        }
        // so clients matching context_length find nothing, fall back to guessing
        // the window from the model name, and guess high — a 372k model read as
        // 1.05M never reaches its compaction threshold and hard-fails upstream.
        // Emitted at top level because not every client recurses into nested
        // objects; the camelCase `capabilities` block stays for compatibility.
        if (kind === LLM_KIND || allowAsLlm) {
          let contextWindow = caps?.contextWindow;
          let maxOutput = caps?.maxOutput;
          // Live-catalog and service-kind capabilities are usually partial
          // (often just { tools: true }), so fill the gaps from the static
          // table rather than emitting null and leaving clients to guess.
          if (!Number.isFinite(contextWindow) || !Number.isFinite(maxOutput)) {
            const fallback = getCapabilitiesForModel(providerId, modelId);
            if (!Number.isFinite(contextWindow)) contextWindow = fallback.contextWindow;
            if (!Number.isFinite(maxOutput)) maxOutput = fallback.maxOutput;
          }
          if (Number.isFinite(contextWindow)) model.context_length = contextWindow;
          if (Number.isFinite(maxOutput)) model.max_completion_tokens = maxOutput;
          // Selectable reasoning levels (the set the dashboard picker shows) so clients
          // can build their effort selector from the gateway instead of keeping a
          // per-model table. Omitted when the model has no reasoning.
          const thinkingCaps = typeof caps?.reasoning === "boolean"
            ? caps
            : { ...getCapabilitiesForModel(providerId, modelId), ...caps };
          const thinkingLevels = getThinkingLevels(providerId, modelId, thinkingCaps);
          if (Array.isArray(thinkingLevels) && thinkingLevels.length > 0) model.thinking_levels = thinkingLevels;
        }
        if (lifecycle) model.lifecycle = lifecycle;
        models.push(model);
      }

      // Web search/fetch — provider IS the model, expose as {alias}/search and/or {alias}/fetch with explicit kind
      const providerInfo = AI_PROVIDERS[providerId];
      if (kindFilter.includes("webSearch") && providerInfo?.searchConfig) {
        models.push({
          id: `${outputAlias}/search`,
          object: "model",
          kind: "webSearch",
          owned_by: outputAlias,
        });
      }
      if (kindFilter.includes("webFetch") && providerInfo?.fetchConfig) {
        models.push({
          id: `${outputAlias}/fetch`,
          object: "model",
          kind: "webFetch",
          owned_by: outputAlias,
        });
      }
    }
  }

  const comboEntries = [];
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    const entry = {
      id: combo.name,
      object: "model",
      owned_by: "combo",
    };
    if (combo.kind === "webSearch" || combo.kind === "webFetch") {
      entry.kind = combo.kind;
    } else if ((combo.kind || LLM_KIND) === LLM_KIND) {
      // Inherit from the members: without this a combo is an id with no limits,
      // so clients guess its window from the name and guess high. The resolver
      // maps custom connection prefixes and model aliases back to provider ids
      // (upstream's static-seat comboSeatCapabilities covers only static aliases).
      const caps = aggregateComboCapabilities(combo.models, comboMembersByName, { resolveMember: resolveComboMember, resolveCaps: resolveComboCaps });
      if (caps) {
        entry.capabilities = caps;
        const levels = caps.thinkingLevels?.filter((level) => caps.thinkingCanDisable || level !== "none");
        if (levels?.length) entry.thinking_levels = levels;
        if (Number.isFinite(caps.contextWindow)) entry.context_length = caps.contextWindow;
        if (Number.isFinite(caps.maxOutput)) entry.max_completion_tokens = caps.maxOutput;
      }
    }
    comboEntries.push(entry);
  }

  const dedupedModels = [];
  const seenModelIds = new Set();
  for (const model of [...comboEntries, ...models]) {
    if (!model?.id || seenModelIds.has(model.id)) continue;
    seenModelIds.add(model.id);
    dedupedModels.push(model);
  }

  return dedupedModels;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 * Lists combos + visible models; `?scope=all` adds every synced/live catalogue id.
 */
export async function GET(request) {
  try {
    // Detect cross-instance recursive /models fetch (another 9router fetching our /models)
    const skipDynamicFetch = request?.headers?.get(INTERNAL_MODELS_FETCH_HEADER) === "1";
    const url = request?.nextUrl || (request?.url ? new URL(request.url) : null);
    const tierFilter = url?.searchParams?.get("tier");
    const freeOnly = tierFilter === "free";
    let data = await buildModelsList([LLM_KIND], { skipDynamicFetch, scope: modelsScopeFromRequest(request) });
    data = await filterModelsListForKey(await getKeyAccessContext(request), data);
    if (freeOnly) data = data.filter((m) => m?.tier === "free");
    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
