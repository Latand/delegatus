import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Database } from "bun:sqlite";

import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../processIdentity";
import { procBackend } from "../proc";

export const CPU_QUEUE_MAX_WAIT_MS = 10 * 60_000;
export const CPU_QUEUE_SPACING_MS = 2_000;
/** A waiting stage polls every five seconds. An ownerless ticket nobody has
 * polled for this long stops counting ahead of others; it keeps its row. */
export const CPU_QUEUE_UNPOLLED_MS = 60_000;
/** An ownerless ticket unpolled for this long, and held by no fence, is removed. */
export const CPU_QUEUE_ABANDONED_MS = 24 * 60 * 60_000;
/** How long a head may stay past its bound, with nothing admitted, before the wait reads as stalled. */
export const CPU_QUEUE_STALE_GRACE_MS = 60_000;
/** `stalledMs` is set only while the head is past its bound and nothing is admitted. */
export type CpuQueueWait = { since: number; position: number; remainingMs: number; stalledMs?: number };
type Ticket = { seq: number; key: string; since: number; owner: string | null };
export type CpuSlotLease = { owner: ProcessIdentity; slot: string };

/** A continuation retains its parent's admission only while the kernel
 * proves that exact process still holds the slot. Service handoff preserves
 * this proof even though the worker is reparented to the user manager. */
export function inheritedCpuSlot(env = process.env): CpuSlotLease | null {
  if (process.platform !== "linux") return null;
  try {
    const lease = JSON.parse(env.LLV_GATE_SLOT_LEASE ?? "null") as CpuSlotLease | null;
    if (!lease || typeof lease.slot !== "string" || !path.isAbsolute(lease.slot) || !lease.owner || !Number.isSafeInteger(lease.owner.pid) || lease.owner.pid < 1) return null;
    const match = /^llv-heavy-gate\.slot([1-9]\d*)\.lock$/.exec(path.basename(lease.slot));
    if (!match || Number(match[1]) > Number(env.LLV_GATE_SLOTS ?? 6) || path.dirname(lease.slot) !== path.resolve(env.LLV_GATE_LOCK_DIR ?? "/var/tmp")) return null;
    if (processIdentityStatus(lease.owner) !== "alive") return null;
    const descriptor = path.join("/proc", String(lease.owner.pid), "fd", "9");
    const file = fs.statSync(lease.slot, { bigint: true }), fd = fs.statSync(descriptor, { bigint: true });
    const info = fs.readFileSync(path.join("/proc", String(lease.owner.pid), "fdinfo", "9"), "utf8");
    const inode = /^ino:\s+(\d+)$/m.exec(info)?.[1];
    if (file.dev !== fd.dev || file.ino !== fd.ino || !inode || BigInt(inode) !== file.ino || !/^lock:.*\bFLOCK\b.*\bWRITE\b/m.test(info)) return null;
    return processIdentityStatus(lease.owner) === "alive" && !procBackend.processExited(lease.owner.pid) ? lease : null;
  } catch { return null; }
}
export function cpuSlotForOwner(owner: ProcessIdentity, env = process.env): CpuSlotLease | null {
  if (process.platform !== "linux") return null;
  try {
    const slot = fs.readlinkSync(path.join("/proc", String(owner.pid), "fd", "9"));
    return inheritedCpuSlot({ ...env, LLV_GATE_SLOT_LEASE: JSON.stringify({ owner, slot }) });
  } catch { return null; }
}

const homeSymbol = Symbol.for("delegatus.cpuAdmission.home");
const nativeHome = globalThis as typeof globalThis & { [homeSymbol]?: string };
/** The operating-system user's home, whatever HOME a child was handed. */
export function machineHome(): string {
  if (nativeHome[homeSymbol]) return nativeHome[homeSymbol]!;
  // Bun's userInfo delegates to homedir, which reads HOME/USERPROFILE first.
  // Bun caches homedir at startup, so remove the overrides before launch.
  const env = { ...process.env };
  delete env.HOME; delete env.USERPROFILE;
  const script = 'process.stdout.write(require("node:os").userInfo().homedir)';
  const probe = (runtime: string, source: string, childEnv: NodeJS.ProcessEnv) => spawnSync(runtime, ["-e", source], {
    env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
  });
  let result = probe(process.execPath, script, env);
  // Local Compose supports host UIDs absent from the image's passwd file.
  // Its installed Bun shim can resolve that UID in the host's account table.
  if ((result.status !== 0 || !path.isAbsolute(result.stdout ?? "")) && process.env.LLV_DOCKER_NSENTER_SHIMS === "1") {
    // The shim needs HOME to find host Bun; that Bun launches its native probe
    // with overrides removed before startup, just as the in-container probe.
    const hostScript = `const env = { ...process.env }; delete env.HOME; delete env.USERPROFILE; const result = require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(script)}], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }); if (result.status !== 0) process.exit(1); process.stdout.write(result.stdout);`;
    result = probe("bun", hostScript, process.env);
  }
  if (result.status !== 0 || !path.isAbsolute(result.stdout ?? "")) throw new Error("CPU admission could not resolve the native user home");
  return nativeHome[homeSymbol] = result.stdout;
}

