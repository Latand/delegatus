import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializeStateCollections, SqliteStateCollection } from "./sqliteStateStore";
import { DatabaseReplacedError } from "./currentDatabase";

type Row = { id: string; nested: { text: string } };
const row = (id: string, text = id): Row => ({ id, nested: { text } });

function fixture(run: (filename: string) => Promise<void> | void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-read-cache-"));
  const filename = path.join(root, "state.sqlite");
  initializeStateCollections(filename, [{ collection: "fixture", schemaVersion: 1,
    migrationId: "fixture", key: (r: Row) => r.id, loadRecords: () => [row("a"), row("b")] }]);
  return Promise.resolve().then(() => run(filename)).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

function options(decode: (value: unknown) => Row, authority = () => "one") {
  return { collection: "fixture", schemaVersion: 1, busyMessage: "busy", readCacheKey: "fixture-v1",
    key: (r: Row) => r.id, decode, clone: (r: Row) => structuredClone(r), decodeAuthority: authority, strictDecode: true };
}

test("separate readers share decoded data, retain independent mutable snapshots and observe peer writes", () => fixture(filename => {
  let decodes = 0;
  const decode = (v: unknown) => { decodes++; return v as Row; };
  const first = new SqliteStateCollection(filename, options(decode));
  const second = new SqliteStateCollection(filename, options(decode));
  first.snapshot();
  expect(decodes).toBe(2);
  const copy = second.snapshot();
  expect(decodes).toBe(2);
  copy[0]!.nested.text = "caller edit";
  expect(first.snapshot()[0]!.nested.text).toBe("a");
  second.boundedPatch(2, tx => { tx.put(row("a", "peer edit")); tx.delete("b"); });
  expect(first.snapshot()).toEqual([row("a", "peer edit")]);
  const count = decodes;
  expect(second.snapshot()).toEqual([row("a", "peer edit")]);
  expect(decodes).toBe(count);
}));

test("decoder authority and version separate caches, and replacement at the same revision invalidates them", () => fixture(filename => {
  let authority = "one";
  let decodes = 0;
  const decode = (v: unknown) => { decodes++; return v as Row; };
  const store = new SqliteStateCollection(filename, options(decode, () => authority));
  store.snapshot();
  authority = "two";
  store.snapshot();
  expect(decodes).toBe(4);
  new SqliteStateCollection(filename, { ...options(decode, () => authority), readCacheKey: "fixture-v2" }).snapshot();
  expect(decodes).toBe(6);
  const replacement = `${filename}.replacement`;
  initializeStateCollections(replacement, [{ collection: "fixture", schemaVersion: 1,
    migrationId: "fixture", key: (r: Row) => r.id, loadRecords: () => [row("fresh")] }]);
  // Close/checkpoint the replacement before publishing its inode at the name.
  const db = new Database(replacement);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  fs.renameSync(filename, `${filename}.old`);
  for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.renameSync(filename + suffix, filename + ".old" + suffix);
  fs.renameSync(replacement, filename);
  expect(store.snapshot()).toEqual([row("fresh")]);
}));

test("cold selection stops decoding at its limit, skips rejected records and pins pages across peer writes", () => fixture(async filename => {
  let decodes = 0;
  const decode = (v: unknown) => { decodes++; return (v as Row).id === "opaque" ? null : v as Row; };
  const opts = { ...options(v => v as Row), decode, preserveRejectedRecords: true };
  const store = new SqliteStateCollection(filename, opts);
  const peer = new SqliteStateCollection(filename, opts);
  peer.boundedPatch(3, tx => { tx.put(row("opaque")); tx.put(row("c")); tx.put(row("d")); });
  expect(await store.selectReadonlyAsync(() => true, 1)).toEqual([row("a")]);
  expect(decodes).toBe(1);
  let changed = false;
  const selected = await store.selectReadonlyAsync(record => {
    if (!changed) { changed = true; peer.boundedPatch(2, tx => { tx.delete("b"); tx.put(row("new")); }); }
    return record.id !== "a";
  }, 3);
  expect(selected.map(r => r.id)).toEqual(["b", "c", "d"]);
  expect((await store.selectReadonlyAsync(() => true, 20)).map(r => r.id)).toEqual(["a", "c", "d", "new"]);
  const db = new Database(filename);
  db.query("UPDATE state_rows SET value_json = ? WHERE collection = 'fixture' AND row_key = 'a'").run("{corrupt");
  db.close();
  await expect(store.selectReadonlyAsync(() => true, 1)).rejects.toThrow();
}));

test("scope churn evicts decoded graphs even when old collection instances survive", () => fixture(filename => {
  let decodes = 0;
  const decode = (v: unknown) => { decodes++; return v as Row; };
  const first = new SqliteStateCollection(filename, options(decode));
  first.snapshot();
  for (let n = 0; n < 9; n++) {
    new SqliteStateCollection(filename, { ...options(decode), readCacheKey: `version-${n}` }).snapshot();
  }
  const before = decodes;
  first.snapshot();
  expect(decodes).toBe(before + 2);
}));

test("oversized collections are returned but never retained by the shared cache", () => fixture(async filename => {
  let decodes = 0;
  const store = new SqliteStateCollection(filename, options(v => { decodes++; return v as Row; }));
  store.boundedPatch(1, tx => tx.put(row("large", "x".repeat(129 * 1024 * 1024))));
  expect(store.loadReadonly()).toHaveLength(3);
  const before = decodes;
  expect(store.loadReadonly()).toHaveLength(3);
  expect(decodes).toBe(before + 3);
  const asynchronous = decodes;
  expect(await store.snapshotAsync()).toHaveLength(3);
  expect(decodes).toBe(asynchronous + 3);
}));

test("a cold asynchronous read refuses an authority change during decoding", () => fixture(async filename => {
  let authority = "one";
  const decode = (value: unknown) => { authority = "two"; return value as Row; };
  const store = new SqliteStateCollection(filename, options(decode, () => authority));
  await expect(store.snapshotAsync()).rejects.toThrow("snapshot changed");
}));

test.each([false, true])("a refused database swap fill cannot poison a fresh reader (incremental: %s)", incremental => fixture(filename => {
  let swap: (() => void) | undefined;
  const decode = (value: unknown) => { const replace = swap; swap = undefined; replace?.(); return value as Row; };
  const store = new SqliteStateCollection(filename, options(decode));
  if (incremental) {
    store.snapshot();
    store.boundedPatch(1, tx => tx.put(row("a", "updated A")));
  }
  const replacement = `${filename}.replacement`;
  initializeStateCollections(replacement, [{ collection: "fixture", schemaVersion: 1,
    migrationId: "fixture", key: (r: Row) => r.id, loadRecords: () => [row("fresh B")] }]);
  const db = new Database(replacement);
  db.query("UPDATE state_collections SET revision = ? WHERE collection = 'fixture'").run(store.revision());
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  swap = () => {
    fs.renameSync(filename, `${filename}.old`);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(filename + suffix)) fs.renameSync(filename + suffix, filename + ".old" + suffix);
    }
    fs.renameSync(replacement, filename);
  };
  expect(() => store.snapshot()).toThrow(DatabaseReplacedError);
  const fresh = new SqliteStateCollection(filename, options(decode));
  expect(fresh.snapshot()).toEqual([row("fresh B")]);
  expect(store.snapshot()).toEqual([row("fresh B")]);
}));

