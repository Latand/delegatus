/**
 * The stamp step every task write passes (docs/design/linked-installs.md M.3):
 * for tasks of linked projects, a group whose content changed while its stamp
 * did not gets a fresh stamp and `o = self`; a group whose stamp the writer set
 * (the sync apply) keeps it; a deleted task leaves a tombstone in the same
 * commit. With nothing linked the store never calls this.
 */
import { TASK_SYNC_GROUPS, type BoardTask, type TaskSyncGroup } from "@/lib/tasks/types";
import { prototypeReviewReplica } from "@/lib/prototypeReview/model";

import { derivedStamp, maxStamp, nextStamp } from "./stamp";
import { floorKey, isFloor, isTombstone, tombstoneKey, type TombstoneRow } from "./tombstones";

export interface TaskSyncWrite {
  linked: ReadonlySet<string>;
  self: { id: string; prefix: string };
  now: () => number;
  /** A companion row as this commit will leave it. */
  read(key: string): TombstoneRow | null;
  put(row: TombstoneRow): void;
  remove(key: string): void;
  /** Keep an accepted equal-stamp placeholder recovery from becoming a local edit. */
  preserveStamp(id: string, group: TaskSyncGroup): void;
  isStampPreserved(id: string, group: TaskSyncGroup): boolean;
}

/** Local digest of a group. `chosen` belongs to the text group: naming a task
    is a change of its text even when the words stay. */
export function groupDigest(task: BoardTask, group: TaskSyncGroup): string {
  switch (group) {
    case "text": return JSON.stringify([task.text, task.details ?? null, task.chosen === true, prototypeReviewReplica(task) ?? null]);
    case "status": return JSON.stringify(task.status);
    case "look": return JSON.stringify([task.color ?? null, task.icon ?? null, task.priority ?? null]);
    case "place": return JSON.stringify([task.placement, task.pos ?? null]);
    case "links": return JSON.stringify(task.workLinks ?? null);
    case "machine": return JSON.stringify(task.machine ?? null);
    case "handover": return JSON.stringify(task.handover ?? null);
  }
}

export type GroupSnapshot = { project: string; updatedAt: string; digests: Record<TaskSyncGroup, string>; stamps: Partial<Record<TaskSyncGroup, string>>; fingerprint: string };

/** Taken before the writer runs, for linked-project tasks only: writers
    mutate rows in place. */
export function snapshotGroups(tasks: readonly BoardTask[], linked: ReadonlySet<string>, fingerprint: (task: BoardTask) => string): Map<string, GroupSnapshot> {
  const snapshot = new Map<string, GroupSnapshot>();
  for (const task of tasks) {
    if (!linked.has(task.project)) continue;
    snapshot.set(task.id, {
      project: task.project, updatedAt: task.updatedAt, fingerprint: fingerprint(task),
      digests: Object.fromEntries(TASK_SYNC_GROUPS.map((group) => [group, groupDigest(task, group)])) as Record<TaskSyncGroup, string>,
      stamps: { ...(task.sync?.s ?? {}) },
    });
  }
  return snapshot;
}

/** The stamp a group reads as, stamped or derived from the row's time. */
export function effectiveStamp(task: Pick<BoardTask, "sync" | "updatedAt">, group: TaskSyncGroup, prefix: string): string {
  return task.sync?.s[group] ?? derivedStamp(task.updatedAt, prefix);
}

export function newestStamp(task: Pick<BoardTask, "sync" | "updatedAt">, prefix: string): string {
  let newest = "";
  for (const group of TASK_SYNC_GROUPS) {
    const stamp = effectiveStamp(task, group, prefix);
    if (stamp > newest) newest = stamp;
  }
  return newest;
}

/** The largest stamp among a project's rows and its floor (M.3). */
export function projectWatermark(tasks: readonly BoardTask[], project: string, write: Pick<TaskSyncWrite, "read" | "self">): string | null {
  let mark: string | null = null;
  for (const task of tasks) if (task.project === project) mark = maxStamp(mark, newestStamp(task, write.self.prefix));
  const floor = write.read(floorKey(project));
  return maxStamp(mark, isFloor(floor) ? floor.floor : null);
}

export function raiseFloor(write: TaskSyncWrite, project: string, stamp: string): void {
  const floor = write.read(floorKey(project));
  if (!isFloor(floor) || floor.floor < stamp) write.put({ project, floor: stamp });
}

export function stampLinkedRows(tasks: BoardTask[], before: ReadonlyMap<string, GroupSnapshot>, write: TaskSyncWrite, fingerprint: (task: BoardTask) => string): void {
  const marks = new Map<string, string | null>();
  const fresh = (project: string) => {
    if (!marks.has(project)) marks.set(project, projectWatermark(tasks, project, write));
    const stamp = nextStamp(marks.get(project)!, write.now(), write.self.prefix);
    marks.set(project, stamp);
    return stamp;
  };
  const present = new Set<string>();
  for (const task of tasks) {
    present.add(task.id);
    if (!write.linked.has(task.project)) continue;
    const prior = before.get(task.id);
    if (prior && prior.fingerprint === fingerprint(task)) continue;
    if (!task.machine) task.machine = write.self.id;
    const stamps: Partial<Record<TaskSyncGroup, string>> = { ...(task.sync?.s ?? {}) };
    let local = false;
    for (const group of TASK_SYNC_GROUPS) {
      const changed = !prior || prior.digests[group] !== groupDigest(task, group);
      const setByWriter = stamps[group] !== undefined && stamps[group] !== prior?.stamps[group];
      const preserved = prior !== undefined && stamps[group] === prior.stamps[group] && write.isStampPreserved(task.id, group);
      if (preserved) continue;
      if (setByWriter) continue;
      if (changed) { stamps[group] = fresh(task.project); local = true; }
      else stamps[group] ??= prior.stamps[group] ?? derivedStamp(prior.updatedAt, write.self.prefix);
    }
    task.sync = { s: stamps, o: local ? write.self.prefix : task.sync?.o ?? write.self.prefix };
  }
  for (const [id, prior] of before) {
    if (present.has(id) || isTombstone(write.read(tombstoneKey(id)))) continue;
    const last = Object.values(prior.stamps).reduce<string>((newest, stamp) => stamp! > newest ? stamp! : newest, derivedStamp(prior.updatedAt, write.self.prefix));
    const gone = fresh(prior.project);
    write.put({ id, project: prior.project, gone, ...(last > gone ? { last } : {}), o: write.self.prefix });
    raiseFloor(write, prior.project, gone);
  }
}
