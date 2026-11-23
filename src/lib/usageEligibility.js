import { USAGE_APIKEY_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { USAGE_IMPLEMENTED_PROVIDERS } from "open-sse/services/usage.js";
import { hasLocalBalanceConfigured } from "open-sse/services/usage/localBalance.js";
import { isLeaseConnection } from "open-sse/services/minimaxCodeLease.js";

// Whether a connection can show up on the usage / quota screens. Lives outside
// the route file because Next route modules may only export HTTP handlers.
export function isUsageEligible(connection) {
  if (hasLocalBalanceConfigured(connection)) return true;
  const provider = connection.provider;
  return USAGE_SUPPORTED_PROVIDERS.includes(provider)
    && USAGE_IMPLEMENTED_PROVIDERS.includes(provider)
    && (
      connection.authType === "oauth"
      || isLeaseConnection(connection)
      || USAGE_APIKEY_PROVIDERS.includes(provider)
    );
}
