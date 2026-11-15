import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  handoffParentConversation,
  handoffParentForChild,
  importLegacyHandoffLineage,
  persistHandoffLineage,
  rememberHandoffChild,
  resetHandoffLineageForTests,
} from "@/lib/handoffLineage";
import {
  checkpointLimitsHistoryRollbackMirrorForDemotion,
  historySamples,
  historySince,
  importLegacyLimitsHistory,
  readHistory,
  recordLimitSample,
  resetLimitsHistoryStoreForTests,
  RETENTION_S,
} from "@/lib/limitsHistoryStore";
import { readAuthorshipEvidence } from "@/lib/reaperAuthorship";
import {
  checkpointReaperStateRollbackMirrorForDemotion,
  importLegacyReaperState,
  readReaperStateDocument,
  recordReaperEvidence,
  resetReaperStateForTests,
} from "@/lib/reaperState";
import type { EngineLimits } from "@/lib/types";
import {
  checkpointHotStateRollbackMirrorsForDemotion,
  establishHotStateCutoverBoundary,
  initializeHotStateStoresAtStartup,
} from "@/lib/viewerInstrumentation";

import { fixtureTranscriptPath, FIXTURE_NOW, handoffLineageFixture, limitsHistoryFixture, reaperStateFixture } from "./histories.fixture";
import { HOT_STATE_BACKEND } from "./hotStateAuthority";
import { ensureLegacyCollectionsImported } from "./legacyCollections";
import { resetLegacyDocumentStoresForTests } from "./legacyDocumentStore";
import { readStateCollectionRevision, readStateImport } from "./sqliteStateStore";

/* #1870 slice 8, the histories: limits history, reaper evidence and handoff
   lineage move from whole-file JSON into keyed rows of `state.sqlite`. */

const saved = { state: process.env.LLV_STATE_DIR, port: process.env.PORT };
const roots: string[] = [];

