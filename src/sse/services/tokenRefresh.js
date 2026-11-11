// Re-export from open-sse with local logger
import * as log from "../utils/logger.js";
import { getProviderConnectionById, updateProviderConnection } from "../../lib/localDb.js";
import {
  getProjectIdForConnection,
  invalidateProjectId,
  removeConnection,
} from "open-sse/services/projectId.js";
import {
  TOKEN_EXPIRY_BUFFER_MS as BUFFER_MS,
  refreshAccessToken as _refreshAccessToken,
  refreshClaudeOAuthToken as _refreshClaudeOAuthToken,
  refreshGoogleToken as _refreshGoogleToken,
  refreshCodexToken as _refreshCodexToken,
  refreshIflowToken as _refreshIflowToken,
  refreshGitHubToken as _refreshGitHubToken,
  refreshCopilotToken as _refreshCopilotToken,
  getAccessToken as _getAccessToken,
  refreshTokenByProvider as _refreshTokenByProvider,
  formatProviderCredentials as _formatProviderCredentials,
  getAllAccessTokens as _getAllAccessTokens,
  refreshKiroToken as _refreshKiroToken,
  refreshNousToken as _refreshNousToken,
  getRefreshLeadMs as _getRefreshLeadMs
} from "open-sse/services/tokenRefresh.js";
import {
  refreshProviderCredentials as _refreshProviderCredentials,
  shouldRefreshCredentials as _shouldRefreshCredentials,
  withCredentialRefreshLock,
} from "open-sse/services/oauthCredentialManager.js";

export const TOKEN_EXPIRY_BUFFER_MS = BUFFER_MS;

// A rotated refresh token that cannot be persisted is a credential-loss risk:
// the next refresh would send a dead RT (invalid_grant → re-login). Retry the
// DB write a few times before giving up loudly.
const CREDENTIAL_PERSIST_ATTEMPTS = 3;
const CREDENTIAL_PERSIST_RETRY_DELAY_MS = 100;

// ─── Re-exports wrapped with local logger ─────────────────────────────────────

export const refreshAccessToken = (provider, refreshToken, credentials) =>
  _refreshAccessToken(provider, refreshToken, credentials, log);

export const refreshClaudeOAuthToken = (refreshToken) =>
  _refreshClaudeOAuthToken(refreshToken, log);

export const refreshGoogleToken = (refreshToken, clientId, clientSecret) =>
  _refreshGoogleToken(refreshToken, clientId, clientSecret, log);

export const refreshCodexToken = (refreshToken) =>
  _refreshCodexToken(refreshToken, log);

export const refreshIflowToken = (refreshToken) =>
  _refreshIflowToken(refreshToken, log);

export const refreshGitHubToken = (refreshToken) =>
  _refreshGitHubToken(refreshToken, log);

export const refreshCopilotToken = (githubAccessToken) =>
  _refreshCopilotToken(githubAccessToken, log);

export const refreshKiroToken = (refreshToken, providerSpecificData) =>
  _refreshKiroToken(refreshToken, providerSpecificData, log);

export const refreshNousToken = (refreshToken) =>
  _refreshNousToken(refreshToken, log);

export const getAccessToken = (provider, credentials) =>
  _getAccessToken(provider, credentials, log);

export const refreshTokenByProvider = (provider, credentials) =>
  _refreshTokenByProvider(provider, credentials, log);

export const formatProviderCredentials = (provider, credentials) =>
  _formatProviderCredentials(provider, credentials, log);

export const getAllAccessTokens = (userInfo) =>
  _getAllAccessTokens(userInfo, log);

export const shouldRefreshCredentials = (provider, credentials) =>
  _shouldRefreshCredentials(provider, credentials);

// ─── Lifecycle hook ───────────────────────────────────────────────────────────

/**
 * Call this when a connection is fully closed / removed.
 * Aborts any in-flight projectId fetch and evicts its cache entry,
 * preventing the module-level Maps from accumulating stale entries.
 *
 * @param {string} connectionId
 */
