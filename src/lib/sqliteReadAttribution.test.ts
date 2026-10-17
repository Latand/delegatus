import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observeSqlite, parseSqliteJson, sqliteReadCounters } from "./sqliteReadAttribution";
import { readAttribution, startReadAttributionSampler } from "./readAttribution";
import { createViewerLoopMonitor } from "./viewerLoopMonitor";
import { openCurrentDatabase } from "./state/currentDatabase";
import { initializeStateCollections, SqliteStateCollection } from "./state/sqliteStateStore";
import { Worker } from "node:worker_threads";
import { attachReadAttributionWorker } from "./readAttribution";

test("mixed collections and later bind slots keep the generic reader label", () => {
  const db = observeSqlite(new Database(":memory:"), "state");
  try {
    db.exec("CREATE TABLE state_rows(collection TEXT,row_key TEXT); INSERT INTO state_rows VALUES ('pipelines','tasks'),('tasks','row')");
    for (const [where, bindings, expected] of [
      ["collection=?", ["pipelines"], "state.pipelines.all"],
      ["collection IN (?)", ["pipelines"], "state.pipelines.all"],
      ["collection IN (?,?)", ["pipelines", "tasks"], "state.all"],
      ["row_key=? AND collection=?", ["tasks", "pipelines"], "state.all"],
      ["collection=?2 AND row_key=?1", ["tasks", "pipelines"], "state.all"],
    ] as const) {
      readAttribution.clear();
      db.query(`SELECT row_key FROM state_rows WHERE ${where}`).all(...bindings);
      const reader = readAttribution.snapshot(1).top.find(row => row.reader.endsWith(".all"));
      expect(reader!.reader).toBe(expected);
    }
  } finally { db.close(); readAttribution.clear(); }
});

