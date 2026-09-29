import { NextRequest, NextResponse } from "next/server";
import {
  guardRelayRoute,
  refusedHere,
  relayRouteError,
} from "@/lib/externalRelay/routeGuard";
import { startRelayPairing } from "@/lib/externalRelay/pairing";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    if (
      typeof body?.url !== "string" ||
      (body.label !== undefined &&
        (typeof body.label !== "string" || body.label.length > 64))
    )
      return refusedHere();
    return NextResponse.json(
      { pairing: await startRelayPairing(body.url, body.label) },
      { status: 201 },
    );
  } catch (error) {
    return relayRouteError(error);
  }
}
