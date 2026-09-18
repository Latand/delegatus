import { NextRequest, NextResponse } from "next/server";

import { handleOrchestratorRotationRequest } from "@/lib/orchestrator/seatCommand";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

/* Explicit orchestrator rotation (two-axis contract). Behavior lives in
   `@/lib/orchestrator/seatCommand`; a route module may export only the
   documented route fields. Rotation is NEVER automatic — this route runs only
   when explicitly called, and context pressure elsewhere only recommends.

   Authority lives there too, in ONE contract this route and the
   `rotate_orchestrator` MCP tool share (#1402): the tool posts here, so
   whatever actor reaches this route rotates, whichever surface it came from.
   The contract bans nobody and names everybody — cross-origin is still refused
   below, because that is the perimeter and not an actor rule. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse<Record<string, unknown> | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  /* No throw leaves this route as a bodyless 500 (#1757). The rotation itself
     records the reason on its own intent and answers it; this is the outer
     guard for everything before that — resolving the actor, reaching the
     command at all — so a caller always gets a reason it can read and report,
     and never a rotation that simply vanished. */
  try {
    const result = await handleOrchestratorRotationRequest(req, body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(`orchestrator rotation route failed: ${error}`);
    return NextResponse.json({ error, code: "rotation_failed" }, { status: 500 });
  }
}
