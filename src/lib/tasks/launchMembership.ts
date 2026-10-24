import { proactiveConversationTaskIds, proactiveExecutionError } from "./proactiveExecution";
import { AccountCommitBusyError } from "@/lib/accounts/accountMutationContext";
import { stateLockDeferral } from "@/lib/state/lockWait";
import { appendLifecycleEvents } from "@/lib/lifecycle/journal";
import { operatorSafeSummary } from "@/lib/lifecycle/vocabulary";
import { canonicalProject } from "@/lib/projects/aliases";
import { recordSpawnNoticeObligation } from "@/lib/spawnNotice/store";
import { loadPipelinesForProjection } from "@/lib/pipelines/store";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { orchestratorSeatForOrUnknown, readOrchestratorSeatFileOrNull } from "@/lib/orchestrator/seats";

import { firstRunsElsewhere } from "@/lib/links/linked";
import { cleanTitle, durableSemanticTitle, firstMeaningfulPromptLine } from "@/lib/title";

import { loadTasks, taskSelectionSource } from "./store";
import { commitFailedLaunchMembership, commitTaskMembership, type FailedLaunchIdentity, type FailedLaunchTaskMove, type MembershipAdmission, type MembershipIdentity, type MembershipInput, type MembershipResult } from "./membership";
import { freshLaunchFailure, type LaunchFailureReporting } from "./launchFailureReporting";

/**
 * Task membership at the shared launch boundary (#1586).
 *
 * Every Viewer launch — operator drafts, agent-initiated spawns, pipeline
 * stages, review-flow rounds, the raw runtime transport — reserves its durable
 * launch receipt through `AgentRegistry.beginSpawnRequest` before anything is
 * actuated, and every caller has finished its own admission checks by then.
 * The registry calls {@link admitReservedLaunch} right after the receipt exists:
 * the launch's task membership is committed with the reserved launch and
 * conversation identity in one task-file transaction. A membership the store
 * cannot record fails the receipt and aborts the launch, so no agent ever
 * starts outside every task.
 *
 * A receipt that was reserved and later recovered for its first execution (a
 * queued pinned launch whose account became admissible) passes the same
 * prerequisite again through {@link admitRecoveredLaunch} before actuation: a
 * membership recorded at reservation converges, one that never was (a receipt
 * older than this rule, a task deleted while queued) is recorded now, and an
 * unavailable store keeps the launch from executing.
 */

export interface ReservedLaunch {
  engine: string;
  /** The launch directory, when the launch records one. A conversation the
      Viewer adopted rather than spawned carries an empty durable profile, so a
      resume successor reaches this reservation naming no directory at all. */
  cwd: string | undefined;
  clientAttemptId?: string | null;
  explicitProject?: string | null;
  launchProfile?: { title?: string | null } | null;
  launchDisplay?: { prompt: string } | null;
  origin?: { kind: string; container?: string; containerId?: string } | null;
  purpose?: string | null;
  /** The launch's role. An orchestrator seat never names its own task, so its
      task is created under the launch title (#1841 keeps the seat's notes
      there, off the board). */
  role?: string | null;
  /** Explicit task targets of a task-local launch (a band's «+ Agent», the
      dedicated task spawn route). All must exist; none is created. */
  taskIds?: readonly string[] | null;
  /** The conversation a reviewer launch reviews; the reviewer joins its tasks. */
  reviewsConversationId?: string | null;
  /** The conversation that initiated an agent-initiated launch; the child
      joins its tasks, as the board draws it under the parent. */
  parentConversationId?: string | null;
  parentArtifactPath?: string | null;
}

export interface ReservedReceipt {
  launchId: string;
  conversationId: string;
  launchProfile?: { title?: string | null } | null;
  launchDisplay?: { prompt: string } | null;
}

export class LaunchMembershipError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "LaunchMembershipError";
  }
}

/** M.4 seam 2: no agent process starts here for a task another machine runs. */
const proactiveAdmission: MembershipAdmission = (tasks) => {
  const proactive = proactiveExecutionError(tasks);
  return proactive ? { error: proactive, status: 403, code: "PROACTIVE_EXECUTION_FENCED" } : null;
};

