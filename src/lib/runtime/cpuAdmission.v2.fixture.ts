import { observeSqlite, parseSqliteJson } from "@/lib/sqliteReadAttribution";
import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { readCpuPriority, type CpuPrioritySource } from "./cpuPriority";
import type { TaskPriority } from "../tasks/types";
import { processIdentityStatus, type ProcessIdentity, type ProcessIdentityStatus } from "../processIdentity";
import { procBackend } from "../proc";
export const CPU_QUEUE_MAX_WAIT_MS = 10 * 60_000;
export const CPU_QUEUE_SPACING_MS = 2_000;
/** A waiting stage polls every five seconds. An ownerless ticket nobody has
 * polled for this long stops counting ahead of others, for every release
 * sharing the file; it keeps its row. */
export const CPU_QUEUE_UNPOLLED_MS = 60_000;
/** An ownerless ticket unpolled for this long, and held by no fence, is
 * removed; so is a ticket whose owner no kernel check here can prove alive. */
export const CPU_QUEUE_ABANDONED_MS = 24 * 60 * 60_000;
/** How long a head may stay past its bound, with nothing admitted, before the wait reads as stalled. */
export const CPU_QUEUE_STALE_GRACE_MS = 60_000;
/** `stalledMs` is set only while the head is past its bound and nothing is admitted. */
export type CpuQueueWait = { since: number; position: number; remainingMs: number; priority?: TaskPriority; stalledMs?: number };
type Ticket = { seq: number; fifo_seq: number; key: string; since: number; owner: string | null; priority: number; source: string | null; polled: number | null; low_pressure: number };
/** The queue judges owners with these; `log` receives one line for each ticket
 * it removes or passes over because of its owner. */
export type CpuOwnerObserver = { status(identity: ProcessIdentity): ProcessIdentityStatus; exited(identity: ProcessIdentity): boolean; log?(line: string): void };
const logOwnerDecision = (line: string) => console.warn(`[cpu-admission] ${line}`);
/** Every release's check stamps its own ticket through this trigger, owned or
 * not, so even a release whose statements predate it shows that its owner is
 * still there. */
const TICKETS_POLL = "CREATE TRIGGER tickets_poll BEFORE INSERT ON tickets BEGIN UPDATE tickets SET polled = NEW.since WHERE key = NEW.key; DELETE FROM unpolled WHERE key = NEW.key; END";
/** Frozen queue class from dcf07a26, before aging and lane separation.
 * Keep its statements fixed: mixed-version tests share one file with it. */
