// Shared SSO sign-in allowlist (OIDC + SAML).
//
// Semantics under test:
//  - both lists empty  -> every IdP-authenticated identity is admitted (backward
//    compatible; upgrading must not lock the owner out).
//  - either list non-empty -> the e-mail must match an exact address or the exact
//    domain of an entry. Domain matching is exact, so "example.com" must NOT admit
//    "user@sub.example.com" (a sub-domain is a different tenant/security boundary).
//  - missing/malformed e-mail with a configured list -> reject.
import { describe, it, expect } from "vitest";
import {
  hasSsoAllowlist,
  isSsoEmailAllowed,
  normalizeDomainList,
  normalizeEmailList,
} from "../../src/lib/auth/ssoAllowlist.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

describe("isSsoEmailAllowed — empty lists are backward compatible", () => {
  it("admits any identity when both lists are empty", () => {
    expect(isSsoEmailAllowed({ email: "anyone@example.com", allowedEmails: [], allowedDomains: [] })).toBe(true);
  });

  it("admits even a missing e-mail when both lists are empty", () => {
    expect(isSsoEmailAllowed({ email: "", allowedEmails: [], allowedDomains: [] })).toBe(true);
    expect(isSsoEmailAllowed({ email: null, allowedEmails: [], allowedDomains: [] })).toBe(true);
  });

  it("treats undefined/null lists as empty", () => {
    expect(isSsoEmailAllowed({ email: "anyone@example.com" })).toBe(true);
    expect(isSsoEmailAllowed({ email: "anyone@example.com", allowedEmails: null, allowedDomains: null })).toBe(true);
  });

  it("ignores whitespace-only entries when deciding whether a list is configured", () => {
    expect(isSsoEmailAllowed({ email: "anyone@example.com", allowedEmails: ["  "], allowedDomains: [""] })).toBe(true);
  });
});

describe("isSsoEmailAllowed — exact e-mail entries", () => {
  it("admits an exact e-mail match", () => {
    expect(
      isSsoEmailAllowed({ email: "admin@example.com", allowedEmails: ["admin@example.com"], allowedDomains: [] })
    ).toBe(true);
  });

  it("matches case-insensitively and trims surrounding whitespace", () => {
    expect(
      isSsoEmailAllowed({
        email: "  Admin@Example.COM  ",
        allowedEmails: ["  ADMIN@example.com "],
        allowedDomains: [],
      })
    ).toBe(true);
  });

  it("rejects a different address in the same domain when only exact e-mails are allowed", () => {
    expect(
      isSsoEmailAllowed({ email: "other@example.com", allowedEmails: ["admin@example.com"], allowedDomains: [] })
    ).toBe(false);
  });

  it("rejects an unrelated address", () => {
    expect(
      isSsoEmailAllowed({ email: "intruder@evil.example", allowedEmails: ["admin@example.com"], allowedDomains: [] })
    ).toBe(false);
  });
});

describe("isSsoEmailAllowed — domain entries", () => {
  it("admits any address in an allowed domain", () => {
    expect(isSsoEmailAllowed({ email: "user@example.com", allowedEmails: [], allowedDomains: ["example.com"] })).toBe(
      true
    );
  });

  it("matches the domain case-insensitively and trims whitespace", () => {
    expect(
      isSsoEmailAllowed({ email: "User@Example.COM", allowedEmails: [], allowedDomains: ["  EXAMPLE.com  "] })
    ).toBe(true);
  });

  it("does NOT admit a sub-domain of an allowed parent domain", () => {
    expect(
      isSsoEmailAllowed({ email: "user@sub.example.com", allowedEmails: [], allowedDomains: ["example.com"] })
    ).toBe(false);
  });

  it("does NOT admit a parent domain when only a sub-domain is allowed", () => {
    expect(
      isSsoEmailAllowed({ email: "user@example.com", allowedEmails: [], allowedDomains: ["sub.example.com"] })
    ).toBe(false);
  });

  it("does NOT admit a lookalike suffix domain", () => {
    expect(
      isSsoEmailAllowed({ email: "user@notexample.com", allowedEmails: [], allowedDomains: ["example.com"] })
    ).toBe(false);
  });

  it("normalizes a leading @ on a domain entry", () => {
    expect(isSsoEmailAllowed({ email: "user@example.com", allowedEmails: [], allowedDomains: ["@example.com"] })).toBe(
      true
    );
  });
});

describe("isSsoEmailAllowed — combined lists and malformed identities", () => {
  it("admits a match in either list", () => {
    const allowedEmails = ["admin@example.com"];
    const allowedDomains = ["partner.example"];
    expect(isSsoEmailAllowed({ email: "admin@example.com", allowedEmails, allowedDomains })).toBe(true);
    expect(isSsoEmailAllowed({ email: "user@partner.example", allowedEmails, allowedDomains })).toBe(true);
    expect(isSsoEmailAllowed({ email: "user@example.com", allowedEmails, allowedDomains })).toBe(false);
  });

  it("rejects a missing e-mail when a list is configured", () => {
    expect(isSsoEmailAllowed({ email: "", allowedEmails: ["admin@example.com"], allowedDomains: [] })).toBe(false);
    expect(isSsoEmailAllowed({ email: null, allowedEmails: [], allowedDomains: ["example.com"] })).toBe(false);
  });

  it("rejects a malformed e-mail with no @ when a list is configured", () => {
    expect(isSsoEmailAllowed({ email: "not-an-email", allowedEmails: ["admin@example.com"] })).toBe(false);
    expect(isSsoEmailAllowed({ email: "@example.com", allowedEmails: [], allowedDomains: ["example.com"] })).toBe(false);
  });
});

describe("hasSsoAllowlist", () => {
  it("is false only when both lists normalize to empty", () => {
    expect(hasSsoAllowlist([], [])).toBe(false);
    expect(hasSsoAllowlist([" "], [""])).toBe(false);
    expect(hasSsoAllowlist(undefined, undefined)).toBe(false);
    expect(hasSsoAllowlist(["admin@example.com"], [])).toBe(true);
    expect(hasSsoAllowlist([], ["example.com"])).toBe(true);
  });
});

describe("list normalization (settings write path)", () => {
  it("trims, lowercases, drops empties and dedupes e-mails", () => {
    expect(normalizeEmailList([" Admin@Example.com ", "admin@example.com", "", null, "other@example.com"])).toEqual([
      "admin@example.com",
      "other@example.com",
    ]);
  });

  it("accepts a comma/newline separated string", () => {
    expect(normalizeEmailList(" Admin@Example.com,\nother@example.com ")).toEqual([
      "admin@example.com",
      "other@example.com",
    ]);
  });

  it("trims, lowercases, strips a leading @ and dedupes domains", () => {
    expect(normalizeDomainList([" Example.COM ", "@example.com", "", "sub.example.com"])).toEqual([
      "example.com",
      "sub.example.com",
    ]);
  });
});

describe("settings repository defaults", () => {
  it("defaults both allowlists to empty arrays so upgrades are backward compatible", () => {
    const settings = mergeWithDefaults({});
    expect(settings.ssoAllowedEmails).toEqual([]);
    expect(settings.ssoAllowedEmailDomains).toEqual([]);
  });

  it("preserves configured allowlists", () => {
    const settings = mergeWithDefaults({
      ssoAllowedEmails: ["admin@example.com"],
      ssoAllowedEmailDomains: ["partner.example"],
    });
    expect(settings.ssoAllowedEmails).toEqual(["admin@example.com"]);
    expect(settings.ssoAllowedEmailDomains).toEqual(["partner.example"]);
  });
});
