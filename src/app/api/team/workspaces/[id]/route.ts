import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, readJson, requireOwner, teamErrorResponse, teamJson } from "@/lib/team/http";
import { deleteWorkspace, requestWorkspaceOptions, updateWorkspace } from "@/lib/team/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{ name?, color? }`, owner only. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireOwner(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const { id } = await ctx.params;
    const body = await readJson(req);
    return teamJson({ workspace: updateWorkspace(authed.store, id, { name: body.name, color: body.color }, requestWorkspaceOptions()) });
  } catch (error) {
    return teamErrorResponse(error);
  }
}

/** Owner only, and only an empty workspace; one already gone answers
    `deleted: false`. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireOwner(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const { id } = await ctx.params;
    return teamJson({ ok: true, deleted: deleteWorkspace(authed.store, id, requestWorkspaceOptions()) });
  } catch (error) {
    return teamErrorResponse(error);
  }
}