export class V2CpuAdmissionQueue {
  private readonly db: Database;
  constructor(file: string, private readonly now = Date.now, private readonly spacingMs = CPU_QUEUE_SPACING_MS, private readonly maxWaitMs = CPU_QUEUE_MAX_WAIT_MS, private readonly unpolledMs = CPU_QUEUE_UNPOLLED_MS,
    private readonly observer: CpuOwnerObserver = {
      status: processIdentityStatus, exited: identity => procBackend.processExited(identity.pid),
    }) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite?.Database) throw new Error("CPU admission requires the supported Bun runtime");
    this.db = observeSqlite(new sqlite.Database(file, { create: true }), "cpu-admission");
    fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS tickets (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, since INTEGER NOT NULL, owner TEXT); CREATE TABLE IF NOT EXISTS suspended (key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY, last INTEGER); INSERT OR IGNORE INTO admission VALUES (1, NULL);");
    this.db.exec("CREATE TABLE IF NOT EXISTS stage_admissions (key TEXT PRIMARY KEY);");
    // The last trigger marks the whole step. It commits with the column and
    // the first bound under one writer lock, so no checker of any release
    // ever reads a file that has the column and not the rest.
    const recordsPolls = () => this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'tickets_gone'").get() !== null;
    if (!recordsPolls()) {
      const opened = this.now();
      this.db.transaction(() => {
        if (recordsPolls()) return;
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
      }).immediate();
    }
    this.db.transaction(() => {
      const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(tickets)").all();
      if (!columns.some(column => column.name === "priority")) this.db.exec("ALTER TABLE tickets ADD COLUMN priority INTEGER NOT NULL DEFAULT 1");
      if (!columns.some(column => column.name === "source")) this.db.exec("ALTER TABLE tickets ADD COLUMN source TEXT");
      // Set by a ticket's own check: it starts only while measured pressure is
      // low. Helpers that predate the column leave it 0, the old behaviour.
      if (!columns.some(column => column.name === "low_pressure")) this.db.exec("ALTER TABLE tickets ADD COLUMN low_pressure INTEGER NOT NULL DEFAULT 0");
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
      this.db.exec(`CREATE TRIGGER tickets_fifo AFTER INSERT ON tickets BEGIN
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
      END`);
      this.db.exec("CREATE INDEX IF NOT EXISTS tickets_priority_seq ON tickets(priority, seq)");
      // The poll trigger above stamped only ownerless tickets at first.
      if (this.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'tickets_poll'").get()?.sql !== TICKETS_POLL) {
        this.db.exec("DROP TRIGGER IF EXISTS tickets_poll");
        this.db.exec(TICKETS_POLL);
      }
    }).immediate();
    // Repair a queue left in the inconsistent order produced by the earlier
    // priority implementation before any old or new checker can claim it.
    this.db.transaction(() => this.orderLegacyTicketsByPriority()).immediate();
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
  check(key: string, pressureAllows: boolean, owner?: ProcessIdentity, consume = true, source?: CpuPrioritySource, requireLowPressure = false): CpuQueueWait | null {
    // Reported only once the transaction has committed what they describe.
    const decisions: string[] = [];
    const wait = this.db.transaction(() => {
      const now = this.now();
      // A release that predates polls released these from a hold since the last check.
      this.db.query("UPDATE tickets SET polled = ? WHERE owner IS NULL AND polled IS NULL").run(now);
      for (const row of this.db.query<Ticket, []>("SELECT * FROM tickets WHERE owner IS NOT NULL").all()) {
        const identity = parseSqliteJson(row.owner!, this.db) as ProcessIdentity;
        const status = this.observer.status(identity);
        if (status === "dead" || this.observer.exited(identity)) {
          this.cancel(row.key);
          decisions.push(`removed ${row.key}: its owner process ${identity.pid} has exited`);
          continue;
        }
        // An owner recorded in another PID namespace, or one the kernel will
        // not describe, is never proven alive or dead here, so its polls stand
        // for it as for an ownerless ticket. One the kernel shows alive keeps
        // its place however long it waits.
        if (status !== "unverified" || row.key === key) continue;
        const quiet = now - (row.polled ?? row.since);
        if (quiet > CPU_QUEUE_ABANDONED_MS) {
          this.cancel(row.key);
          decisions.push(`removed ${row.key}: its owner process ${identity.pid} cannot be verified from here and has not checked in for ${Math.round(quiet / 3_600_000)} h`);
        } else if (quiet > this.unpolledMs && !this.db.query("SELECT 1 FROM suspended WHERE key = ?").get(row.key)) {
          this.db.query("INSERT INTO suspended VALUES (?)").run(row.key);
          this.db.query("INSERT INTO unpolled VALUES (?)").run(row.key);
          decisions.push(`passed over ${row.key}: its owner process ${identity.pid} cannot be verified from here and has not checked in for ${Math.round(quiet / 1_000)} s; its next check returns it to its place`);
        }
      }
      // The insert is the poll: tickets_poll stamps an existing row with `now`.
      this.db.query("INSERT OR IGNORE INTO tickets (key, since, owner) VALUES (?, ?, ?)").run(key, now, owner ? JSON.stringify(owner) : null);
      this.db.query("DELETE FROM suspended WHERE key = ?").run(key);
      this.db.query("DELETE FROM stage_admissions WHERE key = ?").run(key);
      this.touch(key);
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
      // Refresh every waiting binding before any caller can dispatch. Reads seek
      // task primary keys and extract only priority; no task store is decoded.
      let priorityChanged = false;
      for (const row of this.db.query<Ticket, []>("SELECT * FROM tickets WHERE source IS NOT NULL AND key NOT IN (SELECT key FROM suspended) AND key NOT IN (SELECT key FROM stage_admissions)").all()) {
        const priority = readCpuPriority(parseSqliteJson(row.source!, this.db) as CpuPrioritySource);
        const rank = priority === "high" ? 0 : priority === "low" ? 2 : 1;
        if (rank !== row.priority) {
          this.db.query("UPDATE tickets SET priority = ? WHERE key = ?").run(rank, row.key);
          priorityChanged = true;
        }
      }
      if (priorityChanged) this.orderLegacyTicketsByPriority();
      const ticket = this.db.query<Ticket, [string]>("SELECT * FROM tickets WHERE key = ?").get(key)!;
      // Pressure may rise again before this queued ticket reaches the head.
      // Display the durable worst-case bound even on a permissive sample.
      const budget = Math.max(0, this.maxWaitMs - (now - ticket.since));
      // A ticket whose own bound has run out passes tickets that wait for low
      // pressure: their stricter rule can hold them indefinitely, and the
      // bound promises this one a start. They keep FIFO among themselves.
      const passesLowPressure = !requireLowPressure && budget === 0 ? 1 : 0;
      // Strict high → normal → low; the durable sequence is FIFO within a
      // level, including after reprioritization, restart and recovery.
      const counted = "(priority < ? OR (priority = ? AND seq <= ?)) AND (? = 0 OR low_pressure = 0 OR key = ?) AND key NOT IN (SELECT key FROM suspended) AND key NOT IN (SELECT key FROM stage_admissions)";
      const ahead = this.db.query<{ n: number; since: number | null }, [string, number, number, number, number, string]>(`SELECT COUNT(*) AS n, MAX(CASE WHEN key <> ? THEN since END) AS since FROM tickets WHERE ${counted}`).get(key, ticket.priority, ticket.priority, ticket.seq, passesLowPressure, key)!;
      const head = this.db.query<{ since: number }, [number, number, number, number, string]>(`SELECT since FROM tickets WHERE ${counted} ORDER BY priority, seq LIMIT 1`).get(ticket.priority, ticket.priority, ticket.seq, passesLowPressure, key)!;
      const position = ahead.n;
      const last = this.db.query<{ last: number | null }, []>("SELECT last FROM admission WHERE id = 1").get()!.last;
      const spacing = last === null ? 0 : Math.max(0, last + this.spacingMs - now);
      const priorBudget = ahead.since === null ? 0 : Math.max(0, this.maxWaitMs - (now - ahead.since));
      // Heavy gates must keep waiting under load even after the queue's stage
      // fairness bound. Readiness and the final slot claim use the same guard.
      if (position === 1 && spacing === 0 && (pressureAllows || !requireLowPressure && budget === 0)) {
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
        since: ticket.since, position, ...(ticket.priority === 1 ? {} : { priority: ticket.priority === 0 ? "high" as const : "low" as const }), remainingMs: Math.max(budget, priorBudget, spacing) + (position - 1) * this.spacingMs,
        ...(stalledMs > CPU_QUEUE_STALE_GRACE_MS ? { stalledMs } : {}),
      };
    }).immediate();
    for (const line of decisions) (this.observer.log ?? logOwnerDecision)(line);
    return wait;
  }
}
