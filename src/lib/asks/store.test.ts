import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HOT_STATE_BACKEND } from "@/lib/state/hotStateAuthority";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";
import { readStateImport, resetStateReadonlyReaderForTests } from "@/lib/state/sqliteStateStore";
import {
  checkpointHotStateRollbackMirrorsForDemotion,
  establishHotStateCutoverBoundary,
  initializeHotStateStoresAtStartup,
} from "@/lib/viewerInstrumentation";

import {
  loadOperatorAsks,
  mutateOperatorAsks,
  OPERATOR_ASKS_COLLECTION,
  operatorAsksSignature,
  readOperatorAsks,
  resetOperatorAsksStoreForTests,
  type OperatorAsksFileV1,
} from "./store";
import { syntheticOperatorAsks } from "./store.fixture";

const NOW = new Date("2026-11-12T12:00:00Z");
const saved = { state: process.env.LLV_STATE_DIR, port: process.env.PORT };
let sandbox = "";

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-operator-asks-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetOperatorAsksStoreForTests();
});

afterEach(() => {
  resetOperatorAsksStoreForTests();
  resetStateReadonlyReaderForTests();
  if (saved.state === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = saved.state;
  if (saved.port === undefined) delete process.env.PORT;
  else process.env.PORT = saved.port;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const asksFile = () => path.join(sandbox, "operator-asks.json");

/** Each stored row's revision, read through a connection of the test's own. */
function rowRevisions(): Map<string, number> {
  const db = new Database(path.join(sandbox, "state.sqlite"), { readonly: true });
  try {
    return new Map(db.query<{ row_key: string; row_revision: number }, [string]>(
      "SELECT row_key, row_revision FROM state_rows WHERE collection = ?",
    ).all(OPERATOR_ASKS_COLLECTION).map((row) => [row.row_key, row.row_revision]));
  } finally { db.close(); }
}

function changedRows(before: Map<string, number>): string[] {
  const after = rowRevisions();
  return [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).sort();
}

test("a production-shaped store imports once, verified, and reads back as the legacy file read", () => {
  const legacy = syntheticOperatorAsks(NOW);
  fs.writeFileSync(asksFile(), JSON.stringify(legacy));
  expect(loadOperatorAsks(asksFile(), NOW)).toEqual(legacy);

  mutateOperatorAsks(() => {}, NOW, asksFile());

  expect(fs.statSync(asksFile()).isDirectory()).toBe(true);
  expect(readStateImport(path.join(sandbox, "state.sqlite"), OPERATOR_ASKS_COLLECTION)).toMatchObject({ rowCount: 1 + 1_000 + 5_000 + 5_000, gap: null });
  // The store's own revision continues from the file's.
  expect(readOperatorAsks(asksFile(), NOW)).toEqual({ ...legacy, revision: legacy.revision + 1 });
});

test("a spend settlement writes the meta row alone; a send writes its seen key; the trims drop the oldest rows", () => {
  const legacy = syntheticOperatorAsks(NOW);
  fs.writeFileSync(asksFile(), JSON.stringify(legacy));
  mutateOperatorAsks(() => {}, NOW, asksFile());

  let before = rowRevisions();
  mutateOperatorAsks((file) => { file.spend.usd += 0.0004; }, NOW, asksFile());
  expect(changedRows(before)).toEqual(["meta"]);

  before = rowRevisions();
  mutateOperatorAsks((file) => { file.seen.push("conversation-new:claude:message-new"); file.spend.calls += 1; }, NOW, asksFile());
  /* At capacity: the new key goes in and the oldest goes out. */
  expect(changedRows(before)).toEqual(["meta", `seen:${legacy.seen[0]}`, "seen:conversation-new:claude:message-new"].sort());
  const seen = readOperatorAsks(asksFile(), NOW).seen;
  expect(seen).toHaveLength(5_000);
  expect(seen.at(-1)).toBe("conversation-new:claude:message-new");

  // A text scored again moves to the end, so the next trim keeps it.
  const oldest = Object.keys(legacy.scores)[0]!;
  mutateOperatorAsks((file) => { delete file.scores[oldest]; file.scores[oldest] = 0.99; }, NOW, asksFile());
  mutateOperatorAsks((file) => { file.scores["f".repeat(64)] = 0.5; }, NOW, asksFile());
  const scores = Object.keys(readOperatorAsks(asksFile(), NOW).scores);
  expect(scores).toHaveLength(5_000);
  expect(scores.slice(-2)).toEqual([oldest, "f".repeat(64)]);
  expect(scores).not.toContain(Object.keys(legacy.scores)[1]);

  const ask = { ...legacy.asks[0]!, id: "ask-new", messageAt: NOW.getTime() };
  before = rowRevisions();
  mutateOperatorAsks((file) => { file.asks.push(ask); }, NOW, asksFile());
  expect(changedRows(before)).toEqual(["ask:ask-new", `ask:${legacy.asks[0]!.id}`, "meta"].sort());
  expect(readOperatorAsks(asksFile(), NOW).asks.at(-1)).toEqual(ask);
});

test("a write in one process is read by another through its own connection, and the signature moves with it", () => {
  mutateOperatorAsks((file) => { file.spend.usd = 0.25; }, NOW, asksFile());
  const signature = operatorAsksSignature(asksFile());
  const store = path.join(import.meta.dir, "store.ts");
  const child = Bun.spawnSync([process.execPath, "-e", `
    const { mutateOperatorAsks } = await import(${JSON.stringify(store)});
    mutateOperatorAsks((file) => { file.spend.usd += 0.5; file.seen.push("from-child"); }, new Date(${NOW.getTime()}), ${JSON.stringify(asksFile())});
  `], { env: { ...process.env, LLV_STATE_DIR: sandbox }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(operatorAsksSignature(asksFile())).not.toBe(signature);
  expect(readOperatorAsks(asksFile(), NOW)).toMatchObject({ spend: { usd: 0.75 }, seen: ["from-child"] });
});

test("the board's read is shared until the store moves, and the classifier's read is its own copy", () => {
  mutateOperatorAsks((file) => { file.seen.push("one"); }, NOW, asksFile());
  const shared = readOperatorAsks(asksFile(), NOW);
  expect(readOperatorAsks(asksFile(), NOW)).toBe(shared);
  const copy = loadOperatorAsks(asksFile(), NOW);
  copy.seen.push("not stored");
  expect(readOperatorAsks(asksFile(), NOW).seen).toEqual(["one"]);
  mutateOperatorAsks((file) => { file.seen.push("two"); }, NOW, asksFile());
  expect(readOperatorAsks(asksFile(), NOW)).not.toBe(shared);
});

/* The release path (#1870 §6.4): an unpromoted release reads the legacy file
   and refuses writes, the activation imports, the demotion checkpoint writes
   the rollback mirror, and what the older release changes in that file folds
   back in at roll-forward. */
async function activate(revision: string, port: string): Promise<void> {
  process.env.PORT = port;
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, revision, hotStateBackend: HOT_STATE_BACKEND }));
  const boundary = await establishHotStateCutoverBoundary(() => true, {
    pollMs: 0, stablePolls: 1, maxPolls: 2, schedule: (callback) => { callback(); return { unref() {} }; },
  });
  await initializeHotStateStoresAtStartup(boundary);
}

test("the rollback mirror carries the store to an older release, and its sends fold back in at roll-forward", async () => {
  const revision = "7".repeat(40);
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:19084", revision, hotStateBackend: HOT_STATE_BACKEND }));
  process.env.PORT = "19084";
  const legacy = syntheticOperatorAsks(NOW, { asks: 3, seen: 4, scores: 2 });
  fs.writeFileSync(asksFile(), JSON.stringify(legacy));

  // Unpromoted: the file is the store, and a write waits for promotion.
  expect(readOperatorAsks(asksFile(), NOW).spend.usd).toBe(legacy.spend.usd);
  expect(() => mutateOperatorAsks((file) => { file.spend.calls += 1; }, NOW, asksFile())).toThrow("waiting for release promotion");
  expect(fs.statSync(asksFile()).isFile()).toBe(true);

  await activate(revision, "19084");
  expect((await ensureLegacyCollectionsImported()).get(OPERATOR_ASKS_COLLECTION)).toMatchObject({ state: "imported" });
  expect(fs.statSync(asksFile()).isDirectory()).toBe(true);
  mutateOperatorAsks((file) => { file.seen.push("after-import"); file.spend.calls += 1; }, NOW, asksFile());

  await checkpointHotStateRollbackMirrorsForDemotion();
  const mirror = JSON.parse(fs.readFileSync(asksFile(), "utf8")) as OperatorAsksFileV1;
  expect(mirror.seen).toEqual([...legacy.seen, "after-import"]);
  expect(mirror.spend.calls).toBe(legacy.spend.calls + 1);

  // An untouched mirror is recognized at roll-forward and retired.
  expect((await ensureLegacyCollectionsImported()).get(OPERATOR_ASKS_COLLECTION)).toMatchObject({ state: "already-imported", incident: null });
  expect(fs.statSync(asksFile()).isDirectory()).toBe(true);

  /* Demoted again, the older release sends one more message and records
     what it spent, rewriting the whole file as it always did. */
  await checkpointHotStateRollbackMirrorsForDemotion();
  const older = JSON.parse(fs.readFileSync(asksFile(), "utf8")) as OperatorAsksFileV1;
  older.seen.push("from-older-release");
  older.spend = { ...older.spend, usd: older.spend.usd + 0.01, calls: older.spend.calls + 1 };
  older.revision += 1;
  fs.writeFileSync(asksFile(), JSON.stringify(older));

  expect((await ensureLegacyCollectionsImported()).get(OPERATOR_ASKS_COLLECTION)).toMatchObject({ state: "already-imported", incident: { kind: "legacy-reconciled" } });
  expect(fs.statSync(asksFile()).isDirectory()).toBe(true);
  const rolledForward = readOperatorAsks(asksFile(), NOW);
  expect(rolledForward.seen).toEqual([...legacy.seen, "after-import", "from-older-release"]);
  expect(rolledForward.spend).toEqual(older.spend);
  expect(rolledForward.revision).toBe(older.revision);
});