/** Shared by the live Viewer and gate-slot, including children with
 * sandboxed HOME. Every other instance passes its state directory and keeps
 * its own queue there (cpuAdmissionScope.ts). */
export function cpuAdmissionFile(isolatedStateDir?: string | null): string {
  if (!process.env.LLV_GATE_LOCK_DIR && isolatedStateDir) return path.join(isolatedStateDir, "cpu-gate", "admission.sqlite");
  if (!process.env.LLV_GATE_LOCK_DIR && /\.test\.[cm]?[jt]sx?$/.test(process.argv[1] ?? "")) {
    // Bun's test process names its first file as argv[1]. Gate helpers name
    // their own script, so the outer heavy command still shares machine FIFO.
    if (!process.env.LLV_STATE_DIR) throw new Error("Test CPU admission requires an isolated LLV_STATE_DIR or LLV_GATE_LOCK_DIR");
    return path.join(process.env.LLV_STATE_DIR, "cpu-gate", "admission.sqlite");
  }
  // The passwd home is stable when agent/test commands sandbox HOME. It is
  // mounted writable into the Viewer image; /var/tmp there is read-only.
  return path.join(process.env.LLV_GATE_LOCK_DIR || path.join(machineHome(), ".cache", "delegatus-cpu"), "admission.sqlite");
}

/** Admission is committed under SQLite's writer lock, before a caller starts.
 * Stage keys outlive the Viewer; command keys carry a kernel start identity.
 * Sequence numbers break equal-clock ties and never depend on tick order.
 * A stage key has no process to outlive, so every check records its poll: a
 * ticket whose instance went away stops holding the head (2026-10-13). */
