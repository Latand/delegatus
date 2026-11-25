import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { statePath } from "@/lib/configDir";
import { assertRetentionTestPath } from "@/lib/retentionTestSafety";
import { fsyncPath } from "@/lib/state/durableJson";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { STATE_LOCK_WAIT_MS } from "@/lib/state/lockWait";

export const DISK_CLEANER_CLASSES = ["attempt-temp", "release", "evidence"] as const;
export type DiskCleanerClass = typeof DISK_CLEANER_CLASSES[number];
export type CleanerHold = { path: string; bytes: number; reason: string };
export type CleanerSlice = { kept: CleanerHold[]; errors: number };
export type CleanerJournal = (phase: "intent" | "removed" | "refused", directory: string, bytes: number, proof: string) => void;
export type CleanerAuditBinding = { passId: string; proof: string; bytes?: number };

export function isCleanerAuditBinding(value: unknown): value is CleanerAuditBinding {
  const row = value as Partial<CleanerAuditBinding> | null;
  return !!row && typeof row.passId === "string" && /^[a-f0-9-]{36}$/.test(row.passId)
    && typeof row.proof === "string" && (row.bytes === undefined || Number.isSafeInteger(row.bytes) && row.bytes >= 0);
}

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

async function readCleanerAudit(binding: CleanerAuditBinding, kind: DiskCleanerClass, directory: string) {
  const file = cleanerJournalFile(binding.passId);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let bytes: number | undefined, terminal: string | undefined;
  let input: fs.ReadStream | undefined;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("invalid Cleaner audit");
    input = fs.createReadStream(file, { fd });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        const entry = JSON.parse(line);
        if (entry.path !== directory || entry.class !== kind) continue;
        if (entry.phase === "intent") {
          bytes = entry.proof === binding.proof && (binding.bytes === undefined || entry.bytes === binding.bytes)
            ? entry.bytes : undefined;
          terminal = undefined;
        } else if (bytes !== undefined) terminal = entry.phase;
      }
    } finally { lines.close(); }
  } finally {
    if (input) input.destroy();
    else fs.closeSync(fd);
  }
  if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Cleaner quarantine has no matching audit intent");
  return { bytes, terminal };
}

export async function cleanerAuditPending(binding: CleanerAuditBinding, kind: DiskCleanerClass, directory: string) {
  return (await readCleanerAudit(binding, kind, directory)).terminal === undefined;
}

/** The native quarantine stays in custody until its audit and report settle.
 * A restart after appending the outcome can reuse that same terminal entry. */
export async function settleCleanerAudit(binding: CleanerAuditBinding, kind: DiskCleanerClass, directory: string, phase: "removed" | "refused") {
  await withFileTransactionAsync(cleanerJournalFile(binding.passId), "cleaner audit recovery", async () => {
    const { bytes, terminal } = await readCleanerAudit(binding, kind, directory);
    if (terminal === phase) return;
    if (terminal !== undefined) throw new Error("Cleaner quarantine audit outcome conflicts");
    cleanerJournal(binding.passId, kind)(phase, directory, bytes, binding.proof);
  }, { waitMs: STATE_LOCK_WAIT_MS });
}
