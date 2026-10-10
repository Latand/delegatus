import { NextResponse } from "next/server";

import { acceptsGzip, gzipBody } from "@/lib/http/gzipBody";
import { statePath } from "@/lib/configDir";
import { readRuntimeHostStartupState } from "../../../../runtime-host/runtimeHostStartup";
import { isRuntimeHostTransportFailure, runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsEnabled, structuredHostsEnabled, RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import { withJsonMembers } from "@/lib/runtime/snapshotBody";
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
    const scope = summary || voiceFor ? { voiceBodiesFor: voiceFor ? [voiceFor] : [] } : undefined;
    // The request signal reaches the runtime host, so a disconnected caller
    // cancels its socket wait instead of leaving late host work behind.
    const encoded = client.snapshotBytes ? await client.snapshotBytes(request.signal, scope) : null;
    const snapshot = encoded === null ? await client.snapshot(request.signal, scope) : null;
    const viewer = { structuredHostsEnabled: structuredHostsEnabled(), structuredStartup: structuredStartupAxis() };
    /* The host already encoded the snapshot, megabytes of it. The Viewer's
       two members are appended to those bytes. Decoding the frame, parsing
       it, spreading it, and stringifying and encoding it again held the
       request thread for every one of those passes. */
    const body: Uint8Array | string = (encoded === null ? null : withJsonMembers(encoded, viewer))
      ?? JSON.stringify({ ...(snapshot ?? JSON.parse(Buffer.from(encoded!).toString("utf8")) as object), ...viewer });
    const headers = { "content-type": "application/json", "cache-control": "no-store", vary: "accept-encoding" };
    /* A cold open and every authoritative rejoin read the whole projection,
       megabytes of it; compressed it is a fifth of that on the wire (#1994). */
    if (acceptsGzip(request) && body.length >= 1024) {
      return new NextResponse(await gzipBody(body) as BodyInit, { headers: { ...headers, "content-encoding": "gzip" } });
    }
    return new NextResponse(body as BodyInit, { headers });
  } catch (error) {
    if (isRuntimeHostTransportFailure(error)) {
      const startup = readRuntimeHostStartupState(statePath("runtime-host-startup"));
      if (startup.state === "booting") {
        return NextResponse.json({ error: "runtime host is booting", code: "runtime-host-booting", journal: startup.journal }, { status: 503 });
      }
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime host is unavailable" }, { status: 503 });
  }
}
