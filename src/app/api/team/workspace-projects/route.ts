import { NextResponse, type NextRequest } from "next/server";

import { TeamError } from "@/lib/team/members";
import { crossOrigin, readJson, requireOwner, teamErrorResponse, teamJson } from "@/lib/team/http";
import { placeProject, requestWorkspaceOptions } from "@/lib/team/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{ project, workspaceId }`, owner only: Add, Remove and Move to… are this
    one call, and `workspaceId: null` puts the project back in Unassigned.
    Answers the canonical key; the same request again changes nothing. */
export async function PUT(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireOwner(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const body = await readJson(req);
    if (!Object.hasOwn(body, "workspaceId")) throw new TeamError("invalid_id", "workspaceId is a workspace id or null");
    return teamJson(placeProject(authed.store, authed.live.member, body.project, body.workspaceId, requestWorkspaceOptions()));
  } catch (error) {
    return teamErrorResponse(error);
  }
}
