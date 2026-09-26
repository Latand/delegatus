import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized, type StateCollectionSeed } from "@/lib/state/sqliteStateStore";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

import { TASK_TITLE_MAX_CHARS, type TaskChangeKind, type TaskChanges } from "./reportRender";

/*
 * The board's task statuses at each settled deploy
 * (docs/design/orchestrator-reports.md §3.8).
 *
 * Board tasks keep no status history, so "what changed since the previous
 * deploy" needs a picture of the board taken when each deploy settled. The
 * seat tick takes one per terminal deployment in its controller pass, from
 * the runtime's own ledger, whoever started the deploy and whether or not a
 * report ever follows. A deploy report then lists the difference between the
 * last successful deploy before it and its own snapshot.
 *
 * Stored in the `task_status_snapshots` collection of `state.sqlite`, one row
 * per deploy, the newest ten per project kept. Written only here.
 */

export const TASK_STATUS_SNAPSHOT_COLLECTION = "task_status_snapshots";
/** Snapshots kept per project. */
export const TASK_STATUS_SNAPSHOTS_KEPT = 10;

export interface TaskStatusSnapshot {
  key: string;
  project: string;
  deploymentId: string;
  sha8: string;
  /** The deployment's terminal phase. Only `succeeded` starts a later list. */
  state: string;
  settledAt: string;
  takenAt: string;
  /** Task id → status, for the tasks shown on the board at that moment. */
  statuses: Record<string, TaskStatus>;
}

export interface SettledDeployment {
  deploymentId: string;
  revision: string;
  phase: string;
  terminal: boolean;
  updatedAt: string;
}

const collections = new Map<string, { identity: string; collection: SqliteStateCollection<TaskStatusSnapshot> }>();

function identity(filename: string): string {
  try {
    const stat = fs.statSync(filename);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return "absent";
  }
}

function decode(value: unknown): TaskStatusSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<TaskStatusSnapshot>;
  if (typeof row.key !== "string" || typeof row.project !== "string" || typeof row.deploymentId !== "string"
    || typeof row.sha8 !== "string" || typeof row.state !== "string" || typeof row.settledAt !== "string"
    || typeof row.takenAt !== "string" || !row.statuses || typeof row.statuses !== "object") return null;
  return row as TaskStatusSnapshot;
}

const SEED: StateCollectionSeed<unknown> = {
  collection: TASK_STATUS_SNAPSHOT_COLLECTION,
  schemaVersion: 1,
  migrationId: "task-status-snapshots-v1",
  key: (raw) => (raw as TaskStatusSnapshot).key,
  loadRecords: () => [],
};

/** The collection, created on first write. A reader (the MCP server filing a
    report) never creates it: no collection yet means no snapshot yet. */
function collection(purpose: "read" | "write" = "write", filename = statePath("state.sqlite")): SqliteStateCollection<TaskStatusSnapshot> | null {
  const held = collections.get(filename);
  if (held && held.identity === identity(filename)) return held.collection;
  if (purpose === "read" && !stateCollectionsInitialized(filename, [SEED])) return null;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  initializeStateCollections(filename, [SEED]);
  const opened = new SqliteStateCollection<TaskStatusSnapshot>(filename, {
    collection: TASK_STATUS_SNAPSHOT_COLLECTION,
    schemaVersion: 1,
    busyMessage: "task status snapshots are busy",
    key: (row) => row.key,
    decode,
    clone: structuredClone,
    strictDecode: false,
  });
  collections.set(filename, { identity: identity(filename), collection: opened });
  return opened;
}

export function resetTaskChangeCollectionsForTests(): void {
  collections.clear();
}

function snapshotKey(project: string, deploymentId: string): string {
  return `${project}/${deploymentId}`;
}

/** A task that counts: shown on the board, not in a hidden group. */
function onBoard(task: BoardTask): boolean {
  return task.board !== "hidden" && !task.groupHidden;
}

export function projectSnapshots(project: string): TaskStatusSnapshot[] {
  const prefix = `${project}/`;
  const store = collection("read");
  if (!store) return [];
  return store.keyRange(prefix, `${prefix}￿`, 512)
    .sort((left, right) => Date.parse(left.settledAt) - Date.parse(right.settledAt));
}

