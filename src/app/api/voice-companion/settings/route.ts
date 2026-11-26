import { NextRequest, NextResponse } from "next/server";
import { CompanionStorage } from "@/lib/voiceCompanion/storage";
import { companionBody, companionFailure, companionOperator, companionStarter } from "@/lib/voiceCompanion/http";
import { existingCompanionSessions } from "@/lib/voiceCompanion/server";
import { LIVE_USD_PER_SECOND } from "@/lib/voiceCompanion/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rejection = companionOperator(req);
  if (rejection) return rejection;
  try {
    const planBilling = existingCompanionSessions()?.planBillingFor(companionStarter(req));
    if (req.nextUrl.searchParams.get("view") === "plan-billing") return NextResponse.json({ planBilling }, { headers: { "Cache-Control": "no-store" } });
    const settings = new CompanionStorage().settings();
    return NextResponse.json({ ...settings, ...(planBilling ? { planBilling } : {}) }, { headers: { "Cache-Control": "no-store" } });
  }
  catch (error) { return companionFailure(error); }
}
export async function PUT(req: NextRequest) {
  const rejection = companionOperator(req);
  if (rejection) return rejection;
  try {
    const body = await companionBody(req, 1_024);
    // The operator's release of a session a lost mint answer may have opened; it stands alone.
    if (body.releaseUncertainSession !== undefined) {
      if (body.releaseUncertainSession !== true || Object.keys(body).length !== 1) throw new Error("INVALID_SETTINGS");
      return NextResponse.json(new CompanionStorage().releaseUncertainMints(LIVE_USD_PER_SECOND), { headers: { "Cache-Control": "no-store" } });
    }
    if (Object.keys(body).some(key => !["enabled", "monthlyCapUsd", "backend", "callMemory", "timerTelegram"].includes(key))) throw new Error("INVALID_SETTINGS");
    return NextResponse.json(await new CompanionStorage().updateSettingsAsync(body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return companionFailure(error); }
}
