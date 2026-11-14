import { DONE_TASK_BOARD_RETENTION_MS, taskShowsOnBoard } from "./boardVisibility";
import type { TaskSeatReader } from "./mutationView";
import type { BoardTask } from "./types";

/** Incremental admission facts, owned and bounded by the project evidence cache.
 * Expiry changes a fact once; ordinary writes visit only journaled rows. */
export class TaskAdmissionEvidence {
  private shown = new Set<string>();
  private hidden = new Map<string, BoardTask>();
  private expired = new Map<string, BoardTask>();
  private seatRefs = new Map<string, Set<string>>();
  private deadlines: { at: number; task: BoardTask }[] = [];
  private now: number;

  constructor(rows: Iterable<BoardTask>, now: number) {
    this.now = now;
    for (const task of rows) this.put(task);
  }

  private expiry(task: BoardTask) {
    return task.status === "done" ? Date.parse(task.doneAt ?? task.updatedAt) + DONE_TASK_BOARD_RETENTION_MS : Infinity;
  }

  private position(task: BoardTask): number {
    const at = this.expiry(task);
    let low = 0, high = this.deadlines.length;
    while (low < high) {
      const mid = (low + high) >>> 1, held = this.deadlines[mid]!;
      if (held.at < at || held.at === at && held.task.id < task.id) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private refs(task: BoardTask) {
    return new Set(task.assignments.flatMap(row => [row.conversationId, row.path].filter((key): key is string => Boolean(key))));
  }

  remove(task: BoardTask): void {
    this.shown.delete(task.id); this.hidden.delete(task.id); this.expired.delete(task.id);
    const index = this.position(task);
    if (this.deadlines[index]?.task.id === task.id) this.deadlines.splice(index, 1);
    for (const ref of this.refs(task)) {
      const ids = this.seatRefs.get(ref);
      ids?.delete(task.id);
      if (!ids?.size) this.seatRefs.delete(ref);
    }
  }

  put(task: BoardTask): void {
    const expires = this.expiry(task);
    if (taskShowsOnBoard(task, false, { now: this.now })) this.shown.add(task.id);
    else if (this.now > expires) {
      this.expired.set(task.id, task);
      for (const ref of this.refs(task)) {
        let ids = this.seatRefs.get(ref);
        if (!ids) this.seatRefs.set(ref, ids = new Set());
        ids.add(task.id);
      }
    } else this.hidden.set(task.id, task);
    if (Number.isFinite(expires) && this.now <= expires) this.deadlines.splice(this.position(task), 0, { at: expires, task });
  }

  count(project: string, now: number, members?: (task: BoardTask) => boolean, seat?: TaskSeatReader): number {
    // A clock rewind is rare and must rebuild from the owning row map.
    if (now < this.now) throw new Error("task admission clock moved backwards");
    this.now = now;
    while (this.deadlines[0] && now > this.deadlines[0].at) {
      const task = this.deadlines.shift()!.task;
      this.remove(task); this.put(task);
    }
    let count = this.shown.size;
    if (members) for (const task of this.hidden.values()) if (members(task)) count++;
    if (seat?.references && this.expired.size) {
      const ids = new Set(seat.references(project).flatMap(ref => [...this.seatRefs.get(ref) ?? []]));
      for (const id of ids) if (seat(this.expired.get(id)!) === "holds") count++;
    } else if (seat) {
      // Custom readers may report a seat even without an assignment. Preserve
      // that public command contract; production snapshots provide references.
      for (const task of this.expired.values()) if (seat(task) === "holds") count++;
    }
    return count;
  }

  get observedAt(): number { return this.now; }
}
