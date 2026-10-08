import { NextRequest, NextResponse } from "next/server";
import { guardRelayRoute, relayRouteError } from "@/lib/externalRelay/routeGuard";
import {
  listAnswerRecords,
  RELAY_ANSWER_RETENTION_DAYS,
} from "@/lib/externalRelay/answers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; targetId: string }> };
/** A target's recent answers, newest first (relay.md §B.9). Reads local records only. */
export async function GET(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    const { id, targetId } = await context.params;
    return NextResponse.json({
      answers: listAnswerRecords(id, targetId),
      retentionDays: RELAY_ANSWER_RETENTION_DAYS,
    });
  } catch (error) {
    return relayRouteError(error);
  }
}
