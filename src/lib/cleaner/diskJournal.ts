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
/** Optional fields an ordinary (non-pass) journal row carries: why the root
 * qualified or was kept, how old it was and what ended the visit. */
export type CleanerJournalDetail = { reason?: string; ageMs?: number; kind?: string; scope?: string; trigger?: string | null; code?: string; identity?: string };
export type CleanerJournal = (phase: "intent" | "removed" | "refused", directory: string, bytes: number, proof: string, detail?: CleanerJournalDetail) => void;
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
  return (phase, directory, bytes, proof, detail) => {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
    try {
      fs.writeFileSync(fd, JSON.stringify({ phase, path: directory, bytes, class: kind, proof, ...detail, at: new Date().toISOString() }) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
}

/** Deletions made by the ordinary periodic tick, outside any Cleaner pass, go
 * to one file per UTC day beside the pass journals. */
const ORDINARY_JOURNAL = /^ordinary-(\d{4}-\d{2}-\d{2})\.ndjson$/;
export const ORDINARY_JOURNAL_RETENTION_MS = 30 * 86_400_000;
export function ordinaryJournalFile(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("invalid ordinary journal day");
  const file = statePath("disk-cleaner", `ordinary-${day}.ndjson`);
  assertRetentionTestPath(file);
  return file;
}
/** Phases an ordinary row may carry. `skipped` names a root that was examined
 * and kept; it is written once per root and reason, never once per tick. */
export type OrdinaryJournalPhase = "intent" | "removed" | "refused" | "skipped";
export type OrdinaryJournal = (phase: OrdinaryJournalPhase, directory: string, bytes: number, proof: string, detail?: CleanerJournalDetail) => void;
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
