import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { fetch as undiciFetch } from "undici";
import { getCfAccessRelayHeaders, isCfAccessLoginResponse } from "open-sse/utils/proxyFetch.js";

export async function testVercelRelay(relayUrl, timeoutMs = 10000, fetchImpl = undiciFetch) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(relayUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "x-relay-target": "https://httpbin.org",
        "x-relay-path": "/get",
        ...getCfAccessRelayHeaders(relayUrl),
      },
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    const contentType = (res.headers?.get?.("content-type") || "").toLowerCase();

    if (isCfAccessLoginResponse(res)) {
      try { await res.body?.cancel?.(); } catch { }
      return {
        ok: false,
        status: res.status,
        statusText: res.statusText,
        error: "Blocked by Cloudflare Access login redirect (missing or invalid service token)",
        elapsedMs,
      };
    }

    if (res.status !== 200) {
      try { await res.body?.cancel?.(); } catch { }
      return {
        ok: false,
        status: res.status,
        statusText: res.statusText,
        error: `Relay test failed with status ${res.status}`,
        elapsedMs,
      };
    }

    if (!contentType.includes("application/json")) {
      try { await res.body?.cancel?.(); } catch { }
      return {
        ok: false,
        status: res.status,
        statusText: res.statusText,
        error: `Relay returned unexpected content-type (${contentType || "none"}) instead of application/json`,
        elapsedMs,
      };
    }

    const payload = await res.json().catch(() => null);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return {
        ok: false,
        status: res.status,
        statusText: res.statusText,
        error: "Relay returned invalid JSON payload from target",
        elapsedMs,
      };
    }

    return {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      elapsedMs,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.name === "AbortError" ? "Relay test timed out" : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const result = proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify"
      ? await testVercelRelay(proxyPool.proxyUrl)
      : await testProxyUrl({ proxyUrl: proxyPool.proxyUrl });
    const now = new Date().toISOString();

    await updateProxyPool(id, {
      testStatus: result.ok ? "active" : "error",
      lastTestedAt: now,
      lastError: result.ok ? null : (result.error || `Proxy test failed with status ${result.status}`),
      isActive: result.ok,
    });

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      statusText: result.statusText || null,
      error: result.error || null,
      elapsedMs: result.elapsedMs || 0,
      testedAt: now,
    });
  } catch (error) {
    console.log("Error testing proxy pool:", error);
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}
