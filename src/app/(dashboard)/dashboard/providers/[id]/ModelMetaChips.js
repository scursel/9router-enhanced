"use client";

import PropTypes from "prop-types";
import { Tooltip } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import { formatContextLength } from "@/shared/utils/importProviderModels";

// *Source ("provider" | "tested" | "catalog" | "estimated") tells where a
// measured fact came from — see src/app/api/models/route.js withMeasuredFacts.
// A caps object built by the client-side fallback in useModelCaps carries no
// *Source field at all; that case reads the same as "estimated".
function sourceLabel(source) {
  switch (source) {
    case "provider": return translate("Reported by the provider");
    case "tested": return translate("Detected by test");
    case "catalog": return translate("From the model catalog");
    default: return translate("Estimated from the model name");
  }
}

// Small pills next to a model's name: its measured context window and whether
// it reasons on this provider, each with a tooltip naming the source. Caller
// is responsible for not also rendering the reasoning capability badge
// elsewhere on the same row (see CapacityBadges usage in ModelRow).
export default function ModelMetaChips({ caps, className = "" }) {
  if (!caps) return null;
  const contextLabel = formatContextLength(caps.contextWindow);
  const contextSource = caps.contextSource || "estimated";
  const showReasoning = caps.reasoning === true;
  const reasoningSource = caps.reasoningSource || "estimated";

  if (!contextLabel && !showReasoning) return null;

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {contextLabel && (
        <Tooltip text={sourceLabel(contextSource)}>
          <span
            className={`inline-flex items-center rounded bg-black/5 px-1 py-px font-mono text-[9px] cursor-help dark:bg-white/5 ${
              contextSource === "estimated" ? "text-text-muted/50" : "text-text-muted"
            }`}
          >
            {contextSource === "estimated" ? `~${contextLabel}` : contextLabel}
          </span>
        </Tooltip>
      )}
      {showReasoning && (
        <Tooltip text={sourceLabel(reasoningSource)}>
          <span className="inline-flex items-center gap-0.5 rounded bg-black/5 px-1 py-px text-[9px] text-amber-600 cursor-help dark:bg-white/5 dark:text-amber-400">
            <span className="material-symbols-outlined text-[10px] leading-none">neurology</span>
            {translate("Reasoning")}
          </span>
        </Tooltip>
      )}
    </span>
  );
}

ModelMetaChips.propTypes = {
  caps: PropTypes.shape({
    contextWindow: PropTypes.number,
    contextSource: PropTypes.string,
    reasoning: PropTypes.bool,
    reasoningSource: PropTypes.string,
  }),
  className: PropTypes.string,
};
