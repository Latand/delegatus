import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { machineHome } from "../src/lib/runtime/cpuAdmission";
import { onlineCpuCount } from "../src/lib/runtime/cpuPlacement";
import { cpuOwnerIdentity, cpuOwnerStatus, cpuOwnerExited } from "../src/lib/runtime/signalSandboxContext";
import { procBackend } from "../src/lib/proc";
import type { ProcessIdentity } from "../src/lib/processIdentity";
import { reportCpuWait } from "../src/lib/runtime/cpuAdmissionBudget";
import { admissionLockWait } from "./cpu-admission-lock";

/** Independent of HOME, state and outer gate locks: comparator sandboxes must
 * still spend the same machine's permits, on both branch and base. */
export function checkAdmissionFile(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.LLV_CHECK_ADMISSION_FILE ?? env.LLV_GATE_CHECK_ADMISSION_FILE ?? path.join(machineHome(), ".cache", "delegatus-cpu", "checks.sqlite");
}

export function checkCapacity(env: Readonly<Record<string, string | undefined>> = process.env, cores = onlineCpuCount()): number {
  const setting = env.DELEGATUS_GATE_CPU_HEADROOM ?? env.LLV_GATE_CPU_HEADROOM;
  const headroom = setting === undefined ? Math.max(2, Math.ceil(cores / 4)) : Number(setting);
  if (setting !== undefined && (!/^\d+$/.test(setting) || !Number.isSafeInteger(headroom))) {
    throw new Error("GATE_CPU_HEADROOM must be a nonnegative integer");
  }
  return Math.max(1, cores - headroom);
}

type Row = { seq: number; owner: string; capacity: number; held: number; lineage: string };
type Observer = { status: typeof cpuOwnerStatus; exited: typeof cpuOwnerExited };

/** A separate connection per runner, never a process-local counter. The write
 * transaction orders insertion, dead-owner reclamation and admission together.
 * Unknown identities keep their permit; PID reuse cannot inherit one. */