afterEach(() => {
  resetLimitsHistoryStoreForTests();
  resetReaperStateForTests();
  resetHandoffLineageForTests();
  resetLegacyDocumentStoresForTests();
  if (saved.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = saved.state;
  if (saved.port === undefined) delete process.env.PORT; else process.env.PORT = saved.port;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-histories-"));
  roots.push(root);
  process.env.LLV_STATE_DIR = root;
  return root;
}

function seed(root: string, name: string, body: unknown): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Keys the collection's change log names at its current revision: what the
    last commit wrote. */
function lastCommitKeys(root: string, collection: string): string[] {
  const db = new Database(path.join(root, "state.sqlite"), { readonly: true });
  try {
    return db.query<{ row_key: string }, [string, string]>(`SELECT row_key FROM state_changes WHERE collection = ?
      AND revision = (SELECT revision FROM state_collections WHERE collection = ?) ORDER BY row_key`)
      .all(collection, collection).map((row) => row.row_key);
  } finally { db.close(); }
}

function limits(session: number, weekly: number): EngineLimits {
  return { session: { usedPercent: session, resetsAt: null }, weekly: { usedPercent: weekly, resetsAt: null }, plan: "pro", capturedAt: null };
}

async function runChild(root: string, code: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, LLV_STATE_DIR: root }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect([stdout, stderr, exit]).toEqual(["", "", 0]);
}

const libDir = path.resolve(import.meta.dir, "..");

test("limits history: a production-shaped file imports verified, every reader answers as before, and a sample rewrites only its series", () => {
  const root = sandbox();
  const body = limitsHistoryFixture();
  const file = seed(root, "limits-history.json", body);
  const series = Object.keys(body.series as object);

  // Before the import every reader reads the file, and nothing on the read path imports.
  const before = { history: readHistory(), since: historySince(), samples: series.map((key) => {
    const [engine, account, window] = key.split("|") as ["claude" | "codex", string, "session" | "weekly"];
    return historySamples(engine, account, window, FIXTURE_NOW);
  }) };
  expect(fs.statSync(file).isFile()).toBe(true);
  expect(readStateCollectionRevision(path.join(root, "state.sqlite"), "limits_history")).toBeNull();

  const outcome = importLegacyLimitsHistory(file);
  expect(outcome.state).toBe("imported");
  // One row per series and UTC day, the meta row and the three quarantined series.
  const dayRows = Object.values(body.series as Record<string, { t: number }[]>)
    .reduce((sum, samples) => sum + new Set(samples.map((sample) => Math.floor(sample.t / 86_400))).size, 0);
  expect([outcome.record.gap, outcome.record.rowCount]).toEqual([null, 1 + dayRows + 3]);
  expect(fs.statSync(file).isDirectory()).toBe(true);

  resetLimitsHistoryStoreForTests();
  expect(readHistory()).toEqual(before.history);
  expect(historySince()).toBe(before.since);
  expect(series.map((key) => {
    const [engine, account, window] = key.split("|") as ["claude" | "codex", string, "session" | "weekly"];
    return historySamples(engine, account, window, FIXTURE_NOW);
  })).toEqual(before.samples);

  // A poll inside the gap writes nothing; a due window writes its series alone.
  const revision = readStateCollectionRevision(path.join(root, "state.sqlite"), "limits_history");
  recordLimitSample("claude", "account-0", limits(10, 20), "live", (FIXTURE_NOW + 60) * 1000);
  expect(readStateCollectionRevision(path.join(root, "state.sqlite"), "limits_history")).toBe(revision);
  const session = limits(10, 20);
  session.weekly = null;
  recordLimitSample("claude", "account-0", session, "live", (FIXTURE_NOW + 300) * 1000);
  const today = String(Math.floor((FIXTURE_NOW + 300) / 86_400)).padStart(6, "0");
  expect(lastCommitKeys(root, "limits_history")).toEqual([`series:claude|account-0|session:${today}`]);
  expect(historySamples("claude", "account-0", "session", FIXTURE_NOW + 300).at(-1)).toEqual({ t: FIXTURE_NOW + 300, remaining: 90 });
  expect(readHistory().series["claude|account-0|session"]!.at(-1)).toEqual({ t: FIXTURE_NOW + 300, remaining: 90 });
});

test("limits history: a sample two days on deletes the days that left the window and trims the boundary day, as the file's pruning did", () => {
  const root = sandbox();
  const body = limitsHistoryFixture();
  const file = seed(root, "limits-history.json", body);
  importLegacyLimitsHistory(file);
  const later = FIXTURE_NOW + 2 * 86_400;
  const cutoff = later - RETENTION_S;
  const session = limits(25, 0);
  session.weekly = null;
  recordLimitSample("claude", "account-0", session, "live", later * 1000);
  const legacy = [...(body.series as Record<string, { t: number; remaining: number }[]>)["claude|account-0|session"]!, { t: later, remaining: 75 }]
    .filter((sample) => sample.t >= cutoff);
  expect(readHistory().series["claude|account-0|session"]).toEqual(legacy);
  const day = (t: number) => String(Math.floor(t / 86_400)).padStart(6, "0");
  const keys = lastCommitKeys(root, "limits_history");
  expect(keys).toContain(`series:claude|account-0|session:${day(later)}`);
  expect(keys).toContain(`series:claude|account-0|session:${day(cutoff)}`);
  expect(keys.every((key) => key.startsWith("series:claude|account-0|session:"))).toBe(true);
  // Untouched series keep their rows until their own next sample.
  expect(readHistory().series["claude|account-1|weekly"]).toEqual((body.series as Record<string, { t: number; remaining: number }[]>)["claude|account-1|weekly"]);
});

test("limits history: the rollback mirror carries the file shape, and samples the older release adds merge with SQLite's", () => {
  const root = sandbox();
  const file = seed(root, "limits-history.json", limitsHistoryFixture());
  importLegacyLimitsHistory(file);
  checkpointLimitsHistoryRollbackMirrorForDemotion(file);
  const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { series: Record<string, { t: number; remaining: number }[]>; since: string };
  expect(mirror).toEqual(JSON.parse(JSON.stringify(readHistory())));

  // The older release appends to the file while a new-code process appends to SQLite.
  mirror.series["claude|account-0|session"]!.push({ t: FIXTURE_NOW + 600, remaining: 42 });
  mirror.series["claude|account-9|weekly"] = [{ t: FIXTURE_NOW + 600, remaining: 50 }];
  fs.writeFileSync(file, JSON.stringify(mirror));
  const session = limits(70, 0);
  session.weekly = null;
  recordLimitSample("claude", "account-0", session, "live", (FIXTURE_NOW + 900) * 1000);

  expect(importLegacyLimitsHistory(file)).toMatchObject({ state: "already-imported", incident: { kind: "legacy-reconciled" } });
  expect(fs.statSync(file).isDirectory()).toBe(true);
  expect(historySamples("claude", "account-0", "session", FIXTURE_NOW + 900).slice(-2)).toEqual([
    { t: FIXTURE_NOW + 600, remaining: 42 }, { t: FIXTURE_NOW + 900, remaining: 30 },
  ]);
  expect(historySamples("claude", "account-9", "weekly", FIXTURE_NOW + 900)).toEqual([{ t: FIXTURE_NOW + 600, remaining: 50 }]);
});

test("reaper evidence: a production-shaped file imports verified, the board reads the same answers, and a cycle writes only its paths", () => {
  const root = sandbox();
  const body = reaperStateFixture() as { userAuthoredPaths: Record<string, true>; scannedAt: Record<string, number> };
  const file = seed(root, "reaper-state.json", body);
  const paths = [...new Set([...Object.keys(body.userAuthoredPaths), ...Object.keys(body.scannedAt), fixtureTranscriptPath(99_999)])];
  const answers = () => {
    const evidence = readAuthorshipEvidence();
    return paths.map((pathname) => [evidence.userAuthoredPaths.has(pathname), evidence.scannedAt.get(pathname)]);
  };
  const before = answers();
  expect(readStateCollectionRevision(path.join(root, "state.sqlite"), "reaper")).toBeNull();

  const outcome = importLegacyReaperState(file);
  expect([outcome.state, outcome.record.gap, outcome.record.rowCount]).toEqual(["imported", null, 19_538]);
  resetReaperStateForTests();
  expect(answers()).toEqual(before);
  expect(readReaperStateDocument()).toEqual({ userAuthoredPaths: body.userAuthoredPaths, scannedAt: body.scannedAt });

  // One authored path, one moved stamp and one new stamp: three rows, nothing else.
  const scanned = fixtureTranscriptPath(20_400);
  recordReaperEvidence({ authored: [fixtureTranscriptPath(20_500)], scanned: [[scanned, FIXTURE_NOW + 5], [fixtureTranscriptPath(99_998), FIXTURE_NOW]] });
  expect(lastCommitKeys(root, "reaper")).toEqual([
    `p:${fixtureTranscriptPath(20_400)}`, `p:${fixtureTranscriptPath(20_500)}`, `p:${fixtureTranscriptPath(99_998)}`,
  ].sort());
  const evidence = readAuthorshipEvidence();
  expect(evidence.userAuthoredPaths.has(fixtureTranscriptPath(20_500))).toBe(true);
  expect(evidence.scannedAt.get(fixtureTranscriptPath(20_500))).toBe(body.scannedAt[fixtureTranscriptPath(20_500)]);
  expect(evidence.scannedAt.get(scanned)).toBe(FIXTURE_NOW + 5);

  // Evidence that matches what is stored commits nothing.
  const revision = readStateCollectionRevision(path.join(root, "state.sqlite"), "reaper");
  recordReaperEvidence({ authored: [fixtureTranscriptPath(1)], scanned: [[scanned, FIXTURE_NOW + 5]] });
  expect(readStateCollectionRevision(path.join(root, "state.sqlite"), "reaper")).toBe(revision);
});

test("reaper evidence: another process's cycle is read here, and a rollback release's evidence merges back", async () => {
  const root = sandbox();
  const file = seed(root, "reaper-state.json", { version: 1, firstObservedAt: {}, userAuthoredPaths: { "/a": true }, scannedAt: { "/b": 100 } });
  importLegacyReaperState(file);
  expect(readAuthorshipEvidence().userAuthoredPaths.has("/peer")).toBe(false);
  await runChild(root, `const { recordReaperEvidence } = await import(${JSON.stringify(path.join(libDir, "reaperState.ts"))});`
    + `recordReaperEvidence({ authored: ["/peer"], scanned: [["/b", 200]] });`);
  const evidence = readAuthorshipEvidence();
  expect([evidence.userAuthoredPaths.has("/peer"), evidence.scannedAt.get("/b")]).toEqual([true, 200]);

  checkpointReaperStateRollbackMirrorForDemotion(file);
  const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number; firstObservedAt: object; userAuthoredPaths: Record<string, true>; scannedAt: Record<string, number> };
  expect(mirror).toEqual({ version: 1, firstObservedAt: {}, userAuthoredPaths: { "/a": true, "/peer": true }, scannedAt: { "/b": 200 } });
  // The older release rewrites its file whole each cycle; SQLite stamps a path meanwhile.
  fs.writeFileSync(file, JSON.stringify({ ...mirror, userAuthoredPaths: { ...mirror.userAuthoredPaths, "/old": true }, scannedAt: { "/b": 150, "/c": 300 } }));
  recordReaperEvidence({ authored: [], scanned: [["/d", 400]] });
  expect(importLegacyReaperState(file).state).toBe("already-imported");
  expect(readReaperStateDocument()).toEqual({
    userAuthoredPaths: { "/a": true, "/peer": true, "/old": true },
    scannedAt: { "/b": 200, "/d": 400, "/c": 300 },
  });
});

