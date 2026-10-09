import { NextRequest, NextResponse } from "next/server";
import { CompanionStorage } from "@/lib/voiceCompanion/storage";
import { companionBody, companionFailure, companionOperator } from "@/lib/voiceCompanion/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Write-only. Even failures return a fixed code, without the request or a path. */
export async function PUT(req: NextRequest) {
  const rejection = companionOperator(req);
  if (rejection) return rejection;
  try {
    const body = await companionBody(req, 1_024);
    if (Object.keys(body).some(key => key !== "key") || typeof body.key !== "string") throw new Error("INVALID_KEY");
    const storage = new CompanionStorage();
    storage.saveKey(body.key);
    return NextResponse.json(storage.settings(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return companionFailure(error); }
}
