import { workspaceRoute, requestWorkspaceScope, workspaceConversationResolver } from "@/lib/team/workspaceRoute";
import { NextRequest } from "next/server";

import { feedPathAllowed } from "@/lib/externalRelay/feedAccess";
import { createLogTailEventStream, parseLogStreamSubs } from "@/lib/logTailStream";
import { sessionBoundStream } from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function memberGET(req: NextRequest): Promise<Response> {
  const subs = parseLogStreamSubs(req.nextUrl.searchParams.get("subs"));
  const initial = requestWorkspaceScope(req);
  const resolve = await workspaceConversationResolver();
  const feedAllowed = feedPathAllowed(req);
  const allowed = (path: string) => {
    const scope = requestWorkspaceScope(req);
    return feedAllowed(path) && (initial && !initial.owner ? Boolean(scope && scope.access(resolve(path)) !== "none") : true);
  };
  const stream = sessionBoundStream(req, req.signal, (signal) => createLogTailEventStream(subs, signal, allowed));
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

export const GET = workspaceRoute("/api/logs/stream", memberGET);
