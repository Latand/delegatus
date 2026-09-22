import { NextResponse } from "next/server";

import { acceptsGzip, gzipBody } from "@/lib/http/gzipBody";
import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsEnabled, structuredHostsEnabled, RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import { structuredStartupAxis } from "@/lib/runtime/startupStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  /* `runtime-plane-absent` distinguishes "this deployment has no runtime plane
     at all" from "the host is momentarily unreachable": the client bus stops
     claiming host authority on the former (so conversations resolve through the
     legacy path) and keeps its fail-safe reconnect on the latter. */
  if (!runtimeEventsEnabled()) {
    return NextResponse.json({ error: "runtime events are disabled", code: RUNTIME_PLANE_ABSENT }, { status: 503 });
  }
  const url = new URL(request.url);
  const voiceFor = url.searchParams.get("voiceFor");
  if (voiceFor !== null && (!voiceFor || voiceFor.length > 256)) return NextResponse.json({ error: "invalid conversation" }, { status: 400 });
  const summary = url.searchParams.get("view") === "summary";
  const client = runtimeHostClient();
  if (!client) {
    return NextResponse.json({ error: "runtime host socket is unavailable", code: RUNTIME_PLANE_ABSENT }, { status: 503 });
  }
  try {
    const body = JSON.stringify({
      // The request signal reaches the runtime host, so a disconnected caller
      // cancels its socket wait instead of leaving late host work behind.
      ...await client.snapshot(request.signal, summary || voiceFor ? { voiceBodiesFor: voiceFor ? [voiceFor] : [] } : undefined),
      structuredHostsEnabled: structuredHostsEnabled(),
      structuredStartup: structuredStartupAxis(),
    });
    const headers = { "content-type": "application/json", "cache-control": "no-store", vary: "accept-encoding" };
    /* A cold open and every authoritative rejoin read the whole projection,
       megabytes of it; compressed it is a fifth of that on the wire (#1994). */
    if (acceptsGzip(request) && body.length >= 1024) {
      return new NextResponse(await gzipBody(body) as BodyInit, { headers: { ...headers, "content-encoding": "gzip" } });
    }
    return new NextResponse(body, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime host is unavailable" }, { status: 503 });
  }
}
