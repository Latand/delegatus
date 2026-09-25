import fs from "node:fs";

import { NextRequest, NextResponse } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { dismissAttention } from "@/lib/attention/dismissals";
import { headCwd } from "@/lib/agent/transcript";
import { ensureTaskPipelineForAssignment } from "@/lib/pipelines/engine";
import { loadPipelinesForProjection } from "@/lib/pipelines/store";
import type { TaskPipelineSpawnParams } from "@/lib/pipelines/taskBinding";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { applyAssignmentPatches, assignmentRefFromBody, dismissUnstartedLaunch, removeAssignment, type AssignmentPatch } from "@/lib/tasks/commands";
import { isoNow } from "@/lib/tasks/helpers";
import { loadTasks, mutateTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskRouteContext = {
  params: Promise<{ id: string }>;
};

interface AssignmentRouteDependencies {
  loadTasks: typeof loadTasks;
  mutateTasks: typeof mutateTasks;
  spawnParamsForPath(pathname: string): TaskPipelineSpawnParams | null;
  ensureTaskPipelineForAssignment: typeof ensureTaskPipelineForAssignment;
}

function spawnParamsForPath(pathname: string): TaskPipelineSpawnParams | null {
  const registry = agentRegistry();
  const conversation = registry.conversationForPath(pathname);
  const profile = registry.launchProfileForPath(pathname);
  const repoDir = profile?.cwd || headCwd(pathname);
  /* Copilot is not a task-pipeline engine yet (design slice 4). */
  if (!conversation || !repoDir || conversation.engine === "copilot") return null;
  return {
    repoDir,
    engine: conversation.engine,
    model: profile?.model ?? null,
    effort: profile?.effort ?? null,
    srcPath: pathname,
  };
}

const productionDependencies: AssignmentRouteDependencies = {
  loadTasks,
  mutateTasks,
  spawnParamsForPath,
  ensureTaskPipelineForAssignment,
};

function pathFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const path = (body as { path?: unknown }).path;
  return typeof path === "string" && path.trim().length > 0 ? path.trim() : null;
}

/**
 * Records a handoff link: the task text was routed into this agent's composer,
 * nothing was delivered. The assignment is a removable marker of where the
 * task went — never a claim that the agent received or ran it.
 */
async function postAssignment(
  req: NextRequest,
  ctx: TaskRouteContext,
  dependencies: AssignmentRouteDependencies = productionDependencies,
): Promise<NextResponse<{ ok: true; task: BoardTask } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const path = pathFromBody(body);
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });

  const { id } = await ctx.params;
  const task = dependencies.loadTasks().find((candidate) => candidate.id === id);
  if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const existingAssignment = task.assignments.some((assignment) => assignment.path === path);
  if (!existingAssignment) {
    const spawnParams = dependencies.spawnParamsForPath(path);
    if (!spawnParams) return NextResponse.json({ error: "assignment path does not resolve to an agent profile" }, { status: 400 });
    const binding = await dependencies.ensureTaskPipelineForAssignment(task, spawnParams);
    if (!binding.pipeline) {
      return NextResponse.json({ error: binding.error ?? "could not bind task to a pipeline" }, { status: binding.status ?? 400 });
    }
  }
  const at = isoNow();
  const patch: AssignmentPatch = { path, panePid: null, state: "handoff", error: null, at };
  const result = dependencies.mutateTasks((tasks) => {
    const outcome = applyAssignmentPatches(tasks, id, [patch], at);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, task: result.task });
}

export const POST = Object.assign(
  async (req: NextRequest, ctx: TaskRouteContext): Promise<NextResponse<{ ok: true; task: BoardTask } | ApiError>> => await postAssignment(req, ctx),
  { withDependencies: postAssignment },
);

/** Detaches one assignment from the task — the undo for a wrong handoff. */
export async function DELETE(req: NextRequest, ctx: TaskRouteContext): Promise<NextResponse<{ ok: true; task: BoardTask } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const ref = assignmentRefFromBody(body);
  if (!ref) return NextResponse.json({ error: "launchId, path, conversationId or panePid is required" }, { status: 400 });

  const { id } = await ctx.params;
  const result = mutateTasks((tasks) => {
    const outcome = removeAssignment(tasks, id, ref);
    return { tasks: outcome.ok ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, task: result.task });
}

