export const LOCAL_BALANCE_CURRENCIES = ["BRL", "USD"];
export const LOCAL_BALANCE_FX_MODES = ["manual", "auto"];
export const LOCAL_BALANCE_ENFORCEMENTS = ["track", "block"];

const ALLOWED_KEYS = new Set([
  "enabled",
  "currency",
  "initialAmount",
  "since",
  "fxMode",
  "fxRate",
  "fxMarkupPct",
  "enforcement",
  "stopAtPct",
]);

const MAX_FUTURE_DRIFT_MS = 5 * 60 * 1000;
const MAX_AMOUNT = 1e9;
const MAX_FX_RATE = 1000;

function toNum(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate and normalize `providerSpecificData.localBalance` payloads.
 * Pass `null` to remove the configuration cleanly.
 */
export function validateLocalBalancePatch(input, nowMs = Date.now()) {
  if (input === null) {
    return { valid: true, value: null };
  }
  if (!isPlainObject(input)) {
    return { valid: false, error: "localBalance must be an object or null" };
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { valid: false, error: `Invalid localBalance field: ${key}` };
    }
  }

  if (typeof input.enabled !== "boolean") {
    return { valid: false, error: "localBalance.enabled must be a boolean" };
  }

  const currency = input.currency === undefined ? "BRL" : String(input.currency);
  if (!LOCAL_BALANCE_CURRENCIES.includes(currency)) {
    return { valid: false, error: "localBalance.currency must be BRL or USD" };
  }

  const initialAmount =
    input.initialAmount === undefined && !input.enabled ? 0 : input.initialAmount;
  if (
    typeof initialAmount !== "number" ||
    !Number.isFinite(initialAmount) ||
    initialAmount < 0 ||
    initialAmount > MAX_AMOUNT
  ) {
    return {
      valid: false,
      error: "localBalance.initialAmount must be a finite number between 0 and 1e9",
    };
  }

  let sinceIso;
  if (input.since === undefined || input.since === null || input.since === "") {
    sinceIso = new Date(nowMs).toISOString();
  } else if (typeof input.since !== "string") {
    return { valid: false, error: "localBalance.since must be an ISO timestamp string" };
  } else {
    const parsedMs = Date.parse(input.since);
    if (!Number.isFinite(parsedMs) || parsedMs > nowMs + MAX_FUTURE_DRIFT_MS) {
      return {
        valid: false,
        error: "localBalance.since must be a valid timestamp not in the future",
      };
    }
    sinceIso = new Date(parsedMs).toISOString();
  }

  const fxMode = input.fxMode === undefined ? "manual" : String(input.fxMode);
  if (!LOCAL_BALANCE_FX_MODES.includes(fxMode)) {
    return { valid: false, error: "localBalance.fxMode must be manual or auto" };
  }

  let fxRate;
  if (currency === "USD") {
    if (input.fxRate === undefined || input.fxRate === null) {
      fxRate = 1;
    } else if (
      typeof input.fxRate !== "number" ||
      !Number.isFinite(input.fxRate) ||
      input.fxRate <= 0 ||
      input.fxRate >= MAX_FX_RATE
    ) {
      return {
        valid: false,
        error: "localBalance.fxRate must be a finite positive number below 1000",
      };
    } else {
      fxRate = input.fxRate;
    }
  } else if (input.fxRate === undefined || input.fxRate === null) {
    if (input.enabled) {
      return {
        valid: false,
        error: "localBalance.fxRate is required when currency is BRL",
      };
    }
    fxRate = 1;
  } else if (
    typeof input.fxRate !== "number" ||
    !Number.isFinite(input.fxRate) ||
    input.fxRate <= 0 ||
    input.fxRate >= MAX_FX_RATE
  ) {
    return {
      valid: false,
      error: "localBalance.fxRate must be a finite positive number below 1000",
    };
  } else {
    fxRate = input.fxRate;
  }

  const fxMarkupPct = input.fxMarkupPct === undefined ? 0 : input.fxMarkupPct;
  if (
    typeof fxMarkupPct !== "number" ||
    !Number.isFinite(fxMarkupPct) ||
    fxMarkupPct < 0 ||
    fxMarkupPct > 100
  ) {
    return {
      valid: false,
      error: "localBalance.fxMarkupPct must be a finite number between 0 and 100",
    };
  }

  const enforcement = input.enforcement === undefined ? "track" : String(input.enforcement);
  if (!LOCAL_BALANCE_ENFORCEMENTS.includes(enforcement)) {
    return { valid: false, error: "localBalance.enforcement must be track or block" };
  }

  const stopAtPct = input.stopAtPct === undefined ? 100 : input.stopAtPct;
  if (!Number.isInteger(stopAtPct) || stopAtPct < 1 || stopAtPct > 100) {
    return {
      valid: false,
      error: "localBalance.stopAtPct must be an integer between 1 and 100",
    };
  }

  return {
    valid: true,
    value: {
      enabled: input.enabled,
      currency,
      initialAmount,
      since: sinceIso,
      fxMode,
      fxRate,
      fxMarkupPct,
      enforcement,
      stopAtPct,
    },
  };
}

