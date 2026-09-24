import fs from "node:fs";

import { NextRequest, NextResponse } from "next/server";

import { recordOperatorRequest } from "@/lib/activity/requestLedger";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { attachmentPath, sweepAttachments } from "@/lib/tasks/attachments";
import { loadPipelines } from "@/lib/pipelines/store";
import { projectTaskPipelineIds, type TaskPipelineReadModel } from "@/lib/pipelines/taskBinding";
import { createTask, type CreateTaskInput, type CreateTaskResult } from "@/lib/tasks/commands";
import { loadTasks, mutateTasksFile } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<{ tasks: TaskPipelineReadModel[] } | ApiError>> {
  try {
    /* Deliberately no migration here. This route serves the task LIST, which
       shows every task whatever its board flag, so it has nothing to migrate
       for — and a GET that writes surprises every caller. The board reads its
       tasks through /api/files, and that is where the one-time migration runs. */
    return NextResponse.json({ tasks: projectTaskPipelineIds(loadTasks(), loadPipelines()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "task read model unavailable" }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; task: BoardTask; notes?: string[] } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: CreateTaskInput;
  try {
    body = (await req.json()) as CreateTaskInput;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const result = mutateTasksFile<CreateTaskResult>((state) => {
    const outcome = createTask(state.tasks, body, state.recentCreates, {
      /* An attachment ref only becomes task-owned once its bytes are actually
         in the store — a stale/forged ref is rejected loudly, never dangling. */
      attachmentExists: (att) => fs.existsSync(attachmentPath(att)),
    });
    /* Persist only a fresh create; a validation failure or a replay (which left
       the list and receipts untouched) skips the rewrite. */
    const persist = outcome.ok && !outcome.replay ? { tasks: outcome.tasks, recentCreates: outcome.recentCreates } : undefined;
    return { state: persist, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  /* Best-effort GC of stale, unreferenced staged uploads. A dangling reference
     is impossible by construction: `createTask` re-checks `attachmentExists`
     inside the same synchronous `mutateTasksFile` block that persists the task,
     with no `await` before the write — so a concurrent request cannot delete a
     referenced file between the check and the persist. The sweep additionally
     reads the freshest task list (not this request's snapshot), so it never
     evaluates references against stale state. */
  sweepAttachments(loadTasks(), Date.now());
  /* A replayed create answers the same task, so its id is the key. */
  if (directOperatorActivityAuthority(req).ok) {
    recordOperatorRequest(req, { kind: "task", idempotencyKey: `task-create:${result.task.id}`, project: result.task.project });
  }
  /* An icon that names no lucide icon was clamped to none, and says so (#2102). */
  return NextResponse.json({ ok: true, task: result.task, ...(result.notes ? { notes: result.notes } : {}) });
}
