import { NextRequest, NextResponse } from "next/server";
import { companionBody, companionFailure, companionOperator, companionStarter } from "@/lib/voiceCompanion/http";
import { voiceTimers } from "@/lib/voiceCompanion/voiceTimersServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** What this tab should toast now, and when to read again. Only the caller's own timers. */
export async function GET(req: NextRequest) {
  const denied = companionOperator(req); if (denied) return denied;
  try { return NextResponse.json(await voiceTimers().forTab(companionStarter(req)), { headers }); }
  catch (error) { return companionFailure(error); }
}

/** One tab shows a fired timer's toast: the first claim wins for a short lease and `shown` makes it final. A timer the
 * caller does not own is simply not claimed. */
export async function POST(req: NextRequest) {
  const denied = companionOperator(req); if (denied) return denied;
  try {
    const body = await companionBody(req, 2_000);
    if (typeof body.id !== "string" || !/^vt_[0-9a-f]{16}$/.test(body.id)) throw new Error("INVALID_REQUEST");
    if (body.action === "shown") {
      if (!Number.isSafeInteger(body.lease)) throw new Error("INVALID_REQUEST");
      return NextResponse.json(await voiceTimers().toastShown(companionStarter(req), body.id, body.lease as number), { headers });
    }
    if (body.action !== "claim" || (body.locale !== "en" && body.locale !== "uk")) throw new Error("INVALID_REQUEST");
    return NextResponse.json(await voiceTimers().claimToast(companionStarter(req), body.id, body.locale), { headers });
  } catch (error) { return companionFailure(error); }
}
