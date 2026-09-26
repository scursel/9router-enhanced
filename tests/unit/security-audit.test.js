import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const resolveSrc = (relPath) =>
  fileURLToPath(new URL(`../../${relPath}`, import.meta.url));

// ============================================================
// AUDIT-002 (#1962): API key masking in usage stats
// ============================================================
describe("AUDIT-002: API key masking", () => {
  it("source should contain maskApiKey function", () => {
    const source = fs.readFileSync(
      resolveSrc("src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    expect(source).toContain("function maskApiKey");
  });

  it("getUsageHistory should use apiKeyMasked instead of apiKey", () => {
    const source = fs.readFileSync(
      resolveSrc("src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    // The REST response should use apiKeyMasked
    expect(source).toContain("apiKeyMasked: maskApiKey(r.apiKey)");
    // The return mapping in getUsageHistory should not have raw apiKey
    // (The internal ring buffer still uses apiKey: r.apiKey for internal state - that's fine)
    const historyReturn = source.match(/return rows\.map\(\(r\)\s*=>\s*\(\{[\s\S]*?\}\)\);/);
    expect(historyReturn).not.toBeNull();
    expect(historyReturn[0]).toContain("apiKeyMasked");
    expect(historyReturn[0]).not.toContain("apiKey: r.apiKey");
  });

  it("getUsageStats should use apiKeyMasked in byApiKey entries", () => {
    const source = fs.readFileSync(
      resolveSrc("src/lib/db/repos/usageRepo.js"),
      "utf-8"
    );
    // Both code paths (daily summary + 24h live) should use apiKeyMasked
    const maskedCount = (source.match(/apiKeyMasked/g) || []).length;
    expect(maskedCount).toBeGreaterThanOrEqual(4); // function def + 3 usage sites

    // The byApiKey stats entries should use apiKeyMasked, not raw apiKey
    // Check the daily summary path
    const dailyPath = source.match(/stats\.byApiKey\[akKey\] = \{[^}]*apiKeyMasked[^}]*\}/);
    expect(dailyPath).not.toBeNull();
    // Check the 24h live path
    const livePath = source.match(/stats\.byApiKey\[akKey\] = \{[^}]*apiKeyMasked[^}]*\}/g);
    expect(livePath).not.toBeNull();
    expect(livePath.length).toBeGreaterThanOrEqual(1);
  });

  it("byApiKey bucket ids sent to the dashboard never contain the raw key", async () => {
    // Buckets are keyed by the full key internally (upstream v0.5.91: masking
    // collided team keys that share a prefix); the output must hash it away.
    const { publicApiKeyBuckets } = await import("@/lib/db/repos/usageRepo.js");
    const a = "sk-9r-machine01-aaaaaaaaaaaa1111";
    const b = "sk-9r-machine01-aaaaaaaaaaaa2222";
    const out = publicApiKeyBuckets({
      [`${a}|m|p`]: { requests: 1 },
      [`${b}|m|p`]: { requests: 2 },
      "local-no-key": { requests: 3 },
    });
    const ids = Object.keys(out);
    expect(ids.join(" ")).not.toContain(a);
    expect(ids.join(" ")).not.toContain(b);
    expect(ids).toHaveLength(3);          // same prefix, still two buckets
    expect(out["local-no-key"].requests).toBe(3);
    expect(ids.filter((id) => id.endsWith("|m|p"))).toHaveLength(2);
  });
});
