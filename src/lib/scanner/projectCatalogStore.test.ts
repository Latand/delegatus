import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HOT_STATE_BACKEND } from "@/lib/state/hotStateAuthority";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";
import * as sqliteState from "@/lib/state/sqliteStateStore";
import { readStateImport, resetStateReadonlyReaderForTests, SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import {
  checkpointHotStateRollbackMirrorsForDemotion,
  establishHotStateCutoverBoundary,
  initializeHotStateStoresAtStartup,
} from "@/lib/viewerInstrumentation";

import {
  decodeCatalogFile,
  PROJECT_CATALOG_COLLECTION,
  projectCatalogDocumentForTests,
  projectCatalogSignature,
  readProjectCatalog,
  readProjectCatalogFolders,
  readProjectCatalogRecords,
  resetProjectCatalogStoreForTests,
  seedProjectCatalogForTests,
  writeProjectCatalog,
  type CachedProjectFile,
} from "./projectCatalogStore";
import { SYNTHETIC_CATALOG_STATE_KEY, syntheticProjectCatalog } from "./projectCatalogStore.fixture";

const saved = { state: process.env.LLV_STATE_DIR, port: process.env.PORT };
let sandbox = "";

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-catalog-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetProjectCatalogStoreForTests();
});

afterEach(() => {
  resetProjectCatalogStoreForTests();
  resetStateReadonlyReaderForTests();
  if (saved.state === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = saved.state;
  if (saved.port === undefined) delete process.env.PORT;
  else process.env.PORT = saved.port;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const catalogFile = () => path.join(sandbox, "project-catalog.json");

/** Each stored row's revision, read through a connection of the test's own. */
function rowRevisions(): Map<string, number> {
  const db = new Database(path.join(sandbox, "state.sqlite"), { readonly: true });
  try {
    return new Map(db.query<{ row_key: string; row_revision: number }, [string]>(
      "SELECT row_key, row_revision FROM state_rows WHERE collection = ?",
    ).all(PROJECT_CATALOG_COLLECTION).map((row) => [row.row_key, row.row_revision]));
  } finally { db.close(); }
}

/** A scan's write: every record resolved under `stateKey`. */
function scanWrite(files: Record<string, Record<string, unknown>>, stateKey = SYNTHETIC_CATALOG_STATE_KEY) {
  return writeProjectCatalog({
    resolutionVersion: 10,
    stateKey,
    files: Object.fromEntries(Object.entries(files).map(([pathname, file]) => [pathname, { ...file, stateKey } as unknown as CachedProjectFile])),
  }, catalogFile());
}

test("a production-shaped catalog imports once, reads back as the legacy file read, and leaves no file", () => {
  const body = syntheticProjectCatalog(2_000);
  fs.writeFileSync(catalogFile(), JSON.stringify(body));

  const view = readProjectCatalog(catalogFile());

  expect(fs.existsSync(catalogFile())).toBe(false);
  expect(readStateImport(path.join(sandbox, "state.sqlite"), PROJECT_CATALOG_COLLECTION)).toMatchObject({ rowCount: 2_001, gap: null });
  expect(view.resolutionVersion).toBe(10);
  expect(view.stateKey).toBe(SYNTHETIC_CATALOG_STATE_KEY);
  expect(view.files.size).toBe(2_000);
  for (const [pathname, file] of Object.entries(body.files)) {
    const { stateKey: _shared, ...stored } = decodeCatalogFile(file)!;
    expect(view.files.get(pathname)).toEqual(stored);
  }
  expect(projectCatalogDocumentForTests(catalogFile())!.files).toEqual(body.files);
  // The shared state key is stored once, in `meta`, and on no file row.
  const db = new Database(path.join(sandbox, "state.sqlite"), { readonly: true });
  try {
    expect(db.query<{ rows: number }, [string, string]>("SELECT count(*) AS rows FROM state_rows WHERE collection = ? AND instr(value_json, ?) > 0")
      .get(PROJECT_CATALOG_COLLECTION, SYNTHETIC_CATALOG_STATE_KEY)!.rows).toBe(1);
  } finally { db.close(); }
  expect(view.folders().projectRoots.size).toBe(13);
});

test("a scan writes only the rows that changed, and a moved resolution state rewrites meta alone", () => {
  const body = syntheticProjectCatalog(2_000);
  seedProjectCatalogForTests(body, catalogFile());
  const before = rowRevisions();
  const paths = Object.keys(body.files);
  const next = { ...body.files };
  for (const pathname of paths.slice(0, 3)) next[pathname] = { ...next[pathname], size: (next[pathname]!.size as number) + 512, mtimeMs: (next[pathname]!.mtimeMs as number) + 10 };
  delete next[paths[3]!];
  const added = "/srv/agents/.codex/sessions/2026/11/12/rollout-new.jsonl";
  next[added] = { ...body.files[paths[4]!]!, size: 99 };

  expect(scanWrite(next)).toMatchObject({ upserted: 4, deleted: 1 });
  const after = rowRevisions();
  const moved = [...after].filter(([key, revision]) => before.get(key) !== revision).map(([key]) => key).sort();
  expect(moved).toEqual([...paths.slice(0, 3), added].map((pathname) => `f:${pathname}`).sort());
  expect(after.has(`f:${paths[3]}`)).toBe(false);
  expect(readProjectCatalog(catalogFile()).files.get(paths[0]!)?.size).toBe((body.files[paths[0]!]!.size as number) + 512);

  // Nothing changed: nothing written, the revision stays.
  const signature = projectCatalogSignature(catalogFile());
  expect(scanWrite(next)).toMatchObject({ upserted: 0, deleted: 0 });
  expect(projectCatalogSignature(catalogFile())).toBe(signature);

  // Every record re-resolved under a new state key: one row.
  expect(scanWrite(next, "moved-state-key")).toMatchObject({ upserted: 1, deleted: 0 });
  const view = readProjectCatalog(catalogFile());
  expect(view.stateKey).toBe("moved-state-key");
  expect(view.files.get(paths[0]!)?.stateKey).toBeUndefined();
});

test("the folder readers decode no record, and follow another process's scans through the changed rows alone", () => {
  const body = syntheticProjectCatalog(500);
  seedProjectCatalogForTests(body, catalogFile());
  const expected = readProjectCatalog(catalogFile()).folders();
  resetProjectCatalogStoreForTests();
  const decoded = spyOn(SqliteStateCollection.prototype, "loadReadonly");
  const extracted = spyOn(sqliteState, "readStateCollectionFields");
  try {
    const folders = readProjectCatalogFolders(catalogFile());
    expect(folders.paths).toEqual(expected.paths);
    expect([...folders.projectRoots]).toEqual([...expected.projectRoots]);
    expect(readProjectCatalogFolders(catalogFile())).toBe(folders);
    const records = readProjectCatalogRecords(catalogFile())!;
    expect(records.size).toBe(500);
    const [first, second] = Object.keys(body.files) as [string, string];
    /* A record in a worktree of its own, so its folder leaves with it. */
    const third = Object.keys(body.files)[20]!;
    expect(records.get(first)).toMatchObject({ project: body.files[first]!.project, cwd: body.files[first]!.cwd });

    /* The scanning process writes: one record moves to a new folder, one is
       added in another, one is gone. */
    const store = path.join(import.meta.dir, "projectCatalogStore.ts");
    const child = Bun.spawnSync([process.execPath, "-e", `
      const store = await import(${JSON.stringify(store)});
      const view = store.readProjectCatalog(${JSON.stringify(catalogFile())});
      const files = Object.fromEntries([...view.files].map(([p, f]) => [p, { ...f, stateKey: view.stateKey }]));
      files[${JSON.stringify(first)}] = { ...files[${JSON.stringify(first)}], cwd: "/srv/agents/moved-checkout" };
      files["/srv/agents/.codex/sessions/2026/11/12/rollout-added.jsonl"] = { ...files[${JSON.stringify(second)}], cwd: "/srv/agents/added-checkout" };
      delete files[${JSON.stringify(third)}];
      console.log(JSON.stringify(store.writeProjectCatalog({ resolutionVersion: 10, stateKey: view.stateKey, files }, ${JSON.stringify(catalogFile())})));
    `], { env: { ...process.env, LLV_STATE_DIR: sandbox }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!)).toMatchObject({ upserted: 2, deleted: 1 });

    const followed = readProjectCatalogFolders(catalogFile());
    expect(extracted).toHaveBeenCalledTimes(1);
    expect(decoded).not.toHaveBeenCalled();
    expect(followed.paths).toContain("/srv/agents/moved-checkout");
    expect(followed.paths.at(-1)).toBe("/srv/agents/added-checkout");
    expect(followed.paths).not.toContain(body.files[third]!.cwd);
    decoded.mockRestore();
    resetProjectCatalogStoreForTests();
    expect(followed).toEqual(readProjectCatalog(catalogFile()).folders());
  } finally {
    decoded.mockRestore();
    extracted.mockRestore();
  }
});

test("a write in one process is read by another through its own connection, and back", () => {
  const body = syntheticProjectCatalog(50);
  seedProjectCatalogForTests(body, catalogFile());
  const first = Object.keys(body.files)[0]!;
  const signature = projectCatalogSignature(catalogFile());
  const store = path.join(import.meta.dir, "projectCatalogStore.ts");
  const child = Bun.spawnSync([process.execPath, "-e", `
    const store = await import(${JSON.stringify(store)});
    const view = store.readProjectCatalog(${JSON.stringify(catalogFile())});
    const files = Object.fromEntries([...view.files].map(([p, f]) => [p, { ...f, stateKey: view.stateKey }]));
    files[${JSON.stringify(first)}] = { ...files[${JSON.stringify(first)}], title: "Written by another process" };
    console.log(JSON.stringify(store.writeProjectCatalog({ resolutionVersion: 10, stateKey: view.stateKey, files }, ${JSON.stringify(catalogFile())})));
  `], { env: { ...process.env, LLV_STATE_DIR: sandbox }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!)).toMatchObject({ upserted: 1, deleted: 0 });
  expect(projectCatalogSignature(catalogFile())).not.toBe(signature);
  expect(readProjectCatalog(catalogFile()).files.get(first)?.title).toBe("Written by another process");
});

test("an unreadable legacy file is a rescan, and a catalog an older release left later replaces the stored one", () => {
  fs.writeFileSync(catalogFile(), "{ torn");
  const empty = readProjectCatalog(catalogFile());
  expect(empty.files.size).toBe(0);
  expect(empty.resolutionVersion).toBeNull();
  expect(fs.existsSync(catalogFile())).toBe(false);
  expect(readStateImport(path.join(sandbox, "state.sqlite"), PROJECT_CATALOG_COLLECTION)?.gap).toBe("legacy-unreadable");

  seedProjectCatalogForTests(syntheticProjectCatalog(20), catalogFile());
  const older = syntheticProjectCatalog(5, 9);
  fs.writeFileSync(catalogFile(), JSON.stringify(older));
  /* With no release target, the next read takes it, as a first import would. */
  const view = readProjectCatalog(catalogFile());
  expect([...view.files.keys()].sort()).toEqual(Object.keys(older.files).sort());
  expect(view.resolutionVersion).toBe(9);
  expect(fs.existsSync(catalogFile())).toBe(false);
});

test("records of a catalog this release cannot reuse still name their folders", () => {
  fs.writeFileSync(catalogFile(), JSON.stringify({ files: { fixture: { cwd: "/srv/agents/checkout", projectRoot: "/srv/agents/repository" } } }));
  const view = readProjectCatalog(catalogFile());
  expect(view.files.size).toBe(0);
  expect(view.folders().paths).toEqual(["/srv/agents/checkout", "/srv/agents/repository"]);
  expect(view.records().get("fixture")).toEqual({ cwd: "/srv/agents/checkout", projectRoot: "/srv/agents/repository" });
});

/* The release path: an unpromoted release reads the legacy file and writes
   nothing, the activation imports and deletes it, the demotion writes no
   mirror (an older release rescans), and the file that older release writes
   is imported again at roll-forward and never by a read in between. */
async function activate(revision: string, port: string): Promise<void> {
  process.env.PORT = port;
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, revision, hotStateBackend: HOT_STATE_BACKEND }));
  const boundary = await establishHotStateCutoverBoundary(() => true, {
    pollMs: 0, stablePolls: 1, maxPolls: 2, schedule: (callback) => { callback(); return { unref() {} }; },
  });
  await initializeHotStateStoresAtStartup(boundary);
}

