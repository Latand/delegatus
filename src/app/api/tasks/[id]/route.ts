import { NextRequest, NextResponse } from "next/server";

import { recordOperatorRequest } from "@/lib/activity/requestLedger";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { recordTeamEvent, refuseAnonymous, teamActor } from "@/lib/team";
import { LINE_EDIT_KEYS } from "@/lib/lineEdits";
import { deleteTask, patchTask, type PatchTaskInput } from "@/lib/tasks/commands";
import { taskWorkLinkContext, taskWorkLinks } from "@/lib/forge/resolve";
import type { ResolvedWorkLinks } from "@/lib/forge/workLinks";
import { loadPipelines } from "@/lib/pipelines/store";
import { taskSeatHolding } from "@/lib/tasks/seatHolding";
import { taskRevision } from "@/lib/tasks/revision";
import { mutateTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TASK_REQUEST_FIELDS = ["text", "details", "status"] as const;
/* What the team audit names as a change to a task (§7.3): its words, where it
   stands, and whether it is on the board. Placement and decoration are not. */
const TEAM_TASK_FIELDS = ["text", "details", "status", "hide", "board", "priority", "dueAt"] as const;

type TaskRouteContext = {
  params: Promise<{ id: string }>;
};

/** What a line edit to `details` answers (#1845): the task's new revision and
    the length of the field, never the field, which the caller did not send.
    Clamp notes and resolved links still travel, as they do on any other edit. */
type LineEditAnswer = { ok: true; taskId: string; revision: string; detailsLength: number; updatedAt: string; workLinks?: ResolvedWorkLinks; notes?: string[] };

export async function PATCH(
  req: NextRequest,
  ctx: TaskRouteContext,
): Promise<NextResponse<{ ok: true; task: BoardTask; workLinks?: ResolvedWorkLinks; notes?: string[] } | LineEditAnswer | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: PatchTaskInput;
  try {
    body = (await req.json()) as PatchTaskInput;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  /* Who changed it (sign-in-and-team §7.3): a person needs a member in team mode. */
  const actor = teamActor(req);
  const anonymous = refuseAnonymous(actor);
  if (anonymous) return anonymous;

  const { id } = await ctx.params;
  const before: { status: string | null } = { status: null };
  const result = mutateTasks((tasks) => {
    before.status = tasks.find((task) => task.id === id)?.status ?? null;
    /* The dashboard is the operator; a group hide is refused for the task
       holding the project's orchestrator seat. */
    const outcome = patchTask(tasks, id, body, undefined, { actor: "operator", seatHolding: taskSeatHolding, workLinks: taskWorkLinkContext(loadPipelines) });
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  /* The refusal's code and field travel with it, as they do over MCP, so a
     protected seat, a stale revision and a bad value are told apart by code. */
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.field ? { field: result.field } : {}) },
      { status: result.status },
    );
  }
  /* An edit of what the task says or where it stands instructs its agents; a
     move, a colour, an icon, a link or a hide does not, and is not recorded. */
  if (TASK_REQUEST_FIELDS.some((field) => Object.hasOwn(body, field)) && directOperatorActivityAuthority(req).ok) {
    recordOperatorRequest(req, { kind: "task", project: result.task.project });
  }
  const changedFields = TEAM_TASK_FIELDS.filter((field) => Object.hasOwn(body, field));
  if (changedFields.length) {
    const statusMoved = Object.hasOwn(body, "status") && before.status !== result.task.status;
    recordTeamEvent({
      actor,
      action: "task.changed",
      project: result.task.project,
      subject: { kind: "task", id: result.task.id, title: result.task.text.split("\n")[0] ?? null },
      detail: {
        fields: changedFields.join(","),
        ...(statusMoved ? { from: before.status, to: result.task.status } : {}),
      },
    });
  }
  /* #2059: the card redraws its links from this answer, not the next poll. */
  const links = Object.hasOwn(body, "attachLinks") || Object.hasOwn(body, "detachLinks") ? taskWorkLinks(result.task, loadPipelines()) : null;
  const extras = { ...(links ? { workLinks: links } : {}), ...(result.notes ? { notes: result.notes } : {}) };
  if (LINE_EDIT_KEYS.some((key) => Object.hasOwn(body, key))) {
    return NextResponse.json({ ok: true, taskId: result.task.id, revision: taskRevision(result.task), detailsLength: result.task.details?.length ?? 0, updatedAt: result.task.updatedAt, ...extras });
  }
  return NextResponse.json({ ok: true, task: result.task, ...extras });
}

export async function DELETE(_req: NextRequest, ctx: TaskRouteContext): Promise<NextResponse<{ ok: true } | ApiError>> {
  const rejection = rejectCrossOrigin(_req);
  if (rejection) return rejection;

  const { id } = await ctx.params;
  const result = mutateTasks((tasks) => {
    const outcome = deleteTask(tasks, id);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
