// One record that can never be serialised (circular object, BigInt) must not
// block the request-details write buffer forever, and the buffer itself must be
// bounded so a failing flush cannot grow memory without limit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const SCRATCH = os.tmpdir();

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalLogs = process.env.ENABLE_REQUEST_LOGS;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(SCRATCH, "reqdetails-"));
  process.env.DATA_DIR = tempDir;
  process.env.ENABLE_REQUEST_LOGS = "true";
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalLogs === undefined) delete process.env.ENABLE_REQUEST_LOGS;
  else process.env.ENABLE_REQUEST_LOGS = originalLogs;
});

describe("request details buffer survives unserialisable records", () => {
  it("drops a circular record with one warning and persists the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const repo = await import("@/lib/db/repos/requestDetailsRepo.js");
      const { getAdapter } = await import("@/lib/db/driver.js");

      const circular = { name: "bad" };
      circular.self = circular;

      await repo.saveRequestDetail({ id: "bad-circular", provider: "p", model: "m", request: circular });
      await repo.saveRequestDetail({ id: "good-1", provider: "p", model: "m", request: { ok: true } });
      await repo.saveRequestDetail({ id: "good-2", provider: "p", model: "m", request: { ok: true } });

      const remaining = await repo.flushRequestDetailsNow();
      expect(remaining).toBe(0);

      const db = await getAdapter();
      const ids = db.all("SELECT id FROM requestDetails ORDER BY id").map((r) => r.id);
      expect(ids).toEqual(["good-1", "good-2"]);

      const dropped = warn.mock.calls.filter((c) => String(c[0]).includes("dropping request detail"));
      expect(dropped.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("drops a BigInt record (throws in JSON.stringify) without blocking the batch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const repo = await import("@/lib/db/repos/requestDetailsRepo.js");
      const { getAdapter } = await import("@/lib/db/driver.js");

      await repo.saveRequestDetail({ id: "bad-bigint", provider: "p", model: "m", tokens: { prompt_tokens: 1n } });
      await repo.saveRequestDetail({ id: "good", provider: "p", model: "m", request: { ok: true } });

      expect(await repo.flushRequestDetailsNow()).toBe(0);

      const db = await getAdapter();
      const ids = db.all("SELECT id FROM requestDetails ORDER BY id").map((r) => r.id);
      expect(ids).toEqual(["good"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("bounds the write buffer, dropping the oldest records", async () => {
    const repo = await import("@/lib/db/repos/requestDetailsRepo.js");
    const dbIndex = await import("@/lib/db/index.js");
    const { getAdapter } = await import("@/lib/db/driver.js");

    await dbIndex.updateSettings({
      observabilityBatchSize: 100000,
      observabilityFlushIntervalMs: 600000,
      observabilityMaxRecords: 5000,
    });

    const cap = repo.__test__.MAX_BUFFERED_RECORDS;
    const total = cap + 5;
    for (let i = 0; i < total; i++) {
      await repo.saveRequestDetail({ id: `cap-${i}`, provider: "p", model: "m", request: { i } });
    }

    await repo.flushRequestDetailsNow();
    const db = await getAdapter();
    const ids = db.all("SELECT id FROM requestDetails").map((r) => r.id);
    expect(ids.length).toBe(cap);
    expect(ids).not.toContain("cap-0");
    expect(ids).toContain(`cap-${total - 1}`);
  });
});
