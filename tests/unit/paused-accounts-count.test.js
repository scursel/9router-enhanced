import { describe, expect, it } from "vitest";
import { countPausedAccountsForProvider } from "@/shared/hooks/useCircuitBreakers.js";

describe("countPausedAccountsForProvider", () => {
  it("counts accounts, not per-model breaker keys", () => {
    const breakers = [
      { name: "p:c1:m1", state: "OPEN" },
      { name: "p:c1:m2", state: "OPEN" },
      { name: "p:c2:m1", state: "OPEN" },
    ];
    expect(countPausedAccountsForProvider(breakers, "p")).toBe(2);
  });

  it("ignores DEGRADED, HALF_OPEN and CLOSED entries and other providers", () => {
    const breakers = [
      { name: "p:c1:m1", state: "DEGRADED" },
      { name: "p:c2:m1", state: "HALF_OPEN" },
      { name: "p:c3:m1", state: "CLOSED" },
      { name: "q:c4:m1", state: "OPEN" },
    ];
    expect(countPausedAccountsForProvider(breakers, "p")).toBe(0);
  });
});
