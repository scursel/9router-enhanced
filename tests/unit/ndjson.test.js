import { describe, expect, it } from "vitest";
import { splitNdjsonLines, flushNdjsonBuffer } from "@/shared/utils/ndjson.js";

describe("splitNdjsonLines", () => {
  it("parses complete lines and carries the trailing partial line as remainder", () => {
    const chunk = '{"type":"start","total":2}\n{"type":"testing","id":"a"}\n{"type":"test';
    const { events, remainder } = splitNdjsonLines("", chunk);
    expect(events).toEqual([
      { type: "start", total: 2 },
      { type: "testing", id: "a" },
    ]);
    expect(remainder).toBe('{"type":"test');
  });

  it("stitches a remainder from a previous chunk onto the next chunk's start", () => {
    const first = splitNdjsonLines("", '{"type":"testing",');
    expect(first.events).toEqual([]);
    expect(first.remainder).toBe('{"type":"testing",');

    const second = splitNdjsonLines(first.remainder, '"id":"a"}\n{"type":"imported","id":"a"}\n');
    expect(second.events).toEqual([
      { type: "testing", id: "a" },
      { type: "imported", id: "a" },
    ]);
    expect(second.remainder).toBe("");
  });

  it("handles CRLF line endings", () => {
    const { events, remainder } = splitNdjsonLines("", '{"a":1}\r\n{"b":2}\r\n');
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(remainder).toBe("");
  });

  it("skips blank lines", () => {
    const { events } = splitNdjsonLines("", '{"a":1}\n\n{"b":2}\n');
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("drops a malformed complete line instead of throwing", () => {
    const { events, remainder } = splitNdjsonLines("", "not json\n{\"a\":1}\n");
    expect(events).toEqual([{ a: 1 }]);
    expect(remainder).toBe("");
  });

  it("returns no events and empty remainder for an empty chunk", () => {
    const { events, remainder } = splitNdjsonLines("", "");
    expect(events).toEqual([]);
    expect(remainder).toBe("");
  });
});

describe("flushNdjsonBuffer", () => {
  it("parses a final unterminated line once the stream ends", () => {
    expect(flushNdjsonBuffer('{"type":"done","imported":1,"failed":0}')).toEqual([
      { type: "done", imported: 1, failed: 0 },
    ]);
  });

  it("returns an empty array for an empty or whitespace-only buffer", () => {
    expect(flushNdjsonBuffer("")).toEqual([]);
    expect(flushNdjsonBuffer("   ")).toEqual([]);
    expect(flushNdjsonBuffer(undefined)).toEqual([]);
  });

  it("returns an empty array for a malformed trailing line", () => {
    expect(flushNdjsonBuffer("not json")).toEqual([]);
  });
});
