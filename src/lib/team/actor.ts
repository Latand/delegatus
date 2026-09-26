import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { callerConversationId, directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";

import { MEMBER_REQUIRED_CODE, type TeamActor } from "./contract";
import { requestSession, teamMode, type LiveSession } from "./sessions";

/*
 * Who is acting (§3.6). Asked by every place that records a human action;
 * it names the person where `operatorAuthority` answers only operator or agent:
 *
 *   an agent's spawn capability → agent
 *   a Viewer service's tag      → service
 *   a live member session       → member
 *   otherwise                   → operator in solo mode, anonymous in team mode
 *
 * It never reads Authorization, Host or X-Forwarded-*: nothing a caller writes
 * into a header is evidence of which person it is (#1496).
 */

type ActorRequest = Pick<NextRequest, "headers" | "cookies">;

export function teamActor(req: ActorRequest): TeamActor {
  const conversationId = callerConversationId(req);
  if (conversationId) return { kind: "agent", conversationId };
  if (!directOperatorActivityAuthority(req).ok) return { kind: "service", service: "viewer" };
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
