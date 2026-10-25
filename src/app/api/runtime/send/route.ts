import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { NextRequest, NextResponse } from "next/server";

import { handleRuntimeAdmissionQuery, handleRuntimeCommand } from "@/lib/runtime/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function workspacePOST(request: NextRequest): Promise<NextResponse> {
  return handleRuntimeCommand(request, "send");
}

/* The read half of the same key. A caller whose POST response was lost asks
   HERE what became of its message, under the id it stamped the attempt with,
   and never by posting the send a second time. */
function workspaceGET(request: NextRequest): Promise<NextResponse> {
  return handleRuntimeAdmissionQuery(request);
}

export const POST = workspaceRoute("/api/runtime/send", workspacePOST);

export const GET = workspaceRoute("/api/runtime/send", workspaceGET);
