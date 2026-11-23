import type { NextRequest } from "next/server";

import { findPipelineRecord } from "@/lib/pipelines/store";
import { loadTasksByIds } from "@/lib/tasks/store";
import { requestWorkspaceScope } from "@/lib/team/workspaceRoute";
import { realExec } from "@/lib/workflows/provision";
import { taskFilesCaches } from "./cache";
import type { TaskFilesDependencies } from "./http";

/** The production ports of the task file routes. */
export function taskFilesDependencies(): TaskFilesDependencies {
  return {
    task: (id) => loadTasksByIds(new Set([id]), undefined, 1)[0] ?? null,
    pipeline: findPipelineRecord,
    scope: (req: NextRequest) => requestWorkspaceScope(req),
    exec: realExec,
    caches: taskFilesCaches(),
  };
}
