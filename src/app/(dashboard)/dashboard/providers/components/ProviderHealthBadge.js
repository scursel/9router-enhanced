"use client";

/**
 * ProviderHealthBadge — discreet read-only view over GET /api/health/providers
 * (T3.5, the magro port of OmniRoute's provider health matrix).
 *
 * One file, no redesign: the chip reuses CircuitBreakerBadge's pill classes and
 * the popover reuses ModelAvailabilityBadge's shell and status palette
 * (green/amber/red/grey). There is deliberately NO action in here — no reset,
 * no clear-cooldown, no sync. Recovery stays where it already is
 * (CircuitBreakerBadge's reset button, the availability popover); this component
 * only reads. Polling is 30s, the same cadence ModelAvailabilityBadge uses.
 *
 * `unknown` is a first-class state here: a provider without traffic renders grey
 * with "no traffic observed", never red. That is the "missing data never called
 * paid" rule of the route, kept visible in the UI.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";

const POLL_MS = 30_000;

// Colors come from the shared semantic tokens so the chip follows the theme.
// `labelKey` is translated at render time (never at module load, the
// dictionary may not be loaded yet).
const STATUS_CONFIG = {
  ok: { icon: "check_circle", color: "text-success", label: "Healthy" },
  cooldown: { icon: "schedule", color: "text-warning", label: "Waiting to retry" },
  degraded: { icon: "warning", color: "text-warning", label: "Unstable" },
  down: { icon: "error", color: "text-danger", label: "Down" },
  unknown: { icon: "help", color: "text-text-muted", label: "No data yet" },
};

const CHIP_CLASS = {
  ok: "bg-success/10 border-success/20 text-success",
  cooldown: "bg-warning/10 border-warning/20 text-warning",
  degraded: "bg-warning/10 border-warning/20 text-warning",
  down: "bg-danger/10 border-danger/20 text-danger",
  unknown: "bg-surface border-border text-text-muted",
};

// One sentence per status instead of the route's machine-readable reason codes.
const STATUS_HINT = {
  cooldown: "Waiting before trying this provider again.",
  degraded: "Some recent requests failed.",
  down: "Most recent requests failed.",
};

const RANGE_TITLE = {
  "1h": "Provider health · last 1h",
  "24h": "Provider health · last 24h",
  "7d": "Provider health · last 7d",
};

const CATALOG_NOTE = {
  "never-synced": "Model list not loaded yet",
  stale: "Model list is out of date",
  error: "Model list could not be refreshed",
};

function pct(rate) {
  if (rate === null || rate === undefined) return "—";
  return `${Math.round(rate * 100)}%`;
}

function ms(value) {
  if (!Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function breakerSentence(breaker) {
  const secs = breaker.retryAfterMs > 0 ? Math.ceil(breaker.retryAfterMs / 1000) : 0;
  if (breaker.state === "OPEN") {
    return secs > 0
      ? `${translate("Paused after repeated errors, retrying in")} ${secs}s`
      : translate("Paused after repeated errors");
  }
  if (breaker.state === "HALF_OPEN") return translate("Recovering, testing with new requests");
  return translate("Unstable, watching for more errors");
}

async function loadMatrix(range) {
  const res = await fetch(`/api/health/providers?range=${encodeURIComponent(range)}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`health providers GET ${res.status}`);
  return res.json();
}

/**
 * @returns {{matrix: object|null, loading: boolean, refreshing: boolean, error: boolean, refresh: () => Promise<void>}}
 */
