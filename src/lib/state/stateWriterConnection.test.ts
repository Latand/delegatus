import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FileTransactionBusyError } from "./fileTransaction";
import {
  closeStateWriterConnections,
  initializeStateCollections,
  injectStateWriteFaultForTests,
  SqliteStateCollection,
  stateWriterConnectionOpensForTests,
  stateWriterSynchronousForTests,
} from "./sqliteStateStore";

/* #3890: one kept writer connection per database and process, with the
   lease, the busy handling and the fence unchanged. */

type Row = { key: string; value: number };
const directories: string[] = [];

afterEach(() => {
  injectStateWriteFaultForTests(null);
  closeStateWriterConnections();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function collection(name = "probe", filename?: string): SqliteStateCollection<Row> {
  if (!filename) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "state-writer-connection-"));
    directories.push(directory);
    filename = path.join(directory, "state.sqlite");
  }
  const options = { collection: name, schemaVersion: 1, busyMessage: `${name} is busy`,
    key: (row: Row) => row.key, decode: (raw: unknown) => raw as Row, clone: (row: Row) => ({ ...row }) };
  initializeStateCollections(filename, [{ ...options, migrationId: `${name}-v1`, loadRecords: () => [] }]);
  return new SqliteStateCollection<Row>(filename, options);
}

const FULL = 2;

test("writes, leases and releases share one kept connection, and every write commits", () => {
  const store = collection();
  store.patchSync(() => ({ records: [{ key: "a", value: 0 }] }));
  const opened = stateWriterConnectionOpensForTests();
  for (let index = 1; index <= 20; index += 1) {
    store.patchSync(() => ({ records: [{ key: "a", value: index }] }));
    store.boundedPatch(2, (tx) => { tx.put({ key: "b", value: index }); });
  }
  expect(stateWriterConnectionOpensForTests()).toBe(opened);
  expect([store.get("a")?.value, store.get("b")?.value]).toEqual([20, 20]);
  // The rows' commit waits for the disk; only the lease commits do not.
  expect(stateWriterSynchronousForTests(store.filename)).toBe(FULL);
  const db = new Database(store.filename, { readonly: true });
  try {
    expect(db.query("SELECT COUNT(*) AS held FROM state_leases").get()).toEqual({ held: 0 });
  } finally { db.close(); }
});

test("another process's write lock still refuses a write at once, and the kept connection carries on after it", () => {
  const store = collection();
  store.patchSync(() => ({ records: [{ key: "a", value: 1 }] }));
  const opened = stateWriterConnectionOpensForTests();
  const holder = new Database(store.filename);
  try {
    holder.exec("BEGIN IMMEDIATE");
    expect(() => store.patchSync(() => ({ records: [{ key: "a", value: 2 }] }))).toThrow(FileTransactionBusyError);
    holder.exec("ROLLBACK");
  } finally { holder.close(); }
  expect(stateWriterSynchronousForTests(store.filename)).toBe(FULL);
  store.patchSync(() => ({ records: [{ key: "a", value: 3 }] }));
  expect(store.get("a")?.value).toBe(3);
  // Contention is not a reason to give the connection up.
  expect(stateWriterConnectionOpensForTests()).toBe(opened);
});

test("a write started inside another write's transaction gets its own connection and meets the outer lock, as before", () => {
  const store = collection("outer");
  const inner = collection("inner", store.filename);
  let refused: unknown = null;
  store.patchSync(() => {
    try { inner.patchSync(() => ({ records: [{ key: "nested", value: 1 }] })); }
    catch (error) { refused = error; }
    return { records: [{ key: "outer", value: 1 }] };
  });
  expect(refused).toBeInstanceOf(FileTransactionBusyError);
  expect(store.get("outer")?.value).toBe(1);
  expect(inner.get("nested")).toBeNull();
  inner.patchSync(() => ({ records: [{ key: "nested", value: 2 }] }));
  expect(inner.get("nested")?.value).toBe(2);
});

test("a connection whose write failed for any reason other than contention is closed and the next write opens a new one", () => {
  const store = collection();
  store.patchSync(() => ({ records: [{ key: "a", value: 1 }] }));
  const opened = stateWriterConnectionOpensForTests();
  expect(() => store.patchSync(() => { throw new Error("callback failed"); })).toThrow("callback failed");
  injectStateWriteFaultForTests({ site: "commit", collection: "probe", times: 1, error: new Error("disk I/O error") });
  expect(() => store.patchSync(() => ({ records: [{ key: "a", value: 2 }] }))).toThrow("disk I/O error");
  expect(store.get("a")?.value).toBe(1);
  store.patchSync(() => ({ records: [{ key: "a", value: 3 }] }));
  expect(store.get("a")?.value).toBe(3);
  expect(stateWriterConnectionOpensForTests()).toBeGreaterThanOrEqual(opened + 2);
  expect(stateWriterSynchronousForTests(store.filename)).toBe(FULL);
});

test("a database replaced at its name between writes receives the next write", () => {
  const store = collection();
  store.patchSync(() => ({ records: [{ key: "a", value: 1 }] }));
  const replacement = fs.mkdtempSync(path.join(os.tmpdir(), "state-writer-replacement-"));
  directories.push(replacement);
  const fresh = collection("probe", path.join(replacement, "state.sqlite"));
  fresh.patchSync(() => ({ records: [{ key: "a", value: 100 }] }));
  const checkpoint = new Database(fresh.filename);
  try { checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { checkpoint.close(); }
  fresh.close();
  // Swap the files under the name while this process keeps its writer to the old one.
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${store.filename}${suffix}`)) fs.renameSync(`${store.filename}${suffix}`, `${store.filename}${suffix}.moved`);
  }
  fs.renameSync(fresh.filename, store.filename);
  store.patchSync(() => ({ records: [{ key: "b", value: 2 }] }));
  const db = new Database(store.filename, { readonly: true });
  try {
    expect(db.query("SELECT row_key, value_json FROM state_rows WHERE collection = 'probe' ORDER BY row_key").all()).toEqual([
      { row_key: "a", value_json: JSON.stringify({ key: "a", value: 100 }) },
      { row_key: "b", value_json: JSON.stringify({ key: "b", value: 2 }) },
    ]);
  } finally { db.close(); }
});

test("a write with process durability commits and leaves the kept connection waiting for the disk again", () => {
  const store = collection();
  store.patchSync(() => ({ records: [{ key: "a", value: 1 }] }), { durability: "process" });
  expect(store.get("a")?.value).toBe(1);
  expect(stateWriterSynchronousForTests(store.filename)).toBe(FULL);
  // A failed write of that kind gives its connection up and leaves no setting behind.
  expect(() => store.patchSync(() => { throw new Error("callback failed"); }, { durability: "process" })).toThrow("callback failed");
  store.patchSync(() => ({ records: [{ key: "a", value: 2 }] }));
  expect(stateWriterSynchronousForTests(store.filename)).toBe(FULL);
  expect(store.get("a")?.value).toBe(2);
});
