import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observeSqlite } from "./sqliteReadAttribution";
import { attachReadAttributionWorker } from "./readAttribution";
import { readSqliteMemory, sqliteMemoryOnThisThread, SQLITE_MEMORY_MAX_CONNECTIONS } from "./sqliteMemoryDiagnostics";
import { assertStateChildSuccess } from "./state/stateChildResult.fixture";

test("existing connections are counted once, keep pragma units, and leave on close", () => {
  const before = sqliteMemoryOnThisThread().openConnections!;
  const db = observeSqlite(new Database(":memory:"), "state");
  try {
    observeSqlite(db, "state");
    db.exec("PRAGMA cache_size=-321");
    const sample = sqliteMemoryOnThisThread();
    expect(sample.openConnections).toBe(before + 1);
    expect(sample.connections.at(-1)).toMatchObject({ cacheSize: -321, mmapSizeBytes: null });
    expect(sample.memoryUsedBytes).toBeNull();
    db.exec("PRAGMA cache_size=42");
    expect(sqliteMemoryOnThisThread().connections.at(-1)?.cacheSize).toBe(42);
  } finally { db.close(); }
  expect(sqliteMemoryOnThisThread().openConnections).toBe(before);
});

test("one failed pragma is null while the connection and other pragma remain visible", () => {
  const db = observeSqlite(new Database(":memory:"), "state");
  const original = db.prepare.bind(db);
  const prepare = spyOn(db, "prepare").mockImplementation((...args: Parameters<Database["prepare"]>) => {
    if (args[0] === "PRAGMA mmap_size") throw Error("unsupported");
    return original(...args);
  });
  try { expect(sqliteMemoryOnThisThread().connections.at(-1)).toMatchObject({ cacheSize: -2000, mmapSizeBytes: null }); }
  finally { prepare.mockRestore(); db.close(); }
});

test("a failed close remains counted until the real connection closes", () => {
  const before = sqliteMemoryOnThisThread().openConnections!;
  const native = new Database(":memory:");
  const close = native.close.bind(native);
  let refuse = true;
  native.close = () => { if (refuse) throw Error("close refused"); close(); };
  const db = observeSqlite(native, "state");
  try {
    expect(() => db.close()).toThrow("close refused");
    expect(sqliteMemoryOnThisThread().openConnections).toBe(before + 1);
  } finally { refuse = false; db.close(); }
  expect(sqliteMemoryOnThisThread().openConnections).toBe(before);
});

test("explicit resource disposal removes the connection from the census", () => {
  const before = sqliteMemoryOnThisThread().openConnections!;
  const db = observeSqlite(new Database(":memory:"), "state");
  db[Symbol.dispose]();
  expect(sqliteMemoryOnThisThread().openConnections).toBe(before);
});

