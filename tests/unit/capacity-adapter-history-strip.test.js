import { describe, expect, it } from "vitest";
import { stripHistoryForContext } from "../../open-sse/services/capacityAdapter.js";

// The capacity adapter (e.g. a vision fallback) trims history to fit the
// adapter model's window. It used to ALWAYS cut to the first 6 messages + the
// trailing turn, even when everything fit — and the cut could drop the
// assistant turn whose tool_calls the trailing tool results answer, which
// every upstream rejects (400: tool result without matching call).
function agentConversation(turns) {
  const messages = [{ role: "system", content: "sys" }, { role: "user", content: "task" }];
  for (let t = 0; t < turns; t++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: `c${t}`, type: "function", function: { name: "read", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `c${t}`, content: `result ${t} `.repeat(50) });
  }
  return { messages };
}

function assertToolPairing(messages) {
  const calls = new Set();
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.tool_calls || []) calls.add(c.id);
    if (m.role === "tool") expect(calls.has(m.tool_call_id), `orphan tool result ${m.tool_call_id}`).toBe(true);
  }
  // every call must be answered too
  const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const id of calls) expect(answered.has(id), `unanswered tool call ${id}`).toBe(true);
}

describe("stripHistoryForContext", () => {
  it("leaves a conversation that fits the window untouched", () => {
    const body = agentConversation(12);
    expect(stripHistoryForContext(body, 1_000_000)).toBe(body);
  });

  it("when it must trim, keeps tool calls and results paired and the latest turn intact", () => {
    const body = agentConversation(40);
    const out = stripHistoryForContext(body, 5_000); // ~16k chars budget, conversation is ~45k
    expect(out).not.toBe(body);
    expect(out.messages.length).toBeLessThan(body.messages.length);
    expect(out.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(out.messages.at(-1)).toEqual(body.messages.at(-1));
    expect(out.messages.at(-2)).toEqual(body.messages.at(-2)); // the call the last result answers
    assertToolPairing(out.messages);
  });

  it("keeps recent turns rather than only the head when there is room", () => {
    const body = agentConversation(40);
    const out = stripHistoryForContext(body, 5_000);
    const kept = new Set(out.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    expect(kept.has("c38"), "the turn before the latest is still there").toBe(true);
  });
});
