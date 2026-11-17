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
export interface MaintenanceAttention { taskId: string; text: string; options: string[]; nextStep?: string }
export interface MaintenanceLeftAlone { taskId: string; reason: string }
export interface MaintenanceRunLog {
  changes: MaintenanceChange[];
  omittedChanges: number;
  logGaps: number;
  attention: MaintenanceAttention[];
  leftAlone: MaintenanceLeftAlone[];
  verdict: "pass" | "fail" | "needs_decision" | null;
  audit?: MaintenanceAuditResult;
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
  audit?: MaintenanceAuditInput;
  /** An undispatched claim keeps its identity across an update admission hold. */
  admissionDeferred?: boolean;
  launchedAt: string | null;
  state: MaintenanceRunState;
  endedAt: string | null;
  /** `engine` names the runtime a `no-account` launch was refused on, so the
      text and the Accounts link name the engine the run actually used. */
  failure: { kind: MaintenanceFailureKind; detail: string; engine?: "claude" | "codex" } | null;
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
  audit?: MaintenanceAuditState;
}
/** Private, immutable evidence. None of these locators belongs in a card preview. */
export interface MaintenanceAuditSource {
  key: string;
  kind: "transcript" | "decision";
  conversationId: string;
  generation: string;
  path: string | null;
  artifact: string | null;
  size: number;
  from: { seq: number; part?: number; requestIndex: number } | null;
  /** Physical transcript scan boundary; rebuilt from the same artifact after restart. */
  scanThrough?: { seq: number; part?: number; at: string } | null;
  complete: boolean;
  gap: string | null;
  decision?: { roundId: string; revision: number; taskId: string | null; deliveryKey?: string; operationId?: string };
}
export interface MaintenanceAuditOccurrence {
  key: string;
  source: string;
  seq: number;
  part: number;
  at: string;
  requestIndex: number;
  text: string;
  verified: boolean;
  gap: string | null;
}
export interface MaintenanceAuditWindow {
  lower: string;
  upper: string;
  sources: MaintenanceAuditSource[];
  gaps: string[];
  decisionAliases?: string[];
  /** Existing taskless-form raw-key scan, retained across bounded batches. */
  decisionCursor?: string;
  decisionScanComplete?: boolean;
}
export interface MaintenanceAuditState {
  version: 1;
  revision: number;
  through: string | null;
  window: MaintenanceAuditWindow | null;
}
export interface MaintenanceAuditInput {
  version: 1;
  runId: string;
  project: string;
  revision: number;
  seat: MaintenanceRun["seat"];
  operator: { kind: "member"; memberId: string } | { kind: "operator" } | null;
  snapshotAt: string;
  authority?: string | null;
  window: MaintenanceAuditWindow;
  occurrences: MaintenanceAuditOccurrence[];
  /** Per-source first record beyond this batch, independent of MCP cursor handles. */
  unread: Record<string, { seq: number; part?: number; requestIndex: number } | null>;
}
export type MaintenanceRequestOutcome = "done" | "running" | "filed" | "updated" | "cancelled" | "unverified";
export interface MaintenanceAuditRow {
  key: string;
  occurrence: string;
  requestIndex: number;
  at: string;
  request: string;
  outcome: MaintenanceRequestOutcome;
  taskId: string | null;
  code: string;
  merge: string;
  install: string;
  acceptance: string;
  checkedAt: string;
  next: string;
  dueAt: string | null;
  dueTz: string | null;
  mutation: { key: string; state: "readback" | "uncertain" } | null;
}
export interface MaintenanceAuditManifest {
  version: 1;
  runId: string;
  revision: number;
  lower: string;
  upper: string;
  rows: number;
  /** Every supplied occurrence, including messages containing zero requests. */
  occurrences: Array<{ key: string; requests: number; nextIndex: number }>;
}
export interface MaintenanceAuditResult {
  version: 1;
  rows: MaintenanceAuditRow[];
  manifest: MaintenanceAuditManifest | null;
  complete: boolean;
  error: string | null;
  refusedOccurrence?: string | null;
  window: MaintenanceAuditWindow;
}
export interface MaintenanceConversationIndex { kind: "conversation"; conversationId: string; runId: string }
