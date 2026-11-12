import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

function resetDbState() {
  // global._dbAdapter is the driver's state object ({ instance, initPromise }),
  // not the adapter — closing the instance is what releases the sqlite handle
  // and its beforeExit hook. Closing the wrapper was a no-op that leaked one
  // listener per test.
  const adapter = global._dbAdapter?.instance;
  if (adapter && typeof adapter.close === "function") {
    try { adapter.close(); } catch {}
  }
  if (global._statsEmitter && typeof global._statsEmitter.removeAllListeners === "function") {
    try { global._statsEmitter.removeAllListeners(); } catch {}
  }
  if (global._statsEmitTimers) {
    if (global._statsEmitTimers.update) clearTimeout(global._statsEmitTimers.update);
    if (global._statsEmitTimers.pending) clearTimeout(global._statsEmitTimers.pending);
  }
  delete global._dbAdapter;
  delete global._pendingRequests;
  delete global._lastErrorProvider;
  delete global._recentRing;
  delete global._statsEmitter;
  delete global._statsEmitTimers;
  delete global._pendingUsagePersists;
  vi.resetModules();
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-id-test-"));
  process.env.DATA_DIR = tempDir;
  resetDbState();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterEach(() => {
  resetDbState();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("usage payload-conflict log never prints gateway API keys", () => {
  it("masks both stored and incoming apiKey", async () => {
    const ts = new Date().toISOString();
    const base = { usageEventId: "evt-key-leak", provider: "openai", model: "gpt-4o", timestamp: ts, tokens: { prompt_tokens: 1, completion_tokens: 1 } };
    await db.saveRequestUsage({ ...base, apiKey: "sk-STORED-secret-value" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.saveRequestUsage({ ...base, apiKey: "sk-INCOMING-secret-value" });
    const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    warnSpy.mockRestore();
    expect(logged).toContain("payload conflict");
    expect(logged).not.toContain("secret-value");
  });
});
