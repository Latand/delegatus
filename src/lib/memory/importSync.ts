import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { readMemorySourceFile } from "./source";
import { roleMemorySelectorEnabled } from "./settings";
import type { ImportRecord } from "./importTypes";

/* The periodic sync of docs/design/memory-source-switch.md §4.9: while the
   engines' memory is selected, new or changed engine notes join the ready
   import as candidates on a bounded schedule, and the curator takes them in
   import passes. Every decision here reads two small records. */

export const MEMORY_SYNC_DEFAULT_HOURS = 24;
export const MEMORY_SYNC_MAX_HOURS = 168;
/** Files hashed per run after the size and modification-time prefilter. */
export const MEMORY_SYNC_MAX_FILES = 200;
export const MEMORY_SYNC_RETRY_MS = 60 * 60_000;
/** Past the helper's five-minute deadline, a run still marked running was stopped. */
const MEMORY_SYNC_STOPPED_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;

export function validSyncInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MEMORY_SYNC_MAX_HOURS;
}

type Cache = { file: string; mtimeMs: number; size: number; hours: number };
const host = globalThis as typeof globalThis & { __delegatusMemorySync?: Cache };

/** Hours between runs; 0 is off. A missing or malformed file reads as the default. */
export function memorySyncIntervalHours(): number {
  const file = statePath("memory-sync.json");
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { host.__delegatusMemorySync = undefined; return MEMORY_SYNC_DEFAULT_HOURS; }
  const cached = host.__delegatusMemorySync;
  if (cached?.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.hours;
  let hours = MEMORY_SYNC_DEFAULT_HOURS;
  if (stat.isFile() && stat.size <= 4096) {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value?.schemaVersion === 1 && validSyncInterval(value.intervalHours)) hours = value.intervalHours;
    } catch { /* The default. */ }
  }
  host.__delegatusMemorySync = { file, mtimeMs: stat.mtimeMs, size: stat.size, hours };
  return hours;
}

export function setMemorySyncInterval(hours: number, now = new Date().toISOString()): void {
  if (!validSyncInterval(hours)) throw Error("sync interval must be 0 (off) to 168 whole hours");
  writeJsonDurably(statePath("memory-sync.json"), { schemaVersion: 1, intervalHours: hours, changedAt: now });
  host.__delegatusMemorySync = undefined;
}

/** The import whose pending candidates the curator may take now, or null.
    Delegatus mode: the switch's import. The engines position: the same import
    while the sync is on. The emergency switch stops both. */
export function curatableImportId(): string | null {
  if (!roleMemorySelectorEnabled()) return null;
  const source = readMemorySourceFile();
  if (!source?.importId) return null;
  if (source.source === "delegatus") return source.importId;
  return memorySyncIntervalHours() > 0 ? source.importId : null;
}

/** A curator pass admitted outside Delegatus mode: an import batch of the synced import. */
export function syncCurationOpen(importId: string | null | undefined): boolean {
  const source = readMemorySourceFile();
  return !!importId && source?.source === "engines" && curatableImportId() === importId;
}

/** When the next sync may run, from the durable record alone. */
export function memorySyncNextAt(record: Pick<ImportRecord, "sync"> | null, hours = memorySyncIntervalHours()): number | null {
  if (hours <= 0) return null;
  const last = record?.sync;
  if (!last) return 0;
  const at = Date.parse(last.lastAt);
  if (!Number.isFinite(at)) return 0;
  return last.result === "capped" ? at : at + (last.result === "failed" || last.result === "running" ? Math.min(MEMORY_SYNC_RETRY_MS, hours * HOUR_MS) : hours * HOUR_MS);
}

/** The import a sync would extend, when one is due now. */
export function memorySyncDue(record: ImportRecord | null, now = Date.now()): boolean {
  const source = readMemorySourceFile();
  if (source?.source !== "engines" || !source.importId || !roleMemorySelectorEnabled()) return false;
  if (!record || record.id !== source.importId || record.state !== "ready") return false;
  const next = memorySyncNextAt(record);
  return next !== null && now >= next;
}

/** Counts only, for the state read. Null where a sync cannot apply. */
export function memorySyncStatus(record: ImportRecord | null, now = Date.now()) {
  const source = readMemorySourceFile();
  if (source?.source !== "engines" || !record || record.id !== source.importId || record.state !== "ready") return null;
  const hours = memorySyncIntervalHours();
  const next = memorySyncNextAt(record, hours);
  return {
    intervalHours: hours,
    lastAt: record.sync?.lastAt ?? null,
    nextAt: next === null ? null : new Date(Math.max(next, now)).toISOString(),
    added: record.sync?.added ?? 0,
    capped: record.sync?.result === "capped",
    failure: record.sync?.result === "failed" ? record.sync.reason ?? "failed"
      : record.sync?.result === "running" && now - Date.parse(record.sync.lastAt) > MEMORY_SYNC_STOPPED_MS ? "interrupted" : null,
  };
}
