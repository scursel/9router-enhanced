"use client";

import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";
import { translate } from "@/i18n/runtime";

/**
 * Asked before a model that a combo uses is disabled or deleted.
 *
 * Disable offers three exits, because a disabled model can stay in a combo and
 * keep routing. Delete offers two: the model ceases to exist, so "keep" is not
 * on the table.
 */
export default function ComboImpactModal({
  isOpen,
  subject,
  combos = [],
  mode = "disable",
  onRemoveAndProceed,
  onKeepAndProceed,
  onCancel,
}) {
  const isDelete = mode === "delete";
  const emptied = combos.filter((combo) => combo.remainingCount === 0);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={isDelete ? translate("Delete model used by combos") : translate("Disable model used by combos")}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>{translate("Cancel")}</Button>
          {!isDelete && (
            <Button variant="secondary" onClick={onKeepAndProceed}>
              {translate("Disable, keep in combos")}
            </Button>
          )}
          <Button variant="danger" onClick={onRemoveAndProceed}>
            {isDelete ? translate("Remove and delete") : translate("Remove and disable")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-text-muted">
          <span className="font-mono">{subject}</span>{" "}
          {combos.length === 1 ? translate("is used by this combo:") : `${translate("is used by these combos:")} (${combos.length})`}
        </p>

        <ul className="space-y-1">
          {combos.map((combo) => (
            <li key={combo.name} className="flex items-center justify-between gap-2">
              <code className="truncate font-mono text-xs">{combo.name}</code>
              {combo.remainingCount === 0 ? (
                <span className="shrink-0 rounded bg-warning/10 px-1.5 py-px text-[11px] text-warning">
                  {translate("would be left empty")}
                </span>
              ) : (
                <span className="shrink-0 text-[11px] text-text-muted">
                  {combo.remainingCount} {combo.remainingCount === 1 ? translate("model left") : translate("models left")}
                </span>
              )}
            </li>
          ))}
        </ul>

        {emptied.length > 0 && (
          <p className="text-xs text-warning">
            {translate("A combo with no models cannot route until you add one.")}
          </p>
        )}

        {!isDelete && (
          <p className="text-xs text-text-muted">
            {translate("Kept in a combo, the model still works and stays listed here, but it no longer appears in the model list your tools see.")}
          </p>
        )}
      </div>
    </Modal>
  );
}

ComboImpactModal.propTypes = {
  isOpen: PropTypes.bool,
  subject: PropTypes.string,
  combos: PropTypes.arrayOf(
    PropTypes.shape({ name: PropTypes.string, remainingCount: PropTypes.number })
  ),
  mode: PropTypes.oneOf(["disable", "delete"]),
  onRemoveAndProceed: PropTypes.func,
  onKeepAndProceed: PropTypes.func,
  onCancel: PropTypes.func,
};
