import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { LifecycleState } from "@/lib/lifecycle/vocabulary";
import type { PipelineState } from "@/lib/pipelines/types";

export const WORK_QUIET_AFTER_MS = 2 * 60 * 60_000;
export interface WorkerEvidence {
  conversationId: string;
  via: "assignment" | "stage";
  pipelineId?: string;
  stageId?: string;
  lifecycle: LifecycleState | "unknown";
  lastRecordAt: string | null;
}
export interface LaneEvidence {
  pipelineId: string;
  state: PipelineState;
  movedAt: string | null;
  branch: string;
  branchCommitAt: string | null;
  closedAt?: string | null;
  hiddenAt?: string | null;
}
export type WorkVerdict = "working" | "quiet" | "finished-open" | "idle";
export interface TaskWorkEvidence {
  taskId: string;
  status: TaskStatus;
  verdict: WorkVerdict;
  lastWorkAt: string | null;
  workers: WorkerEvidence[];
  lanes: LaneEvidence[];
}
export function newestWorkAt(values: (string | null | undefined)[]): string | null {
  return values.filter((v): v is string => !!v && Number.isFinite(Date.parse(v))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
export const maintenanceLaneIsOpen = (lane: { state: string; closedAt?: string | null; hiddenAt?: string | null }): boolean => !lane.closedAt && !lane.hiddenAt && lane.state !== "completed" && lane.state !== "closed";
export function taskWorkEvidence(task: Pick<BoardTask, "id" | "status">, workers: WorkerEvidence[], lanes: LaneEvidence[], now: number): TaskWorkEvidence {
  const lastWorkAt = newestWorkAt([...workers.map(w => w.lastRecordAt), ...lanes.flatMap(l => [l.movedAt, l.branchCommitAt])]);
  const running = workers.some(w => ["starting", "running", "stalled", "waiting"].includes(w.lifecycle)) || lanes.some(maintenanceLaneIsOpen);
  const unknown = workers.some(w => w.lifecycle === "unknown");
  const verdict = running ? lastWorkAt && now - Date.parse(lastWorkAt) <= WORK_QUIET_AFTER_MS ? "working" : "quiet"
    : task.status === "assigned" && !unknown && (workers.length > 0 || lanes.length > 0) ? "finished-open" : "idle";
  return { taskId: task.id, status: task.status, verdict, lastWorkAt, workers, lanes };
}
export function workEvidenceLines(evidence: readonly TaskWorkEvidence[], now: number, limit = 80): string[] {
  const age = (at: string | null) => at ? `${Math.max(0, Math.round((now - Date.parse(at)) / 60_000))} min ago` : "unread";
  return evidence.filter(e => e.verdict !== "idle").slice(0, limit).map(e => `${e.taskId} ${e.status}: ${e.verdict}; ${[
    ...e.workers.map(w => `agent ${w.conversationId} ${w.lifecycle}, transcript ${age(w.lastRecordAt)}`),
    ...e.lanes.map(l => `lane ${l.pipelineId} ${l.state}, attempt ${age(l.movedAt)}, branch ${l.branch || "unread"} commit ${age(l.branchCommitAt)}`),
  ].join("; ")}`);
}
