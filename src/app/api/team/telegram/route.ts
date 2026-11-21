import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, requireMember, teamErrorResponse, teamJson } from "@/lib/team/http";
import { unlinkTelegram } from "@/lib/team/telegramSignIn";
import { revokeOwnerRuns } from "@/lib/externalRelay/ownerRun";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Unlinks the caller's Telegram account. Linking starts at
    `POST /api/team/session/telegram { purpose: "link" }`. */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const authed = requireMember(req);
  if (authed instanceof NextResponse) return authed;
  try {
    const member = authed.live.member;
    unlinkTelegram(authed.store, member);
    if (member.role === "owner" && member.telegram) await revokeOwnerRuns();
    return teamJson({ ok: true });
  } catch (error) {
    return teamErrorResponse(error);
  }
}
