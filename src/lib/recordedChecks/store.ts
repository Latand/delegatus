import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { statePath } from "@/lib/configDir";
import { stateLockAttempt, waitForStateLock } from "@/lib/state/lockWait";
import { declaredIndexes } from "@/lib/state/declaredIndexes";
import { hotStateSqliteWriterReady } from "@/lib/state/hotStateAuthority";
import { descriptorSchema, terminalSchema, digest, custodyClock, ENVELOPE_BYTES } from "./wire";
import { systemBootEpoch } from "@/lib/processIdentity";
import { assertStateStartupMutation } from "@/lib/stateOwnership";

const bindingSchema = z.object({ project: z.string(), pipeline: z.string(), stage: z.string(), attempt: z.number().int().positive(),
  launch: z.string(), conversation: z.string(), session: z.string(), runtimeFence: z.string(),
  endpoint: z.string(), host: z.object({ pid: z.number(), startIdentity: z.string(), bootEpoch: z.string() }).strict() }).strict();
export type Binding = z.infer<typeof bindingSchema>;
export const resultSchema = z.object({ state: z.enum(["terminal", "unknown"]), reason: z.string().max(1024),
  terminal: terminalSchema.nullable(), complete: z.boolean(), visited: z.number().int().nonnegative(), completed: z.number().int().nonnegative(),
  evidence: z.array(z.object({ file: z.string(), sha256: z.string(), bytes: z.number() }).strict()), evidenceDigest: z.string(),
  revision: z.number().int().positive(), digest: z.string(), history: z.array(z.object({ at: z.number(), reason: z.string().max(1024) }).strict()).max(8),
}).strict();
export type CheckResult = z.infer<typeof resultSchema>;
const notificationSchema = z.object({ key: z.string(), conversation: z.string(), path: z.string(), text: z.string(),
  operation: z.string().nullable(), state: z.enum(["reserved", "uncertain", "delivered", "failed"]), reason: z.string().nullable() }).strict();
export const rowSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), request: z.string(), binding: bindingSchema,
  log: z.string(), descriptor: descriptorSchema, revision: z.number().int().positive(), admission: z.enum(["preparing", "accepted", "refused"]),
  reason: z.string().max(1024), result: resultSchema.nullable(), notification: notificationSchema.nullable(),
  acknowledgement: z.object({ actor: z.string(), resultRevision: z.number(), resultDigest: z.string(), evidenceDigest: z.string(),
    disposition: z.literal("adopt-retained"), at: z.number() }).strict().nullable(),
}).strict();
export type CheckRow = z.infer<typeof rowSchema>;
const indexes = declaredIndexes([
  "CREATE INDEX IF NOT EXISTS recorded_checks_host ON recorded_checks(conversation,deadline) WHERE acknowledged=0",
  "CREATE INDEX IF NOT EXISTS recorded_checks_launch ON recorded_checks(launch) WHERE acknowledged=0",
  "CREATE INDEX IF NOT EXISTS recorded_checks_pending ON recorded_checks(acknowledged,id)",
  "CREATE INDEX IF NOT EXISTS recorded_check_roots_directory ON recorded_check_roots(directory,id) WHERE held=1",
]);

