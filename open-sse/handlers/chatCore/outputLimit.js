import { getCapabilitiesForModel, hasKnownLimits } from "../../providers/capabilities.js";
import { GEMINI_LONG_DECODE_MAX_OUTPUT } from "../../utils/geminiLongDecode.js";

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
  const caps = getCapabilitiesForModel(provider, model);
  // Long-decode models (gemini-4-hydrogen) run continuation hops up to
  // GEMINI_LONG_DECODE_MAX_OUTPUT, so their static 64K maxOutput is not the cap.
  const ceiling = caps.longDecode === true ? GEMINI_LONG_DECODE_MAX_OUTPUT : caps.maxOutput;
  if (!Number.isFinite(ceiling) || ceiling <= 0) return body;

  for (const key of TOP_LEVEL_FIELDS) clampField(body, key, ceiling);
  clampField(body.generationConfig, "maxOutputTokens", ceiling);
  clampField(body.request?.generationConfig, "maxOutputTokens", ceiling);
  return body;
}
