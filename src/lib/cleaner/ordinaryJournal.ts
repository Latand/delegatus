import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { assertRetentionTestPath } from "@/lib/retentionTestSafety";
import { fsyncPath } from "@/lib/state/durableJson";
import type { DiskCleanerClass } from "./diskJournal";

/** Deletions made by the ordinary periodic tick, outside any Cleaner pass, go
 * to one file per UTC day beside the pass journals. A row has the Cleaner's
 * fields (`phase`, `path`, `bytes`, `class`, `proof`, `at`) and the detail below. */
const ORDINARY_JOURNAL = /^ordinary-(\d{4}-\d{2}-\d{2})\.ndjson$/;
export const ORDINARY_JOURNAL_RETENTION_MS = 30 * 86_400_000;
/** Why a root qualified or was kept, how old it was and what ended the visit. */
export type OrdinaryJournalDetail = { reason?: string; ageMs?: number; kind?: string; scope?: string; trigger?: string | null; code?: string; identity?: string };
/** `skipped` names a root that was examined and kept; it is written once per
 * root and reason, never once per tick. */
export type OrdinaryJournalPhase = "intent" | "removed" | "refused" | "skipped";
export type OrdinaryJournal = (phase: OrdinaryJournalPhase, directory: string, bytes: number, proof: string, detail?: OrdinaryJournalDetail) => void;

export function ordinaryJournalFile(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("invalid ordinary journal day");
  const file = statePath("disk-cleaner", `ordinary-${day}.ndjson`);
  assertRetentionTestPath(file);
  return file;
}

/** Appends fsynced rows to today's file. The path is written state-relative so
 * the journal names no home directory. A failed write throws, which blocks the
 * mutation an intent row announces. The first row of a new day deletes this
 * writer's own files older than thirty days. */
export function ordinaryCleanerJournal(kind: DiskCleanerClass, now: () => number = Date.now): OrdinaryJournal {
  return (phase, directory, bytes, proof, detail) => {
    const at = now(), day = new Date(at).toISOString().slice(0, 10), file = ordinaryJournalFile(day);
    const fresh = !fs.existsSync(file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const relative = path.relative(statePath(), directory);
      const shown = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : directory;
      fs.writeFileSync(fd, JSON.stringify({ phase, path: shown, bytes, class: kind, proof, ...detail, at: new Date(at).toISOString() }) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (fresh) {
      fsyncPath(path.dirname(file));
      try {
        for (const name of fs.readdirSync(path.dirname(file))) {
          const match = ORDINARY_JOURNAL.exec(name);
          if (match && Date.parse(match[1]! + "T00:00:00Z") < at - ORDINARY_JOURNAL_RETENTION_MS) fs.rmSync(path.join(path.dirname(file), name), { force: true });
        }
      } catch { /* Pruning is housekeeping and never blocks a deletion. */ }
    }
  };
}