/** A keyed ledger in the existing state DB. History never enters active scans. */
export class RecordedCheckStore {
  private db: Database;
  constructor(readonly filename = statePath("state.sqlite"), create = true) {
    if (create) fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("Recorded checks require Bun");
    this.db = new sqlite.Database(filename, create ? { create: true } : { readonly: true });
    try {
      this.db.exec("PRAGMA busy_timeout=0");
      if (create) {
        if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recorded_checks'").get())
          assertStateStartupMutation(path.dirname(filename), "recorded check ledger initialization");
        if (!hotStateSqliteWriterReady(path.dirname(filename))) throw new Error("recorded check initialization lost release authority");
        indexes.assertRepairAuthority(this.db, path.dirname(filename));
        this.db.exec("PRAGMA journal_mode=WAL");
        this.db.exec(`CREATE TABLE IF NOT EXISTS recorded_checks(id TEXT PRIMARY KEY, request TEXT UNIQUE NOT NULL,
          conversation TEXT NOT NULL, launch TEXT NOT NULL, deadline REAL NOT NULL, acknowledged INTEGER NOT NULL, value TEXT NOT NULL)`);
        this.db.exec("CREATE TABLE IF NOT EXISTS recorded_check_roots(directory TEXT NOT NULL,id TEXT NOT NULL,identity TEXT NOT NULL,retirement TEXT,held INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(directory,id))");
        this.db.exec("CREATE TABLE IF NOT EXISTS recorded_checks_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL)");
        this.db.exec("INSERT OR IGNORE INTO recorded_checks_revision VALUES(1,0)");
        indexes.install(this.db, path.dirname(filename));
        fs.chmodSync(filename, 0o600);
      }
    } catch (error) { this.db.close(); throw error; }
  }
  get(id: string): CheckRow | null {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM recorded_checks WHERE id=?").get(id);
    return row ? rowSchema.parse(JSON.parse(row.value)) : null;
  }
  byRequest(request: string): CheckRow | null {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM recorded_checks WHERE request=?").get(request);
    return row ? rowSchema.parse(JSON.parse(row.value)) : null;
  }
  page(after = "", limit = 32): CheckRow[] {
    return this.db.query<{ value: string }, [string, number]>("SELECT value FROM recorded_checks WHERE acknowledged=0 AND id>? ORDER BY id LIMIT ?")
      .all(after, Math.max(1, Math.min(32, limit))).map(row => rowSchema.parse(JSON.parse(row.value)));
  }
  version() { return this.db.query<{ revision: number }, []>("SELECT revision FROM recorded_checks_revision WHERE id=1").get()?.revision ?? 0; }
  put(row: CheckRow, expected: number | null, authority: () => void = () => {}) {
    const value = JSON.stringify(rowSchema.parse(row));
    if (Buffer.byteLength(value) > ENVELOPE_BYTES) throw new Error("recorded check metadata exceeds its bound");
    return this.db.transaction(() => {
      if (!hotStateSqliteWriterReady(path.dirname(this.filename))) throw new Error("recorded check writes lost release authority");
      authority();
      const current = this.get(row.id);
      if ((current?.revision ?? null) !== expected) throw new Error("recorded check revision changed");
      if (current && (digest(current.binding) !== digest(row.binding) || current.descriptor.descriptorDigest !== row.descriptor.descriptorDigest
        || current.request !== row.request || current.log !== row.log)) throw new Error("recorded check immutable identity changed");
      if (!current) {
        const count = (sql: string, args: string[] = []) => this.db.query<{ count: number }, string[]>(sql).get(...args)!.count;
        if (count("SELECT count(*) AS count FROM recorded_checks WHERE acknowledged=0") >= 128
          || count("SELECT count(*) AS count FROM recorded_checks WHERE acknowledged=0 AND launch=?", [row.binding.launch]) >= 4) throw new Error("recorded check custody capacity is full");
      }
      this.db.query("INSERT INTO recorded_checks VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET acknowledged=excluded.acknowledged,value=excluded.value")
        .run(row.id, row.request, row.binding.conversation, row.binding.launch, row.descriptor.manifest.deadline, Number(!!row.acknowledgement), value);
      if (!current) for (const root of row.descriptor.manifest.roots) this.db.query("INSERT INTO recorded_check_roots(directory,id,identity) VALUES(?,?,?)").run(root.directory, row.id, root.identity);
      if (row.acknowledgement) for (const root of row.descriptor.manifest.roots)
        this.db.query("UPDATE recorded_check_roots SET held=0 WHERE directory=? AND id=?").run(root.directory, row.id);
      this.db.exec("UPDATE recorded_checks_revision SET revision=revision+1 WHERE id=1");
    })();
  }
  async write(row: CheckRow, expected: number | null, authority?: () => void) {
    await waitForStateLock("recorded-check.write", () => stateLockAttempt("recorded-check.write", () => this.put(row, expected, authority)));
  }
  hostHeld(conversation: string, now = custodyClock()): boolean {
    const rows = this.db.query<{ value: string }, [string]>("SELECT value FROM recorded_checks WHERE acknowledged=0 AND conversation=?").all(conversation);
    return rows.some(raw => {
      const row = rowSchema.parse(JSON.parse(raw.value));
      return row.admission !== "refused" && row.descriptor.recorder.bootEpoch === systemBootEpoch()
        && now <= row.descriptor.deadlineUptimeMs + 10_000
        && !(row.result?.terminal?.report?.cleanup === "confirmed" && row.result.terminal.report.phase === "close");
    });
  }
  launchHeld(launch: string) {
    return !!this.db.query("SELECT 1 FROM recorded_checks WHERE acknowledged=0 AND launch=? LIMIT 1").get(launch);
  }
  forLaunch(launch: string): CheckRow[] {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM recorded_checks WHERE acknowledged=0 AND launch=? ORDER BY id LIMIT 4")
      .all(launch).map(row => rowSchema.parse(JSON.parse(row.value)));
  }
  forHost(conversation: string): CheckRow[] {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM recorded_checks WHERE acknowledged=0 AND conversation=? LIMIT 128")
      .all(conversation).map(row => rowSchema.parse(JSON.parse(row.value)));
  }
  rootHeld(directory: string): boolean {
    return !!this.db.query("SELECT 1 FROM recorded_check_roots WHERE directory=? AND held=1 LIMIT 1").get(directory);
  }
  hasRoot(directory: string) { return !!this.db.query("SELECT 1 FROM recorded_check_roots WHERE directory=? LIMIT 1").get(directory); }
  retirement(directory: string, detail: string) {
    this.db.query("UPDATE recorded_check_roots SET retirement=? WHERE directory=?").run(JSON.stringify({ at: Date.now(), reason: detail.slice(0, 1024) }), directory);
  }
  close() { this.db.close(); }
}

