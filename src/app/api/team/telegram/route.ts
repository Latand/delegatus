import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, requireMember, teamErrorResponse, teamJson } from "@/lib/team/http";
import { unlinkTelegram } from "@/lib/team/telegramSignIn";

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
    unlinkTelegram(authed.store, authed.live.member);
    return teamJson({ ok: true });
  } catch (error) {
    return teamErrorResponse(error);
  }
}
