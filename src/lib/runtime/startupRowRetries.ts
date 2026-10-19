import { isMissingCodexRolloutError } from "./hostEndCause";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRegistry, AgentRegistryEntry } from "@/lib/agent/registry";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { operatorLocale } from "@/lib/operator/settings";
import { statePath } from "@/lib/configDir";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { createTask, patchTask } from "@/lib/tasks/commands";
import { mutateTasksAsync } from "@/lib/tasks/store";

export type StartupRowReason = "missing-rollout" | "adoption-failed" | "incumbent-owned";
export interface StartupRowRetry {
  key: string;
  attempts: number;
  reason: StartupRowReason;
  nextAt: number;
  quarantined: boolean;
  /** Hosting settled; only closing the durable notice remains. */
  resolved?: boolean;
  noticePending?: boolean;
}

export function startupRowReason(error: unknown): StartupRowReason {
  return isMissingCodexRolloutError(error)
    ? "missing-rollout" : "adoption-failed";
}

const id = (key: string) => crypto.createHash("sha256").update(key).digest("hex");
const INITIAL_MS = 1_000;
const QUARANTINE_AFTER = 3;
const MAX_MS = 15 * 60_000;

/** One owner per registry, including separately compiled Next server entries.
 * Only active startup rows are loaded; a successful reconciliation evicts its
 * record and timer. Retry clocks survive Viewer replacement. No registry schema
 * or process ownership is changed by quarantine. */
