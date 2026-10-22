import { randomBytes } from "node:crypto";
import { stateDir } from "@/lib/configDir";
import { hashToken, tokensMatch } from "@/lib/authToken";

export const OPERATOR_COOKIE = "llv_operator";
const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
type Session = { value: string; expires: number };
// Shared by the proxy bundle and route bundles. Eviction and restart revoke sessions.
const host = globalThis as typeof globalThis & { __llvOperatorSessions?: Map<string, Session> };
const sessions = host.__llvOperatorSessions ??= new Map<string, Session>();

function sessionScope(): string {
  return `${stateDir()}:${hashToken(process.env.LLV_TOKEN ?? "").toString("hex")}`;
}

export function soloBrowserSession(now = Date.now()): string {
  const scope = sessionScope();
  let session = sessions.get(scope);
  if (!session || session.expires <= now) {
    session = { value: randomBytes(32).toString("base64url"), expires: now + LIFETIME_MS };
    sessions.delete(scope);
    sessions.set(scope, session);
    while (sessions.size > 8) sessions.delete(sessions.keys().next().value!);
  }
  return session.value;
}

export function verifySoloBrowserSession(value: string | undefined, now = Date.now()): boolean {
  const session = sessions.get(sessionScope());
  return !!value && !!session && session.expires > now && tokensMatch(value, session.value);
}
