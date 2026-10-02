import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { RuntimeJournal, type RuntimeJournalStartupProgress } from "./journal";
import { expectedReceipts, largeJournal, pinWal, processWrites, receiptKeys, walCommits } from "./fixtures/largeRuntimeJournal";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "journal-startup-"));
let next = 0;
const fixture = path.join(directory, "large.sqlite");
beforeAll(() => largeJournal(fixture), 120_000);
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
function copy(source = fixture): string { const f = path.join(directory, `copy-${next++}.sqlite`); fs.copyFileSync(source, f); return f; }
function meta(f: string, key: string): string | null { const db = new Database(f, { readonly: true }); try { return db.query<{ value: string }, [string]>("SELECT value FROM journal_meta WHERE key=?").get(key)?.value ?? null; } finally { db.close(); } }
function measure(f: string, options = {}): ReturnType<typeof walCommits> {
  const reader = pinWal(f);
  try {
    const start = performance.now();
    const writes = process.platform === "linux" ? processWrites(() => new RuntimeJournal(f, options)) : null;
    const journal = writes?.result ?? new RuntimeJournal(f, options);
    expect(journal.isWritable()).toBe(true);
    journal.close();
    const result = walCommits(f);
    console.log(JSON.stringify({ boot: path.basename(f), durationMs: performance.now() - start, wchar: writes?.wchar, syscw: writes?.syscw, ...result }));
    return result;
  } finally { reader.exec("ROLLBACK"); reader.close(); }
}

test.skipIf(process.platform !== "linux")("large-history cold boot does not resurrect receipts or write history", () => {
  const f = copy();
  const before = receiptKeys(f).length;
  const measured = processWrites(() => { const journal = new RuntimeJournal(f); expect(journal.isWritable()).toBe(true); journal.close(); });
  console.log(JSON.stringify({ boot: "cold-300k", durationMs: measured.durationMs, wchar: measured.wchar, syscw: measured.syscw, receiptsBefore: before, receiptsAfter: receiptKeys(f).length }));
  expect(receiptKeys(f).length).toBe(expectedReceipts(f).length);
  expect(receiptKeys(f)).toEqual(expectedReceipts(f));
  expect(receiptKeys(f).length).toBe(before);
  expect(meta(f, "producer_receipts_backfill_version")).toBe("1");
  expect(measured.wchar).toBeLessThan(1_000_000);
}, 180_000);

test.skipIf(process.platform !== "linux")("large-history repeated boot after runtime pruning writes no receipt history", () => {
  const f = copy();
  const journal = new RuntimeJournal(f, { maxEvents: 400_000 });
  for (let i = 0; i < 400; i++) journal.append({ scope: { type: "session", id: "conversation-fixture" }, kind: "fixture.history", payload: {}, producer: { kind: "codex-app-server", eventKey: `engine-host:codex:session-${i}:${400_000 + i}` } });
  while (!journal.maintainProducerReceipts().cycled) { /* bounded sweep */ }
  journal.close();
  const before = receiptKeys(f).length;
  const measured = processWrites(() => new RuntimeJournal(f).close());
  console.log(JSON.stringify({ boot: "repeated-300k", durationMs: measured.durationMs, wchar: measured.wchar, syscw: measured.syscw }));
  expect(receiptKeys(f).length).toBe(before);
  expect(receiptKeys(f).length).toBe(expectedReceipts(f).length);
  expect(receiptKeys(f)).toEqual(expectedReceipts(f));
  expect(measured.wchar).toBeLessThan(1_000_000);
}, 180_000);

test("warm boot WAL frames and FULL commits are history-size independent", () => {
  const small = path.join(directory, "small.sqlite"), large = path.join(directory, "medium.sqlite");
  largeJournal(small, 300, { migrated: true }); largeJournal(large, 30_000, { migrated: true });
  expect(measure(large)).toEqual(measure(small));
}, 120_000);

test("cold boot has one receipt migration commit beyond fixed overhead", () => {
  const small = path.join(directory, "overhead.sqlite"), cold = path.join(directory, "cold.sqlite");
  largeJournal(small, 300, { migrated: true }); largeJournal(cold, 30_000);
  expect(measure(cold).commits - measure(small).commits).toBe(1);
}, 120_000);

test("interrupted backfill resumes each durable batch exactly once", async () => {
  const f = path.join(directory, "interrupt.sqlite");
  largeJournal(f, 30_000, { missingNonEngineReceipts: 3000 });
  const uninterrupted = copy(f);
  const reader = pinWal(f);
  let childCommits = 0;
  try {
    const child = Bun.spawn([process.execPath, "-e", `import { RuntimeJournal } from ${JSON.stringify(path.join(import.meta.dir, "journal.ts"))}; new RuntimeJournal(${JSON.stringify(f)}, {startupBatchRows:256,onStartupProgress(p){if(p.subphase==='receipt-backfill' && p.committedBatches===3)process.kill(process.pid,'SIGKILL')}}).close()`], { stdout: "ignore", stderr: "pipe", env: { ...process.env, LLV_STATE_DIR: directory } });
    await child.exited;
    childCommits = walCommits(f).commits;
    console.log(JSON.stringify({ boot: "interrupted", ...walCommits(f) }));
    expect(child.signalCode).toBe("SIGKILL");
    expect(meta(f, "producer_receipts_backfill_cursor")).not.toBeNull();
    expect(meta(f, "producer_receipts_backfill_version")).toBeNull();
  } finally { reader.exec("ROLLBACK"); reader.close(); }
  const resumed = measure(f, { startupBatchRows: 256 });
  const complete = measure(uninterrupted, { startupBatchRows: 256 });
  const overheadFile = path.join(directory, "interrupt-overhead.sqlite");
  largeJournal(overheadFile, 300, { migrated: true });
  const overhead = measure(overheadFile).commits;
  expect(childCommits - overhead).toBe(3);
  expect(childCommits + resumed.commits - 2 * overhead).toBe(complete.commits - overhead);
  expect(receiptKeys(f).length).toBe(expectedReceipts(f).length);
  expect(receiptKeys(f)).toEqual(expectedReceipts(f));
  expect(meta(f, "producer_receipts_backfill_cursor")).toBeNull();
  expect(meta(f, "producer_receipts_backfill_version")).toBe("1");
}, 180_000);

