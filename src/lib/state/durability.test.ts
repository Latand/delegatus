import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { readReaperReport } from "@/lib/reaperRuntime";

import { loadTasks } from "@/lib/tasks/store";
import { checkStateDatabasesBeforeStores } from "@/lib/viewerInstrumentation";

import {
  backupDatabase,
  checkStateDatabasesAtActivation,
  pruneBackups,
  raiseStorageIncidentCard,
  readStorageIncidents,
  runBackupPass,
  removeDeadStateFiles,
  stateDatabases,
  sweepStaleTempFiles,
  type StateDatabase,
} from "./durability";
import { readJsonCache, writeJsonDurably } from "./durableJson";

/* #1870 slice 10 (docs/design/state-sqlite-migration.md §7). Every case runs in
   an mkdtemp state directory; the damaged database is a copy made here, never
   the live one. */

const saved = process.env.LLV_STATE_DIR;
const sandboxes: string[] = [];
const CHILD = path.join(import.meta.dir, "durability.sqliteChild.ts");
const HOUR = 60 * 60_000;
/** A writer's temp-name nonce, in the shape `crypto.randomUUID()` gives. */
const NONCE = ["0f8fad5b", "d9cb", "469f", "a165", "70867728950e"].join("-");

afterEach(() => {
  if (saved === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = saved;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-durability-"));
  sandboxes.push(directory);
  process.env.LLV_STATE_DIR = directory;
  return directory;
}

/** Write tasks through the production store in a child, which exits and
    leaves no connection behind in this process. */
function seedTasks(directory: string, ids: string[]): string[] {
  const child = Bun.spawnSync([process.execPath, CHILD, path.join(directory, "tasks.json"), ...ids], {
    env: { ...process.env, LLV_STATE_DIR: directory },
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(`seed child failed: ${child.stderr.toString()}`);
  return JSON.parse(child.stdout.toString()) as string[];
}

function readTaskIds(directory: string): string[] {
  const child = Bun.spawnSync([process.execPath, CHILD, "--read", path.join(directory, "tasks.json")], {
    env: { ...process.env, LLV_STATE_DIR: directory },
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(`read child failed: ${child.stderr.toString()}`);
  return JSON.parse(child.stdout.toString()) as string[];
}

function checkpoint(filename: string): void {
  const db = new Database(filename);
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
}

/** Overwrite bytes in the copy the test owns. */
function overwrite(filename: string, offset: number, bytes: Buffer): void {
  const descriptor = fs.openSync(filename, "r+");
  try { fs.writeSync(descriptor, bytes, 0, bytes.length, offset); } finally { fs.closeSync(descriptor); }
}

function stateDatabase(directory: string): StateDatabase {
  const found = stateDatabases(directory).find((database) => database.name === "state.sqlite");
  if (!found) throw new Error("state.sqlite is not a durable database");
  return found;
}

function backupDirectory(directory: string): string {
  return path.join(directory, "backups", "sqlite");
}

test("a corrupted state database is restored from the newest good backup and raises an incident", () => {
  const directory = sandbox();
  const database = stateDatabase(directory);
  expect(seedTasks(directory, ["older"])).toEqual(["older"]);
  const first = backupDatabase(database, { backupDirectory: backupDirectory(directory), now: new Date("2026-09-19T10:00:00Z") });
  expect(first.state).toBe("taken");
  seedTasks(directory, ["older", "newer"]);
  const second = backupDatabase(database, { backupDirectory: backupDirectory(directory), now: new Date("2026-09-19T10:10:00Z") });
  expect(second.state).toBe("taken");
  seedTasks(directory, ["older", "newer", "lost"]);
  checkpoint(database.filename);
  /* The newest backup is itself damaged: the fallback skips it. */
  if (second.state !== "taken") throw new Error("unreachable");
  overwrite(second.file, 0, Buffer.alloc(100, 0x41));
  const third = backupDatabase(database, { backupDirectory: backupDirectory(directory), now: new Date("2026-09-19T10:20:00Z") });
  expect(third.state).toBe("taken");
  if (third.state !== "taken") throw new Error("unreachable");
  overwrite(third.file, 0, Buffer.alloc(100, 0x41));
  /* Now damage the live copy: a page in the middle of the file. */
  const size = fs.statSync(database.filename).size;
  overwrite(database.filename, 4096, Buffer.alloc(Math.min(8192, size - 4096), 0xff));

  const incidents = checkStateDatabasesAtActivation(directory, { now: new Date("2026-09-19T10:30:00Z") });

  expect(incidents).toHaveLength(1);
  const [incident] = incidents;
  expect(incident).toMatchObject({ kind: "database-restored", database: "state.sqlite" });
  /* The two damaged backups were refused; the one before them won. */
  if (first.state !== "taken") throw new Error("unreachable");
  expect(incident?.backup).toBe(path.basename(first.file));
  expect(incident?.backupAt).toBe("2026-09-19T10:00:00.000Z");
  expect(incident?.message).toContain("2026-09-19T10:00:00.000Z");
  /* The damaged files are kept, never deleted. */
  expect(incident?.corruptFiles.length).toBeGreaterThan(0);
  for (const kept of incident?.corruptFiles ?? []) expect(fs.existsSync(path.join(directory, kept))).toBe(true);
  expect(fs.existsSync(`${database.filename}.restoring`)).toBe(false);
  /* The store serves the backup's rows. */
  expect(readTaskIds(directory)).toEqual(["older"]);
  /* The incident is durable, for the files route in another process. */
  expect(readStorageIncidents(directory, { now: new Date("2026-09-19T10:31:00Z") })).toEqual([incident!]);
});

test("a database whose header is not SQLite and has no readable backup starts fresh and serves an empty store", () => {
  const directory = sandbox();
  const database = stateDatabase(directory);
  seedTasks(directory, ["gone"]);
  checkpoint(database.filename);
  fs.writeFileSync(database.filename, Buffer.alloc(fs.statSync(database.filename).size, 0));

  const incidents = checkStateDatabasesAtActivation(directory, { now: new Date("2026-09-19T11:00:00Z") });

  expect(incidents).toHaveLength(1);
  expect(incidents[0]).toMatchObject({ kind: "database-fresh", database: "state.sqlite", backup: null });
  expect(fs.existsSync(database.filename)).toBe(false);
  /* The task store answers an empty board instead of an error. */
  expect(readTaskIds(directory)).toEqual([]);
  /* And writes again. */
  expect(seedTasks(directory, ["after"])).toEqual(["after"]);
});

test("a healthy or absent database is left alone", () => {
  const directory = sandbox();
  expect(checkStateDatabasesAtActivation(directory)).toEqual([]);
  seedTasks(directory, ["kept"]);
  const before = fs.readdirSync(directory).sort();
  expect(checkStateDatabasesAtActivation(directory)).toEqual([]);
  expect(fs.readdirSync(directory).sort()).toEqual(before);
  expect(readTaskIds(directory)).toEqual(["kept"]);
});

test("a backup is skipped when nothing changed or it is not due, and taken after a change", () => {
  const directory = sandbox();
  const database = stateDatabase(directory);
  const backups = backupDirectory(directory);
  expect(backupDatabase(database, { backupDirectory: backups, now: new Date("2026-09-19T10:00:00Z") }).state).toBe("absent");
  seedTasks(directory, ["a"]);
  const taken = backupDatabase(database, { backupDirectory: backups, now: new Date("2026-09-19T10:00:00Z") });
  expect(taken).toMatchObject({ state: "taken" });
  if (taken.state !== "taken") throw new Error("unreachable");
  expect(fs.readdirSync(backups).filter((name) => name.endsWith(".partial"))).toEqual([]);
  const copy = new Database(taken.file, { readonly: true });
  try { expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" }); } finally { copy.close(); }

  expect(backupDatabase(database, { backupDirectory: backups, now: new Date("2026-09-19T10:05:00Z"), lastRevision: taken.revision }).state).toBe("not-due");
  expect(backupDatabase(database, { backupDirectory: backups, now: new Date("2026-09-19T10:20:00Z"), lastRevision: taken.revision }).state).toBe("unchanged");
  seedTasks(directory, ["a", "b"]);
  const next = backupDatabase(database, { backupDirectory: backups, now: new Date("2026-09-19T10:20:00Z"), lastRevision: taken.revision });
  expect(next.state).toBe("taken");
  expect(fs.readdirSync(backups).filter((name) => name.endsWith(".sqlite"))).toHaveLength(2);
});

test("a backup is skipped with an incident when free space is below twice the database", () => {
  const directory = sandbox();
  const database = stateDatabase(directory);
  seedTasks(directory, ["a"]);
  const outcome = backupDatabase(database, {
    backupDirectory: backupDirectory(directory),
    now: new Date("2026-09-19T10:00:00Z"),
    freeBytes: () => fs.statSync(database.filename).size,
  });
  expect(outcome.state).toBe("skipped-low-space");
  expect(fs.existsSync(backupDirectory(directory)) ? fs.readdirSync(backupDirectory(directory)) : []).toEqual([]);
  expect(readStorageIncidents(directory, { now: new Date("2026-09-19T10:01:00Z") }).map((incident) => incident.kind))
    .toEqual(["backup-skipped-low-space"]);
});

function fakeBackup(directory: string, database: string, at: Date, bytes: number): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  const file = path.join(directory, `${database.replace(/\.sqlite$/, "")}-${stamp}.sqlite`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
  return path.basename(file);
}

test("retention keeps the newest six, one per four hours for a day and one per day for three days", () => {
  const directory = sandbox();
  const backups = backupDirectory(directory);
  const now = new Date("2026-09-19T12:00:00Z");
  const names: string[] = [];
  /* A generation every 10 minutes for five days. */
  for (let minutes = 0; minutes <= 5 * 24 * 60; minutes += 10) {
    names.push(fakeBackup(backups, "state.sqlite", new Date(now.getTime() - minutes * 60_000), 10));
  }
  const databases = stateDatabases(directory);
  pruneBackups(backups, databases, { now, budgetBytes: 2 * 1024 ** 3 });
  const kept = fs.readdirSync(backups).sort().reverse();
  expect(kept).toHaveLength(15);
  expect(kept.slice(0, 6)).toEqual(names.slice(0, 6));
});

test("the size budget evicts the oldest generations first and never the newest three", () => {
  const directory = sandbox();
  const backups = backupDirectory(directory);
  const now = new Date("2026-09-19T12:00:00Z");
  const names: string[] = [];
  for (let hours = 0; hours < 72; hours += 1) {
    names.push(fakeBackup(backups, "state.sqlite", new Date(now.getTime() - hours * HOUR), 100));
  }
  pruneBackups(backups, stateDatabases(directory), { now, budgetBytes: 250 });
  expect(fs.readdirSync(backups).sort().reverse()).toEqual(names.slice(0, 3));
});

test("temp files of dead writers are swept; a live or young writer's temp file stays", () => {
  const directory = sandbox();
  const now = Date.parse("2026-09-19T12:00:00Z");
  const old = new Date(now - 2 * HOUR);
  const files = {
    dead: `.tasks.json.4000001.${NONCE}.tmp`,
    deadPlain: "limits-cache.json.4000002.tmp",
    live: `.board.json.4000003.${NONCE}.tmp`,
    young: `.attention.json.4000004.${NONCE}.tmp`,
    unowned: "notes.tmp",
    notTemp: "tasks.4000005.json",
  };
  for (const name of Object.values(files)) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, "x");
    if (name !== files.young) fs.utimesSync(file, old, old);
  }
  const removed = sweepStaleTempFiles(directory, { now, pidAlive: (pid) => pid === 4000003 });
  expect(removed.sort()).toEqual([files.dead, files.deadPlain].sort());
  expect(fs.readdirSync(directory).sort()).toEqual([files.live, files.young, files.unowned, files.notTemp].sort());
});

test("dead state files are removed: orchestrator.json and zero-byte stray databases", () => {
  const directory = sandbox();
  fs.writeFileSync(path.join(directory, "orchestrator.json"), "{}");
  fs.writeFileSync(path.join(directory, "pipelines.sqlite"), "");
  fs.writeFileSync(path.join(directory, "registry.sqlite"), "not empty");
  expect(removeDeadStateFiles(directory).sort()).toEqual(["orchestrator.json", "pipelines.sqlite"]);
  expect(fs.readdirSync(directory)).toEqual(["registry.sqlite"]);
});

test("a NUL-filled cache is discarded and rebuilt without an error", () => {
  const directory = sandbox();
  const cache = path.join(directory, "reaper-report.json");
  fs.writeFileSync(cache, Buffer.alloc(4096, 0));
  expect(readJsonCache(cache)).toBeUndefined();
  expect(fs.existsSync(cache)).toBe(false);

  fs.writeFileSync(cache, Buffer.alloc(4096, 0));
  expect(readReaperReport()).toBeNull();
  expect(fs.existsSync(cache)).toBe(false);
  writeJsonDurably(cache, { agents: [] }, { space: 0 });
  expect(fs.readFileSync(cache, "utf8")).toBe("{\"agents\":[]}\n");
  expect(readReaperReport()).toEqual({ agents: [] } as unknown as ReturnType<typeof readReaperReport>);
});

test("the activation hook restores before the stores open, and the incident card lands on the restored board once", async () => {
  const directory = sandbox();
  const database = stateDatabase(directory);
  seedTasks(directory, ["kept"]);
  const pass = runBackupPass(directory, new Map(), { now: new Date("2026-09-19T10:00:00Z") });
  expect(pass.get("state.sqlite")?.state).toBe("taken");
  seedTasks(directory, ["kept", "after-backup"]);
  checkpoint(database.filename);
  fs.writeFileSync(database.filename, Buffer.alloc(fs.statSync(database.filename).size, 0x5a));

  await checkStateDatabasesBeforeStores(directory);
  const [incident] = readStorageIncidents(directory);
  expect(incident).toMatchObject({ kind: "database-restored", database: "state.sqlite", backupAt: "2026-09-19T10:00:00.000Z" });

  const tasksFile = path.join(directory, "tasks.json");
  await raiseStorageIncidentCard(directory, incident!, "proj");
  await raiseStorageIncidentCard(directory, incident!, "proj");
  const tasks = loadTasks(tasksFile);
  expect(tasks.map((task) => task.id)).toContain("kept");
  expect(tasks.map((task) => task.id)).not.toContain("after-backup");
  const cards = tasks.filter((task) => task.text.startsWith("State database state.sqlite was restored"));
  expect(cards).toHaveLength(1);
  expect(cards[0]?.text).toContain("2026-09-19T10:00:00.000Z");
  expect(cards[0]).toMatchObject({ project: "proj", status: "inbox", placement: "unplaced" });
});
