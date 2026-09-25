// Daily auto-import timer — mirrors the modelSync/credentialHealth scheduler
// shape: a startup delay, then a recurring tick that re-checks settings and
// only runs a sweep when isAutoImportDue() says it's time (once per local
// day, at/after the configured hour). Fail-open: any tick error is logged
// and swallowed, never thrown, so a bad provider or a DB hiccup can't kill
// the timer.
import { getSettings } from "@/lib/db/index.js";
import { isAutoImportDue, runAllAutoImports } from "./autoImport.js";

let started = false;
let initialHandle = null;
let intervalHandle = null;

// Conservative: any NEXT_PHASE that is not a known server phase (dev or prod
// server) — e.g. production-build / phase-production-build / phase-export —
// must never arm background sweeps. Mirrors the T3.1/T3.3 guards.
function isNonServerProcess() {
  if (typeof window !== "undefined") return true;
  const phase = String(process.env.NEXT_PHASE || "");
  if (!phase) return false;
  return phase !== "phase-production-server" && phase !== "phase-development-server";
}

async function tick() {
  try {
    const settings = await getSettings();
    const cfg = settings.autoModelImport || {};
    if (isAutoImportDue(cfg, new Date())) {
      await runAllAutoImports();
    }
  } catch (error) {
    console.log(`[modelImport] auto-import tick failed (swallowed): ${error?.message || error}`);
  }
}

/**
 * Arm the daily auto-import timer. Idempotent — a second call is a no-op
 * until stopAutoModelImport() runs. Disabled during build/export phases.
 * @param {{ tickMs?: number, startupDelayMs?: number }} [opts]
 * @returns {boolean} true if this call started the scheduler
 */
export function startAutoModelImport({ tickMs = 15 * 60_000, startupDelayMs = 120_000 } = {}) {
  if (started) return false;
  if (isNonServerProcess()) return false;
  started = true;

  initialHandle = setTimeout(() => {
    tick();
  }, startupDelayMs);
  initialHandle.unref?.();

  intervalHandle = setInterval(() => {
    tick();
  }, tickMs);
  intervalHandle.unref?.();

  return true;
}

export function stopAutoModelImport() {
  if (initialHandle) {
    clearTimeout(initialHandle);
    initialHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
}
