// Soft-error guard for chat combos (services/softErrorGuard.js).
//
// Some free upstreams answer HTTP 200 with their error notice as the assistant
// text (aihubmix: "Sorry, to prevent abuse of free resources, accounts that
// have not been recharged..."). Without a guard the combo returns that notice
// as a success and never tries its next member.
//
// Live traffic answers real user prompts, so the list is narrower than the
// offline health gate's: only phrasings that are specific to a provider
// notice. Bare "rate limit", "unauthorized" or "too many requests" are left
// out — a normal answer can open with them.
export const SOFT_ERROR_PATTERNS = [
  ["prevent abuse", String.raw`\bprevent(?:ing)? abuse\b`],
  ["recharge", String.raw`\brecharg(?:e|ed|ing)\b`],
  ["insufficient balance", String.raw`\binsufficient (?:account )?balance\b`],
  ["insufficient credit", String.raw`\binsufficient credits?\b`],
  ["quota exceeded", String.raw`\bquota (?:has been )?exceeded\b`],
  ["exceeded your quota", String.raw`\bexceeded (?:your |the )?(?:current )?quota\b`],
  ["rate limit exceeded", String.raw`\brate[ _-]?limit (?:exceeded|reached)\b`],
  ["account suspended", String.raw`\baccount (?:has been|is|was) suspended\b`],
  ["api key invalid", String.raw`\b(?:api[ _-]?key (?:is )?invalid|invalid api[ _-]?key)\b`],
  ["free tier limit", String.raw`\bfree[ -]tier limit\b`],
  ["余额不足", "余额不足"],
  ["请充值", "请充值"],
];

export const SOFT_ERROR_GUARD = {
  // Set to "off" to disable the guard without a redeploy (read per request).
  disableEnv: "COMBO_SOFT_ERROR_GUARD",
  // A match anywhere counts only when the whole answer is shorter than this.
  maxChars: 300,
  // Otherwise the notice must start within the first leadChars characters.
  // It is also how much streamed text is held back before the client sees it.
  leadChars: 60,
  // Upper bounds on the stream peek: past either one the answer is released.
  peekMaxMs: 8000,
  peekMaxBytes: 64 * 1024,
  snippetChars: 160,
};
