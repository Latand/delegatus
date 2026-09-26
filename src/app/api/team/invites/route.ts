import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, readJson, requireOwner, shareableLink, teamErrorResponse, teamJson } from "@/lib/team/http";
import { createInvite, openInvites } from "@/lib/team/members";
import { pendingJoinRequests } from "@/lib/team/telegramSignIn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open invites and pending join requests, for the owner's Members tab. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireOwner(req);
  if (authed instanceof NextResponse) return authed;
  try {
    return teamJson({ invites: openInvites(authed.store), requests: pendingJoinRequests(authed.store) });
  } catch (error) {
    return teamErrorResponse(error);
  }
}

/** A new invite link (§6.3): single use, seven days. The link is answered
    once and never again; withdraw and reissue instead. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireOwner(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const body = await readJson(req);
    const { challenge, code } = createInvite(authed.store, authed.live.member, body.name);
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
