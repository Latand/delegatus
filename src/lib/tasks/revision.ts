import crypto, { createHash } from "node:crypto";
import type { BoardTask } from "./types";

export type TaskWithRevision = BoardTask & { revision: string };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

/** Full persisted content, including extension fields; revision is store-owned. */
export function taskFingerprint(task: BoardTask): string {
  const { revision: _revision, ...content } = task as TaskWithRevision;
  return createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex");
}

export function taskRevision(task: BoardTask): string {
  const revision = (task as Partial<TaskWithRevision>).revision;
  if (revision === undefined) return `task-legacy:${taskFingerprint(task)}`;
  if (typeof revision !== "string" || !/^(task-v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|task-legacy:[0-9a-f]{64})$/.test(revision)) {
    throw new Error("invalid persisted task revision");
  }
  return revision;
}

export function snapshotTasks(tasks: BoardTask[], pristine?: readonly BoardTask[], originalDraft?: (index: number) => BoardTask) {
  return new Map((pristine ?? tasks).map((task, index) => {
    const original = pristine?.[index];
    // A store-owned immutable baseline lets no-write callbacks skip hashing.
    // Capture all mutable metadata now; the fingerprint reads only that baseline.
    let fingerprint = original ? undefined : taskFingerprint(task);
    return [task.id, { get ref() { return originalDraft ? originalDraft(index) : task; },
      get fingerprint() { return fingerprint ??= taskFingerprint(original!); },
      revision: taskRevision(task), status: task.status, statusBy: JSON.stringify(task.statusBy ?? null),
      // The immutable baseline this entry's fingerprint describes, when there is one.
      pristine: original as BoardTask | undefined }];
  }));
}

/** Equal plain JSON values, key order aside. A value this cannot vouch for
 * (a class instance, an own key the other side lacks) reads as different. */
function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  const array = Array.isArray(left);
  if (array !== Array.isArray(right)) return false;
  if (array) {
    const other = right as unknown[];
    if ((left as unknown[]).length !== other.length) return false;
    for (let index = 0; index < other.length; index++) if (!sameJson((left as unknown[])[index], other[index])) return false;
    return true;
  }
  const prototype = Object.getPrototypeOf(left);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getPrototypeOf(right) !== prototype) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(right, key) || !sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** Snapshot before the callback: writers can mutate nested assignments in place. */
export function stampTaskRevisions(tasks: BoardTask[], before: ReturnType<typeof snapshotTasks>, replacementsAreWrites: boolean): void {
  for (const task of tasks) {
    const prior = before.get(task.id);
    /* A task equal to its baseline has the baseline's fingerprint. One write
       hashed every task on the board twice to learn that (#3809). */
    const untouched = !!prior?.pristine && sameJson(task, prior.pristine);
    const changed = !prior || (!untouched && prior.fingerprint !== taskFingerprint(task))
      || (replacementsAreWrites && prior.ref !== task);
    (task as TaskWithRevision).revision = changed ? `task-v1:${crypto.randomUUID()}` : prior.revision;
  }
}