export class StartupRowRetries {
  private readonly rows = new Map<string, StartupRowRetry>();
  private readonly scheduled = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}

  get(key: string): StartupRowRetry | undefined { return this.rows.get(key); }
  due(key: string, now = Date.now()): boolean { return (this.rows.get(key)?.nextAt ?? 0) <= now; }

  async load(keys: readonly string[]): Promise<void> {
    try { await fs.access(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const key of keys) {
      if (this.rows.has(key)) continue;
      try {
        const row = JSON.parse(await fs.readFile(this.file(key), "utf8")) as StartupRowRetry;
        if (row.key !== key || !Number.isSafeInteger(row.attempts) || row.attempts < 1
          || !Number.isSafeInteger(row.nextAt) || row.nextAt < 0
          || !["missing-rollout", "adoption-failed", "incumbent-owned"].includes(row.reason)
          || (row.resolved !== undefined && typeof row.resolved !== "boolean")
          || (row.noticePending !== undefined && typeof row.noticePending !== "boolean")
          || row.quarantined !== (row.attempts >= QUARANTINE_AFTER)) throw new Error("invalid structured startup retry record");
        this.rows.set(key, row);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async failed(key: string, reason: StartupRowReason, now = Date.now(), assertActive = () => {}, resolved = false): Promise<StartupRowRetry> {
    const previous = this.rows.get(key);
    const attempts = Math.min((previous?.attempts ?? 0) + 1, 1_000_000);
    const quarantined = attempts >= QUARANTINE_AFTER;
    const delay = quarantined
      ? Math.min(60_000 * 2 ** Math.min(attempts - QUARANTINE_AFTER, 4), MAX_MS)
      : INITIAL_MS * 2 ** (attempts - 1);
    const retainedReason = previous?.reason === "missing-rollout" && reason === "incumbent-owned" ? previous.reason : reason;
    const row: StartupRowRetry = { key, attempts, reason: retainedReason,
      nextAt: now + delay, quarantined,
      noticePending: quarantined && (!previous?.quarantined || retainedReason !== previous.reason || previous.noticePending === true),
      ...((resolved || previous?.resolved) ? { resolved: true } : {}) };
    await this.save(row, assertActive);
    console.error(`[structured hosts] row ${quarantined ? "quarantined" : "deferred"}; retrying alone`, row);
    return row;
  }

  async notified(row: StartupRowRetry, assertActive = () => {}): Promise<void> {
    if (this.rows.get(row.key) !== row) return;
    await this.save({ ...row, noticePending: false }, assertActive);
  }

  private async save(row: StartupRowRetry, assertActive: () => void): Promise<void> {
    const key = row.key;
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = `${this.file(key)}.${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, JSON.stringify(row), { mode: 0o600, flag: "wx" });
      assertActive();
      await fs.rename(temporary, this.file(key));
    } finally { await fs.rm(temporary, { force: true }); }
    this.rows.set(key, row);
  }

  async clear(key: string, assertActive = () => {}): Promise<void> {
    assertActive();
    await fs.rm(this.file(key), { force: true });
    this.rows.delete(key);
  }

  schedule(key: string, schedule: (callback: () => void, delay: number) => { unref?(): void }, retry: () => Promise<void>): void {
    const row = this.rows.get(key);
    if (!row || this.scheduled.has(key)) return;
    this.scheduled.add(key);
    schedule(() => {
      this.scheduled.delete(key);
      if (!this.rows.has(key)) return;
      // Two timers becoming due together must each reconcile their own scope.
      this.tail = this.tail.catch(() => {}).then(async () => {
        try { await fs.access(this.file(key)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.rows.delete(key); return; }
          console.error("[structured hosts] row retry journal is unavailable", { key });
        }
        await withViewerOperation("runtime.startup-row", retry);
      });
      void this.tail.catch(() => {}); // The caller records and reschedules failures.
    }, Math.max(INITIAL_MS, row.nextAt - Date.now())).unref?.();
  }

  private file(key: string): string { return path.join(this.directory, `${id(key)}.json`); }
}

const shared = process as typeof process & { __llvStartupRowRetries?: WeakMap<AgentRegistry, StartupRowRetries> };
export function startupRowRetries(registry: AgentRegistry): StartupRowRetries {
  const stores = shared.__llvStartupRowRetries ??= new WeakMap();
  let store = stores.get(registry);
  if (!store) { store = new StartupRowRetries(`${registry.filename}.startup-retries`); stores.set(registry, store); }
  return store;
}

/** Uses the existing task write admission. A deterministic item survives
 * restarts and is available to the project's seat through list_tasks. */
export async function startupRowNotice(entry: AgentRegistryEntry, row: StartupRowRetry | null, assertActive = () => {}): Promise<void> {
  const key = `${entry.key.engine}:${entry.key.sessionId}`;
  const hash = id(key);
  // A deterministic UUIDv8 keeps retries idempotent and passes older peers'
  // task schemas. Keep finding legacy notices so they can still be resolved.
  const taskId = [hash.slice(0, 8), hash.slice(8, 12), `8${hash.slice(13, 16)}`, `8${hash.slice(17, 20)}`, hash.slice(20, 32)].join("-");
  const legacyId = `startup-quarantine-${hash.slice(0, 32)}`;
  const project = projectInfoFromCwd(entry.cwd)?.project;
  if (!project) throw new Error("structured startup quarantine project is unavailable");
  await mutateTasksAsync(tasks => {
    assertActive();
    const existing = tasks.find(task => task.id === taskId) ?? tasks.find(task => task.id === legacyId);
    if (!row) {
      if (!existing || existing.status === "done") return { tasks: undefined, result: undefined };
      const closed = patchTask(tasks, existing.id, { status: "done" });
      if (!closed.ok) throw new Error(closed.error);
      return { tasks: closed.tasks, result: undefined };
    }
    const text = operatorLocale() === "en"
      ? `Structured host startup quarantine\n\n${key}\nReason: ${row.reason}. Only this row retries with bounded backoff.`
      : `Карантин запуску structured-хоста\n\n${key}\nПричина: ${row.reason}. Повторюється лише цей рядок із обмеженою затримкою.`;
    if (existing) {
      if (existing.text === text && existing.status !== "done") return { tasks: undefined, result: undefined };
      const updated = patchTask(tasks, existing.id, { text, status: "inbox" });
      if (!updated.ok) throw new Error(updated.error);
      return { tasks: updated.tasks, result: undefined };
    }
    const created = createTask(tasks, { project, text, placement: "unplaced" }, [], { id: () => taskId });
    if (!created.ok) throw new Error(created.error);
    return { tasks: created.tasks, result: undefined };
  }, statePath("tasks.json"));
}
