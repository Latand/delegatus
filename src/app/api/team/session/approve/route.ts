import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, readJson, requireMember, teamErrorResponse, teamJson } from "@/lib/team/http";
import { confirmApproval, lookupApproval } from "@/lib/team/members";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A signed-in member approves a new device as themselves (§5.2).
 * `{ code }` looks the request up and answers which device asked;
 * `{ id, approve }` answers it. The new device becomes the approver.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const body = await readJson(req);
    if (typeof body.id === "string") {
      confirmApproval(authed.store, authed.live.member, body.id, body.approve === true);
      return teamJson({ ok: true });
    }
    const challenge = lookupApproval(authed.store, authed.live.member, body.code);
    return teamJson({
      id: challenge.id,
      surface: challenge.requester?.surface ?? "other",
      browser: challenge.requester?.browser ?? "other",
      expiresAt: challenge.expiresAt,
    });
  } catch (error) {
    return teamErrorResponse(error);
  }
}
