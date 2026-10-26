import { NextResponse, type NextRequest } from "next/server";
import { crossOrigin, readJson, requireMember, teamErrorResponse, teamJson } from "@/lib/team/http";
import { requireWorkspaceManager } from "@/lib/team/workspaceAccess";
import { readWorkspaceDefaults, setWorkspaceDefaults } from "@/lib/team/workspaceDefaults";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Context): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const { id } = await ctx.params;
    requireWorkspaceManager(authed.store, authed.live.member, id);
    return teamJson({ defaults: readWorkspaceDefaults(authed.store, id) });
  } catch (error) { return teamErrorResponse(error); }
}

export async function PUT(req: NextRequest, ctx: Context): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const { id } = await ctx.params;
    const input = await readJson(req);
    return teamJson({ defaults: setWorkspaceDefaults(authed.store, authed.live.member, id, input) });
  } catch (error) { return teamErrorResponse(error); }
}
