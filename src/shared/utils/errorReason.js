// Turns a raw provider error (status code, JSON body, HTML error page, network
// failure text) into the standard reason behind it, so the dashboard can show
// "Out of credits" instead of `[402]: {"error": "..."}`. Dashboard-only: the
// /v1 API keeps returning the provider's own status and message untouched.
//
// Pure and dependency-free (runs in the browser and on the server). Titles and
// hints are English source strings; the UI passes them through translate().

export const ERROR_REASONS = {
  invalid_key: {
    title: "Invalid or expired credentials",
    hint: "Check the API key or reconnect the account.",
  },
  no_credits: {
    title: "Out of credits",
    hint: "Top up credits or billing at the provider.",
  },
  quota_exceeded: {
    title: "Plan usage limit reached",
    hint: "Wait for the quota to reset or upgrade the plan.",
  },
  rate_limited: {
    title: "Too many requests (rate limit)",
    hint: "The provider is throttling this account; it recovers on its own.",
  },
  model_not_found: {
    title: "Model not found",
    hint: "The provider does not serve this model id (renamed or retired).",
  },
  model_not_supported: {
    title: "Model not available for this account",
    hint: "The account or plan cannot use this model.",
  },
  subscription_required: {
    title: "Subscription or activation required",
    hint: "Activate the product, plan or deposit the provider asks for.",
  },
  model_unavailable: {
    title: "Model temporarily unavailable",
    hint: "The provider paused this model (maintenance or outage); use another or wait.",
  },
  endpoint_not_found: {
    title: "Endpoint not found at the provider",
    hint: "The provider URL is wrong or its API changed.",
  },
  forbidden: {
    title: "Access denied by the provider",
    hint: "Blocked by region, IP, firewall or plan permissions.",
  },
  context_too_long: {
    title: "Request too long for the model",
    hint: "Shorten the conversation or use a model with a larger context.",
  },
  content_filtered: {
    title: "Blocked by the content filter",
    hint: "The provider's safety filter refused this prompt or response.",
  },
  upstream_down: {
    title: "Provider unavailable",
    hint: "The provider is failing or overloaded; try again later.",
  },
  timeout: {
    title: "Provider timed out",
    hint: "The provider took too long to answer.",
  },
  network: {
    title: "Could not reach the provider",
    hint: "Network or DNS failure between 9Router and the provider.",
  },
  client_outdated: {
    title: "Client version out of date",
    hint: "The provider requires a newer client version.",
  },
  bad_request: {
    title: "Request rejected by the provider",
    hint: "The provider refused the request; see the details.",
  },
};

