import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { assertRetentionTestPath } from "@/lib/retentionTestSafety";
import { fsyncPath } from "@/lib/state/durableJson";

export const DISK_CLEANER_CLASSES = ["attempt-temp", "release", "evidence"] as const;
export type DiskCleanerClass = typeof DISK_CLEANER_CLASSES[number];
export type CleanerHold = { path: string; bytes: number; reason: string };
export type CleanerSlice = { kept: CleanerHold[]; errors: number };
export type CleanerJournal = (phase: "intent" | "removed" | "refused", directory: string, bytes: number, proof: string) => void;

export const diskCleanerStateFile = () => statePath("disk-cleaner", "latest.json");
export const diskCleanerReportsFile = () => statePath("disk-cleaner", "reports.json");

export function cleanerJournalFile(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid disk cleaner pass id");
  const file = statePath("disk-cleaner", `${id}.ndjson`);
  assertRetentionTestPath(file);
  return file;
}

/** A failed intent write blocks its mutation. A surviving intent without a
 * completion stays visible as uncertain, including after a process exit. */
export function cleanerJournal(id: string, kind: DiskCleanerClass): CleanerJournal {
  const file = cleanerJournalFile(id);
  return (phase, directory, bytes, proof) => {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
    try {
      fs.writeFileSync(fd, JSON.stringify({ phase, path: directory, bytes, class: kind, proof, at: new Date().toISOString() }) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
}

export function createCleanerJournal(id: string) {
  const file = cleanerJournalFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(file, "wx", 0o600));
  fsyncPath(path.dirname(file));
}
