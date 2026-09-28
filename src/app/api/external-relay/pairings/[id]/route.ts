import { NextRequest, NextResponse } from "next/server";
import {
  guardRelayRoute,
  relayRouteError,
} from "@/lib/externalRelay/routeGuard";
import {
  cancelRelayPairing,
  checkRelayPairing,
  confirmRelayPairing,
} from "@/lib/externalRelay/pairing";
import { refreshExternalRelayPollers } from "@/lib/externalRelay/poller";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    return NextResponse.json({
      pairing: await checkRelayPairing((await context.params).id),
    });
  } catch (error) {
    return relayRouteError(error);
  }
}
export async function POST(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    if (typeof body?.ownerId !== "string")
      return NextResponse.json({ error: "malformed" }, { status: 400 });
    const relay = await confirmRelayPairing(
      (await context.params).id,
      body.ownerId,
    );
    refreshExternalRelayPollers(relay.id);
    return NextResponse.json({ relay });
  } catch (error) {
    return relayRouteError(error);
  }
}
export async function DELETE(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    await cancelRelayPairing((await context.params).id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return relayRouteError(error);
  }
}
