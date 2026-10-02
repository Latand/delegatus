import { NextRequest, NextResponse } from "next/server";
import { guardRelayRoute } from "@/lib/externalRelay/routeGuard";
import { readRelayDescriptor } from "@/lib/externalRelay/client";
import {
  KNOWN_RELAYS,
  knownRelayInfo,
  type KnownRelayInfo,
} from "@/lib/externalRelay/knownRelays";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * The built-in relay list with whatever each service's descriptor says now.
 * A service that cannot be read keeps its list entry: the button still works,
 * and the pairing reports why it cannot go on.
 */
export async function GET(req: NextRequest) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  const known: KnownRelayInfo[] = await Promise.all(
    KNOWN_RELAYS.map(async (relay) => {
      try {
        const { descriptor } = await readRelayDescriptor(relay.origin);
        return knownRelayInfo(relay, descriptor);
      } catch {
        return knownRelayInfo(relay, null);
      }
    }),
  );
  return NextResponse.json({ known });
}
