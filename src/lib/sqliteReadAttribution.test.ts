import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { observeSqlite, parseSqliteJson, sqliteReadCounters } from "./sqliteReadAttribution";
import { readAttribution } from "./readAttribution";
import { createViewerLoopMonitor } from "./viewerLoopMonitor";
import { openCurrentDatabase } from "./state/currentDatabase";

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

test("real statements, iteration, cache and JSON parsing retain connection identity in gap logs", () => {
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
    let at = 0;
    const lines: string[] = [];
    const monitor = createViewerLoopMonitor(line => lines.push(line), () => at);
    monitor.run("pipelines.get", () => {
      const statement = db!.query<{ value_json: string }, [string]>("SELECT value_json FROM state_rows WHERE collection=?");
      expect(statement).toBe(db!.query("SELECT value_json FROM state_rows WHERE collection=?"));
      for (const row of statement.iterate("pipelines")) parseSqliteJson(row.value_json, db);
      for (const row of statement.all("pipelines")) parseSqliteJson(row.value_json, db);
      expect(statement.get("pipelines")!.value_json).toBe(json);
      expect(statement.values("pipelines")).toHaveLength(1);
      expect(() => parseSqliteJson("invalid", db)).toThrow();
    });
    at = 1100; monitor.tick();
    const gap = JSON.parse(lines[0]!.slice("[viewer loop-gap] ".length));
    expect(gap.reads.decodedJsonBytes).toBe(Buffer.byteLength(json) * 2 + 7);
    if (process.platform === "linux") expect(gap.reads.readBytes).toBeGreaterThan(200_000);
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
