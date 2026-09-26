import { NextResponse } from "next/server";
import { isKnownProvider } from "@/app/api/models/import/isKnownProvider.js";
import { detectModelMeta } from "@/lib/modelMeta/detect.js";

export const dynamic = "force-dynamic";

// POST /api/models/meta/detect { providerId, modelId }
// Reads the model's context window from the provider list and probes whether it
// reasons (one small real request). Stores what it learns; returns the result.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const providerId = typeof body?.providerId === "string" ? body.providerId : "";
  const modelId = typeof body?.modelId === "string" ? body.modelId.trim() : "";
  if (!providerId || !modelId || modelId.length > 300) {
    return NextResponse.json({ error: "providerId and modelId are required" }, { status: 400 });
  }
  if (!isKnownProvider(providerId)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }
  try {
    return NextResponse.json(await detectModelMeta({ providerId, modelId }));
  } catch (error) {
    return NextResponse.json({ error: error?.message || String(error) }, { status: 502 });
  }
}
