import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

type SandboxIdentity = { directory: string; dev: number; ino: number; generation?: string };
const allocations = new Map<string, { identity: SandboxIdentity; journal?: string }>();
const identityKey = (row: SandboxIdentity) => JSON.stringify([row.directory, row.dev, row.ino, row.generation]);

/** A child can recognize a still-owned allocation in its supervisor's journal.
 * A path spelling or an old allocation at the same path is insufficient. */
export function hasActiveGateSandbox(directory: string, journal: string | undefined): boolean {
  if (!journal) return false;
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return false;
    const physical = fs.realpathSync(directory);
    const fd = fs.openSync(journal, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const limit = 1024 * 1024;
      const record = fs.fstatSync(fd);
      if (!record.isFile() || record.uid !== stat.uid || (record.mode & 0o077) !== 0 || record.size > limit) return false;
      const buffer = Buffer.alloc(record.size);
      if (fs.readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) return false;
      const live = new Set<string>();
      for (const line of buffer.toString("utf8").split("\n").filter(Boolean)) {
        const row = JSON.parse(line) as SandboxIdentity & { released?: true; retained?: true };
        if (row.directory !== physical || row.dev !== stat.dev || row.ino !== stat.ino || !row.generation) continue;
        if (row.released || row.retained) live.delete(row.generation);
        else live.add(row.generation);
      }
      return live.size === 1;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** The creating process records the exact allocation before using it. The
 * outer owned runner consumes this journal only after its children stop. */
export function recordGateSandbox(directory: string): string {
  const record = process.env.LLV_GATE_SANDBOX_RECORD;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid gate sandbox allocation");
  const identity = { directory: fs.realpathSync(directory), dev: stat.dev, ino: stat.ino, generation: randomUUID() };
  if (record) fs.appendFileSync(record, JSON.stringify(identity) + "\n");
  allocations.set(path.resolve(directory), { identity, journal: record });
  return directory;
}

/** Normal cleanup retires this allocation's identity. A later directory at the
 * same path belongs to a different owner and must survive outer cleanup. */
export function releaseGateSandbox(directory: string) {
  const key = path.resolve(directory);
  const allocation = allocations.get(key);
  if (!allocation) throw new Error("gate sandbox has no local allocation record");
  const { identity, journal } = allocation;
  const stat = fs.lstatSync(identity.directory, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino
    || fs.realpathSync(identity.directory) !== identity.directory)) throw new Error("recorded gate sandbox changed identity");
  if (stat) fs.rmSync(identity.directory, { recursive: true, force: true });
  if (journal) fs.appendFileSync(journal, JSON.stringify({ ...identity, released: true }) + "\n");
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
  if (journal) fs.appendFileSync(journal, JSON.stringify({ ...identity, retained: true }) + "\n");
  allocations.delete(key);
}

export function ownGateSandboxes() {
  if (process.env.LLV_GATE_SANDBOX_RECORD) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-gate-record-"));
  const record = path.join(root, "sandboxes.ndjson");
  fs.writeFileSync(record, "", { mode: 0o600, flag: "wx" });
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
