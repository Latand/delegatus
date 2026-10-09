import { ownerApiView } from "@/lib/externalRelay/ownerApi";
import { readRelaySwitches } from "@/lib/externalRelay/switches";
import { NextRequest, NextResponse } from "next/server";
import { guardRelayRoute } from "@/lib/externalRelay/routeGuard";
import {
  externalRelayRows,
  refreshTargetsForRead,
} from "@/lib/externalRelay/poller";
import {
  publicPending,
  publicRelay,
  readRelayStore,
} from "@/lib/externalRelay/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  await refreshTargetsForRead();
  const store = readRelayStore();
  return NextResponse.json({
    relays: await Promise.all(store.relays.map(async (relay) => {
      const view = publicRelay(relay);
      if (!readRelaySwitches().owner_api) return view;
      const ownerApi = await ownerApiView(relay);
      return ownerApi ? { ...view, ownerApi } : view;
    })),
    pending: store.pending.map(publicPending),
    status: externalRelayRows(),
  });
}
