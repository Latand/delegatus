import { NextResponse, type NextRequest } from "next/server";

import { operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { boardBootScope } from "@/lib/team/boardBootScope";
import type { TeamView } from "@/lib/team/contract";
import { crossOrigin, publicInfo, requireMember, teamErrorResponse, teamJson } from "@/lib/team/http";
import { teamView } from "@/lib/team/members";
import { existingTeamStore } from "@/lib/team/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's view of the team (§4.4): mode, who they are, the members and
    the sign-in methods. A solo install answers `mode: "solo"` and nothing
    else, and the client draws nothing team-related. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  try {
    const store = existingTeamStore();
    if (req.nextUrl.searchParams.get("view") === "board-access") {
      if (!store?.hasActiveOwner()) return teamJson(boardBootScope(operatorBrowserRequest(req)));
      const authed = requireMember(req);
      if (authed instanceof NextResponse) return authed;
      return teamJson(boardBootScope(false, { store, ...authed.live }));
    }
    const info = await publicInfo(req);
    if (info.mode === "solo" || !store) {
      return teamJson<TeamView>({ mode: "solo", me: null, members: [], methods: info.methods });
    }
    const authed = requireMember(req);
    if (authed instanceof NextResponse) return authed;
    return teamJson(teamView(store, authed.live.member, info.methods));
  } catch (error) {
    return teamErrorResponse(error);
  }
}
