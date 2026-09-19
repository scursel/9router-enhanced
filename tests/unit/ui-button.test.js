import { describe, it, expect } from "vitest";

describe("Button UI Component File Integrity & Exports", () => {
  it("exports a React default export function from Button.js", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const buttonCode = fs.readFileSync(
      path.resolve(process.cwd(), "../src/shared/components/Button.js"),
      "utf8"
    );

    expect(buttonCode).toContain('export default function Button');
  });

  it("includes accessibility focus-visible ring styles", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const buttonCode = fs.readFileSync(
      path.resolve(process.cwd(), "../src/shared/components/Button.js"),
      "utf8"
    );

    expect(buttonCode).toContain("focus-visible:ring-2");
    expect(buttonCode).toContain("focus-visible:outline-none");
    expect(buttonCode).toContain("focus-visible:ring-brand-500/50");
  });

  it("includes aria-busy indicator for loading state", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const buttonCode = fs.readFileSync(
      path.resolve(process.cwd(), "../src/shared/components/Button.js"),
      "utf8"
    );

    expect(buttonCode).toContain("aria-busy={loading || undefined}");
  });

  it("includes aria-hidden='true' for icon elements", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const buttonCode = fs.readFileSync(
      path.resolve(process.cwd(), "../src/shared/components/Button.js"),
      "utf8"
    );

    expect(buttonCode).toContain('aria-hidden="true"');
  });
});
