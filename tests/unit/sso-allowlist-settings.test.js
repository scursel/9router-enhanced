// Settings write path for the shared SSO allowlist keys.
//
// The callbacks compare normalized values, but the dashboard/API is the only
// writer, so PATCH must trim/lowercase/dedupe the lists and reject non-string
// entries instead of persisting something the matcher would silently ignore.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const db = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));

const { GET, PATCH } = await import("@/app/api/settings/route.js");

async function patch(body) {
  const response = await PATCH(
    new Request("https://dashboard.example.com/api/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    })
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.getSettings.mockResolvedValue({ requireLogin: true });
  db.updateSettings.mockImplementation(async (updates) => ({ requireLogin: true, ...updates }));
});

describe("PATCH /api/settings — SSO allowlist normalization", () => {
  it("trims, lowercases and dedupes both lists before persisting", async () => {
    const result = await patch({
      ssoAllowedEmails: [" Admin@Example.com ", "admin@example.com", ""],
      ssoAllowedEmailDomains: ["@Example.COM", " example.com "],
    });

    expect(result.status).toBe(200);
    expect(db.updateSettings).toHaveBeenCalledWith({
      ssoAllowedEmails: ["admin@example.com"],
      ssoAllowedEmailDomains: ["example.com"],
    });
  });

  it("accepts comma-separated strings (UI convenience)", async () => {
    const result = await patch({
      ssoAllowedEmails: "admin@example.com, other@example.com",
    });

    expect(result.status).toBe(200);
    expect(db.updateSettings).toHaveBeenCalledWith({
      ssoAllowedEmails: ["admin@example.com", "other@example.com"],
    });
  });

  it("rejects non-string entries without touching the store", async () => {
    const result = await patch({ ssoAllowedEmails: ["admin@example.com", 42] });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/array of strings/i);
    expect(db.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects a non-array/non-string value without touching the store", async () => {
    const result = await patch({ ssoAllowedEmailDomains: { domain: "example.com" } });

    expect(result.status).toBe(400);
    expect(db.updateSettings).not.toHaveBeenCalled();
  });

  it("leaves the keys untouched when the patch does not mention them", async () => {
    const result = await patch({ theme: "dark" });

    expect(result.status).toBe(200);
    expect(db.updateSettings).toHaveBeenCalledWith({ theme: "dark" });
  });
});

describe("GET /api/settings — SSO allowlist exposure", () => {
  it("returns the configured allowlists to the dashboard", async () => {
    db.getSettings.mockResolvedValue({
      requireLogin: true,
      ssoAllowedEmails: ["admin@example.com"],
      ssoAllowedEmailDomains: ["partner.example"],
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ssoAllowedEmails).toEqual(["admin@example.com"]);
    expect(body.ssoAllowedEmailDomains).toEqual(["partner.example"]);
  });
});
