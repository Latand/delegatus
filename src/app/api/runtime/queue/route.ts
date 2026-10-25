import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { NextRequest } from "next/server";
import { handleNativeQueue } from "@/lib/runtime/nativeQueueHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function workspaceGET(request: NextRequest) { return handleNativeQueue(request); }
function workspacePOST(request: NextRequest) { return handleNativeQueue(request); }

export const GET = workspaceRoute("/api/runtime/queue", workspaceGET);

export const POST = workspaceRoute("/api/runtime/queue", workspacePOST);
