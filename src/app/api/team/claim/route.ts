import type { NextRequest, NextResponse } from "next/server";

import { teamActor } from "@/lib/team/actor";
import { crossOrigin, device, readJson, respondSignedIn, teamErrorResponse, teamJson, teamStore } from "@/lib/team/http";
import { claimInstall } from "@/lib/team/members";
import { existingTeamStore } from "@/lib/team/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The owner claims the install (§6.2). Allowed only in solo mode and only to
 * the request that is the operator today: same origin, neither an agent nor a
 * Viewer service. From the moment it answers, every other browser is asked to
 * sign in.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  try {
    if (existingTeamStore()?.hasActiveOwner()) {
      return teamJson({ error: "this Delegatus already has an owner", code: "already_claimed" }, 409);
    }
    const actor = teamActor(req);
    if (actor.kind !== "operator") {
      return teamJson({ error: "only the person at this Delegatus can set up a team", code: "operator_required" }, 403);
    }
    const body = await readJson(req);
    return respondSignedIn(req, claimInstall(teamStore(), body.name, device(req)));
  } catch (error) {
    return teamErrorResponse(error);
  }
}
