import { HANDOFF_DIGEST_TITLE_PREFIX, isProbePrompt } from "./internalConversations";
import type { BoardTask } from "./types";

/**
 * Settling the placeholder tasks that were left waiting for a name (the
 * «Untitled task» backlog). The sources are closed elsewhere; this decides,
 * for the tasks already in the store, which ones nothing will ever name or
 * work on, so a maintenance run can mark them done.
 *
 * A task is settled when it is still open, still waits for its first name
 * (no agent refinement and no operator edit), belongs to no pipeline, and
 * every conversation it holds has ended — or when it is one of the two
 * placeholders a leaked test fixture left behind. Nothing is ever deleted:
 * deleting a task mints a replacement placeholder for each conversation it
 * held, which is the very card this removes.
 */

/** The title the legacy spawn fixture gives every launch it reserves. */
export const LEGACY_FIXTURE_TITLE = "Exercise legacy spawn fixture";

/** What a task is, for the report. */
export type GhostKind =
  | "fixture"
  | "handoff-digest"
  | "probe"
  | "orchestrator"
  | "launch-not-started"
  | "launch"
  | "conversation";

/** Why an open, unnamed task is kept. */
export type GhostKeepReason = "pipeline" | "operator-edit" | "container" | "active-seat" | "still-running";

export interface GhostTranscript {
  /** Last write, epoch ms; null when the file does not exist. */
  mtimeMs: number | null;
}

export interface GhostSettlementInput {
  tasks: readonly BoardTask[];
  /** Task ids some pipeline names in its `taskIds`. */
  pipelineTaskIds: ReadonlySet<string>;
  /** Conversation ids and transcript paths of every active or pending
      orchestrator seat. A seat's workers join its task, so it stays open
      however quiet the seat has been. */
  seatIdentities: ReadonlySet<string>;
  /** What is on disk behind an assignment's transcript path. */
  transcript: (path: string) => GhostTranscript;
  nowMs: number;
  /** How long a conversation must have been quiet to count as ended. */
  idleMs: number;
}

export interface GhostDecision {
  taskId: string;
  project: string;
  kind: GhostKind;
  settle: boolean;
  reason: GhostKeepReason | null;
}

export interface GhostSettlementPlan {
  decisions: GhostDecision[];
  /** Tasks to mark done, per project and kind. */
  settle: Record<string, Partial<Record<GhostKind, number>>>;
  /** Unnamed tasks that stay, per reason. */
  kept: Partial<Record<GhostKeepReason, number>>;
  totals: { examined: number; settle: number; kept: number };
}

const firstLine = (text: string) => (text.split(/\r?\n/, 1)[0] ?? "").trim();

export function ghostKind(task: BoardTask): GhostKind {
  const title = firstLine(task.text);
  if (title === LEGACY_FIXTURE_TITLE) return "fixture";
  if (title.startsWith(HANDOFF_DIGEST_TITLE_PREFIX)) return "handoff-digest";
  if (isProbePrompt(title)) return "probe";
  if (/^orchestrator\s·/i.test(title)) return "orchestrator";
  const live = task.assignments.filter((assignment) => assignment.state !== "failed");
  if (task.origin?.kind === "launch") {
    return live.every((assignment) => !assignment.path || assignment.path.startsWith("spawn:")) ? "launch-not-started" : "launch";
  }
  return "conversation";
}

/** Anything a person wrote onto the task besides its status: a name, notes,
    a label, an icon, a deadline, a link. */
function operatorTouched(task: BoardTask): boolean {
  return task.origin?.refinement !== "pending"
    || Boolean(task.details?.trim())
    || Boolean(task.color)
    || Boolean(task.icon)
    || Boolean(task.dueAt)
    || Boolean(task.workLinks?.length);
}

function ended(task: BoardTask, input: GhostSettlementInput): boolean {
  const quietSince = input.nowMs - input.idleMs;
  return task.assignments
    .filter((assignment) => assignment.state !== "failed")
    .every((assignment) => {
      const at = Date.parse(assignment.at);
      if (Number.isFinite(at) && at > quietSince) return false;
      if (!assignment.path || assignment.path.startsWith("spawn:")) return true;
      const { mtimeMs } = input.transcript(assignment.path);
      return mtimeMs === null || mtimeMs <= quietSince;
    });
}

export function planGhostSettlement(input: GhostSettlementInput): GhostSettlementPlan {
  const decisions: GhostDecision[] = [];
  for (const task of input.tasks) {
    if (task.status === "done" || !task.origin || task.origin.refinement !== "pending") continue;
    const kind = ghostKind(task);
    const decide = (reason: GhostKeepReason | null) => decisions.push({ taskId: task.id, project: task.project, kind, settle: reason === null, reason });
    /* The leaked fixture's placeholders never had a conversation at all. */
    if (kind === "fixture" && !input.pipelineTaskIds.has(task.id)) {
      decide(null);
      continue;
    }
    if (task.origin.kind === "pipeline" || task.origin.kind === "flow") decide("container");
    else if (input.pipelineTaskIds.has(task.id)) decide("pipeline");
    else if (operatorTouched(task)) decide("operator-edit");
    else if (task.assignments.some((assignment) => assignment.state !== "failed"
      && ((assignment.conversationId && input.seatIdentities.has(assignment.conversationId)) || (assignment.path && input.seatIdentities.has(assignment.path))))) decide("active-seat");
    else if (!ended(task, input)) decide("still-running");
    else decide(null);
  }
  const settle: GhostSettlementPlan["settle"] = {};
  const kept: GhostSettlementPlan["kept"] = {};
  for (const decision of decisions) {
    if (decision.settle) {
      const byKind = (settle[decision.project] ??= {});
      byKind[decision.kind] = (byKind[decision.kind] ?? 0) + 1;
    } else if (decision.reason) {
      kept[decision.reason] = (kept[decision.reason] ?? 0) + 1;
    }
  }
  const settling = decisions.filter((decision) => decision.settle).length;
  return { decisions, settle, kept, totals: { examined: decisions.length, settle: settling, kept: decisions.length - settling } };
}

/**
 * Mark the planned tasks done over a fresh snapshot. A task that changed since
 * the plan — named, edited, closed or given a pipeline — is left alone; the
 * decision is taken again against what the store holds now.
 */
export function applyGhostSettlement(
  tasks: readonly BoardTask[],
  plan: GhostSettlementPlan,
  input: Omit<GhostSettlementInput, "tasks">,
  now: string,
): { tasks: BoardTask[]; settled: string[] } {
  const again = planGhostSettlement({ ...input, tasks });
  const confirmed = new Set(again.decisions.filter((decision) => decision.settle).map((decision) => decision.taskId));
  const planned = new Set(plan.decisions.filter((decision) => decision.settle).map((decision) => decision.taskId));
  const settled: string[] = [];
  const next = tasks.map((task) => {
    if (!planned.has(task.id) || !confirmed.has(task.id)) return task;
    settled.push(task.id);
    return { ...task, status: "done" as const, updatedAt: now };
  });
  return { tasks: next, settled };
}
