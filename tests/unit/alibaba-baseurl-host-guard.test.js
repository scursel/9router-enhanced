import { describe, it, expect } from "vitest";
import { normalizeProviderSpecificData } from "@/lib/providerNormalization.js";
import { DefaultExecutor } from "open-sse/executors/default.js";

describe("Alibaba per-account baseUrl is limited to https Alibaba Cloud hosts", () => {
  for (const bad of ["https://169.254.169.254/v1", "https://internal.corp.local/v1", "https://evil.com/aliyuncs.com", "https://aliyuncs.com.evil.com/v1", "http://x.aliyuncs.com/v1"]) {
    it(`normalization drops ${bad}`, () => {
      expect(normalizeProviderSpecificData("alitp-intl", { baseUrl: bad })).toBeNull();
    });
  }
  it("keeps a real SE endpoint", () => {
    const u = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions";
    expect(normalizeProviderSpecificData("alitp-intl", { baseUrl: u })).toEqual({ baseUrl: u });
  });
  it("executor ignores a stored non-Alibaba override", () => {
    const ex = new DefaultExecutor("alicode");
    const url = ex.buildUrl("m", false, 0, { providerSpecificData: { baseUrl: "https://10.0.0.5/v1" } });
    expect(url).toContain("dashscope.aliyuncs.com");
    expect(ex.buildUrl("m", false, 0, { providerSpecificData: { baseUrl: "https://a.maas.aliyuncs.com/x/" } })).toBe("https://a.maas.aliyuncs.com/x");
  });
});
