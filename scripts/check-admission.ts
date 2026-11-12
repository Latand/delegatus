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
  return env.LLV_CHECK_ADMISSION_FILE ?? path.join(machineHome(), ".cache", "delegatus-cpu", "checks.sqlite");
}

export function checkCapacity(env: Readonly<Record<string, string | undefined>> = process.env, cores = onlineCpuCount()): number {
  const setting = env.DELEGATUS_GATE_CPU_HEADROOM ?? env.LLV_GATE_CPU_HEADROOM;
  const headroom = setting === undefined ? Math.max(2, Math.ceil(cores / 4)) : Number(setting);
  if (setting !== undefined && (!/^\d+$/.test(setting) || !Number.isSafeInteger(headroom))) {
    throw new Error("GATE_CPU_HEADROOM must be a nonnegative integer");
  }
  return Math.max(1, cores - headroom);
}

type Row = { seq: number; owner: string; capacity: number; held: number };
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
        capacity INTEGER NOT NULL CHECK(capacity > 0), held INTEGER NOT NULL DEFAULT 0
      )`);
    } catch (error) { this.db.close(); throw error; }
  }

  claim(owner: ProcessIdentity, capacity: number): boolean {
    if (!owner.startIdentity || !owner.bootEpoch || !Number.isSafeInteger(capacity) || capacity < 1) throw new Error("check admission needs a verified owner and positive capacity");
    const identity = JSON.stringify(owner);
    return this.db.transaction(() => {
      if (this.observer.status(owner) !== "alive" || this.observer.exited(owner)) throw new Error("check admission owner is no longer alive");
      for (const row of this.db.query<Row, []>("SELECT * FROM checks ORDER BY seq").all()) {
        const previous = JSON.parse(row.owner) as ProcessIdentity;
        if (this.observer.status(previous) === "dead" || this.observer.exited(previous)) this.db.query("DELETE FROM checks WHERE seq = ?").run(row.seq);
      }
      this.db.query("INSERT OR IGNORE INTO checks(owner, capacity) VALUES (?, ?)").run(identity, capacity);
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
  hasAdmittedAncestor(pid: number): boolean {
    const parents = procBackend.ppidMap(), ancestors = new Set<number>();
    let parent = parents.get(pid);
    while (parent && parent > 1 && !ancestors.has(parent)) { ancestors.add(parent); parent = parents.get(parent); }
    return this.db.query<Row, []>("SELECT * FROM checks WHERE held = 1").all()
      .some(row => {
        const owner = JSON.parse(row.owner) as ProcessIdentity;
        return ancestors.has(owner.pid) && this.holds(owner);
      });
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

const testSlot = Symbol.for("delegatus.checkAdmission.test");
const globals = globalThis as typeof globalThis & { [testSlot]?: Promise<void> };
export function admitTestProcess(): Promise<void> {
  return globals[testSlot] ??= (async () => {
      const inherited = process.env.DELEGATUS_CHECK_ADMISSION_OWNER;
      if (inherited) {
        try {
          const owner = JSON.parse(inherited) as ProcessIdentity, queue = new CheckAdmission(checkAdmissionFile());
          try { if (queue.holds(owner)) return; } finally { queue.close(); }
        } catch { /* A stale or malformed inherited ticket must reacquire. */ }
      }
      const env = process.env, queue = new CheckAdmission(checkAdmissionFile(env));
      try {
        // Child suites are part of the parent's admitted gate tree. Detect the
        // live ownership chain from process identities so isolated child envs
        // cannot turn a saturated parent/child wait into a queue cycle.
        if (queue.hasAdmittedAncestor(process.pid)) return;
      } finally { queue.close(); }
      const slot = await acquireCheckSlot(env);
      process.env.DELEGATUS_CHECK_ADMISSION_OWNER = JSON.stringify(slot.owner);
    slot.queue.close();
    })();
}

export function admittedCheckAncestor(pid: number, env = process.env): ProcessIdentity | undefined {
  const queue = new CheckAdmission(checkAdmissionFile(env));
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

export function isTestCommand(command: readonly string[]): boolean {
  const binary = path.basename(command[0] ?? "").replace(/\.exe$/, "");
  if (["bash", "sh"].includes(binary) && command[2] === "--in-cpu-scope") return isTestCommand(command.slice(3));
  return binary === "bun" && command[1] === "test";
}

/** Only compiler commands need wrapping here. Bun tests admit their final
 * process in test-preload, after startup HOME and ownership re-entry. */
export function isTypecheckCommand(command: readonly string[]): boolean {
  const name = (value = "") => path.basename(value).replace(/\.(?:cmd|exe|js|cjs|mjs)$/, "");
  const binary = name(command[0]);
  if (["bash", "sh"].includes(binary) && command[2] === "--in-cpu-scope") return isTypecheckCommand(command.slice(3));
  // Shell campaigns often forward their actual command through `exec "$@"`.
  // Admitting the enclosing owned run keeps the permit through that handoff.
  if (["bash", "sh"].includes(binary) && command.slice(1).some(part => /(?:^|[/\\])tsc(?:\.(?:cmd|exe|js|cjs|mjs))?(?:\s|$)/.test(part))) return true;
  if (binary === "tsc") return true;
  if (["bunx", "npx"].includes(binary)) return name(command[1]) === "tsc";
  if (["bun", "node"].includes(binary)) return name(command[1]) === "tsc" || command[1] === "x" && name(command[2]) === "tsc";
  return false;
}
