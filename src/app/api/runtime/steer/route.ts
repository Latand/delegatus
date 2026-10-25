import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { NextRequest, NextResponse } from "next/server";

import { handleRuntimeCommand } from "@/lib/runtime/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function workspacePOST(request: NextRequest): Promise<NextResponse> {
  return handleRuntimeCommand(request, "steer");
}

export const POST = workspaceRoute("/api/runtime/steer", workspacePOST);
