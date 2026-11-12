import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HOT_STATE_BACKEND } from "@/lib/state/hotStateAuthority";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";
import * as sqliteState from "@/lib/state/sqliteStateStore";
import {
  checkpointHotStateRollbackMirrorsForDemotion,
  establishHotStateCutoverBoundary,
  initializeHotStateStoresAtStartup,
} from "@/lib/viewerInstrumentation";

import {
  appendLifecycleEvents,
  importLegacyLifecycleJournal,
  LifecycleJournalCorruptError,
  LIFECYCLE_COLLECTION,
  lifecycleEventId,
  lifecycleJournalPath,
  queryLifecycleEvents,
  readLifecycleJournal,
  resetLifecycleJournalForTests,
  type LifecycleJournalFile,
} from "./journal";
import { productionShapedLifecycleJournal } from "./journal.fixture";

const saved = { state: process.env.LLV_STATE_DIR, port: process.env.PORT };
let sandbox = "";

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-lifecycle-store-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetLifecycleJournalForTests();
});

afterEach(() => {
  resetLifecycleJournalForTests();
  sqliteState.resetStateReadonlyReaderForTests();
  if (saved.state === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = saved.state;
  if (saved.port === undefined) delete process.env.PORT;
  else process.env.PORT = saved.port;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const event = (key: string) => ({ key, type: "stage_started" as const, at: "2026-11-12T08:00:00.000Z", project: "repo-synthetic-1", summary: key });

test("a production-shaped journal imports once and every reader answers as it did from the file", () => {
  const legacy = productionShapedLifecycleJournal();
  fs.writeFileSync(lifecycleJournalPath(), `${JSON.stringify(legacy, null, 2)}\n`);
  const before = plain(readLifecycleJournal());
  const queries = [{}, { project: "repo-synthetic-3" }, { pipelineId: "pipeline_000042" }, { afterSeq: legacy.lastSeq - 10, limit: 5 }, { conversationId: "conversation_00000007", type: "review_verdict" as const }];
  const pagesBefore = queries.map((query) => plain(queryLifecycleEvents(query)));

  expect(importLegacyLifecycleJournal()).toMatchObject({ state: "imported", record: { rowCount: 1 + 2_000 + 8_000 + 27 } });
  expect(fs.statSync(lifecycleJournalPath()).isDirectory()).toBe(true);
  expect(fs.readdirSync(sandbox).some((name) => name.startsWith("lifecycle-journal.json.imported-"))).toBe(true);
  expect(plain(readLifecycleJournal())).toEqual(before);
  expect(queries.map((query) => plain(queryLifecycleEvents(query)))).toEqual(pagesBefore);

  // A second import finds the record and does nothing.
  expect(importLegacyLifecycleJournal()).toMatchObject({ state: "already-imported", incident: null });

  /* Replays stay refused across the move: a retained event, an id the file had
     already retired, and a spawn failure whose event left long ago. */
  const retired = { key: "synthetic:retired:17", type: "stage_started" as const, at: "2026-11-12T08:00:00.000Z" };
  expect(lifecycleEventId(retired.key)).toBe(legacy.retired[17]!);
  expect(appendLifecycleEvents([
    { key: "synthetic:event:1483000", type: "stage_started", at: "2026-11-12T08:00:00.000Z" },
    retired,
    { key: "spawn:launch_synthetic_4:failed", type: "spawn_failed", at: "2026-11-12T08:00:00.000Z" },
  ])).toEqual({ appended: [], skipped: 3 });
  const next = appendLifecycleEvents([event("after import")]);
  expect(next.appended.map((row) => row.seq)).toEqual([legacy.lastSeq + 1]);
  const after = readLifecycleJournal();
  expect(after.events).toHaveLength(2_000);
  expect(after.events.at(-1)!.id).toBe(lifecycleEventId("after import"));
  expect(after.retired).toHaveLength(8_000);
  expect(after.retired.at(-1)).toBe(legacy.events[0]!.id);
});

test("a replay of an event trimmed out of the bounded history is still refused", () => {
  appendLifecycleEvents([event("first transition")]);
  for (let batch = 0; batch < 3; batch += 1) {
    appendLifecycleEvents(Array.from({ length: 1_000 }, (_, index) => event(`filler:${batch}:${index}`)));
  }
  const journal = readLifecycleJournal();
  expect(journal.events.some((row) => row.id === lifecycleEventId("first transition"))).toBe(false);
  expect(journal.retired).toContain(lifecycleEventId("first transition"));
  const head = journal.lastSeq;
  expect(appendLifecycleEvents([event("first transition")])).toEqual({ appended: [], skipped: 1 });
  expect(readLifecycleJournal().lastSeq).toBe(head);
});

test("an unchanged journal is answered without reading a row; an append costs the rows it wrote", () => {
  fs.writeFileSync(lifecycleJournalPath(), JSON.stringify(productionShapedLifecycleJournal()));
  importLegacyLifecycleJournal();
  readLifecycleJournal();
  const selections = spyOn(sqliteState, "readStateCollectionSelection");
  const changes = spyOn(sqliteState.SqliteStateCollection.prototype, "changesAfter");
  try {
    const first = readLifecycleJournal();
    for (let read = 0; read < 200; read += 1) expect(readLifecycleJournal()).toBe(first);
    expect(selections).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();

    appendLifecycleEvents([event("one more")]);
    const changed = readLifecycleJournal();
    expect(changed).not.toBe(first);
    expect(changed.events.at(-1)!.id).toBe(lifecycleEventId("one more"));
    expect(selections).not.toHaveBeenCalled();
    const applied = changes.mock.results.flatMap((result) => (result.value as sqliteState.ChangeLogPage).entries.map((entry) => entry.key.split(":")[0]));
    /* The event in, the oldest event turned into a retired id, the oldest
       retired id beyond its bound out, and the head. */
    expect(applied.sort()).toEqual(["e", "e", "meta", "x", "x"]);
  } finally {
    selections.mockRestore();
    changes.mockRestore();
  }
});

test("an append in another process is read here, and one made here is read there", () => {
  appendLifecycleEvents([event("parent first")]);
  expect(readLifecycleJournal().events).toHaveLength(1);
  const journalModule = JSON.stringify(path.join(import.meta.dir, "journal.ts"));
  const child = spawnSync(process.execPath, ["-e", `
    const { appendLifecycleEvents, readLifecycleJournal } = await import(${journalModule});
    const seen = readLifecycleJournal().events.length;
    const { appended } = appendLifecycleEvents([{ key: "child", type: "stage_completed", at: "2026-11-12T08:01:00.000Z" }]);
    console.log(JSON.stringify({ seen, seq: appended[0].seq }));
  `], { env: { ...process.env }, encoding: "utf8", timeout: 30_000 });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout.trim().split("\n").at(-1)!)).toEqual({ seen: 1, seq: 2 });
  expect(readLifecycleJournal().events.map((row) => row.id)).toEqual([lifecycleEventId("parent first"), lifecycleEventId("child")]);
  expect(appendLifecycleEvents([event("parent second")]).appended[0]!.seq).toBe(3);
});

/* The release path (#1870 §6.4): an unpromoted release reads the legacy file
   and refuses writes, the activation imports, the demotion checkpoint writes
   the rollback mirror, and what the older release appended folds back in. */
async function activate(revision: string, port: string): Promise<void> {
  process.env.PORT = port;
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, revision, hotStateBackend: HOT_STATE_BACKEND }));
  const boundary = await establishHotStateCutoverBoundary(() => true, {
    pollMs: 0, stablePolls: 1, maxPolls: 2, schedule: (callback) => { callback(); return { unref() {} }; },
  });
  await initializeHotStateStoresAtStartup(boundary);
}

