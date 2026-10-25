import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { readMemorySourceFile } from "./source";
import { importCollection, readImportRecord } from "./importStore";
import type { ImportRecord } from "./importTypes";
import { canonicalProject } from "@/lib/projects/aliases";
import type { SeatTickSignalInput } from "@/lib/monitor/types";
import { memorySyncStatus } from "./importSync";

/** Counts only: native paths and candidate bodies never reach a setting read. */
export function memoryImportStatus() {
  return withViewerOperation("memory.import.status", readImportStatus);
}
function readImportStatus() {
  const source = readMemorySourceFile();
  const record = source?.importId ? readImportRecord(source.importId) : null;
  return record ? { counts: record.progress ?? null, remainingGenerations: record.remainingGenerations?.length ?? 0,
    hold: record.reason ?? null } : null;
}
/** A first import that failed puts the switch back where it was (§4.2), so
    the Settings row names the newest failure made after the current choice.
    Import records are one per press; the page bound keeps the read small. */
export function memoryImportFailure(): { reason: NonNullable<ImportRecord["reason"]>; at: string } | null {
  return withViewerOperation("memory.import.status", () => {
    const source = readMemorySourceFile();
    if (source?.source === "delegatus") return null;
    const since = source ? Date.parse(source.changedAt) : -Infinity;
    let rows: ReturnType<NonNullable<ReturnType<typeof importCollection>>["keyRangeEntries"]>;
    // An unreadable import store says nothing about the switch; the row keeps its own words.
    try { rows = importCollection(false)?.keyRangeEntries("i:", "i:\uffff", 256) ?? []; } catch { return null; }
    let newest: { reason: NonNullable<ImportRecord["reason"]>; at: string } | null = null;
    for (const { value } of rows) {
      if (value?.kind !== "import" || value.state !== "failed" || !(Date.parse(value.at) >= since)) continue;
      if (!newest || Date.parse(value.at) > Date.parse(newest.at)) newest = { reason: value.reason ?? "failed", at: value.at };
    }
    return newest;
  });
}
/** The periodic sync's schedule and last run (§4.9), counts only; null where it cannot apply. */
export function memorySyncState(now = Date.now()) {
  return withViewerOperation("memory.import.status", () => {
    const source = readMemorySourceFile();
    return source?.importId ? memorySyncStatus(readImportRecord(source.importId), now) : null;
  });
}
export function memoryImportDrainSignal(project: string, now = Date.now()): SeatTickSignalInput[] {
  return withViewerOperation("memory.import.status", () => drainSignal(project, now));
}
function drainSignal(project: string, now: number): SeatTickSignalInput[] {
  const source = readMemorySourceFile();
  if (source?.source !== "delegatus" || source.phase !== "draining" || !source.importId || !source.flippedAt || now - Date.parse(source.flippedAt) < 24 * 60 * 60_000) return [];
  const record = readImportRecord(source.importId);
  if (!record?.remainingGenerations?.length || !record.hostProject || canonicalProject(record.hostProject) !== canonicalProject(project)) return [];
  return [{ id: `memory-import-drain:${record.id}`, actionable: true, episode: source.flippedAt,
    label: `Memory import has waited a day for ${record.remainingGenerations.length} earlier Claude generations. Ask the operator in a decision form whether to rotate the remaining host. Rotate only after their answer; the trial has not started.` }];
}
