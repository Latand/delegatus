import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { readReaperReport } from "@/lib/reaperRuntime";

import { SqliteHandoffQueueStore } from "@/lib/runtime/handoffQueueStore";
import { loadTasks } from "@/lib/tasks/store";
import { checkStateDatabasesBeforeStores } from "@/lib/viewerInstrumentation";

import {
  backupDatabase,
  checkStateDatabasesAtActivation,
  pruneBackups,
  raiseStorageIncidentCard,
  readStorageIncidents,
  runBackupPass,
  runBackupPassInWorker,
  removeDeadStateFiles,
  storageIncidentTaskText,
  stateDatabases,
  sweepStaleTempFiles,
  type StateDatabase,
  type StorageIncident,
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

test("an incident card with no named project lands on the Viewer's key this machine resolved, under either GitHub name", async () => {
  /* The release names Latand/delegatus while a checkout cloned before the
     GitHub rename still resolves Latand/live-log-viewer-next, and no alias
     joins the two yet. The card belongs on the board the operator sees. */
  const restoreRemote = process.env.LLV_VIEWER_CANONICAL_REMOTE;
  delete process.env.LLV_VIEWER_CANONICAL_REMOTE;
  try {
    const incident: StorageIncident = {
      kind: "database-fresh", database: "state.sqlite", at: "2026-09-23T10:00:00.000Z", message: "fresh",
      corruptFiles: [], backup: null, backupAt: null, backupAgeMs: null, detail: null,
    };
    const cardProject = async (ledger: Record<string, string>): Promise<string | undefined> => {
      const directory = sandbox();
      fs.writeFileSync(path.join(directory, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: ledger }));
      await raiseStorageIncidentCard(directory, incident);
      return loadTasks(path.join(directory, "tasks.json")).find((task) => task.text.includes("state.sqlite"))?.project;
    };
    const oldKey = projectIdentityFromRemote("https://github.com/Latand/live-log-viewer-next.git", os.tmpdir())!;
    const newKey = projectIdentityFromRemote("https://github.com/Latand/delegatus.git", os.tmpdir())!;

    expect(await cardProject({ [oldKey.project]: oldKey.canonicalRemote })).toBe(oldKey.project);
    expect(await cardProject({ [newKey.project]: newKey.canonicalRemote, [oldKey.project]: oldKey.canonicalRemote })).toBe(newKey.project);
    expect(await cardProject({})).toBe(newKey.project);
  } finally {
    if (restoreRemote === undefined) delete process.env.LLV_VIEWER_CANONICAL_REMOTE;
    else process.env.LLV_VIEWER_CANONICAL_REMOTE = restoreRemote;
  }
});

/* ---- the swap under other processes' connections (review round 1) -------- */

const HOLDER = path.join(import.meta.dir, "durability.holderChild.ts");

/** A state database whose last pages can be damaged while a connection that
    only touches `probe` keeps working, as a crash-torn page would leave it. */
function probeDatabase(filename: string, labels: string[]): void {
  const db = new Database(filename, { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE probe(label TEXT NOT NULL); CREATE TABLE filler(body BLOB);");
    db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200) INSERT INTO filler SELECT randomblob(1000) FROM n");
    for (const label of labels) db.query("INSERT INTO probe(label) VALUES (?)").run(label);
  } finally {
    db.close();
  }
}

function probeLabels(filename: string): string[] {
  const db = new Database(filename, { readonly: true });
  try { return db.query<{ label: string }, []>("SELECT label FROM probe ORDER BY rowid").all().map((row) => row.label); } finally { db.close(); }
}

type HolderReply = { ok: boolean; value?: unknown; error?: string; code?: string | null };

