import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { callerConversationId } from "@/lib/agent/operatorAuthority";
import { internalServiceClaim } from "@/lib/agent/callerClaims";
import { matchesOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { pairedTelegramOwner } from "@/lib/externalRelay/store";

import { MEMBER_REQUIRED_CODE, type TeamActor } from "./contract";
import { requestSession, teamMode, type LiveSession } from "./sessions";
import { existingTeamStore } from "./store";

/*
 * Who is acting (§3.6). Asked by every place that records a human action;
 * it names the person where `operatorAuthority` answers only operator or agent:
 *
 *   an agent's spawn capability → agent
 *   the operator spawn capability,
 *   or a Viewer service's tag    → service
 *   a live member session       → member
 *   otherwise                   → operator in solo mode, anonymous in team mode
 *
 * It never reads Authorization, Host or X-Forwarded-*: nothing a caller writes
 * into a header is evidence of which person it is (#1496).
 */

type ActorRequest = Pick<NextRequest, "headers" | "cookies">;

/** Called only with the owner identity from an authenticated relay pairing. */
export function telegramOwnerActor(userId: string): Extract<TeamActor, { kind: "member" | "operator" }> | null {
  const store = existingTeamStore();
  const owner = store?.owner();
  if (!store || !owner) return { kind: "operator" };
  const member = store.memberByTelegram(userId);
  if (member) return member.status === "active" ? { kind: "member", memberId: member.id } : null;
  // Relay pairing and team sign-in keep independent identities. A paired
  // owner can answer as the active install owner without enrolling Telegram as
  // a sign-in method. An existing link or revoked membership stays decisive.
  if (owner.status === "active" && !owner.telegram && pairedTelegramOwner(userId))
    return { kind: "member", memberId: owner.id };
  return null;
}

/** Recheck durable authors before an automatic retry as well as a new send. */
export function activeDeliveryActor(actor: TeamActor): boolean {
  if (actor.kind === "member") return existingTeamStore()?.member(actor.memberId)?.status === "active";
  return actor.kind === "operator" && teamMode() === "solo";
}

/** Telegram sign-in proves the session belongs to the independently paired owner.
 * A local install claim or a newly enrolled passkey supplies no such proof. */
export function authenticatedOwner(req: ActorRequest, telegramUserId: string | undefined): boolean {
  if (!telegramUserId) return false;
  try {
    const live = requestSession(req);
    return live?.session.method === "telegram" && live.member.role === "owner" && live.member.telegram?.userId === telegramUserId;
  } catch {
    return false;
  }
}

export function teamActor(req: ActorRequest): TeamActor {
  const conversationId = callerConversationId(req);
  if (conversationId) return { kind: "agent", conversationId };
  if (operatorSpawnCapabilityPresented(req)) return { kind: "service", service: "viewer" };
  if (internalServiceClaim(req).claim === "valid") return { kind: "service", service: "viewer" };
  let live: LiveSession | null = null;
  try {
    live = requestSession(req);
  } catch {
    live = null;
  }
  if (live) return { kind: "member", memberId: live.member.id };
  try {
    return teamMode() === "team" ? { kind: "anonymous" } : { kind: "operator" };
  } catch {
    return { kind: "anonymous" };
  }
}

/* The operator spawn capability lives in a file only Viewer processes read; no
   browser holds it. The in-process launchers (the scheduled Telegram report,
   the seat, the MCP spawn, the onboarding health check) present it, and the
   identity gate already admits it as first-party, so it names a Viewer service
   here too rather than falling through to "anonymous" in team mode. */
function operatorSpawnCapabilityPresented(req: ActorRequest): boolean {
  const capability = req.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
  if (!capability) return false;
  try {
    return matchesOperatorSpawnCapability(capability);
  } catch {
    return false;
  }
}

/**
 * Whether the access key must be kept from this caller (§9). On a team
 * install the key is the operator's: the owner and the Viewer's own processes
 * may see it, and nobody else — a member would keep it after being revoked.
 * An agent is withheld it too, because every member directs agents and one
 * could relay the link; no agent needs it, since the MCP server resolves its
 * own credential through the control endpoint. An unreadable team store
 * withholds it.
 */
export function accessKeyWithheld(req: ActorRequest): boolean {
  try {
    if (teamMode() !== "team") return false;
    const actor = teamActor(req);
    if (actor.kind === "service") return false;
    if (actor.kind === "agent") return true;
    return actor.kind !== "member" || existingTeamStore()?.member(actor.memberId)?.role !== "owner";
  } catch {
    return true;
  }
}

/** Whether an actor is a person acting on a Viewer surface. */
export function isHumanActor(actor: TeamActor): actor is Extract<TeamActor, { kind: "member" | "operator" }> {
  return actor.kind === "member" || actor.kind === "operator";
}

/** The refusal a human-originated write gets in team mode without a session,
    or null when the actor may act. Agents and services are judged where they
    always were. */
export function refuseAnonymous(actor: TeamActor): NextResponse<{ error: string; code: string }> | null {
  return actor.kind === "anonymous"
    ? NextResponse.json({ error: "sign in required", code: MEMBER_REQUIRED_CODE }, { status: 401 })
    : null;
}

/** The member id an actor names, for records that keep only that. */
export function actorMemberId(actor: TeamActor): string | null {
  return actor.kind === "member" ? actor.memberId : null;
}
