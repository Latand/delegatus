import { workerData, type MessagePort } from "node:worker_threads";
import "@/lib/sqliteMemoryDiagnostics";

// A separate channel holds the real attachment job open while the parent's
// production message listener receives SQLite diagnostics from this worker.
const { control, entry } = workerData as { control: MessagePort; entry: string };
await new Promise<void>(resolve => {
  control.once("message", () => resolve());
  control.postMessage("ready");
});
control.close();
await import(entry);
