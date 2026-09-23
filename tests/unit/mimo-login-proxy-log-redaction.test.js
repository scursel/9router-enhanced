import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dashboardProxy: vi.fn(async () => new Response("ok")),
  isAuthenticated: vi.fn(async () => false),
  proxyAccountRequest: vi.fn(),
  runTakeover: vi.fn(),
  sessionFromRequest: vi.fn(() => null),
}));

vi.mock("../../src/dashboardGuard.js", () => ({
  proxy: mocks.dashboardProxy,
  isAuthenticated: mocks.isAuthenticated,
}));

vi.mock("../../src/lib/mimoLoginSession.js", () => ({
  clearedSessionCookie: (request) => `9r_mimo_login=; Path=/; HttpOnly; SameSite=Lax${request.headers.get("x-forwarded-proto") === "https" ? "; Secure" : ""}; Max-Age=0`,
  sessionFromRequest: mocks.sessionFromRequest,
  isAccountProxyPath: () => true,
  isMimoTakeoverPath: () => false,
  takeoverUpstreamPath: (path) => path,
  proxyAccountRequest: mocks.proxyAccountRequest,
  runTakeover: mocks.runTakeover,
  attachSessionCookie: (response, _session, requestOrOrigin) => {
    const secure = typeof requestOrOrigin === "string"
      ? new URL(requestOrOrigin).protocol === "https:"
      : requestOrOrigin?.headers?.get("x-forwarded-proto") === "https";
    if (secure) response.headers.append("set-cookie", "9r_mimo_login=fixture; Secure");
    return response;
  },
  originOf: (request) => {
    const proto = request.headers.get("x-forwarded-proto") || request.nextUrl.protocol;
    return `${proto.replace(/:$/, "")}://${request.headers.get("host")}`;
  },
}));

const { default: proxy } = await import("../../src/proxy.js");

afterEach(() => {
  vi.restoreAllMocks();
  mocks.dashboardProxy.mockClear();
  mocks.isAuthenticated.mockClear();
  mocks.proxyAccountRequest.mockReset();
  mocks.runTakeover.mockReset();
  mocks.sessionFromRequest.mockReset().mockReturnValue(null);
});

describe("MiMo missing-session diagnostics", () => {

  it("uses the forwarded HTTPS scheme when nextUrl reflects internal HTTP", async () => {
    const request = new Request("http://router.internal/fe/service/login", {
      headers: {
        cookie: "9r_mimo_login=signed-session",
        host: "router.example",
        "x-forwarded-proto": "https",
      },
    });
    Object.defineProperty(request, "nextUrl", {
      value: { pathname: "/fe/service/login", search: "", protocol: "http:", host: "router.internal", searchParams: new URLSearchParams() },
    });

    const { originOf } = await import("../../src/lib/mimoLoginSession.js");

    expect(originOf(request)).toBe("https://router.example");
  });

  it("clears stale proxy-session cookies with Secure behind TLS termination", async () => {
    mocks.sessionFromRequest.mockReturnValue(null);
    const request = new Request("http://router.internal/fe/service/login", {
      headers: {
        cookie: "9r_mimo_login=stale-session",
        host: "router.example",
        "x-forwarded-proto": "https",
      },
    });
    Object.defineProperty(request, "nextUrl", {
      value: { pathname: "/fe/service/login", search: "", protocol: "http:", host: "router.internal", searchParams: new URLSearchParams() },
    });

    const response = await proxy(request);

    expect(response.headers.getSetCookie().some((cookie) => cookie.includes("Max-Age=0") && cookie.includes("Secure"))).toBe(true);
  });

  it("does not log browser Cookie values when the login session is absent", async () => {
    const logger = vi.spyOn(console, "log").mockImplementation(() => {});
    const request = new Request("http://localhost/fe/service/login", {
      headers: { cookie: "auth_token=fixture-dashboard-jwt; theme=dark" },
    });
    Object.defineProperty(request, "nextUrl", {
      value: { pathname: "/fe/service/login", search: "", searchParams: new URLSearchParams() },
    });

    await proxy(request);

    const logged = logger.mock.calls.flat().join(" ");
    expect(logged).not.toContain("fixture-dashboard-jwt");
    expect(logged).not.toContain("auth_token=");
    expect(logged).not.toContain("cookie header");
  });
});
