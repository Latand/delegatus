import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeRegistry } from "@/lib/agent/registry";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import { initializeStateCollections, readStateCollectionRevision, SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { enableSqliteMemoryMap, SQLITE_MMAP_ENV, sqliteMemoryMapBytes } from "./sqliteMemoryMap";

const MIB = 1024 * 1024;
type Row = { id: string; text: string };

afterEach(() => {
  enableSqliteMemoryMap(false);
  delete process.env[SQLITE_MMAP_ENV];
});

/** Whether this process holds a memory map of exactly this file. */
function mapped(filename: string): boolean {
  const real = fs.realpathSync(filename);
  return fs.readFileSync("/proc/self/maps", "utf8").split("\n").some(line => line.endsWith(` ${real}`));
}

function stateFixture(root: string): string {
  const filename = path.join(root, "state.sqlite");
  initializeStateCollections(filename, [{ collection: "fixture", schemaVersion: 1, migrationId: "fixture", key: (row: Row) => row.id,
    loadRecords: () => Array.from({ length: 40 }, (_, index) => ({ id: `row-${index}`, text: "x".repeat(20_000) })) }]);
  return filename;
}

function collection(filename: string): SqliteStateCollection<Row> {
  return new SqliteStateCollection<Row>(filename, { collection: "fixture", schemaVersion: 1, busyMessage: "busy",
    key: row => row.id, decode: value => value as Row, clone: row => structuredClone(row) });
}

test("a process maps only when it asked and the setting names a size above zero", () => {
  expect(sqliteMemoryMapBytes({ [SQLITE_MMAP_ENV]: "512" })).toBe(0);
  enableSqliteMemoryMap();
  expect(sqliteMemoryMapBytes({})).toBe(0);
  expect(sqliteMemoryMapBytes({ [SQLITE_MMAP_ENV]: "" })).toBe(0);
  expect(sqliteMemoryMapBytes({ [SQLITE_MMAP_ENV]: "512" })).toBe(512 * MIB);
  expect(sqliteMemoryMapBytes({ [SQLITE_MMAP_ENV]: "0" })).toBe(0);
  expect(sqliteMemoryMapBytes({ [SQLITE_MMAP_ENV]: "plenty" })).toBe(0);
  expect(sqliteMemoryMapBytes({ [SQLITE_MMAP_ENV]: "-5" })).toBe(0);
});

test.skipIf(process.platform !== "linux")("state collection reads go through a map of the database file once the process asks for it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-memory-map-state-"));
  try {
    const filename = stateFixture(root);
    const plain = collection(filename);
    expect(plain.snapshot()).toHaveLength(40);
    expect(mapped(filename)).toBe(false);
    plain.close();

    /* Asking alone changes nothing: the setting decides. */
    enableSqliteMemoryMap();
    const unset = collection(filename);
    expect(unset.snapshot()).toHaveLength(40);
    expect(mapped(filename)).toBe(false);
    unset.close();

    process.env[SQLITE_MMAP_ENV] = "256";
    const reader = collection(filename);
    expect(reader.snapshot()).toHaveLength(40);
    expect(mapped(filename)).toBe(true);
    /* A writer on another connection changes what the mapped reader returns. */
    reader.boundedPatch(2, tx => { tx.put({ id: "row-0", text: "changed" }); tx.delete("row-1"); });
    const peer = collection(filename);
    expect(peer.snapshot().find(row => row.id === "row-0")?.text).toBe("changed");
    expect(reader.snapshot()).toHaveLength(39);
    expect(readStateCollectionRevision(filename, "fixture")).toBeGreaterThan(1);
    reader.close(); peer.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("a process that did not ask keeps plain reads whatever the setting", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-memory-map-worker-"));
  try {
    const filename = stateFixture(root);
    process.env[SQLITE_MMAP_ENV] = "256";
    const worker = collection(filename);
    expect(worker.snapshot()).toHaveLength(40);
    expect(mapped(filename)).toBe(false);
    worker.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("a size of zero keeps a process that asked on plain reads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-memory-map-off-"));
  try {
    const filename = stateFixture(root);
    enableSqliteMemoryMap();
    process.env[SQLITE_MMAP_ENV] = "0";
    const off = collection(filename);
    expect(off.snapshot()).toHaveLength(40);
    expect(mapped(filename)).toBe(false);
    off.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("registry reads go through a map of the registry file once the process asks for it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-memory-map-registry-"));
  try {
    const empty = normalizeRegistry({ version: 2, entries: {}, receipts: {} });
    const plainFile = path.join(root, "plain.sqlite");
    const plain = new SqliteAgentRegistryStore(plainFile, { initialSnapshot: empty, normalize: normalizeRegistry });
    plain.read(file => Object.keys(file.conversations).length);
    expect(mapped(plainFile)).toBe(false);
    plain.close();

    enableSqliteMemoryMap();
    process.env[SQLITE_MMAP_ENV] = "256";
    const filename = path.join(root, "registry.sqlite");
    const store = new SqliteAgentRegistryStore(filename, { initialSnapshot: empty, normalize: normalizeRegistry });
    expect(store.read(file => Object.keys(file.conversations).length)).toBe(0);
    expect(mapped(filename)).toBe(true);
    const reader = new SqliteAgentRegistryStore(filename, { readOnly: true, initialSnapshot: empty, normalize: normalizeRegistry });
    expect(reader.read(file => Object.keys(file.conversations).length)).toBe(0);
    reader.close(); store.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
