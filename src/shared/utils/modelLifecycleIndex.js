/**
 * Index the /v1/models `lifecycle` annotations for one provider card.
 * Full ids ("alias/model") are always indexed; the bare model id is indexed
 * only when the prefix belongs to this card's provider, so the same bare id
 * under another provider cannot lend its lifecycle ("Retired") to this one.
 */
export function buildLifecycleIndex(list, providerPrefixes = []) {
  const prefixes = new Set(providerPrefixes.filter(Boolean));
  const byId = {};
  for (const m of Array.isArray(list) ? list : []) {
    if (typeof m?.id !== "string" || !m.lifecycle) continue;
    byId[m.id] = m.lifecycle;
    const slash = m.id.indexOf("/");
    if (slash >= 0 && prefixes.has(m.id.slice(0, slash))) byId[m.id.slice(slash + 1)] = m.lifecycle;
  }
  return byId;
}