test("the release path imports at activation, writes no mirror, and takes an older release's catalog back at roll-forward", async () => {
  const revision = "6".repeat(40);
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:19083", revision, hotStateBackend: HOT_STATE_BACKEND }));
  process.env.PORT = "19083";
  const body = syntheticProjectCatalog(30);
  fs.writeFileSync(catalogFile(), JSON.stringify(body));

  // Unpromoted: the file is the catalog, and a write waits for promotion.
  expect(readProjectCatalog(catalogFile()).files.size).toBe(30);
  expect(() => scanWrite(body.files)).toThrow("waiting for release promotion");
  expect(fs.statSync(catalogFile()).isFile()).toBe(true);

  await activate(revision, "19083");
  expect((await ensureLegacyCollectionsImported()).get(PROJECT_CATALOG_COLLECTION)).toMatchObject({ state: "imported" });
  expect(fs.existsSync(catalogFile())).toBe(false);
  expect(readProjectCatalog(catalogFile()).files.size).toBe(30);

  await checkpointHotStateRollbackMirrorsForDemotion();
  expect(fs.existsSync(catalogFile())).toBe(false);

  // The older release rescans and writes its own file; a read never takes it.
  const older = syntheticProjectCatalog(12, 9);
  fs.writeFileSync(catalogFile(), JSON.stringify(older));
  expect(readProjectCatalog(catalogFile()).files.size).toBe(30);
  expect(fs.statSync(catalogFile()).isFile()).toBe(true);

  expect((await ensureLegacyCollectionsImported()).get(PROJECT_CATALOG_COLLECTION)).toMatchObject({ state: "reimported" });
  expect(fs.existsSync(catalogFile())).toBe(false);
  const view = readProjectCatalog(catalogFile());
  expect(view.files.size).toBe(12);
  expect(view.resolutionVersion).toBe(9);
});
