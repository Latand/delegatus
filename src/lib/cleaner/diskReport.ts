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
type PendingReportWrite = { pending: DiskCleanerPass[]; archive: DiskCleanerPass };

function writeArchive(pass: DiskCleanerPass, reports: DiskCleanerPass[]) {
  const index = reports.findIndex(row => row.id === pass.id);
  if (index < 0) reports.push(pass);
  else if (JSON.stringify(reports[index]) === JSON.stringify(pass)) return;
  else reports[index] = pass;
  writeJsonDurably(diskCleanerReportsFile(), reports);
}

function readPending(): DiskCleanerPass[] {
  let stored: DiskCleanerPass[] | PendingReportWrite;
  try { stored = JSON.parse(fs.readFileSync(pendingFile(), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // One-time upgrade from the former archive-plus-receipts representation.
    const acknowledged = new Set(readReceipts().acknowledged);
    const pending = readReports().filter(pass => pass.finished && !acknowledged.has(pass.id));
    writeJsonDurably(pendingFile(), pending);
    return pending;
  }
  if (Array.isArray(stored)) return stored;
  // Finish an interrupted archive write before the seat can acknowledge the
  // changed total. Once acknowledged, the archive already has that version.
  writeArchive(stored.archive, readReports());
  writeJsonDurably(pendingFile(), stored.pending);
  return stored.pending;
}

function publishReport(pass: DiskCleanerPass, pending: DiskCleanerPass[], reports: DiskCleanerPass[]) {
  const index = pending.findIndex(row => row.id === pass.id);
  if (index < 0) pending.push(pass); else pending[index] = pass;
  writeJsonDurably(pendingFile(), { pending, archive: pass } satisfies PendingReportWrite);
  writeArchive(pass, reports);
  writeJsonDurably(pendingFile(), pending);
}

/** Called under the pass lease. Keep completed wake items available while
 * the next pass runs, including for seats that are still mid-turn. */
export async function recordDiskCleanerReport(pass: DiskCleanerPass): Promise<DiskCleanerPass> {
  return withFileTransactionAsync(pendingFile(), "disk cleaner pending reports", () => {
    const pending = readPending();
    const prior = readReports(), recorded = prior.find(row => row.id === pass.id);
    if (recorded) return recorded;
    publishReport(pass, pending, prior);
    return pass;
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
export async function reconcileDiskCleanerReport(passId: string): Promise<boolean> {
  if (!readReports().some(pass => pass.id === passId && pass.finished)) return false;
  return withFileTransactionAsync(pendingFile(), "disk cleaner pending reports", async () => {
    const pending = readPending();
    const reports = readReports(), index = reports.findIndex(pass => pass.id === passId && pass.finished);
    if (index < 0) return false;
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
    const original = reports[index]!, finished = original.finished!;
    const updated: DiskCleanerPass = { ...original, finished: { ...finished, removed, uncertain: outstanding.size,
      errors: Math.max(finished.errors, errors), incomplete: errors > 0 || outstanding.size > 0 || finished.errors > 0 } };
    if (JSON.stringify(finished) === JSON.stringify(updated.finished)) return true;
    publishReport(updated, pending, reports);
    return true;
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
