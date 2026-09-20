import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Anchored on this module, not process.cwd(): the canonical suite runs from tests/
// (CLAUDE.md), where a cwd-relative src/ path breaks when vitest is started from
// the repo root instead.
const buttonSource = readFileSync(
  fileURLToPath(new URL("../../src/shared/components/Button.js", import.meta.url)),
  "utf8"
);

// These are source-level tripwires, not behavior tests: Button.js renders JSX, which
// this node-environment suite cannot import (no jsdom/JSX loader configured here).
describe("Button source invariants", () => {
  it("exports a React default export function from Button.js", () => {
    expect(buttonSource).toContain("export default function Button");
  });

  it("keeps a keyboard focus-visible ring style", () => {
    expect(buttonSource).toContain("focus-visible:ring-2");
    expect(buttonSource).toContain("focus-visible:outline-none");
  });

  it("marks the async loading state with aria-busy", () => {
    expect(buttonSource).toContain("aria-busy={loading || undefined}");
  });

  it("hides decorative icons from screen readers only when a text label exists", () => {
    expect(buttonSource).toContain('aria-hidden={children ? "true" : undefined}');
  });
});
