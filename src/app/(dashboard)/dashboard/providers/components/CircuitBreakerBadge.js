"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Badge from "@/shared/components/Badge";
import { translate } from "@/i18n/runtime";

// Badge variants carry the colors; the icon + text keep the state readable
// without relying on color alone.
const STATE_CONFIG = {
  DEGRADED: { variant: "warning", icon: "warning", label: "Unstable" },
  OPEN: { variant: "error", icon: "pause_circle", label: "Paused after repeated errors" },
  HALF_OPEN: { variant: "info", icon: "autorenew", label: "Recovering" },
};

/**
 * CircuitBreakerBadge — compact badge showing circuit breaker state for an account.
 * Hidden when status is missing or CLOSED. Integrates into existing connection rows
 * without requiring a new page.
 *
 * `onReset` may return a promise; the button stays disabled until it settles so
 * a second click cannot fire a second reset. Failure reporting belongs to the
 * caller/hook (useCircuitBreakers notifies on a failed reset).
 */
export default function CircuitBreakerBadge({ status, onReset }) {
  const [resetting, setResetting] = useState(false);
  if (!status || status.state === "CLOSED") return null;

  const config = STATE_CONFIG[status.state] || STATE_CONFIG.DEGRADED;
  const label = translate(config.label);
  const retryIn = status.retryAfterMs > 0 ? ` (${Math.ceil(status.retryAfterMs / 1000)}s)` : "";
  // The badge aggregates every per-model breaker of the connection (worst
  // state wins), so when more than the label is known, say which models tripped.
  const modelHint = Array.isArray(status.models) && status.models.length > 0 ? ` — ${status.models.join(", ")}` : "";
  const tooltip = `${label}${retryIn}${modelHint}`;

  const handleReset = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (resetting) return;
    setResetting(true);
    try {
      await onReset();
    } finally {
      setResetting(false);
    }
  };

  return (
    <span title={tooltip} className="inline-flex">
      <Badge variant={config.variant} size="md" icon={config.icon} className="gap-1 text-[11px]">
        {label}{retryIn}
        {status.state === "OPEN" && onReset && (
          <button
            type="button"
            onClick={handleReset}
            disabled={resetting}
            className="-my-1 -mr-1.5 inline-flex size-7 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors disabled:opacity-60"
            title={translate("Resume now")}
            aria-label={translate("Resume now")}
          >
            <span
              className="material-symbols-outlined text-[16px]"
              style={resetting ? { animation: "spin 1s linear infinite" } : undefined}
              aria-hidden="true"
            >
              {resetting ? "progress_activity" : "refresh"}
            </span>
          </button>
        )}
      </Badge>
    </span>
  );
}

CircuitBreakerBadge.propTypes = {
  status: PropTypes.shape({
    state: PropTypes.oneOf(["CLOSED", "DEGRADED", "OPEN", "HALF_OPEN"]),
    retryAfterMs: PropTypes.number,
    models: PropTypes.arrayOf(PropTypes.string),
  }),
  onReset: PropTypes.func,
};
