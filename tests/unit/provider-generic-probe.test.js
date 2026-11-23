import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  testProxyUrl: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/lib/network/proxyTest", () => ({
  testProxyUrl: mocks.testProxyUrl,
}));

const { buildGenericProbes, testSingleConnection } = await import(
  "../../src/app/api/providers/[id]/test/testUtils.js"
);

const { PROVIDERS } = await import("open-sse/config/providers.js");

const originalFetch = global.fetch;

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

function connectionFor(provider, extra = {}) {
  return {
    id: `${provider}-conn`,
    provider,
    authType: "apikey",
    apiKey: "sk-test",
    providerSpecificData: {},
    ...extra,
  };
}

describe("generic provider probe fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.updateProviderConnection.mockResolvedValue(undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("buildGenericProbes", () => {
    it("keeps credential-like and framing registry headers out of every probe", () => {
      const original = PROVIDERS.orcarouter.headers;
      PROVIDERS.orcarouter.headers = {
        "x-probe-version": "fake-version",
        Authorization: "fake-registry-auth",
        "Content-Type": "fake/content",
        "X-Api-Key": "fake-registry-key",
        Cookie: "fake=1",
      };
      try {
        const probes = buildGenericProbes(connectionFor("orcarouter"));
        expect(probes.length).toBeGreaterThan(0);

        for (const probe of probes) {
          const names = Object.keys(probe.headers).map((name) => name.toLowerCase());
          // Benign registry headers still reach the probe.
          expect(probe.headers["x-probe-version"], probe.name).toBe("fake-version");
          // The probe's own credential and content type win.
          expect(probe.headers.Authorization, probe.name).toBe("Bearer sk-test");
          if (probe.method === "POST") {
            expect(probe.headers["Content-Type"], probe.name).toBe("application/json");
          }
          // Registry credentials and framing headers are dropped.
          expect(names, probe.name).not.toContain("x-api-key");
          expect(names, probe.name).not.toContain("cookie");
          expect(Object.values(probe.headers), probe.name).not.toContain("fake-registry-auth");
          expect(Object.values(probe.headers), probe.name).not.toContain("fake-registry-key");
        }
      } finally {
        PROVIDERS.orcarouter.headers = original;
      }
    });

    it("prefers the user-supplied base URL, then the registry metadata", () => {
      const probes = buildGenericProbes(connectionFor("dahl", {
        providerSpecificData: { baseUrl: "https://self.example/v1" },
      }));

      expect(probes.map((probe) => probe.name)).toEqual(["baseUrl/models", "transport.validateUrl", "transport.baseUrl"]);
      expect(probes[0].url).toBe("https://self.example/v1/models");
      expect(probes[0].method).toBe("GET");
      expect(probes[1].url).toBe("https://inference.dahl.global/v1/models");
      expect(probes[2].method).toBe("POST");
      expect(probes[2].body).toContain("max_tokens");
    });

    it("walks the registry validateUrl before the transport endpoint", () => {
      const probes = buildGenericProbes(connectionFor("bazaarlink"));

      expect(probes.map((probe) => probe.name)).toEqual(["transport.validateUrl", "transport.baseUrl"]);
      expect(probes[0].url).toBe("https://bazaarlink.ai/api/v1/models");
      expect(probes[0].headers.Authorization).toBe("Bearer sk-test");
      expect(probes[1].url).toBe("https://bazaarlink.ai/api/v1/chat/completions");
    });

    it("probes a media provider through its kind endpoint with the declared auth header", () => {
      const probes = buildGenericProbes(connectionFor("elevenlabs"));

      expect(probes.map((probe) => probe.name)).toEqual(["ttsConfig"]);
      expect(probes[0].url).toBe("https://api.elevenlabs.io/v1/text-to-speech");
      // ElevenLabs authenticates with xi-api-key, not a bearer token.
      expect(probes[0].headers["xi-api-key"]).toBe("sk-test");
      expect(probes[0].headers.Authorization).toBeUndefined();
      // An empty body first, plus the shaped body used only if that is rejected.
      expect(probes[0].body).toBe("{}");
      expect(probes[0].minimalBody).toBe(true);
      expect(JSON.parse(probes[0].retryBody)).toEqual({ text: "ping" });
    });

    it("probes a search provider through its search endpoint", () => {
      const probes = buildGenericProbes(connectionFor("tavily"));

      expect(probes.map((probe) => probe.name)).toEqual(["searchConfig"]);
      expect(probes[0].url).toBe("https://api.tavily.com/search");
      expect(probes[0].headers.Authorization).toBe("Bearer sk-test");
      expect(JSON.parse(probes[0].retryBody)).toEqual({ query: "ping" });
    });

    it("probes the free usage endpoint before anything that can spend quota", () => {
      const probes = buildGenericProbes(connectionFor("qoder"));

      expect(probes.map((probe) => probe.name)).toEqual(["transport.usage", "transport.baseUrl"]);
      expect(probes[0].url).toBe("https://openapi.qoder.sh/api/v2/quota/usage");
      expect(probes[0].method).toBe("GET");
      // Order matters: the free quota read runs before the chat call.
      expect(probes.findIndex((probe) => probe.name === "transport.usage"))
        .toBeLessThan(probes.findIndex((probe) => probe.name === "transport.baseUrl"));
    });

    it("generic probe skips a non-public baseUrl", () => {
      const names = (baseUrl) => buildGenericProbes(connectionFor("orcarouter", {
        providerSpecificData: { baseUrl },
      })).map((probe) => probe.name);

      // Cloud metadata, loopback and RFC1918 literals must never get the bearer key.
      expect(names("http://169.254.169.254/latest")).not.toContain("baseUrl/models");
      expect(names("http://127.0.0.1:9/v1")).not.toContain("baseUrl/models");
      expect(names("http://10.0.0.5/v1")).not.toContain("baseUrl/models");
      expect(names("http://localhost:8080/v1")).not.toContain("baseUrl/models");
      expect(names("http://[::1]:8080/v1")).not.toContain("baseUrl/models");
      expect(names("http://[::ffff:127.0.0.1]/v1")).not.toContain("baseUrl/models");
      expect(names("https://gw.example.com/v1")).toContain("baseUrl/models");
    });

    it("self-hosted providers keep their LAN baseUrl", () => {
      for (const provider of ["selfhosted-embedding", "selfhosted-tts", "selfhosted-stt", "comfyui", "sdwebui"]) {
        const probes = buildGenericProbes(connectionFor(provider, {
          apiKey: "",
          providerSpecificData: { baseUrl: "http://192.168.1.20:8080/v1" },
        }));
        const probe = probes.find((p) => p.name === "baseUrl/models");
        expect(probe, provider).toBeDefined();
        expect(probe.url, provider).toBe("http://192.168.1.20:8080/v1/models");
      }
    });

    it("custom embedding nodes keep their LAN baseUrl", () => {
      const probes = buildGenericProbes(connectionFor("custom-embedding-lan-node", {
        providerSpecificData: { baseUrl: "http://192.168.1.20:8080/v1" },
      }));
      const probe = probes.find((p) => p.name === "baseUrl/models");
      expect(probe).toBeDefined();
      expect(probe.url).toBe("http://192.168.1.20:8080/v1/models");
    });

    it("only probes http(s) baseUrls, even for exempt providers", () => {
      for (const provider of ["orcarouter", "selfhosted-embedding", "custom-embedding-lan-node"]) {
        for (const baseUrl of ["file:///etc/passwd", "ftp://gw.example.com/v1", "not a url"]) {
          const names = buildGenericProbes(connectionFor(provider, { providerSpecificData: { baseUrl } }))
            .map((probe) => probe.name);
          expect(names, `${provider} ${baseUrl}`).not.toContain("baseUrl/models");
        }
      }
    });

    it("returns no probes for a provider the registry does not know", () => {
      expect(buildGenericProbes(connectionFor("totally-unknown-provider"))).toEqual([]);
    });
  });

  describe("testSingleConnection", () => {
    it("tests a provider that used to answer 'Provider test not supported'", async () => {
      mocks.getProviderConnectionById.mockResolvedValue(connectionFor("dahl"));
      global.fetch = vi.fn().mockResolvedValue(jsonRes({ data: [{ id: "MiniMaxAI/MiniMax-M2.7" }] }));

      const result = await testSingleConnection("dahl-conn");

      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();
      expect(global.fetch).toHaveBeenCalledWith("https://inference.dahl.global/v1/models", expect.anything());
      expect(mocks.updateProviderConnection).toHaveBeenCalledWith("dahl-conn", expect.objectContaining({ testStatus: "active" }));
    });

    // dahl got an explicit /models validation case upstream (v0.5.91), so the
    // generic chain is exercised with a registry provider that has none.
    it("walks the probe chain when an endpoint does not exist on the provider", async () => {
      mocks.getProviderConnectionById.mockResolvedValue(connectionFor("orcarouter"));
      global.fetch = vi.fn()
        .mockResolvedValueOnce(jsonRes({ error: "not found" }, 404))
        .mockResolvedValueOnce(jsonRes({ choices: [{ message: { content: "pong" } }] }));

      const result = await testSingleConnection("orcarouter-conn");

      expect(result.valid).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(global.fetch.mock.calls[1][0]).toBe("https://api.orcarouter.ai/v1/chat/completions");
    });

    it("retries with a shaped body when the endpoint validates the body before the key", async () => {
      mocks.getProviderConnectionById.mockResolvedValue(connectionFor("tavily"));
      // Tavily answers 422 for an empty body even with a wrong key, so the empty
      // body proves nothing; the retry reaches auth and succeeds.
      global.fetch = vi.fn()
        .mockResolvedValueOnce(jsonRes({ detail: [{ loc: ["body", "query"], msg: "Field required" }] }, 422))
        .mockResolvedValueOnce(jsonRes({ results: [] }));

      const result = await testSingleConnection("tavily-conn");

      expect(result.valid).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ query: "ping" });
    });

    it("does not mark a connection active when the retry is rejected too", async () => {
      mocks.getProviderConnectionById.mockResolvedValue(connectionFor("tavily"));
      // A bogus Tavily key answers 422 for the empty body and 401 once the body
      // is valid — the old probe read the first 422 as a valid credential.
      global.fetch = vi.fn()
        .mockResolvedValueOnce(jsonRes({ detail: [{ msg: "Field required" }] }, 422))
        .mockResolvedValueOnce(jsonRes({ detail: { error: "Unauthorized: missing or invalid API key." } }, 401));

      const result = await testSingleConnection("tavily-conn");

      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/invalid API key/i);
      expect(mocks.updateProviderConnection).toHaveBeenCalledWith("tavily-conn", expect.objectContaining({ testStatus: "error" }));
    });

    it("keeps the connection active with a warning when the account is out of quota", async () => {
      mocks.getProviderConnectionById.mockResolvedValue(connectionFor("tavily"));
      // Tavily's real status when the plan limit is reached: the key is valid.
      global.fetch = vi.fn()
        .mockResolvedValueOnce(jsonRes({ detail: [{ msg: "Field required" }] }, 422))
        .mockResolvedValueOnce(jsonRes({ detail: { error: "This request exceeds your plan's set usage limit." } }, 432));

      const result = await testSingleConnection("tavily-conn");

      expect(result.valid).toBe(true);
      expect(result.error).toMatch(/exceeds your plan/i);
      expect(mocks.updateProviderConnection).toHaveBeenCalledWith("tavily-conn", expect.objectContaining({
        testStatus: "active",
        lastError: expect.stringMatching(/exceeds your plan/i),
      }));
    });

    it("names the unreachable host instead of a bare 'fetch failed'", async () => {
      mocks.getProviderConnectionById.mockResolvedValue(connectionFor("huggingface"));
      const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      global.fetch = vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause }));

      const result = await testSingleConnection("huggingface-conn");

      expect(result.valid).toBe(false);
      expect(result.error).toContain("router.huggingface.co");
      expect(result.error).toContain("ENOTFOUND");
      expect(result.error).not.toBe("fetch failed");
    });

    it("unwraps a FastAPI detail.error message", async () => {
      mocks.getProviderConnectionById.mockResolvedValue(connectionFor("tavily"));
      global.fetch = vi.fn()
        .mockResolvedValueOnce(jsonRes({ detail: [{ msg: "Field required" }] }, 422))
        .mockResolvedValueOnce(jsonRes({ detail: { error: "This request exceeds your plan's set usage limit." } }, 432));

      const result = await testSingleConnection("tavily-conn");

      expect(result.error).toBe("This request exceeds your plan's set usage limit.");
    });

    it("reports 'could not verify' instead of guessing when only a placeholder body is rejected", async () => {
      mocks.getProviderConnectionById.mockResolvedValue(connectionFor("elevenlabs"));
      global.fetch = vi.fn().mockImplementation(() => jsonRes({ detail: "voice_id is required" }, 422));

      const result = await testSingleConnection("elevenlabs-conn");

      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Could not verify credentials/);
      expect(result.error).not.toMatch(/not supported/);
    });

    it("reports the provider's own message when the credential is rejected", async () => {
      mocks.getProviderConnectionById.mockResolvedValue(connectionFor("elevenlabs"));
      global.fetch = vi.fn().mockResolvedValue(jsonRes({ detail: { message: "Invalid API key" } }, 401));

      const result = await testSingleConnection("elevenlabs-conn");

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid API key");
      expect(result.error).not.toMatch(/not supported/);
      expect(mocks.updateProviderConnection).toHaveBeenCalledWith("elevenlabs-conn", expect.objectContaining({ testStatus: "error" }));
    });

    it("stops at the first rejected credential instead of trying more endpoints", async () => {
      mocks.getProviderConnectionById.mockResolvedValue(connectionFor("dahl"));
      global.fetch = vi.fn().mockResolvedValue(jsonRes({ error: "Unauthorized" }, 401));

      const result = await testSingleConnection("dahl-conn");

      expect(result.valid).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("new gateway providers never send the runtime key to the usage host", async () => {
      const expected = {
        "opendesign-go": "https://amr-link.open-design.ai/v1/models",
        deeprelay: "https://api.deeprelay.ai/v1/models",
        qwencloud: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1/models",
      };
      for (const [provider, validateUrl] of Object.entries(expected)) {
        expect(PROVIDERS[provider].validateUrl).toBe(validateUrl);
        mocks.getProviderConnectionById.mockResolvedValue(connectionFor(provider));
        // 500 (not 200/401): the generic chain stops at the first probe on those,
        // which would let this test pass without the explicit case.
        global.fetch = vi.fn().mockImplementation(() => jsonRes({ error: "boom" }, 500));

        const result = await testSingleConnection(`${provider}-conn`);

        expect(result.valid, provider).toBe(false);
        const urls = global.fetch.mock.calls.map((call) => String(call[0]));
        expect(urls, provider).toEqual([validateUrl]);
        expect(urls.some((u) => u.includes("amr-api.open-design.ai")), provider).toBe(false);
      }
    });

    it("never falls back to the old 'Provider test not supported' placeholder", async () => {
      // Every provider that used to hit the switch's default branch.
      const previouslyUncovered = [
        "dahl", "bai", "bazaarlink", "orcarouter", "tokenrouter", "api-airforce",
        "alitp-intl", "commandcode", "elevenlabs", "tavily", "voyage-ai", "stability-ai",
      ];

      for (const provider of previouslyUncovered) {
        mocks.getProviderConnectionById.mockResolvedValue(connectionFor(provider));
        global.fetch = vi.fn().mockImplementation(() =>
          jsonRes({ error: { message: "invalid api key" } }, 401)
        );

        const result = await testSingleConnection(`${provider}-conn`);

        expect(result.valid, `${provider} must report the rejected credential`).toBe(false);
        expect(result.error, `${provider} must not answer with the old placeholder`)
          .not.toMatch(/Provider test not supported/);
        expect(result.error, `${provider} must carry a real message`).toBeTruthy();
      }
    });

    it("tests an OAuth provider that has no hand-written probe", async () => {
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "xai-conn",
        provider: "xai",
        authType: "oauth",
        accessToken: "oauth-token",
        providerSpecificData: {},
      });
      global.fetch = vi.fn().mockResolvedValue(jsonRes({ data: [{ id: "grok-4" }] }));

      const result = await testSingleConnection("xai-conn");

      expect(result.valid).toBe(true);
      expect(result.refreshed).toBe(false);
      expect(global.fetch).toHaveBeenCalledWith("https://api.x.ai/v1/models", expect.anything());
    });

    it("still refuses to test an OAuth connection with no access token", async () => {
      mocks.getProviderConnectionById.mockResolvedValue({
        id: "xai-conn",
        provider: "xai",
        authType: "oauth",
        accessToken: null,
        providerSpecificData: {},
      });

      const result = await testSingleConnection("xai-conn");

      expect(result.valid).toBe(false);
      expect(result.error).toBe("No access token");
    });
  });
});
