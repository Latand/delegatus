import { NextRequest, NextResponse } from "next/server";
import { companionFailure, companionOperator, companionStarter } from "@/lib/voiceCompanion/http";
import { companionSessions } from "@/lib/voiceCompanion/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's own call that dropped and can go on, or null: a browser that reloaded, or that lost its network,
 * offers it in one tap. Read only; resuming is a start with `resume` on the session route. */
export async function GET(req: NextRequest) {
  const rejection = companionOperator(req); if (rejection) return rejection;
  try { return NextResponse.json({ resumable: companionSessions().resumable(companionStarter(req)) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return companionFailure(error); }
}
