import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISSUER, PLAN_SCOPE, RESOURCE } from "./constants";
import { PlanOidc } from "./oidc";
import { PlanStore, type Credentials } from "./store";

export const now = Date.UTC(2030, 0, 1);
export const clientId = "issued-fixture";
export const model = "voice-fixture";
export const subject = "fixture-subject";
export const label = "Account for the fixture";
export const synth = (kind: string) => [kind, "v".repeat(36)].join("-");
export const discovery = {
  issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
  revocation_endpoint: `${ISSUER}/revoke`, jwks_uri: `${ISSUER}/jwks`,
};

const keys = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
let signingKey: ReturnType<typeof keys> | undefined;
const signWith = () => signingKey ??= keys();
export const jwks = () => Response.json({ keys: [{ ...signWith().publicKey.export({ format: "jwk" }), kid: "fixture" }] });
export function jwt(nonce?: string, overrides: Record<string, unknown> = {}, kid = "fixture", badSignature = false) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "RS256", kid })}.${encode({
    iss: ISSUER, aud: clientId, exp: now / 1_000 + 3600, nonce, sub: subject, email: label, ...overrides,
  })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(badSignature ? body + "." : body), signWith().privateKey).toString("base64url")}`;
}

export function grant(nonce?: string) {
  return { token_type: "Bearer", access_token: synth("access"), refresh_token: synth("refresh"),
    id_token: jwt(nonce), expires_in: 3600, scope: PLAN_SCOPE };
}

export function planFixture(answer?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-plan-"));
  const directory = join(root, "data");
  const store = new PlanStore(() => directory);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json(discovery);
    if (answer) return answer(url, init);
    throw new Error("Unexpected fixture endpoint");
  }) as typeof fetch;
  const oidc = new PlanOidc(http);
  const seed = (overrides: Partial<Credentials> = {}) => {
    const row: Credentials = { version: 1, issuer: ISSUER, clientId, savedAt: now, subject, email: label, models: [model],
      tokens: { accessToken: synth("prior-access"), refreshToken: synth("prior-refresh"), idToken: jwt(),
        expiresAt: now + 90_000, refreshedAt: now, scopes: [PLAN_SCOPE] }, ...overrides };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    store.write("credentials", row);
    return row;
  };
  return { root, directory, store, requests, oidc, seed, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

export function stream(...events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
export const complete = (response: unknown) => ({ type: "response.completed", response });
export const modelsUrl = `${RESOURCE}/models`;

export async function until(predicate: () => boolean): Promise<void> {
  const end = performance.now() + 1_500;
  while (!predicate()) {
    if (performance.now() > end) throw new Error("Fixture did not settle");
    await Bun.sleep(5);
  }
}