test("readonly diagnostics neither open a database nor take the writer lock", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-memory-"));
  const filename = path.join(directory, "fixture.sqlite");
  const writer = observeSqlite(new Database(filename), "state");
  let reader: Database | undefined;
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(value); PRAGMA cache_size=-256; PRAGMA mmap_size=1048576");
    reader = observeSqlite(new Database(filename, { readonly: true }), "state");
    reader.exec("PRAGMA busy_timeout=1; PRAGMA mmap_size=2097152");
    writer.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (1)");
    const before = sqliteMemoryOnThisThread().openConnections;
    const sample = await readSqliteMemory();
    expect(sample.openConnections).toBe(before);
    expect(sample.connections.slice(-2).map(row => row.mmapSizeBytes)).toEqual([1048576, 2097152]);
    expect(reader.inTransaction).toBe(false);
    expect(reader.query("PRAGMA busy_timeout").values()[0]?.[0]).toBe(1);
    writer.exec("COMMIT; BEGIN IMMEDIATE; INSERT INTO t VALUES (2); COMMIT");
    expect(writer.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
  } finally { reader?.close(); writer.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("an exclusive schema lock cannot spend the connection's busy timeout", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-memory-locked-"));
  const filename = path.join(directory, "fixture.sqlite");
  const writer = new Database(filename);
  let reader: Database | undefined;
  try {
    writer.exec("CREATE TABLE t(value); BEGIN EXCLUSIVE");
    reader = observeSqlite(new Database(filename, { readonly: true }), "state");
    reader.exec("PRAGMA busy_timeout=5000");
    const started = performance.now();
    const sample = sqliteMemoryOnThisThread();
    expect(performance.now() - started).toBeLessThan(500);
    expect([null, -2000]).toContain(sample.connections.at(-1)!.cacheSize);
    expect(reader.query("PRAGMA busy_timeout").values()[0]?.[0]).toBe(5000);
    writer.exec("COMMIT");
    expect(sqliteMemoryOnThisThread().connections.at(-1)?.cacheSize).toBe(-2000);
  } finally { reader?.close(); writer.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("connection details have a fixed cap while the count includes all live connections", () => {
  const before = sqliteMemoryOnThisThread().openConnections!;
  const databases: Database[] = [];
  try {
    for (let i = 0; i < SQLITE_MEMORY_MAX_CONNECTIONS + 2; i++) databases.push(observeSqlite(new Database(":memory:"), "state"));
    const sample = sqliteMemoryOnThisThread();
    expect(sample.openConnections).toBe(before + databases.length);
    expect(sample.connections).toHaveLength(SQLITE_MEMORY_MAX_CONNECTIONS);
    expect(sample.omittedConnections).toBe(sample.openConnections! - SQLITE_MEMORY_MAX_CONNECTIONS);
  } finally { for (const db of databases) db.close(); }
  expect(sqliteMemoryOnThisThread().openConnections).toBe(before);
});

test("restarting the real process resets connection identities and the detail budget", async () => {
  const script = `
    const { Database } = require('bun:sqlite');
    const { observeSqlite } = require(${JSON.stringify(path.join(import.meta.dir, "sqliteReadAttribution.ts"))});
    const { sqliteMemoryOnThisThread, SQLITE_MEMORY_MAX_CONNECTIONS } = require(${JSON.stringify(path.join(import.meta.dir, "sqliteMemoryDiagnostics.ts"))});
    const before = sqliteMemoryOnThisThread();
    const handles = Array.from({ length: SQLITE_MEMORY_MAX_CONNECTIONS + 2 }, () => observeSqlite(new Database(':memory:'), 'state'));
    const after = sqliteMemoryOnThisThread();
    console.log(JSON.stringify({ before: before.openConnections, after: after.openConnections,
      details: after.connections.length, omitted: after.omittedConnections, first: after.connections[0].connection }));
  `;
  for (let run = 0; run < 2; run++) {
    const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assertStateChildSuccess(code, stderr);
    expect(JSON.parse(stdout)).toEqual({ before: 0, after: SQLITE_MEMORY_MAX_CONNECTIONS + 2,
      details: SQLITE_MEMORY_MAX_CONNECTIONS, omitted: 2, first: 1 });
  }
});

test("the process census includes worker connections and removes exited workers", async () => {
  const before = sqliteMemoryOnThisThread().openConnections!;
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { Database } = require('bun:sqlite');
    const { observeSqlite } = require(workerData.module);
    const db = observeSqlite(new Database(':memory:'), 'state');
    globalThis.fixtureDatabase = db;
    db.exec('PRAGMA cache_size=-123');
    const { sqliteMemoryOnThisThread } = require(workerData.memory);
    parentPort.postMessage({ type: 'ready', connections: sqliteMemoryOnThisThread().openConnections });
  `, { eval: true, workerData: { module: path.resolve(import.meta.dir, "sqliteReadAttribution.ts"),
    memory: path.resolve(import.meta.dir, "sqliteMemoryDiagnostics.ts") } });
  const detach = attachReadAttributionWorker(worker, "memory-test");
  try {
    const ready = await new Promise<number>((resolve, reject) => {
      const listener = (message: { type?: string; connections: number }) => {
        if (message?.type === "ready") { worker.off("message", listener); resolve(message.connections); }
      };
      worker.on("message", listener); worker.once("error", reject);
    });
    expect(ready).toBe(1);
    const sample = await readSqliteMemory();
    expect(sample.openConnections).toBe(before + 1);
    expect(sample.connections.some(row => row.threadId === worker.threadId && row.cacheSize === -123)).toBe(true);
  } finally { detach(); await worker.terminate(); }
  expect((await readSqliteMemory()).openConnections).toBe(before);
});

test("an unresponsive worker has a bounded wait and makes the total unknown", async () => {
  const worker = new Worker("require('node:worker_threads').parentPort.on('message', () => {});", { eval: true });
  const detach = attachReadAttributionWorker(worker, "memory-timeout-test");
  const listeners = worker.listenerCount("message");
  try {
    const started = performance.now();
    const sample = await readSqliteMemory();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(sample.openConnections).toBeNull();
    expect(sample.unavailableWorkers).toBe(1);
    expect(worker.listenerCount("message")).toBe(listeners);
  } finally { detach(); await worker.terminate(); }
});
