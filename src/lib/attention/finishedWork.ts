import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

/** Terminal containers settle only work raised before their recorded ending.
 * A resumed conversation or a live approval still has someone to answer it. */
export function laneFinishedAt(lane: Pipeline): number | null {
  if (lane.state !== "completed" && lane.state !== "closed") return null;
  const times = [lane.closedAt, lane.merge?.mergedAt,
    ...lane.runs.flatMap(run => run.attempts.map(attempt => attempt.completedAt))]
    .map(value => Date.parse(value ?? "")).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

export function conversationHasHost(file: FileEntry): boolean {
  return file.proc === "running" || file.activity === "live" && file.proc !== "killed" && file.proc !== "done";
}

export type ConversationFinishState = { kind: "finished"; at: number } | { kind: "active" } | { kind: "unknown" };

/** Build once per changed board input, with lookups bounded by its memberships. */
export function finishedWorkIndex(tasks: readonly BoardTask[], pipelines: readonly Pipeline[], canonical = (id: string) => id, files: readonly FileEntry[] = [], ownershipFactsComplete = true) {
  const filesByKey = new Map<string, FileEntry>();
  for (const file of files) {
    filesByKey.set(file.path, file);
    if (file.conversationId) filesByKey.set(canonical(file.conversationId), file);
  }
  const laneTimes = new Map(pipelines.map(lane => [lane.id, laneFinishedAt(lane)]));
  const taskStatuses = new WeakMap<BoardTask, TaskStatus>();
  const lanes = new Map(pipelines.map(lane => [lane.id, lane]));
  const taskLanes = new Map<string, Pipeline[]>();
  const owners = new Map<string, BoardTask[]>();
  const conversations = new Map<string, Pipeline[]>();
  const add = <T>(map: Map<string, T[]>, key: string | null | undefined, value: T) => {
    if (!key) return;
    const held = map.get(key) ?? []; held.push(value); map.set(key, held);
  };
  for (const task of tasks) for (const assignment of task.assignments) {
    add(owners, assignment.conversationId ? canonical(assignment.conversationId) : null, task);
    add(owners, assignment.path, task);
  }
  for (const lane of pipelines) {
    for (const id of lane.taskIds ?? []) add(taskLanes, id, lane);
    for (const run of lane.runs) for (const attempt of run.attempts) {
      add(conversations, attempt.conversationId ? canonical(attempt.conversationId) : null, lane);
      add(conversations, attempt.agentPath, lane);
    }
  }
  const deriveTaskStatus = (task: BoardTask): TaskStatus => {
      if (task.status !== "assigned" || task.machine || task.hold) return task.status;
      const attached = taskLanes.get(task.id) ?? [];
      if (!attached.length) return task.status;
      const times = attached.map(lane => laneTimes.get(lane.id) ?? null);
      if (!times.every((time): time is number => time !== null)) return task.status;
      // A completed lane can still owe a merge; its operator decision stays.
      if (attached.some(lane => lane.merge && !["merged", "cancelled"].includes(lane.merge.state))) return task.status;
      const at = Math.max(...times);
      const references = [...task.assignments, ...attached.flatMap(lane => lane.runs.flatMap(run => run.attempts.map(attempt => ({ path: attempt.agentPath, conversationId: attempt.conversationId }))))];
      if (references.some(reference => {
        const file = filesByKey.get(reference.conversationId ? canonical(reference.conversationId) : reference.path ?? "") ?? filesByKey.get(reference.path ?? "");
        return file && conversationHasHost(file) && (file.pendingPermission || file.pendingQuestion || file.waitingInput || (file.lastTurn?.startedAt ?? 0) > at);
      })) return task.status;
      if (Date.parse(task.statusBy?.at ?? "") > at) return task.status;
      if (task.assignments.some(assignment => assignment.state !== "failed" && Date.parse(assignment.at) > at)) return task.status;
      return "inbox";
  };
  const conversationFinishState = (file: FileEntry): ConversationFinishState => {
    const id = file.conversationId ? canonical(file.conversationId) : file.path;
    const owningTasks = [...new Set([...(owners.get(id) ?? []), ...(owners.get(file.path) ?? [])])];
    const owningLanes = new Set([...(conversations.get(id) ?? []), ...(conversations.get(file.path) ?? [])]);
    for (const task of owningTasks) for (const lane of taskLanes.get(task.id) ?? []) owningLanes.add(lane);
    let unknownOwner = false;
    for (const member of file.durableLineage?.memberships ?? []) {
      if (member.kind !== "pipeline") continue;
      const lane = lanes.get(member.containerId);
      if (!lane) { unknownOwner = true; continue; }
      owningLanes.add(lane);
    }
    const hasRunningAttempt = [...owningLanes].some(lane => lane.runs.some(run => run.attempts.some(attempt =>
      attempt.state === "running" && ((attempt.conversationId && canonical(attempt.conversationId) === id) || attempt.agentPath === file.path))));
    if (hasRunningAttempt || [...owningLanes].some(lane => lane.state !== "completed" && lane.state !== "closed")) return { kind: "active" };
    if ([...owningLanes].some(lane => laneTimes.get(lane.id) === null)) return { kind: "unknown" };
    if (unknownOwner) return { kind: "unknown" };
    if (!ownershipFactsComplete) return { kind: "unknown" };
    if (owningTasks.some(task => task.status !== "done" && ![...owningLanes].some(lane => lane.taskIds?.includes(task.id)))) {
      return { kind: "unknown" };
    }
    const times = [
      ...owningTasks.filter(task => task.status === "done").map(task => Date.parse(task.doneAt ?? task.updatedAt)),
      ...[...owningLanes].map(lane => laneTimes.get(lane.id) ?? Number.NaN),
    ];
    return times.length && times.every(Number.isFinite)
      ? { kind: "finished", at: Math.max(...times) }
      : { kind: "unknown" };
  };
  return {
    /** Unknown or conflicting owners prove nothing; every known owner must
     * have finished. A newer ask belongs to the resumed conversation. */
    conversationFinishState,
    conversationFinishedAt(file: FileEntry): number | null {
      const state = conversationFinishState(file);
      return state.kind === "finished" ? state.at : null;
    },
    /** A lane ending does not declare its task finished. Unfinished work
     * returns to Inbox, unless another lane or a later admission owns it. */
    taskStatus(task: BoardTask): TaskStatus {
      const held = taskStatuses.get(task);
      if (held) return held;
      const status = deriveTaskStatus(task);
      taskStatuses.set(task, status);
      return status;
    },
  };
}
