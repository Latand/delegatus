import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { openCurrentDatabase } from "@/lib/state/currentDatabase";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { defaultSeatTickAdmissionSources } from "@/lib/monitor/seatTickAdmissionSources";
import { admissionHold, type AdmissionHoldKind } from "./curation/admission";
import { curationRevision } from "./curation/store";
import { roleMemoryCollection } from "./roleStore";
import { importCollection } from "./importStore";
import { candidateById, candidateState, survivingImportRules } from "./importCuration";
import { readImportRecord } from "./importStore";
import { readMemorySourceFile } from "./source";

/* What the Settings row says beyond the import record's own counts: the admission
   hold in front of the import's pending batches (docs/design/memory-source-switch.md
   §4.5) and the state of an undone import pass (§4.7). Words and counts only. */

/** The hold that stops the import's pending passes, read for its host project, which stands in
    for the others: a seat wakes setting is per project, an update or a deployment is machine-wide. */
export function memoryImportAdmissionHold(): AdmissionHoldKind | null {
  return withViewerOperation("memory.import.status", () => {
    const source = readMemorySourceFile();
    if (source?.source !== "delegatus" || !source.importId) return null;
    const record = readImportRecord(source.importId);
    if (!record?.hostProject || !(record.progress && record.progress.pendingParts > 0)) return null;
    try { return admissionHold(canonicalProject(record.hostProject), { sources: defaultSeatTickAdmissionSources() })?.kind ?? null; }
    // A hold that cannot be read is not one to name.
    catch { return null; }
  });
}

export type MemoryImportUndo = { state: "undone" | "partlyUndone"; kept: number };
const NEWEST_UNDONE_PASSES = 16;
/** The current import's undone passes: "partly undone" while a rule they produced survives a later
    edit (the undo's own skipped list), "undone" while a candidate they re-pended waits for the curator
    again; null once the curator has dealt with every one of them. */
export function memoryImportUndo(): MemoryImportUndo | null {
  return withViewerOperation("memory.import.status", () => {
    const importId = readMemorySourceFile()?.importId;
    if (!importId) return null;
    /* The Settings row reads this every few seconds: one answer per state of the three stores it derives from. */
    const stamp = `${statePath("state.sqlite")}:${importId}:${curationRevision()}:${roleMemoryCollection()?.revision()}:${importCollection()?.revision()}`;
    if (undoMemo?.stamp === stamp) return undoMemo.value;
    let value: MemoryImportUndo | null;
    // An unreadable store says nothing about the import, and that answer is not kept.
    try { value = readUndo(importId); } catch { return null; }
    undoMemo = { stamp, value };
    return value;
  });
}
let undoMemo: { stamp: string; value: MemoryImportUndo | null } | null = null;
function readUndo(importId: string): MemoryImportUndo | null {
  const sqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
  const db = openCurrentDatabase(statePath("state.sqlite"), () => new sqlite.Database(statePath("state.sqlite"), { readonly: true, strict: true }));
  let passes: { skipped?: string[]; importBatch: { importId: string; candidates: string[] } }[];
  try {
    passes = db.query<{ value_json: string }, [string, number]>(`SELECT value_json FROM state_rows
      WHERE collection='role_memory_curation' AND row_key>='r:' AND row_key<'r:\uffff'
      AND json_extract(value_json,'$.importBatch.importId')=? AND json_extract(value_json,'$.revertedAt') IS NOT NULL
      ORDER BY json_extract(value_json,'$.revertedAt') DESC LIMIT ?`).all(importId, NEWEST_UNDONE_PASSES).map(row => JSON.parse(row.value_json));
  } finally { db.close(); }
  if (!passes.length) return null;
  const kept = survivingImportRules([...new Set(passes.flatMap(pass => pass.skipped ?? []))]).length;
  if (kept) return { state: "partlyUndone", kept };
  for (const pass of passes) for (const id of pass.importBatch.candidates) {
    const row = candidateById(importId, id);
    if (row && candidateState(row).state === "pending") return { state: "undone", kept: 0 };
  }
  return null;
}
