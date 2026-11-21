import { parentPort } from "node:worker_threads";

import { FileTransactionBusyError } from "@/lib/state/fileTransaction";

import { appendSeatTickRecordOnThisThread } from "./journalStore";
import type { SeatTickRunRecord } from "./types";

/* The seat tick journal's worker thread (seatTickJournalWorker.ts): each
   message is one append, run by the same function the Viewer thread used to
   run, and answered with its outcome. */

type Append = { type: "seat-tick-journal-append"; id: number; record: SeatTickRunRecord; filePath: string; replayId?: string };

parentPort?.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || (message as Append).type !== "seat-tick-journal-append") return;
  const { id, record, filePath, replayId } = message as Append;
  void appendSeatTickRecordOnThisThread(record, filePath, replayId).then(
    () => parentPort!.postMessage({ type: "seat-tick-journal-done", id, ok: true }),
    (error: unknown) => parentPort!.postMessage({
      type: "seat-tick-journal-done", id, ok: false,
      error: { message: error instanceof Error ? error.message : String(error), busy: error instanceof FileTransactionBusyError },
    }),
  );
});
