import { parentPort } from "node:worker_threads";

import { FileTransactionBusyError } from "@/lib/state/fileTransaction";

import { appendSeatTickRecordOnThisThread, type SeatTickJournalAppendOptions } from "./journalStore";
import type { SeatTickRunRecord } from "./types";

/* The seat tick journal's worker thread (seatTickJournalWorker.ts): each
   message is one append, run by the same function the Viewer thread used to
   run, and answered with its outcome. */

type Append = { type: "seat-tick-journal-append"; id: number; record: SeatTickRunRecord; filePath: string; options: SeatTickJournalAppendOptions };

parentPort?.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || (message as Append).type !== "seat-tick-journal-append") return;
  const { id, record, filePath, options } = message as Append;
  void appendSeatTickRecordOnThisThread(record, filePath, options).then(
    () => parentPort!.postMessage({ type: "seat-tick-journal-done", id, ok: true }),
    (error: unknown) => parentPort!.postMessage({
      type: "seat-tick-journal-done", id, ok: false,
      error: {
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
        busy: error instanceof FileTransactionBusyError,
      },
    }),
  );
});
