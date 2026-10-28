import { proxyAwareFetch } from "../../utils/proxyFetch.js";

export function num(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function resetAt(value) {
  if (!value || typeof value === "boolean" || Array.isArray(value)) return null;
  if (typeof value === "object" && !(value instanceof Date)) return null;
  if (Number(value) === 0) return null;
  const n = Number(value);
  const val = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : value;
  const date = new Date(val);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function formatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

export function quota(used, total, resetAtVal = null) {
  const safeUsed = Math.max(0, num(used, 0));
  const safeTotal = Math.max(0, num(total, 0));
  const remaining = Math.max(0, safeTotal - safeUsed);
  return {
    used: safeUsed,
    total: safeTotal,
    remainingPercentage: safeTotal > 0 ? (remaining / safeTotal) * 100 : 0,
    resetAt: resetAt(resetAtVal),
    unlimited: false,
  };
}

export function balance(amount, resetAtVal = null) {
  const safeBalance = Math.max(0, num(amount, 0));
  return {
    used: 0,
    total: safeBalance,
    remainingPercentage: safeBalance > 0 ? 100 : 0,
    resetAt: resetAt(resetAtVal),
    unlimited: false,
  };
}

export function localQuota(used, limit) {
  const safeUsed = Math.max(0, num(used, 0));
  const safeLimit = Math.max(0, num(limit, 0));
  if (safeLimit > 0) {
    const remaining = Math.max(0, safeLimit - safeUsed);
    return {
      used: safeUsed,
      total: safeLimit,
      remainingPercentage: (remaining / safeLimit) * 100,
      resetAt: null,
      unlimited: false,
    };
  }
  return {
    used: safeUsed,
    total: 0,
    resetAt: null,
    unlimited: true,
  };
}

export async function getJson(url, token, proxyOptions, extraHeaders = null) {
  try {
    const headers = {
      Accept: "application/json",
      ...(extraHeaders || {}),
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await proxyAwareFetch(url, { method: "GET", headers }, proxyOptions);
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err?.name === "AbortError" ? "timeout" : "request failed",
    };
  }
}

export function quotaError(result, label) {
  const statusStr = result?.status
    ? `error (${result.status}).`
    : `${result?.error || "request failed"}.`;
  return {
    message: `${label} quota API ${statusStr}`,
    quotas: {},
  };
}
