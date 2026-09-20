import { NextResponse } from "next/server";
import { pingModelWithFallback } from "./ping";

// POST /api/models/test - Ping a single model via internal completions or embeddings.
// Falls back across kinds when the declared one is not served on that route.
export async function POST(request) {
  try {
    const { model, kind } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const result = await pingModelWithFallback(model, kind || "llm");
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
