import { workspaceRoute, requestWorkspaceScope } from "@/lib/team/workspaceRoute";
import type { NextRequest } from "next/server";

import { productionDoneWorld } from "@/lib/done/world";

import { doneAcknowledgeHandler, doneReadHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const read = doneReadHandler({ world: productionDoneWorld, now: Date.now, deferProjection: true });
const acknowledge = doneAcknowledgeHandler({ now: Date.now });

async function workspaceGET(request: NextRequest): Promise<Response> {
  const response = await read();
  const scope = requestWorkspaceScope(request);
  if (!scope || scope.owner || !response.ok) return response;
  const body = await response.json();
  return Response.json({ ...body, items: body.items.filter((item: { project: string | null }) => scope.access(item.project) !== "none") }, { headers: { "cache-control": "private, no-store" } });
}

function workspacePOST(request: NextRequest): Promise<Response> {
  return acknowledge(request);
}

export const GET = workspaceRoute("/api/attention/done", workspaceGET, true);

export const POST = workspaceRoute("/api/attention/done", workspacePOST);