test("handoff lineage: a production-shaped file imports verified, edges one process records are read by another, and an edge a busy write missed is kept", async () => {
  const root = sandbox();
  const body = handoffLineageFixture() as { children: Record<string, string>; conversationChildren: Record<string, string> };
  const file = seed(root, "handoff-lineage.json", body);
  const before = Object.keys(body.children).map(handoffParentForChild);
  expect(importLegacyHandoffLineage(file)).toMatchObject({ state: "imported", record: { gap: null, rowCount: 1_088 } });
  resetHandoffLineageForTests();
  expect(Object.keys(body.children).map(handoffParentForChild)).toEqual(before);
  expect(handoffParentConversation("conversation_child-3")).toBe("conversation_parent-3");

  await runChild(root, `const lineage = await import(${JSON.stringify(path.join(libDir, "handoffLineage.ts"))});`
    + `lineage.rememberHandoffChild("/peer/child.jsonl", "/peer/parent.jsonl"); lineage.persistHandoffLineage();`);
  expect(handoffParentForChild("/peer/child.jsonl")).toBe("/peer/parent.jsonl");

  // The legacy store rewrote its whole file from this process's copy; a row write keeps the peer's edge.
  rememberHandoffChild("/here/child.jsonl", "/here/parent.jsonl");
  const db = new Database(path.join(root, "state.sqlite"));
  try {
    db.exec("BEGIN IMMEDIATE");
    persistHandoffLineage();
    db.exec("ROLLBACK");
  } finally { db.close(); }
  expect(handoffParentForChild("/here/child.jsonl")).toBe("/here/parent.jsonl");
  persistHandoffLineage();
  expect(lastCommitKeys(root, "handoff_lineage")).toEqual(["child:/here/child.jsonl"]);
  resetHandoffLineageForTests();
  expect([handoffParentForChild("/here/child.jsonl"), handoffParentForChild("/peer/child.jsonl")]).toEqual(["/here/parent.jsonl", "/peer/parent.jsonl"]);
});

