import { NextRequest, NextResponse } from "next/server";

import { activityResponse, type ActivityResponse } from "@/lib/activity/report";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The activity dashboard's one read (docs/design/activity-dashboard.md):
 * `range=today|7d|30d`, `tz` (the settings' zone, Europe/Kyiv, when absent),
 * `window` and `break` in minutes, `rounding`.
 * Every parameter is clamped; the answer holds times, durations, counts,
 * enums, project keys and names, pipeline and stage ids and role ids — no
 * path, title or message text.
 */
export async function GET(req: NextRequest): Promise<NextResponse<ActivityResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  try {
    const body = await activityResponse(req.nextUrl.searchParams);
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "activity report unavailable" }, { status: 500 });
  }
}
