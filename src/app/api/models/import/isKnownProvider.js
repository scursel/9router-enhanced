// providerId from the URL is user input — accept only a registered provider
// (a key of AI_PROVIDERS) or a compatible-node id (openai-compatible-*/
// anthropic-compatible-*), otherwise every [providerId] route 404s.
import {
  AI_PROVIDERS,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
} from "@/shared/constants/providers";

export function isKnownProvider(providerId) {
  if (typeof providerId !== "string" || !providerId) return false;
  if (providerId in AI_PROVIDERS) return true;
  return isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);
}
