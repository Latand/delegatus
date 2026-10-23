import { NextResponse, type NextRequest } from "next/server";
import { crossOrigin, readJson, requireMember, teamErrorResponse, teamJson } from "@/lib/team/http";
import { TeamError } from "@/lib/team/members";
import { requireWorkspaceManager } from "@/lib/team/workspaceAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** An owner or this workspace's manager places a person or changes their role. */
export async function PUT(req: NextRequest, ctx: Context): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  try {
    const authed = requireMember(req);
    if (authed instanceof NextResponse) return authed;
    const { id } = await ctx.params;
    const body = await readJson(req);
    authed.store.transaction(() => {
      requireWorkspaceManager(authed.store, authed.live.member, id);
      const member = typeof body.memberId === "string" ? authed.store.member(body.memberId) : null;
      if (!member || member.status !== "active") throw new TeamError("member_gone", "no active member", 404);
      if (body.role !== "member" && body.role !== "manager") throw new TeamError("invalid_role", "choose member or manager");
      authed.store.putWorkspaceMember(id, member.id, body.role, authed.live.member.id, new Date().toISOString());
    });
    return teamJson({ ok: true });
  } catch (error) { return teamErrorResponse(error); }
}

export async function DELETE(req: NextRequest, ctx: Context): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  try {
    const authed = requireMember(req);
    if (authed instanceof NextResponse) return authed;
    const { id } = await ctx.params;
    const body = await readJson(req);
    authed.store.transaction(() => {
      requireWorkspaceManager(authed.store, authed.live.member, id);
      if (typeof body.memberId !== "string") throw new TeamError("member_required", "choose a member");
      authed.store.removeWorkspaceMember(id, body.memberId);
    });
    return teamJson({ ok: true });
  } catch (error) { return teamErrorResponse(error); }
}
