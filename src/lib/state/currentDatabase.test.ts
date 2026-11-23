import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DatabaseReplacedError, databaseSwapInProgress, databaseSwapMarker, openCurrentDatabase } from "./currentDatabase";
import { stateDatabaseSignature } from "./sqliteStateStore";

function fixture(run: (filename: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "current-database-"));
  const filename = path.join(root, "state.sqlite");
  const seed = new Database(filename, { create: true });
  seed.exec("CREATE TABLE notes (text TEXT NOT NULL); INSERT INTO notes VALUES ('first')");
  seed.close();
  try { run(filename); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("a swap is under way only while a fresh marker stands beside the database", () => fixture(filename => {
  const marker = databaseSwapMarker(filename);
  const db = openCurrentDatabase(filename, () => new Database(filename));
  try {
    expect(databaseSwapInProgress(filename)).toBe(false);
    expect(db.query("SELECT text FROM notes").all()).toEqual([{ text: "first" }]);

    fs.writeFileSync(marker, "");
    expect(databaseSwapInProgress(filename)).toBe(true);
    expect(() => db.query("SELECT text FROM notes").all()).toThrow(DatabaseReplacedError);

    /* A marker left by a swap that died stops counting after ten minutes. */
    const old = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(marker, old, old);
    expect(databaseSwapInProgress(filename)).toBe(false);
    expect(db.query("SELECT text FROM notes").all()).toEqual([{ text: "first" }]);

    fs.rmSync(marker);
    expect(databaseSwapInProgress(filename)).toBe(false);
  } finally { db.close(); }
}));

test("the database signature names a missing file and moves with a write", () => fixture(filename => {
  expect(stateDatabaseSignature(filename)).toContain("state.sqlite-wal:missing");
  expect(stateDatabaseSignature(path.join(path.dirname(filename), "absent.sqlite"))).toContain("absent.sqlite:missing");
  const before = stateDatabaseSignature(filename);
  expect(stateDatabaseSignature(filename)).toBe(before);
  const db = new Database(filename);
  db.exec("INSERT INTO notes VALUES ('a second note that makes the file longer')");
  db.close();
  expect(stateDatabaseSignature(filename)).not.toBe(before);
}));
