import { sharedLinkState } from "./runtimeState";
/**
 * The apply, one function on both sides (docs/design/linked-installs.md M.5):
 * per group the larger stamp wins and an equal stamp keeps the local value;
 * `machine` is taken only from the peer the local copy names as owner, or for
 * a task this machine never held; `handover.to` must name the sender. A row
 * whose id holds a tombstone is dropped; a tombstone deletes the local row.
 * When no group wins nothing is written, so a replay or an echo costs no
 * revision.
 */
import { BOARD_TASKS_PER_PROJECT_LIMIT, deleteTask } from "@/lib/tasks/commands";
import { mutateLinkedTasks, TASKS_FILE } from "@/lib/tasks/store";
import { taskFingerprint } from "@/lib/tasks/revision";
import { TASK_SYNC_GROUPS, UNTITLED_TASK_TEXT, type BoardTask, type TaskSyncGroup } from "@/lib/tasks/types";

import { countBoardTasks } from "@/lib/tasks/boardVisibility";
import { repairLinkedTasks } from "./taskRepair";

import { stampMs } from "./stamp";
import { effectiveStamp, newestStamp, raiseFloor, type TaskSyncWrite } from "./taskStamp";
import { encodeTask, isWireGone, isWireStub, MalformedRow, wireGroup, type WireRow, type WireTask } from "./taskWire";
import { isTombstone, stubKey, tombstoneKey } from "./tombstones";

export type ApplyLink = { key: string; install: string; prefix: string; projects: ReadonlySet<string> };
export type ApplyOutcome = { changed: number; refused?: "clock" | "quota" };

/** M.3: a stamp more than an hour ahead of this machine pauses the link. */
export const CLOCK_AHEAD_LIMIT_MS = 3_600_000;
/** M.8: rows that changed something, per link and UTC day. */
export const DAILY_ROW_BUDGET = 5_000;
const budgets = sharedLinkState("taskApply.budgets", () => new Map<string, { day: string; rows: number }>());

const rowStamps = (row: WireRow) => isWireGone(row) ? [row.gone] : isWireStub(row) ? [row.withheld] : Object.values(row.s);

function assignGroup(target: BoardTask, row: WireTask, group: TaskSyncGroup): void {
  const set = <K extends keyof BoardTask>(key: K, value: BoardTask[K] | undefined) => {
    if (value === undefined) delete target[key]; else target[key] = value;
  };
  switch (group) {
    case "text": target.text = row.text; set("details", row.details); target.chosen = true; break;
    case "status": target.status = row.status; break;
    case "look": set("color", row.color); set("icon", row.icon); set("priority", row.priority); break;
    case "place": target.placement = row.placement; set("pos", row.pos); break;
    case "links": set("workLinks", row.workLinks); break;
    case "machine": target.machine = row.machine; break;
    case "handover": set("handover", row.handover); break;
  }
}

/** Whether the merged row, in wire form, is exactly what the sender sent. */
function equalsSent(merged: BoardTask, row: WireTask, self: { id: string; prefix: string }): boolean {
  const mine = encodeTask(merged, self).row;
  if (isWireStub(mine)) return false;
  return TASK_SYNC_GROUPS.every((group) => mine.s[group] === row.s[group] && wireGroup(mine, group) === wireGroup(row, group));
}

function mergeRow(local: BoardTask | null, row: WireTask, link: ApplyLink, write: TaskSyncWrite): BoardTask | null {
  const self = write.self;
  if (!local) {
    const task: BoardTask = { id: row.id, project: row.project, status: row.status, text: row.text, placement: row.placement,
      assignments: [], createdAt: row.createdAt, updatedAt: row.updatedAt, machine: row.machine, sync: { s: { ...row.s }, o: link.prefix } };
    for (const group of TASK_SYNC_GROUPS) if (group !== "machine") assignGroup(task, row, group);
    // A machine asks only for itself.
    if (row.handover && row.handover.to !== link.install) delete task.handover;
    task.sync!.o = equalsSent(task, row, self) ? link.prefix : self.prefix;
    return task;
  }
  const merged: BoardTask = structuredClone(local);
  // Board is an arrival preference, outside the stamped sync groups. Older
  // peers could not send it, so fill an unset or automatic preference on a replay of
  // a task still owned by that peer. An explicit local choice always wins.
  const boardChanged = row.board !== undefined && (local.board === undefined || local.boardAutoHidden === true) && local.boardChoice !== true && (local.machine ?? self.id) === link.install;
  if (boardChanged) {
    merged.board = row.board;
    delete merged.boardAutoHidden;
  }
  const stamps: Partial<Record<TaskSyncGroup, string>> = {};
  let won = false;
  for (const group of TASK_SYNC_GROUPS) {
    const held = effectiveStamp(local, group, self.prefix);
    stamps[group] = held;
    // v1 sent an unchosen title as a placeholder under its real text stamp.
    // A v2 rescan can fill that exact placeholder. A newer local edit keeps
    // its stamp and wins as usual; no other equal-stamp field is replaced.
    const restoresTitle = group === "text" && row.s.text === held && local.text === UNTITLED_TASK_TEXT && row.text !== UNTITLED_TASK_TEXT;
    if (row.s[group] <= held && !restoresTitle) continue;
    // Only the owner hands a task on, judged by the link the call came over.
    if (group === "machine" && (local.machine ?? self.id) !== link.install) continue;
    if (group === "handover" && row.handover && row.handover.to !== link.install) continue;
    if (restoresTitle) {
      merged.text = row.text;
      merged.chosen = true;
      write.preserveStamp(row.id, group);
    }
    else assignGroup(merged, row, group);
    stamps[group] = row.s[group];
    won = true;
  }
  if (!won) return boardChanged ? merged : null;
  if (row.updatedAt > merged.updatedAt) merged.updatedAt = row.updatedAt;
  merged.sync = { s: stamps, o: self.prefix };
  if (equalsSent(merged, row, self)) merged.sync.o = link.prefix;
  return merged;
}

