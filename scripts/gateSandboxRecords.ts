import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { GATE_ALLOCATION_FILE, GATE_OWNER_FILE, isSandboxJournal, LOCAL_GATE_SANDBOX_NAME, readSandboxRows,
  type SandboxIdentity } from "../src/lib/gateSandboxProof";
import { cpuOwnerIdentity } from "../src/lib/runtime/signalSandboxContext";

const allocations = new Map<string, { identity: SandboxIdentity; journal: string }>();
const identityKey = (row: SandboxIdentity) => JSON.stringify([row.directory, row.dev, row.ino, row.generation]);

/** A timed-out test can leave a sealed dependency cache behind. Restore write
 * access on owned directories only, after the test's runner has ended. */
function removeSandbox(directory: string, expected?: SandboxIdentity): void {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return;
  const checkRoot = (current: fs.Stats) => {
    if (!current.isDirectory() || current.dev !== stat.dev || current.ino !== stat.ino
      || (expected && (current.dev !== expected.dev || current.ino !== expected.ino
        || fs.realpathSync(directory) !== expected.directory))) throw new Error("recorded gate sandbox changed identity");
  };
  checkRoot(stat);
  const remove = () => fs.rmSync(directory, { recursive: true, force: true });
  try { remove(); }
  catch (error) {
    if (process.platform !== "linux" || (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    const uid = process.getuid!();
    const mount = (fd: number) => /^mnt_id:\s*(\d+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1];
    const root = fs.openSync(directory, flags);
    try {
      checkRoot(fs.fstatSync(root));
      const rootMount = mount(root);
      if (!rootMount) throw error;
      const unseal = (fd: number) => {
        const entry = fs.fstatSync(fd);
        if (entry.uid !== uid || entry.dev !== stat.dev || mount(fd) !== rootMount) throw error;
        if ((entry.mode & 0o700) !== 0o700) fs.fchmodSync(fd, (entry.mode & 0o777) | 0o700);
        const anchor = `/proc/self/fd/${fd}`;
        for (const child of fs.readdirSync(anchor, { withFileTypes: true })) {
          if (!child.isDirectory()) continue;
          const nested = fs.openSync(path.join(anchor, child.name), flags);
          try { unseal(nested); }
          finally { fs.closeSync(nested); }
        }
      };
      unseal(root);
      checkRoot(fs.lstatSync(directory));
      remove();
    } finally { fs.closeSync(root); }
  }
}

function writeRecoveryRecord(file: string, values: object): void {
  try {
    fs.writeFileSync(file, JSON.stringify({ ...values, owner: cpuOwnerIdentity(process.pid) }), { mode: 0o600, flag: "wx" });
  } catch {
    // Orphan recovery requires this proof. Ordinary gate cleanup still owns
    // the allocation recorded in the journal when the extra write fails.
  }
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
    removeSandbox(directory);
    return;
  }
  const { identity, journal } = allocation;
  removeSandbox(identity.directory, identity);
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
        removeSandbox(row.directory, row);
      }
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.error("owned runner: sandbox cleanup failed", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
}
