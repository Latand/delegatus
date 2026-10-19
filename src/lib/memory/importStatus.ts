import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { readMemorySourceFile } from "./source";
import { readImportRecord } from "./importStore";
import { canonicalProject } from "@/lib/projects/aliases";
import type { SeatTickSignalInput } from "@/lib/monitor/types";

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