export class CpuAdmissionQueue {
  private readonly db: Database;
  constructor(file: string, private readonly now = Date.now, private readonly spacingMs = CPU_QUEUE_SPACING_MS, private readonly maxWaitMs = CPU_QUEUE_MAX_WAIT_MS, private readonly unpolledMs = CPU_QUEUE_UNPOLLED_MS) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite?.Database) throw new Error("CPU admission requires the supported Bun runtime");
    this.db = new sqlite.Database(file, { create: true });
    fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS tickets (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, since INTEGER NOT NULL, owner TEXT); CREATE TABLE IF NOT EXISTS suspended (key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY, last INTEGER); INSERT OR IGNORE INTO admission VALUES (1, NULL);");
    this.db.exec("CREATE TABLE IF NOT EXISTS stage_admissions (key TEXT PRIMARY KEY);");
    if (!this.db.query<{ name: string }, []>("PRAGMA table_info(tickets)").all().some(column => column.name === "polled")) {
      try {
        this.db.exec("ALTER TABLE tickets ADD COLUMN polled INTEGER");
        // A ticket queued before polls existed may have a live checker: it
        // gets one bound from here to show it, whatever its age.
        this.db.query("UPDATE tickets SET polled = ? WHERE owner IS NULL").run(this.now());
      } catch (error) { if (!/duplicate column/i.test(String(error))) throw error; }
    }
    // A release that predates polls shares this file for as long as it serves,
    // and its check only repeats this insert. The trigger lives in the file, so
    // that insert records the poll too, with the clock the checker passed.
    this.db.exec("CREATE TRIGGER IF NOT EXISTS tickets_polled BEFORE INSERT ON tickets BEGIN UPDATE tickets SET polled = NEW.since WHERE key = NEW.key; END");
  }
  close(): void { this.db.close(); }
  cancel(key: string): void {
    this.db.query("DELETE FROM stage_admissions WHERE key = ?").run(key);
    this.db.query("DELETE FROM suspended WHERE key = ?").run(key);
    this.db.query("DELETE FROM tickets WHERE key = ?").run(key);
  }
  /** Another admission fence may hold a stage for longer than the CPU bound.
   * Retain its sequence and timestamp without blocking eligible heavy work. */
  suspend(key: string): void {
    this.db.query("INSERT OR IGNORE INTO suspended SELECT key FROM tickets WHERE key = ? AND owner IS NULL").run(key);
    this.touch(key);
  }
  /** Its owner holding or releasing a ticket shows the owner is there, as a
   * check does: a released stage is ahead of later work before its next tick. */
  private touch(key: string): void {
    this.db.query("UPDATE tickets SET polled = ? WHERE key = ? AND owner IS NULL").run(this.now(), key);
  }
  /** Only the release owning this pipeline namespace reconciles stage tickets. */
  reconcile(prefix: string, active: ReadonlySet<string>, eligible = active): void {
    this.db.transaction(() => {
      for (const row of this.db.query<Ticket, []>("SELECT * FROM tickets WHERE owner IS NULL").all()) {
        if (!row.key.startsWith(prefix)) continue;
        if (!active.has(row.key)) this.cancel(row.key);
        else {
          // A pending durable row has not checkpointed its start. Replay the
          // original ticket after a crash, preserving both sequence and age.
          this.db.query("DELETE FROM stage_admissions WHERE key = ?").run(row.key);
          if (!eligible.has(row.key)) this.suspend(row.key);
          else if (this.db.query("DELETE FROM suspended WHERE key = ?").run(row.key).changes > 0) this.touch(row.key);
        }
      }
    }).immediate();
  }
  check(key: string, pressureAllows: boolean, owner?: ProcessIdentity, consume = true): CpuQueueWait | null {
    return this.db.transaction(() => {
      const now = this.now();
      for (const row of this.db.query<Ticket, []>("SELECT * FROM tickets WHERE owner IS NOT NULL").all()) {
        const identity = JSON.parse(row.owner!) as ProcessIdentity;
        if (processIdentityStatus(identity) === "dead" || procBackend.processExited(identity.pid)) this.cancel(row.key);
      }
      for (const row of this.db.query<{ key: string }, [number]>("SELECT key FROM tickets WHERE owner IS NULL AND COALESCE(polled, since) < ? AND key NOT IN (SELECT key FROM suspended)").all(now - CPU_QUEUE_ABANDONED_MS)) this.cancel(row.key);
      // The insert is the poll: tickets_polled stamps an existing row with `now`.
      this.db.query("INSERT OR IGNORE INTO tickets (key, since, owner) VALUES (?, ?, ?)").run(key, now, owner ? JSON.stringify(owner) : null);
      this.db.query("DELETE FROM suspended WHERE key = ?").run(key);
      this.db.query("DELETE FROM stage_admissions WHERE key = ?").run(key);
      const ticket = this.db.query<Ticket, [string]>("SELECT * FROM tickets WHERE key = ?").get(key)!;
      // An ownerless ticket nobody polls is passed over, never removed here:
      // its instance may only be restarting, and it returns to its sequence
      // and age with its next check. Spacing below still separates starts.
      const counted = "seq <= ?1 AND key NOT IN (SELECT key FROM suspended) AND key NOT IN (SELECT key FROM stage_admissions) AND NOT (owner IS NULL AND COALESCE(polled, since) < ?2)";
      const unpolledBefore = now - this.unpolledMs;
      const ahead = this.db.query<{ n: number; since: number | null }, [number, number]>(`SELECT COUNT(*) AS n, MAX(CASE WHEN seq < ?1 THEN since END) AS since FROM tickets WHERE ${counted}`).get(ticket.seq, unpolledBefore)!;
      const head = this.db.query<{ since: number }, [number, number]>(`SELECT since FROM tickets WHERE ${counted} ORDER BY seq LIMIT 1`).get(ticket.seq, unpolledBefore)!;
      const position = ahead.n;
      const last = this.db.query<{ last: number | null }, []>("SELECT last FROM admission WHERE id = 1").get()!.last;
      const spacing = last === null ? 0 : Math.max(0, last + this.spacingMs - now);
      // Pressure may rise again before this queued ticket reaches the head.
      // Display the durable worst-case bound even on a permissive sample.
      const budget = Math.max(0, this.maxWaitMs - (now - ticket.since));
      const priorBudget = ahead.since === null ? 0 : Math.max(0, this.maxWaitMs - (now - ahead.since));
      if (position === 1 && spacing === 0 && (pressureAllows || budget === 0)) {
        if (consume) {
          // Commands settle at their kernel slot claim. Stages retain a
          // recoverable admission until their own start checkpoint is read.
          if (!owner && (key.startsWith("stage:") || key.startsWith("workflow:"))) {
            this.db.query("INSERT OR IGNORE INTO stage_admissions VALUES (?)").run(key);
          } else this.cancel(key);
          this.db.query("UPDATE admission SET last = ? WHERE id = 1").run(now);
        }
        return null;
      }
      // The bounds above assume the head is admitted at its own. Once it is
      // past that and nothing has been admitted since, they promise nothing.
      const stalledMs = now - Math.max(head.since + this.maxWaitMs, last ?? 0);
      return {
        since: ticket.since, position, remainingMs: Math.max(budget, priorBudget, spacing) + (position - 1) * this.spacingMs,
        ...(stalledMs > CPU_QUEUE_STALE_GRACE_MS ? { stalledMs } : {}),
      };
    }).immediate();
  }
}

const queueSymbol = Symbol.for("delegatus.cpuAdmission");
const globals = globalThis as typeof globalThis & { [queueSymbol]?: { file: string; queue: CpuAdmissionQueue } };
export function machineCpuAdmissionQueue(isolatedStateDir?: string | null): CpuAdmissionQueue {
  const file = cpuAdmissionFile(isolatedStateDir);
  if (globals[queueSymbol]?.file !== file) {
    globals[queueSymbol]?.queue.close();
    globals[queueSymbol] = { file, queue: new CpuAdmissionQueue(file) };
  }
  return globals[queueSymbol]!.queue;
}
export function cpuCommandOwner(): ProcessIdentity { return captureProcessIdentity(process.pid); }
