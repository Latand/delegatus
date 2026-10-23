import { NextResponse } from "next/server";
import { workspaceRoute, requestWorkspaceScope } from "@/lib/team/workspaceRoute";
import { createWorkspaceFilesResponder } from "@/lib/team/workspaceFilesResponse";
import { after } from "next/server";
import { GET as filesResponse } from "./operatorProjection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { HEAD as operatorHEAD } from "./operatorProjection";

const scopedFilesResponse = createWorkspaceFilesResponder(filesResponse, requestWorkspaceScope);

async function memberFiles(request: Request): Promise<Response> {
  const scope = requestWorkspaceScope(request);
  return !scope || scope.owner ? filesResponse(request, after) : scopedFilesResponse(request, scope, after);
}

export const GET = workspaceRoute("/api/files", memberFiles, true);
export const HEAD = workspaceRoute("/api/files", (request: Request) => {
  const scope = requestWorkspaceScope(request);
  return !scope || scope.owner ? operatorHEAD(request) : new NextResponse(null, { headers: { "cache-control": "private, no-store" } });
}, true);
