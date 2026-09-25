// Incremental NDJSON (newline-delimited JSON) line splitter for streaming
// fetch bodies (`response.body.getReader()` + TextDecoder). Callers keep a
// `buffer` string across chunks; each decoded chunk is fed in along with the
// leftover from the previous call, and complete, parsed lines come back
// together with the new remainder to carry forward. A malformed complete
// line is dropped rather than thrown, so one bad line never kills the reader
// loop mid-stream.

export function splitNdjsonLines(buffer, chunkText) {
  const combined = (buffer || "") + (chunkText || "");
  const lines = combined.split(/\r?\n/);
  const remainder = lines.pop() ?? "";

  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed line — never let a bad line abort the stream reader.
    }
  }

  return { events, remainder };
}

// Parse whatever is left in `buffer` once the stream has ended (the final
// line may not be newline-terminated). Returns [] on empty/malformed input.
export function flushNdjsonBuffer(buffer) {
  const trimmed = (buffer || "").trim();
  if (!trimmed) return [];
  try {
    return [JSON.parse(trimmed)];
  } catch {
    return [];
  }
}
