// updateProviderConnection must accept a function patch and resolve it against
// the row it reads INSIDE its synchronous transaction. That is the atomic
// read-modify-write seam the account-lock bookkeeping needs: a decision made
// from a request-time snapshot (lock merge, backoff level, which locks to
// clear) can otherwise overwrite state another request wrote in between.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { captured, currentRow } = vi.hoisted(() => ({
  captured: { lastRun: null, callback: null },
  currentRow: { value: null },
}));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: async () => ({
    get: () => currentRow.value,
    all: () => (currentRow.value ? [currentRow.value] : []),
    run: (sql, params) => {
      captured.lastRun = { sql, params };
      const [, , , , , , , dataJson] = params;
      currentRow.value = { ...currentRow.value, data: dataJson };
    },
    transaction: (fn) => {
      captured.inTransaction = true;
      try {
        return fn();
      } finally {
        captured.inTransaction = false;
      }
    },
  }),
}));

const repo = await import("../../src/lib/db/repos/connectionsRepo.js");

function makeRow() {
  return {
    id: "conn-1",
    provider: "p",
    authType: "apikey",
    name: "acc",
    email: null,
    priority: 1,
    isActive: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    data: JSON.stringify({
      apiKey: "sk-fake",
      modelLock_M: "2099-01-01T00:00:00.000Z",
    }),
  };
}

beforeEach(() => {
  captured.lastRun = null;
  captured.inTransaction = false;
  currentRow.value = makeRow();
});

describe("updateProviderConnection — function patch", () => {
  it("resolves the patch against the row read inside the transaction", async () => {
    const seen = {};
    const result = await repo.updateProviderConnection("conn-1", (existing) => {
      seen.lock = existing.modelLock_M;
      seen.inTransaction = captured.inTransaction;
      return { modelLock_M: null };
    });

    expect(seen).toEqual({ lock: "2099-01-01T00:00:00.000Z", inTransaction: true });
    expect(result.modelLock_M).toBe(null);
    expect(JSON.parse(currentRow.value.data).modelLock_M).toBe(null);
  });

  it("writes nothing when the callback returns null", async () => {
    const before = currentRow.value.data;
    const result = await repo.updateProviderConnection("conn-1", () => null);

    expect(result.modelLock_M).toBe("2099-01-01T00:00:00.000Z");
    expect(captured.lastRun).toBe(null);
    expect(currentRow.value.data).toBe(before);
  });

  it("keeps object patches working unchanged", async () => {
    const result = await repo.updateProviderConnection("conn-1", { modelLock_M: null });

    expect(result.modelLock_M).toBe(null);
    expect(captured.lastRun).not.toBe(null);
  });
});
