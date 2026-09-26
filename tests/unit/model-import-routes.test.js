// Task 3 — API routes under src/app/api/models/import/. Lib modules are
// mocked so these are pure route-contract tests (validation, status codes,
// NDJSON framing, provider-id guard).
import { describe, it, expect, vi, beforeEach } from "vitest";

const listImportCandidates = vi.fn();
const resolveStorageAlias = vi.fn((providerId) => `alias-${providerId}`);
const runImport = vi.fn();
const getImportRule = vi.fn();
const saveImportRule = vi.fn();
const deleteImportRule = vi.fn();
const listImportRules = vi.fn();
const runAllAutoImports = vi.fn();
const getSettings = vi.fn();

vi.mock("@/lib/modelImport/candidates.js", () => ({
  listImportCandidates: (...args) => listImportCandidates(...args),
  resolveStorageAlias: (...args) => resolveStorageAlias(...args),
}));
vi.mock("@/lib/modelImport/runImport.js", () => ({
  runImport: (...args) => runImport(...args),
}));
vi.mock("@/lib/modelImport/rules.js", () => ({
  getImportRule: (...args) => getImportRule(...args),
  saveImportRule: (...args) => saveImportRule(...args),
  deleteImportRule: (...args) => deleteImportRule(...args),
  listImportRules: (...args) => listImportRules(...args),
}));
vi.mock("@/lib/modelImport/autoImport.js", () => ({
  runAllAutoImports: (...args) => runAllAutoImports(...args),
}));
vi.mock("@/lib/db/index.js", () => ({
  getSettings: (...args) => getSettings(...args),
}));

const { GET: candidatesGET, POST: candidatesPOST } = await import(
  "@/app/api/models/import/[providerId]/route.js"
);
const { PUT: rulePUT, DELETE: ruleDELETE } = await import(
  "@/app/api/models/import/[providerId]/rule/route.js"
);
const { GET: autoGET, POST: autoPOST } = await import("@/app/api/models/import/auto/route.js");
const { isKnownProvider } = await import("@/app/api/models/import/isKnownProvider.js");

const KNOWN_PROVIDER = "openrouter";
const UNKNOWN_PROVIDER = "definitely-not-a-real-provider-xyz";
const COMPATIBLE_PROVIDER = "openai-compatible-my-node";

function paramsFor(providerId) {
  return { params: Promise.resolve({ providerId }) };
}

async function readNdjson(res) {
  const text = await res.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveStorageAlias.mockImplementation((providerId) => `alias-${providerId}`);
});

