import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetJournalCollectionsForTests } from "@/lib/state/journalCollection";
import * as sqliteState from "@/lib/state/sqliteStateStore";

import {
  appendSeatTickRecord,
  checkpointSeatTickJournalRollbackMirrorForDemotion,
  importLegacySeatTickJournal,
  readSeatTickAlarmRecords,
  readSeatTickRecords,
  sanitizeSeatTickRecord,
  SEAT_TICK_RUN_HISTORY,
  SEAT_TICK_RUNS_COLLECTION,
  seatTickJournalPath,
} from "./journalStore";
import { seatTickProjectName, writeLegacySeatTickRings } from "./journalStore.fixture";
import type { SeatTickRunRecord } from "./types";

const saved = process.env.LLV_STATE_DIR;
let sandbox = "";

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-store-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetJournalCollectionsForTests();
});

afterEach(() => {
  resetJournalCollectionsForTests();
  sqliteState.resetStateReadonlyReaderForTests();
  if (saved === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = saved;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const SHAPE = { checks: [40, 620, 540, 12, 700, 90], phases: 30, withoutProjectFile: [3] };
const PROJECTS = SHAPE.checks.map((_, index) => seatTickProjectName(index));

function check(project: string, detail: string): SeatTickRunRecord {
  return { schemaVersion: 1, at: "2026-11-12T09:00:00.000Z", project, seatEpoch: 1, verdict: "quiet", reasons: [], items: 0, deferred: 0, eventsThrough: 0, delivery: null, detail };
}

/** Every reader's answer, for comparing the legacy rings with the store. */
function answers(file: string) {
  return {
    global: readSeatTickRecords(SEAT_TICK_RUN_HISTORY, file),
    newest: readSeatTickRecords(7, file),
    projects: PROJECTS.map((project) => readSeatTickRecords(SEAT_TICK_RUN_HISTORY, file, project)),
    alarms: PROJECTS.map((project) => readSeatTickAlarmRecords(SEAT_TICK_RUN_HISTORY, file, project)),
    tails: PROJECTS.map((project) => readSeatTickAlarmRecords(3, file, project)),
  };
}

function changedRows(revision: number): string[] {
  const db = new Database(path.join(sandbox, "state.sqlite"), { readonly: true });
  try {
    return db.query<{ row_key: string; operation: string }, [string, number]>(
      "SELECT row_key, operation FROM state_changes WHERE collection = ? AND revision = ? ORDER BY row_key",
    ).all(SEAT_TICK_RUNS_COLLECTION, revision).map((row) => `${row.operation} ${row.row_key.split(":")[0]}`);
  } finally { db.close(); }
}

test("both legacy rings import once and every reader answers as it did from the files", () => {
  const file = seatTickJournalPath();
  writeLegacySeatTickRings(file, SHAPE);
  const before = answers(file);
  expect(before.projects[3]!.length).toBeGreaterThan(0);

  expect(importLegacySeatTickJournal(file)).toMatchObject({ state: "imported" });
  expect(fs.statSync(file).isDirectory()).toBe(true);
  expect(fs.existsSync(`${file}.projects`)).toBe(false);
  expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".imported-")).length).toBe(2);
  expect(answers(file)).toEqual(before);
  expect(importLegacySeatTickJournal(file)).toMatchObject({ state: "already-imported", incident: null });

  /* Each check is stored once: the global ring's lines are its projects'
     newest, and the import does not count them twice. */
  const db = new Database(path.join(sandbox, "state.sqlite"), { readonly: true });
  try {
    const runs = db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM state_rows WHERE collection = ? AND row_key LIKE 'r:%'").get(SEAT_TICK_RUNS_COLLECTION)!.count;
    const expected = SHAPE.checks.reduce((sum, checks, index) => sum + (index === 3 ? 0 : Math.min(checks, SEAT_TICK_RUN_HISTORY)), 0)
      + before.global.filter((row) => row.project === PROJECTS[3]).length;
    expect(runs).toBe(expected);
  } finally { db.close(); }
});

