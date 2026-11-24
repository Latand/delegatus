import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { boundedJson, ISSUER, object } from "./constants";
import { PlanError } from "./errors";
import type { PlanOidc } from "./oidc";
import { textField } from "./store";

const invalid = () => new PlanError("reconnect_required");
const decode = (part: string) => object(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));

export async function validateIdentity(oidc: PlanOidc, idToken: string, clientId: string, now: number,
  signal: AbortSignal, nonce?: string): Promise<{ subject: string; email?: string }> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
  const [headerPart, payloadPart, signature] = parts;
  let header: ReturnType<typeof decode>, payload: ReturnType<typeof decode>;
  try { header = decode(headerPart); payload = decode(payloadPart); }
  catch { throw invalid(); }
  const audiences = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
  if (header?.alg !== "RS256" || !textField(header.kid) || !payload || payload.iss !== ISSUER
    || !audiences.every(textField) || !audiences.includes(clientId)
    || ((audiences.length > 1 || payload.azp !== undefined) && payload.azp !== clientId)
    || typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp * 1_000 <= now - 5_000
    || (nonce !== undefined && payload.nonce !== nonce) || !textField(payload.sub)) throw invalid();
  let keys: unknown;
  try {
    const { jwks_uri } = await oidc.configuration(signal);
    const response = await oidc.http(jwks_uri, { redirect: "error", signal });
    if (response.ok) keys = object(await boundedJson(response))?.keys;
  } catch { throw new PlanError("retry_later"); }
  if (!Array.isArray(keys)) throw new PlanError("retry_later");
  const key = keys.map(object).find(key => key?.kid === header.kid && key?.kty === "RSA"
    && (key.use === undefined || key.use === "sig") && (key.alg === undefined || key.alg === "RS256"));
  if (!key) throw invalid();
  try {
    if (!verify("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), createPublicKey({ key: key as JsonWebKey, format: "jwk" }),
      Buffer.from(signature, "base64url"))) throw invalid();
  } catch { throw invalid(); }
  const email = payload.email;
  return { subject: payload.sub, ...(typeof email === "string" && email.length <= 320 && !/[\p{C}]/u.test(email) ? { email } : {}) };
}
