import type { TaskStatus } from "@/lib/tasks/types";

export const MAINTENANCE_RUN_RETENTION = 10;
export const MAINTENANCE_LOG_ENTRY_LIMIT = 400;
export const MAINTENANCE_LAUNCH_TIMEOUT_MS = 30_000;
export const MAINTENANCE_LAUNCH_GRACE_MS = 15 * 60_000;
export const MAINTENANCE_RUN_TIMEOUT_MS = 90 * 60_000;
export type MaintenanceRunState = "claimed" | "launching" | "running" | "succeeded" | "failed";
export type MaintenanceFailureKind = "no-account" | "no-repository" | "launch-refused" | "launch-failed" | "host-died" | "turn-error" | "agent-fail" | "needs-decision" | "timed-out";
export interface MaintenanceChange {
  at: string;
  taskId: string;
  tool: "create_task" | "update_task";
  fields: string[];
  statusFrom?: TaskStatus;
  statusTo?: TaskStatus;
  titleFrom?: string;
  titleTo?: string;
  textBefore?: string;
}
export interface MaintenanceAttention { taskId: string; text: string; options: string[] }
export interface MaintenanceLeftAlone { taskId: string; reason: string }
export interface MaintenanceRunLog {
  changes: MaintenanceChange[];
  omittedChanges: number;
  logGaps: number;
  attention: MaintenanceAttention[];
  leftAlone: MaintenanceLeftAlone[];
  verdict: "pass" | "fail" | "needs_decision" | null;
}
export interface MaintenanceCounts {
  writes: number;
  tasks: number;
  status: number;
  closed: number;
  created: number;
  text: number;
  details: number;
  looks: number;
}
export const emptyMaintenanceCounts = (): MaintenanceCounts => ({ writes: 0, tasks: 0, status: 0, closed: 0, created: 0, text: 0, details: 0, looks: 0 });
export const emptyMaintenanceLog = (): MaintenanceRunLog => ({ changes: [], omittedChanges: 0, logGaps: 0, attention: [], leftAlone: [], verdict: null });
export const maintenanceRunIsLive = (run: Pick<MaintenanceRun, "state">): boolean => ["claimed", "launching", "running"].includes(run.state);
export interface MaintenanceRun {
  kind: "run";
  runId: string;
  project: string;
  slot: number;
  intervalHours: number;
  claimedAt: string;
  seat: { seatEpoch: number; conversationId: string };
  repoDir: string | null;
  taskId: string | null;
  clientAttemptId: string;
  launchId: string | null;
  conversationId: string | null;
  transcriptPath: string | null;
  launchBody?: Record<string, unknown>;
  launchedAt: string | null;
  state: MaintenanceRunState;
  endedAt: string | null;
  failure: { kind: MaintenanceFailureKind; detail: string } | null;
  log: MaintenanceRunLog;
  counts: MaintenanceCounts;
  /** Distinct ids remain exact even after the stored change preview fills. */
  changedTaskIds: string[];
  supersededTaskIds: string[];
}
export interface MaintenanceProject {
  kind: "project";
  project: string;
  lastClaimAt: string | null;
  /** Time the durable spawn dispatch was first recorded, used for cooldown. */
  lastLaunchAt?: string | null;
  lastLaunchRunId?: string | null;
  lastSlotKey: string | null;
  currentRunId: string | null;
  runIds: string[];
}
export interface MaintenanceConversationIndex { kind: "conversation"; conversationId: string; runId: string }
