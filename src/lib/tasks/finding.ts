import type { TaskRefusal } from "./commands";
import type { BoardTask } from "./types";

export const FINDING_KEY_LIMIT = 200;

/** Opaque: retain whitespace and case, and count Unicode characters. */
export function readFindingKey(value: unknown): { ok: true; key?: string } | TaskRefusal {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string" || value.length > FINDING_KEY_LIMIT * 2 || [...value].length > FINDING_KEY_LIMIT) {
    return { ok: false, status: 400, code: "TASK_INVALID_FIELD", field: "findingKey", error: `findingKey must be a string of at most ${FINDING_KEY_LIMIT} characters` };
  }
  return { ok: true, key: value };
}

export function validStoredFinding(value: unknown): value is NonNullable<BoardTask["finding"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.count) && Number(row.count) > 0
    && typeof row.lastSeenAt === "string" && Number.isFinite(Date.parse(row.lastSeenAt))
    && (row.previousTaskId === undefined || typeof row.previousTaskId === "string");
}

/** Project aliases can join previously independent holders. Keep every task
 * record; the oldest owns the combined occurrence history and original key. */
export function reconcileOpenFindings(tasks: readonly BoardTask[]): BoardTask[] {
  const groups = new Map<string, BoardTask[]>();
  for (const task of tasks) {
    if (task.status === "done" || task.findingKey === undefined) continue;
    const identity = JSON.stringify([task.project, task.findingKey]);
    const held = groups.get(identity);
    if (held) held.push(task); else groups.set(identity, [task]);
  }
  const changed = new Map<string, BoardTask>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
    const keeper = group[0]!;
    const count = group.reduce((sum, task) => Math.min(Number.MAX_SAFE_INTEGER, sum + (task.finding?.count ?? 1)), 0);
    const lastSeenAt = group.reduce((latest, task) => Date.parse(task.finding?.lastSeenAt ?? task.updatedAt) > Date.parse(latest) ? task.finding?.lastSeenAt ?? task.updatedAt : latest, keeper.finding?.lastSeenAt ?? keeper.updatedAt);
    changed.set(keeper.id, { ...keeper, finding: { ...keeper.finding, count, lastSeenAt } });
    for (const task of group.slice(1)) {
      const detached = { ...task };
      delete detached.findingKey;
      delete detached.finding;
      changed.set(task.id, detached);
    }
  }
  return tasks.map(task => changed.get(task.id) ?? task);
}
