import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Database } from "bun:sqlite";

import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../processIdentity";
import { procBackend } from "../proc";

export const CPU_QUEUE_MAX_WAIT_MS = 10 * 60_000;
export const CPU_QUEUE_SPACING_MS = 2_000;
export type CpuQueueWait = { since: number; position: number; remainingMs: number };
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
function machineHome(): string {
  if (nativeHome[homeSymbol]) return nativeHome[homeSymbol]!;
  // Bun's userInfo delegates to homedir, which reads HOME/USERPROFILE first.
  // A tiny synchronous child uses the native account/profile fallback without
  // changing the Viewer's environment. NSS remains intact inside the image.
  const env = { ...process.env };
  delete env.HOME; delete env.USERPROFILE;
  const result = spawnSync(process.execPath, ["-e", 'process.stdout.write(require("node:os").userInfo().homedir)'], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
  });
  if (result.status !== 0 || !path.isAbsolute(result.stdout ?? "")) throw new Error("CPU admission could not resolve the native user home");
  return nativeHome[homeSymbol] = result.stdout;
}

/** Shared by the Viewer and gate-slot, including children with sandboxed HOME. */
export function cpuAdmissionFile(): string {
  // The passwd home is stable when agent/test commands sandbox HOME. It is
  // mounted writable into the Viewer image; /var/tmp there is read-only.
  return path.join(process.env.LLV_GATE_LOCK_DIR || path.join(machineHome(), ".cache", "delegatus-cpu"), "admission.sqlite");
}

/** Admission is committed under SQLite's writer lock, before a caller starts.
 * Stage keys outlive the Viewer; command keys carry a kernel start identity.
 * Sequence numbers break equal-clock ties and never depend on tick order. */
export class CpuAdmissionQueue {
  private readonly db: Database;
  constructor(file: string, private readonly now = Date.now, private readonly spacingMs = CPU_QUEUE_SPACING_MS, private readonly maxWaitMs = CPU_QUEUE_MAX_WAIT_MS) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite?.Database) throw new Error("CPU admission requires the supported Bun runtime");
    this.db = new sqlite.Database(file, { create: true });
    fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS tickets (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, since INTEGER NOT NULL, owner TEXT); CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY, last INTEGER); INSERT OR IGNORE INTO admission VALUES (1, NULL);");
  }
  close(): void { this.db.close(); }
  cancel(key: string): void { this.db.query("DELETE FROM tickets WHERE key = ?").run(key); }
  /** Only the release owning this pipeline namespace reconciles stage tickets. */
  reconcile(prefix: string, active: ReadonlySet<string>): void {
    this.db.transaction(() => {
      for (const row of this.db.query<Ticket, []>("SELECT * FROM tickets WHERE owner IS NULL").all()) {
        if (row.key.startsWith(prefix) && !active.has(row.key)) this.cancel(row.key);
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
      this.db.query("INSERT OR IGNORE INTO tickets (key, since, owner) VALUES (?, ?, ?)").run(key, now, owner ? JSON.stringify(owner) : null);
      const ticket = this.db.query<Ticket, [string]>("SELECT * FROM tickets WHERE key = ?").get(key)!;
      const ahead = this.db.query<{ n: number; since: number | null }, [number, number]>("SELECT COUNT(*) AS n, MAX(CASE WHEN seq < ? THEN since END) AS since FROM tickets WHERE seq <= ?").get(ticket.seq, ticket.seq)!;
      const position = ahead.n;
      const last = this.db.query<{ last: number | null }, []>("SELECT last FROM admission WHERE id = 1").get()!.last;
      const spacing = last === null ? 0 : Math.max(0, last + this.spacingMs - now);
      // Pressure may rise again before this queued ticket reaches the head.
      // Display the durable worst-case bound even on a permissive sample.
      const budget = Math.max(0, this.maxWaitMs - (now - ticket.since));
      const priorBudget = ahead.since === null ? 0 : Math.max(0, this.maxWaitMs - (now - ahead.since));
      if (position === 1 && spacing === 0 && (pressureAllows || budget === 0)) {
        if (consume) {
          this.cancel(key);
          this.db.query("UPDATE admission SET last = ? WHERE id = 1").run(now);
        }
        return null;
      }
      return { since: ticket.since, position, remainingMs: Math.max(budget, priorBudget, spacing) + (position - 1) * this.spacingMs };
    }).immediate();
  }
}

const queueSymbol = Symbol.for("delegatus.cpuAdmission");
const globals = globalThis as typeof globalThis & { [queueSymbol]?: { file: string; queue: CpuAdmissionQueue } };
export function machineCpuAdmissionQueue(): CpuAdmissionQueue {
  const file = cpuAdmissionFile();
  if (globals[queueSymbol]?.file !== file) {
    globals[queueSymbol]?.queue.close();
    globals[queueSymbol] = { file, queue: new CpuAdmissionQueue(file) };
  }
  return globals[queueSymbol]!.queue;
}
export function cpuCommandOwner(): ProcessIdentity { return captureProcessIdentity(process.pid); }
