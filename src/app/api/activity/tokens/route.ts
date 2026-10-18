import { NextRequest, NextResponse } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { requestSession, teamMode } from "@/lib/team/sessions";
import { ActivityMemberForbidden, ACTIVITY_MEMBER_FORBIDDEN } from "@/lib/activity/report";
import { activityTokensResponse } from "@/lib/activity/tokenReport";
import { activityOperation } from "@/lib/activity/operation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  return activityOperation("activity.tokens.read", async () => {
    try {
      const mode = teamMode(), session = requestSession(req);
      const body = await activityTokensResponse(req.nextUrl.searchParams, {
        mode: session ? "team" : mode, memberId: session?.member.id ?? null,
        canChoose: session ? session.member.role === "owner" : mode === "solo",
      });
      return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof ActivityMemberForbidden) return NextResponse.json({ error: error.message, code: ACTIVITY_MEMBER_FORBIDDEN }, { status: 403, headers: { "Cache-Control": "no-store" } });
      return NextResponse.json({ error: "activity token report unavailable" }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  });
}
