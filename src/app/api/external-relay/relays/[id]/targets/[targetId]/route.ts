import { NextRequest, NextResponse } from "next/server";
import {
  guardRelayRoute,
  relayRouteError,
} from "@/lib/externalRelay/routeGuard";
import { relayCall } from "@/lib/externalRelay/client";
import { readRelayStore, updateRelayStore } from "@/lib/externalRelay/store";
import { targetSchema } from "@/lib/externalRelay/protocol";
import { refreshExternalRelayPollers } from "@/lib/externalRelay/poller";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; targetId: string }> };
export async function PATCH(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req, true);
  if (denied) return denied;
  try {
    const { id, targetId } = await context.params;
    const relay = readRelayStore().relays.find((item) => item.id === id);
    const target = relay?.targets.find((item) => item.id === targetId);
    if (!relay || !target)
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    const patch = await req.json();
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some(
        (key) => !["answered_by", "fallback"].includes(key),
      ) ||
      !["install", "service", undefined].includes(patch.answered_by) ||
      !["service", "none", undefined].includes(patch.fallback) ||
      (patch.answered_by === undefined && patch.fallback === undefined) ||
      (patch.answered_by === "install" && (!target.engine || !target.model))
    )
      return NextResponse.json({ error: "malformed" }, { status: 400 });
    const result = await relayCall(
      relay.api_base,
      `/targets/${encodeURIComponent(targetId)}`,
      "PATCH",
      patch,
      relay.credential,
      { maxBytes: relay.limits.max_response_bytes },
    );
    const remote = targetSchema.parse(result.body);
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              targets: entry.targets.map((item) =>
                item.id === targetId
                  ? {
                      ...item,
                      answered_by: remote.answered_by,
                      fallback: remote.fallback,
                      name: remote.name,
                    }
                  : item,
              ),
            }
          : entry,
      ),
    }));
    refreshExternalRelayPollers(id);
    return NextResponse.json({ target: remote });
  } catch (error) {
    return relayRouteError(error);
  }
}