/**
 * Apply one page in one task transaction. Throws {@link MalformedRow} for a
 * row that breaks a bound (the whole page fails, nothing is applied).
 */
export function applyTaskRows(rows: readonly WireRow[], link: ApplyLink, options: { now?: number; filePath?: string } = {}): ApplyOutcome {
  repairLinkedTasks(options.filePath ?? TASKS_FILE);
  if (!rows.length) return { changed: 0 };
  const now = options.now ?? Date.now();
  if (rows.some((row) => rowStamps(row).some((stamp) => stampMs(stamp) > now + CLOCK_AHEAD_LIMIT_MS))) return { changed: 0, refused: "clock" };
  const day = new Date(now).toISOString().slice(0, 10);
  const budget = budgets.get(link.key);
  if (budget?.day === day && budget.rows >= DAILY_ROW_BUDGET) return { changed: 0, refused: "quota" };
  const changed = mutateLinkedTasks((current, write) => {
    if (!write) return { tasks: undefined, result: 0 };
    let tasks = current;
    let count = 0;
    const index = () => new Map(tasks.map((task, position) => [task.id, position]));
    let byId = index();
    for (const row of rows) {
      // Unsharing on either side stops that project at the next call.
      if (!link.projects.has(row.project) || !write.linked.has(row.project)) continue;
      const position = byId.get(row.id);
      const local = position === undefined ? null : tasks[position]!;
      if (local && local.project !== row.project) throw new MalformedRow("id");
      const tomb = write.read(tombstoneKey(row.id));
      if (isWireGone(row)) {
        if (isTombstone(tomb)) continue;
        const last = local ? newestStamp(local, write.self.prefix) : null;
        write.put({ id: row.id, project: row.project, gone: row.gone, ...(last && last > row.gone ? { last } : {}), o: link.prefix });
        raiseFloor(write, row.project, row.gone);
        if (write.read(stubKey(row.id))) write.remove(stubKey(row.id));
        if (local) {
          const removed = deleteTask(tasks, row.id);
          if (!removed.ok) throw new Error(removed.error);
          tasks = removed.tasks;
          byId = index();
        }
        count++;
        continue;
      }
      if (isTombstone(tomb)) continue;
      if (isWireStub(row)) {
        const held = write.read(stubKey(row.id));
        if (!held || (held as { withheld?: string }).withheld !== row.withheld) {
          write.put({ id: row.id, project: row.project, withheld: row.withheld });
        }
        continue;
      }
      if (write.read(stubKey(row.id))) write.remove(stubKey(row.id));
      const merged = mergeRow(local, row, link, write);
      if (!merged) continue;
      if (position === undefined) {
        // Admission changes only the receiving board preference; every row is kept.
        merged.board = row.board ?? (row.status === "done" ? "hidden" : undefined);
        if (row.board === undefined && merged.board === "hidden") merged.boardAutoHidden = true;
      }
      // Recovery is also an admission. Keep the automatic default at capacity
      // so a later source row can retry it without displacing a local choice.
      if (merged.board !== "hidden" && (!local || local.board === "hidden")
        && countBoardTasks(tasks, merged.project, () => false) >= BOARD_TASKS_PER_PROJECT_LIMIT) {
        merged.board = "hidden";
        merged.boardAutoHidden = true;
      }
      if (position === undefined) {
        tasks = [...tasks, merged];
        byId.set(merged.id, tasks.length - 1);
      } else {
        if (taskFingerprint(merged) === taskFingerprint(local!)) continue;
        if (tasks === current) tasks = current.slice();
        tasks[position] = merged;
      }
      count++;
    }
    return { tasks: count ? tasks : undefined, result: count };
  }, options.filePath ?? TASKS_FILE);
  const held = budgets.get(link.key);
  budgets.set(link.key, { day, rows: (held?.day === day ? held.rows : 0) + changed });
  return { changed };
}

export function resetRowBudgetsForTests(): void { budgets.clear(); }
