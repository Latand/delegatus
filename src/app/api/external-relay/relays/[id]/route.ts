import { NextRequest, NextResponse } from "next/server";
import { validateLaunchModel } from "@/lib/agent/models";
import { effortScale } from "@/lib/agent/efforts";
import {
  guardRelayRoute,
  relayRouteError,
} from "@/lib/externalRelay/routeGuard";
import { refreshExternalRelayPollers } from "@/lib/externalRelay/poller";
import { unpairRelay } from "@/lib/externalRelay/pairing";
import {
  publicRelay,
  updateRelayStore,
  type RelayTargetSettings,
} from "@/lib/externalRelay/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    const id = (await context.params).id;
    const body = await req.json();
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !["paused", "target"].includes(key)) ||
      (body.paused !== undefined && typeof body.paused !== "boolean") ||
      (body.target !== undefined &&
        (typeof body.target !== "object" ||
          !body.target ||
          Array.isArray(body.target) ||
          typeof body.target.id !== "string" ||
          Object.keys(body.target).some(
            (key) =>
              ![
                "id",
                "enabled",
                "engine",
                "model",
                "effort",
                "project",
                "concurrency",
                "hardCapMinutes",
              ].includes(key),
          )))
    )
      return NextResponse.json({ error: "malformed" }, { status: 400 });
    let updated: ReturnType<typeof publicRelay> | null = null;
    updateRelayStore((store) => ({
      ...store,
      relays: store.relays.map((relay) => {
        if (relay.id !== id) return relay;
        let targets = relay.targets;
        if (body.target) {
          const patch = body.target as Partial<RelayTargetSettings> & {
            id: string;
          };
          if (!targets.some((target) => target.id === patch.id))
            throw new Error("target missing");
          targets = targets.map((target) => {
            if (target.id !== patch.id) return target;
            const next = { ...target, ...patch };
            if (
              (next.engine !== null &&
                next.engine !== "claude" &&
                next.engine !== "codex") ||
              (next.model !== null &&
                (typeof next.model !== "string" ||
                  !next.engine ||
                  "error" in validateLaunchModel(next.engine, next.model))) ||
              (next.effort !== null &&
                (!next.engine ||
                  !effortScale(next.engine, next.model)?.includes(
                    next.effort,
                  ))) ||
              (next.project !== null &&
                (typeof next.project !== "string" ||
                  next.project.length > 256)) ||
              !Number.isInteger(next.concurrency) ||
              next.concurrency < 1 ||
              next.concurrency > 4 ||
              !Number.isInteger(next.hardCapMinutes) ||
              next.hardCapMinutes < 1 ||
              next.hardCapMinutes > 240 ||
              typeof next.enabled !== "boolean"
            )
              throw new Error("invalid target settings");
            return next;
          });
        }
        const next = { ...relay, paused: body.paused ?? relay.paused, targets };
        updated = publicRelay(next);
        return next;
      }),
    }));
    if (!updated)
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    refreshExternalRelayPollers(id);
    return NextResponse.json({ relay: updated });
  } catch (error) {
    return relayRouteError(error);
  }
}
export async function DELETE(req: NextRequest, context: Context) {
  const denied = guardRelayRoute(req);
  if (denied) return denied;
  try {
    const result = await unpairRelay((await context.params).id);
    refreshExternalRelayPollers((await context.params).id);
    return NextResponse.json(result);
  } catch (error) {
    return relayRouteError(error);
  }
}
