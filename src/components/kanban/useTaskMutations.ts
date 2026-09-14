"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { fireTasksChanged } from "@/components/tasks/taskApi";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";

/**
 * Optimistic status moves for the kanban board (#1695 K2).
 *
 * A move shows at once and is written with the task's revision as a guard, so
 * a stale view can never silently overwrite a change made elsewhere. One write
 * per task is in flight at a time; later moves of the same task queue behind
 * it and form their guard from the revision the previous write returned.
 *
 * A 409 is answered by reading the stored task, never by guessing:
 * - the server already holds the target status: the move is settled;
 * - the stored status is still the one this move started from (only other
 *   fields moved, or the guard carried a display-remapped project): the write
 *   is sent once more with the stored guard;
 * - the status was changed elsewhere: the card goes to the server's column and
 *   the operator decides whether to move it anyway.
 *
 * The optimistic status stays until the poll shows the write (its revision or
 * its status) or shows a newer write, so a card never blinks back to its old
 * column between the response and the next poll.
 */

export type StatusMoveOutcome =
  | { kind: "noop" }
  | { kind: "saved"; task: BoardTask; from: TaskStatus; to: TaskStatus }
  | { kind: "settled"; task: BoardTask; from: TaskStatus; to: TaskStatus }
  | { kind: "conflict"; task: BoardTask; from: TaskStatus; to: TaskStatus; serverStatus: TaskStatus }
  | { kind: "failed"; from: TaskStatus; to: TaskStatus; error: string; status: number };

export type PatchResult = { ok: true; task: BoardTask } | { ok: false; status: number; error: string };

export interface TaskMutationPorts {
  patch(id: string, body: { status: TaskStatus; expectedProject: string; expectedRevision: string }): Promise<PatchResult>;
  /** The stored task, unremapped, or null when it no longer exists. */
  read(id: string): Promise<BoardTask | null>;
  /** A write landed: pollers should refresh. */
  changed(): void;
}

interface Override {
  status: TaskStatus;
  /** Writes of this task still in flight. */
  pending: number;
  /** Revision the poll read before the first queued write. */
  baseRevision: string | null;
  /** Revision the server confirmed for the latest settled write. */
  confirmedRevision: string | null;
}

export function revisionOf(task: BoardTask): string | null {
  const revision = (task as BoardTask & { revision?: unknown }).revision;
  return typeof revision === "string" ? revision : null;
}

export class TaskStatusMutations {
  private readonly overrides = new Map<string, Override>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** The newest stored revision and project this device has seen per task. */
  private readonly known = new Map<string, { revision: string; project: string; status: TaskStatus }>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlyMap<string, TaskStatus> = new Map();

  constructor(private readonly ports: TaskMutationPorts) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  statuses = (): ReadonlyMap<string, TaskStatus> => this.snapshot;

  pending(id: string): boolean {
    return (this.overrides.get(id)?.pending ?? 0) > 0;
  }

  private emit(): void {
    this.snapshot = new Map([...this.overrides].map(([id, override]) => [id, override.status] as const));
    for (const listener of this.listeners) listener();
  }