export function readDeploySnapshot(project: string, deploymentId: string): TaskStatusSnapshot | null {
  return collection("read")?.get(snapshotKey(project, deploymentId)) ?? null;
}

/**
 * Take the snapshot for one settled deployment, once. Idempotent by
 * deployment id: a second call for the same deploy changes nothing, so the
 * picture stays the board as it was when the deploy was first seen settled.
 * Returns whether a snapshot was written.
 */
export function recordDeploySnapshot(
  project: string,
  deployment: SettledDeployment,
  tasks: readonly BoardTask[],
  now: string = new Date().toISOString(),
): boolean {
  if (!deployment.terminal) return false;
  const key = snapshotKey(project, deployment.deploymentId);
  const store = collection("write")!;
  if (store.get(key)) return false;
  const statuses: Record<string, TaskStatus> = {};
  for (const task of tasks) {
    if (task.project === project && onBoard(task)) statuses[task.id] = task.status;
  }
  const snapshot: TaskStatusSnapshot = {
    key,
    project,
    deploymentId: deployment.deploymentId,
    sha8: deployment.revision.slice(0, 8),
    state: deployment.phase,
    settledAt: deployment.updatedAt,
    takenAt: now,
    statuses,
  };
  return store.boundedPatch(64, (tx) => {
    if (tx.get(key)) return false;
    tx.put(snapshot);
    /* Keep the newest ten of this project by settle time. */
    const kept = [...projectSnapshots(project), snapshot]
      .sort((left, right) => Date.parse(left.settledAt) - Date.parse(right.settledAt));
    for (const old of kept.slice(0, Math.max(0, kept.length - TASK_STATUS_SNAPSHOTS_KEPT))) {
      if (old.key !== key) tx.delete(old.key);
    }
    return true;
  });
}

/** Every terminal deployment in `deployments` without a snapshot gets one. */
export function recordDeploySnapshots(
  project: string,
  deployments: readonly SettledDeployment[],
  tasks: readonly BoardTask[],
  now?: string,
): number {
  let written = 0;
  for (const deployment of deployments) {
    if (deployment.terminal && recordDeploySnapshot(project, deployment, tasks, now)) written += 1;
  }
  return written;
}

const KIND_OF_STATUS: Partial<Record<TaskStatus, TaskChangeKind>> = { done: "done", blocked: "blocked", assigned: "assigned" };

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length <= TASK_TITLE_MAX_CHARS ? line : `${line.slice(0, TASK_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * The changes a report on `deploymentId` lists: from the snapshot of the last
 * successful deploy that settled before it to its own snapshot. Titles are the
 * tasks' current first lines; a task deleted or hidden since is left out, and
 * so is a move back to inbox. Null when either snapshot is missing, which is
 * a deploy that settled before snapshots existed or aged out of the ten kept.
 */
export function deployTaskChanges(
  project: string,
  deploymentId: string,
  tasks: readonly BoardTask[],
): TaskChanges | null {
  const snapshots = projectSnapshots(project);
  const target = snapshots.find((snapshot) => snapshot.deploymentId === deploymentId);
  if (!target) return null;
  const settled = Date.parse(target.settledAt);
  const base = snapshots
    .filter((snapshot) => snapshot.state === "succeeded" && snapshot.deploymentId !== deploymentId && Date.parse(snapshot.settledAt) < settled)
    .at(-1);
  if (!base) return null;
  const current = new Map(tasks.filter((task) => task.project === project && onBoard(task)).map((task) => [task.id, task]));
  const groups: Partial<Record<TaskChangeKind, string[]>> = {};
  for (const [id, status] of Object.entries(target.statuses)) {
    const task = current.get(id);
    if (!task) continue;
    const before = base.statuses[id];
    const kind: TaskChangeKind | undefined = before === undefined ? "created" : before !== status ? KIND_OF_STATUS[status] : undefined;
    if (!kind) continue;
    const title = firstLine(task.text);
    if (!title) continue;
    (groups[kind] ??= []).push(title);
  }
  return { groups, notOnProdYet: target.state !== "succeeded" };
}
