import { importMemoryRevision } from "./importCuration";
import { stateDir } from "@/lib/configDir";
import { readMemorySourceFile } from "./source";
import { readImportRecord } from "./importStore";
import { runMemoryImport } from "./importJob";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

const owner = globalThis as typeof globalThis & { __delegatusImportSchedule?: { root: string; done: Promise<void> } };
/** One deferred job at a time across Next bundles. The scanner retries after
 * restart or refusal; no timer, source traversal or hashing runs on a request. */
export function scheduleMemoryImport(): Promise<void> {
  const root = stateDir();
  const active = owner.__delegatusImportSchedule;
  if (active) return active.done;
  const done = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
    if (stateDir() !== root) return;
    const source = readMemorySourceFile();
    if (source?.source !== "delegatus" || !source.importId) return;
    const record = readImportRecord(source.importId);
    if (source.phase === "active" && !record) return;
    if (source.phase === "active" && !record?.curationDirty && record?.observedMemoryRevision === importMemoryRevision()) return;
    await withViewerOperation("memory.import.advance", () => runMemoryImport({ importId: source.importId!, previous: record?.previous ?? null, advance: true }));
  }).catch(() => { console.error("[memory import] background advance failed; the next scan retries from the private record"); })
    .finally(() => { if (owner.__delegatusImportSchedule?.done === done) owner.__delegatusImportSchedule = undefined; });
  owner.__delegatusImportSchedule = { root, done };
  return done;
}
