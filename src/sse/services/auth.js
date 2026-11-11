import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, getModelLockKey, getEarliestModelLockUntil, MODEL_LOCK_PREFIX } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache, getAntigravityModelQuota } from "./antigravityQuota.js";
import {
  buildAccountBreakerName,
  isBlocked,
  getRetryAfterMs,
} from "open-sse/utils/circuitBreaker.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const requestedModel = options?.requestedModel || model;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, Antigravity quota-exhausted, and circuit-open connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      const enabled = c.providerSpecificData?.enabledModels;
      if (providerId === "codex" && Array.isArray(enabled) && enabled.length && requestedModel && !enabled.includes(requestedModel)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const connQuotas = antigravityQuotaCache.get(c.id);
        const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      // Per-model breaker. Without a model there is nothing account-wide to
      // consult, so the account stays eligible rather than being hidden by a
      // breaker that another model tripped.
      if (model) {
        const breakerName = buildAccountBreakerName({ provider: providerId, connectionId: c.id, model });
        if (isBlocked(breakerName)) return false;
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock, lazy Antigravity quota-cache reset, or OPEN-breaker retry.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const connQuotas = antigravityQuotaCache.get(c.id);
          const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
          const resetAt = quota?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      if (model) {
        for (const c of connections) {
          const breakerName = buildAccountBreakerName({ provider: providerId, connectionId: c.id, model });
          if (!isBlocked(breakerName)) continue;
          const ms = getRetryAfterMs(breakerName);
          if (ms > 0) expiries.push(new Date(Date.now() + ms).toISOString());
        }
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || 503
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);
  const providerId = resolveProviderId(provider);

  // `shouldFallback` and `applyCooldownOnly` do not depend on the backoff level,
  // so this pass only decides whether a write is warranted at all. The cooldown
  // and the level that are actually persisted are recomputed below from the row
  // as it is inside the write transaction: the snapshot above is stale as soon
  // as a concurrent failure has written its own escalation.
  let shouldFallback, cooldownMs, applyCooldownOnly;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = providerId === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
  } else {
    ({ shouldFallback, cooldownMs, applyCooldownOnly } =
      checkFallbackError(status, errorText, backoffLevel, providerId));
  }
  // `applyCooldownOnly`: the failure belongs to a resource every credential
  // shares (an upstream pool) or to a model the upstream will not serve at this
  // tier, so rotating accounts cannot help — the caller must stop the loop and
  // propagate the upstream error — but the wait the upstream asked for still has
  // to be recorded, otherwise this account keeps hitting a saturated pool with no
  // pause at all. Skipping the rotation while keeping the cooldown is the whole
  // point of the distinction. The flag never arrives together with
  // `shouldFallback: true` (invariant in checkFallbackError's JSDoc), so the two
  // returns below stay mutually exclusive.
  if (!shouldFallback && !applyCooldownOnly) return { shouldFallback: false, cooldownMs: 0 };
  if (!(cooldownMs > 0)) return { shouldFallback, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  // GitHub's monthly cap is account-wide, so it locks `modelLock___all`.
  const lockModel = githubResetAtMs ? null : model;
  const lockKey = getModelLockKey(lockModel);

  let applied = null;
  await updateProviderConnection(connectionId, (existing) => {
    const storedLevel = existing?.backoffLevel || 0;
    const now = Date.now();
    let level, waitMs;
    if (githubResetAtMs) {
      // Account-wide lock until the next UTC month: the ladder restarts after it.
      level = 0;
      waitMs = githubResetAtMs - now;
    } else if (resetsAtMs && resetsAtMs > now) {
      // The upstream stated the exact reset; the ladder restarts after it too.
      level = 0;
      waitMs = providerId === "antigravity"
        ? resetsAtMs - now
        : Math.min(resetsAtMs - now, MAX_RATE_LIMIT_COOLDOWN_MS);
    } else {
      const decision = checkFallbackError(status, errorText, storedLevel, providerId);
      waitMs = decision.cooldownMs;
      level = decision.newBackoffLevel ?? storedLevel;
      // One escalation per lock window. A failure that lands while this model is
      // already locked belongs to the same burst: it extends the wait but does
      // not advance the ladder again, and the stored level is never lowered.
      if (level > storedLevel && isModelLockActive(existing, lockModel)) level = storedLevel;
    }
    if (!(waitMs > 0)) return null;
    const storedUntil = new Date(existing?.[lockKey] || 0).getTime();
    // Never shorten a lock that is still active: take the later expiry.
    const until = Math.max(now + waitMs, Number.isFinite(storedUntil) ? storedUntil : 0);
    applied = { cooldownMs: until - now };
    return {
      [lockKey]: new Date(until).toISOString(),
      testStatus: "unavailable",
      lastError: reason,
      errorCode: status,
      lastErrorAt: new Date(now).toISOString(),
      backoffLevel: level
    };
  });

  const appliedCooldownMs = applied?.cooldownMs ?? cooldownMs;
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(appliedCooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback, cooldownMs: appliedCooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * The set of locks to clear and the "any active locks left?" decision are both
 * taken from the stored row inside the update transaction, so a lock written by
 * a concurrent request is neither cleared nor ignored. A per-model success does
 * NOT clear `modelLock___all`: account-wide locks (e.g. GitHub's monthly cap)
 * are not disproved by one model succeeding.
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const succeededKey = model ? getModelLockKey(model) : null;
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith(MODEL_LOCK_PREFIX));

  // Fast path only — the authoritative decision is taken from the stored row
  // inside the update below. Skipping here is safe: a lock written after this
  // snapshot is newer evidence than the success that triggered this call, and
  // must not be cleared by it.
  const snapshotClearable = allLockKeys.some(k =>
    (succeededKey && k === succeededKey) ||
    (conn[k] && new Date(conn[k]).getTime() <= now));
  if (!snapshotClearable && conn.testStatus !== "unavailable" && !conn.lastError) return;

  await updateProviderConnection(connectionId, (existing) => {
    const at = Date.now();
    const lockKeys = Object.keys(existing || {}).filter(k => k.startsWith(MODEL_LOCK_PREFIX));
    // Clear the scope that just succeeded plus every lock that already expired.
    // A lock another request wrote for a different model is NOT cleared: this
    // success says nothing about it. The account-wide lock is deliberately not
    // cleared by a per-model success either — it is set by account-wide
    // conditions (e.g. GitHub's monthly cap) that one model's success does not
    // disprove.
    const keysToClear = lockKeys.filter(k => {
      if (succeededKey && k === succeededKey) return true;
      const expiry = existing[k];
      return expiry && new Date(expiry).getTime() <= at;
    });

    // Reset the error state only when no lock is still active, judged from the
    // row being written — not from the request-time snapshot.
    const remainingActiveLocks = lockKeys.filter(k => {
      if (keysToClear.includes(k)) return false;
      const expiry = existing[k];
      return expiry && new Date(expiry).getTime() > at;
    });

    const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));
    if (remainingActiveLocks.length === 0) {
      Object.assign(clearObj, {
        testStatus: "active",
        lastError: null,
        errorCode: null,
        lastErrorAt: null,
        backoffLevel: 0
      });
    }

    return Object.keys(clearObj).length === 0 ? null : clearObj;
  });
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