test("pre-receipt journal migrates newest engine keys and preserves durable duplicate receipts", () => {
  const f = path.join(directory, "legacy.sqlite"); largeJournal(f, 3000, { emptyReceipts: true });
  const journal = new RuntimeJournal(f);
  expect(journal.isWritable()).toBe(true);
  expect(receiptKeys(f).length).toBe(expectedReceipts(f).length);
  expect(receiptKeys(f)).toEqual(expectedReceipts(f));
  const baseInput = { scope: { type: "session" as const, id: "conversation-fixture" }, kind: "fixture.history", payload: {} };
  const native = journal.append({ ...baseInput, producer: { kind: "viewer", eventKey: "native:op-1" } });
  const engine = journal.append({ ...baseInput, producer: { kind: "codex-app-server", eventKey: "engine-host:codex:session-1:1" } });
  expect(native.seq).toBe(2801); expect(engine.seq).toBe(2401);
  journal.close();
  // Exercise the old writer's actual startup statements against the migrated schema.
  const db = new Database(f);
  for (const row of db.query<Record<string, any>, []>("SELECT * FROM events WHERE producer_key IS NOT NULL").all()) {
    const event = { schemaVersion: 1, seq: row.seq, eventId: row.event_id, scope: { type: "session", id: "conversation-fixture" }, revision: row.revision, kind: row.kind, occurredAt: row.occurred_at, recordedAt: row.recorded_at, producer: { kind: row.producer_kind, eventKey: row.producer_key }, causationId: row.causation_id, correlationId: row.correlation_id, payload: JSON.parse(row.payload_json) };
    db.query("INSERT INTO producer_receipts VALUES (?,?,?) ON CONFLICT(producer_kind,producer_key) DO NOTHING").run(row.producer_kind, row.producer_key, JSON.stringify(event));
  }
  db.exec("DROP INDEX IF EXISTS events_producer_key; CREATE UNIQUE INDEX IF NOT EXISTS events_producer_key ON events(producer_kind,producer_key) WHERE producer_key IS NOT NULL");
  db.close();
  const before = receiptKeys(f);
  const writes = measure(f);
  const reopened = new RuntimeJournal(f); expect(reopened.isWritable()).toBe(true);
  expect(reopened.append({ ...baseInput, producer: { kind: "viewer", eventKey: "native:op-1" } }).seq).toBe(native.seq);
  expect(reopened.append({ ...baseInput, producer: { kind: "codex-app-server", eventKey: "engine-host:codex:session-1:1" } }).seq).toBe(engine.seq);
  reopened.close();
  expect(writes.commits).toBe(1);
  expect(writes.frames).toBe(3);
  // The duplicate engine append prunes the old release's superseded receipts.
  expect(receiptKeys(f).length).toBeLessThanOrEqual(before.length); expect(meta(f, "producer_receipts_backfill_version")).toBe("1");
}, 120_000);

test("cooperative open yields while verifying the full large-history hash chain", async () => {
  const f = copy(); const progress: RuntimeJournalStartupProgress[] = [];
  let yielded = false;
  setImmediate(() => { yielded = true; expect(progress.some((p) => p.subphase === "hash-chain" && p.done === p.total)).toBe(false); });
  const journal = await RuntimeJournal.open(f, { onStartupProgress: (p) => progress.push(p) });
  expect(yielded).toBe(true); expect(journal.isWritable()).toBe(true); journal.close();
  expect([...new Set(progress.map((p) => p.subphase))]).toEqual(["schema", "receipt-backfill", "integrity-check", "hash-chain"]);
  expect(progress.length).toBeLessThan(100);
  const corrupted = path.join(directory, "anchor-corruption.sqlite");
  largeJournal(corrupted, 300, { migrated: true });
  const db = new Database(corrupted);
  const tail = db.query<{ hash: string }, []>("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").get()!;
  db.query("UPDATE journal_meta SET value=? WHERE key='anchor_seq'").run("300");
  db.query("UPDATE journal_meta SET value=? WHERE key='anchor_hash'").run(tail.hash);
  db.close();
  const faulted = await RuntimeJournal.open(corrupted);
  expect(faulted.isWritable()).toBe(false);
  expect(() => faulted.append({ scope: "system:fixture", kind: "fixture.history", payload: {} })).toThrow("read-only");
  faulted.close();
}, 120_000);
