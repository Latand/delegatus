import { withFileTransaction } from "@/lib/state/fileTransaction";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { importCollection } from "./importStore";
import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { waitForStateLock } from "@/lib/state/lockWait";

export type MemorySource = "delegatus" | "engines";
export type MemoryPhase = "importing" | "draining" | "active";
export interface MemorySourceFile {
  schemaVersion: 1;
  source: MemorySource;
  changedAt: string;
  importId?: string;
  phase?: MemoryPhase;
  importStartedAt?: string;
  flippedAt?: string;
  drainedAt?: string;
}

type Cache = { file: string; mtimeMs: number; size: number; value: MemorySourceFile | null };
// Next's compiled entry points share one bounded owner. Changing state roots
// replaces this single entry; no installation history is retained in memory.
const host = globalThis as typeof globalThis & { __delegatusMemorySource?: Cache };
const MAX_BYTES = 8192;

function parse(value: unknown): MemorySourceFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || (row.source !== "delegatus" && row.source !== "engines")
    || typeof row.changedAt !== "string" || !Number.isFinite(Date.parse(row.changedAt))) return null;
  if (row.phase !== undefined && !["importing", "draining", "active"].includes(row.phase as string)) return null;
  if (row.source === "delegatus" && row.phase === undefined) return null;
  if (row.importId !== undefined && (typeof row.importId !== "string" || !row.importId || row.importId.length > 256)) return null;
  for (const key of ["importStartedAt", "flippedAt", "drainedAt"] as const) {
    if (row[key] !== undefined && (typeof row[key] !== "string" || !Number.isFinite(Date.parse(row[key])))) return null;
  }
  return {
    schemaVersion: 1, source: row.source, changedAt: row.changedAt,
    ...(row.phase !== undefined ? { phase: row.phase as MemoryPhase } : {}),
    ...(row.importId !== undefined ? { importId: row.importId as string } : {}),
    ...Object.fromEntries(["importStartedAt", "flippedAt", "drainedAt"].flatMap(key => row[key] === undefined ? [] : [[key, row[key]]])),
  };
}

/** Missing or malformed settings preserve the installation's existing output. */
export function readMemorySourceFile(): MemorySourceFile | null {
  return withViewerOperation("memory.source-read", readSource);
}

function readSource(): MemorySourceFile | null {
  const file = statePath("memory-source.json");
  let stat: fs.Stats;
  try { stat = fs.statSync(file); }
  catch { host.__delegatusMemorySource = undefined; return null; }
  const cached = host.__delegatusMemorySource;
  if (cached?.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value ? { ...cached.value } : null;
  let value: MemorySourceFile | null = null;
  if (stat.isFile() && stat.size <= MAX_BYTES) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "r");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes <= MAX_BYTES) value = parse(JSON.parse(buffer.toString("utf8", 0, bytes)));
    } catch { /* Unchosen. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  host.__delegatusMemorySource = { file, mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value ? { ...value } : null;
}

export function memorySource(): { choice: MemorySource | null; phase: MemoryPhase | null } {
  const row = readMemorySourceFile();
  return { choice: row?.source ?? null, phase: row?.phase ?? null };
}

export function engineMemoryOff({ cleanMemory = false }: { cleanMemory?: boolean } = {}): boolean {
  if (cleanMemory) return true;
  const { choice, phase } = memorySource();
  return choice === "delegatus" && (phase === "draining" || phase === "active");
}

/** The route supplies async state admission; this bounded write never reads an engine home. */
export function setMemorySource(source: MemorySource, now = new Date().toISOString()): "first_choice_delegatus" | null {
  const current = readMemorySourceFile();
  if (current?.source === source) return null;
  if (source === "engines" && !current) return "first_choice_delegatus";
  if (source === "delegatus") {
    const id = `import_${randomUUID()}`;
    importCollection(true)!.boundedPatch(2, tx => tx.put({ kind: "import", id, state: "copying", at: now, previous: current,
      backup: statePath(path.join("backups", "engine-memory", id)), files: 0, candidates: 0, parts: 0 }));
    writeSource({ schemaVersion: 1, source, phase: "importing", changedAt: now, importId: id, importStartedAt: now });
  } else writeSource({ ...current!, source, changedAt: now });
  return null;
}
function writeSource(row: MemorySourceFile) {
  withViewerOperation("memory.source-write", () => writeJsonDurably(statePath("memory-source.json"), row));
  host.__delegatusMemorySource = undefined;
}
function sourceTransaction<T>(operation: () => T | Promise<T>) {
  const file = statePath("memory-source.json");
  for (const [target, directory] of [[`${file}.write-locks`, true], [`${file}.write-lock`, false]] as const) {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw Error("memory source lock unavailable");
  }
  return withFileTransaction(file, "memory source busy", operation);
}
export async function selectMemorySource(source: MemorySource, now = new Date().toISOString()) {
  return withViewerOperation("memory.source-write", () => sourceTransaction(() => waitForStateLock("memory.source.select", () => setMemorySource(source, now))));
}
export async function advanceMemorySource(importId: string, phase: "draining" | "active", at?: string, guard: () => boolean = () => true) {
  return sourceTransaction(() => waitForStateLock("memory.import.flip", () => {
    const current = readMemorySourceFile();
    const expected = phase === "draining" ? "importing" : "draining";
    if (!guard() || current?.source !== "delegatus" || current.importId !== importId || current.phase !== expected) return false;
    at ??= new Date().toISOString();
    writeSource({ ...current, phase, ...(phase === "draining" ? { flippedAt: at } : { drainedAt: at }) });
    return true;
  }));
}

/** Restore only while this import still owns the importing choice. UI choices
 * already have a lock queue. Legacy preflight recovery creates no sidecars. */
export async function restoreMemorySourceAfterImport(importId: string, previous: MemorySourceFile | null): Promise<void> {
  const restore = () => waitForStateLock("memory.import.restore", () => withViewerOperation("memory.source-write", () => {
    const current = readMemorySourceFile();
    if (current?.source !== "delegatus" || current.phase !== "importing" || current.importId !== importId) return;
    if (previous) writeJsonDurably(statePath("memory-source.json"), previous);
    else fs.unlinkSync(statePath("memory-source.json"));
    host.__delegatusMemorySource = undefined;
  }));
  let queued = false;
  try { fs.lstatSync(statePath("memory-source.json.write-locks")); queued = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (queued) await sourceTransaction(restore); else await restore();
}