test("handoff lineage: past 20,000 child edges the oldest fall out first", () => {
  const root = sandbox();
  const body = handoffLineageFixture(20_000) as { children: Record<string, string> };
  const file = seed(root, "handoff-lineage.json", body);
  importLegacyHandoffLineage(file);
  const oldest = Object.keys(body.children).slice(0, 2);
  rememberHandoffChild("/new/one.jsonl", "/new/parent.jsonl");
  rememberHandoffChild("/new/two.jsonl", "/new/parent.jsonl");
  persistHandoffLineage();
  expect(lastCommitKeys(root, "handoff_lineage")).toEqual([...oldest.map((child) => `child:${child}`), "child:/new/one.jsonl", "child:/new/two.jsonl"].sort());
  resetHandoffLineageForTests();
  expect(oldest.map(handoffParentForChild)).toEqual([null, null]);
  expect(handoffParentForChild(Object.keys(body.children)[2]!)).toBe(body.children[Object.keys(body.children)[2]!]!);
});

test("each store fails closed on torn bytes, and an older writer finds the tombstone", () => {
  const root = sandbox();
  for (const [name, importer] of [
    ["limits-history.json", importLegacyLimitsHistory],
    ["reaper-state.json", importLegacyReaperState],
    ["handoff-lineage.json", importLegacyHandoffLineage],
  ] as const) {
    const file = path.join(root, name);
    fs.writeFileSync(file, Buffer.from('{"partial":\u0000'));
    const outcome = importer(file);
    expect(outcome.record.gap).toBe("legacy-unreadable");
    expect(fs.existsSync(outcome.incident!.preservedAs!)).toBe(true);
    // An older release's writer: its read throws and its write fails on the directory.
    expect(() => fs.writeFileSync(file, "{}")).toThrow(/EISDIR/);
  }
  expect(readHistory().series).toEqual({});
  expect(readAuthorshipEvidence().scannedAt.get("/any")).toBeUndefined();
  expect(handoffParentForChild("/any")).toBeNull();
});

