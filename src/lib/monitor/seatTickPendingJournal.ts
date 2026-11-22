import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { stateDatabaseBusy } from "@/lib/state/lockWait";
import { appendSeatTickRecordAsync, sanitizeSeatTickRecord, seatTickJournalPath } from "./journalStore";
import type { SeatTickRunRecord } from "./types";

type PendingRecord = { id: string; record: SeatTickRunRecord };

type RecoveryState = { promise: Promise<void> | null; retryAt: number; retryMs: number; deferred: boolean };
const recoveries = new Map<string, RecoveryState>();

function recoveryState(file: string): RecoveryState {
  let state = recoveries.get(file);
  if (!state) {
    state = { promise: null, retryAt: 0, retryMs: 1_000, deferred: false };
    recoveries.set(file, state);
  }
  return state;
}

function deferRecovery(state: RecoveryState): void {
  state.retryAt = performance.now() + state.retryMs;
  state.retryMs = Math.min(state.retryMs * 2, 60_000);
}

function decodePendingRecords(text: string): PendingRecord[] | null {
  let rows: unknown;
  try { rows = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(rows) || !rows.length) return null;
  const pending: PendingRecord[] = [];
  for (const row of rows) {
    if (typeof row?.id !== "string" || !/^[a-f0-9]{32}$/.test(row.id)) return null;
    const record = sanitizeSeatTickRecord(row.record);
    if (!record) return null;
    pending.push({ id: row.id, record });
  }
  return pending;
}

/** A completed check survives a Viewer restart in the adjacent pending
 * directory, independent of the legacy file lock and SQLite writer.
 * Once an append fails, new results queue until a sweep can replay them. */
export class SeatTickPendingJournal {
  private readonly file: string;
  private readonly directory: string;
  private readonly recovery: RecoveryState;

  constructor(file = seatTickJournalPath()) {
    this.file = path.resolve(file);
    this.directory = `${this.file}.pending-checks`;
    this.recovery = recoveryState(this.file);
  }

  async ready(): Promise<void> {
    const state = this.recovery;
    if (state.promise) return state.promise;
    if (state.retryAt > performance.now()) return;
    const admission = this.recoverPendingBatches().then(() => {
      state.retryAt = 0;
      state.retryMs = 1_000;
      state.deferred = false;
    }, error => {
      // A missing reply may follow a successful commit. Keep the batch and
      // its receipt ids so the next attempt can safely replay it.
      deferRecovery(state);
      this.recordDeferral(error);
    });
    state.promise = admission;
    try {
      await admission;
    } finally {
      state.promise = null;
    }
  }

  private async recoverPendingBatches(): Promise<void> {
    let entries: string[];
    try { entries = await fs.readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // A temporary file belongs to an active publisher. Only the atomic rename
    // creates a visible, recoverable intent; a sweep must never inspect it.
    const batches = entries.filter(name => /^\d{16}-[a-f0-9]{32}\.json$/.test(name)).sort();
    for (const batch of batches) {
      const filename = path.join(this.directory, batch);
      // Another release may have already finished this batch.
      const text = await fs.readFile(filename, "utf8").catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (text === null) continue;
      const pending = decodePendingRecords(text);
      if (pending) {
        for (const { id, record } of pending) {
          await appendSeatTickRecordAsync(record, this.file, { replayId: id, waitMs: 0 });
        }
        // All receipts and their runs committed before this batch is removed.
        await fs.rm(filename, { force: true });
      } else {
        await fs.rename(filename, `${filename}.unreadable`);
        console.warn("[seat tick] an unreadable pending journal batch was set aside");
      }
    }
  }

  /** True when the line is already available to journal readers. */
  async append(row: SeatTickRunRecord): Promise<boolean> {
    const record = sanitizeSeatTickRecord(row);
    if (!record) return false;
    // The receipt identity precedes the first attempt. A worker can commit and
    // lose its reply, so every retry must use the same idempotency key.
    const pending = { id: randomUUID().replaceAll("-", ""), record };
    // Publish the stable receipt and result before dispatch. If the Viewer exits
    // at any point after this, a successor can replay the same idempotent row.
    const filename = path.join(this.directory, `${String(Date.now()).padStart(16, "0")}-${pending.id}.json`);
    const temp = `${filename}.tmp`;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(temp, JSON.stringify([pending]), { flag: "wx", mode: 0o600 });
    try { await fs.rename(temp, filename); }
    finally { await fs.rm(temp, { force: true }); }
    await this.recovery.promise;
    if (this.recovery.deferred) return false;
    try {
      await appendSeatTickRecordAsync(record, this.file, { replayId: pending.id, waitMs: 1_000 });
      await fs.rm(filename, { force: true });
      return true;
    } catch (error) {
      this.recordDeferral(error);
      return false;
    }
  }

  private recordDeferral(error: unknown): void {
    if (this.recovery.deferred) return;
    this.recovery.deferred = true;
    const busy = error instanceof FileTransactionBusyError || stateDatabaseBusy(error);
    const kind = error instanceof Error ? error.name : "UnknownError";
    const detail = busy ? "the journal is busy" : "the journal write failed";
    console.warn(`[seat tick] ${detail} (${kind}). Pending check results are saved for retry on a later sweep.`);
  }
}
