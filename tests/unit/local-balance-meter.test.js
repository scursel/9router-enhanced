import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeLocalBalanceSnapshot,
  validateLocalBalancePatch,
} from "../../open-sse/services/usage/localBalanceMath.js";
import { formatQuotaUsage } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalRetention = process.env.USAGE_RETENTION_DAYS;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-lb-meter-"));
  process.env.DATA_DIR = tempDir;
  delete process.env.USAGE_RETENTION_DAYS;
  delete global._dbAdapter;
  delete globalThis.__9rLocalBalanceGuard;
  delete globalThis.__9rFxUsdBrlCache;
  vi.resetModules();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  delete globalThis.__9rLocalBalanceGuard;
  delete globalThis.__9rFxUsdBrlCache;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalRetention === undefined) delete process.env.USAGE_RETENTION_DAYS;
  else process.env.USAGE_RETENTION_DAYS = originalRetention;
  vi.restoreAllMocks();
});

describe("Local balance validation, BRL/USD metering & retention", () => {
  it("validates localBalance patches strictly and defaults fxMode to manual", () => {
    const ok = validateLocalBalancePatch(
      { enabled: true, currency: "BRL", initialAmount: 150, fxRate: 5.8 },
      Date.parse("2026-11-21T12:00:00.000Z")
    );
    expect(ok.valid).toBe(true);
    expect(ok.value).toMatchObject({
      enabled: true,
      currency: "BRL",
      initialAmount: 150,
      fxMode: "manual",
      fxRate: 5.8,
      fxMarkupPct: 0,
      enforcement: "track",
      stopAtPct: 100,
    });

    expect(validateLocalBalancePatch(null)).toEqual({ valid: true, value: null });
    expect(validateLocalBalancePatch({ enabled: true, currency: "BRL", initialAmount: 100 }).valid).toBe(false);
    expect(validateLocalBalancePatch({ enabled: true, currency: "BRL", initialAmount: -1, fxRate: 5 }).valid).toBe(false);
    expect(validateLocalBalancePatch({ enabled: true, currency: "EUR", initialAmount: 10, fxRate: 6 }).valid).toBe(false);
    expect(validateLocalBalancePatch({ enabled: true, currency: "USD", initialAmount: 10, extra: 1 }).valid).toBe(false);
    expect(validateLocalBalancePatch({ enabled: true, currency: "USD", initialAmount: 10, stopAtPct: 0 }).valid).toBe(false);
    expect(
      validateLocalBalancePatch(
        {
          enabled: true,
          currency: "USD",
          initialAmount: 10,
          since: "2099-01-01T00:00:00.000Z",
        },
        Date.parse("2026-11-21T12:00:00.000Z")
      ).valid
    ).toBe(false);
  });

  it("converts USD spend to BRL with fxRate + fxMarkupPct and renders in pt-BR R$", () => {
    const snap = computeLocalBalanceSnapshot(
      {
        enabled: true,
        currency: "BRL",
        initialAmount: 100,
        fxMode: "manual",
        fxRate: 5.0,
        fxMarkupPct: 10,
        enforcement: "track",
        stopAtPct: 100,
      },
      10,
      { unpricedCount: 2 }
    );
    // $10 * 5.0 * 1.10 = R$ 55.00
    expect(snap.spent).toBeCloseTo(55, 8);
    expect(snap.remaining).toBeCloseTo(45, 8);
    expect(snap.quotaKey).toBe("Saldo (BRL)");
    expect(snap.notice).toContain("2 requisição(ões) sem preço");

    const rendered = formatQuotaUsage({
      name: snap.quotaKey,
      used: snap.spent,
      total: snap.total,
    }).replace(/\u00a0/g, " ");
    expect(rendered).toBe("R$ 55,00 / R$ 100,00");
  });

  it("reads usageHistory since timestamp and falls back to usageDaily under USAGE_RETENTION_DAYS without double-counting (M1)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { getLocalBalanceUsage } = await import("open-sse/services/usage/localBalance.js");
    const db = await getAdapter();

    const nowMs = Date.parse("2026-11-21T15:00:00.000Z");
    process.env.USAGE_RETENTION_DAYS = "7"; // cutoff = 2026-11-14T15:00:00.000Z -> split next local midnight

    const connId = "conn-gem-ret";
    const lbConfig = {
      enabled: true,
      currency: "BRL",
      initialAmount: 200,
      since: "2026-11-01T00:00:00.000Z",
      fxMode: "manual",
      fxRate: 5.0,
      fxMarkupPct: 0,
      enforcement: "track",
      stopAtPct: 100,
    };
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt) VALUES(?, 'gemini', 'apikey', 'Gemini Paid', 1, 1, ?, ?, ?)`,
      [connId, JSON.stringify({ apiKey: "fake-gemini-key", localBalance: lbConfig }), "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]
    );

    // Old pruned day in usageDaily ($4.00)
    db.run(
      `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`,
      [
        "2026-11-10",
        JSON.stringify({
          byAccount: {
            [connId]: { requests: 2, promptTokens: 1000, completionTokens: 200, cost: 4.0 },
          },
        }),
      ]
    );
    // Day on/after split also in usageDaily ($6.00) + raw usageHistory ($6.00) -> must NOT double-count!
    db.run(
      `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`,
      [
        "2026-11-18",
        JSON.stringify({
          byAccount: {
            [connId]: { requests: 1, promptTokens: 1000, completionTokens: 200, cost: 6.0 },
          },
        }),
      ]
    );
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, 'gemini', 'gemini-2.5-pro', ?, 1000, 200, 6.0, 'ok', '{}', '{}')`,
      ["2026-11-18T12:00:00.000Z", connId]
    );
    // Error row must be ignored
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, 'gemini', 'gemini-2.5-pro', ?, 0, 0, 99.0, 'error:429', '{}', '{}')`,
      ["2026-11-19T12:00:00.000Z", connId]
    );

    const result = await getLocalBalanceUsage(
      { connectionId: connId, provider: "gemini", providerSpecificData: { localBalance: lbConfig } },
      nowMs
    );

    // Total USD = $4 (2026-11-10 daily) + $6 (2026-11-18 history) = $10 -> * 5 = R$ 50
    expect(result.source).toBe("router-local");
    expect(result.quotas["Saldo (BRL)"].used).toBeCloseTo(50, 8);
    expect(result.quotas["Saldo (BRL)"].total).toBe(200);
    expect(result.notice).toContain("USAGE_RETENTION_DAYS");
  });

  it("merges localBalance quota into getUsageForProvider without touching gemini registry features (B2)", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { getUsageForProvider } = await import("open-sse/services/usage.js");
    const db = await getAdapter();

    const connId = "conn-gem-merge";
    const lbConfig = {
      enabled: true,
      currency: "USD",
      initialAmount: 50,
      since: "2026-11-20T00:00:00.000Z",
      fxMode: "manual",
      fxRate: 1,
      fxMarkupPct: 0,
      enforcement: "track",
      stopAtPct: 100,
    };
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, 'gemini', 'gemini-2.5-flash', ?, 1000, 100, 12.5, 'ok', '{}', '{}')`,
      ["2026-11-21T01:00:00.000Z", connId]
    );

    const res = await getUsageForProvider({
      id: connId,
      provider: "gemini",
      authType: "apikey",
      providerSpecificData: { localBalance: lbConfig },
    });
    expect(res.quotas["Saldo (USD)"].used).toBeCloseTo(12.5, 8);
    expect(res.quotas["Saldo (USD)"].total).toBe(50);

    // Without localBalance enabled, gemini still stays disabled/clean
    const disabledRes = await getUsageForProvider({
      id: "conn-gem-plain",
      provider: "gemini",
      authType: "apikey",
      providerSpecificData: {},
    });
    expect(disabledRes.quotas).toBeUndefined();
    expect(disabledRes.message).toContain("Usage API not implemented");
  });

  it("supports PUT localBalance validation, atomic calibrate/topup, and client eligibility (M8, B5)", async () => {
    const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
    const { PUT } = await import("@/app/api/providers/[id]/route.js");
    const { GET: getClientList } = await import("@/app/api/providers/client/route.js");

    const conn = await createProviderConnection({
      provider: "gemini",
      authType: "apikey",
      name: "Gemini Main",
      apiKey: "fake-gemini-key-1",
    });

    // Reject invalid localBalance
    const badPut = await PUT(
      new Request(`http://localhost/api/providers/${conn.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerSpecificData: {
            localBalance: { enabled: true, currency: "BRL", initialAmount: -10, fxRate: 5.5 },
          },
        }),
      }),
      { params: Promise.resolve({ id: conn.id }) }
    );
    expect(badPut.status).toBe(400);

    // Save valid localBalance
    const goodPut = await PUT(
      new Request(`http://localhost/api/providers/${conn.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerSpecificData: {
            localBalance: {
              enabled: true,
              currency: "BRL",
              initialAmount: 100,
              fxMode: "manual",
              fxRate: 5.5,
              fxMarkupPct: 0,
              enforcement: "block",
              stopAtPct: 95,
              since: "2026-11-20T00:00:00.000Z",
            },
          },
        }),
      }),
      { params: Promise.resolve({ id: conn.id }) }
    );
    expect(goodPut.status).toBe(200);
    const saved = await goodPut.json();
    expect(saved.connection.providerSpecificData.localBalance.initialAmount).toBe(100);

    // Client usage list marks gemini connection eligible and exposes localBalance safely
    const listRes = await getClientList(new Request("http://localhost/api/providers/client?sort=provider"));
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    const found = listJson.connections.find((c) => c.id === conn.id);
    expect(found).toBeTruthy();
    expect(found.providerSpecificData.localBalance.initialAmount).toBe(100);

    // Atomic topup
    const topupRes = await PUT(
      new Request(`http://localhost/api/providers/${conn.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localBalanceAction: { type: "topup", amount: 50 } }),
      }),
      { params: Promise.resolve({ id: conn.id }) }
    );
    expect(topupRes.status).toBe(200);
    const topupJson = await topupRes.json();
    expect(topupJson.connection.providerSpecificData.localBalance.initialAmount).toBe(150);
    expect(topupJson.connection.providerSpecificData.localBalance.since).toBe("2026-11-20T00:00:00.000Z");

    // Atomic calibrate resets since and updates initialAmount
    const calRes = await PUT(
      new Request(`http://localhost/api/providers/${conn.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localBalanceAction: { type: "calibrate", amount: 80, fxRate: 5.75 } }),
      }),
      { params: Promise.resolve({ id: conn.id }) }
    );
    expect(calRes.status).toBe(200);
    const calJson = await calRes.json();
    expect(calJson.connection.providerSpecificData.localBalance.initialAmount).toBe(80);
    expect(calJson.connection.providerSpecificData.localBalance.fxRate).toBe(5.75);
    expect(calJson.connection.providerSpecificData.localBalance.since).not.toBe("2026-11-20T00:00:00.000Z");
  });
});