function holder(filename: string): { child: Subprocess<"pipe", "pipe", "inherit">; next(): Promise<HolderReply>; send(line: string): void } {
  const child = Bun.spawn([process.execPath, HOLDER, filename], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    child,
    async next() {
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          return JSON.parse(line) as HolderReply;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("holder exited");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
    send(line: string) {
      child.stdin.write(`${line}\n`);
      child.stdin.flush();
    },
  };
}

test("a connection held across the restore never writes into the set-aside files: its open transaction is refused and its next write lands in the restored database", async () => {
  const directory = sandbox();
  const database = stateDatabase(directory);
  probeDatabase(database.filename, ["before-backup"]);
  expect(backupDatabase(database, { backupDirectory: backupDirectory(directory), now: new Date("2026-09-19T10:00:00Z") }).state).toBe("taken");
  const late = new Database(database.filename);
  try { late.query("INSERT INTO probe(label) VALUES ('after-backup')").run(); late.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { late.close(); }

  const held = holder(database.filename);
  try {
    expect(await held.next()).toEqual({ ok: true, value: ["before-backup", "after-backup"] });
    held.send("begin");
    expect((await held.next()).ok).toBe(true);
    /* Crash damage in pages the holder does not touch. */
    const size = fs.statSync(database.filename).size;
    overwrite(database.filename, size - 3 * 4096, Buffer.alloc(3 * 4096, 0xff));

    const opensDuringSwap: HolderReply[] = [];
    const namesDuringSwap: string[][] = [];
    const outcome = checkStateDatabasesAtActivation(directory, {
      now: new Date("2026-09-19T10:30:00Z"),
      beforeSwapStep: (step) => {
        if (step === "set-aside-main") {
          /* A writer whose transaction began before the swap asks for the
             write lock while the swap holds it. */
          held.send("insert late-row");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        }
        if (step === "restore") {
          /* A process that opens in the window between the WAL moving aside
             and the restored file arriving. */
          const opened = Bun.spawnSync([process.execPath, HOLDER, database.filename, "--open-once"], { stderr: "inherit" });
          opensDuringSwap.push(JSON.parse(opened.stdout.toString()) as HolderReply);
          namesDuringSwap.push(fs.readdirSync(directory).filter((name) => /^state\.sqlite-(wal|shm)$/.test(name)));
        }
      },
    });

    expect(outcome.map((incident) => incident.kind)).toEqual(["database-restored"]);
    expect(opensDuringSwap).toHaveLength(1);
    expect(opensDuringSwap[0]).toMatchObject({ ok: false, code: "LLV_DATABASE_REPLACED" });
    expect(namesDuringSwap).toEqual([[]]);
    /* The insert went through inside the transaction; its commit is refused
       and rolled back, so it lands nowhere. */
    expect((await held.next()).ok).toBe(true);
    held.send("commit");
    expect(await held.next()).toMatchObject({ ok: false, code: "LLV_DATABASE_REPLACED" });
    /* The next write reopens and lands in the restored database. */
    held.send("write after-restore");
    expect(await held.next()).toEqual({ ok: true, value: null });
    held.send("labels");
    expect(await held.next()).toEqual({ ok: true, value: ["before-backup", "after-restore"] });
  } finally {
    held.send("exit");
    await held.child.exited;
  }
  expect(probeLabels(database.filename)).toEqual(["before-backup", "after-restore"]);
  const corrupt = fs.readdirSync(directory).filter((name) => name.includes(".corrupt-"));
  expect(corrupt.length).toBeGreaterThan(0);
  for (const name of corrupt) {
    const bytes = fs.readFileSync(path.join(directory, name));
    expect(bytes.includes("after-restore")).toBe(false);
    expect(bytes.includes("late-row")).toBe(false);
  }
  expect(fs.existsSync(`${database.filename}.swapping`)).toBe(false);
});

test("a failure after the damaged files move aside records an incident and a card, and keeps the damaged files", () => {
  const directory = sandbox();
  const database = stateDatabase(directory);
  seedTasks(directory, ["kept"]);
  expect(runBackupPass(directory, new Map(), { now: new Date("2026-09-19T10:00:00Z") }).get("state.sqlite")?.state).toBe("taken");
  checkpoint(database.filename);
  fs.writeFileSync(database.filename, Buffer.alloc(fs.statSync(database.filename).size, 0x5a));
  const damaged = fs.readFileSync(database.filename);

  const incidents = checkStateDatabasesAtActivation(directory, {
    now: new Date("2026-09-19T10:30:00Z"),
    beforeSwapStep: (step) => {
      if (step === "restore") throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    },
  });

  expect(incidents).toHaveLength(1);
  const [incident] = incidents;
  expect(incident).toMatchObject({ kind: "database-fallback-failed", database: "state.sqlite" });
  expect(incident?.message).toContain("ENOSPC");
  expect(incident?.message).toContain("starts empty");
  expect(readStorageIncidents(directory, { now: new Date("2026-09-19T10:31:00Z") })).toEqual([incident!]);
  expect(storageIncidentTaskText(incident!)).toStartWith("State database state.sqlite was damaged and could not be restored");
  /* The damaged bytes are kept aside; the name is free for a fresh store. */
  expect(incident?.corruptFiles.length).toBeGreaterThan(0);
  expect(fs.readFileSync(path.join(directory, incident!.corruptFiles[0]!))).toEqual(damaged);
  expect(fs.existsSync(database.filename)).toBe(false);
  expect(fs.existsSync(`${database.filename}.restoring`)).toBe(false);
  expect(readTaskIds(directory)).toEqual([]);
});

test("an unreadable incident record is kept aside, never discarded", () => {
  const directory = sandbox();
  const record = path.join(directory, "storage-incidents.json");
  fs.writeFileSync(record, "{\"version\":1,\"incidents\":[{\"kind\":\"database-res");
  expect(readStorageIncidents(directory)).toEqual([]);
  const kept = fs.readdirSync(directory).filter((name) => name.startsWith("storage-incidents.json.unreadable-"));
  expect(kept).toHaveLength(1);
  expect(fs.readFileSync(path.join(directory, kept[0]!), "utf8")).toContain("database-res");
});

test("a failing backup records an incident, once a day", () => {
  const directory = sandbox();
  const database = stateDatabase(directory);
  fs.writeFileSync(database.filename, Buffer.alloc(8192, 0));
  const first = runBackupPass(directory, new Map(), { now: new Date("2026-09-19T10:00:00Z") });
  expect(first.get("state.sqlite")?.state).toBe("failed");
  runBackupPass(directory, new Map(), { now: new Date("2026-09-19T10:10:00Z") });
  const recorded = readStorageIncidents(directory, { now: new Date("2026-09-19T10:11:00Z") }).filter((incident) => incident.kind === "backup-failed");
  expect(recorded.map((incident) => incident.database)).toEqual(["state.sqlite"]);
  expect(recorded[0]?.message).toContain("There is no backup yet");
  runBackupPass(directory, new Map(), { now: new Date("2026-09-20T10:00:01Z") });
  expect(readStorageIncidents(directory, { now: new Date("2026-09-20T10:01:00Z") }).filter((incident) => incident.kind === "backup-failed")).toHaveLength(2);
});

test("a backup pass of a realistic database runs in the worker and leaves the Viewer's event loop free", async () => {
  const directory = sandbox();
  const database = stateDatabase(directory);
  const db = new Database(database.filename, { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE filler(body BLOB)");
    db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000) INSERT INTO filler SELECT randomblob(4000) FROM n");
  } finally {
    db.close();
  }
  expect(fs.statSync(database.filename).size).toBeGreaterThan(40_000_000);

  /* The same copy on this thread, for scale: what each request would wait. */
  const inline = performance.now();
  expect(backupDatabase(database, { backupDirectory: path.join(directory, "inline") }).state).toBe("taken");
  const inlineMs = performance.now() - inline;

  let worstDelayMs = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    worstDelayMs = Math.max(worstDelayMs, now - last - 5);
    last = now;
  }, 5);
  const lastRevisions = new Map<string, string>();
  const started = performance.now();
  const outcomes = await runBackupPassInWorker(directory, lastRevisions);
  const workerMs = performance.now() - started;
  clearInterval(probe);

  console.info(`[durability] backup of ${fs.statSync(database.filename).size} bytes: inline ${inlineMs.toFixed(0)} ms, `
    + `worker ${workerMs.toFixed(0)} ms with a worst event-loop delay of ${worstDelayMs.toFixed(1)} ms`);
  expect(outcomes.get("state.sqlite")?.state).toBe("taken");
  expect(lastRevisions.get("state.sqlite")).toBeString();
  expect(worstDelayMs).toBeLessThan(50);
}, 60_000);

test("a production store held across a fresh fallback writes into the new database, not the damaged one", () => {
  const directory = sandbox();
  const filename = path.join(directory, "handoff-queue.sqlite");
  const store = new SqliteHandoffQueueStore(filename);
  store.saveDrainingGenerations(["gen-before"]);
  checkpoint(filename);
  fs.writeFileSync(filename, Buffer.alloc(fs.statSync(filename).size, 0));

  const incidents = checkStateDatabasesAtActivation(directory, { now: new Date("2026-09-19T12:00:00Z") });
  expect(incidents.map((incident) => [incident.kind, incident.database])).toEqual([["database-fresh", "handoff-queue.sqlite"]]);

  store.saveDrainingGenerations(["gen-after"]);
  expect(store.loadDrainingGenerations()).toEqual(["gen-after"]);
  const fresh = new Database(filename, { readonly: true });
  try {
    expect(fresh.query("SELECT generation FROM handoff_draining_generations").all()).toEqual([{ generation: "gen-after" }]);
  } finally {
    fresh.close();
  }
  for (const name of incidents[0]!.corruptFiles) {
    expect(fs.readFileSync(path.join(directory, name)).includes("gen-after")).toBe(false);
  }
});
