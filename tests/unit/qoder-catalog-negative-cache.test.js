// A failed catalog fetch must not put a COSY-signed upstream call in front of
// every /v1/models listing while a credential is expired — but it also must not
// cache a sentinel entry, because routableQoderModels would read empty models as
// "the catalog says only Sonus/Cantus exist" instead of failing open. So the
// suppression returns the same null callers already handle, and forceRefresh
// (chat's model_config fallback, the dashboard refresh, provider validate)
// always gets through.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", async (importActual) => {
  const actual = await importActual();
  return { ...actual, proxyAwareFetch: vi.fn() };
});

import { resolveQoderModels, clearQoderCatalog } from "../../open-sse/services/qoderModels.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

const CREDS = {
  provider: "qoder",
  accessToken: "dt-test",
  providerSpecificData: { userId: "u1", machineId: "m1", authMethod: "oauth" },
};

const UPSTREAM = {
  chat: [
    {
      key: "qfmodel", enable: true, display_name: "Qwen3.8-Flash",
      is_free: true, price_factor: 0, max_input_tokens: 180000,
    },
  ],
};

const fail = (status) => ({ ok: false, status, text: async () => "" });
const succeed = () => ({ ok: true, json: async () => UPSTREAM });

beforeEach(() => {
  clearQoderCatalog();
  vi.mocked(proxyAwareFetch).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("qoder catalog negative cache", () => {
  it("returns null and suppresses the retry after a failed fetch", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(fail(403));

    expect(await resolveQoderModels(CREDS)).toBeNull();
    expect(await resolveQoderModels(CREDS)).toBeNull();
    expect(await resolveQoderModels(CREDS)).toBeNull();

    expect(vi.mocked(proxyAwareFetch)).toHaveBeenCalledTimes(1);
  });

  it("lets forceRefresh bypass the suppression", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(fail(403));

    await resolveQoderModels(CREDS);
    await resolveQoderModels(CREDS, { forceRefresh: true });

    expect(vi.mocked(proxyAwareFetch)).toHaveBeenCalledTimes(2);
  });

  it("clears the suppression once a fetch succeeds", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(fail(500));
    expect(await resolveQoderModels(CREDS)).toBeNull();

    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(succeed());
    const recovered = await resolveQoderModels(CREDS, { forceRefresh: true });
    expect(recovered?.models?.[0]?.id).toBe("qfmodel");

    // Success re-populated the real cache, so this one is served without a call.
    const cached = await resolveQoderModels(CREDS);
    expect(cached?.models?.[0]?.id).toBe("qfmodel");
    expect(vi.mocked(proxyAwareFetch)).toHaveBeenCalledTimes(2);
  });

  it("does not suppress a different credential", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(fail(403));
    await resolveQoderModels(CREDS);

    const other = {
      ...CREDS,
      providerSpecificData: { ...CREDS.providerSpecificData, userId: "u2" },
    };
    await resolveQoderModels(other);

    expect(vi.mocked(proxyAwareFetch)).toHaveBeenCalledTimes(2);
  });

  it("suppresses the retry after a thrown catalog fetch", async () => {
    // Internal timeout rejects with an AbortError while the caller signal is
    // still live. That must arm the same 60s window as an HTTP failure.
    const timeout = Object.assign(new Error("timeout"), { name: "AbortError" });
    vi.mocked(proxyAwareFetch).mockRejectedValue(timeout);

    expect(await resolveQoderModels(CREDS)).toBeNull();
    expect(await resolveQoderModels(CREDS)).toBeNull();

    expect(vi.mocked(proxyAwareFetch)).toHaveBeenCalledTimes(1);
  });

  it("does not suppress when the caller's signal aborted", async () => {
    vi.mocked(proxyAwareFetch).mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const signal = AbortSignal.abort(new Error("client gone"));

    await expect(resolveQoderModels(CREDS, { signal })).rejects.toThrow(/aborted/);

    vi.mocked(proxyAwareFetch).mockResolvedValue(fail(403));
    expect(await resolveQoderModels(CREDS)).toBeNull();
    expect(vi.mocked(proxyAwareFetch)).toHaveBeenCalledTimes(2);
  });

  it("lets forceRefresh bypass a thrown-fetch suppression", async () => {
    vi.mocked(proxyAwareFetch).mockRejectedValue(new Error("ECONNRESET"));

    expect(await resolveQoderModels(CREDS)).toBeNull();
    expect(await resolveQoderModels(CREDS, { forceRefresh: true })).toBeNull();

    expect(vi.mocked(proxyAwareFetch)).toHaveBeenCalledTimes(2);
  });

  it("suppresses a failed PAT exchange per token and region", async () => {
    vi.mocked(proxyAwareFetch).mockRejectedValue(new Error("exchange down"));
    const pat = (token) => ({
      provider: "qoder",
      apiKey: token,
      providerSpecificData: { machineId: "m1" },
    });

    expect(await resolveQoderModels(pat("pt-one"))).toBeNull();
    expect(await resolveQoderModels(pat("pt-one"))).toBeNull();
    expect(vi.mocked(proxyAwareFetch)).toHaveBeenCalledTimes(1);

    expect(await resolveQoderModels(pat("pt-one"), { region: "cn" })).toBeNull();
    expect(await resolveQoderModels(pat("pt-two"))).toBeNull();
    expect(vi.mocked(proxyAwareFetch)).toHaveBeenCalledTimes(3);

    expect(await resolveQoderModels(pat("pt-one"), { forceRefresh: true })).toBeNull();
    expect(vi.mocked(proxyAwareFetch)).toHaveBeenCalledTimes(4);
  });
});
