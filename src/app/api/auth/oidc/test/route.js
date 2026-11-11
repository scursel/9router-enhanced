import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import {
  fetchOidcDiscovery,
  getPublicOrigin,
  isSameOidcIssuer,
  probeOidcClientSecret,
} from "@/lib/auth/oidc";
import { assertPublicUrlResolved, fetchPublic } from "@/shared/utils/ssrfGuard.js";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

async function canAccessTestRoute() {
  const settings = await getSettings();
  if (settings.requireLogin === false) return true;

  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

function badRequest(message) {
  return NextResponse.json({ error: message }, { status: 400 });
}

// The settings test route is an admin-initiated outbound fetch, so it must not
// become an SSRF primitive. assertPublicUrlResolved also rejects hostnames that
// merely resolve to a private/loopback/metadata address.
async function guardTestUrl(rawUrl, label) {
  try {
    await assertPublicUrlResolved(rawUrl);
    return null;
  } catch (error) {
    return badRequest(`${label} is not allowed: ${error.message || "blocked URL"}`);
  }
}

export async function POST(request) {
  try {
    if (!(await canAccessTestRoute())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const settings = await getSettings();

    const issuerUrl = String(body.issuerUrl || settings.oidcIssuerUrl || "").trim();
    const clientId = String(body.clientId || settings.oidcClientId || "").trim();
    const scopes = String(body.scopes || settings.oidcScopes || "openid profile email").trim() || "openid profile email";
    const storedIssuerUrl = String(settings.oidcIssuerUrl || "").trim();
    // The stored secret belongs to the configured issuer only. For any other
    // caller-chosen issuer an absent body secret means "skip the probe" — never
    // send the stored credential to an issuer the admin did not configure.
    const clientSecret = String(
      Object.prototype.hasOwnProperty.call(body, "clientSecret")
        ? body.clientSecret
        : isSameOidcIssuer(issuerUrl, storedIssuerUrl)
          ? settings.oidcClientSecret || ""
          : ""
    ).trim();

    if (!issuerUrl) {
      return badRequest("Issuer URL is required");
    }
    if (!clientId) {
      return badRequest("Client ID is required");
    }

    const issuerBlocked = await guardTestUrl(issuerUrl, "Issuer URL");
    if (issuerBlocked) return issuerBlocked;

    const discovery = await fetchOidcDiscovery(issuerUrl, { fetchImpl: fetchPublic });
    const tokenEndpoint = String(discovery.token_endpoint || "").trim();
    if (!tokenEndpoint) {
      return badRequest("OIDC discovery document is missing token_endpoint");
    }

    let tokenUrl;
    try {
      tokenUrl = new URL(tokenEndpoint);
    } catch {
      return badRequest("OIDC discovery token_endpoint is not a valid URL");
    }
    // Same-origin is deliberately NOT required: real IdPs serve the token
    // endpoint from a different host (Google: accounts.google.com ->
    // oauth2.googleapis.com), so requiring it would break legitimate IdPs.
    // https + the resolved-address SSRF guard is the boundary for this route.
    if (tokenUrl.protocol !== "https:") {
      return badRequest("OIDC discovery token_endpoint must use https");
    }
    const tokenBlocked = await guardTestUrl(tokenEndpoint, "OIDC token endpoint");
    if (tokenBlocked) return tokenBlocked;

    const redirectUri = `${getPublicOrigin(request)}/api/auth/oidc/callback`;
    const secretProbe = await probeOidcClientSecret({
      tokenEndpoint,
      clientId,
      clientSecret,
      redirectUri,
      fetchImpl: fetchPublic,
    });

    if (secretProbe.tested && secretProbe.valid === false) {
      return NextResponse.json({
        ok: false,
        discoveryOk: true,
        clientSecretTested: true,
        clientSecretValid: false,
        issuerUrl,
        clientId,
        scopes,
        redirectUri,
        authorizationEndpoint: discovery.authorization_endpoint || "",
        tokenEndpoint: discovery.token_endpoint || "",
        jwksUri: discovery.jwks_uri || "",
        error: `Discovery loaded, but the client secret is not valid: ${secretProbe.message}`,
      });
    }

    return NextResponse.json({
      ok: true,
      discoveryOk: true,
      clientSecretTested: secretProbe.tested,
      clientSecretValid: secretProbe.valid,
      issuerUrl,
      clientId,
      scopes,
      redirectUri,
      authorizationEndpoint: discovery.authorization_endpoint || "",
      tokenEndpoint: discovery.token_endpoint || "",
      jwksUri: discovery.jwks_uri || "",
      message: secretProbe.message,
    });
  } catch (error) {
    const message = error.message || "OIDC test failed";
    // fetchPublic re-validates every redirect hop; a blocked hop is bad input,
    // not a server fault.
    return NextResponse.json({ error: message }, { status: /^Blocked URL:/.test(message) ? 400 : 500 });
  }
}