export function useProviderHealth(range = "24h") {
  const [matrix, setMatrix] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(() => {
    setRefreshing(true);
    return loadMatrix(range)
      .then((json) => {
        setMatrix(json);
        setError(false);
        setLoading(false);
      })
      .catch(() => {
        // The popover shows the error with a Retry button; polling retries too.
        setError(true);
        setLoading(false);
      })
      .finally(() => setRefreshing(false));
  }, [range]);

  useEffect(() => {
    let cancelled = false;
    loadMatrix(range)
      .then((json) => {
        if (cancelled) return;
        setMatrix(json);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  // Fixed 30s cadence, the one ModelAvailabilityBadge already uses: the matrix
  // is cheap and read-only, so there is no "only poll when unhealthy" trick.
  useEffect(() => {
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return { matrix, loading, refreshing, error, refresh };
}

const CHIP_BASE = "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium";

export default function ProviderHealthBadge({ range = "24h" }) {
  const { matrix, loading, refreshing, error, refresh } = useProviderHealth(range);
  const [expanded, setExpanded] = useState(false);
  const ref = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!expanded) return undefined;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setExpanded(false);
    };
    const handleKey = (e) => {
      if (e.key === "Escape") {
        setExpanded(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [expanded]);

  // Same-size placeholder: returning null made the chip pop in and shift the header.
  if (loading) {
    return (
      <div
        aria-hidden="true"
        className={`${CHIP_BASE} border-border bg-surface text-transparent animate-pulse select-none`}
      >
        <span className="inline-block size-3.5 rounded-full bg-border" />
        {translate("Health: no data yet")}
      </div>
    );
  }

  const providers = matrix?.providers || [];
  const totals = matrix?.totals || {};
  const attention = providers.filter((p) => p.status === "down" || p.status === "degraded" || p.status === "cooldown");
  const summary = error
    ? { key: "unknown", label: translate("Health unavailable") }
    : providers.length === 0
      ? { key: "unknown", label: translate("No providers") }
      : attention.length > 0
        ? {
            key: attention[0].status,
            label: `${attention.length} ${translate(attention.length === 1 ? "provider to watch" : "providers to watch")}`,
          }
        : providers.every((p) => p.status === "unknown")
          ? { key: "unknown", label: translate("Health: no data yet") }
          : { key: "ok", label: translate("Providers healthy") };
  const status = STATUS_CONFIG[summary.key] || STATUS_CONFIG.unknown;
  const chipClass = CHIP_CLASS[summary.key] || CHIP_CLASS.unknown;

  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        onClick={() => setExpanded((v) => !v)}
        title={translate("Provider health (read-only)")}
        aria-label={`${translate("Provider health")}: ${summary.label}`}
        aria-expanded={expanded}
        aria-haspopup="true"
        className={`${CHIP_BASE} transition-all ${chipClass}`}
      >
        <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
          {status.icon}
        </span>
        {summary.label}
      </button>

      {expanded && (
        <div className="absolute top-full right-0 mt-2 w-96 max-w-[calc(100vw-2rem)] bg-surface border border-border rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg">
            <div className="flex items-center gap-2">
              <span className={`material-symbols-outlined text-[16px] ${status.color}`} aria-hidden="true">
                {status.icon}
              </span>
              <span className="text-sm font-semibold text-text-main">
                {translate(RANGE_TITLE[range] || RANGE_TITLE["24h"])}
              </span>
            </div>
            <button
              onClick={refresh}
              disabled={refreshing}
              className="p-1.5 rounded-lg hover:bg-surface text-text-muted hover:text-text-main transition-colors disabled:opacity-60"
              title={translate("Refresh")}
              aria-label={translate("Refresh")}
            >
              <span
                className="material-symbols-outlined text-[16px]"
                style={refreshing ? { animation: "spin 1s linear infinite" } : undefined}
                aria-hidden="true"
              >
                refresh
              </span>
            </button>
          </div>

          <div className="px-4 py-3 max-h-80 overflow-y-auto">
            {error ? (
              <div className="flex flex-col items-center gap-2 py-2">
                <p className="text-sm text-text-muted text-center">
                  {translate("Health data could not be loaded. Nothing was changed on any provider.")}
                </p>
                <button
                  onClick={refresh}
                  disabled={refreshing}
                  className="px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-text-main hover:bg-bg transition-colors disabled:opacity-60"
                >
                  {translate("Retry")}
                </button>
              </div>
            ) : providers.length === 0 ? (
              <p className="text-sm text-text-muted text-center py-2">{translate("No providers configured.")}</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                <p className="text-[11px] text-text-muted">
                  {totals.requests || 0} {translate("requests")} · {totals.unknown || 0} {translate("providers without traffic")}.{" "}
                  {translate("This view only shows information and changes nothing.")}
                </p>
                {(totals.unknown || 0) > 0 && (
                  // Said once here instead of under every idle provider.
                  <p className="text-[11px] text-text-muted">
                    {translate("No requests in this period, so the status is unknown, not down.")}
                  </p>
                )}
                {providers.map((p) => {
                  const cfg = STATUS_CONFIG[p.status] || STATUS_CONFIG.unknown;
                  const models = (p.models || []).slice(0, 6);
                  const catalogNote = CATALOG_NOTE[p.catalog?.worst || "never-synced"];
                  const hint = STATUS_HINT[p.status];
                  return (
                    <div key={p.provider} className="rounded-lg bg-surface/30 px-2.5 py-2">
                      {/* The name keeps the whole first line; the numbers wrap below it
                          rather than squeezing the name down to two letters. */}
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                        <div className="flex items-center gap-1.5 min-w-0 max-w-full">
                          <span
                            className={`material-symbols-outlined text-[14px] shrink-0 ${cfg.color}`}
                            aria-hidden="true"
                          >
                            {cfg.icon}
                          </span>
                          <span className="font-mono text-xs text-text-main truncate">{p.provider}</span>
                          <span className={`text-[11px] font-medium shrink-0 ${cfg.color}`}>{translate(cfg.label)}</span>
                        </div>
                        {p.requests > 0 && (
                          <span className="text-[11px] text-text-muted shrink-0">
                            {p.requests} {translate("requests")} · {pct(p.successRate)} {translate("succeeded")} · {ms(p.avgLatencyMs)}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-col gap-0.5 mt-1 text-[11px] text-text-muted">
                        {hint && <span>{translate(hint)}</span>}
                        {p.breaker && p.breaker.state !== "CLOSED" && (
                          <span className="text-danger">{breakerSentence(p.breaker)}</span>
                        )}
                        {catalogNote && <span>{translate(catalogNote)}</span>}
                      </div>
                      {models.length > 0 && (
                        <div className="flex flex-col gap-0.5 mt-1.5">
                          {models.map((m) => {
                            const mcfg = STATUS_CONFIG[m.status] || STATUS_CONFIG.unknown;
                            return (
                              <div key={m.model} className="flex items-center justify-between gap-2 text-[11px]">
                                <span className="flex items-center gap-1 min-w-0">
                                  <span
                                    className={`material-symbols-outlined text-[12px] shrink-0 ${mcfg.color}`}
                                    aria-hidden="true"
                                  >
                                    {mcfg.icon}
                                  </span>
                                  <span className="font-mono text-text-main truncate">{m.model}</span>
                                  <span className={`shrink-0 ${mcfg.color}`}>{translate(mcfg.label)}</span>
                                </span>
                                <span className="text-text-muted shrink-0">
                                  {m.requests} · {pct(m.successRate)} · {ms(m.avgLatencyMs)}
                                </span>
                              </div>
                            );
                          })}
                          {p.modelsTotal > models.length && (
                            <span className="text-[11px] text-text-muted">
                              +{p.modelsTotal - models.length} {translate("more models")}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

ProviderHealthBadge.propTypes = {
  range: PropTypes.oneOf(["1h", "24h", "7d"]),
};
