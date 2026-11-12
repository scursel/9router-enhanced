"use client";

/**
 * CB4 — the compact success chip on a combo card + its in-line breakdown.
 *
 * Deliberately presentational and self-contained (react only): every value it
 * prints comes from comboStats.js (chipLabel / chipTone / sortMembersByFailure
 * / memberRowView), which the model tests cover. It never fetches and never
 * recomputes — the page-level useComboStats feeds it one matched `entry`, so
 * N cards share a single endpoint read. Clicking toggles an IN-LINE expansion
 * (a conditional div, not a route) so no new page is created.
 *
 * Discretion + fail-open: a null rate renders a muted "No traffic yet"; a fetch
 * gap renders a muted "Stats unavailable" — no toast, no red error.
 */
import { useId, useState } from "react";
import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { describeProviderError } from "@/shared/utils/errorReason";
import {
  chipLabel,
  chipTone,
  coverageBadgeLabel,
  sortMembersByFailure,
  memberRowView,
  subComboNoticeLines,
  MEMBER_VERDICT,
  countVerdicts,
} from "./comboStats.js";

// Worst first, matching the row order below.
const VERDICT_ORDER = ["paused", "not-working", "unstable", "working", "unused"];

// `member.lastErrorStatus` is stored as "error:<code>" (see comboStats.js/
// memberRowView) — not a bare HTTP status, so it is normalized here rather
// than inside the pure, i18n-free comboStats helpers. Falls back to plain
// errorText (unchanged wording, still unit-tested) when no reason matches.
function errorDisplayText(rawMember, viewErrorText) {
  if (viewErrorText === "—") return viewErrorText;
  const status = rawMember?.lastErrorStatus;
  const match = String(status ?? "").match(/(\d{3})/);
  if (!match) return viewErrorText;
  const info = describeProviderError(null, Number(match[1]));
  const title = info?.title ? translate(info.title) : null;
  if (!title) return viewErrorText;
  return viewErrorText.replace(String(status), `${title} (${match[1]})`);
}

export default function ComboStatsBadge({ entry = null, coverage = null, range = "24h", error = false, pending = false }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  const partial = coverageBadgeLabel({ coverage }) === "partial";
  const tone = chipTone(entry ? entry.successRate : null);
  const rateLabel = chipLabel(entry);
  // "—" alone reads as a bug: say why there is no number. A failed poll is a
  // quiet state (no toast) because this refreshes in the background.
  const hasRate = rateLabel !== "—";
  let label = rateLabel;
  let chipTitle = `${translate("Combo success rate")} · ${range}`;
  if (!hasRate && !pending) {
    if (error && !entry) {
      label = translate("Stats unavailable");
      chipTitle = translate("Could not load success stats. They refresh automatically, so try again in a moment.");
    } else {
      label = translate("No traffic yet");
      chipTitle = translate("No requests were routed through this combo in this time window.");
    }
  }
  if (partial) chipTitle += ` · ${translate("partial")}`;
  const rawMembers = sortMembersByFailure(entry ? entry.members : []);
  const verdictCounts = countVerdicts(rawMembers);
  const members = rawMembers.map((m) => {
    const view = memberRowView(m);
    return {
      ...view,
      errorText: errorDisplayText(m, view.errorText).replace(
        "less than a minute ago",
        translate("less than a minute ago"),
      ),
      // The countdown is a number, so only the sentence around it is translated.
      breakerLabel: m?.breaker?.state === "OPEN" && m.breaker.retryAfterMs > 0
        ? `${translate("Paused after repeated errors, retrying in")} ${Math.ceil(m.breaker.retryAfterMs / 1000)}s`
        : translate(view.breakerLabel),
    };
  });
  // CB5/NIT-2: sub-combo names flagged by the aggregate — rendered as text
  // lines, never as numbers (see subComboNoticeLines for the entry-less gap).
  const subComboNotices = subComboNoticeLines(entry).map((line) => translate(line));

  return (
    <div
      className="min-w-0"
      onKeyDown={(e) => { if (e.key === "Escape" && expanded) { e.stopPropagation(); setExpanded(false); } }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={`${translate("Combo success rate")}: ${label}`}
          title={chipTitle}
          className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors ${tone}`}
        >
          <span className="material-symbols-outlined text-[13px]" aria-hidden="true">percent</span>
          <span>{label}</span>
          <span aria-hidden="true" className={`material-symbols-outlined text-[12px] transition-transform ${expanded ? "rotate-180" : ""}`}>
            expand_more
          </span>
        </button>
        {partial && (
          <span
            className="inline-flex items-center rounded bg-warning/10 px-1.5 py-px text-[11px] text-warning"
            title={translate("Some requests in this window were made before combo tracking started, so this rate may be understated.")}
          >
            {translate("partial")}
          </span>
        )}
      </div>

      {expanded && (
        <div id={panelId} className="mt-2 rounded-lg border border-border bg-bg-subtle/40 px-3 py-2">
          {subComboNotices.length > 0 && (
            <div className="mb-1.5 flex flex-col gap-0.5">
              {subComboNotices.map((line) => (
                <p key={line} className="text-[11px] leading-snug text-text-muted">{line}</p>
              ))}
            </div>
          )}
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              {translate("By member")} · {range}
            </span>
            <span className="text-[11px] text-text-muted">{translate("problematic first")}</span>
          </div>
          {members.length > 0 && (
            <p className="mb-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
              {VERDICT_ORDER.filter((key) => verdictCounts[key] > 0).map((key) => (
                <span key={key} className={`inline-flex items-center gap-1 font-medium ${MEMBER_VERDICT[key].tone}`}>
                  <span className="material-symbols-outlined text-[13px]" aria-hidden="true">{MEMBER_VERDICT[key].icon}</span>
                  {translate(MEMBER_VERDICT[key].label)}: {verdictCounts[key]}
                </span>
              ))}
            </p>
          )}
          {members.length === 0 ? (
            <p className="py-1 text-[11px] text-text-muted">
              {entry ? translate("No attributed attempts recorded in this window.") : translate("No data.")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {members.map((m, i) => (
                <li key={`${m.member || "member"}-${m.model || i}`} className="text-[11px]">
                  <span className="flex min-w-0 flex-col items-start gap-1 sm:flex-row sm:gap-1.5">
                    <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px font-medium ${MEMBER_VERDICT[m.verdict].chip}`}>
                      <span className="material-symbols-outlined text-[13px]" aria-hidden="true">{MEMBER_VERDICT[m.verdict].icon}</span>
                      {translate(MEMBER_VERDICT[m.verdict].label)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-text-main" title={m.label}>{m.label}</span>
                      {m.verdict === "paused" && (
                        <span className="block text-[11px] text-text-muted">{m.breakerLabel}</span>
                      )}
                      <span className="block text-[11px] text-text-muted">
                        {m.attempts > 0
                          ? <>{m.successes}/{m.attempts} {translate("requests worked")}</>
                          : translate("No requests yet")}
                      </span>
                      {m.errorText !== "—" && (
                        <span className="block truncate text-[11px] text-text-muted">
                          {translate("Last error:")} <span className="font-mono">{m.errorText}</span>
                        </span>
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

ComboStatsBadge.propTypes = {
  entry: PropTypes.object,
  coverage: PropTypes.oneOf(["full", "partial", null]),
  range: PropTypes.string,
  error: PropTypes.bool,
  pending: PropTypes.bool,
};
