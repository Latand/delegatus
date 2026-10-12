import { NextRequest, NextResponse } from "next/server";
import {
  guardRelayRoute,
  refusedHere,
  relayRouteError,
} from "@/lib/externalRelay/routeGuard";
import { generateCloneAvatars } from "@/lib/externalRelay/cloneCreate";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
/** «Згенерувати»: the relay's generator draws the portraits, this install hands back small previews. */
export async function POST(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "prompt") || typeof body.prompt !== "string")
      return refusedHere();
    return NextResponse.json({ candidates: await generateCloneAvatars((await context.params).id, body.prompt) });
  } catch (error) {
    return relayRouteError(error);
  }
}