export const launchAdmission: MembershipAdmission = (tasks) => {
  const proactive = proactiveAdmission(tasks);
  if (proactive) return proactive;
  const refusal = firstRunsElsewhere(tasks);
  return refusal ? { error: refusal.error, status: refusal.status, code: refusal.code } : null;
};

const engineOf = (engine: string): "claude" | "codex" | null => (engine === "claude" || engine === "codex" ? engine : null);

export interface PipelineLaunchContext {
  taskIds: readonly string[];
  brief?: string | null;
}

function oneLineDescription(brief: string | null | undefined): string {
  const line = firstMeaningfulPromptLine(brief, 240) || "";
  return cleanTitle(line.split(/(?<=[.!?])\s/, 1)[0] ?? "", 240);
}

/** The membership a reserved launch commits: its explicit tasks, the tasks of a
    bound pipeline, the tasks of the work a reviewer reviews or a child's
    parent does, a fallback task per task-less container, or one placeholder
    keyed by the client attempt (or the launch id for keyless launches). */
export function launchMembershipInput(
  launch: ReservedLaunch,
  receipt: ReservedReceipt,
  pipelineContext: (pipelineId: string) => PipelineLaunchContext | null,
  projectForCwd: (cwd: string) => string | null,
  seatIdentity?: (project: string) => MembershipIdentity | null,
): MembershipInput {
  const identity = { launchId: receipt.launchId, conversationId: receipt.conversationId, clientAttemptId: launch.clientAttemptId ?? null, engine: engineOf(launch.engine) };
  const project = launch.explicitProject?.trim() || projectForCwd(launch.cwd ?? "") || "other";
  const lines = (launch.launchProfile?.title ?? receipt.launchProfile?.title)?.trim().split(/\r?\n/) ?? [];
  const prompt = launch.launchDisplay?.prompt ?? receipt.launchDisplay?.prompt;
  const title = durableSemanticTitle(lines[0], 80) || firstMeaningfulPromptLine(prompt, 80);
  /* The display prompt is the launcher's brief; echo is the composed role
     scaffold and is deliberately never used for the card. */
  const description = oneLineDescription(lines.slice(1).join(" ").trim() || prompt);
  const text = { title, ...(description ? { description } : {}), ...(title ? { titled: true } : {}) };
  const launchOrigin = { kind: "launch" as const, key: launch.clientAttemptId ?? receipt.launchId };
  const explicit = (launch.taskIds ?? []).filter((id) => id.trim());
  /* Explicit targets carry their own project: the operator chose the task, and
     the launch directory (a worktree, a scratch checkout) may derive another. */
  if (explicit.length) return { project: "", origin: launchOrigin, ...text, identity, explicitTaskIds: explicit };
  /* A reviewer belongs to the work it reviews, a child to the work its parent
     does: their recorded membership is the launch's task context. */
  const reviewed: MembershipIdentity[] = [];
  for (const conversationId of [launch.reviewsConversationId, launch.parentConversationId]) {
    if (conversationId && !reviewed.some((identity) => identity.conversationId === conversationId)) {
      reviewed.push({ conversationId, path: conversationId === launch.parentConversationId ? launch.parentArtifactPath ?? null : null });
    }
  }
  /* Rotation keeps the seat's work on its existing card. This is task
     membership only: making the incumbent a launch parent would change the
     successor's delegation depth and connector grants. */
  if (launch.role === "orchestrator") {
    const incumbent = seatIdentity?.(project);
    if (incumbent) reviewed.push(incumbent);
  }
  if (launch.origin?.kind === "container" && launch.origin.containerId) {
    const containerId = launch.origin.containerId;
    if (launch.origin.container === "pipeline") {
      /* Task targets and the human brief come from the same pipeline snapshot,
         including a stage whose adapter supplies only its title. */
      const pipeline = pipelineContext(containerId);
      const taskIds = (pipeline?.taskIds ?? []).filter((id) => id.trim());
      const pipelineDescription = description || oneLineDescription(pipeline?.brief);
      const pipelineText = { ...text, ...(pipelineDescription ? { description: pipelineDescription } : {}) };
      if (taskIds.length) return { project, origin: launchOrigin, ...pipelineText, identity, explicitTaskIds: taskIds, fallbackOrigin: { kind: "pipeline", key: containerId } };
      return { project, origin: { kind: "pipeline", key: containerId }, ...pipelineText, identity, ...(reviewed.length ? { inherit: reviewed } : {}) };
    }
    return { project, origin: { kind: "flow", key: containerId }, ...text, identity, inherit: reviewed };
  }
  return { project, origin: launchOrigin, ...text, identity, ...(reviewed.length ? { inherit: reviewed } : {}) };
}

