import { AI_PROVIDERS } from "../shared/constants/providers.js";

/**
 * Detect xAI Grok models by id pattern (grok-*, Grok_*, etc).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isXaiModel(modelId) {
  return typeof modelId === "string" && /^grok[-_]/i.test(modelId.trim());
}

export function normalizeProviderId(provider) {
  if (typeof provider !== "string") return provider;

  const trimmed = provider.trim();
  if (AI_PROVIDERS[trimmed]) return trimmed;

  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (AI_PROVIDERS[slug]) return slug;

  const providerByName = Object.values(AI_PROVIDERS).find(
    (entry) => entry.name?.toLowerCase() === trimmed.toLowerCase()
  );
  return providerByName?.id || trimmed;
}

// Alibaba MaaS per-account endpoints: https + an Alibaba Cloud domain only, so the
// account bearer key can never be sent to an arbitrary or internal host.
export function isAlibabaCloudHttpsUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    return ["aliyuncs.com", "alibabacloud.com", "aliyun.com"].some((d) => h === d || h.endsWith("." + d));
  } catch { return false; }
}

export function normalizeProviderSpecificData(provider, body = {}, providerSpecificData = null) {
  const next = providerSpecificData && typeof providerSpecificData === "object"
    ? { ...providerSpecificData }
    : {};

  const ALIBABA_SE_HOSTS = new Set(["alicode", "alicode-intl", "alims-intl", "alitp-intl"]);
  const needsBaseUrl = provider === "ollama-local" || ALIBABA_SE_HOSTS.has(provider);
  if (needsBaseUrl) {
    let baseUrl = (
      next.baseUrl ||
      body.baseUrl ||
      body.baseURL ||
      body.ollamaHostUrl ||
      ""
    ).trim();

    // SEC-SSRF-002 narrowing: Alibaba MaaS hosts are public cloud — block
    // non-https to avoid plaintext Bearer forwarding. Local nodes (ollama-local)
    // keep permissiveness via the allowlist branch.
    if (baseUrl && ALIBABA_SE_HOSTS.has(provider) && !isAlibabaCloudHttpsUrl(baseUrl)) {
      baseUrl = "";
    }

    if (baseUrl) next.baseUrl = baseUrl;
  }

  return Object.keys(next).length > 0 ? next : null;
}
