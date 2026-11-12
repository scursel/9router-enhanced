// Image provider adapter registry
import createOpenAIAdapter from "./openai.js";
import gemini from "./gemini.js";
import codex from "./codex.js";
import sdwebui from "./sdwebui.js";
import comfyui from "./comfyui.js";
import huggingface from "./huggingface.js";
import nanobanana from "./nanobanana.js";
import falAi from "./falAi.js";
import stabilityAi from "./stabilityAi.js";
import blackForestLabs from "./blackForestLabs.js";
import runwayml from "./runwayml.js";
import cloudflareAi from "./cloudflareAi.js";
import antigravity from "./antigravity.js";
import alibabaWan, { isAlibabaWanRequest } from "./alibabaWan.js";
import museWeb from "./muse-web.js";
import chatgptWeb from "./chatgpt-web.js";
import geminiWeb from "./gemini-web.js";
import grokWeb from "./grok-web.js";
import veoAiFreeWeb from "./veoaifree-web.js";
import ucWeb from "./uc-web.js";

const ADAPTERS = {
  openai: createOpenAIAdapter("openai"),
  minimax: createOpenAIAdapter("minimax"),
  openrouter: createOpenAIAdapter("openrouter"),
  recraft: createOpenAIAdapter("recraft"),
  "vercel-ai-gateway": createOpenAIAdapter("vercel-ai-gateway"),
  xai: createOpenAIAdapter("xai"),
  sensenova: createOpenAIAdapter("sensenova"),
  "sensenova-intl": createOpenAIAdapter("sensenova-intl"),
  gemini,
  codex,
  sdwebui,
  comfyui,
  huggingface,
  nanobanana,
  antigravity,
  "fal-ai": falAi,
  "stability-ai": stabilityAi,
  "black-forest-labs": blackForestLabs,
  runwayml,
  "cloudflare-ai": cloudflareAi,
  "muse-web": museWeb,
  "chatgpt-web": chatgptWeb,
  "gemini-web": geminiWeb,
  "grok-web": grokWeb,
  "veoaifree-web": veoAiFreeWeb,
  "uc-web": ucWeb,
};

// ctx = { model, credentials }: custom nodes are matched by their base URL host + model,
// not by node id. Only OpenAI-compatible custom nodes are considered.
export function getImageAdapter(provider, ctx = {}) {
  if (ADAPTERS[provider]) return ADAPTERS[provider];
  if (
    typeof provider === "string" &&
    provider.startsWith("openai-compatible-") &&
    isAlibabaWanRequest(ctx.model, ctx.credentials?.providerSpecificData?.baseUrl)
  ) {
    return alibabaWan;
  }
  return null;
}

export function isImageProvider(provider, ctx = {}) {
  return getImageAdapter(provider, ctx) !== null;
}
