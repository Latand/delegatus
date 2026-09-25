import type { TaskStatus } from "@/lib/tasks/types";

/**
 * The desktop board's undo and redo (#1856): the operator's own status moves,
 * text edits and group hides, newest last, in memory only. One history per
 * board and project, so a project switch or a reload starts empty.
 *
 * An entry is recorded when its write is sent; `settled` resolves true once
 * that write saved, and an entry whose write did not save is dropped, so only
 * what this board actually wrote can be undone. Recording a new edit clears
 * the redo stack.
 */

interface Settles {
  /** The write this entry stands for: true once it saved. */
  settled: Promise<boolean>;
  /** What `settled` resolved to, once it has. */
  saved?: boolean;
  /** Per task, the lineage its saved write answered with; the undo and the
      redo of the entry are fenced on it (useTaskMutations.ts). */
  lineages?: Map<string, number>;
}

export type HistoryEntry = Settles & (
  | { kind: "status"; taskId: string; title: string; from: TaskStatus; to: TaskStatus }
  /* The whole text field, since title and description are stored as one. */
  | { kind: "text"; taskId: string; title: string; before: string; after: string }
  /* One entry for a single hide or a column's bulk hide: one Undo brings the
     whole bulk back, so Ctrl+Z never skips past part of it. `text` is what the
     hide's receipt said, which a redo of a bulk hide says again. */
  | { kind: "hide"; text: string; tasks: Array<{ taskId: string; title: string }> }
);

export const HISTORY_LIMIT = 50;

export class BoardHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private records = 0;
  /** Per entry on the undo stack, the epoch it was placed there at. */
  private placed = new WeakMap<HistoryEntry, number>();

  constructor(private readonly limit = HISTORY_LIMIT) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Counts `record` calls: an undo or a redo still being written when a new
      edit is recorded must not refill the redo stack that edit cleared. */
  get epoch(): number {
    return this.records;
  }

  /** A new edit: it becomes the next undo, and nothing is left to redo. */
  record(entry: HistoryEntry): void {
    this.records += 1;
    this.redoStack = [];
    this.pushUndo(entry);
    void entry.settled.then((saved) => {
      entry.saved = saved;
      if (!saved) this.discard(entry);
    });
  }

  /** An entry that was just redone, or an undo that failed to reach the
      server. An undo sent at an older `since` epoch goes back below the edits
      recorded after it, so the next undo still takes the newest edit first. */
  pushUndo(entry: HistoryEntry, since = this.records): void {
    this.placed.set(entry, since);
    let at = this.undoStack.length;
    while (at > 0 && (this.placed.get(this.undoStack[at - 1]!) ?? 0) > since) at -= 1;
    this.undoStack.splice(at, 0, entry);
    if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
  }

  /** An entry that was just undone, or a redo that failed to reach the server. */
  pushRedo(entry: HistoryEntry): void {
    this.redoStack.push(entry);
    if (this.redoStack.length > this.limit) this.redoStack.splice(0, this.redoStack.length - this.limit);
  }

  takeUndo(): HistoryEntry | null {
    return this.undoStack.pop() ?? null;
  }

  takeRedo(): HistoryEntry | null {
    return this.redoStack.pop() ?? null;
  }

  /** Take `entry` off the stack a step in `direction` takes from; false when
      it is not there, as a redo is not once a new edit cleared its stack. */
  withdraw(entry: HistoryEntry, direction: "undo" | "redo"): boolean {
    const stack = direction === "undo" ? this.undoStack : this.redoStack;
    const at = stack.indexOf(entry);
    if (at < 0) return false;
    stack.splice(at, 1);
    return true;
  }

  discard(entry: HistoryEntry): void {
    this.undoStack = this.undoStack.filter((candidate) => candidate !== entry);
    this.redoStack = this.redoStack.filter((candidate) => candidate !== entry);
  }

  /** Forget every entry of a task: after a refusal each is fenced on a
      revision that is now stale. A bulk hide keeps its other tasks. */
  dropTask(taskId: string): void {
    const keep = (entry: HistoryEntry): boolean => {
      if (entry.kind !== "hide") return entry.taskId !== taskId;
      entry.tasks = entry.tasks.filter((task) => task.taskId !== taskId);
      return entry.tasks.length > 0;
    };
    this.undoStack = this.undoStack.filter(keep);
    this.redoStack = this.redoStack.filter(keep);
  }

  /** What is on the stacks, oldest first, for tests. */
  entries(): { undo: readonly HistoryEntry[]; redo: readonly HistoryEntry[] } {
    return { undo: [...this.undoStack], redo: [...this.redoStack] };
  }
}
