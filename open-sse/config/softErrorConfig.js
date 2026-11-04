// Soft-error guard for chat combos (services/softErrorGuard.js).
//
// Some free upstreams answer HTTP 200 with their error notice as the assistant
// text (aihubmix: "Sorry, to prevent abuse of free resources, accounts that
// have not been recharged..."). Without a guard the combo returns that notice
// as a success and never tries its next member.
//
// Match only unambiguous upstream notices. Generic error terms also occur in
// legitimate explanations and must not cause a successful combo member to be
// discarded.
export const SOFT_ERROR_PATTERNS = [
  ["prevent abuse", String.raw`^sorry,? to prevent abuse of free resources,? accounts that have not been recharged\b`],
  ["余额不足", String.raw`^余额不足[，,、;；\s]*请充值(?:[。.!！\s]|$)`],
];

export const SOFT_ERROR_GUARD = {
  // Set to "off" to disable the guard without a redeploy (read per request).
  disableEnv: "COMBO_SOFT_ERROR_GUARD",
  // A match anywhere counts only when the whole answer is shorter than this.
  maxChars: 300,
  // Otherwise the notice must start within the first leadChars characters.
  // It is also how much streamed text is held back before the client sees it.
  // This window covers the anchored aihubmix signature across SSE deltas.
  leadChars: 120,
  // Upper bounds on the stream peek: past either one the answer is released.
  peekMaxMs: 8000,
  peekMaxBytes: 64 * 1024,
  snippetChars: 160,
};
