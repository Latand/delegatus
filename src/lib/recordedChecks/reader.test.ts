import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { readRecorded, recordedRootHeld } from "./store";

let root = "", priorState: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "recorded-reader-"));
  priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = root;
});
afterEach(() => {
  if (priorState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = priorState;
  fs.rmSync(root, { recursive: true, force: true });
});

function ledger(filename: string, held: string[] = []) {
  const db = new Database(filename, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE IF NOT EXISTS recorded_checks(id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS recorded_check_roots(directory TEXT NOT NULL,id TEXT NOT NULL,identity TEXT NOT NULL,retirement TEXT,held INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(directory,id))");
  for (const directory of held) db.query("INSERT INTO recorded_check_roots(directory,id,identity) VALUES(?,?,?)").run(directory, "run", "identity");
  return db;
}

test("one connection answers successive questions and sees later commits", () => {
  const writer = ledger(path.join(root, "state.sqlite"));
  try {
    const first = readRecorded(store => store, null);
    expect(first).not.toBeNull();
    expect(recordedRootHeld("/work/a")).toBe(false);
    writer.query("INSERT INTO recorded_check_roots(directory,id,identity) VALUES(?,?,?)").run("/work/a", "run", "identity");
    expect(recordedRootHeld("/work/a")).toBe(true);
    expect(readRecorded(store => store, null)).toBe(first);
  } finally { writer.close(); }
});

test("a replaced state file is read through a new connection", () => {
  const filename = path.join(root, "state.sqlite");
  ledger(filename, ["/work/old"]).close();
  const first = readRecorded(store => store, null);
  expect(recordedRootHeld("/work/old")).toBe(true);
  const staged = path.join(root, "staged.sqlite");
  ledger(staged, ["/work/new"]).close();
  fs.renameSync(staged, filename);
  fs.rmSync(`${filename}-wal`, { force: true });
  fs.rmSync(`${filename}-shm`, { force: true });
  expect(recordedRootHeld("/work/old")).toBe(false);
  expect(recordedRootHeld("/work/new")).toBe(true);
  expect(readRecorded(store => store, null)).not.toBe(first);
});

test("a missing file and a state file without the ledger read as absent", () => {
  expect(readRecorded(store => store.rootHeld("/work/a"), "absent")).toBe("absent");
  const plain = new Database(path.join(root, "state.sqlite"), { create: true });
  plain.exec("CREATE TABLE unrelated(id INTEGER)");
  plain.close();
  expect(readRecorded(store => store.rootHeld("/work/a"), "absent")).toBe("absent");
  ledger(path.join(root, "state.sqlite"), ["/work/a"]).close();
  expect(readRecorded(store => store.rootHeld("/work/a"), "absent")).toBe(true);
});

test("a failed read closes the connection it used", () => {
  ledger(path.join(root, "state.sqlite")).close();
  const first = readRecorded(store => store, null);
  expect(() => readRecorded(() => { throw new Error("reader failed"); }, null)).toThrow("reader failed");
  expect(readRecorded(store => store, null)).not.toBe(first);
});
