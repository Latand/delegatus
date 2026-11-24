import fs from "node:fs";
import path from "node:path";
import { redactBounded } from "@/lib/monitor/redact";
import type { SeatTickSignalInput } from "@/lib/monitor/types";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { formatDiskBytes } from "@/lib/state/diskPressure";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { STATE_LOCK_WAIT_MS } from "@/lib/state/lockWait";
import { diskCleanerReportsFile } from "./diskJournal";
import type { DiskCleanerPass } from "./diskState";
import { seatTickSignalVersion } from "@/lib/monitor/seatTick";
import type { SeatTickSeatInput } from "@/lib/monitor/types";

function readReports(): DiskCleanerPass[] {
  try { return JSON.parse(fs.readFileSync(diskCleanerReportsFile(), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Called under the pass lease. Keep completed wake items available while
 * the next pass runs, including for seats that are still mid-turn. */
export function recordDiskCleanerReport(pass: DiskCleanerPass): void {
  const file = diskCleanerReportsFile();
  const prior = readReports();
  if (!prior.some(row => row.id === pass.id)) writeJsonDurably(file, [...prior, pass]);
}

type CleanerReceipts = { acknowledged: string[] };
function readReceipts(): CleanerReceipts {
  try { return JSON.parse(fs.readFileSync(`${diskCleanerReportsFile()}.receipts`, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { acknowledged: [] }; throw error; }
}

export async function diskCleanerSignals(project: string, shown: readonly string[] = [], seat: Pick<SeatTickSeatInput, "conversationId" | "seatEpoch"> | null = null): Promise<SeatTickSignalInput[]> {
  try {
    const file = diskCleanerReportsFile();
    return await withFileTransactionAsync(`${file}.receipts`, "disk cleaner report receipts", () => {
      const reports = readReports();
      const receipts = readReceipts();
      const pending = reports.filter(pass => pass.finished && canonicalOrchestratorProject(pass.project) === project
        && !receipts.acknowledged.includes(pass.id));
      const acknowledged = pending.filter(pass => {
        const signal = { id: `disk-cleaner:${pass.id}`, actionable: true, label: diskCleanerReport(pass) };
        return seat !== null && shown.includes(seatTickSignalVersion(signal, seat));
      });
      if (acknowledged.length) {
        const ids = new Set(acknowledged.map(pass => pass.id));
        writeJsonDurably(`${file}.receipts`, { acknowledged: [...new Set([...receipts.acknowledged, ...ids])] });
      }
      return pending.filter(pass => !acknowledged.includes(pass)).map(pass => ({
        id: `disk-cleaner:${pass.id}`, actionable: true, label: diskCleanerReport(pass),
      }));
    }, { waitMs: STATE_LOCK_WAIT_MS });
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
