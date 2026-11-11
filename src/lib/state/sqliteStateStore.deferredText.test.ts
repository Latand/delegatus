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
    // A stored row is about 96 KiB of UTF-16 text; the cache keeps its short values.
    expect(measured.perRecord).toBeLessThan(1024);
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
