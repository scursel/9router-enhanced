import { NextResponse } from "next/server";
import { saveImportRule, deleteImportRule } from "@/lib/modelImport/rules.js";
import { isKnownProvider } from "@/app/api/models/import/isKnownProvider.js";

export const dynamic = "force-dynamic";

// PUT /api/models/import/[providerId]/rule - save the per-provider auto-import rule
export async function PUT(request, { params }) {
  const { providerId } = await params;
  if (!isKnownProvider(providerId)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const rule = await saveImportRule(providerId, { filters: body?.filters, testFirst: body?.testFirst });
    return NextResponse.json({ rule });
  } catch (error) {
    console.log("Error saving import rule:", error);
    return NextResponse.json({ error: error?.message || String(error) }, { status: 500 });
  }
}

// DELETE /api/models/import/[providerId]/rule - remove the saved rule
export async function DELETE(request, { params }) {
  const { providerId } = await params;
  if (!isKnownProvider(providerId)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }

  try {
    await deleteImportRule(providerId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting import rule:", error);
    return NextResponse.json({ error: error?.message || String(error) }, { status: 500 });
  }
}