test("an append writes its check, its timing and the head, plus what left both rings", () => {
  const file = seatTickJournalPath();
  writeLegacySeatTickRings(file, SHAPE);
  importLegacySeatTickJournal(file);
  const database = path.join(sandbox, "state.sqlite");

  // A project far below its bound: nothing is past either ring once this lands.
  appendSeatTickRecord({ ...check(PROJECTS[3]!, "small project"), timing: readSeatTickRecords(1, file, PROJECTS[1]!)[0]!.timing }, file);
  const small = changedRows(sqliteState.readStateCollectionRevision(database, SEAT_TICK_RUNS_COLLECTION)!);
  /* The global ring was full: its oldest check leaves, and so does the
     project check it pushed out, when its own project keeps no more of it. */
  expect(small.filter((row) => row.startsWith("upsert")).sort()).toEqual(["upsert meta", "upsert r", "upsert t"]);
  expect(small.filter((row) => row.startsWith("delete")).length).toBeLessThanOrEqual(2);

  // A project at its bound: its oldest check leaves with its timing.
  const fullBefore = readSeatTickRecords(SEAT_TICK_RUN_HISTORY, file, PROJECTS[4]!);
  appendSeatTickRecord({ ...check(PROJECTS[4]!, "full project"), timing: fullBefore.at(-1)!.timing }, file);
  const full = changedRows(sqliteState.readStateCollectionRevision(database, SEAT_TICK_RUNS_COLLECTION)!);
  expect(full.sort()).toEqual(["delete r", "delete t", "upsert meta", "upsert r", "upsert t"]);
  const fullAfter = readSeatTickRecords(SEAT_TICK_RUN_HISTORY, file, PROJECTS[4]!);
  expect(fullAfter).toHaveLength(SEAT_TICK_RUN_HISTORY);
  expect(fullAfter.slice(0, -1)).toEqual(fullBefore.slice(1));
  expect(fullAfter.at(-1)!.detail).toBe("full project");
  expect(readSeatTickRecords(1, file)[0]!.detail).toBe("full project");
});

test("a check stays while either ring keeps it, and leaves when neither does", () => {
  const file = path.join(sandbox, "rings.ndjson");
  for (let index = 0; index < 3; index += 1) appendSeatTickRecord(check("quiet-project", `quiet ${index}`), file);
  for (let index = 0; index < SEAT_TICK_RUN_HISTORY + 10; index += 1) appendSeatTickRecord(check("busy-project", `busy ${index}`), file);
  // The global ring moved past the quiet project's checks; its own ring keeps them.
  expect(readSeatTickRecords(SEAT_TICK_RUN_HISTORY, file).some((row) => row.project === "quiet-project")).toBe(false);
  expect(readSeatTickRecords(SEAT_TICK_RUN_HISTORY, file, "quiet-project").map((row) => row.detail)).toEqual(["quiet 0", "quiet 1", "quiet 2"]);
  const busy = readSeatTickRecords(SEAT_TICK_RUN_HISTORY + 10, file, "busy-project");
  expect(busy).toHaveLength(SEAT_TICK_RUN_HISTORY);
  expect(busy[0]!.detail).toBe("busy 10");
  const db = new Database(path.join(sandbox, "state.sqlite"), { readonly: true });
  try {
    const stored = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM state_rows WHERE collection LIKE 'seat_tick_runs:%' AND row_key LIKE 'r:%'").get()!.count;
    expect(stored).toBe(SEAT_TICK_RUN_HISTORY + 3);
  } finally { db.close(); }
}, 120_000);

test("the alarm reader never reads a timing row", () => {
  const file = seatTickJournalPath();
  writeLegacySeatTickRings(file, SHAPE);
  importLegacySeatTickJournal(file);
  const pages = spyOn(sqliteState, "readStateRowsPage");
  try {
    const rows = readSeatTickAlarmRecords(SEAT_TICK_RUN_HISTORY, file, PROJECTS[2]!);
    expect(rows).toHaveLength(SEAT_TICK_RUN_HISTORY);
    expect(rows.every((row) => row.timing === undefined)).toBe(true);
    expect(pages).toHaveBeenCalledTimes(1);
    expect(pages.mock.calls[0]![2]).not.toHaveProperty("companion");
    expect(readSeatTickRecords(1, file, PROJECTS[2]!)[0]!.timing?.phases.length).toBe(30);
  } finally { pages.mockRestore(); }
});

