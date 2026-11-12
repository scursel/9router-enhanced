// Per-provider auto-import rules, used by the (future) daily auto-import job
// to decide which providers to sweep and with what filters/testFirst setting.
// Stored under the settings key `autoModelImportRules`; updateSettings only
// merges top-level keys, so every write here is a full read-modify-write of
// that whole object.
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { normalizeImportFilters } from "@/shared/utils/importProviderModels.js";

// Serialise read-modify-write cycles: two concurrent saves for different providers
// would otherwise both read the same snapshot and the later write would drop the
// earlier provider's rule.
let writeChain = Promise.resolve();
function withRulesLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

export async function getImportRule(providerId) {
  const settings = await getSettings();
  const rules = settings.autoModelImportRules || {};
  return Object.hasOwn(rules, providerId) ? rules[providerId] : null;
}

export async function listImportRules() {
  const settings = await getSettings();
  return settings.autoModelImportRules || {};
}

export function saveImportRule(providerId, opts = {}) {
  return withRulesLock(() => saveImportRuleUnlocked(providerId, opts));
}

async function saveImportRuleUnlocked(providerId, { filters, testFirst } = {}) {
  const settings = await getSettings();
  const rules = { ...(settings.autoModelImportRules || {}) };

  const rule = {
    filters: normalizeImportFilters(filters),
    testFirst: testFirst === true,
    updatedAt: new Date().toISOString(),
  };
  rules[providerId] = rule;

  await updateSettings({ autoModelImportRules: rules });
  return rule;
}

export function deleteImportRule(providerId) {
  return withRulesLock(() => deleteImportRuleUnlocked(providerId));
}

async function deleteImportRuleUnlocked(providerId) {
  const settings = await getSettings();
  const rules = { ...(settings.autoModelImportRules || {}) };
  delete rules[providerId];
  await updateSettings({ autoModelImportRules: rules });
}
