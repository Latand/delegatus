import { NextRequest, NextResponse } from "next/server";
import { relayChats } from "@/lib/externalRelay/conversationView";
import { guardRelayRoute, relayRouteError } from "@/lib/externalRelay/routeGuard";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * The relay's per-chat conversations for the operator's conversation list
 * (relay-slice3.md §4): one row per chat and context, with the transcript as a
 * conversation entry once a turn wrote one. Operator only, like every relay
 * route; the scanner keeps listing none of them.
 */
export async function GET(req: NextRequest) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    return NextResponse.json(relayChats());
  } catch (error) {
    return relayRouteError(error);
  }
}
