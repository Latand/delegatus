import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";

import { processIdentityStatus, type ProcessIdentity } from "../processIdentity";
import { procBackend } from "../proc";
import { CPU_QUEUE_MAX_WAIT_MS, CPU_QUEUE_SPACING_MS } from "./cpuAdmission";

type CpuQueueWait = { since: number; position: number; remainingMs: number };

type Ticket = { seq: number; key: string; since: number; owner: string | null };

/** The queue class of release 8f103d02e, the last one before polls were
 * recorded, with only its name changed. That release shares the machine file
 * with the current one for as long as it serves, and its statements are fixed:
 * the mixed-release cases run this class and the current one on one file. */
export class PrePollCpuAdmissionQueue {
  private readonly db: Database;
  constructor(file: string, private readonly now = Date.now, private readonly spacingMs = CPU_QUEUE_SPACING_MS, private readonly maxWaitMs = CPU_QUEUE_MAX_WAIT_MS) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite?.Database) throw new Error("CPU admission requires the supported Bun runtime");
    this.db = new sqlite.Database(file, { create: true });
    fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS tickets (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, since INTEGER NOT NULL, owner TEXT); CREATE TABLE IF NOT EXISTS suspended (key TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY, last INTEGER); INSERT OR IGNORE INTO admission VALUES (1, NULL);");
    this.db.exec("CREATE TABLE IF NOT EXISTS stage_admissions (key TEXT PRIMARY KEY);");
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
          else this.db.query("DELETE FROM suspended WHERE key = ?").run(row.key);
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
      this.db.query("INSERT OR IGNORE INTO tickets (key, since, owner) VALUES (?, ?, ?)").run(key, now, owner ? JSON.stringify(owner) : null);
      this.db.query("DELETE FROM suspended WHERE key = ?").run(key);
      this.db.query("DELETE FROM stage_admissions WHERE key = ?").run(key);
      const ticket = this.db.query<Ticket, [string]>("SELECT * FROM tickets WHERE key = ?").get(key)!;
      const ahead = this.db.query<{ n: number; since: number | null }, [number, number]>("SELECT COUNT(*) AS n, MAX(CASE WHEN seq < ? THEN since END) AS since FROM tickets WHERE seq <= ? AND key NOT IN (SELECT key FROM suspended) AND key NOT IN (SELECT key FROM stage_admissions)").get(ticket.seq, ticket.seq)!;
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
      return { since: ticket.since, position, remainingMs: Math.max(budget, priorBudget, spacing) + (position - 1) * this.spacingMs };
    }).immediate();
  }
}
