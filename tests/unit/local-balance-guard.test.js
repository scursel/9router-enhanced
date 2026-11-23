import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unavailableResponse } from "../../open-sse/utils/error.js";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-lb-guard-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._pendingUsagePersists;
  delete global._recentRing;
  delete global._statsEmitTimers;
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
  vi.restoreAllMocks();
});

describe("Local balance guard, FX cache & exhaustion contract", () => {
  it("unavailableResponse omits retry-after when retryAfter is null (A3)", async () => {
    const res = unavailableResponse(402, "Local balance exhausted", null, null);
    expect(res.status).toBe(402);
    expect(res.headers.get("retry-after")).toBeNull();
    const json = await res.json();
    expect(json.error.message).toBe("Local balance exhausted");
  });

  it("increments guard cache only once per inserted billable row and skips exhausted accounts on routing (M3, M4)", async () => {
    const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
    const { saveRequestUsage, drainPendingUsage } = await import("@/lib/db/repos/usageRepo.js");
    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const { PUT } = await import("@/app/api/providers/[id]/route.js");

    const since = "2026-11-20T00:00:00.000Z";
    const conn1 = await createProviderConnection({
      provider: "gemini",
      authType: "apikey",
      name: "Gemini A (capped)",
      apiKey: "fake-key-a",
      priority: 1,
      providerSpecificData: {
        localBalance: {
          enabled: true,
          currency: "BRL",
          initialAmount: 10, // R$ 10 at fx=5 -> $2 USD cap
          since,
          fxMode: "manual",
          fxRate: 5,
          fxMarkupPct: 0,
          enforcement: "block",
          stopAtPct: 100,
        },
      },
    });
    const conn2 = await createProviderConnection({
      provider: "gemini",
      authType: "apikey",
      name: "Gemini B (backup)",
      apiKey: "fake-key-b",
      priority: 2,
      providerSpecificData: {
        localBalance: {
          enabled: true,
          currency: "BRL",
          initialAmount: 100,
          since,
          fxMode: "manual",
          fxRate: 5,
          fxMarkupPct: 0,
          enforcement: "track", // track-only never blocks
          stopAtPct: 100,
        },
      },
    });

    // Warm preload -> selects conn1 first
    const first = await getProviderCredentials("gemini", null, "gemini-2.5-pro");
    expect(first.connectionId).toBe(conn1.id);

    // Duplicate usageEventId (M3) + failure row: must only count $2.50 ONCE (1M input * $2.50? Use gemini-2.5-pro <=200k: 200k*1.25/1M + ... -> let's use 200k input + 180k output = 0.25 + 1.80 = $2.05)
    const event = {
      usageEventId: "evt-unique-1",
      provider: "gemini",
      model: "gemini-2.5-pro",
      connectionId: conn1.id,
      timestamp: "2026-11-21T01:00:00.000Z",
      tokens: { prompt_tokens: 200_000, completion_tokens: 180_000 },
    };
    await saveRequestUsage(event);
    await saveRequestUsage(event); // duplicate must NOT increment guard cache twice
    await saveRequestUsage({
      usageEventId: "evt-failed-1",
      provider: "gemini",
      model: "gemini-2.5-pro",
      connectionId: conn1.id,
      status: "error:500",
      timestamp: "2026-11-21T01:01:00.000Z",
      tokens: { prompt_tokens: 200_000, completion_tokens: 180_000 },
    });
    await drainPendingUsage();

    expect(globalThis.__9rLocalBalanceGuard.spentUsd.get(conn1.id)).toBeCloseTo(2.05, 8);

    // conn1 is now >= R$10 ($2.05 * 5 = R$10.25) -> auth skips conn1 and selects conn2!
    const second = await getProviderCredentials("gemini", null, "gemini-2.5-pro");
    expect(second.connectionId).toBe(conn2.id);

    // Top-up conn1 via PUT invalidates guard cache and makes conn1 selectable again
    const topupRes = await PUT(
      new Request(`http://localhost/api/providers/${conn1.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localBalanceAction: { type: "topup", amount: 50 } }),
      }),
      { params: Promise.resolve({ id: conn1.id }) }
    );
    expect(topupRes.status).toBe(200);
    expect(globalThis.__9rLocalBalanceGuard.spentUsd.has(conn1.id)).toBe(false);

    const third = await getProviderCredentials("gemini", null, "gemini-2.5-pro");
    expect(third.connectionId).toBe(conn1.id);
  });

  it("returns 402 without retry-after on single-model chat & embeddings when all accounts are exhausted, and falls back in combos (A3)", async () => {
    const { createProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const { handleChat } = await import("@/sse/handlers/chat.js");
    const { handleEmbeddings } = await import("@/sse/handlers/embeddings.js");
    const { handleComboChat } = await import("open-sse/services/combo.js");

    await updateSettings({ requireApiKey: false });

    const since = "2026-11-20T00:00:00.000Z";
    const gem = await createProviderConnection({
      provider: "gemini",
      authType: "apikey",
      name: "Gemini Capped Only",
      apiKey: "fake-gem-only",
      providerSpecificData: {
        localBalance: {
          enabled: true,
          currency: "BRL",
          initialAmount: 10,
          since,
          fxMode: "manual",
          fxRate: 5,
          fxMarkupPct: 0,
          enforcement: "block",
          stopAtPct: 100,
        },
      },
    });
    const backup = await createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI Backup",
      apiKey: "fake-openai-key",
    });

    const db = await getAdapter();
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, 'gemini', 'gemini-2.5-pro', ?, 1000, 100, 3.0, 'ok', '{}', '{}')`,
      ["2026-11-21T02:00:00.000Z", gem.id]
    );

    const credResult = await getProviderCredentials("gemini", null, "gemini-2.5-pro");
    expect(credResult).toMatchObject({
      allRateLimited: true,
      budgetExhausted: true,
      retryAfter: null,
      lastErrorCode: 402,
    });

    // Single-model chat returns 402 without retry-after
    const chatRes = await handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini/gemini-2.5-pro",
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    );
    expect(chatRes.status).toBe(402);
    expect(chatRes.headers.get("retry-after")).toBeNull();
    const chatJson = await chatRes.json();
    expect(chatJson.error.message).toContain("Local balance exhausted");

    // Embeddings returns 402 without retry-after
    const embRes = await handleEmbeddings(
      new Request("http://localhost/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini/gemini-embedding-001",
          input: "hello",
        }),
      })
    );
    expect(embRes.status).toBe(402);
    expect(embRes.headers.get("retry-after")).toBeNull();

    // Combo falls back from 402 gemini to next model (openai/gpt-4o)
    const attemptedModels = [];
    const comboRes = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }] },
      models: ["gemini/gemini-2.5-pro", "openai/gpt-4o"],
      comboName: "my-combo",
      comboStrategy: "fallback",
      handleSingleModel: async (_body, modelStr) => {
        attemptedModels.push(modelStr);
        if (modelStr.startsWith("gemini/")) {
          return await handleChat(
            new Request("http://localhost/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: modelStr,
                messages: [{ role: "user", content: "hi" }],
              }),
            })
          );
        }
        return Response.json({ ok: true, usedBackup: backup.id }, { status: 200 });
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(attemptedModels).toEqual(["gemini/gemini-2.5-pro", "openai/gpt-4o"]);
    expect(comboRes.status).toBe(200);
  });

  it("fetches, caches, and fail-opens USD/BRL exchange rate securely (B4)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rates: { BRL: 5.72 } }), { status: 200 })
      )
      .mockRejectedValueOnce(new Error("network down"));

    const { GET } = await import("@/app/api/fx/usd-brl/route.js");

    const res1 = await GET(new Request("http://localhost/api/fx/usd-brl"));
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1).toMatchObject({ rate: 5.72, source: "frankfurter", stale: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Cached second call makes no network request
    const res2 = await GET(new Request("http://localhost/api/fx/usd-brl"));
    expect(res2.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Force refresh when both network sources fail falls back to stale cache
    fetchSpy.mockRejectedValue(new Error("network down"));
    const res3 = await GET(new Request("http://localhost/api/fx/usd-brl?refresh=1"));
    expect(res3.status).toBe(200);
    const json3 = await res3.json();
    expect(json3).toMatchObject({ rate: 5.72, stale: true });
  });
});
