import type { NextRequest, NextResponse } from "next/server";

import { taskFilesDependencies } from "@/lib/taskFiles/dependencies";
import { taskFilesGET } from "@/lib/taskFiles/http";
import { workspaceRoute } from "@/lib/team/workspaceRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskRouteContext = { params: Promise<{ id: string }> };

/** The files a task's lanes committed, read from Git at each lane's pinned
    head (docs/design/task-file-preview.md). Lists metadata only. */
async function workspaceGET(req: NextRequest, context: TaskRouteContext): Promise<NextResponse> {
  const { id } = await context.params;
  return taskFilesGET(req, id, taskFilesDependencies());
}

export const GET = workspaceRoute("/api/tasks/[id]/files", workspaceGET);