/** Missing table means legacy, unverified custody. Corruption refuses retirement. */
export function readRecorded<T>(read: (store: RecordedCheckStore) => T, absent: T): T {
  const filename = statePath("state.sqlite");
  if (!fs.existsSync(filename)) return absent;
  let store: RecordedCheckStore | undefined;
  try {
    store = new RecordedCheckStore(filename, false);
    return read(store);
  } catch (error) {
    if (error instanceof Error && /no such table: recorded_checks(?:\b|_)/.test(error.message)) return absent;
    throw error;
  } finally { store?.close(); }
}
export const recordedHostHeld = (conversation: string) => readRecorded(store => store.hostHeld(conversation), false);
export const recordedLaunchHeld = (launch: string) => readRecorded(store => store.launchHeld(launch), false);
export const recordedRootHeld = (directory: string) => readRecorded(store => store.rootHeld(directory), false);
export async function recordRootRetirement(directory: string, reason: string) {
  if (!readRecorded(store => store.hasRoot(directory), false)) return;
  const store = await openRecordedChecks();
  try { await waitForStateLock("recorded-check.retirement", () => stateLockAttempt("recorded-check.retirement", () => store.retirement(directory, reason))); }
  finally { store.close(); }
}
export function openRecordedChecks(filename = statePath("state.sqlite")) {
  return waitForStateLock("recorded-check.open", () => stateLockAttempt("recorded-check.open", () => new RecordedCheckStore(filename)));
}
export const recordedAttemptReceipts = (launch: string) => readRecorded(store => store.forLaunch(launch).map(row => ({
  id: row.id, admission: row.admission, deadline: row.descriptor.manifest.deadline, reason: row.reason,
  pending: !row.result?.terminal || row.result.terminal.report?.cleanup !== "confirmed", resultRevision: row.result?.revision ?? null,
})), []);