test("the rollback mirror carries the journal to an older release, and its appends fold back in", async () => {
  const revision = "5".repeat(40);
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:19091", revision, hotStateBackend: HOT_STATE_BACKEND }));
  process.env.PORT = "19091";
  const legacy: LifecycleJournalFile = { version: 1, lastSeq: 40, events: [], retired: [lifecycleEventId("long gone")], spawnFailureKeys: [] };
  fs.writeFileSync(lifecycleJournalPath(), JSON.stringify(legacy));

  // Unpromoted: the file is the journal, and an append waits for promotion.
  expect(readLifecycleJournal().lastSeq).toBe(40);
  expect(() => appendLifecycleEvents([event("early")])).toThrow("waiting for release promotion");
  expect(fs.statSync(lifecycleJournalPath()).isFile()).toBe(true);

  await activate(revision, "19091");
  expect((await ensureLegacyCollectionsImported()).get(LIFECYCLE_COLLECTION)).toMatchObject({ state: "imported" });
  expect(appendLifecycleEvents([event("after import")]).appended[0]!.seq).toBe(41);

  await checkpointHotStateRollbackMirrorsForDemotion();
  const mirror = JSON.parse(fs.readFileSync(lifecycleJournalPath(), "utf8")) as LifecycleJournalFile;
  expect(mirror).toEqual(plain(readLifecycleJournal()));

  // An untouched mirror is recognized at roll-forward and retired.
  expect((await ensureLegacyCollectionsImported()).get(LIFECYCLE_COLLECTION)).toMatchObject({ state: "already-imported", incident: null });
  expect(fs.statSync(lifecycleJournalPath()).isDirectory()).toBe(true);

  /* Demoted again, the older release appends two events and retires an id,
     rewriting the whole file the way it always did. */
  await checkpointHotStateRollbackMirrorsForDemotion();
  const older = JSON.parse(fs.readFileSync(lifecycleJournalPath(), "utf8")) as LifecycleJournalFile;
  for (const key of ["older one", "older two"]) {
    older.lastSeq += 1;
    older.events.push({ ...plain(readLifecycleJournal().events[0]!), id: lifecycleEventId(key), seq: older.lastSeq, summary: key });
  }
  older.retired.push(lifecycleEventId("retired by the older release"));
  fs.writeFileSync(lifecycleJournalPath(), JSON.stringify(older));

  const rolledForward = (await ensureLegacyCollectionsImported()).get(LIFECYCLE_COLLECTION);
  expect(rolledForward).toMatchObject({ state: "already-imported", incident: { kind: "legacy-reconciled", summary: { added: 3, removed: 0 } } });
  expect(fs.statSync(lifecycleJournalPath()).isDirectory()).toBe(true);
  const merged = readLifecycleJournal();
  expect(merged.events.map((row) => [row.summary, row.seq])).toEqual([["after import", 41], ["older one", 42], ["older two", 43]]);
  expect(merged.lastSeq).toBe(43);
  expect(merged.retired).toEqual([lifecycleEventId("long gone"), lifecycleEventId("retired by the older release")]);
  expect(appendLifecycleEvents([event("older one")])).toEqual({ appended: [], skipped: 1 });
  expect(appendLifecycleEvents([event("next")]).appended[0]!.seq).toBe(44);
});