export interface LaunchMembershipPorts {
  commit: (input: MembershipInput) => MembershipResult;
  pipelineContext: (pipelineId: string) => PipelineLaunchContext | null;
  projectForCwd: (cwd: string) => string | null;
  seatIdentity?: (project: string) => MembershipIdentity | null;
  retainedTaskIds?: (conversationIds: readonly string[]) => string[];
}

export const productionLaunchMembershipPorts: LaunchMembershipPorts = {
  commit: (input) => commitTaskMembership(input),
  retainedTaskIds: proactiveConversationTaskIds,
  pipelineContext: (pipelineId) => {
    const pipeline = loadPipelinesForProjection().find((pipeline) => pipeline.id === pipelineId);
    return pipeline ? { taskIds: pipeline.taskIds, brief: pipeline.spec?.trim() || pipeline.task } : null;
  },
  projectForCwd: (cwd) => projectInfoFromCwd(cwd)?.project ?? null,
  seatIdentity: (project) => {
    const seat = orchestratorSeatForOrUnknown(project);
    if (!seat) throw new Error("orchestrator task owner could not be read");
    return seat.active?.conversationId ? { conversationId: seat.active.conversationId, path: seat.active.path } : null;
  },
};

/**
 * Commit the membership of a launch whose receipt was just reserved. A resume
 * successor keeps its conversation's existing membership (the identity resolves
 * to the held assignment, minting nothing). On failure `fail` retires the
 * receipt and the error propagates to the launching caller.
 */
export function admitReservedLaunch(
  launch: ReservedLaunch,
  receipt: ReservedReceipt,
  fail: (reason: string) => void,
  ports: LaunchMembershipPorts = productionLaunchMembershipPorts,
): MembershipResult {
  let result: MembershipResult;
  try {
    const identities = [...new Set([launch.parentConversationId, launch.reviewsConversationId, receipt.conversationId]
      .filter((id): id is string => !!id))].map(conversationId => ({ conversationId }));
    const taskIds = ports.retainedTaskIds?.(identities.map(identity => identity.conversationId)) ?? [];
    const input: MembershipInput = { ...launchMembershipInput(launch, receipt, ports.pipelineContext, ports.projectForCwd, ports.seatIdentity),
      admit: launchAdmission, admitRelated: { identities, ...(taskIds.length ? { taskIds } : {}), admit: proactiveAdmission } };
    result = ports.commit(input);
    // Receipt-owned targets survive detaching the visible assignment. Carry
    // them into this launch so its dispatch, descendants and recovery stay fenced.
    if (result.ok && taskIds.length) result = { ...result, taskIds: [...new Set([...result.taskIds, ...taskIds])] };
  } catch (error) {
    if (error instanceof AccountCommitBusyError || stateLockDeferral(error)) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "SQLITE_BUSY" || /\bSQLITE_BUSY\b|database is (?:locked|busy)/i.test(message)) {
      /* The receipt reservation is durable, while the task-store transaction
         did not commit. Keep that reservation available to the same request
         key so the caller's bounded retry can repeat membership admission. */
      throw new LaunchMembershipError(message, 503, "SQLITE_BUSY");
    }
    const reason = `task membership could not be recorded: ${error instanceof Error ? error.message : String(error)}`;
    fail(reason);
    throw new LaunchMembershipError(reason, 503);
  }
  if (!result.ok) {
    fail(result.error);
    throw new LaunchMembershipError(result.error, result.status, result.code);
  }
  return result;
}

/** The durable receipt fields the membership prerequisite reads when a
    reserved launch is recovered for its first execution. */
