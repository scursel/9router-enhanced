// Locality is peer + Host, not peer alone. Two ways a request reaches the loopback
// socket without being local:
//  (a) a tunnel/reverse proxy on this machine dials 127.0.0.1 while relaying an
//      internet client (cloudflared quick tunnel, `tailscale funnel`, any local proxy);
//  (b) DNS rebinding: a page whose hostname re-resolves to 127.0.0.1 sends same-origin
//      GETs with no Origin header and its own Host.
// custom-server.js already flags forwarding headers with x-9r-via-proxy, but a proxy
// that adds none leaves the loopback peer as the only signal. The Host the client
// addressed must therefore also be a loopback name, in production too.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => Symbol("next")),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

const { __test__ } = await import("../../src/dashboardGuard.js");
const { isLocalRequest } = __test__;

const PEER_TOKEN = "peer-token-fixture";

function request(headers = {}) {
  return {
    nextUrl: { pathname: "/v1/chat/completions", searchParams: new URL("http://localhost/v1/chat/completions").searchParams },
    headers: new Headers(headers),
    cookies: { get: vi.fn(() => undefined) },
    url: "http://localhost/v1/chat/completions",
  };
}

// custom-server.js stamped the TCP peer: loopback socket.
function loopbackPeer(headers = {}) {
  return request({ "x-9r-real-ip": "127.0.0.1", "x-9r-peer-token": PEER_TOKEN, ...headers });
}

const originalNodeEnv = process.env.NODE_ENV;

describe("isLocalRequest requires a loopback Host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.NINEROUTER_PEER_TOKEN;
  });

  it.each([
    "localhost",
    "localhost:20128",
    "LOCALHOST:20128",
    "localhost.:20128",
    "127.0.0.1",
    "127.0.0.1:20128",
    "[::1]:20128",
    "::1",
    "[::ffff:127.0.0.1]:20128",
  ])("accepts loopback peer + Host %s", (host) => {
    expect(isLocalRequest(loopbackPeer({ host }))).toBe(true);
  });

  it.each([
    "evil.example",
    "evil.example:20128",
    "some-tunnel.trycloudflare.com",
    "10.0.0.9:20128",
    "0.0.0.0:20128",
    "localhost.evil.example",
    "127.0.0.1.evil.example",
  ])("refuses loopback peer + Host %s", (host) => {
    expect(isLocalRequest(loopbackPeer({ host }))).toBe(false);
  });

  it("refuses a request with no Host header", () => {
    expect(isLocalRequest(loopbackPeer())).toBe(false);
  });

  it("still refuses a tunnel Host that carries no forwarding headers", () => {
    expect(isLocalRequest(loopbackPeer({ host: "some-tunnel.trycloudflare.com" }))).toBe(false);
  });

  it("keeps the via-proxy stamp authoritative even with a loopback Host", () => {
    expect(isLocalRequest(loopbackPeer({ host: "localhost:20128", "x-9r-via-proxy": "1" }))).toBe(false);
  });

  it("keeps the Origin check: non-loopback Origin is refused", () => {
    expect(isLocalRequest(loopbackPeer({ host: "localhost:20128", origin: "http://evil.example.com" }))).toBe(false);
  });

  it("allows a loopback Host with a loopback Origin", () => {
    expect(isLocalRequest(loopbackPeer({ host: "localhost:20128", origin: "http://localhost:20128" }))).toBe(true);
  });

  it("does not grant locality to a remote peer that names a loopback Host", () => {
    const remote = request({
      host: "localhost:20128",
      "x-9r-real-ip": "10.1.2.3",
      "x-9r-peer-token": PEER_TOKEN,
    });

    expect(isLocalRequest(remote)).toBe(false);
  });

  it("holds in production mode, not only the development Host fallback", () => {
    process.env.NODE_ENV = "production";

    expect(isLocalRequest(loopbackPeer({ host: "localhost:20128" }))).toBe(true);
    expect(isLocalRequest(loopbackPeer({ host: "some-tunnel.trycloudflare.com" }))).toBe(false);
  });
});
