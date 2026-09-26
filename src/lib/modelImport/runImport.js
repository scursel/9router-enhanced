// Runs an import batch: optionally probes each model with a real upstream
// call before writing it as a custom model, so a picked-but-broken model
// never lands silently. Progress streams out through onEvent so a route can
// forward it as SSE.
import { pingModelWithFallback } from "@/app/api/models/test/ping.js";
import { addCustomModel, setModelMeta } from "@/lib/db/index.js";
import { internalBaseUrl } from "./internal.js";

export const IMPORT_TEST_CONCURRENCY = 4;

function dedupeById(models) {
  const seen = new Set();
  const out = [];
  for (const model of models || []) {
    const id = model?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(model);
  }
  return out;
}

export async function runImport({
  storageAlias,
  models,
  testFirst = false,
  concurrency = IMPORT_TEST_CONCURRENCY,
  onEvent = () => {},
  signal = null,
  forceKind = null,
  deps = {},
}) {
  const ping = deps.ping || pingModelWithFallback;
  const addModel = deps.addModel || addCustomModel;
  const saveMeta = deps.saveMeta || ((...args) => setModelMeta(...args));
  const baseUrl = deps.baseUrl || internalBaseUrl();

  const deduped = dedupeById(models);
  const imported = [];
  const failed = [];
  const aborted = () => signal?.aborted === true;

  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // onEvent is a progress hook — never let a listener error abort the import.
    }
  };

  emit({ type: "start", total: deduped.length, testFirst });

  const importModel = async (model, kindOverride) => {
    try {
      await addModel({
        providerAlias: storageAlias,
        id: model.id,
        type: forceKind || kindOverride || model.kind || "llm",
        name: model.name,
      });
      imported.push(model.id);
      // Context window / reasoning as the provider's own list reported them.
      if (model.contextLength || typeof model.reasoning === "boolean") {
        try {
          await saveMeta(storageAlias, model.id, {
            contextWindow: model.contextLength, reasoning: model.reasoning, source: "provider",
          });
        } catch { /* metadata is a nicety; the import itself succeeded */ }
      }
      emit({ type: "imported", id: model.id });
    } catch (error) {
      const message = error?.message || String(error);
      failed.push({ id: model.id, error: message });
      emit({ type: "failed", id: model.id, error: message });
    }
  };

  // ping.js has no dedicated tts probe (it falls back to an llm chat call,
  // which just burns a call and always fails for a tts-only model) — so a
  // tts model can never pass testFirst honestly. Fail it locally instead of
  // spending an upstream call whose result is meaningless.
  const testAndImportModel = async (model) => {
    if (model.kind === "tts") {
      const message = "Can't test TTS models — import with 'Test before import' off";
      failed.push({ id: model.id, error: message });
      emit({ type: "failed", id: model.id, error: message });
      return;
    }

    emit({ type: "testing", id: model.id });
    let result;
    try {
      result = await ping(`${storageAlias}/${model.id}`, model.kind || "llm", baseUrl);
    } catch (error) {
      const message = error?.message || String(error);
      failed.push({ id: model.id, error: message });
      emit({ type: "failed", id: model.id, error: message });
      return;
    }

    emit({ type: "tested", id: model.id, ok: result.ok, error: result.error, latencyMs: result.latencyMs });

    if (!result.ok) {
      const message = result.error || `HTTP ${result.status}`;
      failed.push({ id: model.id, error: message });
      emit({ type: "failed", id: model.id, error: message });
      return;
    }

    await importModel(model, result.kind);
  };

  if (testFirst) {
    if (deduped.length > 0 && !aborted()) {
      // Warm-up: ping the first model alone first (token refresh etc. happens
      // once, not once per concurrent worker), then run the rest through a
      // bounded pool.
      await testAndImportModel(deduped[0]);

      const rest = deduped.slice(1);
      let cursor = 0;
      const workerCount = Math.min(concurrency, rest.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < rest.length && !aborted()) {
          const model = rest[cursor];
          cursor += 1;
          await testAndImportModel(model);
        }
      });
      await Promise.all(workers);
    }
  } else {
    for (const model of deduped) {
      if (aborted()) break;
      await importModel(model);
    }
  }

  emit({ type: "done", imported: imported.length, failed: failed.length });

  return { imported, failed };
}
