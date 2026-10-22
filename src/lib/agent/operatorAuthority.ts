import crypto from "node:crypto";

import type { NextRequest } from "next/server";

import { OPERATOR_COOKIE, verifySoloBrowserSession } from "@/lib/agent/operatorSession";
import { tokensMatch } from "@/lib/authToken";
import { existingTeamStore } from "@/lib/team/store";
import { MEMBER_COOKIE, verifySessionValue } from "@/lib/team/sessions";

import { internalServiceClaim } from "@/lib/agent/callerClaims";
import { agentRegistry } from "@/lib/agent/registry";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";

export { internalServiceHeaders, type InternalViewerService } from "@/lib/agent/callerClaims";

/** Operator actions require an authenticated session or a separately configured operator token.
 * Conversation capabilities identify agents and never grant operator authority. */
export type OperatorAuthority =
  | { ok: true }
  | { ok: false; status: number; error: string };

/* Shape of a per-conversation spawn capability, used only to decide whether the
   registry is worth asking about the presented value. */
const AGENT_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

type ConversationResolver = (digest: string) => string | null;

const productionResolver: ConversationResolver = (digest) =>
  agentRegistry().conversationIdForSpawnCapabilityDigest(digest);

let resolveConversation: ConversationResolver = productionResolver;

/** Tests only; `null` restores the registry lookup. Seamed here rather than in a
    route, because a route module may export only route fields. */
export function setCallerConversationResolverForTests(resolver: ConversationResolver | null): void {
  resolveConversation = resolver ?? productionResolver;
}

/** The conversation a presented capability names, or null when it names none. */
export function callerConversationId(request: Pick<NextRequest, "headers">): string | null {
  const capability = request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
  if (!capability || !AGENT_CAPABILITY.test(capability)) return null;
  return resolveConversation(crypto.createHash("sha256").update(capability).digest("hex"));
}

/** Voice transport uses the same authenticated operator boundary as operator actions. */
export function voiceTransportOperator(request: Pick<NextRequest, "headers">): boolean {
  return requireOperatorAuthority(request).ok;
}

const AGENT_REFUSED: OperatorAuthority = {
  ok: false,
  status: 403,
  error: "this is an operator-only action; an agent may not perform it, whatever role it holds",
};

const SERVICE_REFUSED: OperatorAuthority = {
  ok: false,
  status: 403,
  error: "background Viewer activity is outside direct operator activity",
};

/** Classifies direct activity while leaving the product authority gate intact. */
export function directOperatorActivityAuthority(request: Pick<NextRequest, "headers">): OperatorAuthority {
  if (internalServiceClaim(request).claim === "valid") return SERVICE_REFUSED;
  return requireOperatorAuthority(request);
}

/** Browser attribution requires a verified cookie. Fetch Metadata adds no authority. */
export function operatorBrowserRequest(request: Pick<NextRequest, "headers">): boolean {
  return directOperatorActivityAuthority(request).ok && authenticatedSession(request);
}

function cookie(request: Pick<NextRequest, "headers">, name: string): string | undefined {
  const values = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  try { return decodeURIComponent(values[0]!.slice(name.length + 1)); }
  catch { return undefined; }
}

function authenticatedSession(request: Pick<NextRequest, "headers">): boolean {
  const configuredKey = process.env.LLV_TOKEN;
  const value = cookie(request, "llv_auth");
  if (configuredKey && value && tokensMatch(value, configuredKey)) return true;
  const member = cookie(request, MEMBER_COOKIE);
  try {
    const store = existingTeamStore();
    if (member && store && verifySessionValue(store, member) !== null) return true;
    return !store?.hasActiveOwner() && verifySoloBrowserSession(cookie(request, OPERATOR_COOKIE));
  } catch { return false; }
}

/** Who a request says it is. `operator` is the local browser — anything that
    named no conversation; `agent` is a caller that named itself with the
    conversation capability the registry issued it. */
export type ViewerActorKind = "operator" | "agent";

export interface ViewerActor {
  kind: ViewerActorKind;
  /** The conversation the caller named itself with; null for the operator. */
  conversationId: string | null;
}

/**
 * ROTATION AUTHORITY — the one contract, shared by both rotation surfaces (#1402).
 *
 * `POST /api/orchestrator/rotate` and the `rotate_orchestrator` MCP tool used to
 * disagree about the same actor: the route accepted the local caller and performed
 * the rotation, while the tool — which reaches the rotation only through that
 * route, forwarding the calling session's own conversation capability — was refused
 * by `requireOperatorAuthority` as "an agent may not perform it, whatever role it
 * holds". So the surface agents are told to prefer was the one surface that could
 * not do it, and the shell fallback was the only working path.
 *
 * Nobody ever configured that ban. The operator's rule is that a control is a
 * CAPABILITY: their word is the trigger, and whoever acts on it must be able to
 * execute through the first-class tool. So rotation asks only who the caller is —
 * this function BANS NOBODY and cannot refuse. Its answer is attribution: the
 * rotation record carries the actor kind and the triggering conversation, so a
 * rotation nobody can be stopped from performing is still a rotation everybody can
 * see the author of.
 *
 * The perimeter is unchanged and is not this function's job: `rejectCrossOrigin`
 * runs first in the route, exactly as it does for every other authority decision
 * here. Because the tool holds no second copy of the rule — it posts to the route
 * and inherits whatever the route decides — the two surfaces cannot drift again.
 */
export function rotationActor(request: Pick<NextRequest, "headers">): ViewerActor {
  const conversationId = callerConversationId(request);
  return conversationId ? { kind: "agent", conversationId } : { kind: "operator", conversationId: null };
}

/** The route checks origin first; credentials establish authority independently. */
export function requireOperatorAuthority(request: Pick<NextRequest, "headers">): OperatorAuthority {
  if (callerConversationId(request)) return AGENT_REFUSED;
  if (authenticatedSession(request)) return { ok: true };
  // The local gateway injects the perimeter bearer token. It is not caller proof.
  const expected = process.env.DELEGATUS_OPERATOR_TOKEN || process.env.LLV_OPERATOR_TOKEN;
  const presented = request.headers.get("x-llv-operator-token");
  if (expected && presented && tokensMatch(presented, expected)) return { ok: true };
  // The MCP backend checks tool-specific authority and forwards conversation capabilities for designation.
  const service = internalServiceClaim(request, { readOnly: true });
  if (service.claim === "valid" && service.service === "mcp") return { ok: true };
  return { ok: false, status: 403, error: "this is an operator-only action; a verified session or operator token is required" };
}
