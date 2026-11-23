import fs from "node:fs";
import path from "node:path";
import { redactBounded } from "@/lib/monitor/redact";
import type { SeatTickSignalInput } from "@/lib/monitor/types";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { formatDiskBytes } from "@/lib/state/diskPressure";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { diskCleanerReportsFile } from "./diskJournal";
import type { DiskCleanerPass } from "./diskState";

const REPORT_HISTORY = 24;

function readReports(): DiskCleanerPass[] {
  try { return JSON.parse(fs.readFileSync(diskCleanerReportsFile(), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Called under the pass lease. Keep completed wake items available while
 * the next pass runs, including for seats that are still mid-turn. */
export function recordDiskCleanerReport(pass: DiskCleanerPass): void {
  const prior = readReports();
  if (!prior.some(row => row.id === pass.id)) writeJsonDurably(diskCleanerReportsFile(), [...prior, pass].slice(-REPORT_HISTORY));
}

export function diskCleanerSignals(project: string): SeatTickSignalInput[] {
  try {
    return readReports().filter(pass => pass.finished && canonicalOrchestratorProject(pass.project) === project)
      .map(pass => ({ id: `disk-cleaner:${pass.id}`, actionable: true, label: diskCleanerReport(pass) }));
  } catch { return []; }
}

export function diskCleanerReport(pass: DiskCleanerPass): string {
  const result = pass.finished;
  if (!result) return "Автоматичне прибирання диска триває.";
  const space = (bytes: number | null) => bytes === null ? "невідомо" : formatDiskBytes(bytes);
  const readings = pass.before.map(row => `${row.roles.join("/")} ${space(row.freeBytes)} → ${space(result.after.find(after => after.volume === row.volume)?.freeBytes ?? null)}`);
  const kept = result.kept.map(row => `${redactBounded(path.basename(row.path), 120)} (${space(row.bytes)}, ${redactBounded(row.reason, 140)})`);
  return [
    `Прибирання диска завершено${pass.mode === "dry-run" ? " (пробний прохід)" : ""}. Вільно до → після: ${readings.join(", ")}.`,
    `Видалено: спроби ${space(result.removed["attempt-temp"])}, релізи ${space(result.removed.release)}, докази ${space(result.removed.evidence)}.`,
    kept.length ? `Найбільші збережені: ${kept.join("; ")}.` : "",
    result.incomplete || result.errors || result.uncertain
      ? `Неповний прохід: помилок ${result.errors}, незавершених записів ${result.uncertain}.` : "",
    `Журнал disk-cleaner/${pass.id}.ndjson`,
  ].filter(Boolean).join("\n");
}
