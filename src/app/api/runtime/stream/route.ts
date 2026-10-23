import { workspaceRoute, requestWorkspaceScope } from "@/lib/team/workspaceRoute";
import { workspaceRuntimeEvent } from "@/lib/team/workspaceProjection";
import type { NextRequest } from "next/server";

import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsEnabled, RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import { runtimeCursor, runtimeEventStream } from "@/lib/runtime/sse";
import { sessionBoundStream } from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function memberGET(request: NextRequest): Promise<Response> {
  /* Same plane-absent code the snapshot route sends: a deployment with no
     runtime plane is a durable fact, not a reconnectable outage. */
  if (!runtimeEventsEnabled()) return Response.json({ error: "runtime events are disabled", code: RUNTIME_PLANE_ABSENT }, { status: 503 });
  const client = runtimeHostClient();
  if (!client) return Response.json({ error: "runtime host socket is unavailable", code: RUNTIME_PLANE_ABSENT }, { status: 503 });
  const url = new URL(request.url);
  const header = request.headers.get("last-event-id");
  let after: number;
  try {
    after = runtimeCursor(url.searchParams.get("after"), header);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "runtime cursor is invalid" }, { status: 400 });
  }
  const initial = requestWorkspaceScope(request);
  const restricted = Boolean(initial && !initial.owner);
  return new Response(sessionBoundStream(request, request.signal, (signal) => runtimeEventStream(client, after, signal, async event => {
    const scope = requestWorkspaceScope(request);
    return restricted ? Boolean(scope && await workspaceRuntimeEvent(scope, event, () => requestWorkspaceScope(request))) : true;
  })), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

export const GET = workspaceRoute("/api/runtime/stream", memberGET, true);
