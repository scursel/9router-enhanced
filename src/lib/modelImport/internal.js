// Internal loopback call helpers for the model-import core. Mirrors the
// private helpers in src/app/api/models/test/ping.js (kept in sync by hand;
// don't import from there — this module must stay usable outside a request
// context, e.g. from the future daily auto-import job).
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getApiKeys } from "@/lib/db/index.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const CLI_TOKEN_SALT = "9r-cli-auth";

export function internalBaseUrl() {
  return `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
}

export async function getInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    apiKey = keys.find((k) => k.isActive !== false)?.key || null;
  } catch {}

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}
