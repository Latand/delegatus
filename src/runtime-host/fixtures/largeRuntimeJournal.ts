import { createHash } from "node:crypto";
import fs from "node:fs";
import { Database } from "bun:sqlite";
import { RuntimeJournal } from "../journal";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function largeJournal(filename: string, count = 300_000, options: { migrated?: boolean; missingNonEngineReceipts?: number; emptyReceipts?: boolean } = {}): void {
  new RuntimeJournal(filename).close();
  const db = new Database(filename, { strict: true });
  db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
  const insert = db.query(`INSERT INTO events VALUES ($seq,$event_id,$scope,$revision,$kind,$payload_json,$created_at,$occurred_at,$recorded_at,$producer_kind,$producer_account_id,$producer_key,$producer_host_epoch,$operation_id,$causation_id,$correlation_id,$prev_hash,$hash)`);
  const receipt = db.query("INSERT INTO producer_receipts VALUES (?,?,?) ON CONFLICT(producer_kind,producer_key) DO UPDATE SET event_json=excluded.event_json");
  const latest = new Map<string, [string, string, string]>();
  const nonEngine = Math.max(Math.floor(count / 30), options.missingNonEngineReceipts ?? 0);
  const engineCount = count - nonEngine - Math.floor(count / 30);
  let previous = "0".repeat(64);
  for (let seq = 1; seq <= count; seq++) {
    const engine = seq <= engineCount;
    const prefix = `engine-host:codex:session-${seq % 400}:`;
    const producer_key = engine ? `${prefix}${seq}` : seq <= engineCount + nonEngine ? `native:op-${seq - engineCount}` : null;
    const producer_kind = engine ? "codex-app-server" : "viewer";
    const payload = { conversationId: "conversation-fixture", turnId: "turn-fixture", text: "synthetic journal history ".repeat(7) };
    const time = "2026-01-01T00:00:00.000Z";
    const unsigned = { seq, event_id: `event-${seq}`, scope: "session:conversation-fixture", revision: seq, kind: "fixture.history", payload_json: canonical(payload), created_at: 1767225600000, occurred_at: time, recorded_at: time, producer_kind, producer_account_id: null, producer_key, producer_host_epoch: null, operation_id: null, causation_id: null, correlation_id: null };
    const hash = createHash("sha256").update(`${previous}\n${canonical(unsigned)}`).digest("hex");
    insert.run({ ...unsigned, prev_hash: previous, hash });
    previous = hash;
    if (producer_key) {
      const event = canonical({ schemaVersion: 1, seq, eventId: unsigned.event_id, scope: { type: "session", id: "conversation-fixture" }, revision: seq, kind: unsigned.kind, occurredAt: time, recordedAt: time, producer: { kind: producer_kind, eventKey: producer_key }, causationId: null, correlationId: null, payload });
      if (engine) latest.set(prefix, [producer_kind, producer_key, event]);
      else if (seq - engineCount > (options.missingNonEngineReceipts ?? 0)) receipt.run(producer_kind, producer_key, event);
    }
  }
  for (const value of latest.values()) receipt.run(...value);
  if (options.emptyReceipts) db.exec("DELETE FROM producer_receipts");
  db.query("INSERT INTO scope_revisions VALUES (?,?)").run("session:conversation-fixture", count);
  // History is deliberately retained, while orchestration already consumed it.
  db.query("INSERT OR REPLACE INTO consumer_cursors VALUES (?,?)").run("orchestration", count);
  db.query("INSERT OR REPLACE INTO consumer_cursors VALUES (?,?)").run("fixture-retention-pin", 0);
  for (const [key, value] of [["seq", String(count)], ["published_seq", String(count)], ["hash", previous]]) db.query("UPDATE journal_meta SET value=? WHERE key=?").run(value!, key!);
  if (options.migrated) db.query("INSERT OR REPLACE INTO journal_meta VALUES (?,?)").run("producer_receipts_backfill_version", "1");
  if (!options.migrated) db.exec("DELETE FROM journal_meta WHERE key='producer_receipts_backfill_version'");
  db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

export function receiptKeys(filename: string): string[] {
  const db = new Database(filename, { readonly: true });
  try { return db.query<{ producer_kind: string; producer_key: string }, []>("SELECT producer_kind,producer_key FROM producer_receipts").all().map((r) => `${r.producer_kind}/${r.producer_key}`).sort(); }
  finally { db.close(); }
}
export function expectedReceipts(filename: string): string[] {
  const db = new Database(filename, { readonly: true });
  try {
    const keys: string[] = [];
    const latest = new Map<string, { sequence: number; key: string }>();
    for (const row of db.query<{ producer_kind: string; producer_key: string }, []>("SELECT producer_kind,producer_key FROM events WHERE producer_key IS NOT NULL").all()) {
      const match = /^engine-host:(codex|claude):(.+:)(\d+)$/.exec(row.producer_key);
      const key = `${row.producer_kind}/${row.producer_key}`;
      if (!match) keys.push(key);
      else {
        const group = `${row.producer_kind}/${match[1]}/${match[2]}`;
        const sequence = Number(match[3]);
        if (sequence > (latest.get(group)?.sequence ?? -1)) latest.set(group, { sequence, key });
      }
    }
    return [...keys, ...[...latest.values()].map((r) => r.key)].sort();
  } finally { db.close(); }
}

export function walCommits(filename: string): { frames: number; commits: number } {
  const wal = fs.readFileSync(`${filename}-wal`);
  if (wal.length < 32) return { frames: 0, commits: 0 };
  const pageSize = wal.readUInt32BE(8);
  let frames = 0, commits = 0;
  for (let offset = 32; offset + 24 + pageSize <= wal.length; offset += 24 + pageSize) {
    if (!wal.subarray(offset + 8, offset + 16).equals(wal.subarray(16, 24))) break;
    frames++;
    if (wal.readUInt32BE(offset + 4)) commits++;
  }
  return { frames, commits };
}
export function pinWal(filename: string): Database {
  const db = new Database(filename, { strict: true });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); BEGIN; SELECT count(*) FROM events");
  return db;
}
export function processWrites<T>(fn: () => T): { result: T; durationMs: number; wchar: number; syscw: number } {
  const read = () => Object.fromEntries(fs.readFileSync("/proc/self/io", "utf8").trim().split("\n").map((line) => { const [key, value] = line.split(":"); return [key, Number(value)]; }));
  const before = read(), start = performance.now();
  const result = fn(), durationMs = performance.now() - start, after = read();
  return { result, durationMs, wchar: after.wchar! - before.wchar!, syscw: after.syscw! - before.syscw! };
}
