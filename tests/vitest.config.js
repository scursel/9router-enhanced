import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // JSX lives in plain .js files across src/shared/components/ (Next.js style), and
  // component tests under tests/ render JSX too. Vitest 4 transforms with oxc
  // (rolldown) — esbuild options are ignored here. Plain JavaScript parses fine as
  // a superset, so widening the transform is safe for the suite.
  oxc: {
    // Force the oxc parser to allow JSX syntax inside the matched .js files
    // (vite derives `lang` from the extension otherwise and rejects JSX in .js).
    lang: "jsx",
    jsx: {
      runtime: "automatic",
      importSource: "react",
    },
    include: [/src\/shared\/components\/.*\.js$/, /tests\/.*\.test\.js$/],
    exclude: [],
  },
  test: {
    environment: "node",
    // Must run before any test imports src/lib/db — see the file header.
    globalSetup: ["./setup/isolate-data-dir.js"],
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
