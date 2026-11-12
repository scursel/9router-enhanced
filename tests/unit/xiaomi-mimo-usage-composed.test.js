import { describe, expect, it, vi, beforeEach } from "vitest";

const balanceUsage = vi.fn();
const desktopUsage = vi.fn();

vi.mock("../../open-sse/services/usage/xiaomiMimo.js", () => ({
  getXiaomiMimoUsage: balanceUsage,
}));
vi.mock("../../open-sse/services/usage/xiaomi-mimo.js", () => ({
  getXiaomiMimoUsage: desktopUsage,
}));

const { getUsageForProvider } = await import("../../open-sse/services/usage.js");

describe("MiMo usage composition", () => {
  beforeEach(() => {
    balanceUsage.mockReset();
    desktopUsage.mockReset();
  });

  it("returns only the console balance when that credential is present", async () => {
    desktopUsage.mockResolvedValue({ message: "Xiaomi MiMo Desktop not connected. Add credentials to view usage." });
    balanceUsage.mockResolvedValue({ plan: "API balance", quotas: { "Available balance (CNY)": { total: 12 } } });
    const result = await getUsageForProvider({ provider: "xiaomi-mimo", providerSpecificData: { quotaCookie: "fixture-cookie" } });
    expect(result).toEqual({ plan: "API balance", quotas: { "Available balance (CNY)": { total: 12 } } });
    expect(desktopUsage).toHaveBeenCalledTimes(1);
  });

  it("returns only Desktop weekly quota when its pass token is present", async () => {
    desktopUsage.mockResolvedValue({ plan: "Xiaomi MiMo Desktop", quotas: { Weekly: { total: 100, remainingPercentage: 75 } } });
    const result = await getUsageForProvider({ provider: "xiaomi-mimo", providerSpecificData: { mimoPassToken: "fixture-pass" } });
    expect(result).toEqual({ plan: "Xiaomi MiMo Desktop", quotas: { Weekly: { total: 100, remainingPercentage: 75 } } });
    expect(balanceUsage).not.toHaveBeenCalled();
  });

  it("keeps both sources and their units when both credentials are present", async () => {
    balanceUsage.mockResolvedValue({ plan: "API balance", quotas: { "Available balance (CNY)": { total: 12 } } });
    desktopUsage.mockResolvedValue({ plan: "Xiaomi MiMo Desktop", quotas: { Weekly: { total: 100, remainingPercentage: 75 } } });
    const result = await getUsageForProvider({
      provider: "xiaomi-mimo",
      providerSpecificData: { quotaCookie: "fixture-cookie", mimoPassToken: "fixture-pass" },
    });
    expect(result).toEqual({
      plan: "API balance + Xiaomi MiMo Desktop",
      quotas: {
        "Available balance (CNY)": { total: 12 },
        Weekly: { total: 100, remainingPercentage: 75 },
      },
    });
  });

  it("uses the local Desktop fallback when no pass token is stored", async () => {
    desktopUsage.mockResolvedValue({ plan: "Xiaomi MiMo Desktop", quotas: { Weekly: { total: 100, remainingPercentage: 60 } } });
    const result = await getUsageForProvider({ provider: "xiaomi-mimo", providerSpecificData: {} });
    expect(result).toEqual({ plan: "Xiaomi MiMo Desktop", quotas: { Weekly: { total: 100, remainingPercentage: 60 } } });
    expect(desktopUsage).toHaveBeenCalledWith(null, {}, null);
    expect(balanceUsage).not.toHaveBeenCalled();
  });

  it("reports one neutral message when the local fallback finds nothing", async () => {
    desktopUsage.mockResolvedValue({ message: "Xiaomi MiMo Desktop not connected. Add credentials to view usage." });
    const result = await getUsageForProvider({ provider: "xiaomi-mimo", providerSpecificData: {} });
    expect(result).toEqual({
      message: "MiMo usage unavailable: no quota data from the console cookie or the MiMo Desktop session.",
      quotas: {},
    });
    expect(balanceUsage).not.toHaveBeenCalled();
  });

  it("reports one neutral message when the fallback collector throws or returns nothing", async () => {
    desktopUsage.mockRejectedValue(new Error("locked"));
    const thrown = await getUsageForProvider({ provider: "xiaomi-mimo", providerSpecificData: {} });
    expect(Object.keys(thrown).sort()).toEqual(["message", "quotas"]);
    expect(thrown.message).toMatch(/^MiMo usage unavailable/);
    desktopUsage.mockReset();
    const empty = await getUsageForProvider({ provider: "xiaomi-mimo", providerSpecificData: {} });
    expect(empty.quotas).toEqual({});
    expect(empty.message).toMatch(/^MiMo usage unavailable/);
  });

  it("keeps a single failure message from a configured source when nothing yields quotas", async () => {
    balanceUsage.mockRejectedValue(new Error("fixture balance failure"));
    desktopUsage.mockResolvedValue({ message: "Xiaomi MiMo Desktop not connected. Add credentials to view usage." });
    const result = await getUsageForProvider({ provider: "xiaomi-mimo", providerSpecificData: { quotaCookie: "fixture-cookie" } });
    expect(result).toEqual({ message: "MiMo balance unavailable: fixture balance failure", quotas: {} });
  });

  it("preserves one source when the other source fails", async () => {
    balanceUsage.mockRejectedValue(new Error("fixture balance failure"));
    desktopUsage.mockResolvedValue({ plan: "Xiaomi MiMo Desktop", quotas: { Weekly: { total: 100, remainingPercentage: 75 } } });
    const result = await getUsageForProvider({
      provider: "xiaomi-mimo",
      providerSpecificData: { quotaCookie: "fixture-cookie", mimoPassToken: "fixture-pass" },
    });
    expect(result).toEqual({
      plan: "Xiaomi MiMo Desktop",
      quotas: { Weekly: { total: 100, remainingPercentage: 75 } },
      message: "MiMo balance unavailable: fixture balance failure",
    });
  });
});