interface DismissRouteDependencies {
  mutateTasks: typeof mutateTasks;
  /** Whether the launch's conversation has a transcript on disk after all. */
  transcriptExists(ref: { launchId?: string | null; conversationId?: string | null }): boolean;
  linkedPipeline(taskId: string): boolean;
  /** Clears the Needs-you item a failed launch raised (#2170): dismissing the
      launch on its card answers it there too. */
  clearAttention?(ref: { launchId?: string | null; conversationId?: string | null }): Promise<void>;
}

async function clearLaunchAttention(ref: { launchId?: string | null; conversationId?: string | null }): Promise<void> {
  try {
    await dismissAttention({
      kind: "conversation",
      ...(ref.conversationId ? { conversationId: ref.conversationId } : {}),
      /* The launch's placeholder path, for a conversation the registry never
         recorded: the overlay reads a record by that path too. */
      ...(ref.launchId ? { path: `spawn:${ref.launchId}` } : {}),
    }, { kind: "operator" });
  } catch {
    /* The launch is dismissed on its task either way; a Needs-you record this
       write could not reach is cleared from the queue by hand. */
  }
}

function launchTranscriptExists(ref: { launchId?: string | null; conversationId?: string | null }): boolean {
  try {
    /* Every launch row records the conversation it reserved; a row with a
       launch id alone predates that and proves nothing here. */
    const conversationId = ref.conversationId ?? null;
    if (!conversationId) return false;
    const conversation = agentRegistry().conversation(conversationId as `conversation_${string}`);
    return Boolean(conversation?.generations.some((generation) => generation.path && fs.existsSync(generation.path)));
  } catch {
    /* An unreadable registry proves nothing either way; the card offered the
       dismiss because the board found no transcript. */
    return false;
  }
}

const dismissDependencies: DismissRouteDependencies = {
  mutateTasks,
  transcriptExists: launchTranscriptExists,
  clearAttention: clearLaunchAttention,
  linkedPipeline: (taskId) => {
    try {
      return loadPipelinesForProjection().some((pipeline) => pipeline.taskIds.includes(taskId));
    } catch {
      return true;
    }
  },
};

/**
 * Dismisses a launch that never produced a transcript (`{ launchId,
 * conversationId, dismiss: "launch-did-not-start" }`). The assignment is kept
 * and marked failed; a launch whose conversation turns out to have a
 * transcript is refused, since that one opens.
 */
async function patchAssignment(
  req: NextRequest,
  ctx: TaskRouteContext,
  dependencies: DismissRouteDependencies = dismissDependencies,
): Promise<NextResponse<{ ok: true; task: BoardTask } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || (body as { dismiss?: unknown }).dismiss !== "launch-did-not-start") {
    return NextResponse.json({ error: "dismiss must be \"launch-did-not-start\"" }, { status: 400 });
  }
  const ref = assignmentRefFromBody(body);
  if (!ref || (ref.launchId == null && ref.conversationId == null)) return NextResponse.json({ error: "launchId or conversationId is required" }, { status: 400 });
  if (dependencies.transcriptExists(ref)) return NextResponse.json({ error: "this launch has a transcript; open it instead" }, { status: 409 });
  const { id } = await ctx.params;
  const linkedPipeline = dependencies.linkedPipeline(id);
  const result = dependencies.mutateTasks((tasks) => {
    const outcome = dismissUnstartedLaunch(tasks, id, ref, isoNow(), { linkedPipeline });
    return { tasks: outcome.ok && outcome.tasks !== tasks ? outcome.tasks : undefined, result: outcome };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  await dependencies.clearAttention?.(ref);
  return NextResponse.json({ ok: true, task: result.task });
}

export const PATCH = Object.assign(
  async (req: NextRequest, ctx: TaskRouteContext): Promise<NextResponse<{ ok: true; task: BoardTask } | ApiError>> => await patchAssignment(req, ctx),
  { withDependencies: patchAssignment },
);
