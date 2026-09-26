"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";
import { describeProviderError } from "@/shared/utils/errorReason";

// Shows why a provider call failed in plain words ("Out of credits") with the
// provider's raw error one click away. Falls back to the raw text when the
// error matches no standard reason.
//   compact: one line (title only) for tables and pills; full: title + hint.
export default function ErrorReason({ error, status, compact = false, className }) {
  const [open, setOpen] = useState(false);
  const info = describeProviderError(error, status);
  if (!info) return null;

  const title = info.title ? translate(info.title) : null;
  const hint = info.hint ? translate(info.hint) : null;
  const raw = info.detail && info.detail !== info.raw ? `${info.detail}\n\n${info.raw}` : info.raw;

  return (
    <div className={cn("min-w-0 text-red-600 dark:text-red-400", className)}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={open ? translate("Hide details") : translate("Show the provider's original error")}
        className="flex max-w-full items-start gap-1 text-left"
      >
        <span className="material-symbols-outlined mt-px shrink-0 text-[14px]">error</span>
        <span className="min-w-0">
          <span className={cn("font-medium", compact && "block truncate")}>
            {title || (compact ? info.raw : translate("Provider error"))}
            {info.status ? <span className="ml-1 font-normal opacity-70">({info.status})</span> : null}
          </span>
          {!compact && hint && <span className="block text-xs text-text-muted">{hint}</span>}
        </span>
        <span className="material-symbols-outlined shrink-0 text-[14px] opacity-60">{open ? "expand_less" : "expand_more"}</span>
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/5 p-2 text-[11px] text-text-muted dark:bg-white/5">
          {raw}
        </pre>
      )}
    </div>
  );
}

ErrorReason.propTypes = {
  error: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
  status: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  compact: PropTypes.bool,
  className: PropTypes.string,
};
