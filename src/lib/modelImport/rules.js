// Per-provider auto-import rules, used by the (future) daily auto-import job
// to decide which providers to sweep and with what filters/testFirst setting.
// Stored under the settings key `autoModelImportRules`; updateSettings only
// merges top-level keys, so every write here is a full read-modify-write of
// that whole object.
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { normalizeImportFilters } from "@/shared/utils/importProviderModels.js";

export async function getImportRule(providerId) {
  const settings = await getSettings();
  const rules = settings.autoModelImportRules || {};
  return Object.hasOwn(rules, providerId) ? rules[providerId] : null;
}

export async function listImportRules() {
  const settings = await getSettings();
  return settings.autoModelImportRules || {};
}

export async function saveImportRule(providerId, { filters, testFirst } = {}) {
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

export async function deleteImportRule(providerId) {
  const settings = await getSettings();
  const rules = { ...(settings.autoModelImportRules || {}) };
  delete rules[providerId];
  await updateSettings({ autoModelImportRules: rules });
}
