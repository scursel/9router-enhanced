import { applyThinking, parseSuffix } from "../../translator/concerns/thinkingUnified.js";

// Native passthrough skips translateRequest, which is where a combo member's
// thinking suffix (`cc/claude-opus-5(high)`, `gemini-cli/gemini-2.5-pro(8192)`)
// is normally applied. Apply it here so the member's configured effort is not
// silently dropped. No suffix → the client's own thinking params stay as sent.
export function applyPassthroughSuffixThinking(body, { sourceFormat, upstreamModel, provider }) {
  if (!parseSuffix(upstreamModel).override) return body;

  if (provider === "codex") {
    // Responses shape: effort lives in reasoning.effort, not reasoning_effort.
    const suffixThinking = {};
    applyThinking(sourceFormat, upstreamModel, suffixThinking, provider);
    if (suffixThinking.reasoning_effort) {
      const reasoning = body.reasoning;
      body.reasoning = {
        ...(reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? reasoning : {}),
        effort: suffixThinking.reasoning_effort,
      };
      delete body.reasoning_effort;
    }
    return body;
  }

  applyThinking(sourceFormat, upstreamModel, body, provider);
  return body;
}
