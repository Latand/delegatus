import { NextResponse, type NextRequest } from "next/server";

import { crossOrigin, device, readJson, requireMember, signInStore, teamErrorResponse, teamJson, telegramBot } from "@/lib/team/http";
import { startTelegram, telegramDeepLink } from "@/lib/team/telegramSignIn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A Telegram deep link with a one-time code (§5.3). `{ purpose: "sign-in" }`
 * needs nobody signed in; `{ purpose: "link" }` binds the signed-in member's
 * Telegram account. The browser polls with the proof it is handed.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejection = crossOrigin(req);
  if (rejection) return rejection;
  const store = signInStore();
  if (store instanceof NextResponse) return store;
  try {
    const bot = await telegramBot();
    if (!bot.available || !bot.botUsername) {
      return teamJson({ error: "no Telegram bot is connected to this Delegatus", code: "telegram_unavailable" }, 409);
    }
    const body = await readJson(req);
    const purpose = body.purpose === "link" ? "link" : "sign-in";
    let memberId: string | null = null;
    if (purpose === "link") {
      const authed = requireMember(req);
      if (authed instanceof NextResponse) return authed;
      memberId = authed.live.member.id;
    }
    const { challenge, code } = startTelegram(store, purpose, memberId, device(req));
    return teamJson({ id: challenge.id, proof: code, url: telegramDeepLink(bot.botUsername, code), expiresAt: challenge.expiresAt });
  } catch (error) {
    return teamErrorResponse(error);
  }
}