// Text rules, checked in order: the more specific reason comes first
// (e.g. "Credits exhausted" arriving as a 429 is a credit problem, and
// "Could not verify credentials — Model not supported" is a model problem).
const TEXT_RULES = [
  ["client_outdated", /\bout of date\b|\boutdated\b|(update|upgrade) (your |the )?(cli|client)\b|minimum (client )?version/i],
  ["subscription_required", /subscription (is )?required|not activated|activate (the )?product|deposit required|requires? an? (active )?(paid )?(plan|subscription)/i],
  ["model_unavailable", /model is (currently )?unavailable|in maintenance|model_maintenance|model (is )?(temporarily )?(offline|paused|disabled)/i],
  ["endpoint_not_found", /page not found|endpoint not found|route not found|no route (matched|found)|unknown (endpoint|route)/i],
  ["context_too_long", /context[ _]length|maximum context|context window|prompt is too long|input is too long|too many (input )?tokens/i],
  ["content_filtered", /content[ _](policy|filter|management)|safety (filter|system)|flagged by|moderation/i],
  // "not your personal quota": a provider-wide free pool is full, not this account.
  ["upstream_down", /capacity is (currently )?full|not your personal quota|no_available_channel|cannot be served at the moment/i],
  ["no_credits", /free quota (has been |is )?exhausted|add funds|credit|insufficient[ _](balance|funds|quota)|\bbalance\b|payment required|billing|top[ -]?up|add-on packs/i],
  ["quota_exceeded", /usage limit|quota|monthly limit|daily limit|limit for your plan|plan limit/i],
  ["rate_limited", /rate[ _-]?limit|too many requests|slow down|requests per (minute|second|day)/i],
  ["model_not_supported", /model[^.]{0,80}not (supported|available|allowed|enabled)|unsupported model|not available (for|on) (your|this) (plan|account)|(does not|doesn't) have access to (this|the) model/i],
  ["model_not_found", /model[^.]{0,80}(not found|does not exist|doesn't exist|not a valid model|no such model)|unknown model|invalid model|model_not_found/i],
  ["invalid_key", /api[ _-]?key|access token|unauthori[sz]ed|authentication|invalid[ _]grant|token (has )?expired|expired token|could not verify credentials|invalid credentials|not authenticated/i],
  ["forbidden", /forbidden|access denied|permission denied|not allowed|\bregion\b|\bcountry\b|geo-?block/i],
  ["timeout", /timed? ?out|timeout|ETIMEDOUT|deadline exceeded|no output within/i],
  ["network", /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|fetch failed|network error|UND_ERR/i],
  ["upstream_down", /ended without any output|empty response|overloaded|service unavailable|temporarily unavailable|bad gateway|internal server error|server[ _]error|upstream request failed|try again later|\bcapacity\b/i],
];

function statusReason(status) {
  if (status === 401) return "invalid_key";
  if (status === 402) return "no_credits";
  if (status === 403) return "forbidden";
  if (status === 404) return "model_not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 413) return "context_too_long";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status < 600) return "upstream_down";
  if (status === 400 || status === 422) return "bad_request";
  return null;
}

function toStatus(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 100 && n < 600 ? n : null;
}

// Pull a readable message and a status out of whatever was stored.
function normalize(input, explicitStatus) {
  let status = toStatus(explicitStatus);
  let text = "";
  if (input && typeof input === "object") {
    status = status ?? toStatus(input.status ?? input.statusCode ?? input.code ?? input.error?.code);
    const inner = input.error && typeof input.error === "object" ? input.error : null;
    text = String(inner?.message ?? input.message ?? input.error ?? input.lastError ?? "");
  } else {
    text = String(input ?? "");
  }
  // Some stores keep only the status (combo member stats): describe the code.
  const raw = text.trim() || (status ? `HTTP ${status}` : "");
  if (!raw) return null;

  // "[402]: ...", "HTTP 401: ...", "ERROR 429 · ..."
  const prefix = raw.match(/^\s*(?:\[(\d{3})\]|HTTP (\d{3})|ERROR (\d{3})|(\d{3})(?= [A-Za-z]))/i);
  if (prefix) status = status ?? toStatus(prefix[1] || prefix[2] || prefix[3] || prefix[4]);

  // HTML error page: read its <title> (or first <h1>) — "403 Forbidden".
  let detail = "";
  if (/<html|<!doctype html|<head>|<body/i.test(raw)) {
    const title = raw.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || raw.match(/<h1[^>]*>([^<]{1,200})<\/h1>/i);
    detail = title ? title[1].trim() : "";
    const pageStatus = detail.match(/^(\d{3})\b/);
    if (pageStatus) status = toStatus(pageStatus[1]) ?? status;
  }
  return { raw, status, detail };
}

/**
 * @param {string|object|null} input  stored error text, or {status, message} / {error:{message,code}}
 * @param {number} [status]           HTTP status when known separately (errorCode, testStatus code)
 * @returns {{reason: string|null, title: string|null, hint: string|null, status: number|null, detail: string, raw: string}|null}
 *   null when there is no error at all; reason null when the text matches no standard reason.
 */
export function describeProviderError(input, status) {
  const n = normalize(input, status);
  if (!n) return null;
  const haystack = n.detail ? `${n.detail} ${n.raw}` : n.raw;
  let reason = null;
  for (const [key, pattern] of TEXT_RULES) {
    if (pattern.test(haystack)) { reason = key; break; }
  }
  // An HTML error page is identified by its status, not by stray words in it.
  if (n.detail && statusReason(n.status)) reason = statusReason(n.status);
  reason = reason ?? statusReason(n.status);
  const info = reason ? ERROR_REASONS[reason] : null;
  return {
    reason,
    title: info?.title ?? null,
    hint: info?.hint ?? null,
    status: n.status,
    detail: n.detail,
    raw: n.raw,
  };
}
