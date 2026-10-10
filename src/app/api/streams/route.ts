import { NextRequest } from "next/server";

import { GET as logTails } from "@/app/api/logs/stream/route";
import { GET as runtimeEvents } from "@/app/api/runtime/stream/route";
import { GET as selfUpdateEvents } from "@/app/api/self-update/events/route";
import { proxy } from "@/proxy";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { MUX_CONNECTION_ID, MUX_MAX_BODY_BYTES, parseMuxOps, type MuxStreamPath } from "@/lib/streamMux/protocol";
import { applyMuxOps, openMuxConnection } from "@/lib/streamMux/server";
import { sessionBoundStream } from "@/lib/team";

/* Every live stream of a tab over one connection (src/lib/streamMux/protocol.ts). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/* A channel is one of these routes, answered by the route's own handler: what it carries, and who may read
   it, is decided there and nowhere else. */
const routes: Record<MuxStreamPath, (request: NextRequest) => Response | Promise<Response>> = {
  "/api/logs/stream": logTails,
  "/api/runtime/stream": runtimeEvents,
  "/api/self-update/events": selfUpdateEvents,
};

/* `LLV_STREAM_MUX=0` takes the route away; a page that finds none opens each stream on its own connection. */
const off = () => process.env.LLV_STREAM_MUX === "0";
const gone = () => Response.json({ error: "stream multiplexing is off", code: "mux-off" }, { status: 404, headers: noStore });
const tooLarge = () => Response.json({ error: "payload too large" }, { status: 413, headers: noStore });

/*
 * The proxy's matcher leaves this route out (src/proxy.ts): in front of a POST, Next reads the whole body
 * before the route sees a byte of it, and this route stops reading at its limit. So the route asks the
 * proxy itself, before anything else, and asks it again for every channel, as the GET that channel stands
 * for and at the moment it opens. A control request whose body arrives slowly is then judged when it has
 * arrived, not when it started. null = pass; otherwise the proxy's own answer.
 */
function gate(request: NextRequest): Response | null {
  const answer = proxy(request);
  return answer.headers.get("x-middleware-next") === "1" ? null : answer;
}

/** The body as text, read no further than the limit; null when it is longer. */
async function readBody(request: NextRequest): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MUX_MAX_BODY_BYTES) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/* An EventSource sends its last event id UTF-8 encoded; a header value reads back one character per byte. */
const asHeader = (value: string) => String.fromCharCode(...new TextEncoder().encode(value));

export function GET(request: NextRequest): Response {
  const refused = gate(request);
  if (refused) return refused;
  if (off()) return gone();
  const id = request.nextUrl.searchParams.get("c") ?? "";
  if (!MUX_CONNECTION_ID.test(id)) return Response.json({ error: "c must name the connection" }, { status: 400, headers: noStore });
  return new Response(sessionBoundStream(request, request.signal, (signal) => openMuxConnection(id, signal)), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const refused = gate(request);
  if (refused) return refused;
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  if (off()) return gone();
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MUX_MAX_BODY_BYTES) return tooLarge();
  let body: unknown;
  try {
    const text = await readBody(request);
    if (text === null) return tooLarge();
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400, headers: noStore });
  }
  const parsed = parseMuxOps(body);
  if (!parsed) return Response.json({ error: "invalid request" }, { status: 400, headers: noStore });

  /* Each channel is read as this caller: its request carries this request's own credentials and origin,
     and nothing of its body. */
  const headers = new Headers(request.headers);
  for (const name of ["content-length", "content-type", "last-event-id", "transfer-encoding"]) headers.delete(name);
  headers.set("accept", "text/event-stream");
  const outcome = applyMuxOps(parsed.connection, parsed.ops, new URL(request.url), (url, signal, lastEventId) => {
    const route = (routes as Record<string, (typeof routes)[MuxStreamPath] | undefined>)[url.pathname];
    if (!route) return Response.json({ error: "not a stream" }, { status: 404 });
    const channelHeaders = new Headers(headers);
    if (lastEventId) channelHeaders.set("last-event-id", asHeader(lastEventId));
    const channel = new NextRequest(url, { headers: channelHeaders, signal });
    return gate(channel) ?? route(channel);
  });
  if (outcome === "unknown-connection") {
    return Response.json({ error: "unknown connection", code: "unknown-connection" }, { status: 404, headers: noStore });
  }
  return Response.json({ ok: true }, { headers: noStore });
}
