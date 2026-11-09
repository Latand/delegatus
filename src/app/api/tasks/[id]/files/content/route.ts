import type { NextRequest, NextResponse } from "next/server";

import { taskFilesDependencies } from "@/lib/taskFiles/dependencies";
import { taskFileContentGET } from "@/lib/taskFiles/http";
import { workspaceRoute } from "@/lib/team/workspaceRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskRouteContext = { params: Promise<{ id: string }> };

/** One committed file of a task's lane: its metadata (`mode=meta`) or its
    bytes, ranged, from the Git object at the lane's head. */
async function workspaceGET(req: NextRequest, context: TaskRouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  return taskFileContentGET(req, id, taskFilesDependencies());
}

export const GET = workspaceRoute("/api/tasks/[id]/files/content", workspaceGET);
