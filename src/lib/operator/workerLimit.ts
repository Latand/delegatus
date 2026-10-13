import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

export const WORKER_LIMIT_DEFAULT = 3;
export const WORKER_LIMIT_MIN = 1;
export const WORKER_LIMIT_MAX = 64;
export type WorkerLimitSource = "default" | "machine" | "project";
export interface WorkerLimitActor {
  kind: "operator" | "manager" | "gateway";
  conversationId?: string | null;
  project?: string | null;
  via: string;
}
interface Entry { value: number; changedAt: string; changedBy: WorkerLimitActor; reason: string | null }
interface History {
  at: string; scope: "machine" | "project"; project: string | null;
  from: number | null; to: number | null; by: WorkerLimitActor;
  reason: string | null; clientRequestId: string | null;
}
export interface WorkerLimits {
  schemaVersion: 1; machine: Entry | null; projects: Record<string, Entry>;
  history: History[]; unreadable?: boolean;
}
let cache: { file: string; mtime: number; size: number; value: WorkerLimits } | null = null;
const empty = (): WorkerLimits => ({ schemaVersion: 1, machine: null, projects: {}, history: [] });
export const isWorkerLimit = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= WORKER_LIMIT_MIN && value <= WORKER_LIMIT_MAX;
function entry(value: unknown): Entry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Entry;
  return isWorkerLimit(row.value) && typeof row.changedAt === "string" && row.changedBy && typeof row.changedBy === "object" ? row : null;
}
/** One stat per read; callers receive copies so no reader can mutate the cache. */
export function readWorkerLimits(): WorkerLimits {
  const file = statePath("worker-limit.json");
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch (error) {
    return { ...empty(), ...((error as NodeJS.ErrnoException).code === "ENOENT" ? {} : { unreadable: true }) };
  }
  if (cache?.file === file && cache.mtime === stat.mtimeMs && cache.size === stat.size) return structuredClone(cache.value);
  const value = empty();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed.schemaVersion !== 1 || !parsed.projects || typeof parsed.projects !== "object" || Array.isArray(parsed.projects) || !Array.isArray(parsed.history)) throw new Error("invalid worker limit file");
    value.machine = entry(parsed.machine);
    value.projects = Object.fromEntries(Object.entries(parsed.projects).flatMap(([key, row]) => {
      const valid = entry(row);
      return valid ? [[key, valid]] : [];
    }));
    value.history = parsed.history.slice(-500);
    if ((parsed.machine != null && !value.machine) || Object.keys(parsed.projects).length !== Object.keys(value.projects).length) value.unreadable = true;
  } catch { value.unreadable = true; }
  cache = { file, mtime: stat.mtimeMs, size: stat.size, value };
  return structuredClone(value);
}
export function effectiveWorkerLimit(project: string) {
  const stored = readWorkerLimits();
  const own = projectWorkerLimit(project, stored);
  const machine = stored.machine?.value ?? WORKER_LIMIT_DEFAULT;
  return { value: own?.value ?? machine, source: (own ? "project" : stored.machine ? "machine" : "default") as WorkerLimitSource, machine };
}
/** A moved key can still have its override stored under its predecessor. */
export function projectWorkerLimit(project: string, stored = readWorkerLimits()): Entry | null {
  const key = canonicalProject(project);
  return stored.projects[key] ?? stored.projects[project]
    ?? Object.entries(stored.projects).find(([candidate]) => canonicalProject(candidate) === key)?.[1] ?? null;
}
function setLimit(project: string | null, value: number | null, actor: WorkerLimitActor, reason: string | null, requestId: string | null) {
  if (value !== null && !isWorkerLimit(value)) throw new Error("worker limit must be an integer from 1 to 64");
  if (actor.kind !== "operator" && (!reason?.trim() || reason.trim().length > 300)) throw new Error("worker limit reason is required (1 to 300 characters)");
  const key = project === null ? null : canonicalProject(project.trim());
  if (key === "") throw new Error("project is required");
  const file = statePath("worker-limit.json");
  return withFileTransactionSync(file, "worker limit store is busy", () => {
    cache = null;
    const stored = readWorkerLimits();
    // A malformed existing record cannot supply a truthful audit predecessor.
    if (stored.unreadable) throw new Error("worker limit store is unreadable");
    const current = key === null ? stored.machine : projectWorkerLimit(project!, stored);
    const from = current?.value ?? (key === null ? WORKER_LIMIT_DEFAULT : null);
    const scope: History["scope"] = key === null ? "machine" : "project";
    const replay = requestId ? stored.history.find(row => row.clientRequestId === requestId) : null;
    if (replay) {
      if (replay.project !== key || replay.to !== value || replay.reason !== reason || JSON.stringify(replay.by) !== JSON.stringify(actor)) throw new Error("worker limit request id already used");
      return { changed: false, scope, project: key, from: replay.from, to: replay.to, effective: effectiveWorkerLimit(key ?? "").value };
    }
    const changed = value === null ? !!current : current?.value !== value;
    if (!changed) return { changed: false, scope, project: key, from, to: value, effective: effectiveWorkerLimit(key ?? "").value };
    const at = new Date().toISOString();
    const next = value === null ? null : { value, changedAt: at, changedBy: actor, reason };
    if (key === null) stored.machine = next;
    else {
      for (const candidate of Object.keys(stored.projects)) if (canonicalProject(candidate) === key) delete stored.projects[candidate];
      if (next) stored.projects[key] = next;
      else delete stored.projects[key];
    }
    stored.history = [...stored.history, { at, scope, project: key, from, to: value, by: actor, reason, clientRequestId: requestId }].slice(-500);
    const temporary = path.join(path.dirname(file), `.worker-limit.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(stored) + "\n", { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
      cache = null;
    }
    return { changed: true, scope, project: key, from, to: value, effective: effectiveWorkerLimit(key ?? "").value };
  });
}
export function setMachineWorkerLimit(value: number | null, actor: WorkerLimitActor, reason: string | null, requestId: string | null = null) {
  return setLimit(null, value, actor, reason, requestId);
}
export function setProjectWorkerLimit(project: string, value: number | null, actor: WorkerLimitActor, reason: string | null, requestId: string | null = null) {
  return setLimit(project, value, actor, reason, requestId);
}
