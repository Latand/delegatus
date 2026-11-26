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
import { readRecorded, RecordedCheckStore } from "./recordedChecks/store";
import { AttemptTempStore } from "./runtime/attemptTempRetention";

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

test("persistent SQLite stores and the cached recorded-check reader register and release every handle", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-memory-recorded-store-"));
  const filename = path.join(directory, "state.sqlite");
  const oldStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
  const before = sqliteMemoryOnThisThread().openConnections!;
  const store = new RecordedCheckStore(filename);
  const attempts = new AttemptTempStore(path.join(directory, "attempt-temp.sqlite"));
  try {
    expect(sqliteMemoryOnThisThread().openConnections).toBe(before + 2);
    expect(sqliteMemoryOnThisThread().connections.slice(-2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ cacheSize: -2000, mmapSizeBytes: 0 }),
    ]));
    expect(readRecorded(reader => reader, null)).toBeInstanceOf(RecordedCheckStore);
    expect(sqliteMemoryOnThisThread().openConnections).toBe(before + 3);
    expect(readRecorded(reader => reader, null)).toBeInstanceOf(RecordedCheckStore);
    expect(sqliteMemoryOnThisThread().openConnections).toBe(before + 3);
    // A missing state file retires the real cached reader and closes its handle.
    process.env.LLV_STATE_DIR = path.join(directory, "missing");
    expect(readRecorded(reader => reader, null)).toBeNull();
    expect(sqliteMemoryOnThisThread().openConnections).toBe(before + 2);
  } finally {
    attempts.close(); store.close();
    if (oldStateDir === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = oldStateDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

test("an exclusive schema lock sample runs behind an independent watchdog", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-memory-locked-"));
  const filename = path.join(directory, "fixture.sqlite");
  const writer = new Database(filename);
  try {
    writer.exec("CREATE TABLE t(value); BEGIN EXCLUSIVE");
    const script = `
      const { Database } = require('bun:sqlite');
      const { observeSqlite } = require(${JSON.stringify(path.join(import.meta.dir, "sqliteReadAttribution.ts"))});
      const { sqliteMemoryOnThisThread } = require(${JSON.stringify(path.join(import.meta.dir, "sqliteMemoryDiagnostics.ts"))});
      const reader = observeSqlite(new Database(${JSON.stringify(filename)}, { readonly: true }), 'state');
      reader.exec('PRAGMA busy_timeout=5000');
      const started = performance.now();
      const sample = sqliteMemoryOnThisThread();
      process.stdout.write(JSON.stringify({ elapsedMs: performance.now() - started, connection: sample.connections.at(-1) }) + '\\n');
      reader.close();
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
    const started = performance.now();
    const watchdog = setTimeout(() => child.kill(), 2_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      const sample = JSON.parse(stdout.trim()) as { elapsedMs: number; connection: { cacheSize: number | null; mmapSizeBytes: number | null } };
      console.info("locked SQLite memory sample elapsed ms:", sample.elapsedMs.toFixed(2));
      expect([null, -2000]).toContain(sample.connection.cacheSize);
    } finally { clearTimeout(watchdog); if (child.exitCode === null) child.kill(); await child.exited; }
    writer.exec("COMMIT");
  } finally { writer.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a synchronous PRAGMA hang is bounded by an independent child watchdog", async () => {
  const script = `
    const { Database } = require('bun:sqlite');
    const { observeSqlite } = require(${JSON.stringify(path.join(import.meta.dir, "sqliteReadAttribution.ts"))});
    const { sqliteMemoryOnThisThread } = require(${JSON.stringify(path.join(import.meta.dir, "sqliteMemoryDiagnostics.ts"))});
    const db = observeSqlite(new Database(':memory:'), 'watchdog');
    const prepare = Database.prototype.prepare;
    Database.prototype.prepare = function(sql, ...args) {
      if (sql === 'PRAGMA cache_size') {
        process.stdout.write('entered-blocking-pragma\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      }
      return Reflect.apply(prepare, this, [sql, ...args]);
    };
    sqliteMemoryOnThisThread();
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const stdoutReader = child.stdout.getReader();
  const stderrText = new Response(child.stderr).text();
  let output = "";
  let startupExpired = false;
  const startupWatchdog = setTimeout(() => { startupExpired = true; child.kill(); }, 5_000);
  let blockStarted = false;
  let watchdogFired = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    while (!output.includes("\n")) {
      const chunk = await stdoutReader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
      if (output.includes("entered-blocking-pragma\n")) {
        blockStarted = true;
        clearTimeout(startupWatchdog);
        const started = performance.now();
        watchdog = setTimeout(() => { watchdogFired = true; child.kill(); }, 750);
        const code = await child.exited;
        const elapsedMs = performance.now() - started;
        expect(watchdogFired).toBe(true);
        expect(code).not.toBe(0);
        expect(elapsedMs).toBeLessThan(2_000);
        break;
      }
    }
    expect(startupExpired).toBe(false);
    expect(blockStarted).toBe(true);
    expect(output).toContain("entered-blocking-pragma");
    await stderrText;
  } finally {
    clearTimeout(startupWatchdog);
    if (watchdog) clearTimeout(watchdog);
    if (child.exitCode === null) child.kill();
    await child.exited;
    stdoutReader.releaseLock();
  }
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
    console.info("unresponsive worker sample elapsed ms:", (performance.now() - started).toFixed(2));
    expect(sample.openConnections).toBeNull();
    expect(sample.unavailableWorkers).toBe(1);
    expect(worker.listenerCount("message")).toBe(listeners);
  } finally { detach(); await worker.terminate(); }
});
