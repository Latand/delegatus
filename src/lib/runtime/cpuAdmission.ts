import { observeSqlite, parseSqliteJson } from "@/lib/sqliteReadAttribution";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Database } from "bun:sqlite";
import { readCpuPriority, type CpuPrioritySource } from "./cpuPriority";
import type { TaskPriority } from "../tasks/types";

import { processIdentityStatus, systemBootEpoch, type ProcessIdentity, type ProcessIdentityStatus } from "../processIdentity";
import { procBackend } from "../proc";
import { cpuOwnerIdentity, cpuOwnerStatus, cpuOwnerExited, signalSandboxContext } from "./signalSandboxContext";

export const CPU_QUEUE_MAX_WAIT_MS = 10 * 60_000;
export const CPU_QUEUE_SPACING_MS = 2_000;
export const CPU_STAGE_POLL_MS = 5_000;
/** A waiting stage polls every five seconds. Ownerless tickets, bounded Linux
 * gate waiters and unverifiable owners that stop polling keep their rows but
 * stop counting ahead of others, for every release sharing the file. */
export const CPU_QUEUE_UNPOLLED_MS = 60_000;
/** An ownerless ticket unpolled for this long, and held by no fence, is
 * removed; so is a ticket whose owner no kernel check here can prove alive. */
export const CPU_QUEUE_ABANDONED_MS = 24 * 60 * 60_000;
/** How long a head may stay past its bound, with nothing admitted, before the wait reads as stalled. */
export const CPU_QUEUE_STALE_GRACE_MS = 60_000;
const BOUNDED_GATE_PREFIX = "command:bounded:";
export const ACTIVE_GATE_PREFIX = "command:gate-active:";
const PUBLICATION_LAUNCHES = "publication_launches";
/** More live publications than this never run on one machine. */
const PUBLICATION_LAUNCH_LIMIT = 64;
function readPublicationLaunch(stored: string): ProcessIdentity | null {
  try {
    const identity = JSON.parse(stored) as ProcessIdentity | null;
    return identity && Number.isSafeInteger(identity.pid) && identity.pid > 0 && typeof identity.startIdentity === "string"
      && typeof identity.bootEpoch === "string" && identity.bootEpoch ? identity : null;
  } catch { return null; }
}
/** `stalledMs` is set only while the head is past its bound and nothing is admitted. */
export type CpuQueueWait = { since: number; position: number; waitedMs: number; heldBy: "queue" | "pressure"; priority?: TaskPriority; stalledMs?: number };
/** Recent kernel capacity evidence from before admission. Any intervening
 * admission invalidates the observation, including on a different process. */
export type UrgentStageCapacity = {
  key: string; revision: string; sampledAt: number; lastBeforeProbe: number | null; hasCapacity: boolean;
};
type UrgentStageDecision = { evidence: UrgentStageCapacity; currentRevision(): string | null };

function matchesUrgentStage(decision: UrgentStageDecision): boolean {
  try { return decision.currentRevision() === decision.evidence.revision; }
  catch { return false; } // A state reader with no current evidence cannot authorize an early start.
}
type Ticket = { seq: number; fifo_seq: number; key: string; since: number; owner: string | null; priority: number; source: string | null; polled: number | null; low_pressure: number; linux_poll: string | null };
const boundedLinuxGateWaiter = (row: Ticket) =>
  process.platform === "linux" && row.low_pressure === 1 && row.key.startsWith(BOUNDED_GATE_PREFIX);
type LinuxGatePoll = { domain: string; ms: number };
/** A time namespace shows CLOCK_BOOTTIME plus its own offset. Null when this
 * process is in a time namespace whose offset cannot be read. */
function linuxBootOffsetMs(): number | null {
  try {
    const offset = /^boottime\s+(-?\d+)\s+(\d+)\s*$/m.exec(fs.readFileSync("/proc/self/timens_offsets", "utf8"));
    return offset ? Number(offset[1]) * 1000 + Number(offset[2]) / 1_000_000 : null;
  } catch {
    // A kernel without time namespaces has neither file and no offset.
    return fs.existsSync("/proc/self/ns/time") ? null : 0;
  }
}
function openLinuxGateClock(): (() => LinuxGatePoll | null) | null {
  try {
    const epoch = systemBootEpoch()?.split(":")[1];
    const ffi = process.getBuiltinModule?.("bun:ffi") as typeof import("bun:ffi") | undefined;
    const offset = linuxBootOffsetMs();
    if (!epoch || !ffi || offset === null) return null;
    // Samples are kept on the host's boot clock, so helpers in different time
    // namespaces of one boot age a ticket on the same clock.
    const domain = `${epoch}:host-boottime`;
    const library = ffi.dlopen("libc.so.6", { clock_gettime: { args: ["i32", "ptr"], returns: "i32" } });
    const time = new BigInt64Array(2);
    return () => {
      // CLOCK_BOOTTIME is shared by the independent helpers and is immune to
      // wall-clock steps. Bun's hrtime starts over in each helper.
      if (library.symbols.clock_gettime(7, ffi.ptr(time)) !== 0) return null;
      return { domain, ms: Number(time[0]) * 1000 + Number(time[1]) / 1_000_000 - offset };
    };
  } catch { return null; }
}
let readLinuxGateClock: ReturnType<typeof openLinuxGateClock> | undefined;
function linuxGateClock(): LinuxGatePoll | null {
  if (readLinuxGateClock === undefined) readLinuxGateClock = openLinuxGateClock();
  return readLinuxGateClock?.() ?? null;
}
const linuxPollStamp = (poll: LinuxGatePoll) => `${poll.domain}:${poll.ms}`;
function linuxPollAge(row: Ticket, clock: LinuxGatePoll | null): number | null {
  if (!clock || !row.linux_poll) return null;
  const split = row.linux_poll.lastIndexOf(":");
  if (split <= 0 || row.linux_poll.slice(0, split) !== clock.domain || split === row.linux_poll.length - 1) return null;
  const ms = Number(row.linux_poll.slice(split + 1));
  return Number.isFinite(ms) && ms >= 0 && ms <= clock.ms ? clock.ms - ms : null;
}
type GateSlot = { slot: number | null; cap: number };
type ActiveGateSlot = GateSlot & { key: string; owner: string };
/** The queue judges owners with these; `log` receives one line for each ticket
 * it removes or passes over because of its owner. */
