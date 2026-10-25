import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, readJson, requireMember, shareableLink, teamErrorResponse, teamJson } from "@/lib/team/http";
import { createInvite, openInvites } from "@/lib/team/members";
import { workspaceScope } from "@/lib/team/workspaceAccess";
import { pendingJoinRequests } from "@/lib/team/telegramSignIn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open invites and pending join requests, for the owner's Members tab. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const scope = workspaceScope(authed.store, authed.live.member.id);
    return teamJson({ invites: openInvites(authed.store).filter(invite => scope.owner || (invite.workspaceId && scope.role(invite.workspaceId) === "manager")), requests: scope.owner ? pendingJoinRequests(authed.store) : [] });
  } catch (error) {
    return teamErrorResponse(error);
  }
}

/** A new invite link (§6.3): single use, seven days. The link is answered
    once and never again; withdraw and reissue instead. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const body = await readJson(req);
    const { challenge, code } = createInvite(authed.store, authed.live.member, body.name, Date.now(), body.workspaceId);
    return teamJson({
      id: challenge.id,
      url: shareableLink(req, `/join/${code}`),
      invitedName: challenge.invitedName,
      expiresAt: challenge.expiresAt,
    });
  } catch (error) {
    return teamErrorResponse(error);
  }
}
