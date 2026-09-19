import { getJson, quotaError, quota, balance, formatDate, num } from "./quotaShared.js";

// credits.monthlyCredits is remaining, not the plan grant. Totals come from
// https://commandcode.ai/docs/resources/pricing-limits keyed by planId.
export function commandCodeMonthlyTotal(planId) {
  const totals = {
    "individual-go": 10,
    "individual-goat": 70,
    "individual-pro": 80,
    "individual-pro-v1": 80,
    "individual-provider": 15,
    "individual-max": 150,
    "individual-max-10x": 150,
    "individual-ultra": 300,
    "individual-max-20x": 300,
    "teams-pro": 40,
    "team-pro": 40,
  };
  return num(totals[String(planId || "").toLowerCase()], 0);
}

// Display names for plan ids whose brand spelling the generic title-casing below
// would get wrong (GOAT, Max 10×/20×). Taken from the official collector.
const PLAN_NAMES = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-max-10x": "Max 10×",
  "individual-ultra": "Ultra",
  "individual-max-20x": "Max 20×",
  "teams-pro": "Teams Pro",
  "team-pro": "Teams Pro",
};

export function parseCommandCode(body, subscriptionBody = null) {
  const credits = body?.credits || {};
  const limits = body?.windowLimits || {};
  const subscription = subscriptionBody?.data || subscriptionBody || {};
  const renewalAt = subscription.currentPeriodEnd || null;
  const renewalDate = formatDate(renewalAt);
  const quotas = {};
  const remaining = num(credits.monthlyCredits, 0);
  const monthlyTotal = commandCodeMonthlyTotal(subscription.planId);
  const purchased = num(credits.purchasedCredits, 0);
  const free = num(credits.freeCredits, 0);
  if (monthlyTotal > 0 || remaining > 0) {
    const monthlyName = renewalDate
      ? `Monthly credits (USD) - renews ${renewalDate}`
      : "Monthly credits (USD)";
    quotas[monthlyName] = monthlyTotal > 0
      ? quota(monthlyTotal - remaining, monthlyTotal, renewalAt)
      : balance(remaining, renewalAt);
  }
  if (purchased > 0) quotas["Purchased credits (USD)"] = balance(purchased);
  if (free > 0) quotas["Free credits (USD)"] = balance(free);

  const fiveHour = limits.fiveHour;
  if (fiveHour && num(fiveHour.cap, 0) > 0) {
    quotas["5 hour window (USD)"] = quota(
      fiveHour.used,
      fiveHour.cap,
      fiveHour.resetAt,
    );
  }
  const weekly = limits.weekly;
  if (weekly && num(weekly.cap, 0) > 0) {
    quotas["7 day window (USD)"] = quota(
      weekly.used,
      weekly.cap,
      weekly.resetAt,
    );
  }
  if (!Object.keys(quotas).length) return null;
  const planId = String(subscription.planId || "");
  const plan = PLAN_NAMES[planId.toLowerCase()] || (planId
    ? planId
        .replace(/^individual-/, "")
        .replace(/^teams-/, "Teams ")
        .replace(/(^|[- ])\w/g, (match) => match.toUpperCase().replace("-", " "))
    : limits.limited === false
      ? "Pay as you go"
      : "Subscription");
  return { plan, quotas };
}

export async function getCommandCodeUsage(apiKey, proxyOptions) {
  if (!apiKey) {
    return { message: "CommandCode API key not available.", quotas: {} };
  }

  const base = "https://api.commandcode.ai";
  // Billing is scoped to an org: without the orgId a Teams member reads their
  // personal (empty) wallet instead of the team pool. whoami is best-effort —
  // only an auth failure there is conclusive (official collector behaviour).
  const whoami = await getJson(`${base}/alpha/whoami?limits=1`, apiKey, proxyOptions);
  if (whoami.status === 401 || whoami.status === 403) return authError();
  const orgId = whoami.ok ? whoami.body?.org?.id : null;
  const scoped = (route) => (orgId ? `${base}${route}?orgId=${encodeURIComponent(orgId)}` : `${base}${route}`);

  const [creditsRes, subRes] = await Promise.all([
    getJson(scoped("/alpha/billing/credits"), apiKey, proxyOptions),
    getJson(scoped("/alpha/billing/subscriptions"), apiKey, proxyOptions),
  ]);

  if (creditsRes.status === 401 || creditsRes.status === 403) return authError();
  if (!creditsRes.ok) return quotaError(creditsRes, "CommandCode");

  const parsed = parseCommandCode(creditsRes.body, subRes.ok ? subRes.body : null);
  return parsed || { message: "CommandCode connected. No quota data was returned.", quotas: {} };
}

function authError() {
  return { message: "CommandCode authentication failed. Check the API key.", quotas: {} };
}
