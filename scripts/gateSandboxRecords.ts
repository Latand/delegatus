import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

type SandboxIdentity = { directory: string; dev: number; ino: number; generation?: string };
const allocations = new Map<string, { identity: SandboxIdentity; journal: string }>();
const identityKey = (row: SandboxIdentity) => JSON.stringify([row.directory, row.dev, row.ino, row.generation]);

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

export function ownGateSandboxes() {
  if (process.env.LLV_GATE_SANDBOX_RECORD) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-gate-record-"));
  const record = path.join(root, "sandboxes.ndjson");
  fs.writeFileSync(record, "", { mode: 0o600, flag: "wx" });
  process.env.LLV_GATE_SANDBOX_RECORD = record;
  process.once("exit", () => {
    try {
      const rows = fs.readFileSync(record, "utf8").split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as SandboxIdentity & { released?: true });
      const released = new Set(rows.filter(row => row.released === true).map(identityKey));
      for (const row of rows) {
        if (row.released || released.has(identityKey(row))) continue;
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