export interface RecoverableReceipt extends ReservedReceipt {
  engine: string;
  /** Absent for the same reason as {@link ReservedLaunch.cwd}: the reservation
      recorded whatever directory the launch named, which may be none. */
  cwd: string | undefined;
  clientAttemptId: string | null;
  explicitProject: string | null;
  launchProfile: { title?: string | null };
  launchDisplay: { prompt: string } | null;
}

/**
 * Re-establish the membership prerequisite for a receipt about to execute for
 * the first time after its reservation. The receipt carries no task targets
 * (they were validated and committed under its attempt key at reservation), so
 * this resolves by that key, then by the conversation, and mints a placeholder
 * only for a launch that has none. Throws {@link LaunchMembershipError} when
 * the store refuses or is unavailable; the caller keeps the launch from
 * executing.
 */
export function admitRecoveredLaunch(receipt: RecoverableReceipt, ports: LaunchMembershipPorts = productionLaunchMembershipPorts): MembershipResult {
  const launch: ReservedLaunch = {
    engine: receipt.engine,
    cwd: receipt.cwd,
    clientAttemptId: receipt.clientAttemptId,
    explicitProject: receipt.explicitProject,
    launchProfile: receipt.launchProfile,
    launchDisplay: receipt.launchDisplay,
  };
  return admitReservedLaunch(launch, receipt, () => undefined, ports);
}

/** The receipt fields a failed launch's settlement reads. */
export interface FailedLaunchReceipt {
  launchId: string;
  conversationId: string;
  clientAttemptId: string | null;
  purpose: string;
  artifactLifecycle: string;
  error: string | null;
  launcher?: { conversationId: string; notify: boolean } | null;
  rejection?: unknown;
  agentRole?: string | null;
  launchProfile?: { title?: string | null };
  cwd?: string;
  explicitProject?: string | null;
  createdAt?: string;
  failureAnnouncementSuppressed?: true;
  failureReporting?: LaunchFailureReporting;
}

/**
 * The task side of a launch that failed (#2170): the membership admission
 * committed before anything ran is settled, restoring the task status when
 * linking moved it. Only a fresh launch that never wrote a
 * transcript qualifies — a resume or migration successor continues a
 * conversation whose membership predates it and stays exactly as it was.
 *
 * The receipt has already failed when this runs, and that is the fact the
 * launching caller reports; a task store that cannot take this write costs the
 * board a stale column; the receipt remains failed. Launcher reports and
 * lifecycle events use separate idempotent writes so one failed write cannot
 * suppress the other. Refusals before acceptance silence these reports.
 */