test("the rollback mirror writes both rings, and what an older release appends folds back in once", () => {
  const file = seatTickJournalPath();
  writeLegacySeatTickRings(file, SHAPE);
  importLegacySeatTickJournal(file);
  appendSeatTickRecord(check(PROJECTS[1]!, "after import"), file);
  const stored = answers(file);

  checkpointSeatTickJournalRollbackMirrorForDemotion(file);
  expect(fs.statSync(file).isFile()).toBe(true);
  expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(SEAT_TICK_RUN_HISTORY);
  /* The mirror is what the legacy readers read: the global ring, and one ring
     per project, every line as the store answers it. */
  const ring = (target: string) => fs.readFileSync(target, "utf8").trim().split("\n").map((line) => sanitizeSeatTickRecord(JSON.parse(line)));
  expect(ring(file)).toEqual(stored.global);
  PROJECTS.forEach((project, index) => {
    const own = path.join(`${file}.projects`, `${crypto.createHash("sha256").update(project).digest("hex")}.ndjson`);
    expect(stored.projects[index]!.length).toBeGreaterThan(0);
    expect(ring(own)).toEqual(stored.projects[index]!);
  });

  // An untouched mirror is retired at roll-forward, rings and all.
  expect(importLegacySeatTickJournal(file)).toMatchObject({ state: "already-imported", incident: null });
  expect(fs.statSync(file).isDirectory()).toBe(true);
  expect(fs.existsSync(`${file}.projects`)).toBe(false);
  expect(answers(file)).toEqual(stored);

  /* Demoted again, the older release appends one check to both rings the way
     it always did. */
  checkpointSeatTickJournalRollbackMirrorForDemotion(file);
  const line = `${JSON.stringify(check(PROJECTS[2]!, "older release"))}\n`;
  fs.appendFileSync(file, line);
  const projectFile = fs.readdirSync(`${file}.projects`).map((name) => path.join(`${file}.projects`, name))
    .find((candidate) => fs.readFileSync(candidate, "utf8").includes(`"project":"${PROJECTS[2]}"`))!;
  fs.appendFileSync(projectFile, line);

  expect(importLegacySeatTickJournal(file)).toMatchObject({ state: "already-imported", incident: { kind: "legacy-reconciled", summary: { added: 1, removed: 0 } } });
  expect(fs.statSync(file).isDirectory()).toBe(true);
  const own = readSeatTickRecords(SEAT_TICK_RUN_HISTORY + 1, file, PROJECTS[2]!);
  expect(own.filter((row) => row.detail === "older release")).toHaveLength(1);
  expect(readSeatTickRecords(1, file)[0]!.detail).toBe("older release");
  appendSeatTickRecord(check(PROJECTS[2]!, "rolled forward"), file);
  expect(readSeatTickRecords(2, file, PROJECTS[2]!).map((row) => row.detail)).toEqual(["older release", "rolled forward"]);
});

test("an import that stopped after its commit finishes on the next pass and retires both rings once", () => {
  const file = seatTickJournalPath();
  writeLegacySeatTickRings(file, SHAPE);
  const before = answers(file);
  expect(() => importLegacySeatTickJournal(file, { reconcile: true, hooks: { afterCommit: () => { throw new Error("stopped after commit"); } } }))
    .toThrow("stopped after commit");
  // Committed, so readers already answer from the store, and the files still stand.
  expect(fs.statSync(file).isFile()).toBe(true);
  expect(fs.statSync(`${file}.projects`).isDirectory()).toBe(true);
  expect(answers(file)).toEqual(before);

  expect(importLegacySeatTickJournal(file)).toMatchObject({ state: "already-imported", incident: null });
  expect(fs.statSync(file).isDirectory()).toBe(true);
  expect(fs.existsSync(`${file}.projects`)).toBe(false);
  const kept = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".imported-")).sort();
  expect(kept).toHaveLength(2);
  expect(answers(file)).toEqual(before);
  // An older writer meets the tombstone before any line counts as journaled.
  expect(() => fs.appendFileSync(file, "{}\n")).toThrow(/EISDIR/);
});

test("in the Viewer an async append runs on the journal worker thread, and the Viewer thread reads what it wrote", async () => {
  const { seatTickJournalWorkersStartedForTests, stopSeatTickJournalWorkerForTests } = await import("./seatTickJournalWorker");
  const { appendSeatTickRecordAsync } = await import("./journalStore");
  const file = seatTickJournalPath();
  const previous = process.env.LLV_SEAT_TICK_JOURNAL_WORKER;
  process.env.LLV_SEAT_TICK_JOURNAL_WORKER = "1";
  const started = seatTickJournalWorkersStartedForTests();
  try {
    await appendSeatTickRecordAsync(check("repo-a", "first"), file);
    await Promise.all([appendSeatTickRecordAsync(check("repo-a", "second"), file), appendSeatTickRecordAsync(check("repo-b", "third"), file)]);
    expect(seatTickJournalWorkersStartedForTests()).toBe(started + 1);
    expect(readSeatTickRecords(10, file, "repo-a").map((row) => row.detail)).toEqual(["first", "second"]);
    expect(readSeatTickRecords(10, file).map((row) => row.detail).sort()).toEqual(["first", "second", "third"]);
    // A record no reader would show is refused there as it is here.
    await appendSeatTickRecordAsync({ ...check("repo-a", "bad"), verdict: "nonsense" } as unknown as SeatTickRunRecord, file);
    expect(readSeatTickRecords(10, file, "repo-a")).toHaveLength(2);
  } finally {
    await stopSeatTickJournalWorkerForTests();
    if (previous === undefined) delete process.env.LLV_SEAT_TICK_JOURNAL_WORKER;
    else process.env.LLV_SEAT_TICK_JOURNAL_WORKER = previous;
  }
});
