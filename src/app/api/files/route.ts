import { NextResponse } from "next/server";
import { workspaceRoute, requestWorkspaceScope } from "@/lib/team/workspaceRoute";
import { workspaceFiles } from "@/lib/team/workspaceProjection";
import { after } from "next/server";
import { GET as filesResponse } from "./operatorProjection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { HEAD as operatorHEAD } from "./operatorProjection";

async function memberFiles(request: Request): Promise<Response> {
  const scope = requestWorkspaceScope(request);
  if (!scope || scope.owner) return filesResponse(request, after);
  // Shared caches contain the operator projection. Negotiate plain JSON and
  // project it into an uncached response; a global ETag/delta never escapes.
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) if (/^(?:if-|accept-encoding|x-llv-|x-board-)/i.test(key)) headers.delete(key);
  const source = await filesResponse(new Request(request.url, { headers, signal: request.signal }), after);
  if (source.status !== 200) return NextResponse.json({ error: "board unavailable" }, { status: 503 });
  const data = await source.json();
  const latest = requestWorkspaceScope(request);
  if (!latest) return NextResponse.json({ error: "workspace access denied", code: "workspace_forbidden" }, { status: 403 });
  return NextResponse.json(workspaceFiles(latest, data), { headers: { "cache-control": "private, no-store" } });
}

export const GET = workspaceRoute("/api/files", memberFiles, true);
export const HEAD = workspaceRoute("/api/files", (request: Request) => {
  const scope = requestWorkspaceScope(request);
  return !scope || scope.owner ? operatorHEAD(request) : new NextResponse(null, { headers: { "cache-control": "private, no-store" } });
}, true);