export function settleFailedLaunch(
  receipt: FailedLaunchReceipt,
  commit: (launch: FailedLaunchIdentity) => FailedLaunchTaskMove[] = commitFailedLaunchMembership,
  options: {
    announce?: boolean;
    launcherProject?: string | null;
    appendLifecycleEvents?: typeof appendLifecycleEvents;
    recordSpawnNoticeObligation?: typeof recordSpawnNoticeObligation;
    now?: number;
    onProgress?: (progress: { lifecycle: boolean; notice: boolean; task: boolean; suppressed: boolean }) => void;
  } = {},
): boolean {
  const progress = { lifecycle: receipt.failureReporting?.lifecycle ?? false, notice: receipt.failureReporting?.notice ?? false,
    task: receipt.failureReporting?.task ?? false, suppressed: false };
  if (receipt.purpose !== "launch" || receipt.artifactLifecycle !== "pending") {
    options.onProgress?.({ lifecycle: true, notice: true, task: true, suppressed: true });
    return false;
  }
  let moves: FailedLaunchTaskMove[] = [];
  let taskCommitAvailable = true;
  let taskStateKnown = false;
  let tasksSettled = false;
  try {
    const taskSource = taskSelectionSource();
    tasksSettled = (receipt.failureReporting?.taskIds ?? []).some(id => {
      const task = taskSource?.read(id);
      return !task || task.status === "done";
    });
    taskStateKnown = true;
    if (!progress.task) moves = commit({
      launchId: receipt.launchId,
      conversationId: receipt.conversationId,
      clientAttemptId: receipt.clientAttemptId,
      error: receipt.error,
    });
    progress.task = true;
  } catch (error) {
    taskCommitAvailable = false;
    console.warn(`[tasks] failed launch ${receipt.launchId} left its task unsettled: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (moves.length === 0 && taskCommitAvailable) {
    /* A report retry runs after the task transaction may already have
       committed. Rebuild its task list from the failed assignment rows so a
       notice refused on the first pass still names the work it affected. */
    try {
      const source = taskSelectionSource();
      const tasks = receipt.failureReporting?.taskIds
        ? receipt.failureReporting.taskIds.flatMap(id => { const task = source?.read(id); return task ? [task] : []; })
        : loadTasks();
      moves = tasks.flatMap(task => {
        if (task.status === "done" && task.assignments.some(row => row.launchId === receipt.launchId)) tasksSettled = true;
        return task.assignments.some(assignment =>
          assignment.launchId === receipt.launchId
          && assignment.state === "failed"
          && (!assignment.conversationId || assignment.conversationId === receipt.conversationId)
          && assignment.error === (receipt.error?.trim() || "launch failed"))
        ? [{ taskId: task.id, from: task.assignments.find(assignment => assignment.launchId === receipt.launchId)?.statusBeforeLink ?? task.status, to: task.status }]
        : [];
      });
    } catch (error) {
      console.warn(`[tasks] failed launch ${receipt.launchId} task report lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const launcher = receipt.launcher;
  let eligible = options.announce !== false && !receipt.rejection && !receipt.failureAnnouncementSuppressed
    && freshLaunchFailure(receipt.failureReporting?.failedAt ?? null, options.now)
    && Boolean(launcher && launcher.conversationId !== receipt.conversationId);
  try {
    if (eligible) {
      if (!taskStateKnown) throw new Error("task state is unreadable");
      const seats = readOrchestratorSeatFileOrNull();
      if (!seats) throw new Error("orchestrator seat state is unreadable");
      if (launcher && !Object.values(seats.seats).some(seat => seat.conversationId === launcher.conversationId)
        && seats.revocations.some(row => row.conversationId === launcher.conversationId)) eligible = false;
    }
    if (tasksSettled || moves.some(move => move.to === "done")) eligible = false;
  } catch (error) {
    console.warn(`[spawn] failed launch ${receipt.launchId} announcement eligibility unavailable: ${error instanceof Error ? error.message : String(error)}`);
    options.onProgress?.(progress);
    return moves.length > 0;
  }
  if (!eligible) {
    progress.lifecycle = true;
    progress.notice = true;
    progress.suppressed = true;
  }
  if (eligible && launcher) {
    const at = receipt.failureReporting!.failedAt!;
    const title = receipt.launchProfile?.title?.trim() || "spawned agent";
    const reason = receipt.error?.trim() || "launch failed";
    try {
      const project = options.launcherProject || receipt.explicitProject || productionLaunchMembershipPorts.projectForCwd(receipt.cwd ?? "")
        || loadTasks().find(task => task.assignments.some(row => row.launchId === receipt.launchId))?.project;
      if (!progress.lifecycle) (options.appendLifecycleEvents ?? appendLifecycleEvents)([{ key: `spawn:${receipt.launchId}:failed`, type: "spawn_failed", at,
        project: project ? canonicalProject(project) : null, conversationId: receipt.conversationId, role: receipt.agentRole,
        summary: `${operatorSafeSummary(title, 45)}: ${operatorSafeSummary(reason, 70)}; agent ${receipt.conversationId}; launch ${receipt.launchId}; launcher ${launcher.conversationId}; ${moves.map(task => `task ${task.taskId}: ${task.from} → ${task.to}`).join("; ")}`,
      }]);
      progress.lifecycle = true;
    } catch (error) {
      console.warn(`[spawn] failed launch ${receipt.launchId} lifecycle report failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (!progress.notice) (options.recordSpawnNoticeObligation ?? recordSpawnNoticeObligation)({ childConversationId: receipt.conversationId, turnId: `launch:${receipt.launchId}`,
        launcherConversationId: launcher.conversationId, outcome: "lost", startedAt: receipt.createdAt ?? null, endedAt: at,
        lost: { launchId: receipt.launchId, title, reason, tasks: moves },
      });
      progress.notice = true;
    } catch (error) {
      console.warn(`[spawn] failed launch ${receipt.launchId} launcher report failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  options.onProgress?.(progress);
  return moves.length > 0;
}