export type CpuOwnerObserver = { status(identity: ProcessIdentity): ProcessIdentityStatus; exited(identity: ProcessIdentity): boolean; log?(line: string): void };
const logOwnerDecision = (line: string) => console.warn(`[cpu-admission] ${line}`);
/** Every release's check stamps its own ticket through this trigger, owned or
 * not, so even a release whose statements predate it shows that its owner is
 * still there. */
const TICKETS_POLL = "CREATE TRIGGER tickets_poll BEFORE INSERT ON tickets BEGIN UPDATE tickets SET polled = NEW.since WHERE key = NEW.key; DELETE FROM unpolled WHERE key = NEW.key; END";
const TICKETS_FIFO = `CREATE TRIGGER tickets_fifo AFTER INSERT ON tickets BEGIN
        UPDATE tickets SET fifo_seq = COALESCE(fifo_seq, (SELECT next FROM ticket_order WHERE id = 1)) WHERE key = NEW.key;
        UPDATE ticket_order SET next = MAX(next, (SELECT COALESCE(MAX(fifo_seq), 0) + 1 FROM tickets)) WHERE id = 1;
        -- Rebuild the seq view for every membership change. Older helpers
        -- write only seq/since/owner, so this trigger is their ordering
        -- boundary even when the new row's default priority is unchanged.
        -- Offset first to avoid collisions in the primary key.
        UPDATE tickets SET seq = seq + (SELECT COALESCE(MAX(seq), 0) + COUNT(*) + 1 FROM tickets);
        UPDATE tickets SET seq = (
          SELECT COUNT(*) FROM tickets AS earlier
          WHERE earlier.priority < tickets.priority
             OR (earlier.priority = tickets.priority AND earlier.fifo_seq <= tickets.fifo_seq)
        );
        UPDATE sqlite_sequence SET seq = (SELECT COUNT(*) FROM tickets) WHERE name = 'tickets';
      END`;
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
    if (!match || Number(match[1]) > Number(env.LLV_GATE_SLOTS ?? 6)
      || fs.realpathSync(path.dirname(lease.slot)) !== fs.realpathSync(env.LLV_GATE_LOCK_DIR ?? "/var/tmp")) return null;
    const context = signalSandboxContext(env);
    const proc = context?.hostProc ?? "/proc";
    if (cpuOwnerStatus(lease.owner, env) !== "alive") return null;
    // An ancestor namespace's readable PID is insufficient lease authority.
    if (context && fs.readlinkSync(path.join(proc, String(lease.owner.pid), "ns/user")) !== context.userNamespace) return null;
    const descriptor = path.join(proc, String(lease.owner.pid), "fd", "9");
    const file = fs.statSync(lease.slot, { bigint: true }), fd = fs.statSync(descriptor, { bigint: true });
    const info = fs.readFileSync(path.join(proc, String(lease.owner.pid), "fdinfo", "9"), "utf8");
    const inode = /^ino:\s+(\d+)$/m.exec(info)?.[1];
    if (file.dev !== fd.dev || file.ino !== fd.ino || !inode || BigInt(inode) !== file.ino || !/^lock:.*\bFLOCK\b.*\bWRITE\b/m.test(info)) return null;
    return cpuOwnerStatus(lease.owner, env) === "alive" && !cpuOwnerExited(lease.owner, env) ? lease : null;
  } catch { return null; }
}
export function cpuSlotForOwner(owner: ProcessIdentity, env = process.env): CpuSlotLease | null {
  if (process.platform !== "linux") return null;
  try {
    const slot = fs.readlinkSync(path.join(signalSandboxContext(env)?.hostProc ?? "/proc", String(owner.pid), "fd", "9"));
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
  // eslint-disable-next-line no-restricted-syntax -- Legacy cached native-home probe on first CPU admission, including serving launch paths.
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
    // their own script, so the outer heavy command still shares the machine queue.
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
 * ticket whose instance went away stops holding the head (2026-10-13).
 *
 * A release that predates polls shares this file for as long as it serves, and
 * its statements are fixed. Whatever it has to see is therefore kept in the
 * tables it reads, and whatever it has to record is recorded by triggers,
 * which live in the file and run for every connection:
 * - a passed-over ticket gets a row in `suspended`, which every release
 *   skips, and one in `unpolled`, which tells it from a fence's hold;
 * - the insert every check repeats records the poll and ends the passing over
 *   (`tickets_poll`, `tickets_queued`);
 * - a hold replaces the passing over, and its release starts one fresh bound:
 *   `polled` NULL reads "seen now" at the next current check, so a trigger
 *   needs no clock (`suspended_hold`, `suspended_release`);
 * - a reconcile leaves the passing over in place; the ticket's own check ends
 *   it (`suspended_keep`);
 * - a removed ticket leaves nothing behind (`tickets_gone`). */
export class CpuAdmissionQueue {
  private readonly db: Database;
  constructor(file: string, private readonly now = Date.now, private readonly spacingMs = CPU_QUEUE_SPACING_MS, private readonly maxWaitMs = CPU_QUEUE_MAX_WAIT_MS, private readonly unpolledMs = CPU_QUEUE_UNPOLLED_MS,
    private readonly observer: CpuOwnerObserver = {
      status: processIdentityStatus, exited: identity => procBackend.processExited(identity.pid),
    }, busyTimeoutMs = 5_000, private readonly linuxClock = linuxGateClock) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite?.Database) throw new Error("CPU admission requires the supported Bun runtime");
    this.db = observeSqlite(new sqlite.Database(file, { create: true }), "cpu-admission");
    try {
      fs.chmodSync(file, 0o600);
      this.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(busyTimeoutMs))}`);
      this.db.exec("PRAGMA journal_mode=WAL");
      this.db.exec("PRAGMA synchronous=FULL");
      // Inspect the persisted schema before asking for the writer. A warm
      // opener neither reinstalls triggers nor takes a write transaction.
      const schemaReady = () => {
        const triggers = new Map(this.db.query<{ name: string; sql: string }, []>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all().map(row => [row.name, row.sql]));
        const columns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(tickets)").all().map(row => row.name));
        const cutoverColumns = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(legacy_gate_cutover)").all().map(row => row.name));
        return triggers.has("legacy_gate_retired") && triggers.has("tickets_linux_poll_reset") && triggers.get("tickets_fifo") === TICKETS_FIFO && triggers.get("tickets_poll") === TICKETS_POLL
          && ["priority", "source", "low_pressure", "aging", "fifo_seq", "linux_poll"].every(name => columns.has(name)) && cutoverColumns.has("admission");
      };
      if (!schemaReady()) {
        const opened = this.now();
        this.db.transaction(() => {
          // Another opener may have finished while this one waited.
          if (schemaReady()) return;
          this.db.exec("CREATE TABLE IF NOT EXISTS tickets (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, since INTEGER NOT NULL, owner TEXT)");
          this.db.exec("CREATE TABLE IF NOT EXISTS suspended (key TEXT PRIMARY KEY)");
          this.db.exec("CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY, last INTEGER)");
          this.db.exec("INSERT OR IGNORE INTO admission VALUES (1, NULL)");
          this.db.exec("CREATE TABLE IF NOT EXISTS stage_admissions (key TEXT PRIMARY KEY);");
          // The last trigger marks the whole step. It commits with the column and
          // the first bound under one writer lock, so no checker of any release
          // ever reads a file that has the column and not the rest.
          const recordsPolls = () => this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'tickets_gone'").get() !== null;
          if (!recordsPolls()) {
            if (!this.db.query<{ name: string }, []>("PRAGMA table_info(tickets)").all().some(column => column.name === "polled")) this.db.exec("ALTER TABLE tickets ADD COLUMN polled INTEGER");
            this.db.exec("CREATE TABLE IF NOT EXISTS unpolled (key TEXT PRIMARY KEY)");
            // The first cut of this change recorded polls with this one trigger.
            this.db.exec("DROP TRIGGER IF EXISTS tickets_polled");
            this.db.exec("CREATE TRIGGER tickets_poll BEFORE INSERT ON tickets BEGIN UPDATE tickets SET polled = NEW.since WHERE key = NEW.key AND owner IS NULL; DELETE FROM unpolled WHERE key = NEW.key; END");
            this.db.exec("CREATE TRIGGER tickets_queued AFTER INSERT ON tickets WHEN NEW.owner IS NULL AND NEW.polled IS NULL BEGIN UPDATE tickets SET polled = NEW.since WHERE seq = NEW.seq; END");
            this.db.exec("CREATE TRIGGER suspended_hold BEFORE INSERT ON suspended BEGIN DELETE FROM unpolled WHERE key = NEW.key; END");
            this.db.exec("CREATE TRIGGER suspended_keep BEFORE DELETE ON suspended WHEN OLD.key IN (SELECT key FROM unpolled) BEGIN SELECT RAISE(IGNORE); END");
            this.db.exec("CREATE TRIGGER suspended_release AFTER DELETE ON suspended BEGIN UPDATE tickets SET polled = NULL WHERE key = OLD.key AND owner IS NULL; END");
            // A ticket queued before polls existed may have a live checker: it
            // gets one bound from here to show it, whatever its age.
            this.db.query("UPDATE tickets SET polled = ? WHERE owner IS NULL AND polled IS NULL").run(opened);
            this.db.exec("CREATE TRIGGER tickets_gone AFTER DELETE ON tickets BEGIN DELETE FROM unpolled WHERE key = OLD.key; DELETE FROM suspended WHERE key = OLD.key; END");
          }
          const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(tickets)").all();
          if (!columns.some(column => column.name === "priority")) this.db.exec("ALTER TABLE tickets ADD COLUMN priority INTEGER NOT NULL DEFAULT 1");
          if (!columns.some(column => column.name === "source")) this.db.exec("ALTER TABLE tickets ADD COLUMN source TEXT");
          // Set by a ticket's own check: it starts only while measured pressure is
          // low. Helpers that predate the column leave it 0, the old behaviour.
          if (!columns.some(column => column.name === "low_pressure")) this.db.exec("ALTER TABLE tickets ADD COLUMN low_pressure INTEGER NOT NULL DEFAULT 0");
          // Legacy checkers still publish wall-clock polls through tickets_poll.
          // Their writes invalidate the boot-clock sample, even for a repeated
          // wall timestamp. This release writes its sample after that update.
          if (!columns.some(column => column.name === "linux_poll")) this.db.exec("ALTER TABLE tickets ADD COLUMN linux_poll TEXT");
          this.db.exec(`CREATE TRIGGER IF NOT EXISTS tickets_linux_poll_reset AFTER UPDATE OF polled ON tickets
            WHEN NEW.linux_poll IS NOT NULL BEGIN UPDATE tickets SET linux_poll = NULL WHERE key = NEW.key; END`);
          // Only a ticket checked by an aging-aware owner may gain effective rank.
          // Legacy owners keep comparing task rank/seq and cannot act on its age.
          if (!columns.some(column => column.name === "aging")) this.db.exec("ALTER TABLE tickets ADD COLUMN aging INTEGER NOT NULL DEFAULT 0");
          if (!columns.some(column => column.name === "fifo_seq")) {
            this.db.exec("ALTER TABLE tickets ADD COLUMN fifo_seq INTEGER");
            this.db.exec("UPDATE tickets SET fifo_seq = seq");
          }
          this.db.exec("CREATE TABLE IF NOT EXISTS ticket_order (id INTEGER PRIMARY KEY CHECK (id = 1), next INTEGER NOT NULL)");
          if (!this.db.query("SELECT 1 FROM ticket_order WHERE id = 1").get()) {
            const next = this.db.query<{ next: number }, []>("SELECT COALESCE(MAX(fifo_seq), 0) + 1 AS next FROM tickets").get()!.next;
            this.db.query("INSERT INTO ticket_order VALUES (1, ?)").run(next);
          }
          this.db.exec("DROP TRIGGER IF EXISTS tickets_fifo");
          this.db.exec(TICKETS_FIFO);
          if (!this.db.query("SELECT 1 FROM sqlite_master WHERE name = 'legacy_gate_retired'").get()) {
            // Historical shells delete their own command ticket when claiming.
            // A cancellation is also a possible claim until that identity exits.
            this.db.exec(`CREATE TABLE legacy_gate_retirements (seq INTEGER PRIMARY KEY, owner TEXT);
              CREATE TABLE legacy_gate_cutover (id INTEGER PRIMARY KEY, boot TEXT, clock TEXT, uptime REAL, admission INTEGER, overflow INTEGER NOT NULL);
              INSERT INTO legacy_gate_cutover VALUES (1, NULL, NULL, NULL, NULL, 0);
              CREATE TRIGGER legacy_gate_retired AFTER DELETE ON tickets WHEN OLD.key GLOB 'command:[0-9]*' BEGIN
                INSERT INTO legacy_gate_retirements (owner) VALUES (OLD.owner);
                UPDATE legacy_gate_cutover SET overflow = 1 WHERE overflow = 0 AND last_insert_rowid() > 128;
                DELETE FROM legacy_gate_retirements WHERE seq <= last_insert_rowid() - 128;
              END`);
            if (this.lastAdmission() !== null) this.restartLegacyObservation();
          }
          if (!this.db.query<{ name: string }, []>("PRAGMA table_info(legacy_gate_cutover)").all().some(column => column.name === "admission")) {
            this.db.exec("ALTER TABLE legacy_gate_cutover ADD COLUMN admission INTEGER");
            this.restartLegacyObservation();
          }
          this.db.exec("CREATE INDEX IF NOT EXISTS tickets_priority_seq ON tickets(priority, seq)");
          // The poll trigger above stamped only ownerless tickets at first.
          if (this.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'tickets_poll'").get()?.sql !== TICKETS_POLL) {
            this.db.exec("DROP TRIGGER IF EXISTS tickets_poll");
            this.db.exec(TICKETS_POLL);
          }
        }).immediate();
      }
      // Repair a queue left in the inconsistent order produced by the earlier
      // priority implementation before any old or new checker can claim it.
      const ordered = this.db.query<{ seq: number }, []>("SELECT seq FROM tickets ORDER BY priority, fifo_seq").all();
      if (!ordered.every((row, index) => row.seq === index + 1)) {
        this.db.transaction(() => this.orderLegacyTicketsByPriority()).immediate();
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
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
    this.db.query("UPDATE tickets SET polled = ? WHERE key = ?").run(this.now(), key);
  }
  /** Older gate helpers share this file and use fixed `seq`-ordered queries.
   * Keep that durable view in priority order so they cannot admit ahead of a
   * ticket whose priority an upgraded checker has observed. Equal priorities
   * retain their prior sequence order. */
  private orderLegacyTicketsByPriority(): void {
    const rows = this.db.query<{ seq: number; priority: number }, []>("SELECT seq, priority FROM tickets ORDER BY priority, fifo_seq").all();
    if (rows.every((row, index) => row.seq === index + 1)) return;
    const offset = Math.max(0, ...rows.map(row => row.seq)) + rows.length + 1;
    this.db.query("UPDATE tickets SET seq = seq + ?").run(offset);
    const assign = this.db.query("UPDATE tickets SET seq = ? WHERE seq = ?");
    rows.forEach((row, index) => assign.run(index + 1, row.seq + offset));
    this.db.query("UPDATE sqlite_sequence SET seq = ? WHERE name = 'tickets'").run(rows.length);
  }
  private stalledDuration(now: number, headSince: number, last: number | null): number | undefined {
    const elapsed = now - Math.max(headSince + this.maxWaitMs, last ?? 0);
    return elapsed > CPU_QUEUE_STALE_GRACE_MS ? elapsed : undefined;
  }
  /** A ready command stays at the head while its outer slot is unavailable. */
  slotWait(key: string): { waitedMs: number; stalledMs?: number } {
    const row = this.db.query<{ since: number; last: number | null }, [string]>(
      "SELECT since, last FROM tickets CROSS JOIN admission WHERE key = ? AND admission.id = 1",
    ).get(key)!;
    const now = this.now();
    return { waitedMs: Math.max(0, now - row.since), stalledMs: this.stalledDuration(now, row.since, row.last) };
  }
  lastAdmission(): number | null {
    return this.db.query<{ last: number | null }, []>("SELECT last FROM admission WHERE id = 1").get()!.last;
  }
  // Called with the SQLite writer held. A process already running at this
  // boundary can own an unobserved grant. A later birth has complete history.
  private restartLegacyObservation(): void {
    const context = process.platform === "linux" ? signalSandboxContext() : null;
    let uptime: number | null = null, clock: string | null = null;
    if (process.platform === "linux") {
      const proc = context?.hostProc ?? "/proc";
      try {
        clock = fs.readlinkSync(path.join(proc, "self/ns/time"));
        uptime = Number(fs.readFileSync(path.join(proc, "uptime"), "utf8").split(" ")[0]);
      }
      catch { /* An unavailable clock keeps the pre-existing grant uncertain. */ }
    }
    this.db.query("UPDATE legacy_gate_cutover SET boot = ?, clock = ?, uptime = ?, admission = ?, overflow = 0").run(
      context?.hostEpoch ?? (process.platform === "linux" ? systemBootEpoch() : null) ?? "unknown", clock, uptime, this.lastAdmission());
    this.db.exec("DELETE FROM legacy_gate_retirements");
  }
  legacyGateHistory(epoch: string) {
    const snapshot = () => this.db.transaction(() => ({
      cutover: this.db.query<{ boot: string | null; clock: string | null; uptime: number | null; admission: number | null; overflow: number }, []>(
        "SELECT boot, clock, uptime, admission, overflow FROM legacy_gate_cutover WHERE id = 1").get()!,
      rows: this.db.query<{ owner: string | null }, []>("SELECT owner FROM legacy_gate_retirements").all(),
    }))();
    const read = () => {
      const { cutover, rows } = snapshot();
      const retirements = new Set<string>();
      let complete = !cutover.overflow;
      for (const row of rows) {
        let owner: ProcessIdentity | null = null;
        try { if (row.owner) owner = JSON.parse(row.owner) as ProcessIdentity; }
        catch { /* A malformed historical identity requires a new observation. */ }
        if (owner && owner.bootEpoch === epoch && Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
          typeof owner.startIdentity === "string" && /^\d+:\d+$/.test(owner.startIdentity) && owner.startIdentity.startsWith(`${owner.pid}:`)) {
          retirements.add(owner.startIdentity);
        } else complete = false;
      }
      return { cutover, retirements, complete };
    };
    const history = read();
    if (history.complete) return history;
    // A missed or untranslatable retirement invalidates absence as evidence
    // for existing processes. Later births get a fresh, complete observation.
    return this.db.transaction(() => {
      if (!read().complete) this.restartLegacyObservation();
      return read();
    }).immediate();
  }
  waitingGateOwners(): string[] {
    return this.db.query<{ owner: string }, []>(`SELECT DISTINCT owner FROM tickets
      WHERE owner IS NOT NULL AND key GLOB 'command:*' AND key NOT GLOB '${ACTIVE_GATE_PREFIX}*'`).all().map(row => row.owner);
  }
  /** The Viewer records each publication preparer it starts by the kernel
   * identity of the process it spawned and the operation it handed that
   * process. Gate helpers read the rows to tell the preparer's cleanup runner
   * from a legacy holder, whatever bytes the lane's checkout carries. A row
   * proves nothing alone: a reader must match it to a live process that still
   * carries the same operation. Older releases never read this table. */
  recordPublicationLaunch(identity: ProcessIdentity, operation: string): void {
    // Probe the processes before taking the writer, as check() does.
    const ended = this.publicationLaunchRows().filter(row => {
      const launch = readPublicationLaunch(row.identity);
      return !launch || this.observer.status(launch) === "dead";
    }).map(row => row.identity);
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${PUBLICATION_LAUNCHES} (identity TEXT PRIMARY KEY, operation TEXT NOT NULL, recorded INTEGER NOT NULL)`);
      const remove = this.db.query(`DELETE FROM ${PUBLICATION_LAUNCHES} WHERE identity = ?`);
      for (const row of ended) remove.run(row);
      this.db.query(`INSERT OR REPLACE INTO ${PUBLICATION_LAUNCHES} VALUES (?, ?, ?)`).run(JSON.stringify(identity), operation, this.now());
      // A Viewer that dies before forgetting leaves its row until the process
      // is seen dead. The newest rows are the live publications.
      this.db.query(`DELETE FROM ${PUBLICATION_LAUNCHES} WHERE identity NOT IN
        (SELECT identity FROM ${PUBLICATION_LAUNCHES} ORDER BY recorded DESC, rowid DESC LIMIT ?)`).run(PUBLICATION_LAUNCH_LIMIT);
    }).immediate();
  }
  forgetPublicationLaunch(identity: ProcessIdentity): void {
    if (!this.hasPublicationLaunches()) return;
    this.db.query(`DELETE FROM ${PUBLICATION_LAUNCHES} WHERE identity = ?`).run(JSON.stringify(identity));
  }
  publicationLaunches(): { identity: ProcessIdentity; operation: string }[] {
    return this.publicationLaunchRows().flatMap(row => {
      const identity = readPublicationLaunch(row.identity);
      return identity ? [{ identity, operation: row.operation }] : [];
    });
  }
  private hasPublicationLaunches(): boolean {
    return this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(PUBLICATION_LAUNCHES) !== null;
  }
  private publicationLaunchRows(): { identity: string; operation: string }[] {
    if (!this.hasPublicationLaunches()) return [];
    return this.db.query<{ identity: string; operation: string }, []>(`SELECT identity, operation FROM ${PUBLICATION_LAUNCHES}`).all();
  }
  activeGateSlots(): ActiveGateSlot[] {
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gate_slots'").get()) return [];
    return this.db.query<ActiveGateSlot, []>("SELECT tickets.key, owner, slot, cap FROM gate_slots JOIN tickets USING (key)").all();
  }
  // Retire precisely the observed claim. The caller has either reaped its
  // owned runner or proved that its lifetime lock is free.
  releaseGateSlot(key: string, owner: string): void {
    this.db.transaction(() => {
      if (this.db.query("DELETE FROM gate_slots WHERE key = ? AND EXISTS (SELECT 1 FROM tickets WHERE key = ? AND owner = ?)").run(key, key, owner).changes) {
        this.cancel(key);
      }
    }).immediate();
  }
  private recordGateSlot(key: string, gate: GateSlot): void {
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gate_slots'").get()) {
      // Older releases still write these tables directly. Slot recovery
      // belongs to the wrapper that can verify the lifetime proof.
      this.db.exec(`
        CREATE TABLE gate_slots (key TEXT PRIMARY KEY, slot INTEGER, cap INTEGER NOT NULL);
        CREATE TRIGGER gate_slot_keep BEFORE DELETE ON tickets
          WHEN OLD.key IN (SELECT key FROM gate_slots) BEGIN SELECT RAISE(IGNORE); END;
        CREATE TRIGGER gate_slot_count BEFORE INSERT ON suspended
          WHEN NEW.key IN (SELECT key FROM gate_slots) BEGIN SELECT RAISE(IGNORE); END;
        CREATE TRIGGER gate_slot_polled BEFORE INSERT ON unpolled
          WHEN NEW.key IN (SELECT key FROM gate_slots) BEGIN SELECT RAISE(IGNORE); END;
      `);
    }
    this.db.query("INSERT INTO gate_slots VALUES (?, ?, ?)").run(key, gate.slot, gate.cap);
  }
  /** Only the release owning this pipeline namespace reconciles stage tickets. */
  reconcile(prefix: string, active: ReadonlySet<string>, eligible = active): void {
    this.db.transaction(() => {
      const rows = prefix.endsWith(":")
        ? this.db.query<Ticket, [string, string]>("SELECT * FROM tickets WHERE owner IS NULL AND key >= ? AND key < ?")
          .all(prefix, `${prefix.slice(0, -1)};`)
        : this.db.query<Ticket, []>("SELECT * FROM tickets WHERE owner IS NULL").all();
      for (const row of rows) {
        if (!row.key.startsWith(prefix)) continue;
        if (!active.has(row.key)) this.cancel(row.key);
        else {
          // A pending durable row has not checkpointed its start. Replay the
          // original ticket after a crash, preserving both sequence and age.
          this.db.query("DELETE FROM stage_admissions WHERE key = ?").run(row.key);
          if (!eligible.has(row.key)) this.suspend(row.key);
          // A passed-over ticket stays so (suspended_keep): only its check returns it.
          else if (this.db.query("DELETE FROM suspended WHERE key = ?").run(row.key).changes > 0) this.touch(row.key);
        }
      }
    }).immediate();
  }
  check(key: string, pressureAllows: boolean, owner?: ProcessIdentity, consume = true, source?: CpuPrioritySource, requireLowPressure = false,
    gateSlot?: GateSlot & { lastBeforeProbe: number | null }, urgentStage?: UrgentStageDecision): CpuQueueWait | null {
    // Process probes and reads of the task database must not hold this
    // queue's writer. Re-read the rows under the lock and match observations
    // by their exact owner/binding and observed rank. Peers may poll or reorder
    // freely; an unobserved owner keeps its ticket until a check can verify it.
    const owners = new Map(this.db.query<{ owner: string }, []>("SELECT DISTINCT owner FROM tickets WHERE owner IS NOT NULL").all().map(row => {
      const identity = parseSqliteJson(row.owner, this.db) as ProcessIdentity;
      const status = this.observer.status(identity);
      return [row.owner, { identity, status, dead: status === "dead" || this.observer.exited(identity) }] as const;
    }));
    const priorities = new Map<string, number>();
    const rank = (binding: string) => {
      if (!priorities.has(binding)) {
        const priority = readCpuPriority(parseSqliteJson(binding, this.db) as CpuPrioritySource);
        priorities.set(binding, priority === "high" ? 0 : priority === "low" ? 2 : 1);
      }
    };
    const sampledAt = this.now();
    let sampledClock: LinuxGatePoll | null | undefined;
    const preflightClock = () => sampledClock === undefined ? sampledClock = this.linuxClock() : sampledClock;
    const sampledTickets = new Map(this.db.query<Ticket, [string]>("SELECT * FROM tickets WHERE (source IS NOT NULL AND key NOT IN (SELECT key FROM suspended) AND key NOT IN (SELECT key FROM stage_admissions)) OR key = ?").all(key).map(row => [row.key, row]));
    for (const row of sampledTickets.values()) {
      const observed = owners.get(row.owner!);
      if (observed?.dead) continue;
      // The calling ticket returns from a hold and refreshes its binding below.
      if (row.key === key) { if (!source && row.source) rank(row.source); continue; }
      const wallQuiet = sampledAt - (row.polled ?? (row.owner === null ? sampledAt : row.since));
      // Without a boot clock here, the poll's wall-clock age applies.
      const quiet = boundedLinuxGateWaiter(row) && row.owner !== null && preflightClock()
        ? linuxPollAge(row, preflightClock()) ?? 0 : wallQuiet;
      const unverifiable = row.owner === null || observed?.status === "unverified";
      if (quiet > this.unpolledMs && (unverifiable || boundedLinuxGateWaiter(row))
        || quiet > CPU_QUEUE_ABANDONED_MS && unverifiable) continue;
      if (row.source) rank(row.source);
    }
    if (source) rank(JSON.stringify(source));
    // Reported only once the transaction has committed what they describe.
    const decisions: string[] = [];
    const wait = this.db.transaction(() => {
      const now = this.now();
      let committedClock: LinuxGatePoll | null | undefined;
      const clock = () => committedClock === undefined ? committedClock = this.linuxClock() : committedClock;
      const activeSlots = this.activeGateSlots();
      const gateHolders = new Set(activeSlots.map(gate => gate.key));
      // A release that predates polls released these from a hold since the last check.
      this.db.query("UPDATE tickets SET polled = ? WHERE owner IS NULL AND polled IS NULL").run(now);
      for (const row of this.db.query<Ticket, []>("SELECT * FROM tickets WHERE owner IS NOT NULL").all()) {
        if (gateHolders.has(row.key)) continue;
        const observed = owners.get(row.owner!);
        if (!observed) continue;
        const { identity, status, dead } = observed;
        if (dead) {
          this.cancel(row.key);
          if (!row.key.startsWith(ACTIVE_GATE_PREFIX)) decisions.push(`removed ${row.key}: its owner process ${identity.pid} has exited`);
          continue;
        }
        // An owner recorded in another PID namespace, or one the kernel will
        // not describe, is never proven alive or dead here, so its polls stand
        // for it as for an ownerless ticket. A stopped Linux gate wrapper can
        // also be alive without making progress on its bounded wait.
        if (row.key === key || status !== "unverified" && !boundedLinuxGateWaiter(row)) continue;
        let quiet = now - (row.polled ?? row.since);
        const sample = boundedLinuxGateWaiter(row) ? clock() : null;
        if (sample) {
          const age = linuxPollAge(row, sample);
          // An older writer or a reboot gets one full interval from
          // observation. Initialize it under the writer lock.
          if (age === null) this.db.query("UPDATE tickets SET linux_poll = ? WHERE key = ?").run(linuxPollStamp(sample), row.key);
          quiet = age ?? 0;
        }
        if (status === "unverified" && quiet > CPU_QUEUE_ABANDONED_MS) {
          this.cancel(row.key);
          decisions.push(`removed ${row.key}: its owner process ${identity.pid} cannot be verified from here and has not checked in for ${Math.round(quiet / 3_600_000)} h`);
        } else if (quiet > this.unpolledMs && !this.db.query("SELECT 1 FROM suspended WHERE key = ?").get(row.key)) {
          this.db.query("INSERT INTO suspended VALUES (?)").run(row.key);
          this.db.query("INSERT INTO unpolled VALUES (?)").run(row.key);
          const reason = status === "unverified" ? " cannot be verified from here and" : "";
          decisions.push(`passed over ${row.key}: its owner process ${identity.pid}${reason} has not checked in for ${Math.round(quiet / 1_000)} s; its next check returns it to its place`);
        }
      }
      // The insert is the poll: tickets_poll stamps an existing row with `now`.
      this.db.query("INSERT OR IGNORE INTO tickets (key, since, owner) VALUES (?, ?, ?)").run(key, now, owner ? JSON.stringify(owner) : null);
      this.db.query("DELETE FROM suspended WHERE key = ?").run(key);
      this.db.query("DELETE FROM stage_admissions WHERE key = ?").run(key);
      this.touch(key);
      if (owner && requireLowPressure && process.platform === "linux" && key.startsWith(BOUNDED_GATE_PREFIX)) {
        const sample = clock();
        if (sample) this.db.query("UPDATE tickets SET linux_poll = ? WHERE key = ?").run(linuxPollStamp(sample), key);
      }
      this.db.query("UPDATE tickets SET aging = 1 WHERE key = ? AND aging = 0").run(key);
      this.db.query("UPDATE tickets SET low_pressure = ? WHERE key = ? AND low_pressure IS NOT ?").run(requireLowPressure ? 1 : 0, key, requireLowPressure ? 1 : 0);
      if (source) {
        const binding = JSON.stringify(source);
        this.db.query("UPDATE tickets SET source = ? WHERE key = ? AND source IS NOT ?").run(binding, key, binding);
      }
      for (const row of this.db.query<{ key: string }, [number]>("SELECT key FROM tickets WHERE owner IS NULL AND polled < ? AND (key NOT IN (SELECT key FROM suspended) OR key IN (SELECT key FROM unpolled))").all(now - CPU_QUEUE_ABANDONED_MS)) this.cancel(row.key);
      // An ownerless ticket nobody polls is passed over, never removed here:
      // its instance may only be restarting, and it returns to its sequence
      // and age with its next check. Spacing below still separates starts.
      for (const row of this.db.query<{ key: string }, [number]>("SELECT key FROM tickets WHERE owner IS NULL AND polled < ? AND key NOT IN (SELECT key FROM suspended)").all(now - this.unpolledMs)) {
        this.db.query("INSERT INTO suspended VALUES (?)").run(row.key);
        this.db.query("INSERT INTO unpolled VALUES (?)").run(row.key);
      }
      // A peer may already have committed a newer rank for the same binding.
      // Apply samples only while both the binding and observed rank still match.
      // A newly bound ticket must be observed before any caller can dispatch.
      let observationChanged = false;
      const updates: { key: string; priority: number }[] = [];
      for (const row of this.db.query<Ticket, []>("SELECT * FROM tickets WHERE source IS NOT NULL AND key NOT IN (SELECT key FROM suspended) AND key NOT IN (SELECT key FROM stage_admissions)").all()) {
        const priority = priorities.get(row.source!);
        const observed = sampledTickets.get(row.key);
        const ownBinding = row.key === key && source !== undefined;
        if (priority === undefined || (observed
          ? observed.priority !== row.priority || !ownBinding && observed.source !== row.source
          : row.key !== key || row.priority !== 1)) {
          observationChanged = true;
          break;
        }
        if (priority !== row.priority) updates.push({ key: row.key, priority });
      }
      // Keep the poll and FIFO age, but apply no stale sample or admission.
      // Every consumer already retries queue holds on its asynchronous poll;
      // a changed observation must not escape as a database lock failure.
      if (!observationChanged && updates.length) {
        for (const update of updates) this.db.query("UPDATE tickets SET priority = ? WHERE key = ?").run(update.priority, update.key);
        this.orderLegacyTicketsByPriority();
      }
      const ticket = this.db.query<Ticket, [string]>("SELECT * FROM tickets WHERE key = ?").get(key)!;
      const waitedMs = Math.max(0, now - ticket.since);
      const budget = Math.max(0, this.maxWaitMs - waitedMs);
      // Owned commands and ownerless starts share spacing, but only count
      // their own lane. No slot-waiting command can hold a stage start.
      const lane = ticket.owner === null ? "owner IS NULL" : "owner IS NOT NULL";
      // Keep task ranks and the legacy seq view unchanged for old checkers.
      // Each full wait bound raises one class for aging-aware owners only.
      // Aging a legacy row could make both owners count the other ahead,
      // leaving no client able to claim. fifo_seq breaks every class tie.
      const age = Math.floor(waitedMs / this.maxWaitMs);
      const effectiveClass = Math.max(0, ticket.priority - age);
      const agedClass = "MAX(0, priority - aging * CAST(MAX(0, ? - since) / ? AS INTEGER))";
      // At its bound, an install can pass checks that may be waiting for a slot.
      // Gate tickets count each other even after they become eligible under pressure.
      const passesLowPressure = !requireLowPressure && budget === 0 ? 1 : 0;
      // The active gate's fence is visible to older command checkers. It is
      // outside this release's FIFO. At its bound a current shell also passes
      // older pressure-only shells, which cannot act on an expired hold.
      const passLegacyGates = key.startsWith(BOUNDED_GATE_PREFIX) && budget === 0;
      const gateFilter = passLegacyGates ? `AND (low_pressure = 0 OR key GLOB '${BOUNDED_GATE_PREFIX}*')` : "";
      const counted = `${lane} AND key NOT GLOB '${ACTIVE_GATE_PREFIX}*' ${gateFilter} AND (${agedClass} < ? OR (${agedClass} = ? AND fifo_seq <= ?)) AND (? = 0 OR low_pressure = 0 OR key = ?) AND key NOT IN (SELECT key FROM suspended) AND key NOT IN (SELECT key FROM stage_admissions)`;
      const args: [number, number, number, number, number, number, number, number, string] = [now, this.maxWaitMs, effectiveClass, now, this.maxWaitMs, effectiveClass, ticket.fifo_seq, passesLowPressure, key];
      const ahead = this.db.query<{ n: number }, typeof args>(`SELECT COUNT(*) AS n FROM tickets WHERE ${counted}`).get(...args)!;
      const head = this.db.query<{ since: number }, [...typeof args, number, number]>(`SELECT since FROM tickets WHERE ${counted} ORDER BY ${agedClass}, fifo_seq LIMIT 1`).get(...args, now, this.maxWaitMs)!;
      const position = ahead.n;
      const last = this.lastAdmission();
      const spacing = last === null ? 0 : Math.max(0, last + this.spacingMs - now);
      // The durable wait bound lifts the pressure hold in both lanes.
      // Readiness and claim still require the same queue position and spacing.
      const slotObservationChanged = gateSlot !== undefined && gateSlot.lastBeforeProbe !== last;
      const portableSlots = gateSlot?.slot === null ? activeSlots.filter(gate => gate.slot === null) : [];
      const portableFull = gateSlot?.slot === null && portableSlots.length >= Math.min(gateSlot.cap, ...portableSlots.map(gate => gate.cap));
      const ready = !observationChanged && !slotObservationChanged && !portableFull && position === 1 && spacing === 0;
      const evidence = urgentStage?.evidence;
      const canStartUrgently = ready && !pressureAllows && budget > 0 && consume && evidence?.hasCapacity === true
        && ticket.owner === null && ticket.priority === 0 && !requireLowPressure && ticket.low_pressure === 0
        && key.startsWith("stage:") && evidence.key === key && evidence.lastBeforeProbe === last
        && evidence.sampledAt <= now && now - evidence.sampledAt <= CPU_STAGE_POLL_MS
        && matchesUrgentStage(urgentStage!);
      if (ready && (pressureAllows || budget === 0 || canStartUrgently)) {
        if (consume) {
          // Commands settle at their kernel slot claim. Stages retain a
          // recoverable admission until their own start checkpoint is read.
          if (!owner && (key.startsWith("stage:") || key.startsWith("workflow:"))) {
            this.db.query("INSERT OR IGNORE INTO stage_admissions VALUES (?)").run(key);
          } else this.cancel(key);
          if (gateSlot && owner) {
            // Earlier legacy claims are covered by the probe and last check.
            // A later legacy claim sees this head until the owner exits. Its
            // negative FIFO sequence keeps it ahead even when peers age to 0.
            this.db.query(`INSERT INTO tickets (key, since, owner, priority, low_pressure, fifo_seq)
              VALUES (?, ?, ?, -1, 1, -(SELECT next FROM ticket_order WHERE id = 1))`)
              .run(`${ACTIVE_GATE_PREFIX}${key}`, now, JSON.stringify(owner));
            this.recordGateSlot(`${ACTIVE_GATE_PREFIX}${key}`, gateSlot);
            this.db.exec("UPDATE ticket_order SET next = next + 1 WHERE id = 1");
          }
          this.db.query("UPDATE admission SET last = ? WHERE id = 1").run(now);
        }
        return null;
      }
      // A lane head past its pressure bound, with no recent machine
      // admission, is stalled. This reading never estimates a remaining wait.
      const stalledMs = this.stalledDuration(now, head.since, last);
      return {
        since: ticket.since, position, waitedMs, heldBy: observationChanged || position > 1 || spacing > 0 || slotObservationChanged || portableFull ? "queue" as const : "pressure" as const,
        ...(ticket.priority === 1 ? {} : { priority: ticket.priority === 0 ? "high" as const : "low" as const }),
        ...(stalledMs !== undefined ? { stalledMs } : {}),
      };
    }).immediate();
    for (const line of decisions) (this.observer.log ?? logOwnerDecision)(line);
    return wait;
  }
}

const queueSymbol = Symbol.for("delegatus.cpuAdmission");
const globals = globalThis as typeof globalThis & { [queueSymbol]?: { file: string; queue: CpuAdmissionQueue } };
export function machineCpuAdmissionQueue(isolatedStateDir?: string | null): CpuAdmissionQueue {
  const file = cpuAdmissionFile(isolatedStateDir);
  if (globals[queueSymbol]?.file !== file) {
    globals[queueSymbol]?.queue.close();
    globals[queueSymbol] = { file, queue: new CpuAdmissionQueue(file, Date.now, CPU_QUEUE_SPACING_MS, CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_UNPOLLED_MS,
      { status: cpuOwnerStatus, exited: cpuOwnerExited }) };
  }
  return globals[queueSymbol]!.queue;
}
export function cpuCommandOwner(): ProcessIdentity { return cpuOwnerIdentity(process.pid); }
