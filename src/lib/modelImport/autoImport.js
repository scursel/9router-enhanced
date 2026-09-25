// Daily auto-import core: for each saved per-provider rule (Task 3's
// rules.js), pulls fresh candidates, applies the rule's filters (forcing
// onlyNew so an auto sweep never re-imports something the user removed), and
// hands the survivors to Task 2's runImport(). Never removes models — this
// module only ever adds.
import { listImportCandidates } from "./candidates.js";
import { runImport } from "./runImport.js";
import { listImportRules } from "./rules.js";
import { applyImportFilters } from "@/shared/utils/importProviderModels.js";
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

// Pure: does cfg (settings.autoModelImport) call for a run right now?
// `now`'s LOCAL calendar day is what "already ran today" is measured against,
// matching the hour also being read in local time (the dashboard's `hour`
// picker is local-time too).
const DEFAULT_AUTO_IMPORT_HOUR = 4;

export function isAutoImportDue(cfg, now = new Date()) {
  if (!cfg || cfg.enabled !== true) return false;
  const hour = Number.isInteger(cfg.hour) && cfg.hour >= 0 && cfg.hour <= 23
    ? cfg.hour
    : DEFAULT_AUTO_IMPORT_HOUR;
  if (now.getHours() < hour) return false;
  if (!cfg.lastRunAt) return true;

  const last = new Date(cfg.lastRunAt);
  if (Number.isNaN(last.getTime())) return true;

  const sameLocalDay =
    last.getFullYear() === now.getFullYear() &&
    last.getMonth() === now.getMonth() &&
    last.getDate() === now.getDate();

  return !sameLocalDay;
}

/**
 * Sweep one provider against its saved rule. Never throws — any failure
 * (candidate lookup, import) is captured on the returned result so a bad
 * provider doesn't take down the rest of the sweep.
 * @param {string} providerId
 * @param {{ filters?: object, testFirst?: boolean }} rule
 * @param {{ listImportCandidates?: Function, runImport?: Function }} [deps]
 */
export async function runAutoImportForProvider(providerId, rule, deps = {}) {
  const listCandidates = deps.listImportCandidates || listImportCandidates;
  const doImport = deps.runImport || runImport;

  try {
    const { storageAlias, candidates } = await listCandidates(providerId, {});
    const filtered = applyImportFilters(candidates, { ...rule?.filters, onlyNew: true });

    if (filtered.length === 0) {
      return { providerId, imported: 0, failed: 0 };
    }

    const models = filtered.map((c) => ({ id: c.id, kind: c.kind, name: c.name }));
    const importArgs = { storageAlias, models, testFirst: rule?.testFirst === true };
    // Compatible-node providers (openai-compatible-*/anthropic-compatible-*)
    // always store imported models as "llm" — CompatibleModelsSection only
    // displays llm rows. The probe itself still runs with the model's own
    // kind; only the stored type is forced.
    if (isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId)) {
      importArgs.forceKind = "llm";
    }
    const result = await doImport(importArgs);

    return { providerId, imported: result.imported.length, failed: result.failed.length };
  } catch (error) {
    const message = error?.message || String(error);
    console.log(`[modelImport] auto-import failed for ${providerId} (swallowed): ${message}`);
    return { providerId, imported: 0, failed: 0, error: message };
  }
}

// Module-level single-flight lock: a slow sweep (or one triggered manually
// while the timer's own tick is mid-run) must not overlap another.
let running = false;

/**
 * Run every saved rule sequentially, then persist the sweep's outcome.
 * Never throws: a sweep-level failure (rules/settings I/O) is logged and
 * returned as `{ busy: false, error }` so callers can surface it.
 * @param {{ listImportRules?: Function, getSettings?: Function,
 *           updateSettings?: Function, listImportCandidates?: Function,
 *           runImport?: Function, runAutoImportForProvider?: Function }} [deps]
 */
export async function runAllAutoImports(deps = {}) {
  if (running) return { busy: true };
  running = true;

  try {
    const listRules = deps.listImportRules || listImportRules;
    const loadSettings = deps.getSettings || getSettings;
    const saveSettings = deps.updateSettings || updateSettings;
    const runForProvider = deps.runAutoImportForProvider || runAutoImportForProvider;

    const rules = await listRules();
    const providers = [];
    for (const [providerId, rule] of Object.entries(rules)) {
      const result = await runForProvider(providerId, rule, deps);
      providers.push(result);
    }

    const at = new Date().toISOString();
    const settings = await loadSettings();
    const current = settings.autoModelImport || {};

    // A sweep where every rule errored out (connection down, DB hiccup, …)
    // didn't really "run" — leave lastRunAt alone so the next 15-minute tick
    // retries today instead of waiting until tomorrow. Still persist
    // lastResult so the settings card can show the errors.
    const allProvidersErrored = providers.length > 0 && providers.every((p) => Boolean(p?.error));
    await saveSettings({
      autoModelImport: {
        ...current,
        lastRunAt: allProvidersErrored ? current.lastRunAt : at,
        lastResult: { at, providers },
      },
    });

    return { busy: false, at, providers };
  } catch (error) {
    console.log(`[modelImport] auto-import sweep failed (swallowed): ${error?.message || error}`);
    return { busy: false, error: error?.message || String(error) };
  } finally {
    running = false;
  }
}
