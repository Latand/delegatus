import { NextRequest, NextResponse } from "next/server";
import { guardRelayRoute, refusedHere, relayRouteError } from "@/lib/externalRelay/routeGuard";
import { bindOwnerKey, forgetOwnerKey, ownerApiView } from "@/lib/externalRelay/ownerApi";
import { readRelayStore } from "@/lib/externalRelay/store";
import { readRelaySwitches } from "@/lib/externalRelay/switches";
import { ExternalRelayError } from "@/lib/externalRelay/client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
async function find(context: Context) {
  if (!readRelaySwitches().owner_api) throw new ExternalRelayError("owner_api_unavailable", 409);
  const id = (await context.params).id;
  const relay = readRelayStore().relays.find((r) => r.id === id);
  if (!relay) throw new ExternalRelayError("not_found", 404);
  return relay;
}
export async function PUT(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req); if (denied) return denied;
  try {
    const relay = await find(context);
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.key !== "string") return refusedHere();
    return NextResponse.json({ ownerApi: await bindOwnerKey(relay!, body.key) });
  } catch (error) { return relayRouteError(error); }
}
export async function DELETE(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req); if (denied) return denied;
  try {
    const relay = await find(context);
    const view = await ownerApiView(relay!); if (!view) throw new ExternalRelayError("owner_api_unavailable", 409);
    forgetOwnerKey(relay!.id);
    return NextResponse.json({ ownerApi: { ...view, state: "none", boundAt: null, expiresAt: null } });
  } catch (error) { return relayRouteError(error); }
}
