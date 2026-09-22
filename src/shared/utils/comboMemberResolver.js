import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";

// Combo members are stored as the model picker's `{prefix}/{model}` strings,
// where the prefix may be a connection's custom prefix, the provider's static
// alias, or the raw provider id. Capabilities are keyed by provider id, so map
// every prefix a member could carry back to one.
export function buildProviderIdByPrefix(connections = []) {
  const byPrefix = new Map();
  for (const [providerId, alias] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
    byPrefix.set(providerId, providerId);
    if (alias) byPrefix.set(alias, providerId);
  }
  for (const conn of connections) {
    const providerId = conn?.provider;
    if (!providerId) continue;
    const alias = getProviderAlias(providerId);
    if (alias) byPrefix.set(alias, providerId);
    const prefix = conn?.providerSpecificData?.prefix;
    if (typeof prefix === "string" && prefix.trim()) byPrefix.set(prefix.trim(), providerId);
  }
  return byPrefix;
}

// resolveMember for aggregateComboCapabilities (open-sse/providers/capabilities.js).
// Nested combos are resolved by the aggregator before this runs, so a bare
// member here is a model alias — routing resolves in that order — or a
// provider-as-model entry with no member model to read limits from (null).
export function makeComboMemberResolver(connections = [], modelAliases = {}) {
  const providerIdByPrefix = buildProviderIdByPrefix(connections);
  return (member) => {
    let fullModel = member;
    if (!fullModel.includes("/")) {
      const resolved = modelAliases?.[fullModel];
      if (typeof resolved !== "string" || !resolved.includes("/")) return null;
      fullModel = resolved;
    }
    const separator = fullModel.indexOf("/");
    const prefix = fullModel.slice(0, separator);
    const model = fullModel.slice(separator + 1).trim();
    if (!model) return null;
    return { provider: providerIdByPrefix.get(prefix) || prefix, model };
  };
}
