import { NextRequest, NextResponse } from "next/server";
import { guardRelayRoute, relayRouteError } from "@/lib/externalRelay/routeGuard";
import { readAnswerRecord } from "@/lib/externalRelay/answers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {
  params: Promise<{ id: string; targetId: string; requestId: string }>;
};
/** One relayed exchange, read-only (relay.md §B.9). */
export async function GET(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    const { id, targetId, requestId } = await context.params;
    const answer = readAnswerRecord(id, targetId, requestId);
    return answer
      ? NextResponse.json({ answer })
      : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return relayRouteError(error);
  }
}
