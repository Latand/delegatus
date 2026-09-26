import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, readJson, requireOwner, teamErrorResponse, teamJson } from "@/lib/team/http";
import { memberSummary } from "@/lib/team/members";
import { answerJoinRequest } from "@/lib/team/telegramSignIn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The owner answers a Telegram join request: `{ approve, name? }`. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireOwner(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const { id } = await ctx.params;
    const body = await readJson(req);
    const member = answerJoinRequest(authed.store, authed.live.member, id, body.approve === true, body.name);
    return teamJson({ ok: true, member: member ? memberSummary(member) : null });
  } catch (error) {
    return teamErrorResponse(error);
  }
}
