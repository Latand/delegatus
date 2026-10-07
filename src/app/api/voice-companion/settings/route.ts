import { NextRequest, NextResponse } from "next/server";
import { CompanionStorage } from "@/lib/voiceCompanion/storage";
import { companionBody, companionFailure, companionOperator } from "@/lib/voiceCompanion/http";
import { LIVE_USD_PER_SECOND } from "@/lib/voiceCompanion/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rejection = companionOperator(req);
  if (rejection) return rejection;
  try { return NextResponse.json(new CompanionStorage().settings(), { headers: { "Cache-Control": "no-store" } }); }
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
    if (Object.keys(body).some(key => !["enabled", "monthlyCapUsd"].includes(key))) throw new Error("INVALID_SETTINGS");
    return NextResponse.json(new CompanionStorage().updateSettings(body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return companionFailure(error); }
}
