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

import { FORGE_LINKS_COLLECTION, readForgeCache, resetForgeCacheForTests, updateForgeCache, type ForgeCacheFile } from "./cache";
import { syntheticForgeCache } from "./cache.fixture";

/* The forge cache in state.sqlite: one row per repository record, proposal
   page, pull request and issue number. */

const saved = { state: process.env.LLV_STATE_DIR, port: process.env.PORT };
let sandbox = "";

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-forge-store-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetForgeCacheForTests();
});

afterEach(() => {
  resetForgeCacheForTests();
  resetStateReadonlyReaderForTests();
  if (saved.state === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = saved.state;
  if (saved.port === undefined) delete process.env.PORT;
  else process.env.PORT = saved.port;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const forgeFile = () => path.join(sandbox, "forge-links.json");

function rowRevisions(): Map<string, number> {
  const db = new Database(path.join(sandbox, "state.sqlite"), { readonly: true });
  try {
    return new Map(db.query<{ row_key: string; row_revision: number }, [string]>(
      "SELECT row_key, row_revision FROM state_rows WHERE collection = ?",
    ).all(FORGE_LINKS_COLLECTION).map((row) => [row.row_key, row.row_revision]));
  } finally { db.close(); }
}

function changedRows(before: Map<string, number>): string[] {
  const after = rowRevisions();
  return [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).sort();
}

test("a production-shaped cache imports once, verified, and reads back as the legacy file read", () => {
  const legacy = syntheticForgeCache();
  fs.writeFileSync(forgeFile(), JSON.stringify(legacy));
  const before = readForgeCache(forgeFile()).data;
  expect(before).toEqual(legacy);

  updateForgeCache(() => {}, forgeFile());

  expect(fs.statSync(forgeFile()).isDirectory()).toBe(true);
  const prs = Object.values(legacy.repositories).reduce((total, entry) => total + Object.keys(entry.prs).length, 0);
  expect(readStateImport(path.join(sandbox, "state.sqlite"), FORGE_LINKS_COLLECTION)).toMatchObject({ rowCount: 8 + 5 + prs + 110, gap: null });
  resetForgeCacheForTests();
  expect(readForgeCache(forgeFile()).data).toEqual(legacy);
});

test("a sweep page writes the pull requests it read and the repository record, never the rest of the history", () => {
  const legacy = syntheticForgeCache();
  fs.writeFileSync(forgeFile(), JSON.stringify(legacy));
  updateForgeCache(() => {}, forgeFile());
  const name = Object.keys(legacy.repositories)[0]!;
  const before = rowRevisions();
  const at = "2026-11-12T12:03:00.000Z";
  updateForgeCache((data) => {
    const entry = data.repositories[name]!;
    entry.lastAttemptAt = at;
    entry.lastSweepAt = at;
    for (const number of ["2726", "2725"]) entry.prs[number] = { ...entry.prs[number]!, checkedAt: at };
    entry.prs["2727"] = { ...entry.prs["2726"]!, url: `https://github.com/${name}/pull/2727`, headRefName: "pipeline/new", state: "open", checkedAt: at };
    delete entry.issues["100000"];
  }, forgeFile());
  expect(changedRows(before)).toEqual([`repo:${name}`, `pr:${name}#2725`, `pr:${name}#2726`, `pr:${name}#2727`, `issue:${name}#100000`].sort());
  const entry = readForgeCache(forgeFile()).data.repositories[name]!;
  expect(entry.prs["2727"]).toMatchObject({ headRefName: "pipeline/new", state: "open" });
  expect(entry.issues["100000"]).toBeUndefined();
  expect(readForgeCache(forgeFile()).view.repository(name)!.byHead("pipeline/new").map((pr) => pr.number)).toEqual([2727]);

  // An unchanged cache is answered from the same snapshot.
  expect(readForgeCache(forgeFile())).toBe(readForgeCache(forgeFile()));
});

test("a write in one process is read by another through its own connection", () => {
  updateForgeCache((data) => { data.repositories["example-org/widgets"] = { canonical: null, completeSince: null, lastSweepAt: null, lastAttemptAt: null, lastError: null, prs: {}, issues: {} }; }, forgeFile());
  const first = readForgeCache(forgeFile());
  const cache = path.join(import.meta.dir, "cache.ts");
  const child = Bun.spawnSync([process.execPath, "-e", `
    const { updateForgeCache } = await import(${JSON.stringify(cache)});
    updateForgeCache((data) => { data.repositories["example-org/widgets"].canonical = "example-org/renamed"; }, ${JSON.stringify(forgeFile())});
  `], { env: { ...process.env, LLV_STATE_DIR: sandbox }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const second = readForgeCache(forgeFile());
  expect(second).not.toBe(first);
  expect(second.view.repository("example-org/renamed")).toBe(second.view.repository("example-org/widgets"));
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

test("the rollback mirror carries the cache to an older release, and its newer readings fold back in at roll-forward", async () => {
  const revision = "8".repeat(40);
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:19085", revision, hotStateBackend: HOT_STATE_BACKEND }));
  process.env.PORT = "19085";
  const legacy = syntheticForgeCache();
  for (const name of Object.keys(legacy.repositories).slice(2)) delete legacy.repositories[name];
  fs.writeFileSync(forgeFile(), JSON.stringify(legacy));
  const [name, other] = Object.keys(legacy.repositories) as [string, string];

  // Unpromoted: the file is the cache, and a write waits for promotion.
  expect(readForgeCache(forgeFile()).data).toEqual(legacy);
  expect(() => updateForgeCache((data) => { data.repositories[name]!.lastError = "timed-out"; }, forgeFile())).toThrow("waiting for release promotion");
  expect(fs.statSync(forgeFile()).isFile()).toBe(true);

  await activate(revision, "19085");
  expect((await ensureLegacyCollectionsImported()).get(FORGE_LINKS_COLLECTION)).toMatchObject({ state: "imported" });
  expect(fs.statSync(forgeFile()).isDirectory()).toBe(true);
  updateForgeCache((data) => { data.repositories[other]!.lastError = "command-failed"; }, forgeFile());

  await checkpointHotStateRollbackMirrorsForDemotion();
  const mirror = JSON.parse(fs.readFileSync(forgeFile(), "utf8")) as ForgeCacheFile;
  expect(mirror.repositories[other]!.lastError).toBe("command-failed");
  expect(Object.keys(mirror.repositories[name]!.prs)).toHaveLength(Object.keys(legacy.repositories[name]!.prs).length);

  // The older release sweeps once: a newer reading of one pull request and a new one.
  const older = structuredClone(mirror);
  const entry = older.repositories[name]!;
  entry.prs["1"] = { ...entry.prs["1"]!, state: "closed", checkedAt: "2026-11-12T13:00:00.000Z" };
  entry.prs["9001"] = { ...entry.prs["1"]!, url: `https://github.com/${name}/pull/9001`, headRefName: "pipeline/older", state: "open" };
  fs.writeFileSync(forgeFile(), JSON.stringify(older));

  expect((await ensureLegacyCollectionsImported()).get(FORGE_LINKS_COLLECTION)).toMatchObject({ state: "already-imported", incident: { kind: "legacy-reconciled" } });
  expect(fs.statSync(forgeFile()).isDirectory()).toBe(true);
  const rolledForward = readForgeCache(forgeFile()).data;
  expect(rolledForward.repositories[name]!.prs["1"]).toMatchObject({ state: "closed" });
  expect(rolledForward.repositories[name]!.prs["9001"]).toMatchObject({ headRefName: "pipeline/older" });
  expect(rolledForward.repositories[other]!.lastError).toBe("command-failed");
});
