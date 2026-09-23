import { NextResponse } from "next/server";
import { request as httpRequest } from "node:http";
import { shouldUseSecureCookie } from "@/lib/auth/dashboardSession";
import { beginSession, encodeSessionCookie, rewriteMimoBases, absorbSetCookies as absorbResponseCookies, originOf, loginUpstreamFetch, SESSION_COOKIE } from "@/lib/mimoLoginSession";

/**
 * POST /api/oauth/xiaomi-mimo/login/start
 * Body: { region: "cn" | "sgp" | "ams" | "ru" | "in" }
 *
 * Walks the first two hops of the Desktop login surface server-side
 * (me -> 302 account/pass/serviceLogin -> 302 /fe/service/login) and hands
 * the browser a same-origin pageUrl carrying the 9r_mimo_login session cookie.
 * All subsequent account.xiaomi.com traffic flows through src/proxy.js.
 *
 * Egress resolution: MIMO_LOGIN_PROXY env > (region=sgp: probe common LOCAL
 * HTTP proxy ports — v2rayN/clash defaults) > direct. The resolved URL rides
 * the session cookie so every hop/XHR uses the same exit.
 */

const API_UA =
  "miNative PC/Normal Windows_NT/10.0.19045 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0";
const SSO_UA = "MiClaw/1.0";
const LOCAL_PROXY_PORTS = [10808, 10809, 7890, 7891, 1080, 1081, 8080, 8888];

function validateLoginProxy(value) {
  try {
    const url = new URL(value);
    if (!(["http:", "https:", "socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"].includes(url.protocol))
        || !url.hostname || url.hash || url.search) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function validateAccountRedirect(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
    if (url.protocol !== "https:" || url.hostname !== "account.xiaomi.com"
        || authority !== "account.xiaomi.com" || url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

/** First local port answering a CONNECT to account.xiaomi.com (or null). */
function probeLocalHttpProxy(timeoutMs = 500) {
  const attempts = LOCAL_PROXY_PORTS.map(
    (port) =>
      new Promise((resolve, reject) => {
        let settled = false;
        const done = (v) => {
          if (settled) return;
          settled = true;
          // Promise.any picks the first FULFILLED value — failures must reject,
          // otherwise an instant ECONNREFUSED from a closed candidate port would
          // "win" with null before the real proxy answers.
          if (v) resolve(v);
          else reject(new Error(`no-proxy-${port}`));
        };
        try {
          const req = httpRequest({
            host: "127.0.0.1",
            port,
            method: "CONNECT",
            path: "account.xiaomi.com:443",
            timeout: timeoutMs,
          });
          req.on("connect", (res, socket) => {
            socket.destroy();
            done(res.statusCode === 200 || res.statusCode === 202 ? `http://127.0.0.1:${port}` : null);
          });
          req.on("timeout", () => { req.destroy(); done(null); });
          req.on("error", () => done(null));
          req.on("response", () => done(null));
          req.end();
        } catch {
          done(null);
        }
      }),
  );
  return Promise.any(attempts).catch(() => null);
}

async function hop(sess, url, ua) {
  return loginUpstreamFetch(url, {
    redirect: "manual",
    headers: { "User-Agent": ua, Accept: "text/html,application/json,*/*" },
    signal: AbortSignal.timeout(15000),
  }, sess);
}

export async function POST(request) {
  try {
    let region = "cn";
    try {
      const body = await request.json();
      const r = String(body?.region || "").toLowerCase();
      // Known MiMo Desktop clusters (cn/sgp/ams/ru/in) — default cn.
      if (r === "cn" || r === "sgp" || r === "ams" || r === "ru" || r === "in") region = r;
    } catch { /* empty body — default cn */ }

    const sess = beginSession(region);

    // Egress — non-CN clusters may need an overseas exit for the login page's
    // geo-decided features (e.g. Google sign-in); CN is always direct.
    let egress = null;
    let egressSource = "direct";
    const configuredProxy = process.env.MIMO_LOGIN_PROXY?.trim();
    if (region === "cn" && configuredProxy) {
      console.log(`${new Date().toISOString().slice(11,23)} [mimo-login] configured egress ignored for CN region`);
    }
    if (region !== "cn" && configuredProxy) {
      const validated = validateLoginProxy(configuredProxy);
      if (!validated) {
        return NextResponse.json({ error: "Invalid MIMO_LOGIN_PROXY configuration" }, { status: 500 });
      }
      egress = validated;
      egressSource = "configured";
    } else if (region !== "cn") {
      const found = await probeLocalHttpProxy();
      if (found) {
        egress = found;
        egressSource = "local-probe";
      }
    }
    sess.proxyUrl = egress;

    // Hop 1: me -> account SSO (callback carries the sts callback for THIS cluster)
    const meRes = await hop(sess, `${sess.upstreamBase}/api/user/xiaomi/me`, API_UA);
    absorbResponseCookies(sess, meRes, `${sess.upstreamBase}/api/user/xiaomi/me`);
    const ssoLoc = meRes.headers.get("location");
    const ssoUrl = validateAccountRedirect(ssoLoc);
    if (!ssoUrl) {
      return NextResponse.json(
        { error: `Unexpected me response (${meRes.status}) — no account redirect` },
        { status: 502 },
      );
    }

    // Hop 2: serviceLogin -> /fe/service/login SPA (also seeds deviceId cookies)
    const loginRes = await hop(sess, ssoUrl.toString(), SSO_UA);
    absorbResponseCookies(sess, loginRes, ssoUrl.toString());
    const pageLoc = loginRes.headers.get("location");
    const pageUrl = validateAccountRedirect(pageLoc);
    if (!pageUrl) {
      return NextResponse.json(
        { error: `Unexpected serviceLogin response (${loginRes.status})` },
        { status: 502 },
      );
    }

    // Same-origin path for the SPA (middleware proxies native prefixes).
    const origin = originOf(request);
    // Session travels ONLY in the httpOnly cookie — never in the URL (history,
    // logs, Referer). /login/status re-arms the cookie on every poll, so a
    // dropped-cookie browser still recovers on the next poll cycle.
    const proxiedPath = rewriteMimoBases(pageUrl.pathname + pageUrl.search, "toProxy", origin);
    const egressLog = egress ? egress.replace(/\/\/[^@/]+@/, "//***@") : "";
    console.log(`${new Date().toISOString().slice(11,23)} [mimo-login] start region=${sess.region} origin=${origin} egress=${egressSource}${egressLog ? ` (${egressLog})` : ""} page=${pageUrl.pathname}`);

    const res = NextResponse.json({ success: true, state: sess.state, pageUrl: proxiedPath, region });
    res.cookies.set(SESSION_COOKIE, encodeSessionCookie(sess), {
      path: "/",
      httpOnly: true,
      secure: shouldUseSecureCookie(request),
      sameSite: "lax",
      maxAge: 15 * 60,
    });
    return res;
  } catch (error) {
    const configuredProxy = process.env.MIMO_LOGIN_PROXY?.trim();
    const message = configuredProxy ? "configured login egress failed" : "login start failed";
    console.log(`${new Date().toISOString().slice(11,23)} [mimo-login] start error (egress=${configuredProxy ? "configured" : "auto"})`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