/**
 * True when a connection (or its providerSpecificData) has an enabled local balance.
 */
export function hasLocalBalanceConfigured(connOrPsd) {
  const lb = connOrPsd?.providerSpecificData?.localBalance ?? connOrPsd?.localBalance;
  return Boolean(
    lb &&
      lb.enabled === true &&
      Number.isFinite(Number(lb.initialAmount)) &&
      Number(lb.initialAmount) >= 0
  );
}

/**
 * Effective USD -> target currency multiplier including optional markup/spread.
 */
export function effectiveFxMultiplier(config, liveRate = null) {
  if (!config || config.currency === "USD") return 1;
  const live = Number(liveRate);
  const stored = Number(config.fxRate);
  const base =
    config.fxMode === "auto" && Number.isFinite(live) && live > 0 && live < MAX_FX_RATE
      ? live
      : stored;
  if (!Number.isFinite(base) || base <= 0) return 1;
  const markup = Math.max(0, toNum(config.fxMarkupPct, 0));
  return base * (1 + markup / 100);
}

function formatAmount(value, currency) {
  try {
    return Number(value || 0).toLocaleString("pt-BR", {
      style: "currency",
      currency,
    });
  } catch {
    return `${currency} ${Number(value || 0).toFixed(2)}`;
  }
}

/**
 * Pure calculation of spent/remaining balance, exhaustion flag, and display strings.
 */
export function computeLocalBalanceSnapshot(
  config,
  spentUsd,
  { liveRate = null, unpricedCount = 0, historyPruned = false } = {}
) {
  const currency = config?.currency === "USD" ? "USD" : "BRL";
  const multiplier = effectiveFxMultiplier(config, liveRate);
  const safeSpentUsd = Math.max(0, toNum(spentUsd, 0));
  const spent = safeSpentUsd * multiplier;
  const total = Math.max(0, toNum(config?.initialAmount, 0));
  const remaining = Math.max(0, total - spent);
  const usedPct = total > 0 ? (spent / total) * 100 : 100;
  const remainingPct = total > 0 ? Math.max(0, (remaining / total) * 100) : 0;
  const stopAtPct = Math.min(100, Math.max(1, Math.round(toNum(config?.stopAtPct, 100))));
  const enforcement = config?.enforcement === "block" ? "block" : "track";
  const exhausted = enforcement === "block" && (total <= 0 || usedPct >= stopAtPct);
  const quotaKey = `Saldo (${currency})`;

  const usedLiveFx =
    currency === "BRL" &&
    config?.fxMode === "auto" &&
    Number.isFinite(Number(liveRate)) &&
    Number(liveRate) > 0;
  const planParts = [`Local ${currency}`];
  if (currency === "BRL") {
    const baseRate = usedLiveFx ? Number(liveRate) : toNum(config?.fxRate, 1);
    const markup = Math.max(0, toNum(config?.fxMarkupPct, 0));
    const rateText = `1 USD = R$ ${multiplier.toFixed(2)}`;
    const fxLabel = usedLiveFx ? `${rateText}, auto` : `${rateText}, fixo`;
    planParts.push(markup > 0 ? `${fxLabel} +${markup}%` : fxLabel);
    if (usedLiveFx && baseRate !== multiplier && markup === 0) {
      // keep concise
    }
  }
  if (enforcement === "block") {
    planParts.push(stopAtPct < 100 ? `pausa em ${stopAtPct}%` : "pausa em 100%");
  }

  const notices = [];
  if (exhausted) {
    notices.push(
      `Saldo local atingiu o limite (${usedPct.toFixed(0)}% de ${formatAmount(total, currency)}).`
    );
  }
  if (unpricedCount > 0) {
    notices.push(
      `${unpricedCount} requisição(ões) sem preço no catálogo ($0 estimado).`
    );
  }
  if (historyPruned) {
    notices.push(
      "USAGE_RETENTION_DAYS ativo: dias antigos somados via resumo diário (usageDaily)."
    );
  }

  const summary = `Local balance exhausted (${formatAmount(spent, currency)} / ${formatAmount(total, currency)})`;

  return {
    currency,
    quotaKey,
    multiplier,
    spentUsd: safeSpentUsd,
    spent,
    total,
    remaining,
    usedPct,
    remainingPct,
    stopAtPct,
    enforcement,
    exhausted,
    usedLiveFx,
    plan: planParts.join(" · "),
    notice: notices.length > 0 ? notices.join(" ") : null,
    summary,
  };
}
