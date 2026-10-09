import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { redactMonitorText } from "@/lib/monitor/redact";
import { emptyMaintenanceCounts, emptyMaintenanceLog, maintenanceRunIsLive, MAINTENANCE_LOG_ENTRY_LIMIT, MAINTENANCE_RUN_RETENTION, type MaintenanceRun, type MaintenanceProject, type MaintenanceConversationIndex, type MaintenanceChange } from "./types";

type Row = MaintenanceRun | MaintenanceProject | MaintenanceConversationIndex;
const COLLECTION = "board_maintenance_runs";
const key = (row: Row) => row.kind === "run" ? `r:${row.runId}` : row.kind === "project" ? `p:${row.project}` : `c:${row.conversationId}`;
const seed = { collection: COLLECTION, schemaVersion: 1, migrationId: "board-maintainer-v1", key, loadRecords: (): Row[] => [] };
const cache = new Map<string, SqliteStateCollection<Row>>();
function decode(value: unknown): Row | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Row;
  return row.kind === "run" && typeof row.runId === "string" && Array.isArray(row.log?.changes)
    || row.kind === "project" && typeof row.project === "string" && Array.isArray(row.runIds)
    || row.kind === "conversation" && typeof row.conversationId === "string" && typeof row.runId === "string" ? row : null;
}
function collection(create = false): SqliteStateCollection<Row> | null {
  const file = statePath("state.sqlite");
  const held = cache.get(file);
  if (held) return held;
  if (!create && !stateCollectionsInitialized(file, [seed])) return null;
  if (create) initializeStateCollections(file, [seed]);
  const opened = new SqliteStateCollection<Row>(file, { collection: COLLECTION, schemaVersion: 1, busyMessage: "board maintenance runs busy", key, decode, clone: structuredClone, strictDecode: true });
  cache.set(file, opened);
  return opened;
}
export function readMaintenanceRun(runId: string): MaintenanceRun | null {
  const row = collection()?.get(`r:${runId}`);
  return row?.kind === "run" ? row : null;
}
export function readMaintenanceProject(project: string): MaintenanceProject | null {
  const row = collection()?.get(`p:${project}`);
  return row?.kind === "project" ? row : null;
}
export function maintenanceRuns(project: string): MaintenanceRun[] {
  return (readMaintenanceProject(project)?.runIds ?? []).flatMap(id => { const row = readMaintenanceRun(id); return row ? [row] : []; });
}
export function previousMaintenanceRun(project: string, beforeRunId: string): MaintenanceRun | null {
  const runs = maintenanceRuns(project);
  const index = runs.findIndex(run => run.runId === beforeRunId);
  return runs.slice(0, index < 0 ? runs.length : index).reverse().find(run => !maintenanceRunIsLive(run)) ?? null;
}
export function maintenanceRunForConversation(conversationId: string): MaintenanceRun | null {
  const row = collection()?.get(`c:${conversationId}`);
  return row?.kind === "conversation" ? readMaintenanceRun(row.runId) : null;
}
/** Retained independently of run history so a pruned scheduled caller stays fenced. */
export function maintenanceRunIdForConversation(conversationId: string): string | null {
  const row = collection()?.get(`c:${conversationId}`);
  return row?.kind === "conversation" ? row.runId : null;
}
export function claimMaintenanceRun(input: { project: string; now: number; intervalHours: number; seat: MaintenanceRun["seat"]; repoDir: string | null }): { claimed: true; run: MaintenanceRun } | { claimed: false; reason: "live" | "interval" | "slot-taken" } {
  const intervalMs = input.intervalHours * 3_600_000;
  const slot = Math.floor(input.now / intervalMs);
  const slotKey = `${input.intervalHours}:${slot}`;
  const runId = `maint_${createHash("sha256").update(`${input.project}:${slotKey}`).digest("hex").slice(0, 24)}`;
  return collection(true)!.boundedPatch(128, tx => {
    const held = tx.get(`p:${input.project}`) as MaintenanceProject | null;
    const current = held?.currentRunId ? tx.get(`r:${held.currentRunId}`) as MaintenanceRun | null : null;
    if (current && maintenanceRunIsLive(current)) return { claimed: false as const, reason: "live" as const };
    let recordedLaunchAt = held?.lastLaunchAt ?? null;
    let recordedLaunchRunId = held?.lastLaunchRunId ?? null;
    if (!recordedLaunchAt && held) {
      for (const id of [...held.runIds].reverse()) {
        const prior = tx.get(`r:${id}`) as MaintenanceRun | null;
        if (prior?.launchedAt) { recordedLaunchAt = prior.launchedAt; recordedLaunchRunId = prior.runId; break; }
      }
    }
    const cooldownStart = recordedLaunchAt;
    if (cooldownStart && input.now - Date.parse(cooldownStart) < intervalMs) return { claimed: false as const, reason: "interval" as const };
    if (tx.get(`r:${runId}`)) return { claimed: false as const, reason: "slot-taken" as const };
    const run: MaintenanceRun = {
      kind: "run", runId, project: input.project, slot, intervalHours: input.intervalHours, claimedAt: new Date(input.now).toISOString(), seat: input.seat, repoDir: input.repoDir,
      taskId: null, clientAttemptId: runId, launchId: null, conversationId: null, transcriptPath: null, launchedAt: null, state: "claimed", endedAt: null, failure: null,
      log: emptyMaintenanceLog(), counts: emptyMaintenanceCounts(), changedTaskIds: [], supersededTaskIds: [],
    };
    const ids = [...(held?.runIds ?? []), runId];
    for (const id of ids.slice(0, -MAINTENANCE_RUN_RETENTION)) {
      const old = tx.get(`r:${id}`) as MaintenanceRun | null;
      tx.delete(`r:${id}`);
    }
    tx.put(run);
    tx.put({ kind: "project", project: input.project, lastClaimAt: run.claimedAt, lastLaunchAt: recordedLaunchAt, lastLaunchRunId: recordedLaunchRunId, lastSlotKey: slotKey, currentRunId: runId, runIds: ids.slice(-MAINTENANCE_RUN_RETENTION) });
    return { claimed: true as const, run };
  });
}
/** State changes and conversation index updates share the transaction. Ended runs stay fenced. */
export function patchMaintenanceRun(runId: string, patch: Partial<MaintenanceRun>): MaintenanceRun | null {
  return collection(true)!.boundedPatch(8, tx => {
    const held = tx.get(`r:${runId}`) as MaintenanceRun | null;
    if (!held || !maintenanceRunIsLive(held)) return held;
    const next = { ...held, ...patch, ...(held.launchBody ? { launchBody: held.launchBody } : {}), kind: "run" as const, runId, project: held.project };
    tx.put(next);
    if (patch.launchedAt && (!held.launchedAt || held.admissionDeferred)) {
      const project = tx.get(`p:${held.project}`) as MaintenanceProject | null;
      if (project && project.currentRunId === runId) tx.put({ ...project, lastLaunchAt: patch.launchedAt, lastLaunchRunId: runId });
    }
    if (next.conversationId) tx.put({ kind: "conversation", conversationId: next.conversationId, runId });
    if (!maintenanceRunIsLive(next)) {
      const project = tx.get(`p:${held.project}`) as MaintenanceProject | null;
      if (project?.currentRunId === runId) tx.put({ ...project, currentRunId: null });
    }
    return next;
  });
}
export const bindMaintenanceConversation = patchMaintenanceRun;
export const settleMaintenanceRun = patchMaintenanceRun;
export function recordMaintenanceChange(runId: string, change: MaintenanceChange): void {
  collection(true)!.boundedPatch(2, tx => {
    const run = tx.get(`r:${runId}`) as MaintenanceRun | null;
    if (!run || !maintenanceRunIsLive(run)) return;
    const entry = { ...change, titleFrom: change.titleFrom ? redactMonitorText(change.titleFrom).slice(0, 120) : undefined, titleTo: change.titleTo ? redactMonitorText(change.titleTo).slice(0, 120) : undefined, textBefore: change.textBefore ? redactMonitorText(change.textBefore) : undefined };
    const ids = [...new Set([...run.changedTaskIds, change.taskId])];
    const c = run.counts;
    const f = new Set(change.fields);
    const counts = {
      writes: c.writes + 1, tasks: ids.length, created: c.created + Number(change.tool === "create_task"),
      status: c.status + Number(f.has("status") && change.statusTo !== "done"), closed: c.closed + Number(f.has("status") && change.statusTo === "done"),
      text: c.text + Number(f.has("text")), details: c.details + Number(["details", "appendLine", "replaceLine"].some(field => f.has(field))), looks: c.looks + Number(["icon", "color", "priority"].some(field => f.has(field))),
    };
    tx.put({ ...run, counts, changedTaskIds: ids, log: { ...run.log, changes: [...run.log.changes, entry].slice(0, MAINTENANCE_LOG_ENTRY_LIMIT), omittedChanges: run.log.omittedChanges + Number(run.log.changes.length >= MAINTENANCE_LOG_ENTRY_LIMIT) } });
  });
}

/** Best-effort marker after a log write failed; a committed task change stays accepted. */
export function recordMaintenanceLogGap(runId: string): void {
  collection(true)!.boundedPatch(2, tx => {
    const run = tx.get(`r:${runId}`) as MaintenanceRun | null;
    if (run && maintenanceRunIsLive(run)) tx.put({ ...run, log: { ...run.log, logGaps: run.log.logGaps + 1 } });
  });
}
