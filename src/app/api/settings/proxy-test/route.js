import { NextResponse } from "next/server";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";
import { isLocalRequest } from "@/dashboardGuard";

export async function POST(request) {
  try {
    const body = await request.json();

    // SSRF guard for remote callers, same rule as provider-nodes/validate: a
    // request from the host itself may test a local proxy (127.0.0.1:7890 is the
    // common case), a remote one may not make the gateway probe internal hosts.
    if (!isLocalRequest(request)) {
      for (const candidate of [body?.proxyUrl, body?.testUrl]) {
        if (candidate === undefined || candidate === null || String(candidate).trim() === "") continue;
        try {
          assertPublicUrl(String(candidate).trim());
        } catch {
          return NextResponse.json({ ok: false, error: "URL not allowed" }, { status: 400 });
        }
      }
    }

    const result = await testProxyUrl({
      proxyUrl: body?.proxyUrl,
      testUrl: body?.testUrl,
      timeoutMs: body?.timeoutMs,
    });

    if (result?.ok) {
      return NextResponse.json(result);
    }

    const status = typeof result?.status === "number" ? result.status : 500;
    return NextResponse.json({ ok: false, error: result?.error || "Proxy test failed" }, { status });
  } catch (err) {
    const message = err?.name === "AbortError" ? "Proxy test timed out" : (err?.message || String(err));
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
