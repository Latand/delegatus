import { afterEach, expect, test } from "bun:test";
import { validateIdentity } from "./idToken";
import { clientId, jwks, jwt, label, now, planFixture, subject } from "./plan.fixture";

let fixture: ReturnType<typeof planFixture> | undefined;
afterEach(() => fixture?.dispose());

test("verifies a signed identity including multiple audiences and authorized party", async () => {
  fixture = planFixture(jwks);
  const token = jwt("nonce", { aud: [clientId, "other"], azp: clientId });
  const identity = await validateIdentity(fixture.oidc, token, clientId, now, AbortSignal.timeout(1_000), "nonce");
  expect(identity).toEqual({ subject, email: label });
});

test.each([
  ["issuer", { iss: "https://elsewhere.example" }, "fixture", false],
  ["audience", { aud: "other" }, "fixture", false],
  ["authorized party", { aud: [clientId, "other"], azp: "other" }, "fixture", false],
  ["nonce", { nonce: "wrong" }, "fixture", false],
  ["expiry", { exp: now / 1_000 - 6 }, "fixture", false],
  ["signature", {}, "fixture", true],
  ["key", {}, "unknown", false],
] as const)("refuses the wrong %s", async (_, claims, kid, bad) => {
  fixture = planFixture(jwks);
  await expect(validateIdentity(fixture.oidc, jwt("nonce", claims, kid, bad), clientId, now, AbortSignal.timeout(1_000), "nonce"))
    .rejects.toThrow("reconnect_required");
});

test("JWKS outages preserve the distinction from an invalid identity", async () => {
  fixture = planFixture(() => { throw new Error("upstream text"); });
  await expect(validateIdentity(fixture.oidc, jwt(), clientId, now, AbortSignal.timeout(1_000))).rejects.toThrow("retry_later");
});
