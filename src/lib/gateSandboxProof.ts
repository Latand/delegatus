import fs from "node:fs";
import path from "node:path";
import type { ProcessIdentity } from "./processIdentity";
import { cpuOwnerStatus } from "./runtime/signalSandboxContext";

/**
 * The records a local gate leaves about its sandbox allocations, and the proof
 * that an allocation's owner has ended. `scripts/gateSandboxRecords.ts` writes
 * them; the temp sweep reads them here, because the runtime image ships `src/`
 * and only a listed few scripts.
 */

export type SandboxIdentity = { directory: string; dev: number; ino: number; generation?: string };
export type SandboxRow = SandboxIdentity & { released?: true; retained?: true };
const GATE_RECORD_DIRECTORY = /^delegatus-gate-record-[A-Za-z0-9]{6}$/;
export const LOCAL_GATE_SANDBOX_NAME = /^delegatus-local-gate-[A-Za-z0-9]{6}$/;
export const GATE_ALLOCATION_FILE = ".delegatus-gate-allocation.json";
export const GATE_OWNER_FILE = "owner.json";

function readPrivateRecord(file: string, uid: number, limit: number): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > limit)
      throw new Error("invalid gate sandbox record");
    const buffer = Buffer.alloc(stat.size);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (size !== buffer.length || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs
      || current.dev !== stat.dev || current.ino !== stat.ino)
      throw new Error("gate sandbox record changed during read");
    return buffer.toString("utf8");
  } finally { fs.closeSync(fd); }
}

export function readSandboxRows(journal: string, uid: number): SandboxRow[] {
  return readPrivateRecord(journal, uid, 1024 * 1024).split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as SandboxRow);
}

export function isSandboxJournal(file: string): boolean {
  return path.isAbsolute(file) && path.normalize(file) === file && path.basename(file) === "sandboxes.ndjson"
    && GATE_RECORD_DIRECTORY.test(path.basename(path.dirname(file)));
}

function ownerEnded(owner: ProcessIdentity | undefined): boolean {
  return !!owner && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.startIdentity === "string" && !!owner.startIdentity
    && typeof owner.bootEpoch === "string" && !!owner.bootEpoch
    && cpuOwnerStatus(owner) === "dead";
}

/** Authenticate an orphaned allocation against its supervisor's journal.
 * Explicit retention or a missing owner record leaves the directory held. */
export function gateSandboxOwnerEnded(directory: string, original: string, via: string, journalInUse: (file: string) => boolean): boolean {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return false;
    const proof = JSON.parse(readPrivateRecord(path.join(directory, GATE_ALLOCATION_FILE), stat.uid, 4096)) as
      SandboxIdentity & { journal: string; owner?: ProcessIdentity };
    if (proof.directory !== original || proof.dev !== stat.dev || proof.ino !== stat.ino
      || typeof proof.generation !== "string" || !proof.generation || typeof proof.journal !== "string"
      || !isSandboxJournal(proof.journal) || !ownerEnded(proof.owner)) return false;
    const journal = via + proof.journal;
    const ownerDirectory = fs.lstatSync(path.dirname(journal));
    if (!ownerDirectory.isDirectory() || ownerDirectory.uid !== stat.uid || (ownerDirectory.mode & 0o077) !== 0
      || !ownerEnded(JSON.parse(readPrivateRecord(path.join(path.dirname(journal), GATE_OWNER_FILE), stat.uid, 4096)).owner)
      || journalInUse(proof.journal)) return false;
    const rows = readSandboxRows(journal, stat.uid).filter(row =>
      row.directory === original && row.dev === stat.dev && row.ino === stat.ino);
    return rows.length === 1 && rows[0]!.generation === proof.generation && !rows[0]!.retained && !rows[0]!.released;
  } catch { return false; }
}
