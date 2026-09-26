import type { NextRequest, NextResponse } from "next/server";

import { crossOrigin, teamErrorResponse, teamJson } from "@/lib/team/http";
import { signOutSession } from "@/lib/team/members";
import { clearSessionCookie, requestIsHttps, requestSession } from "@/lib/team/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Signs this browser out: the session ends on the server and the cookie is
    cleared. Answers ok for a browser that was not signed in. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  try {
    const live = requestSession(req);
    if (live) {
      const { existingTeamStore } = await import("@/lib/team/store");
      const store = existingTeamStore();
      if (store) signOutSession(store, live.member, live.session);
    }
    const response = teamJson({ ok: true });
    clearSessionCookie(response, requestIsHttps(req));
    return response;
  } catch (error) {
    return teamErrorResponse(error);
  }
}
