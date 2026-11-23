import { AI_PROVIDERS } from "@/shared/constants/providers";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

const SECRET_PROVIDER_SPECIFIC_KEYS = new Set([
  "cookie",
  "quotaCookie",
  "clientSecret",
  "copilotToken",
  "storageState",
  "mimoPassToken",
  "opendesignControlKey",
  "sessionToken",
]);

export function toProviderConnectionResponse(connection) {
  const { apiKey, accessToken, refreshToken, idToken, providerSpecificData, ...safe } = connection;

  // Redact secret keys from providerSpecificData
  let sanitizedProviderSpecificData = providerSpecificData;
  if (providerSpecificData && typeof providerSpecificData === "object") {
    sanitizedProviderSpecificData = { ...providerSpecificData };
    for (const key of SECRET_PROVIDER_SPECIFIC_KEYS) {
      delete sanitizedProviderSpecificData[key];
    }
  }

  return { ...safe, ...(sanitizedProviderSpecificData && Object.keys(sanitizedProviderSpecificData).length > 0 ? { providerSpecificData: sanitizedProviderSpecificData } : {}) };
}
