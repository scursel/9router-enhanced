import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../../open-sse/config/codexInstructions.js";

const ENV = "CODEX_SYSTEM_PROMPT_LAYOUT";
const credentials = { connectionId: "fixture", accessToken: "fixture-token" };
let saved;
beforeEach(() => { saved = process.env[ENV]; });
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

const makeBody = () => ({
  model: "gpt-5.5",
  input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "SYSTEM-PROMPT-ALPHA" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ],
});
const run = () => new CodexExecutor().transformRequest("gpt-5.5", makeBody(), true, credentials);

describe("CODEX_SYSTEM_PROMPT_LAYOUT", () => {
  it("default folds leading system text into instructions", () => {
    delete process.env[ENV];
    const body = run();
    expect(body.instructions).toContain("SYSTEM-PROMPT-ALPHA");
    expect(body.input.map(i => i.role)).toEqual(["user"]);
  });

  it("input keeps developer items in input and does not copy them into instructions", () => {
    process.env[ENV] = "input";
    const body = run();
    expect(body.instructions).toBe(CODEX_DEFAULT_INSTRUCTIONS);
    expect(body.instructions).not.toContain("SYSTEM-PROMPT-ALPHA");
    expect(body.input.map(i => i.role)).toEqual(["developer", "user"]);
    expect(body.input[0].content[0].text).toBe("SYSTEM-PROMPT-ALPHA");
  });

  it("input converts a system role to developer like upstream", () => {
    process.env[ENV] = "input";
    const b = makeBody();
    b.input[0].role = "system";
    const body = new CodexExecutor().transformRequest("gpt-5.5", b, true, credentials);
    expect(body.input[0].role).toBe("developer");
  });

  it("unknown value behaves like the default", () => {
    process.env[ENV] = "bogus";
    const body = run();
    expect(body.instructions).toContain("SYSTEM-PROMPT-ALPHA");
    expect(body.input.map(i => i.role)).toEqual(["user"]);
  });
});
