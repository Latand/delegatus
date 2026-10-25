import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, requireMember, teamErrorResponse, teamJson } from "@/lib/team/http";
import { inviteWorkspace } from "@/lib/team/workspaceAccess";
import { withdrawInvite } from "@/lib/team/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const { id } = await ctx.params;
    const invite = authed.store.challenge(id);
    if (!invite || invite.kind !== "invite") return teamJson({ error: "no such invite", code: "invite_gone" }, 404);
    inviteWorkspace(authed.store, authed.live.member, invite.payload?.workspaceId);
    return withdrawInvite(authed.store, id) ? teamJson({ ok: true }) : teamJson({ error: "no such invite", code: "invite_gone" }, 404);
  } catch (error) {
    return teamErrorResponse(error);
  }
}
