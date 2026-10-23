import { NextRequest, NextResponse } from "next/server";
import { companionFailure, companionOperator, companionStarter, ownsCompanionSession } from "@/lib/voiceCompanion/http";
import { companionSessions } from "@/lib/voiceCompanion/server";
import { retainedCalls } from "@/lib/voiceCompanion/callHistory";
import type { StoredSession } from "@/lib/voiceCompanion/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's own retained voice calls, newest first, each with what it did (`callHistoryTypes.ts`). A call's
 * words stay in its record, which the session route serves to the same owner. Read only. */
export async function GET(req: NextRequest) {
  const denied = companionOperator(req); if (denied) return denied;
  try {
    const service = companionSessions();
    // The session route's own owner rule decides each row, so a listed id opens there and nowhere else.
    const starter = companionStarter(req);
    const owns = (session: StoredSession) => ownsCompanionSession(starter, session);
    return NextResponse.json({ calls: retainedCalls(service.storage, service.admission.records, owns) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return companionFailure(error); }
}
