import { getCapabilitiesForModel, hasKnownLimits } from "../../providers/capabilities.js";

// Output-token fields per wire format. Gemini wrappers (gemini-cli,
// antigravity) nest the Gemini body under `request`.
const TOP_LEVEL_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];

function clampField(obj, key, ceiling) {
  const v = obj?.[key];
  if (Number.isFinite(v) && v > ceiling) obj[key] = ceiling;
}

// Clamp the requested output budget to the target model's documented maximum.
// A combo retries the same client body on every member, so a max_tokens that
// is valid for the primary (Opus: 128k) reached a fallback with a smaller
// ceiling (gpt-4o: 16k) and came back as a 400. Only models whose limits come
// from real data are clamped: the DEFAULT floor is a guess and must never cut
// an uncatalogued model's legitimate budget. Only lowers, never raises.
export function clampOutputTokens(body, provider, model) {
  if (!body || typeof body !== "object" || !model) return body;
  if (!hasKnownLimits(provider, model)) return body;
  const ceiling = getCapabilitiesForModel(provider, model).maxOutput;
  if (!Number.isFinite(ceiling) || ceiling <= 0) return body;

  for (const key of TOP_LEVEL_FIELDS) clampField(body, key, ceiling);
  clampField(body.generationConfig, "maxOutputTokens", ceiling);
  clampField(body.request?.generationConfig, "maxOutputTokens", ceiling);
  return body;
}