export class CheckAdmission {
  readonly db: Database;
  constructor(file: string, private readonly observer: Observer = { status: cpuOwnerStatus, exited: cpuOwnerExited }) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true });
    try {
      fs.chmodSync(file, 0o600);
      this.db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
      this.db.exec(`CREATE TABLE IF NOT EXISTS checks (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT UNIQUE NOT NULL,
        capacity INTEGER NOT NULL CHECK(capacity > 0), held INTEGER NOT NULL DEFAULT 0,
        lineage TEXT NOT NULL DEFAULT '[]'
      )`);
      // Old launchers continue to write the same owner and default lineage.
      // Serialize the probe and ALTER together across concurrent upgrades.
      this.db.transaction(() => {
        if (!this.db.query<{ name: string }, []>("PRAGMA table_info(checks)").all().some(row => row.name === "lineage")) {
          this.db.exec("ALTER TABLE checks ADD COLUMN lineage TEXT NOT NULL DEFAULT '[]'");
        }
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }

  claim(owner: ProcessIdentity, capacity: number, lineage: readonly ProcessIdentity[] = []): boolean {
    if (!owner.startIdentity || !owner.bootEpoch || !Number.isSafeInteger(capacity) || capacity < 1) throw new Error("check admission needs a verified owner and positive capacity");
    const identity = JSON.stringify(owner);
    return this.db.transaction(() => {
      if (this.observer.status(owner) !== "alive" || this.observer.exited(owner)) throw new Error("check admission owner is no longer alive");
      for (const row of this.db.query<Row, []>("SELECT * FROM checks ORDER BY seq").all()) {
        const previous = JSON.parse(row.owner) as ProcessIdentity;
        if (this.observer.status(previous) === "dead" || this.observer.exited(previous)) this.db.query("DELETE FROM checks WHERE seq = ?").run(row.seq);
      }
      this.db.query("INSERT OR IGNORE INTO checks(owner, capacity, lineage) VALUES (?, ?, ?)").run(identity, capacity, JSON.stringify(lineage));
      const rows = this.db.query<Row, []>("SELECT * FROM checks ORDER BY seq").all();
      const own = rows.find(row => row.owner === identity)!;
      if (own.held) return true;
      // A stricter concurrent caller cannot be overridden by a sibling's env.
      const limit = Math.min(...rows.map(row => row.capacity));
      if (rows.filter(row => row.held).length >= limit || rows.find(row => !row.held)?.seq !== own.seq) return false;
      this.db.query("UPDATE checks SET held = 1 WHERE seq = ?").run(own.seq);
      return true;
    }).immediate();
  }

  bind(owner: ProcessIdentity, child: ProcessIdentity): void {
    if (!child.startIdentity || !child.bootEpoch) throw new Error("check command has no verifiable identity");
    this.db.transaction(() => {
      // A test preload may have reached its own check before the spawn parent
      // could bind. Fold that ticket into the already held launch permit.
      this.cancel(child);
      this.db.query("UPDATE checks SET owner = ? WHERE owner = ? AND held = 1").run(JSON.stringify(child), JSON.stringify(owner));
    }).immediate();
  }
  holds(owner: ProcessIdentity): boolean {
    return this.db.query<{ held: number }, [string]>("SELECT held FROM checks WHERE owner = ?").get(JSON.stringify(owner))?.held === 1
      && this.observer.status(owner) === "alive" && !this.observer.exited(owner);
  }
  cancel(owner: ProcessIdentity): void { this.db.query("DELETE FROM checks WHERE owner = ?").run(JSON.stringify(owner)); }
  close(): void { this.db.close(); }
}

export async function acquireCheckSlot(env = process.env, signal?: AbortSignal) {
  const capacity = checkCapacity(env), owner = cpuOwnerIdentity(process.pid, env);
  const retry = admissionLockWait();
  const endWait = reportCpuWait(env);
  let queue: CheckAdmission | undefined;
  let admitted = false;
  try {
    queue = await retry(() => { signal?.throwIfAborted(); return new CheckAdmission(checkAdmissionFile(env)); });
    let shown = false;
    for (;;) {
      signal?.throwIfAborted();
      if (await retry(() => { signal?.throwIfAborted(); return queue!.claim(owner, capacity); })) {
        // Cancellation can arrive at the await after the durable claim.
        signal?.throwIfAborted();
        admitted = true;
        return { queue, owner };
      }
      if (!shown) { console.error(`gate-slot: waiting for a machine test/typecheck permit (capacity ${capacity})`); shown = true; }
      await Bun.sleep(1_000);
    }
  } finally {
    endWait();
    if (!admitted && queue) {
      try { await retry(() => queue!.cancel(owner)); } finally { queue.close(); }
    }
  }
}

/** Opening the shared WAL can briefly contend with another runner creating or
 * configuring it. Keep those read-only ownership probes on the same bounded
 * SQLite retry path as admission itself. */
export async function openCheckAdmission(env = process.env): Promise<CheckAdmission> {
  const endWait = reportCpuWait(env);
  try {
    return await admissionLockWait()(() => new CheckAdmission(checkAdmissionFile(env)));
  } finally { endWait(); }
}

/** The preload client supervises this exact worker; an ancestor can never
 * authorize another process. Shared by the repository and injected preloads. */
export async function admitTestProcess(): Promise<void> {
  const { admitWorker } = await import("./check-worker-client.mjs");
  await admitWorker("test");
}

export async function admittedCheckAncestor(pid: number, env = process.env): Promise<ProcessIdentity | undefined> {
  const queue = await openCheckAdmission(env);
  try {
    const parents = procBackend.ppidMap(), ancestors = new Set<number>();
    let parent = parents.get(pid);
    while (parent && parent > 1 && !ancestors.has(parent)) { ancestors.add(parent); parent = parents.get(parent); }
    return queue.db.query<Row, []>("SELECT * FROM checks WHERE held = 1").all().map(row => JSON.parse(row.owner) as ProcessIdentity)
      .find(owner => ancestors.has(owner.pid) && queue.holds(owner));
  } finally { queue.close(); }
}

/** Explicit preload travels with this runner, even when its command reads a
 * baseline checkout whose bunfig and default preload predate this cap. */
export function withTestAdmission(command: readonly string[], preload: string): string[] {
  const binary = path.basename(command[0] ?? "").replace(/\.exe$/, "");
  if (["bash", "sh"].includes(binary) && command[2] === "--in-cpu-scope") return [...command.slice(0, 3), ...withTestAdmission(command.slice(3), preload)];
  const test = binary === "bun" && (command[1] === "test" ? 2 : command[1] === "run" && command[2] === "test" ? 3 : 0);
  if (!test || command.includes(preload)) return [...command];
  return [...command.slice(0, test), "--preload", preload, ...command.slice(test)];
}
