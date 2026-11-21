import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { FileTransactionBusyError } from "@/lib/state/fileTransaction";
import { appendSeatTickRecordAsync, sanitizeSeatTickRecord, seatTickJournalPath } from "./journalStore";
import type { SeatTickRunRecord } from "./types";

type PendingRecord = { id: string; record: SeatTickRunRecord };

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

  constructor(file = seatTickJournalPath()) {
    this.file = path.resolve(file);
    this.directory = `${this.file}.pending-checks`;
  }

  isBlocked(): boolean { return this.blocked; }

  async ready(): Promise<boolean> {
    if (this.blocked) return false;
    let entries: string[];
    try { entries = await fs.readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const [first, next] = entries.filter(name => /^\d{16}-[a-f0-9]{32}\.json$/.test(name)).sort();
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
        } catch (error) {
          if (!(error instanceof FileTransactionBusyError)) throw error;
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
    if (!this.pending.length) {
      try { await appendSeatTickRecordAsync(row, this.file); return; }
      catch (error) { if (!(error instanceof FileTransactionBusyError)) throw error; }
    }
    const record = sanitizeSeatTickRecord(row);
    if (record) this.pending.push({ id: randomUUID().replaceAll("-", ""), record });
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
    console.warn("[seat tick] the journal is busy. The check result was saved for retry on the next sweep.");
    return false;
  }
}
