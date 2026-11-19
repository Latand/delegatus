import fs from "node:fs";
import path from "node:path";
import { isMainThread, SHARE_ENV, Worker } from "node:worker_threads";

import { attachReadAttributionWorker } from "@/lib/readAttribution";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";

import type { SeatTickRunRecord } from "./types";

/*
 * The seat tick's journal append, on a thread of its own.
 *
 * The legacy append did its file I/O asynchronously: a check spent well under
 * a millisecond of the Viewer thread on it. A `state.sqlite` write is
 * synchronous, so on the Viewer thread every check would block it for the
 * whole transaction (about 3 ms here, 10 ms on a busy disk). The Viewer keeps
 * one worker thread that runs the same append, `appendSeatTickRecordOnThisThread`
 * in `journalStore.ts`, with the same lease, fence and busy handling; the
 * check awaits its answer as it awaited the file write.
 *
 * - The worker shares the Viewer's environment (`SHARE_ENV`), so it resolves
 *   the same state directory and release authority.
 * - It runs only in the Viewer (`LLV_STATE_OWNER=viewer`), where its
 *   source or its bundle is shipped; `LLV_SEAT_TICK_JOURNAL_WORKER=0` turns it
 *   off and `=1` turns it on elsewhere (tests). Without it, the append runs on
 *   the caller's thread as before.
 * - A worker that fails to start, dies or stops answering rejects what it
 *   held; the next append starts another. After three failures in a row the
 *   process appends on its own thread.
 */

const ANSWER_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 3;

type Pending = { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
interface Held {
  worker: Worker;
  pending: Map<number, Pending>;
  next: number;
  detach(): void;
}

type Done = { type: "seat-tick-journal-done"; id: number; ok: boolean; error?: { message: string; busy: boolean } };

let held: Held | null = null;
let consecutiveFailures = 0;
let started = 0;

export function seatTickJournalWorkerPath(): string | null {
  const setting = process.env.LLV_SEAT_TICK_JOURNAL_WORKER;
  if (setting === "0" || !isMainThread) return null;
  if (setting !== "1" && process.env.LLV_STATE_OWNER !== "viewer") return null;
  const bundled = path.join(process.cwd(), ".next/server/seat-tick-journal-worker.js");
  const source = path.join(process.cwd(), "src/lib/monitor/seatTickJournal.worker.ts");
  for (const candidate of process.env.NODE_ENV === "production" ? [bundled, source] : [source, bundled]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function retire(state: Held, error: Error): void {
  if (held === state) held = null;
  state.detach();
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  state.pending.clear();
  void state.worker.terminate().catch(() => undefined);
}

function settle(state: Held, message: Done): void {
  const pending = state.pending.get(message.id);
  if (!pending) return;
  state.pending.delete(message.id);
  clearTimeout(pending.timer);
  if (state.pending.size === 0) state.worker.unref();
  consecutiveFailures = 0;
  if (message.ok) pending.resolve();
  else pending.reject(message.error?.busy ? new FileTransactionBusyError(message.error.message) : new Error(message.error?.message ?? "seat tick journal append failed"));
}

function worker(): Held | null {
  if (held) return held;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null;
  const entry = seatTickJournalWorkerPath();
  if (!entry) return null;
  let created: Worker;
  try {
    created = new Worker(entry, { env: SHARE_ENV, name: "seat-tick-journal" });
  } catch (error) {
    consecutiveFailures += 1;
    console.warn("[seat tick] journal worker unavailable; appending on this thread:", error instanceof Error ? error.message : String(error));
    return null;
  }
  started += 1;
  created.unref();
  const state: Held = { worker: created, pending: new Map(), next: 0, detach: attachReadAttributionWorker(created, "seat-tick-journal") };
  created.on("message", (message: unknown) => {
    if (message && typeof message === "object" && (message as Done).type === "seat-tick-journal-done") settle(state, message as Done);
  });
  created.on("error", (error) => {
    consecutiveFailures += 1;
    retire(state, error instanceof Error ? error : new Error(String(error)));
  });
  created.on("exit", (code) => {
    if (held === state) consecutiveFailures += 1;
    retire(state, new Error(`the seat tick journal worker exited (${code})`));
  });
  held = state;
  return state;
}

/**
 * Hand one record to the journal worker. Null when no worker runs here: the
 * caller appends on its own thread.
 */
export function appendThroughSeatTickJournalWorker(record: SeatTickRunRecord, filePath: string): Promise<void> | null {
  const state = worker();
  if (!state) return null;
  const id = ++state.next;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!state.pending.delete(id)) return;
      consecutiveFailures += 1;
      // A worker that stopped answering is replaced; what it held is rejected.
      retire(state, new FileTransactionBusyError("the seat tick journal worker did not answer"));
      reject(new FileTransactionBusyError("the seat tick journal worker did not answer"));
    }, ANSWER_TIMEOUT_MS);
    timer.unref?.();
    // A pending append keeps the process alive until it is answered.
    if (state.pending.size === 0) state.worker.ref();
    state.pending.set(id, { resolve, reject, timer });
    try {
      state.worker.postMessage({ type: "seat-tick-journal-append", id, record, filePath });
    } catch (error) {
      state.pending.delete(id);
      clearTimeout(timer);
      retire(state, error instanceof Error ? error : new Error(String(error)));
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Test seam: how many journal workers this process started. */
export function seatTickJournalWorkersStartedForTests(): number {
  return started;
}

/** Test seam: stop the worker and forget its failures. */
export async function stopSeatTickJournalWorkerForTests(): Promise<void> {
  const state = held;
  held = null;
  consecutiveFailures = 0;
  if (state) {
    state.detach();
    await state.worker.terminate().catch(() => undefined);
  }
}
