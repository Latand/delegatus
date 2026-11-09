import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

import { internalServiceClaim } from "@/lib/agent/callerClaims";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";

export const NATIVE_RELAY_HEADER = "x-delegatus-native-relay";
type Caller = () => string;
type Grant = { envelope: string; caller: Caller; expiresAt: number };
const KEY = Symbol.for("delegatus.nativeRelayHandoff");
function state() {
  const holder = globalThis as typeof globalThis & { [KEY]?: { grants: Map<string, Grant>; requests: WeakMap<object, Caller> } };
  return holder[KEY] ??= { grants: new Map(), requests: new WeakMap() };
}
const envelope = (body: Record<string, unknown>) => crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");

/** A short-lived, single-request rendezvous inside the serving Viewer. Only
 * the authenticated MCP producer holds the resolver; the HTTP caller gets an
 * opaque reference bound to its exact original envelope, never an identity.
 * Losing the process or completing dispatch removes the grant. */
export async function withNativeRelayHandoff<T>(body: Record<string, unknown>, caller: Caller | null,
  dispatch: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  if (!caller) return dispatch({});
  caller();
  const { grants } = state();
  const now = Date.now();
  for (const [key, grant] of grants) if (grant.expiresAt <= now) grants.delete(key);
  if (grants.size >= 128) throw new Error("native relay handoff is busy");
  // Keep the authenticated peer and any consumed native hook proof's async
  // context through the second HTTP request and all later synchronous checks.
  const run = AsyncLocalStorage.snapshot();
  const key = crypto.randomBytes(32).toString("base64url");
  const expiresAt = now + 5 * 60_000;
  let active = true;
  const currentCaller = () => {
    if (!active || Date.now() >= expiresAt) throw new Error("native relay handoff ended");
    return run(caller);
  };
  grants.set(key, { envelope: envelope(body), caller: currentCaller, expiresAt });
  try { return await dispatch({ [NATIVE_RELAY_HEADER]: key }); }
  finally { active = false; grants.delete(key); }
}

/** Only the relay endpoint consumes a grant, before transforming the body. */
export function acceptNativeRelayHandoff(request: Pick<Request, "headers">, body: Record<string, unknown>): boolean {
  const key = request.headers.get(NATIVE_RELAY_HEADER);
  if (key === null) return true;
  const { grants, requests } = state();
  const grant = grants.get(key);
  grants.delete(key);
  const service = internalServiceClaim(request, { readOnly: true });
  if (!grant || request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER) || service.claim !== "valid" || service.service !== "mcp"
    || grant.expiresAt <= Date.now() || grant.envelope !== envelope(body)) return false;
  try { grant.caller(); } catch { return false; }
  requests.set(request, grant.caller);
  return true;
}

export function nativeRelayConversation(request: Pick<Request, "headers">): string | null {
  const caller = state().requests.get(request);
  if (caller) return caller();
  if (request.headers.has(NATIVE_RELAY_HEADER)) throw new Error("native relay caller is unavailable");
  return null;
}

/** The endpoint constructs one internal request for the shared send handler. */
export function inheritNativeRelayHandoff(from: object, to: object): void {
  const caller = state().requests.get(from);
  if (caller) state().requests.set(to, caller);
}
