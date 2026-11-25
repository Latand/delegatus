import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ProcessIdentity } from "../src/lib/processIdentity";
import { cpuOwnerIdentity, cpuOwnerStatus } from "../src/lib/runtime/signalSandboxContext";

type SandboxIdentity = { directory: string; dev: number; ino: number; generation?: string };
type SandboxRow = SandboxIdentity & { released?: true; retained?: true };
const GATE_RECORD_DIRECTORY = /^delegatus-gate-record-[A-Za-z0-9]{6}$/;
export const LOCAL_GATE_SANDBOX_NAME = /^delegatus-local-gate-[A-Za-z0-9]{6}$/;
const GATE_ALLOCATION_FILE = ".delegatus-gate-allocation.json";
const GATE_OWNER_FILE = "owner.json";
const allocations = new Map<string, { identity: SandboxIdentity; journal: string }>();
const identityKey = (row: SandboxIdentity) => JSON.stringify([row.directory, row.dev, row.ino, row.generation]);

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

function readSandboxRows(journal: string, uid: number): SandboxRow[] {
  return readPrivateRecord(journal, uid, 1024 * 1024).split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as SandboxRow);
}

function isSandboxJournal(file: string): boolean {
  return path.isAbsolute(file) && path.normalize(file) === file && path.basename(file) === "sandboxes.ndjson"
    && GATE_RECORD_DIRECTORY.test(path.basename(path.dirname(file)));
}

function writeRecoveryRecord(file: string, values: object): void {
  try {
    fs.writeFileSync(file, JSON.stringify({ ...values, owner: cpuOwnerIdentity(process.pid) }), { mode: 0o600, flag: "wx" });
  } catch {
    // Orphan recovery requires this proof. Ordinary gate cleanup still owns
    // the allocation recorded in the journal when the extra write fails.
  }
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

/** A child can recognize a still-owned allocation in its supervisor's journal.
 * A path spelling or an old allocation at the same path is insufficient. */
export function hasActiveGateSandbox(directory: string, journal: string | undefined): boolean {
  if (!journal) return false;
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return false;
    const physical = fs.realpathSync(directory);
    const live = new Set<string>();
    for (const row of readSandboxRows(journal, stat.uid)) {
      if (row.directory !== physical || row.dev !== stat.dev || row.ino !== stat.ino || !row.generation) continue;
      if (row.released || row.retained) live.delete(row.generation);
      else live.add(row.generation);
    }
    return live.size === 1;
  } catch { return false; }
}

/** The creating process records the exact allocation before using it. The
 * outer owned runner consumes this journal only after its children stop. */
export function recordGateSandbox(directory: string): string {
  const record = process.env.LLV_GATE_SANDBOX_RECORD;
  if (record) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid gate sandbox allocation");
    const identity = { directory: fs.realpathSync(directory), dev: stat.dev, ino: stat.ino, generation: randomUUID() };
    fs.appendFileSync(record, JSON.stringify(identity) + "\n");
    allocations.set(path.resolve(directory), { identity, journal: record });
    if (LOCAL_GATE_SANDBOX_NAME.test(path.basename(directory)) && isSandboxJournal(record)) {
      writeRecoveryRecord(path.join(directory, GATE_ALLOCATION_FILE), { ...identity, journal: record });
    }
  }
  return directory;
}

/** Normal cleanup retires this allocation's identity. A later directory at the
 * same path belongs to a different owner and must survive outer cleanup. */
export function releaseGateSandbox(directory: string) {
  const key = path.resolve(directory);
  const allocation = allocations.get(key);
  if (!allocation) {
    if (process.env.LLV_GATE_SANDBOX_RECORD) throw new Error("gate sandbox has no local allocation record");
    fs.rmSync(directory, { recursive: true, force: true });
    return;
  }
  const { identity, journal } = allocation;
  const stat = fs.lstatSync(identity.directory, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino
    || fs.realpathSync(identity.directory) !== identity.directory)) throw new Error("recorded gate sandbox changed identity");
  if (stat) fs.rmSync(identity.directory, { recursive: true, force: true });
  fs.appendFileSync(journal, JSON.stringify({ ...identity, released: true }) + "\n");
  allocations.delete(key);
}

/** Keep a sandbox whose consumer completion could not be proven. Its owner
 * journal records the deliberate retention so the outer runner cannot remove
 * inputs from beneath an unobserved child process. */
export function retainGateSandbox(directory: string) {
  const key = path.resolve(directory);
  const allocation = allocations.get(key);
  if (!allocation) throw new Error("gate sandbox has no local allocation record");
  const { identity, journal } = allocation;
  const stat = fs.lstatSync(identity.directory, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino
    || fs.realpathSync(identity.directory) !== identity.directory) throw new Error("recorded gate sandbox changed identity");
  fs.appendFileSync(journal, JSON.stringify({ ...identity, retained: true }) + "\n");
  allocations.delete(key);
}

export function ownGateSandboxes() {
  if (process.env.LLV_GATE_SANDBOX_RECORD) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-gate-record-"));
  const record = path.join(root, "sandboxes.ndjson");
  fs.writeFileSync(record, "", { mode: 0o600, flag: "wx" });
  writeRecoveryRecord(path.join(root, GATE_OWNER_FILE), {});
  process.env.LLV_GATE_SANDBOX_RECORD = record;
  process.once("exit", () => {
    try {
      const rows = fs.readFileSync(record, "utf8").split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as SandboxIdentity & { released?: true; retained?: true });
      const released = new Set(rows.filter(row => row.released === true).map(identityKey));
      const retained = new Set(rows.filter(row => row.retained === true).map(identityKey));
      for (const row of rows) {
        if (row.released || row.retained || released.has(identityKey(row)) || retained.has(identityKey(row))) continue;
        const stat = fs.lstatSync(row.directory, { throwIfNoEntry: false });
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== row.dev || stat.ino !== row.ino
          || fs.realpathSync(row.directory) !== row.directory) throw new Error("recorded gate sandbox changed identity");
        fs.rmSync(row.directory, { recursive: true, force: true });
      }
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.error("owned runner: sandbox cleanup failed", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
}