  /** Apply a poll: drop optimistic statuses the stored rows have caught up with. */
  reconcile(tasks: readonly BoardTask[]): void {
    let changed = false;
    const byId = new Map(tasks.map((task) => [task.id, task] as const));
    for (const [id, override] of this.overrides) {
      if (override.pending > 0) continue;
      const row = byId.get(id);
      const revision = row ? revisionOf(row) : null;
      const caughtUp = !row
        || row.status === override.status
        || (revision !== null && revision === override.confirmedRevision)
        || (revision !== null && revision !== override.baseRevision && revision !== override.confirmedRevision);
      if (caughtUp) {
        this.overrides.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Move `task` to `to`. Resolves once the server has answered. */
  move(task: BoardTask, to: TaskStatus): Promise<StatusMoveOutcome> {
    const id = task.id;
    const current = this.overrides.get(id);
    const from = current?.status ?? task.status;
    if (from === to && !current?.pending) return Promise.resolve({ kind: "noop" });
    const override: Override = current ?? { status: to, pending: 0, baseRevision: revisionOf(task), confirmedRevision: null };
    override.status = to;
    override.pending += 1;
    this.overrides.set(id, override);
    this.emit();

    const previous = this.chains.get(id) ?? Promise.resolve();
    const run = previous.then(() => this.write(task, from, to), () => this.write(task, from, to));
    this.chains.set(id, run);
    void run.finally(() => {
      if (this.chains.get(id) === run) this.chains.delete(id);
    });
    return run;
  }

  private remember(task: BoardTask): void {
    const revision = revisionOf(task);
    if (revision) this.known.set(task.id, { revision, project: task.project, status: task.status });
  }

  private guardFor(task: BoardTask): { project: string; revision: string } | null {
    const known = this.known.get(task.id);
    if (known) return { project: known.project, revision: known.revision };
    const revision = revisionOf(task);
    return revision ? { project: task.project, revision } : null;
  }

  private settle(id: string, status: TaskStatus, confirmed: string | null, keep: boolean): void {
    const override = this.overrides.get(id);
    if (!override) return;
    override.pending = Math.max(0, override.pending - 1);
    if (override.pending === 0) {
      if (keep) {
        override.status = status;
        override.confirmedRevision = confirmed;
      } else {
        this.overrides.delete(id);
      }
    }
    this.emit();
  }

  private async write(task: BoardTask, from: TaskStatus, to: TaskStatus): Promise<StatusMoveOutcome> {
    const id = task.id;
    let guard = this.guardFor(task);
    if (!guard) {
      const stored = await this.readSafely(id);
      if (!stored) return this.fail(id, from, to, 404, "task not found");
      this.remember(stored);
      guard = this.guardFor(stored)!;
    }
    const first = await this.patchSafely(id, { status: to, expectedProject: guard.project, expectedRevision: guard.revision });
    if (first.ok) return this.saved(first.task, from, to);
    if (first.status !== 409) return this.fail(id, from, to, first.status, first.error);

    const stored = await this.readSafely(id);
    if (!stored) return this.fail(id, from, to, 404, "task not found");
    this.remember(stored);
    if (stored.status === to) {
      this.settle(id, to, revisionOf(stored), true);
      this.ports.changed();
      return { kind: "settled", task: stored, from, to };
    }
    if (stored.status === from || revisionOf(stored) === guard.revision) {
      const retry = await this.patchSafely(id, { status: to, expectedProject: stored.project, expectedRevision: revisionOf(stored) ?? "" });
      if (retry.ok) return this.saved(retry.task, from, to);
      return this.fail(id, from, to, retry.status, retry.error);
    }
    this.settle(id, stored.status, revisionOf(stored), true);
    this.ports.changed();
    return { kind: "conflict", task: stored, from, to, serverStatus: stored.status };
  }

  private saved(task: BoardTask, from: TaskStatus, to: TaskStatus): StatusMoveOutcome {
    this.remember(task);
    this.settle(task.id, to, revisionOf(task), true);
    this.ports.changed();
    return { kind: "saved", task, from, to };
  }

  private fail(id: string, from: TaskStatus, to: TaskStatus, status: number, error: string): StatusMoveOutcome {
    /* The card returns to where this move started. When the server is known
       to hold that status (an earlier queued move landed it), it stays there
       until the poll catches up instead of blinking back to an older row. */
    const known = this.known.get(id);
    const hold = known?.status === from;
    this.settle(id, from, hold ? known!.revision : null, hold);
    return { kind: "failed", from, to, error, status };
  }

  private async patchSafely(id: string, body: { status: TaskStatus; expectedProject: string; expectedRevision: string }): Promise<PatchResult> {
    try {
      return await this.ports.patch(id, body);
    } catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async readSafely(id: string): Promise<BoardTask | null> {
    try {
      return await this.ports.read(id);
    } catch {
      return null;
    }
  }
}

export const browserTaskMutationPorts: TaskMutationPorts = {
  async patch(id, body) {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as { task?: BoardTask; error?: string } | null;
    if (response.ok && json?.task) return { ok: true, task: json.task };
    return { ok: false, status: response.status, error: json?.error ?? `HTTP ${response.status}` };
  },
  async read(id) {
    const response = await fetch("/api/tasks", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as { tasks?: BoardTask[] };
    return json.tasks?.find((task) => task.id === id) ?? null;
  },
  changed: fireTasksChanged,
};

/** One controller per board mount; statuses re-render the board as they move. */
export function useTaskMutations(tasks: readonly BoardTask[], ports: TaskMutationPorts = browserTaskMutationPorts) {
  const portsRef = useRef(ports);
  const controller = useMemo(() => new TaskStatusMutations({
    patch: (id, body) => portsRef.current.patch(id, body),
    read: (id) => portsRef.current.read(id),
    changed: () => portsRef.current.changed(),
  }), []);
  useEffect(() => { portsRef.current = ports; }, [ports]);
  const statuses = useSyncExternalStore(controller.subscribe, controller.statuses, controller.statuses);
  useEffect(() => { controller.reconcile(tasks); }, [controller, tasks]);
  return { controller, statuses };
}
