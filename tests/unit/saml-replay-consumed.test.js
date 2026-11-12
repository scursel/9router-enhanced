import { describe, it, expect } from "vitest";
import { validateSamlResponse } from "../../src/lib/auth/saml.js";

describe("SAML replay: client-controlled saml_state cookie cannot revive a used request id", () => {
  it("rejects the second presentation of the same InResponseTo id", async () => {
    const settings = { samlCert: "dummy-cert", samlEntryPoint: "https://idp.invalid/sso" };
    const id = "_replay-test-id-1";
    const xml = Buffer.from(`<Response InResponseTo="${id}"></Response>`).toString("base64");
    // First attempt consumes the id (fails later on signature/cert validation).
    await expect(validateSamlResponse({ headers: new Headers() }, { SAMLResponse: xml }, id, settings)).rejects.toThrow();
    await expect(validateSamlResponse({ headers: new Headers() }, { SAMLResponse: xml }, id, settings)).rejects.toThrow(/already used/);
  });
});
