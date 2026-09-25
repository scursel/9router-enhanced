import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db/index.js";
import { listImportRules } from "@/lib/modelImport/rules.js";
import { runAllAutoImports } from "@/lib/modelImport/autoImport.js";

export const dynamic = "force-dynamic";

// GET /api/models/import/auto - current auto-import settings + saved rules
export async function GET() {
  try {
    const settings = await getSettings();
    const rules = await listImportRules();
    return NextResponse.json({ settings: settings.autoModelImport, rules });
  } catch (error) {
    console.log("Error reading auto-import settings:", error);
    return NextResponse.json({ error: error?.message || String(error) }, { status: 500 });
  }
}

// POST /api/models/import/auto - trigger a daily auto-import sweep now
export async function POST() {
  try {
    const result = await runAllAutoImports();

    if (result?.busy) {
      return NextResponse.json({ error: "Auto-import already running" }, { status: 409 });
    }
    if (result?.error) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.log("Error running auto-import sweep:", error);
    return NextResponse.json({ error: error?.message || String(error) }, { status: 500 });
  }
}