// ---------------------------------------------------------------------------
// isKnownProvider — prototype-pollution-shaped ids must not walk the
// prototype chain (Object.hasOwn, not `in`).
// ---------------------------------------------------------------------------
describe("isKnownProvider", () => {
  it("returns false for prototype-property-shaped ids like 'constructor'", () => {
    expect(isKnownProvider("constructor")).toBe(false);
    expect(isKnownProvider("toString")).toBe(false);
    expect(isKnownProvider("hasOwnProperty")).toBe(false);
  });

  it("still returns true for a real registry provider", () => {
    expect(isKnownProvider(KNOWN_PROVIDER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/models/import/[providerId]
// ---------------------------------------------------------------------------
describe("GET [providerId]", () => {
  it("returns candidates spread with rule attached", async () => {
    listImportCandidates.mockResolvedValue({
      providerId: KNOWN_PROVIDER,
      storageAlias: "openrouter",
      source: "catalog",
      connectionId: null,
      candidates: [{ id: "m1" }],
    });
    getImportRule.mockResolvedValue({ filters: {}, testFirst: false });

    const req = new Request(`http://localhost/api/models/import/${KNOWN_PROVIDER}`);
    const res = await candidatesGET(req, paramsFor(KNOWN_PROVIDER));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      providerId: KNOWN_PROVIDER,
      storageAlias: "openrouter",
      source: "catalog",
      connectionId: null,
      candidates: [{ id: "m1" }],
      rule: { filters: {}, testFirst: false },
    });
    expect(listImportCandidates).toHaveBeenCalledWith(KNOWN_PROVIDER);
  });

  it("502s with the error message when listImportCandidates throws", async () => {
    listImportCandidates.mockRejectedValue(new Error("upstream exploded"));
    const req = new Request(`http://localhost/api/models/import/${KNOWN_PROVIDER}`);
    const res = await candidatesGET(req, paramsFor(KNOWN_PROVIDER));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toBe("upstream exploded");
  });

  it("404s for an unknown provider without calling the lib", async () => {
    const req = new Request(`http://localhost/api/models/import/${UNKNOWN_PROVIDER}`);
    const res = await candidatesGET(req, paramsFor(UNKNOWN_PROVIDER));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Unknown provider");
    expect(listImportCandidates).not.toHaveBeenCalled();
  });

  it("accepts an openai-compatible-* node id even though it's not a registry key", async () => {
    listImportCandidates.mockResolvedValue({ providerId: COMPATIBLE_PROVIDER, candidates: [] });
    getImportRule.mockResolvedValue(null);
    const req = new Request(`http://localhost/api/models/import/${COMPATIBLE_PROVIDER}`);
    const res = await candidatesGET(req, paramsFor(COMPATIBLE_PROVIDER));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/models/import/[providerId]
// ---------------------------------------------------------------------------
describe("POST [providerId]", () => {
  function postReq(providerId, body) {
    return new Request(`http://localhost/api/models/import/${providerId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("404s for an unknown provider", async () => {
    const res = await candidatesPOST(postReq(UNKNOWN_PROVIDER, { models: [{ id: "a" }] }), paramsFor(UNKNOWN_PROVIDER));
    expect(res.status).toBe(404);
    expect(runImport).not.toHaveBeenCalled();
  });

  it.each([
    ["missing models", {}],
    ["empty array", { models: [] }],
    ["non-array", { models: "nope" }],
    ["over 1000 entries", { models: Array.from({ length: 1001 }, (_, i) => ({ id: `m${i}` })) }],
    ["bad id (missing)", { models: [{ name: "no id" }] }],
    ["bad id (empty string)", { models: [{ id: "" }] }],
    ["bad id (non-string)", { models: [{ id: 42 }] }],
  ])("400s on %s", async (_label, body) => {
    const res = await candidatesPOST(postReq(KNOWN_PROVIDER, body), paramsFor(KNOWN_PROVIDER));
    expect(res.status).toBe(400);
    expect(runImport).not.toHaveBeenCalled();
  });

  it("coerces an invalid kind to llm and defaults name to id, streams NDJSON events", async () => {
    runImport.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: "start", total: 1, testFirst: false });
      onEvent({ type: "imported", id: "m1" });
      onEvent({ type: "done", imported: 1, failed: 0 });
      return { imported: ["m1"], failed: [] };
    });

    const res = await candidatesPOST(
      postReq(KNOWN_PROVIDER, { models: [{ id: "m1", kind: "not-a-kind" }] }),
      paramsFor(KNOWN_PROVIDER),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(runImport).toHaveBeenCalledWith(
      expect.objectContaining({
        storageAlias: `alias-${KNOWN_PROVIDER}`,
        models: [{ id: "m1", kind: "llm", name: "m1" , contextLength: null, reasoning: null }],
        testFirst: false,
      }),
    );
    const events = await readNdjson(res);
    expect(events.map((e) => e.type)).toEqual(["start", "imported", "done"]);
  });

  it("passes forceKind:'llm' to runImport for an openai-compatible-* node id", async () => {
    runImport.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: "done", imported: 0, failed: 0 });
      return { imported: [], failed: [] };
    });

    await candidatesPOST(
      postReq(COMPATIBLE_PROVIDER, { models: [{ id: "m1", kind: "embedding" }] }),
      paramsFor(COMPATIBLE_PROVIDER),
    );

    expect(runImport).toHaveBeenCalledWith(expect.objectContaining({ forceKind: "llm" }));
  });

  it("does not force a kind for a regular registry provider", async () => {
    runImport.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: "done", imported: 0, failed: 0 });
      return { imported: [], failed: [] };
    });

    await candidatesPOST(postReq(KNOWN_PROVIDER, { models: [{ id: "m1" }] }), paramsFor(KNOWN_PROVIDER));

    expect(runImport).toHaveBeenCalledWith(expect.objectContaining({ forceKind: null }));
  });

  it("passes testFirst through only when strictly true, and keeps a valid kind/name", async () => {
    runImport.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: "done", imported: 0, failed: 0 });
      return { imported: [], failed: [] };
    });

    await candidatesPOST(
      postReq(KNOWN_PROVIDER, {
        models: [{ id: "m1", kind: "embedding", name: "My Model" , contextLength: null, reasoning: null }],
        testFirst: "yes",
      }),
      paramsFor(KNOWN_PROVIDER),
    );

    expect(runImport).toHaveBeenCalledWith(
      expect.objectContaining({
        models: [{ id: "m1", kind: "embedding", name: "My Model" , contextLength: null, reasoning: null }],
        testFirst: false,
      }),
    );
  });

  it("passes the request's AbortSignal through to runImport", async () => {
    runImport.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: "done", imported: 0, failed: 0 });
      return { imported: [], failed: [] };
    });

    const controller = new AbortController();
    const req = new Request(`http://localhost/api/models/import/${KNOWN_PROVIDER}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: [{ id: "m1" }] }),
      signal: controller.signal,
    });

    await candidatesPOST(req, paramsFor(KNOWN_PROVIDER));

    // req.signal isn't guaranteed to be the exact same object identity as
    // controller.signal across Request implementations, so assert on the
    // request's own signal and its abort-following behavior instead.
    expect(runImport).toHaveBeenCalledWith(
      expect.objectContaining({ signal: req.signal }),
    );
    const passedSignal = runImport.mock.calls[0][0].signal;
    expect(passedSignal.aborted).toBe(false);
    controller.abort();
    expect(passedSignal.aborted).toBe(true);
  });

  it("404s an unknown provider even when providerId is 'constructor'", async () => {
    const res = await candidatesPOST(postReq("constructor", { models: [{ id: "a" }] }), paramsFor("constructor"));
    expect(res.status).toBe(404);
    expect(runImport).not.toHaveBeenCalled();
  });

  it("emits an error event and still closes cleanly when runImport throws", async () => {
    runImport.mockImplementation(async ({ onEvent }) => {
      onEvent({ type: "start", total: 1, testFirst: false });
      throw new Error("boom");
    });

    const res = await candidatesPOST(
      postReq(KNOWN_PROVIDER, { models: [{ id: "m1" }] }),
      paramsFor(KNOWN_PROVIDER),
    );
    expect(res.status).toBe(200);
    const events = await readNdjson(res);
    expect(events[0]).toEqual({ type: "start", total: 1, testFirst: false });
    expect(events[events.length - 1]).toEqual({ type: "error", error: "boom" });
  });
});

// ---------------------------------------------------------------------------
// PUT/DELETE /api/models/import/[providerId]/rule
// ---------------------------------------------------------------------------
describe("[providerId]/rule", () => {
  function putReq(providerId, body) {
    return new Request(`http://localhost/api/models/import/${providerId}/rule`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("PUT saves the rule and returns it", async () => {
    saveImportRule.mockResolvedValue({ filters: { onlyNew: true }, testFirst: true, updatedAt: "now" });
    const res = await rulePUT(
      putReq(KNOWN_PROVIDER, { filters: { onlyNew: true }, testFirst: true }),
      paramsFor(KNOWN_PROVIDER),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ rule: { filters: { onlyNew: true }, testFirst: true, updatedAt: "now" } });
    expect(saveImportRule).toHaveBeenCalledWith(KNOWN_PROVIDER, { filters: { onlyNew: true }, testFirst: true });
  });

  it("PUT 404s for an unknown provider", async () => {
    const res = await rulePUT(putReq(UNKNOWN_PROVIDER, {}), paramsFor(UNKNOWN_PROVIDER));
    expect(res.status).toBe(404);
    expect(saveImportRule).not.toHaveBeenCalled();
  });

  it("PUT 400s with 'Invalid JSON body' on malformed JSON, like POST does", async () => {
    const req = new Request(`http://localhost/api/models/import/${KNOWN_PROVIDER}/rule`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const res = await rulePUT(req, paramsFor(KNOWN_PROVIDER));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toEqual({ error: "Invalid JSON body" });
    expect(saveImportRule).not.toHaveBeenCalled();
  });

  it("DELETE removes the rule", async () => {
    deleteImportRule.mockResolvedValue(undefined);
    const req = new Request(`http://localhost/api/models/import/${KNOWN_PROVIDER}/rule`, { method: "DELETE" });
    const res = await ruleDELETE(req, paramsFor(KNOWN_PROVIDER));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true });
    expect(deleteImportRule).toHaveBeenCalledWith(KNOWN_PROVIDER);
  });

  it("DELETE 404s for an unknown provider", async () => {
    const req = new Request(`http://localhost/api/models/import/${UNKNOWN_PROVIDER}/rule`, { method: "DELETE" });
    const res = await ruleDELETE(req, paramsFor(UNKNOWN_PROVIDER));
    expect(res.status).toBe(404);
    expect(deleteImportRule).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET/POST /api/models/import/auto
// ---------------------------------------------------------------------------
describe("auto", () => {
  it("GET returns settings.autoModelImport and rules", async () => {
    getSettings.mockResolvedValue({ autoModelImport: { enabled: true, hour: 4 }, other: "x" });
    listImportRules.mockResolvedValue({ openrouter: { filters: {}, testFirst: false } });

    const res = await autoGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      settings: { enabled: true, hour: 4 },
      rules: { openrouter: { filters: {}, testFirst: false } },
    });
  });

  it("POST returns 200 with the sweep result on success", async () => {
    runAllAutoImports.mockResolvedValue({ busy: false, at: "2026-01-01T00:00:00.000Z", providers: [] });
    const res = await autoPOST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ busy: false, at: "2026-01-01T00:00:00.000Z", providers: [] });
  });

  it("POST returns 409 when the sweep reports busy", async () => {
    runAllAutoImports.mockResolvedValue({ busy: true });
    const res = await autoPOST();
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data).toEqual({ error: "Auto-import already running" });
  });

  it("POST returns 500 on a sweep-level error", async () => {
    runAllAutoImports.mockResolvedValue({ busy: false, error: "settings I/O failed" });
    const res = await autoPOST();
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data).toEqual({ error: "settings I/O failed" });
  });
});
