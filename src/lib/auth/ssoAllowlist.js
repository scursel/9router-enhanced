// Shared SSO sign-in allowlist used by BOTH dashboard callbacks (OIDC + SAML).
//
// Backward compatibility: when both lists are empty every IdP-authenticated
// identity is admitted, so upgrading cannot lock the owner out. As soon as either
// list is configured, an identity is admitted only when its e-mail is an exact
// address match or belongs to an exactly-matching domain.
//
// Domain matching is EXACT on purpose: "example.com" must not admit
// "user@sub.example.com" — a sub-domain can be a different tenant/security
// boundary, so suffix matching would silently widen the allowlist.

export const SSO_EMAIL_NOT_ALLOWED = "sso_email_not_allowed";

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeDomain(value) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\.+$/, "");
}

function toList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[\s,;]+/);
  return [];
}

export function normalizeEmailList(value) {
  return [...new Set(toList(value).map(normalizeEmail).filter(Boolean))];
}

export function normalizeDomainList(value) {
  return [...new Set(toList(value).map(normalizeDomain).filter(Boolean))];
}

export function hasSsoAllowlist(allowedEmails, allowedDomains) {
  return normalizeEmailList(allowedEmails).length > 0 || normalizeDomainList(allowedDomains).length > 0;
}

/**
 * Pure allowlist decision shared by the OIDC callback and the SAML ACS route.
 * @param {{ email?: string|null, allowedEmails?: string[]|string, allowedDomains?: string[]|string }} input
 * @returns {boolean} true when the identity may sign in
 */
export function isSsoEmailAllowed({ email, allowedEmails, allowedDomains } = {}) {
  const emails = normalizeEmailList(allowedEmails);
  const domains = normalizeDomainList(allowedDomains);
  if (emails.length === 0 && domains.length === 0) return true;

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;

  // Exactly one @: reject malformed identities instead of guessing which part
  // the IdP meant (e.g. "a@evil.example@allowed.example").
  const at = normalizedEmail.indexOf("@");
  if (at <= 0 || at !== normalizedEmail.lastIndexOf("@")) return false;

  if (emails.includes(normalizedEmail)) return true;

  const domain = normalizedEmail.slice(at + 1);
  return domains.includes(domain);
}
