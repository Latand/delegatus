import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { appendSeatTickRecordAsync, sanitizeSeatTickRecord, seatTickJournalPath } from "./journalStore";
import type { SeatTickRunRecord } from "./types";

type PendingRecord = { id: string; record: SeatTickRunRecord };

type RecoveryState = { promise: Promise<boolean> | null; retryAt: number; retryMs: number; warned: boolean };
const recoveries = new Map<string, RecoveryState>();

function recoveryState(file: string): RecoveryState {
  let state = recoveries.get(file);
  if (!state) {
    state = { promise: null, retryAt: 0, retryMs: 1_000, warned: false };
    recoveries.set(file, state);
  }
  return state;
}

function deferRecovery(state: RecoveryState): void {
  state.retryAt = Date.now() + state.retryMs;
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

/** One sweep shares one admission budget after the first journal refusal.
 * The completed check survives a Viewer restart in the adjacent pending
 * directory, independent of the legacy file lock and SQLite writer. */
export class SeatTickPendingJournal {
  private blocked = false;
  private readonly pending: PendingRecord[] = [];
  private readonly file: string;
  private readonly directory: string;
  private readonly recovery: RecoveryState;

  constructor(file = seatTickJournalPath()) {
    this.file = path.resolve(file);
    this.directory = `${this.file}.pending-checks`;
    this.recovery = recoveryState(this.file);
  }

  isBlocked(): boolean { return this.blocked; }

  async ready(): Promise<boolean> {
    if (this.blocked) return false;
    if (this.recovery.promise) {
      const ready = await this.recovery.promise;
      this.blocked = !ready;
      return ready;
    }
    if (this.recovery.retryAt > Date.now()) {
      this.blocked = true;
      return false;
    }
    const admission = Promise.resolve().then(() => this.recoverPendingBatch());
    this.recovery.promise = admission;
    try {
      const ready = await admission;
      this.blocked = !ready;
      if (ready) {
        this.recovery.retryAt = 0;
        this.recovery.retryMs = 1_000;
        this.recovery.warned = false;
      }
      return ready;
    } finally {
      if (this.recovery.promise === admission) this.recovery.promise = null;
    }
  }

  private async recoverPendingBatch(): Promise<boolean> {
    let entries: string[];
    try { entries = await fs.readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const [first, next] = entries.filter(name => /^\d{16}-[a-f0-9]{32}\.json(?:\.tmp)?$/.test(name)).sort();
    if (!first) return true;
    const filename = path.join(this.directory, first);
    // Another release may have already finished this batch.
    const text = await fs.readFile(filename, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (text !== null) {
      const pending = decodePendingRecords(text);
      if (pending) {
        try {
          for (const row of pending) await appendSeatTickRecordAsync(row.record, this.file, row.id);
        } catch {
          // A missing worker reply may follow a successful commit. Keep the
          // batch and its receipt ids; a later pass can safely replay it.
          deferRecovery(this.recovery);
          this.blocked = true;
          return false;
        }
        // All receipts and their runs committed before this batch is removed.
        await fs.rm(filename, { force: true });
      } else {
        await fs.rename(filename, `${filename}.unreadable`);
        console.warn("[seat tick] an unreadable pending journal batch was set aside");
      }
    }
    this.blocked = !!next;
    return !this.blocked;
  }

  async append(row: SeatTickRunRecord): Promise<void> {
    const record = sanitizeSeatTickRecord(row);
    if (!record) return;
    // The receipt identity precedes the first attempt. A worker can commit and
    // lose its reply, so every retry must use the same idempotency key.
    const pending = { id: randomUUID().replaceAll("-", ""), record };
    if (!this.pending.length) {
      try { await appendSeatTickRecordAsync(record, this.file, pending.id); return; }
      catch { /* Any failed reply is ambiguous: persist the row for receipt replay. */ }
    }
    this.pending.push(pending);
  }

  async finish(): Promise<boolean> {
    if (!this.pending.length) return true;
    const filename = path.join(this.directory, `${String(Date.now()).padStart(16, "0")}-${this.pending[0]!.id}.json`);
    const temp = `${filename}.tmp`;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Publish atomically with the same process-restart guarantee as the
    // SQLite journal's synchronous=NORMAL commits.
    try {
      await fs.writeFile(temp, JSON.stringify(this.pending), { flag: "wx", mode: 0o600 });
      await fs.rename(temp, filename);
    } finally {
      await fs.rm(temp, { force: true });
    }
    this.pending.length = 0;
    this.blocked = true;
    if (!this.recovery.warned) {
      this.recovery.warned = true;
      console.warn("[seat tick] the journal is busy. The check result was saved for retry on the next sweep.");
    }
    return false;
  }
}
