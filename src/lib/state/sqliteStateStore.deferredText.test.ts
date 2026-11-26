import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cacheSizes } from "../cacheTelemetry";
import { initializeStateCollections, SqliteStateCollection, StateSnapshotChangedError } from "./sqliteStateStore";

type Attempt = { status: string; input: string; report: { summary: string; findings: string[] } };
type Row = { id: string; state: string; runs: { attempts: Attempt[] }[] };

const TEXT = 16 * 1024;
const text = (id: string, field: string) => `${id}:${field}:`.padEnd(TEXT, "x");
const row = (id: string, state = "closed"): Row => ({ id, state, runs: [{ attempts: [{ status: "passed",
  input: text(id, "input"), report: { summary: text(id, "summary"), findings: ["short finding", text(id, "finding")] } }] }] });
const rowBytes = (id: string) => JSON.stringify(row(id)).length;

async function fixture(size: number, run: (filename: string, ids: string[]) => Promise<void> | void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-deferred-text-"));
  const filename = path.join(root, "state.sqlite");
  const ids = Array.from({ length: size }, (_, index) => `row-${String(index).padStart(4, "0")}`);
  initializeStateCollections(filename, [{ collection: "fixture", schemaVersion: 1,
    migrationId: "fixture", key: (r: Row) => r.id, loadRecords: () => ids.map(id => row(id)) }]);
  try { await run(filename, ids); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function collection(filename: string, counter: { rows: number; bytes: number }, name: string) {
  return new SqliteStateCollection<Row>(filename, { collection: "fixture", schemaVersion: 1, busyMessage: "busy",
    readCacheKey: name, deferTextLongerThan: 512, key: r => r.id, clone: r => structuredClone(r), strictDecode: true,
    decode: (value) => { counter.rows += 1; counter.bytes += JSON.stringify(value).length; return value as Row; } });
}

const cachedBytes = () => cacheSizes().caches.find(size => size.owner === "state/collectionReadCache" && size.name === "hot")!.bytes;

/** Cache bytes one record adds, and the rows and bytes one long text reads. */
async function measure(size: number) {
  let result!: { perRecord: number; warmRows: number; textRows: number; textBytes: number; sameRecordRows: number };
  await fixture(size, (filename, ids) => {
    const counter = { rows: 0, bytes: 0 };
    const store = collection(filename, counter, `measure-${size}`);
    const before = cachedBytes();
    const records = store.loadReadonly();
    const perRecord = (cachedBytes() - before) / size;
    expect(counter.rows).toBe(size);
    counter.rows = 0; counter.bytes = 0;
    expect(store.loadReadonly()).toBe(records);
    expect(records.map(r => r.state)).toEqual(ids.map(() => "closed"));
    const warmRows = counter.rows;
    const last = records.at(-1)!;
    expect(last.runs[0]!.attempts[0]!.input).toBe(text(last.id, "input"));
    const textRows = counter.rows, textBytes = counter.bytes;
    expect(last.runs[0]!.attempts[0]!.report.findings[1]).toBe(text(last.id, "finding"));
    expect(last.runs[0]!.attempts[0]!.report.summary).toBe(text(last.id, "summary"));
    result = { perRecord, warmRows, textRows, textBytes, sameRecordRows: counter.rows - textRows };
    store.close();
  });
  return result;
}

test("cache bytes per record and the cost of one long text stay constant as the collection grows", async () => {
  const small = await measure(8);
  const large = await measure(64);
  for (const measured of [small, large]) {
    // A stored row is about 96 KiB of UTF-16 text. The cache keeps its short
    // values and counts 192 bytes for each of its three deferred strings.
    expect(measured.perRecord).toBeLessThan(2048);
    expect(measured.perRecord).toBeGreaterThan(3 * 192);
    expect(measured.warmRows).toBe(0);
    expect(measured.textRows).toBe(1);
    expect(measured.textBytes).toBe(rowBytes("row-0000"));
    expect(measured.sameRecordRows).toBe(0);
  }
  expect(large.perRecord).toBe(small.perRecord);
});

test("a cached record with deferred text reads, serializes and clones as the stored record", () => fixture(6, (filename, ids) => {
  const store = collection(filename, { rows: 0, bytes: 0 }, "complete");
  const records = store.loadReadonly();
  const stored = ids.map(id => row(id));
  expect(JSON.stringify(records)).toBe(JSON.stringify(stored));
  expect(structuredClone(records[3])).toEqual(stored[3]!);
  expect(store.snapshot()).toEqual(stored);
  expect(Object.keys(records[0]!.runs[0]!.attempts[0]!)).toEqual(["status", "input", "report"]);
  expect(Object.isFrozen(records[0]!.runs[0]!.attempts[0]!.report.findings)).toBe(true);
  const copy = store.snapshot()[0]!;
  copy.runs[0]!.attempts[0]!.input = "caller edit";
  expect(records[0]!.runs[0]!.attempts[0]!.input).toBe(text(ids[0]!, "input"));
  // Reading every record in turn keeps only a few complete rows decoded.
  for (const record of records) expect(record.runs[0]!.attempts[0]!.report.summary).toBe(text(record.id, "summary"));
  store.close();
}));

test("a peer write refreshes one cached record, and a record whose row changed refuses its old text", () => fixture(8, (filename, ids) => {
  const counter = { rows: 0, bytes: 0 };
  const store = collection(filename, counter, "refresh");
  const writer = collection(filename, { rows: 0, bytes: 0 }, "refresh-writer");
  const held = store.loadReadonly();
  const changed = { ...row(ids[2]!), state: "reopened" };
  changed.runs[0]!.attempts[0]!.input = text(ids[2]!, "rewritten");
  writer.boundedPatch(2, tx => { tx.put(changed); tx.delete(ids[5]!); });
  counter.rows = 0;
  const next = store.loadReadonly();
  expect(counter.rows).toBe(1);
  expect(next.map(r => r.id)).toEqual(ids.filter(id => id !== ids[5]));
  expect(next[2]!.state).toBe("reopened");
  expect(next[2]!.runs[0]!.attempts[0]!.input).toBe(text(ids[2]!, "rewritten"));
  expect(next[0]).toBe(held[0]!);
  expect(held[0]!.runs[0]!.attempts[0]!.input).toBe(text(ids[0]!, "input"));
  expect(held[2]!.state).toBe("closed");
  expect(() => held[2]!.runs[0]!.attempts[0]!.input).toThrow(StateSnapshotChangedError);
  expect(() => held[5]!.runs[0]!.attempts[0]!.report.summary).toThrow(StateSnapshotChangedError);
  // A response built from the older list serializes each record whole: the
  // unchanged ones as listed, the rewritten one as its current row.
  const response = JSON.parse(JSON.stringify({ lanes: [held[0], held[2]] })) as { lanes: Row[] };
  expect(response.lanes[0]).toEqual(row(ids[0]!));
  expect(response.lanes[1]).toEqual(changed);
  expect(() => JSON.stringify(held[5])).toThrow(StateSnapshotChangedError);
  store.close(); writer.close();
}));

test("a collection without the option keeps complete mutable records in its cache", () => fixture(2, (filename, ids) => {
  const store = new SqliteStateCollection<Row>(filename, { collection: "fixture", schemaVersion: 1, busyMessage: "busy",
    readCacheKey: "inline", key: r => r.id, clone: r => structuredClone(r), strictDecode: true, decode: value => value as Row });
  const records = store.loadReadonly();
  expect(Object.isFrozen(records[0])).toBe(false);
  expect(Object.getOwnPropertyDescriptor(records[0]!.runs[0]!.attempts[0]!, "input")!.value).toBe(text(ids[0]!, "input"));
  store.close();
}));

test("returning to a record, alternating between records and walking one record decode each row once", () => fixture(6, (filename, ids) => {
  const counter = { rows: 0, bytes: 0 };
  const store = collection(filename, counter, "traversal");
  const records = store.loadReadonly();
  counter.rows = 0;
  for (let pass = 0; pass < 3; pass++) for (const record of records) {
    expect(record.runs[0]!.attempts[0]!.input).toBe(text(record.id, "input"));
  }
  expect(counter.rows).toBe(ids.length);
  const walk = (value: unknown): number => typeof value === "string" ? value.length
    : value && typeof value === "object" ? Object.values(value).reduce((sum: number, child) => sum + walk(child), 0) : 0;
  for (const record of records) expect(walk(record)).toBeGreaterThan(3 * TEXT);
  expect(JSON.stringify(records)).toBe(JSON.stringify(ids.map(id => row(id))));
  expect(counter.rows).toBe(ids.length);
  store.close();
}));

test("writing back a cached record stores its complete text byte for byte", () => fixture(4, async (filename, ids) => {
  const store = collection(filename, { rows: 0, bytes: 0 }, "write-back");
  const stored = (id: string) => {
    const db = new Database(filename, { readonly: true });
    try {
      return db.query<{ value_json: string }, [string]>("SELECT value_json FROM state_rows WHERE collection='fixture' AND row_key=?").get(id)!.value_json;
    } finally { db.close(); }
  };
  const records = store.loadReadonly();
  store.boundedPatch(1, tx => { tx.put({ ...records[0]!, state: "reopened" }); });
  expect(stored(ids[0]!)).toBe(JSON.stringify(row(ids[0]!, "reopened")));
  await store.mutate(async (session, persist) => {
    session.find(record => record.id === ids[1])!.state = "edited";
    await persist();
  });
  expect(stored(ids[1]!)).toBe(JSON.stringify(row(ids[1]!, "edited")));
  expect(stored(ids[2]!)).toBe(JSON.stringify(row(ids[2]!)));
  const next = store.loadReadonly();
  expect(JSON.stringify(next)).toBe(JSON.stringify([row(ids[0]!, "reopened"), row(ids[1]!, "edited"), row(ids[2]!), row(ids[3]!)]));
  store.close();
}));

test("the option is part of the shared cache identity", () => fixture(2, (filename, ids) => {
  const deferring = collection(filename, { rows: 0, bytes: 0 }, "shared-key");
  const inline = new SqliteStateCollection<Row>(filename, { collection: "fixture", schemaVersion: 1, busyMessage: "busy",
    readCacheKey: "shared-key", key: r => r.id, clone: r => structuredClone(r), strictDecode: true, decode: value => value as Row });
  expect(Object.isFrozen(deferring.loadReadonly()[0])).toBe(true);
  const records = inline.loadReadonly();
  expect(Object.isFrozen(records[0])).toBe(false);
  expect(Object.getOwnPropertyDescriptor(records[0]!.runs[0]!.attempts[0]!, "input")!.value).toBe(text(ids[0]!, "input"));
  deferring.close(); inline.close();
}));

test("a record of a replaced database refuses its text, whatever the new file holds under its key and revision", () => fixture(2, (filename, ids) => {
  const store = collection(filename, { rows: 0, bytes: 0 }, "replaced");
  const held = store.loadReadonly();
  const foreign = (id: string): Row => ({ ...row(id), runs: [{ attempts: [{ status: "passed", input: text(id, "foreign"),
    report: { summary: text(id, "foreign-summary"), findings: ["short finding", text(id, "foreign-finding")] } }] }] });
  const replacement = `${filename}.replacement`;
  initializeStateCollections(replacement, [{ collection: "fixture", schemaVersion: 1,
    migrationId: "fixture", key: (r: Row) => r.id, loadRecords: () => ids.map(foreign) }]);
  const db = new Database(replacement);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  fs.renameSync(filename, `${filename}.old`);
  for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.renameSync(filename + suffix, filename + ".old" + suffix);
  fs.renameSync(replacement, filename);
  expect(() => held[0]!.runs[0]!.attempts[0]!.input).toThrow();
  const fresh = store.loadReadonly();
  expect(fresh[0]!.runs[0]!.attempts[0]!.input).toBe(text(ids[0]!, "foreign"));
  expect(held[1]!.state).toBe("closed");
  expect(() => held[1]!.runs[0]!.attempts[0]!.report.summary).toThrow();
  store.close();
}));