test("transaction JSON bytes belong to the connection that supplied the row", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "read-attribution-transaction-"));
  const filename = path.join(directory, "state.sqlite");
  const row = { id: "row", text: "content" };
  initializeStateCollections(filename, [{ collection: "tasks", schemaVersion: 1, migrationId: "fixture",
    key: value => (value as typeof row).id, loadRecords: () => [row] }]);
  const store = new SqliteStateCollection<typeof row>(filename, { collection: "tasks", schemaVersion: 1, busyMessage: "busy",
    key: value => value.id, decode: value => value as typeof row, clone: structuredClone });
  const reader = (store as unknown as { readDb: Database }).readDb;
  try {
    const identity = sqliteReadCounters(reader)!.connection;
    const before = sqliteReadCounters(reader)!.decodedJsonBytes;
    readAttribution.clear();
    expect(store.boundedPatch(8, tx => tx.get("row"))).toEqual(row);
    const decoded = readAttribution.snapshot(1).top.find(value => value.reader === "state.json")!;
    expect(decoded.decodedJsonBytes).toBe(Buffer.byteLength(JSON.stringify(row)));
    expect(decoded.connection).not.toBe(identity);
    expect(sqliteReadCounters(reader)!.decodedJsonBytes).toBe(before);
    expect(store.get("row")).toEqual(row);
    expect(sqliteReadCounters(reader)!.decodedJsonBytes).toBe(before + Buffer.byteLength(JSON.stringify(row)));
  } finally { reader.close(); readAttribution.clear(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test.each(["before", "after"])("prototype guards installed %s decoration are observed and restore native calls", timing => {
  const native = Database.prototype.exec;
  let db: Database | undefined;
  if (timing === "after") db = observeSqlite(new Database(":memory:"), "state");
  const calls = spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, ...args) {
    if (args[0] === "forbidden") throw Error("guard refusal");
    return Reflect.apply(native, this, args);
  });
  try {
    db ??= observeSqlite(new Database(":memory:"), "state");
    db.exec("CREATE TABLE t(value TEXT)");
    expect(() => db!.exec("forbidden")).toThrow("guard refusal");
    expect(calls).toHaveBeenCalledTimes(2);
  } finally { calls.mockRestore(); }
  try {
    db!.exec("INSERT INTO t VALUES ('{}')");
    expect(db!.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
  } finally { db?.close(); readAttribution.clear(); }
});

test("real statements, iteration, cache and JSON parsing retain connection identity in gap logs", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "read-attribution-"));
  const filename = path.join(directory, "fixture.sqlite");
  const open = () => observeSqlite(new Database(filename), "state");
  let db: Database | undefined;
  try {
    const seed = new Database(filename);
    seed.exec("CREATE TABLE state_rows(collection TEXT, value_json TEXT)");
    const json = JSON.stringify({ payload: "ї".repeat(128 * 1024) });
    seed.query("INSERT INTO state_rows VALUES (?,?)").run("pipelines", json);
    seed.close();
    db = openCurrentDatabase(filename, open);
    db.exec("PRAGMA cache_size=-16");
    readAttribution.clear();
    startReadAttributionSampler();
    await new Promise(resolve => setTimeout(resolve, 30));
    readAttribution.clear();
    let at = 0;
    const lines: string[] = [];
    const monitor = createViewerLoopMonitor(line => lines.push(line), () => at);
    monitor.run("pipelines.get", () => {
      const statement = db!.query<{ value_json: string }, [string]>("SELECT value_json FROM state_rows WHERE collection=?");
      expect(statement).toBe(db!.query("SELECT value_json FROM state_rows WHERE collection=?"));
      const iterator = statement.iterate("pipelines");
      const first = readAttribution.sync("state.iterate", () => {
        const row = iterator.next();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 35);
        return row;
      }, sqliteReadCounters(db!)!.connection);
      expect(first.done).toBe(false);
      parseSqliteJson(first.value!.value_json, db);
      for (const row of iterator) parseSqliteJson(row.value_json, db);
      for (const row of statement.all("pipelines")) parseSqliteJson(row.value_json, db);
      expect(statement.get("pipelines")!.value_json).toBe(json);
      expect(statement.values("pipelines")).toHaveLength(1);
      expect(() => parseSqliteJson("invalid", db)).toThrow();
    });
    at = 1100; monitor.tick();
    const gap = JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length));
    expect(gap.reads.decodedJsonBytes).toBe(Buffer.byteLength(json) * 2 + 7);
    if (process.platform === "linux") {
      expect(gap.reads.readBytes).toBe(0);
      expect(gap.reads.unavailableCalls).toBeGreaterThan(0);
    }
    const jsonReader = gap.reads.top.find((row: { reader: string }) => row.reader === "state.json");
    expect(jsonReader.connection).toBeGreaterThan(0);
    expect(jsonReader.failed).toBe(1);
    expect(gap.reads.top.filter((row: { connection: number }) => row.connection > 0).every((row: { connection: number }) => row.connection === jsonReader.connection)).toBe(true);
    expect(gap.reads.operations).toContainEqual({ name: "pipelines.get", readBytes: gap.reads.readBytes, decodedJsonBytes: gap.reads.decodedJsonBytes });
    expect(JSON.stringify(gap)).not.toContain(directory);
    expect(JSON.stringify(gap)).not.toContain("SELECT value_json");
    expect(JSON.stringify(gap)).not.toContain("ї");
    expect(sqliteReadCounters(db)!.decodedJsonBytes).toBe(Buffer.byteLength(json) * 2 + 7);
    expect(gap.operations[0].decodedJsonBytes).toBe(gap.reads.decodedJsonBytes);
    monitor.stop();
    expect(readAttribution.snapshot(1).top).toEqual([]);
    if (process.platform === "linux") {
      const bulkDb = new Database(filename);
      const nativeQuery = bulkDb.query.bind(bulkDb);
      observeSqlite(bulkDb, "state-bulk");
      const connection = sqliteReadCounters(bulkDb)!.connection;
      try {
        bulkDb.exec("PRAGMA cache_size=-16; PRAGMA shrink_memory");
        readAttribution.sync("state.bulk", () => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
          nativeQuery("SELECT value_json FROM state_rows").all();
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }, connection);
        const bulk = readAttribution.snapshot(100).top.find(row => row.reader === "state.bulk");
        expect(bulk?.connection).toBe(connection);
        expect(bulk?.readBytes).toBeGreaterThan(100_000);
      } finally { bulkDb.close(); readAttribution.clear(); }
    }
    db.transaction(() => db!.query("INSERT INTO state_rows VALUES (?,?)").run("tasks", "{}"))();
    expect(() => db!.transaction(() => { db!.exec("DELETE FROM state_rows"); throw Error("rollback"); })()).toThrow();
    expect(db.query("SELECT count(*) AS n FROM state_rows").get()).toEqual({ n: 2 });
    const early = db.query("SELECT value_json FROM state_rows").iterate();
    for (const row of early) { expect(row).toBeDefined(); break; }
    expect(() => db!.query("SELECT missing FROM state_rows")).toThrow();
    const privateCollection = "unpublished-collection";
    db.query("SELECT value_json FROM state_rows WHERE collection=?").get(privateCollection);
    expect(JSON.stringify(readAttribution.snapshot(1))).not.toContain(privateCollection);
  } finally { db?.close(); readAttribution.clear(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("connection reopening updates the identity used by row decoders", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "read-attribution-swap-"));
  const filename = path.join(directory, "fixture.sqlite");
  const replacement = path.join(directory, "replacement.sqlite");
  for (const file of [filename, replacement]) { const seed = new Database(file); seed.exec("CREATE TABLE t(value TEXT); INSERT INTO t VALUES ('{}')"); seed.close(); }
  const db = openCurrentDatabase(filename, () => observeSqlite(new Database(filename), "state"));
  try {
    readAttribution.clear(); parseSqliteJson(db.query<{ value: string }, []>("SELECT value FROM t").get()!.value, db);
    const before = readAttribution.snapshot(1).top.find(row => row.reader === "state.json")!.connection;
    fs.renameSync(replacement, filename);
    readAttribution.clear(); parseSqliteJson(db.query<{ value: string }, []>("SELECT value FROM t").get()!.value, db);
    const after = readAttribution.snapshot(1).top.find(row => row.reader === "state.json")!.connection;
    expect(after).toBeGreaterThan(before);
  } finally { db.close(); readAttribution.clear(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("worker SQLite reads and JSON decoding reach the parent loop monitor with worker identity", async () => {
  readAttribution.clear();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "read-attribution-worker-"));
  const filename = path.join(directory, "fixture.sqlite");
  const seed = new Database(filename);
  const payload = JSON.stringify({ value: "x".repeat(1024 * 1024) });
  seed.exec("CREATE TABLE rows(value TEXT)");
  seed.query("INSERT INTO rows VALUES (?)").run(payload);
  seed.close();
  let now = 0;
  const lines: string[] = [];
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => now);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { Database } = require('bun:sqlite');
    const { observeSqlite, sqliteReadCounters, parseSqliteJson } = require(workerData.sqliteModule);
    const { readAttribution } = require(workerData.readModule);
    const { startReadAttributionSampler } = require(workerData.readModule);
    parentPort.on('message', message => {
      if (message?.type === 'delegatus-read-attribution-ack') parentPort.close();
    });
    const db = new Database(workerData.filename);
    observeSqlite(db, 'worker-state');
    startReadAttributionSampler();
    readAttribution.run('worker.fixture', () => {
      const row = readAttribution.sync('worker-state.get', () => {
        const value = db.query('SELECT value FROM rows').get();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 35);
        return value;
      }, sqliteReadCounters(db).connection);
      const bulkDb = new Database(workerData.filename);
      const bulkQuery = bulkDb.query.bind(bulkDb);
      observeSqlite(bulkDb, 'worker-state-bulk');
      readAttribution.sync('worker-state.bulk', () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        bulkQuery('SELECT value FROM rows').all();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }, sqliteReadCounters(bulkDb).connection);
      bulkDb.close();
      parseSqliteJson(row.value, db);
    });
    db.close();
    parentPort.postMessage({ type: 'worker-done' });
  `, { eval: true, workerData: { filename, sqliteModule: `${import.meta.dir}/sqliteReadAttribution.ts`, readModule: `${import.meta.dir}/readAttribution.ts` } });
  const detach = attachReadAttributionWorker(worker, "fixture");
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
    });
    await new Promise(resolve => setImmediate(resolve));
    monitor.run("files.get", () => {});
    now = 600;
    monitor.tick();
    const report = JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length));
    const workerJson = report.reads.top.find((row: { reader: string }) => row.reader === "worker-state.json");
    expect(workerJson).toMatchObject({ reader: "worker-state.json", decodedJsonBytes: 1024 * 1024 + 12 });
    expect(workerJson.worker).toMatch(/^fixture-\d+$/);
    expect(workerJson.operation).toBe(`worker-${workerJson.worker}:worker.fixture`);
    const workerSql = report.reads.top.find((row: { operation: string; reader: string }) => row.operation === workerJson.operation
      && row.reader === "worker-state.get");
    expect(workerSql.connections).toHaveLength(1);
    if (process.platform === "linux") expect(workerSql.unavailableCalls).toBeGreaterThan(0);
    const workerBulk = report.reads.top.find((row: { reader: string }) => row.reader === "worker-state.bulk");
    if (process.platform === "linux") expect(workerBulk.readBytes).toBeGreaterThan(0);
    expect(report.reads.workerBatches).toBeGreaterThan(0);
  } finally { detach(); await worker.terminate(); readAttribution.clear(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a real process restart resets counter retention and sampling budgets", async () => {
  const run = async (mode: string) => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "readAttributionFixture.ts"), mode], {
      env: process.env, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    return JSON.parse(stdout);
  };
  const full = await run("overflow"), fresh = await run("fresh");
  expect(full.before.top).toEqual([]);
  expect(full.after.dropped).toBe(384);
  expect(fresh.before.top).toEqual([]);
  expect(fresh.after.dropped).toBe(0);
  expect(fresh.after.readBytes).toBe(0);
});

test.skipIf(process.platform !== "linux")("production Bun process attributes SQLite bytes after sampler collisions and transient latency", async () => {
  for (let restart = 0; restart < 2; restart++) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "read-counter-process-"));
    const roots = Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "TMPDIR", "LLV_STATE_DIR"].map(name => {
      const root = path.join(directory, name); fs.mkdirSync(root); return [name, root];
    }));
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "readAttributionFixture.ts"), "service-recovery"], {
      env: { ...process.env, ...roots, NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe",
    });
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.nodeEnv).toBe("production");
      expect(report.gap.reads.samplerDegraded).toBe(false);
      expect(report.gap.reads.readBytes).toBeGreaterThan(1_000_000);
      expect(report.gap.reads.sampledCalls).toBeGreaterThan(0);
      expect(report.gap.reads.top.find((row: { reader: string }) => row.reader === "state.all"))
        .toMatchObject({ operation: "files.get", connection: report.connection, readBytes: report.gap.reads.readBytes });
      expect(report.counters.connection).toBe(report.connection);
      expect(report.counters.readBytes).toBe(report.gap.reads.readBytes);
      expect(report.gap.operations[0].readBytes).toBe(report.gap.reads.readBytes);
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited; }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}, 20_000);
