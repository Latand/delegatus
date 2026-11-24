import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { redactBounded } from "@/lib/monitor/redact";
import type { SeatTickSignalInput } from "@/lib/monitor/types";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { formatDiskBytes } from "@/lib/state/diskPressure";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { STATE_LOCK_WAIT_MS } from "@/lib/state/lockWait";
import { cleanerJournalFile, diskCleanerReportsFile, DISK_CLEANER_CLASSES } from "./diskJournal";
import type { DiskCleanerPass } from "./diskState";
import { seatTickSignalVersion } from "@/lib/monitor/seatTick";
import type { SeatTickSeatInput } from "@/lib/monitor/types";

function readReports(): DiskCleanerPass[] {
  try { return JSON.parse(fs.readFileSync(diskCleanerReportsFile(), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function pendingFile() { return `${diskCleanerReportsFile()}.pending`; }
function readPending(): DiskCleanerPass[] {
  try { return JSON.parse(fs.readFileSync(pendingFile(), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // One-time upgrade from the former archive-plus-receipts representation.
    const acknowledged = new Set(readReceipts().acknowledged);
    const pending = readReports().filter(pass => pass.finished && !acknowledged.has(pass.id));
    writeJsonDurably(pendingFile(), pending);
    return pending;
  }
}

/** Called under the pass lease. Keep completed wake items available while
 * the next pass runs, including for seats that are still mid-turn. */
export async function recordDiskCleanerReport(pass: DiskCleanerPass): Promise<void> {
  const file = diskCleanerReportsFile();
  const prior = readReports(), index = prior.findIndex(row => row.id === pass.id);
  if (index < 0) prior.push(pass); else prior[index] = pass;
  writeJsonDurably(file, prior);
  await withFileTransactionAsync(pendingFile(), "disk cleaner pending reports", () => {
    const pending = readPending(), old = pending.findIndex(row => row.id === pass.id);
    if (old < 0) pending.push(pass); else pending[old] = pass;
    writeJsonDurably(pendingFile(), pending);
  }, { waitMs: STATE_LOCK_WAIT_MS });
}

type CleanerReceipts = { acknowledged: string[] };
function readReceipts(): CleanerReceipts {
  try { return JSON.parse(fs.readFileSync(`${diskCleanerReportsFile()}.receipts`, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { acknowledged: [] }; throw error; }
}

export async function diskCleanerSignals(project: string, shown: readonly string[] = [], seat: Pick<SeatTickSeatInput, "conversationId" | "seatEpoch"> | null = null): Promise<SeatTickSignalInput[]> {
  try {
    return await withFileTransactionAsync(pendingFile(), "disk cleaner pending reports", () => {
      const pending = readPending().filter(pass => canonicalOrchestratorProject(pass.project) === project);
      const acknowledged = pending.filter(pass => {
        const signal = { id: `disk-cleaner:${pass.id}`, actionable: true, label: diskCleanerReport(pass) };
        return seat !== null && shown.includes(seatTickSignalVersion(signal, seat));
      });
      if (acknowledged.length) {
        const ids = new Set(acknowledged.map(pass => pass.id));
        const remaining = readPending().filter(pass => !ids.has(pass.id));
        writeJsonDurably(pendingFile(), remaining);
      }
      return pending.filter(pass => !acknowledged.includes(pass)).map(pass => ({
        id: `disk-cleaner:${pass.id}`, actionable: true, label: diskCleanerReport(pass),
      }));
    }, { waitMs: STATE_LOCK_WAIT_MS });
  } catch { return []; }
}

/** Rebuild a completed pass after interrupted work later settles. Requeue the
 * updated report so the seat receives the corrected totals and uncertainty. */
export async function reconcileDiskCleanerReport(passId: string): Promise<void> {
  const file = diskCleanerReportsFile(), reports = readReports();
  const index = reports.findIndex(pass => pass.id === passId && pass.finished);
  if (index < 0) return;
  const removed: NonNullable<DiskCleanerPass["finished"]>["removed"] = { "attempt-temp": 0, release: 0, evidence: 0 };
  const outstanding = new Set<string>();
  let errors = 0;
  const lines = createInterface({ input: fs.createReadStream(cleanerJournalFile(passId)), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const row = JSON.parse(line), kind = row.class as keyof typeof removed;
        if (!DISK_CLEANER_CLASSES.includes(kind) || typeof row.path !== "string" || !Number.isFinite(row.bytes) || row.bytes < 0) throw new Error("invalid journal row");
        const key = JSON.stringify([kind, row.path]);
        if (row.phase === "intent") outstanding.add(key);
        else if (row.phase === "removed" && outstanding.delete(key)) removed[kind] += row.bytes;
        else if (row.phase === "refused" && outstanding.delete(key)) continue;
        else throw new Error("unbound journal outcome");
      } catch { errors++; }
    }
  } catch { errors++; }
  const original = reports[index]!;
  const finished = original.finished!;
  const updated: DiskCleanerPass = { ...original, finished: { ...finished, removed, uncertain: outstanding.size,
    errors: Math.max(finished.errors, errors), incomplete: errors > 0 || outstanding.size > 0 || finished.errors > 0 } };
  reports[index] = updated;
  writeJsonDurably(file, reports);
  await withFileTransactionAsync(pendingFile(), "disk cleaner pending reports", () => {
    const pending = readPending(), pendingIndex = pending.findIndex(pass => pass.id === passId);
    if (pendingIndex < 0) pending.push(updated); else pending[pendingIndex] = updated;
    writeJsonDurably(pendingFile(), pending);
  }, { waitMs: STATE_LOCK_WAIT_MS });
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
