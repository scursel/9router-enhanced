// A rotated refresh token that cannot be persisted is a credential-loss risk:
// the next refresh would send a dead RT (invalid_grant → re-login). Persist is
// retried a bounded number of times, the failure is logged loudly and surfaced
// on the returned credentials, and the fresh access token is still returned for
// the current request. The DB re-read that adopts a concurrently rotated token
// must happen INSIDE the single-flight refresh lock.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { refreshTokenByProviderMock, dbMocks, logMocks } = vi.hoisted(() => ({
  refreshTokenByProviderMock: vi.fn(),
  dbMocks: {
    getProviderConnectionById: vi.fn(),
    updateProviderConnection: vi.fn(),
  },
  logMocks: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("open-sse/services/tokenRefresh.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, refreshTokenByProvider: refreshTokenByProviderMock };
});
vi.mock("@/lib/localDb.js", () => dbMocks);
vi.mock("../../src/sse/utils/logger.js", () => logMocks);

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();

const staleCreds = () => ({
  connectionId: "conn-1",
  refreshToken: "old-rt",
  accessToken: "old-at",
  expiresAt: past(),
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnectionById.mockResolvedValue(null);
  dbMocks.updateProviderConnection.mockResolvedValue({ id: "conn-1" });
  refreshTokenByProviderMock.mockResolvedValue({
    accessToken: "fresh-at",
    refreshToken: "rotated-rt",
    expiresIn: 3600,
  });
});

describe("checkAndRefreshToken credential persistence", () => {
  it("retries a failed persist, logs a credential-loss risk, and still returns the fresh token", async () => {
    dbMocks.updateProviderConnection.mockResolvedValue(null); // every write fails

    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    const out = await checkAndRefreshToken("claude", staleCreds());

    expect(out.accessToken).toBe("fresh-at");
    expect(out.refreshToken).toBe("rotated-rt");
    expect(dbMocks.updateProviderConnection).toHaveBeenCalledTimes(3);
    expect(out.refreshPersistFailed).toBe(true);

    const loud = logMocks.error.mock.calls.filter((call) => String(call[1]).includes("CREDENTIAL LOSS RISK"));
    expect(loud.length).toBe(1);
  });

  it("stops retrying as soon as a write succeeds", async () => {
    dbMocks.updateProviderConnection
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "conn-1" });

    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");
    const out = await checkAndRefreshToken("claude", staleCreds());

    expect(dbMocks.updateProviderConnection).toHaveBeenCalledTimes(2);
    expect(out.refreshPersistFailed).toBeUndefined();
    expect(logMocks.error.mock.calls.filter((call) => String(call[1]).includes("CREDENTIAL LOSS RISK")).length).toBe(0);
  });

  it("adopts a concurrently rotated token instead of refreshing with the stale one", async () => {
    const staleRow = {
      id: "conn-1",
      provider: "claude",
      refreshToken: "old-rt",
      accessToken: "old-at",
      expiresAt: past(),
      lastRefreshAt: "2020-01-01T00:00:00.000Z",
    };
    const freshRow = {
      ...staleRow,
      refreshToken: "new-rt",
      accessToken: "new-at",
      expiresAt: future(5),
      lastRefreshAt: new Date().toISOString(),
    };
    let reads = 0;
    // The old code reads BEFORE taking the lock: the first read captures the
    // stale row and resolves only after the concurrent refresh has finished.
    dbMocks.getProviderConnectionById.mockImplementation(async () => {
      reads++;
      if (reads === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return staleRow;
      }
      return freshRow;
    });

    const { withCredentialRefreshLock } = await import("../../open-sse/services/oauthCredentialManager.js");
    const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

    // A concurrent refresh holds the lock, rotates + persists the RT, and
    // releases before the stale read above resolves.
    const holder = withCredentialRefreshLock(
      "claude",
      { connectionId: "conn-1", refreshToken: "old-rt" },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { accessToken: "new-at", refreshToken: "new-rt", expiresAt: freshRow.expiresAt };
      }
    );

    const out = await checkAndRefreshToken("claude", staleCreds());
    await holder;

    // The stale RT must never be replayed. Depending on whether the concurrent
    // refresh left the credential still due, the in-lock re-read either skips
    // the upstream call or refreshes with the fresh RT.
    const usedRefreshTokens = refreshTokenByProviderMock.mock.calls.map((call) => call[1].refreshToken);
    expect(usedRefreshTokens).not.toContain("old-rt");
    expect(out.accessToken).toBe("new-at");
    expect(out.refreshToken).toBe("new-rt");
  });
});
