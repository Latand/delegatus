import { NextRequest, NextResponse } from "next/server";
import { companionBody, companionFailure, companionOperator, companionStarter } from "@/lib/voiceCompanion/http";
import { companionSessions } from "@/lib/voiceCompanion/server";
import { CallMemory } from "@/lib/voiceCompanion/callMemory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function memory() { const service = companionSessions(); return new CallMemory(service.storage, service.admission.records); }
export async function GET(req: NextRequest) {
  const rejection = companionOperator(req); if (rejection) return rejection;
  try { const store = memory(); const starter = companionStarter(req); return NextResponse.json({ calls: store.list(starter), retained: store.retained(starter) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return companionFailure(error); }
}
export async function DELETE(req: NextRequest) {
  const rejection = companionOperator(req); if (rejection) return rejection;
  try {
    const body = await companionBody(req,1024);
    const all = body.all === true && Object.keys(body).length === 1;
    const one = typeof body.sessionId === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(body.sessionId) && Object.keys(body).length === 1;
    if (!all && !one) throw new Error("INVALID_REQUEST");
    const store = memory(); const starter = companionStarter(req);
    store.clear(starter, all ? undefined : body.sessionId as string);
    return NextResponse.json({ calls: store.list(starter), retained: store.retained(starter) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return companionFailure(error); }
}