test.each([false, true])("a refused authority transition fill cannot poison a fresh reader (incremental: %s)", incremental => fixture(filename => {
  let authority = "one", transition = false;
  const decode = (value: unknown): Row => {
    const projection = authority;
    if (transition) { authority = "two"; transition = false; }
    return row((value as Row).id, projection);
  };
  const opts = options(decode, () => authority);
  const store = new SqliteStateCollection(filename, opts);
  if (incremental) {
    store.snapshot();
    store.boundedPatch(1, tx => tx.put(row("c")));
  }
  transition = true;
  expect(() => store.snapshot()).toThrow("snapshot changed");
  const expected = [row("a", "two"), row("b", "two"), ...(incremental ? [row("c", "two")] : [])];
  expect(new SqliteStateCollection(filename, opts).snapshot()).toEqual(expected);
  expect(store.snapshot()).toEqual(expected);
}));

test("the active, archive and task working set fits together without repeated decoding", () => fixture(filename => {
  let decodes = 0;
  const decode = (value: unknown) => { decodes++; return value as Row; };
  const collections = [
    { collection: "active-fixture", characters: 30 * 1024 * 1024 },
    { collection: "pipelines_archive", characters: 110 * 1024 * 1024 },
    { collection: "tasks-fixture", characters: 8 * 1024 * 1024 },
  ];
  initializeStateCollections(filename, collections.map(({ collection, characters }) => ({ collection,
    schemaVersion: 1, migrationId: "working-set", key: (r: Row) => r.id,
    loadRecords: () => [row("working-set", "x".repeat(characters))] })));
  const readers = collections.map(({ collection }) => new SqliteStateCollection(filename, { ...options(decode), collection }));
  for (const reader of readers) reader.loadReadonly();
  expect(decodes).toBe(3);
  for (const reader of readers) reader.loadReadonly();
  expect(decodes).toBe(3);
}));

test("ordered key selection seeks metadata only, deduplicates and observes peer deletes", () => fixture(filename => {
  let decodes = 0;
  const opts = options(value => { decodes++; return value as Row; });
  const store = new SqliteStateCollection(filename, opts);
  const peer = new SqliteStateCollection(filename, opts);
  expect(store.keysInOrder(["missing", "b", "a", "a"], 8)).toEqual(["a", "b"]);
  expect(store.keysInOrder(["b", "a"], 1)).toEqual(["a"]);
  expect(store.keysInOrder([], 8)).toEqual([]);
  expect(store.keysInOrder(["a"], 0)).toEqual([]);
  expect(store.keysInOrder(["missing"], 8)).toEqual([]);
  expect(decodes).toBe(0);
  peer.boundedPatch(1, tx => { tx.delete("a"); });
  const afterWrite = decodes;
  expect(store.keysInOrder(["a", "b"], 8)).toEqual(["b"]);
  expect(decodes).toBe(afterWrite);
}));
