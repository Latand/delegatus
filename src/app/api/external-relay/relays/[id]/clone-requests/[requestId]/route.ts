import { NextRequest, NextResponse } from "next/server";
import { guardRelayRoute, relayRouteError } from "@/lib/externalRelay/routeGuard";
import { cancelCloneRequest, checkCloneRequest } from "@/lib/externalRelay/cloneCreate";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; requestId: string }> };
export async function GET(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    const { id, requestId } = await context.params;
    return NextResponse.json({ request: await checkCloneRequest(id, requestId) });
  } catch (error) {
    return relayRouteError(error);
  }
}
export async function DELETE(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    const { id, requestId } = await context.params;
    await cancelCloneRequest(id, requestId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return relayRouteError(error);
  }
}
