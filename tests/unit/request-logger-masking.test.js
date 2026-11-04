import { describe, expect, it } from "vitest";
import { maskSensitiveHeaders } from "../../open-sse/utils/requestLogger.js";

describe("maskSensitiveHeaders", () => {
  it("masks all sensitive headers with <redacted> and preserves non-sensitive headers", () => {
    const input = {
      Authorization: "Bearer fake-token-12345",
      "X-Goog-Api-Key": "fake-google-api-key",
      Cookie: "session=fake-session-cookie",
      "Set-Cookie": "auth=fake-auth-cookie",
      "x-amz-security-token": "fake-aws-security-token",
      "Proxy-Authorization": "Basic fake-proxy-auth",
      apikey: "fake-apikey-value",
      "X-Client-Secret": "fake-client-secret-value",
      "Content-Type": "application/json",
      "User-Agent": "fake-client/1.0",
    };

    const cloned = { ...input };
    const masked = maskSensitiveHeaders(input);

    expect(masked.Authorization).toBe("<redacted>");
    expect(masked["X-Goog-Api-Key"]).toBe("<redacted>");
    expect(masked.Cookie).toBe("<redacted>");
    expect(masked["Set-Cookie"]).toBe("<redacted>");
    expect(masked["x-amz-security-token"]).toBe("<redacted>");
    expect(masked["Proxy-Authorization"]).toBe("<redacted>");
    expect(masked.apikey).toBe("<redacted>");
    expect(masked["X-Client-Secret"]).toBe("<redacted>");
    expect(masked["Content-Type"]).toBe("application/json");
    expect(masked["User-Agent"]).toBe("fake-client/1.0");

    // Does not mutate original object
    expect(input).toEqual(cloned);
  });

  it("handles mixed case header names", () => {
    const masked = maskSensitiveHeaders({
      "x-GoOg-ApI-kEy": "fake-key",
      AUTHORIZATION: "Bearer fake",
    });
    expect(masked["x-GoOg-ApI-kEy"]).toBe("<redacted>");
    expect(masked.AUTHORIZATION).toBe("<redacted>");
  });

  it("returns empty object for null or undefined or empty input", () => {
    expect(maskSensitiveHeaders(null)).toEqual({});
    expect(maskSensitiveHeaders(undefined)).toEqual({});
    expect(maskSensitiveHeaders({})).toEqual({});
  });
});