export function releaseConnection(connectionId) {
  if (!connectionId) return;
  removeConnection(connectionId);
  log.debug("TOKEN_REFRESH", "Released connection resources", { connectionId });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute an ISO expiry timestamp from a relative expiresIn (seconds).
 * @param {number} expiresIn
 * @returns {string}
 */
function toExpiresAt(expiresIn) {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Providers that carry a real Google project ID.
 * @param {string} provider
 * @returns {boolean}
 */
function needsProjectId(provider) {
  return provider === "antigravity" || provider === "gemini-cli";
}

/**
 * Non-blocking: fetch the project ID for a connection after a token refresh and
 * persist it to localDb.  Invalidates the stale cached value first so the fetch
 * always retrieves a fresh one.
 *
 * @param {string} provider
 * @param {string} connectionId
 * @param {string} accessToken
 */
function _refreshProjectId(provider, connectionId, accessToken) {
  if (!needsProjectId(provider) || !connectionId || !accessToken) return;

  // Invalidate the stale cached entry so getProjectIdForConnection does a real fetch
  invalidateProjectId(connectionId);

  // Lazy resolution: Do not eagerly trigger onboardUser during background token refresh.
  // Eagerly fetching projectId across multiple accounts simultaneously triggers Google Cloud anti-abuse / rate limits.
  // Runtime handlers (e.g. chat handler) will lazily call getProjectIdForConnection() on demand.
  if (process.env.EAGER_PROJECT_ID_REFRESH === "true") {
    getProjectIdForConnection(connectionId, accessToken, provider)
      .then((projectId) => {
        if (!projectId) return;
        updateProviderCredentials(connectionId, { projectId }).catch((err) => {
          log.debug("TOKEN_REFRESH", "Failed to persist refreshed projectId", {
            connectionId,
            error: err?.message ?? err,
          });
        });
      })
      .catch((err) => {
        log.debug("TOKEN_REFRESH", "Failed to fetch projectId after token refresh", {
          connectionId,
          error: err?.message ?? err,
        });
      });
  }
}

// ─── Local-specific: persist credentials to localDb ──────────────────────────

/**
 * Persist updated credentials for a connection to localDb.
 * Only fields that are present in `newCredentials` are written.
 *
 * @param {string} connectionId
 * @param {object} newCredentials
 * @returns {Promise<boolean>}
 */
export async function updateProviderCredentials(connectionId, newCredentials) {
  try {
    const updates = {};

    if (newCredentials.accessToken)         updates.accessToken  = newCredentials.accessToken;
    if (newCredentials.refreshToken)        updates.refreshToken = newCredentials.refreshToken;
    if (newCredentials.apiKey)              updates.apiKey       = newCredentials.apiKey;
    if (newCredentials.idToken)             updates.idToken = newCredentials.idToken;
    if (newCredentials.lastRefreshAt)       updates.lastRefreshAt = newCredentials.lastRefreshAt;
    if (newCredentials.expiresAt)           updates.expiresAt = newCredentials.expiresAt;
    if (newCredentials.expiresIn) {
      updates.expiresAt = toExpiresAt(newCredentials.expiresIn);
      updates.expiresIn = newCredentials.expiresIn;
    } else if (newCredentials.expiresAt) {
      const expiresAt = normalizeExpiresAt(newCredentials.expiresAt);
      if (expiresAt) {
        updates.expiresAt = expiresAt;
        updates.expiresIn = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      }
    }
    if (newCredentials.providerSpecificData) {
      updates.providerSpecificData = {
        ...(newCredentials.existingProviderSpecificData || {}),
        ...newCredentials.providerSpecificData,
      };
    }
    if (newCredentials.copilotToken || newCredentials.copilotTokenExpiresAt) {
      updates.providerSpecificData = {
        ...(updates.providerSpecificData || newCredentials.existingProviderSpecificData || {}),
        ...(newCredentials.copilotToken ? { copilotToken: newCredentials.copilotToken } : {}),
        ...(newCredentials.copilotTokenExpiresAt ? { copilotTokenExpiresAt: newCredentials.copilotTokenExpiresAt } : {}),
      };
    }
    if (newCredentials.projectId)            updates.projectId = newCredentials.projectId;

    const result = await updateProviderConnection(connectionId, updates);
    log.info("TOKEN_REFRESH", "Credentials updated in localDb", {
      connectionId,
      success: !!result
    });
    return !!result;
  } catch (error) {
    log.error("TOKEN_REFRESH", "Error updating credentials in localDb", {
      connectionId,
      error: error.message,
    });
    return false;
  }
}

// ─── Local-specific: proactive token refresh ─────────────────────────────────

/**
 * Adopt a newer token set from the DB. Another refresh may have rotated the
 * refresh token; replaying a stale one revokes the whole session.
 * @param {object} creds
 * @returns {Promise<object>}
 */
async function adoptLatestDbTokens(creds) {
  if (!creds.connectionId) return creds;
  const latest = await getProviderConnectionById(creds.connectionId).catch(() => null);
  const latestRefreshMs = Date.parse(latest?.lastRefreshAt || "");
  const credsRefreshMs = Date.parse(creds.lastRefreshAt || "");
  const dbIsNewer = Number.isFinite(latestRefreshMs)
    && (!Number.isFinite(credsRefreshMs) || latestRefreshMs > credsRefreshMs);
  if (dbIsNewer && latest.refreshToken && latest.refreshToken !== creds.refreshToken) {
    return {
      ...creds,
      refreshToken: latest.refreshToken,
      accessToken: latest.accessToken || creds.accessToken,
      expiresAt: latest.expiresAt || latest.tokenExpiresAt || creds.expiresAt,
      lastRefreshAt: latest.lastRefreshAt || creds.lastRefreshAt,
    };
  }
  return creds;
}

/**
 * Persist refreshed credentials with a bounded retry. Returns false only after
 * the last attempt fails; the caller keeps the fresh access token for this
 * request but must surface the credential-loss risk.
 * @returns {Promise<boolean>}
 */
async function persistRefreshedCredentials(provider, connectionId, mergedCreds) {
  if (!connectionId) return true;
  for (let attempt = 1; attempt <= CREDENTIAL_PERSIST_ATTEMPTS; attempt++) {
    if (await updateProviderCredentials(connectionId, mergedCreds)) return true;
    if (attempt < CREDENTIAL_PERSIST_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, CREDENTIAL_PERSIST_RETRY_DELAY_MS * attempt));
    }
  }
  log.error("TOKEN_REFRESH", "CREDENTIAL LOSS RISK: rotated refresh token could not be persisted after retries; the next refresh may fail with invalid_grant and require re-login", {
    provider,
    connectionId,
    attempts: CREDENTIAL_PERSIST_ATTEMPTS,
  });
  return false;
}

