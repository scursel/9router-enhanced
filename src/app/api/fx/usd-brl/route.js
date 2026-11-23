import { NextResponse } from "next/server";
import { fetchUsdToBrlRate } from "@/lib/fxRate.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/fx/usd-brl - Fetch USD to BRL exchange rate (cached 6h, ?refresh=1 forces update).
 * Auth is enforced by src/dashboardGuard.js on all /api/* routes.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const force = searchParams.get("refresh") === "1";
    const result = await fetchUsdToBrlRate({ force });
    if (!result) {
      return NextResponse.json(
        { error: "Unable to fetch USD/BRL exchange rate" },
        { status: 503 }
      );
    }
    return NextResponse.json({
      rate: result.rate,
      fetchedAt: result.fetchedAt,
      source: result.source,
      stale: result.stale === true,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch USD/BRL exchange rate" },
      { status: 500 }
    );
  }
}