test("the release path: an unpromoted release reads the files and refuses writes, activation imports all three, demotion mirrors them back", async () => {
  const root = sandbox();
  const revision = "8".repeat(40);
  process.env.PORT = "19081";
  fs.writeFileSync(path.join(root, "viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:19081", revision, hotStateBackend: HOT_STATE_BACKEND }));
  const limitsFile = seed(root, "limits-history.json", { version: 1, codexAttributionVersion: 1, unattributedCodexSeries: {}, since: "2026-11-01T00:00:00.000Z", series: { "claude|a|weekly": [{ t: FIXTURE_NOW, remaining: 40 }] } });
  const reaperFile = seed(root, "reaper-state.json", { version: 1, firstObservedAt: {}, userAuthoredPaths: { "/a": true }, scannedAt: {} });
  const lineageFile = seed(root, "handoff-lineage.json", { panes: {}, children: { "/child": "/parent" }, conversationChildren: {} });

  expect(historySamples("claude", "a", "weekly", FIXTURE_NOW)).toEqual([{ t: FIXTURE_NOW, remaining: 40 }]);
  expect(readAuthorshipEvidence().userAuthoredPaths.has("/a")).toBe(true);
  expect(handoffParentForChild("/child")).toBe("/parent");
  expect(() => recordReaperEvidence({ authored: ["/b"], scanned: [] })).toThrow("waiting for release promotion");
  for (const file of [limitsFile, reaperFile, lineageFile]) expect(fs.statSync(file).isFile()).toBe(true);

  const boundary = await establishHotStateCutoverBoundary(() => true, {
    pollMs: 0, stablePolls: 1, maxPolls: 2, schedule: (callback) => { callback(); return { unref() {} }; },
  });
  await initializeHotStateStoresAtStartup(boundary);
  const outcomes = await ensureLegacyCollectionsImported();
  for (const collection of ["limits_history", "reaper", "handoff_lineage"]) {
    expect(outcomes.get(collection)).toMatchObject({ state: "imported" });
    expect(readStateImport(path.join(root, "state.sqlite"), collection)?.release).toBe(revision.slice(0, 12));
  }
  recordReaperEvidence({ authored: ["/b"], scanned: [] });
  rememberHandoffChild("/child-2", "/parent");
  persistHandoffLineage();

  await checkpointHotStateRollbackMirrorsForDemotion();
  expect(JSON.parse(fs.readFileSync(reaperFile, "utf8")).userAuthoredPaths).toEqual({ "/a": true, "/b": true });
  expect(JSON.parse(fs.readFileSync(lineageFile, "utf8")).children).toEqual({ "/child": "/parent", "/child-2": "/parent" });
  expect(JSON.parse(fs.readFileSync(limitsFile, "utf8")).series).toEqual({ "claude|a|weekly": [{ t: FIXTURE_NOW, remaining: 40 }] });

  const rolledForward = await ensureLegacyCollectionsImported();
  for (const collection of ["limits_history", "reaper", "handoff_lineage"]) {
    expect(rolledForward.get(collection)).toMatchObject({ state: "already-imported", incident: null });
  }
  for (const file of [limitsFile, reaperFile, lineageFile]) expect(fs.statSync(file).isDirectory()).toBe(true);
  expect(readAuthorshipEvidence().userAuthoredPaths.has("/b")).toBe(true);
});