/**
 * Check whether the provider token (and, for GitHub, the Copilot token) is
 * about to expire and refresh it proactively.
 *
 * @param {string} provider
 * @param {object} credentials
 * @param {{ force?: boolean }} [options]  force=true skips the on-request lead check
 *   (used by background scheduler which applies a larger lead). Request path omits this.
 * @returns {Promise<object>} updated credentials object
 */
export async function checkAndRefreshToken(provider, credentials, options = {}) {
  let creds = { ...credentials };
  if (!creds.connectionId && creds.id) {
    creds.connectionId = creds.id;
  }

  // Adopt latest DB tokens (best effort): OpenAI rotates the refresh token on
  // every refresh, and refreshing with a stale snapshot (reuse) revokes the
  // whole session → account logout. The authoritative re-read happens again
  // inside the single-flight lock below.
  creds = await adoptLatestDbTokens(creds);

  const force = options?.force === true;

  // ── 1. Regular access-token expiry ────────────────────────────────────────
  if (force || _shouldRefreshCredentials(provider, creds)) {
    // Re-read INSIDE the lock: another refresh can complete between the read
    // above and this acquisition, and replaying its (now dead) RT would revoke
    // the session. When another refresh is already in flight the lock returns
    // that refresh's result instead of running this callback.
    const refreshed = await withCredentialRefreshLock(provider, creds, async () => {
      creds = await adoptLatestDbTokens(creds);

      // The concurrent refresh already made this credential fresh.
      if (!force && !_shouldRefreshCredentials(provider, creds)) {
        return creds;
      }

      const expiresAt = creds.expiresAt ? new Date(creds.expiresAt).getTime() : null;
      const remaining = expiresAt ? expiresAt - Date.now() : null;
      const refreshLead = _getRefreshLeadMs(provider);

      log.info("TOKEN_REFRESH", "Refreshing provider credentials proactively", {
        provider,
        expiresIn: remaining === null ? null : Math.round(remaining / 1000),
        refreshLeadMs: refreshLead,
        lastRefreshAt: creds.lastRefreshAt || null,
      });

      const newCreds = await _refreshProviderCredentials(provider, creds, log);
      if (!(newCreds?.accessToken || newCreds?.apiKey || newCreds?.copilotToken)) {
        return null;
      }

      const mergedCreds = {
        ...newCreds,
        existingProviderSpecificData: creds.providerSpecificData,
      };

      // Persist the rotated token; a failure is retried, then surfaced.
      const persisted = await persistRefreshedCredentials(provider, creds.connectionId, mergedCreds);

      creds = {
        ...creds,
        ...newCreds,
        expiresAt: newCreds.expiresIn
          ? toExpiresAt(newCreds.expiresIn)
          : normalizeExpiresAt(newCreds.expiresAt) || newCreds.expiresAt || creds.expiresAt,
        providerSpecificData: newCreds.providerSpecificData
          ? { ...creds.providerSpecificData, ...newCreds.providerSpecificData }
          : creds.providerSpecificData,
      };
      if (!persisted) creds.refreshPersistFailed = true;

      // Non-blocking: refresh projectId with the new access token
      _refreshProjectId(provider, creds.connectionId, creds.accessToken);

      return creds;
    });

    if (refreshed) {
      creds = { ...creds, ...refreshed };
    }
  }

  // ── 2. GitHub Copilot token expiry ────────────────────────────────────────
  if (provider === "github") {
    const copilotToken = creds.providerSpecificData?.copilotToken;
    const copilotExpiresAt = creds.providerSpecificData?.copilotTokenExpiresAt
      ? creds.providerSpecificData.copilotTokenExpiresAt * 1000
      : 0;
    const now              = Date.now();
    const remaining        = copilotExpiresAt - now;

    if (!copilotToken || remaining < TOKEN_EXPIRY_BUFFER_MS) {
      log.info("TOKEN_REFRESH", "Copilot token expiring soon or missing, refreshing proactively", {
        provider,
        expiresIn: copilotToken ? Math.round(remaining / 1000) : "missing",
      });

      const copilotTokenResult = await refreshCopilotToken(creds.accessToken);
      if (copilotTokenResult) {
        const updatedSpecific = {
          ...creds.providerSpecificData,
          copilotToken:          copilotTokenResult.token,
          copilotTokenExpiresAt: copilotTokenResult.expiresAt,
        };

        await updateProviderCredentials(creds.connectionId, {
          providerSpecificData: updatedSpecific,
        });

        creds.providerSpecificData = updatedSpecific;
        creds.copilotToken = copilotTokenResult.token;
      }
    }
  }

  return creds;
}

// ─── Local-specific: combined GitHub + Copilot refresh ───────────────────────

/**
 * Refresh the GitHub OAuth token and immediately exchange it for a fresh
 * Copilot token.
 *
 * @param {object} credentials  – must contain `refreshToken`
 * @returns {Promise<object|null>} merged credentials or the raw GitHub credentials on Copilot failure
 */
export async function refreshGitHubAndCopilotTokens(credentials) {
  const newGitHubCreds = await refreshGitHubToken(credentials.refreshToken);
  if (!newGitHubCreds?.accessToken) return newGitHubCreds;

  const copilotToken = await refreshCopilotToken(newGitHubCreds.accessToken);
  if (!copilotToken) return newGitHubCreds;

  return {
    ...newGitHubCreds,
    providerSpecificData: {
      copilotToken:          copilotToken.token,
      copilotTokenExpiresAt: copilotToken.expiresAt,
    },
  };
}
