"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { fireTasksChanged } from "@/components/tasks/taskApi";
import type { BoardTask, TaskColor, TaskStatus } from "@/lib/tasks/types";

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
 *
 * Field edits (#1695 K4b) — the colour label, the group hide and the task's
 * text — ride the same per-task queue and the same revision memory, so an edit
 * and a status move of one task never race each other's guard. Their 409 is
 * read the same way:
 * - the server already holds the value: settled;
 * - a colour or a hide: sent once more with the stored guard, since the label
 *   and the hide say nothing about what else changed;
 * - text: sent again only while the stored text is still the text the edit
 *   started from; otherwise the edit is a conflict and the caller shows both.
 * A refusal with its own code (a protected seat) is final and rolls back.
 */

export type StatusMoveOutcome =
  | { kind: "noop" }
  | { kind: "saved"; task: BoardTask; from: TaskStatus; to: TaskStatus }
  | { kind: "settled"; task: BoardTask; from: TaskStatus; to: TaskStatus }
  | { kind: "conflict"; task: BoardTask; from: TaskStatus; to: TaskStatus; serverStatus: TaskStatus }
  | { kind: "failed"; from: TaskStatus; to: TaskStatus; error: string; status: number };

export type PatchResult = { ok: true; task: BoardTask } | { ok: false; status: number; error: string; code?: string };

export type TaskFieldChange =
  | { field: "color"; value: TaskColor | null }
  | { field: "hide"; value: boolean }
  | { field: "text"; value: string };

export type TaskField = TaskFieldChange["field"];

/** What an edit resolved to. `value` is the field's value as the board should
    now show it: the new one after a save, the stored one after a conflict or
    a settle, the previous one after a refusal. */
export type FieldEditOutcome =
  | { kind: "noop"; field: TaskField }
  | { kind: "saved" | "settled"; field: TaskField; task: BoardTask }
  | { kind: "conflict"; field: TaskField; task: BoardTask; serverValue: unknown }
  | { kind: "failed"; field: TaskField; error: string; status: number; code?: string };

export type PatchBody = { expectedProject: string; expectedRevision: string } & ({ status: TaskStatus } | { color: TaskColor | "none" } | { hide: boolean } | { text: string });

export interface TaskMutationPorts {
  patch(id: string, body: PatchBody): Promise<PatchResult>;
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

interface FieldOverride {
  value: unknown;
  pending: number;
  baseRevision: string | null;
  confirmedRevision: string | null;
}

/** The field as a stored row holds it. */
export function fieldValue(task: BoardTask, field: TaskField): unknown {
  if (field === "color") return task.color ?? null;
  if (field === "hide") return Boolean(task.groupHidden);
  return task.text;
}

/** The edits a board shows ahead of the poll, per task. */
export type FieldEdits = ReadonlyMap<string, { color?: TaskColor | null; hide?: boolean; text?: string }>;

export function revisionOf(task: BoardTask): string | null {
  const revision = (task as BoardTask & { revision?: unknown }).revision;
  return typeof revision === "string" ? revision : null;
}

export class TaskStatusMutations {
  private readonly overrides = new Map<string, Override>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** The newest stored revision and project this device has seen per task. */
  private readonly known = new Map<string, { revision: string; project: string; status: TaskStatus }>();
  /** Revisions this device's own writes replaced: a poll still carrying one
      of them is older than what `known` holds and must not replace it. */
  private readonly replaced = new Map<string, Set<string>>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlyMap<string, TaskStatus> = new Map();
  private readonly fieldOverrides = new Map<string, Map<TaskField, FieldOverride>>();
  private fieldSnapshot: FieldEdits = new Map();

  constructor(private readonly ports: TaskMutationPorts) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  statuses = (): ReadonlyMap<string, TaskStatus> => this.snapshot;

  edits = (): FieldEdits => this.fieldSnapshot;

  pending(id: string): boolean {
    if ((this.overrides.get(id)?.pending ?? 0) > 0) return true;
    for (const override of this.fieldOverrides.get(id)?.values() ?? []) if (override.pending > 0) return true;
    return false;
  }

  private emit(): void {
    this.snapshot = new Map([...this.overrides].map(([id, override]) => [id, override.status] as const));
    this.fieldSnapshot = new Map([...this.fieldOverrides].map(([id, fields]) => [id, Object.fromEntries([...fields].map(([field, override]) => [field, override.value]))] as const));
    for (const listener of this.listeners) listener();
  }

  /** Apply a poll: drop optimistic statuses the stored rows have caught up
      with, and adopt a newer revision written elsewhere so the next move is
      guarded by it instead of paying a 409 and a read. */
  reconcile(tasks: readonly BoardTask[]): void {
    let changed = false;
    const byId = new Map(tasks.map((task) => [task.id, task] as const));
    for (const [id, known] of this.known) {
      if (this.pending(id)) continue;
      const row = byId.get(id);
      const revision = row ? revisionOf(row) : null;
      if (!row || !revision || revision === known.revision || this.replaced.get(id)?.has(revision)) continue;
      /* The stored project is kept: a poll row carries the display-remapped
         project name, which the guard must not adopt. */
      this.known.set(id, { revision, project: known.project, status: row.status });
    }
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
    for (const [id, fields] of this.fieldOverrides) {
      const row = byId.get(id);
      const revision = row ? revisionOf(row) : null;
      for (const [field, override] of fields) {
        if (override.pending > 0) continue;
        const caughtUp = !row
          || fieldValue(row, field) === override.value
          || (revision !== null && revision === override.confirmedRevision)
          || (revision !== null && revision !== override.baseRevision && revision !== override.confirmedRevision);
        if (caughtUp) {
          fields.delete(field);
          changed = true;
        }
      }
      if (!fields.size) this.fieldOverrides.delete(id);
    }
    if (changed) this.emit();
  }

  /** Edit one field of `task`. Resolves once the server has answered. */
  edit(task: BoardTask, change: TaskFieldChange): Promise<FieldEditOutcome> {
    const id = task.id;
    const fields = this.fieldOverrides.get(id) ?? new Map<TaskField, FieldOverride>();
    const current = fields.get(change.field);
    const from = current ? current.value : fieldValue(task, change.field);
    if (from === change.value && !current?.pending) return Promise.resolve({ kind: "noop", field: change.field });
    const override: FieldOverride = current ?? { value: change.value, pending: 0, baseRevision: revisionOf(task), confirmedRevision: null };
    override.value = change.value;
    override.pending += 1;
    fields.set(change.field, override);
    this.fieldOverrides.set(id, fields);
    this.emit();

    const previous = this.chains.get(id) ?? Promise.resolve();
    const run = previous.then(() => this.writeField(task, change, from), () => this.writeField(task, change, from));
    this.chains.set(id, run);
    void run.finally(() => {
      if (this.chains.get(id) === run) this.chains.delete(id);
    });
    return run;
  }

  private settleField(id: string, field: TaskField, value: unknown, confirmed: string | null, keep: boolean): void {
    const fields = this.fieldOverrides.get(id);
    const override = fields?.get(field);
    if (!fields || !override) return;
    override.pending = Math.max(0, override.pending - 1);
    if (override.pending === 0) {
      if (keep) {
        override.value = value;
        override.confirmedRevision = confirmed;
      } else {
        fields.delete(field);
        if (!fields.size) this.fieldOverrides.delete(id);
      }
    }
    this.emit();
  }

  private bodyFor(change: TaskFieldChange, guard: { project: string; revision: string }): PatchBody {
    const fence = { expectedProject: guard.project, expectedRevision: guard.revision };
    if (change.field === "color") return { ...fence, color: change.value ?? "none" };
    if (change.field === "hide") return { ...fence, hide: change.value };
    return { ...fence, text: change.value };
  }

  private async writeField(task: BoardTask, change: TaskFieldChange, from: unknown): Promise<FieldEditOutcome> {
    const id = task.id;
    const field = change.field;
    const failed = (status: number, error: string, code?: string): FieldEditOutcome => {
      this.settleField(id, field, from, null, false);
      return { kind: "failed", field, error, status, ...(code ? { code } : {}) };
    };
    let guard = this.guardFor(task);
    if (!guard) {
      const stored = await this.readSafely(id);
      if (!stored) return failed(404, "task not found");
      this.remember(stored);
      guard = this.guardFor(stored)!;
    }
    const first = await this.patchSafely(id, this.bodyFor(change, guard));
    const savedField = (saved: BoardTask, replacing: string | null): FieldEditOutcome => {
      this.remember(saved, replacing);
      this.settleField(id, field, change.value, revisionOf(saved), true);
      this.ports.changed();
      return { kind: "saved", field, task: saved };
    };
    if (first.ok) return savedField(first.task, guard.revision);
    if (first.status !== 409 || (first.code && first.code !== "TASK_REVISION_MISMATCH" && first.code !== "TASK_PROJECT_MISMATCH")) {
      return failed(first.status, first.error, first.code);
    }

    const stored = await this.readSafely(id);
    if (!stored) return failed(404, "task not found");
    this.remember(stored);
    const storedValue = fieldValue(stored, field);
    if (storedValue === change.value) {
      this.settleField(id, field, change.value, revisionOf(stored), true);
      this.ports.changed();
      return { kind: "settled", field, task: stored };
    }
    if (field !== "text" || storedValue === from) {
      const retry = await this.patchSafely(id, this.bodyFor(change, { project: stored.project, revision: revisionOf(stored) ?? "" }));
      if (retry.ok) return savedField(retry.task, revisionOf(stored));
      return failed(retry.status, retry.error, retry.code);
    }
    this.settleField(id, field, storedValue, revisionOf(stored), true);
    this.ports.changed();
    return { kind: "conflict", field, task: stored, serverValue: storedValue };
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

  private remember(task: BoardTask, replacing: string | null = null): void {
    const revision = revisionOf(task);
    if (!revision) return;
    if (replacing && replacing !== revision) {
      const set = this.replaced.get(task.id) ?? new Set<string>();
      set.add(replacing);
      if (set.size > 16) set.delete(set.values().next().value!);
      this.replaced.set(task.id, set);
    }
    this.known.set(task.id, { revision, project: task.project, status: task.status });
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
    if (first.ok) return this.saved(first.task, from, to, guard.revision);
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
      if (retry.ok) return this.saved(retry.task, from, to, revisionOf(stored));
      return this.fail(id, from, to, retry.status, retry.error);
    }
    this.settle(id, stored.status, revisionOf(stored), true);
    this.ports.changed();
    return { kind: "conflict", task: stored, from, to, serverStatus: stored.status };
  }

  private saved(task: BoardTask, from: TaskStatus, to: TaskStatus, replacing: string | null): StatusMoveOutcome {
    this.remember(task, replacing);
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

  private async patchSafely(id: string, body: PatchBody): Promise<PatchResult> {
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
    const json = (await response.json().catch(() => null)) as { task?: BoardTask; error?: string; code?: string } | null;
    if (response.ok && json?.task) return { ok: true, task: json.task };
    return { ok: false, status: response.status, error: json?.error ?? `HTTP ${response.status}`, ...(json?.code ? { code: json.code } : {}) };
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
  const edits = useSyncExternalStore(controller.subscribe, controller.edits, controller.edits);
  useEffect(() => { controller.reconcile(tasks); }, [controller, tasks]);
  return { controller, statuses, edits };
}
