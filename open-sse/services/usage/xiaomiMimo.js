import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { balance, quotaError, num, QUOTA_REQUEST_TIMEOUT_MS } from "./quotaShared.js";

export function parseMimo(body) {
  const data = body?.data || body?.result || body;
  if (!data || typeof data !== "object") return null;
  const bal = num(data.balance);
  if (!Number.isFinite(bal)) return null;
  const currency = String(data.currency || "USD").toUpperCase();
  const quotas = {
    [`Available balance (${currency})`]: balance(bal),
  };
  const cash = num(data.cashBalance);
  const gift = num(data.giftBalance);
  if (Number.isFinite(cash) && cash > 0) {
    quotas[`Paid balance (${currency})`] = balance(cash);
  }
  if (Number.isFinite(gift) && gift > 0) {
    quotas[`Granted balance (${currency})`] = balance(gift);
  }
  return { plan: "API balance", quotas };
}

export async function cookieGet(url, cookie, proxyOptions) {
  try {
    const response = await proxyAwareFetch(
      url,
      {
        method: "GET",
        headers: {
          Cookie: cookie,
          Accept: "application/json",
          Origin: "https://platform.xiaomimimo.com",
          Referer: "https://platform.xiaomimimo.com/#/console/balance",
          "User-Agent": "Mozilla/5.0",
        },
        signal: AbortSignal.timeout(QUOTA_REQUEST_TIMEOUT_MS),
      },
      proxyOptions,
    );
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err?.name === "AbortError" || err?.name === "TimeoutError" ? "timeout" : "request failed",
    };
  }
}

export async function getXiaomiMimoUsage(providerSpecificData, proxyOptions) {
  const cookie =
    providerSpecificData?.quotaCookie ||
    providerSpecificData?.cookie ||
    process.env.MIMO_QUOTA_COOKIE;

  if (!cookie) {
    return {
      message:
        "MiMo balance requires the console cookie in MIMO_QUOTA_COOKIE or providerSpecificData.quotaCookie.",
      quotas: {},
    };
  }

  const res = await cookieGet("https://platform.xiaomimimo.com/api/v1/balance", cookie, proxyOptions);
  if (!res.ok) return quotaError(res, "MiMo");

  const parsed = parseMimo(res.body);
  return parsed || { message: "MiMo connected. No balance data was returned.", quotas: {} };
}
