// Every test run gets a throwaway DATA_DIR before any test file imports the DB.
//
// Why: without it, tests that create provider connections (e.g.
// unit/zed-live-models.test.js) wrote into the developer's REAL ~/.9router — the
// same database the local 9router service serves from. Each `npx vitest run`
// added 5 fake Zed accounts and 1 "kimchi-nope" account to the live dashboard.
//
// Runs as Vitest globalSetup: the main process sets DATA_DIR before workers are
// forked (they inherit it), and the returned teardown deletes the directory.
// An explicit DATA_DIR is honoured only when it already lives under the OS temp
// dir; anything else (including unset) is replaced.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function isolateDataDir() {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const current = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : "";
  if (current && (current + path.sep).startsWith(tempRoot + path.sep)) return undefined;

  const dir = fs.mkdtempSync(path.join(tempRoot, "9router-test-data-"));
  process.env.DATA_DIR = dir;
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
