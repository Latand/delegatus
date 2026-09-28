import { NextRequest, NextResponse } from "next/server";
import { guardRelayRoute } from "@/lib/externalRelay/routeGuard";
import { externalRelayRows } from "@/lib/externalRelay/poller";
import {
  publicPending,
  publicRelay,
  readRelayStore,
} from "@/lib/externalRelay/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: NextRequest) {
  const denied = guardRelayRoute(req, false);
  if (denied) return denied;
  const store = readRelayStore();
  return NextResponse.json({
    relays: store.relays.map(publicRelay),
    pending: store.pending.map(publicPending),
    status: externalRelayRows(),
  });
}
