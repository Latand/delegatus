import { NextRequest } from "next/server";

import { createLogTailEventStream, parseLogStreamSubs } from "@/lib/logTailStream";
import { sessionBoundStream } from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const subs = parseLogStreamSubs(req.nextUrl.searchParams.get("subs"));
  const stream = sessionBoundStream(req, req.signal, (signal) => createLogTailEventStream(subs, signal));
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
