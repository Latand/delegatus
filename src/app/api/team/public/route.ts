import type { NextRequest, NextResponse } from "next/server";

import { crossOrigin, publicInfo, teamErrorResponse, teamJson } from "@/lib/team/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What a signed-out browser may know: the mode, this host's name and which
    sign-in methods apply here (§6.5). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  try {
    return teamJson(await publicInfo(req));
  } catch (error) {
    return teamErrorResponse(error);
  }
}
