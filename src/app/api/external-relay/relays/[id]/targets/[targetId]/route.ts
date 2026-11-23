import { NextRequest, NextResponse } from "next/server";
import {
  guardRelayRoute,
  refusedHere,
  relayRouteError,
} from "@/lib/externalRelay/routeGuard";
import { relayCall } from "@/lib/externalRelay/client";
import { readRelayStore, updateRelayStoreAsync } from "@/lib/externalRelay/store";
import { answeredElsewhereResponse } from "@/lib/externalRelay/targetOwnership";
import { ExternalRelayError } from "@/lib/externalRelay/errors";
import { targetSchema, type ExternalRelayTarget } from "@/lib/externalRelay/protocol";
import { refreshExternalRelayPollers } from "@/lib/externalRelay/poller";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; targetId: string }> };
export async function PATCH(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    const { id, targetId } = await context.params;
    const patch = await req.json();
    const relay = readRelayStore().relays.find((item) => item.id === id);
    const target = relay?.targets.find((item) => item.id === targetId);
    if (!relay || !target)
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some(
        (key) => !["answered_by", "fallback", "confirmTakeover"].includes(key),
      ) ||
      !["install", "service", undefined].includes(patch.answered_by) ||
      (patch.confirmTakeover !== undefined && typeof patch.confirmTakeover !== "boolean") ||
      (patch.answered_by === "install" && target.answered_elsewhere === true && patch.confirmTakeover !== true) ||
      !["service", "none", undefined].includes(patch.fallback) ||
      (patch.answered_by === undefined && patch.fallback === undefined) ||
      (patch.answered_by === "install" && (!target.engine || !target.model))
    )
      return refusedHere();
    let remote: ExternalRelayTarget;
    let refusedElsewhere = false;
    try {
      // Confirmation is local to the owner UI; only protocol fields reach the service.
      const result = await relayCall(
        relay.api_base,
        `/targets/${encodeURIComponent(targetId)}`,
        "PATCH",
        undefined,
        relay.credential,
        {
          maxBytes: relay.limits.max_response_bytes,
          prepareBody: () => {
            // Refresh may discover another owner while DNS is pending.
            // Recheck synchronously at the final request emission boundary.
            if (patch.answered_by === "install" && patch.confirmTakeover !== true) {
              const current = readRelayStore().relays.find(item => item.id === id)?.targets.find(item => item.id === targetId);
              if (current?.answered_elsewhere === true) throw new ExternalRelayError("refused_here", 400);
            }
            return { ...(patch.answered_by !== undefined ? { answered_by: patch.answered_by } : {}), ...(patch.fallback !== undefined ? { fallback: patch.fallback } : {}) };
          },
        },
      );
      remote = targetSchema.parse(result.body);
    } catch (error) {
      if (patch.answered_by !== "install" || !(error instanceof ExternalRelayError) || !answeredElsewhereResponse(error.status, error.payload, targetId)) throw error;
      refusedElsewhere = true;
      // A competing pairing is a target state, so adoption can continue for its peers.
      remote = { target_id: targetId, name: target.name, answered_by: "service" as const, answered_elsewhere: true, fallback: target.fallback };
    }
    const updated = await updateRelayStoreAsync((store) => ({
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
                      answered_elsewhere: remote.answered_elsewhere,
                      ...(refusedElsewhere ? {} : { fallback: remote.fallback, name: remote.name }),
                    }
                  : item,
              ),
            }
          : entry,
      ),
    }));
    if (refusedElsewhere) {
      const latest = updated.relays.find(entry => entry.id === id)?.targets.find(item => item.id === targetId);
      if (latest) remote = { ...remote, name: latest.name, fallback: latest.fallback };
    }
    refreshExternalRelayPollers(id);
    // A move the owner confirmed was refused: say so. Unconfirmed writes (adoption, clone setup) keep the 200.
    if (refusedElsewhere && patch.confirmTakeover === true)
      return NextResponse.json({ error: "answered_elsewhere" }, { status: 409 });
    return NextResponse.json({ target: remote });
  } catch (error) {
    return relayRouteError(error);
  }
}
