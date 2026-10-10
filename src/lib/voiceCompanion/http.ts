import { NextRequest, NextResponse } from "next/server";
import { operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { teamActor, teamMode } from "@/lib/team";
import { existingTeamStore } from "@/lib/team/store";
import type { SessionStarter, StoredSession } from "./storage";

export function companionStarter(req: NextRequest): SessionStarter {
  const actor = teamActor(req);
  if (actor.kind === "member" && existingTeamStore()?.member(actor.memberId)?.status === "active") return { memberId: actor.memberId };
  if (actor.kind === "operator" && teamMode() === "solo") return { operator: true };
  throw new Error(actor.kind === "anonymous" || actor.kind === "member" ? "MEMBER_REQUIRED" : "OPERATOR_REQUIRED");
}
/** A session id or mint request id is never authority for another member's call. */
export function companionSessionOwner(req: NextRequest, session: StoredSession): void {
  const starter = companionStarter(req);
  if (teamMode() === "team" || (session.startedBy && "memberId" in session.startedBy)) {
    if (!("memberId" in starter) || !session.startedBy || !("memberId" in session.startedBy)
      || session.startedBy.memberId !== starter.memberId) throw new Error("MEMBER_REQUIRED");
  }
}

export function companionOperator(req: NextRequest): NextResponse | null {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  if (req.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER) || !operatorBrowserRequest(req))
    return NextResponse.json({ code: "OPERATOR_REQUIRED", error: "Open this control in Delegatus." }, { status: 403 });
  try { companionStarter(req); } catch (error) { return companionFailure(error); }
  return null;
}
export async function companionBody(req: NextRequest, limit = 96_000): Promise<Record<string, unknown>> {
  const body = await req.text();
  if (Buffer.byteLength(body) > limit) throw new Error("INVALID_REQUEST");
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_REQUEST");
  return parsed;
}
export function companionFailure(error: unknown): NextResponse {
  const candidate = error instanceof Error ? error.message : "";
  const code = ["OPERATOR_REQUIRED", "MEMBER_REQUIRED", "NO_KEY", "KEY_FROM_ENV", "CAP_REACHED", "INVALID_SETTINGS", "INVALID_KEY", "INVALID_REQUEST", "SESSION_CLOSED", "SESSION_UNAVAILABLE", "COMPANION_DISABLED", "SESSION_LIMIT", "PROJECT_REFUSED", "TOOL_NOT_ALLOWED", "PROVIDER_ERROR", "MINT_UNCERTAIN"].includes(candidate) ? candidate : "COMPANION_UNAVAILABLE";
  return NextResponse.json({ code }, { status: code === "MEMBER_REQUIRED" ? 401 : code === "OPERATOR_REQUIRED" ? 403 : code.startsWith("INVALID") ? 400 : code === "PROVIDER_ERROR" ? 502 : 409, headers: { "Cache-Control": "no-store" } });
}
