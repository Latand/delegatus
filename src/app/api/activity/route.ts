import { NextRequest, NextResponse } from "next/server";

import { ACTIVITY_MEMBER_FORBIDDEN, ActivityMemberForbidden, activityResponse, type ActivityResponse } from "@/lib/activity/report";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";
import { requestSession, teamMode } from "@/lib/team/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The activity dashboard's one read (docs/design/activity-dashboard.md):
 * `range=today|7d|30d`, `tz` (the settings' zone, Europe/Kyiv, when absent),
 * `window` and `break` in minutes, `rounding`, and `project`, a project key
 * that scopes the totals and days to that project's share of the same count,
 * and `member`: absent for the viewer's own input, a member id, or `all`.
 * The owner, and a solo host's operator, may name anyone; anyone else naming
 * someone other than themselves gets 403 `activity_member_forbidden`.
 * Every other parameter is clamped; the answer holds times, durations, counts,
 * enums, project keys and names, member ids and roster names, pipeline and
 * stage ids and role ids — no path, title, message text or email.
 */
export async function GET(req: NextRequest): Promise<NextResponse<ActivityResponse | (ApiError & { code?: string })>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  try {
    const mode = teamMode();
    const session = requestSession(req);
    const body = await activityResponse(req.nextUrl.searchParams, {}, {
      mode: session ? "team" : mode,
      memberId: session?.member.id ?? null,
      canChoose: session ? session.member.role === "owner" : mode === "solo",
    });
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ActivityMemberForbidden) {
      return NextResponse.json({ error: error.message, code: ACTIVITY_MEMBER_FORBIDDEN }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: "activity report unavailable" }, { status: 500 });
  }
}
