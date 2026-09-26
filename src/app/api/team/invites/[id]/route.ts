import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, requireOwner, teamErrorResponse, teamJson } from "@/lib/team/http";
import { withdrawInvite } from "@/lib/team/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireOwner(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const { id } = await ctx.params;
    return withdrawInvite(authed.store, id) ? teamJson({ ok: true }) : teamJson({ error: "no such invite", code: "invite_gone" }, 404);
  } catch (error) {
    return teamErrorResponse(error);
  }
}