test("events an older writer numbered below the head are numbered again after it, in their order", () => {
  appendLifecycleEvents([event("first"), event("second")]);
  /* A file written from the journal at seq 1, to which an older writer added
     two events while this release appended its second one. */
  const file: LifecycleJournalFile = {
    version: 1, lastSeq: 3,
    events: [
      { ...plain(readLifecycleJournal().events[0]!) },
      { ...plain(readLifecycleJournal().events[0]!), id: lifecycleEventId("older a"), seq: 2, summary: "older a" },
      { ...plain(readLifecycleJournal().events[0]!), id: lifecycleEventId("older b"), seq: 3, summary: "older b" },
    ],
    retired: [], spawnFailureKeys: [],
  };
  fs.rmSync(lifecycleJournalPath(), { recursive: true, force: true });
  fs.writeFileSync(lifecycleJournalPath(), JSON.stringify(file));
  expect(importLegacyLifecycleJournal()).toMatchObject({ incident: { kind: "legacy-reconciled", summary: { added: 2, kept: 1 } } });
  expect(readLifecycleJournal().events.map((row) => [row.summary, row.seq])).toEqual([["first", 1], ["second", 2], ["older a", 4], ["older b", 5]]);
  expect(appendLifecycleEvents([event("next")]).appended[0]!.seq).toBe(6);
});

test("an older release finds a directory where the journal was, and a damaged stored row stops every reader", () => {
  appendLifecycleEvents([event("stored")]);
  // What every older reader and writer does first.
  expect(() => fs.readFileSync(lifecycleJournalPath(), "utf8")).toThrow(/EISDIR/);
  expect(fs.readFileSync(path.join(lifecycleJournalPath(), "README"), "utf8")).toContain(LIFECYCLE_COLLECTION);

  const db = new Database(path.join(sandbox, "state.sqlite"));
  try {
    db.query("UPDATE state_rows SET value_json = ? WHERE collection = ? AND row_key = ?")
      .run(JSON.stringify({ key: `e:${lifecycleEventId("stored")}`, value: { id: "torn" } }), LIFECYCLE_COLLECTION, `e:${lifecycleEventId("stored")}`);
  } finally { db.close(); }
  resetLifecycleJournalForTests();
  expect(() => readLifecycleJournal()).toThrow(LifecycleJournalCorruptError);
  expect(() => queryLifecycleEvents({})).toThrow(/recorded event .* is malformed/);
});
