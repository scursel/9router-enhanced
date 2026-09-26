import { NextResponse } from "next/server";
import { listImportCandidates, resolveStorageAlias } from "@/lib/modelImport/candidates.js";
import { runImport } from "@/lib/modelImport/runImport.js";
import { getImportRule } from "@/lib/modelImport/rules.js";
import { IMPORT_KINDS } from "@/shared/utils/importProviderModels.js";
import { isKnownProvider } from "@/app/api/models/import/isKnownProvider.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

const MAX_MODELS = 1000;

// Validate + normalize the POST body's `models` array. Returns null on any
// validation failure (caller responds 400), otherwise the normalized list.
function normalizeModels(models) {
  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_MODELS) return null;

  const out = [];
  for (const model of models) {
    if (!model || typeof model !== "object") return null;
    const id = model.id;
    if (typeof id !== "string" || id.trim() === "") return null;

    const kind = IMPORT_KINDS.includes(model.kind) ? model.kind : "llm";
    const name = typeof model.name === "string" && model.name.trim() ? model.name : id;
    const contextLength = Number.isInteger(model.contextLength) && model.contextLength > 0 ? model.contextLength : null;
    const reasoning = typeof model.reasoning === "boolean" ? model.reasoning : null;
    out.push({ id, kind, name, contextLength, reasoning });
  }
  return out;
}

// GET /api/models/import/[providerId] - importable candidates + saved rule
export async function GET(request, { params }) {
  const { providerId } = await params;
  if (!isKnownProvider(providerId)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }

  try {
    const candidates = await listImportCandidates(providerId);
    const rule = await getImportRule(providerId);
    return NextResponse.json({ ...candidates, rule });
  } catch (error) {
    console.log("Error listing import candidates:", error);
    return NextResponse.json({ error: error?.message || String(error) }, { status: 502 });
  }
}

// POST /api/models/import/[providerId] - stream an import batch as NDJSON
export async function POST(request, { params }) {
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

  const models = normalizeModels(body?.models);
  if (!models) {
    return NextResponse.json(
      { error: "models must be a non-empty array (max 1000) of { id }" },
      { status: 400 },
    );
  }

  const testFirst = body?.testFirst === true;
  const storageAlias = resolveStorageAlias(providerId);
  const forceKind =
    isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId) ? "llm" : null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const onAbort = () => {
        // Stop enqueueing on client disconnect. runImport also gets the same
        // signal: it stops starting new models once aborted, but lets any
        // in-flight probe/import finish rather than cutting it off mid-call.
        closed = true;
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      const emit = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };

      try {
        await runImport({ storageAlias, models, testFirst, forceKind, signal: request.signal, onEvent: emit });
      } catch (error) {
        emit({ type: "error", error: error?.message || String(error) });
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed/errored — nothing left to do.
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
