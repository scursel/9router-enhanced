import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const customServerPath = path.resolve(__dirname, "../../custom-server.js");

describe("CORS Preflight and Header Injection (Source)", () => {
  let server;
  let port;

  beforeAll(async () => {
    // Import custom-server.js to hook http.createServer
    await import(customServerPath);

    // Boot HTTP server wrapped by custom-server.js
    server = http.createServer((req, res) => {
      if (req.url.startsWith("/_next/static/")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.setHeader("ETag", '"test-etag-123"');
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end("// static chunk");
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          ip: req.headers["x-9r-real-ip"],
          hasPeerToken: Boolean(req.headers["x-9r-peer-token"]),
        })
      );
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  function makeRequest(options) {
    return new Promise((resolve, reject) => {
      const reqOptions = {
        host: "127.0.0.1",
        port,
        ...options,
      };
      const req = http.request(reqOptions, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("1. short-circuits OPTIONS requests with 204 and exact CORS headers without auth", async () => {
    const res = await makeRequest({
      method: "OPTIONS",
      path: "/v1/chat/completions",
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toBe(
      "GET, POST, OPTIONS, PUT, DELETE, PATCH"
    );
    expect(res.headers["access-control-allow-headers"]).toBe(
      "Authorization, Content-Type, x-api-key, x-goog-api-key, Origin, Accept, Cache-Control"
    );
    expect(res.headers["access-control-max-age"]).toBe("86400");
  });

  it("2. injects CORS headers into normal responses and preserves real IP logic", async () => {
    const res = await makeRequest({
      method: "GET",
      path: "/v1/models",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toBe(
      "GET, POST, OPTIONS, PUT, DELETE, PATCH"
    );
    expect(res.headers["access-control-allow-headers"]).toBe(
      "Authorization, Content-Type, x-api-key, x-goog-api-key, Origin, Accept, Cache-Control"
    );
    expect(res.headers["access-control-max-age"]).toBe("86400");

    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.ip).toBe("127.0.0.1");
    expect(data.hasPeerToken).toBe(true);
  });

  // Chunk names are content-hashed by the build, so nothing rewrites a chunk in
  // place any more: the wrapper must not touch caching headers at all.
  it("3. leaves static Cache-Control untouched", async () => {
    for (const chunk of [
      "/_next/static/chunks/1321-54939b699b5f3d07.js",
      "/_next/static/chunks/app/layout-12345.js",
    ]) {
      const res = await makeRequest({ method: "GET", path: chunk });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(res.headers["etag"]).toBe('"test-etag-123"');
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    }
  });

  // The dashboard API is same-origin only: a wildcard origin there would let any
  // website read provider credentials when requireLogin is off.
  it("4. does not send CORS headers on dashboard API routes", async () => {
    for (const apiPath of [
      "/api/providers",
      "/api/keys",
      "/api/settings/database",
      "//api/providers",
      "/%61pi/providers",
      "/API/providers",
      "/api/v1x/secret",
    ]) {
      const res = await makeRequest({ method: "GET", path: apiPath });
      expect(res.headers["access-control-allow-origin"], apiPath).toBeUndefined();

      const preflight = await makeRequest({ method: "OPTIONS", path: apiPath });
      expect(preflight.statusCode, apiPath).not.toBe(204);
      expect(preflight.headers["access-control-allow-origin"], apiPath).toBeUndefined();
    }
  });

  it("5. keeps CORS on the gateway surface under /api", async () => {
    for (const apiPath of ["/api/v1/chat/completions", "/api/v1beta/models", "/api/v1", "/v1beta/models", "/responses"]) {
      const res = await makeRequest({ method: "GET", path: apiPath });
      expect(res.headers["access-control-allow-origin"], apiPath).toBe("*");
    }
  });
});
