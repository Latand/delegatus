import { NextRequest, NextResponse } from "next/server";
import { CompanionStorage } from "@/lib/voiceCompanion/storage";
import { companionBody, companionFailure, companionOperator } from "@/lib/voiceCompanion/http";

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
    if (Object.keys(body).some(key => !["enabled", "backend", "monthlyCapUsd"].includes(key))) throw new Error("INVALID_SETTINGS");
    return NextResponse.json(new CompanionStorage().updateSettings(body), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return companionFailure(error); }
}
