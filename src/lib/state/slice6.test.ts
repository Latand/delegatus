import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { slice6Cases } from "./slice6.fixture";
import { resetLegacyDocumentStoresForTests } from "./legacyDocumentStore";
import { projectAliasStore, projectCurationStore, projectRemoteStore, worktreeMapStore, readProjectDocument, projectStoreSignature } from "@/lib/projects/persistence";
import { canonicalProject, persistProjectAliases, recordedProjectRemote, recordProjectRemote } from "@/lib/projects/aliases";
import { setProjectCrown, createManualProject } from "@/lib/projects/curation";
import { archiveProjects } from "@/lib/reviewHistory/reader";
import { readStateImport } from "./sqliteStateStore";
import { FileTransactionAdmissionError, withFileTransactionAttempt } from "./fileTransaction";
const roots: string[] = [];
const previous = process.env.LLV_STATE_DIR;
function sandbox() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "slice6-")); roots.push(root); process.env.LLV_STATE_DIR = root; return root; }
function seed(root: string, name: string, body: unknown) { const file = path.join(root, name); fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 }); return file; }
afterEach(() => {
  resetLegacyDocumentStoresForTests();
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});
async function restart(root: string) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "slice6.fixture.ts"), root], { env: { ...process.env, LLV_STATE_DIR: root }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(code).toBe(0);
  return JSON.parse(stdout) as { name: string; state: string; value: unknown }[];
}
for (const [name, store, body] of slice6Cases) {
  test(`${name}: verified import, idempotency and rollback mirror`, () => {
    const root = sandbox(), file = seed(root, name, body);
    const expected = store.legacyCollection(file).parse(body);
    const outcome = store.importLegacy(file);
    expect(outcome.state).toBe("imported"); expect(outcome.record.gap).toBeNull();
    expect(outcome.record.rowCount).toBeGreaterThan(0);
    expect(store.read(file)).toEqual(expected);
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(store.importLegacy(file).state).toBe("already-imported");
    store.checkpointRollbackMirror(file);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(body);
    expect(store.importLegacy(file).state).toBe("already-imported");
    expect(store.read(file)).toEqual(expected);
  });
  test(`${name}: torn bytes are preserved once with a durable gap`, () => {
    const root = sandbox(), file = seed(root, name, body), torn = Buffer.from('{"partial":\u0000');
    fs.writeFileSync(file, torn);
    const outcome = store.importLegacy(file);
    expect(outcome.record.gap).toBe("legacy-unreadable");
    expect(fs.readFileSync(outcome.incident!.preservedAs!)).toEqual(torn);
    expect(store.importLegacy(file).state).toBe("already-imported");
    expect(readStateImport(path.join(root, "state.sqlite"), store.legacyCollection(file).collection)?.gap).toBe("legacy-unreadable");
  });
  test.each(["late-writer", "rollback-mirror"])(`${name}: consumed %s archive never restores a later SQLite deletion after restart`, async mode => {
    const root = sandbox(), file = seed(root, name, body);
    const changed = JSON.parse(JSON.stringify(body).replaceAll("fixture", "updated").replaceAll("Fixture", "Updated"));
    if (mode === "late-writer") {
      store.importLegacy(file, { reconcile: true, hooks: { afterCommit: () => {
        const temp = `${file}.predecessor.tmp`; fs.writeFileSync(temp, JSON.stringify(changed)); fs.renameSync(temp, file);
      } } });
    } else {
      store.importLegacy(file); store.checkpointRollbackMirror(file);
      fs.writeFileSync(file, JSON.stringify(changed)); store.importLegacy(file);
    }
    const expectedRows = store.legacyCollection(file).toRows(store.legacyCollection(file).parse(changed));
    const actual = new Map(store.legacyCollection(file).toRows(store.read(file)).map(row => [row.key, row.value]));
    for (const row of expectedRows) {
      // Curation reassembles display order across old and newly added rows.
      // Compare each retained row's facts independently of its new position.
      const normalize = (value: unknown) => {
        const row = structuredClone(value) as { value?: { order?: number } };
        if (name === "project-curation.json" && row.value) delete row.value.order;
        return row;
      };
      expect(normalize(actual.get(row.key))).toEqual(normalize(row.value));
    }
    store.clear(file);
    const empty = store.read(file);
    for (let attempt = 0; attempt < 2; attempt++) {
      resetLegacyDocumentStoresForTests();
      expect((await restart(root)).find(row => row.name === name)?.value).toEqual(empty);
    }
  });
  test(`${name}: builds read legacy state without importing`, () => {
    const root = sandbox(), file = seed(root, name, body), phase = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = "phase-production-build";
    try {
      expect(store.read(file)).toEqual(store.legacyCollection(file).parse(body));
      expect(() => store.mutate(file, document => ({ next: document, result: undefined }))).toThrow("waiting for release promotion");
      expect(fs.existsSync(path.join(root, "state.sqlite"))).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(body));
    } finally { if (phase === undefined) delete process.env.NEXT_PHASE; else process.env.NEXT_PHASE = phase; }
  });
  test(`${name}: a contended legacy writer refuses immediately`, () => {
    const root = sandbox(), file = seed(root, name, body);
    withFileTransactionAttempt(file, "fixture busy", () => expect(() => store.importLegacy(file)).toThrow(FileTransactionAdmissionError));
    expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(body));
  });
}
test("restart finishes all five imports interrupted after COMMIT", async () => {
  const root = sandbox();
  const expected = slice6Cases.map(([name, store, body]) => {
    const file = seed(root, name, body);
    expect(() => store.importLegacy(file, { reconcile: true, hooks: { afterCommit: () => { throw new Error("fixture interrupted"); } } })).toThrow("fixture interrupted");
    return { name, state: "already-imported", value: store.read(file) };
  });
  expect(await restart(root)).toEqual(expected);
  for (const [name] of slice6Cases) expect(fs.statSync(path.join(root, name)).isDirectory()).toBe(true);
});
test("alias decoders read committed SQLite inside a peer transaction; guards follow SQLite writes", () => {
  const root = sandbox();
  const aliases = path.join(root, "project-aliases.json"), remotes = path.join(root, "project-remotes.json");
  seed(root, "project-aliases.json", slice6Cases[0]![2]); projectAliasStore.importLegacy(aliases);
  seed(root, "project-remotes.json", slice6Cases[2]![2]); projectRemoteStore.importLegacy(remotes);
  const before = projectStoreSignature("project-aliases.json");
  expect(canonicalProject("old")).toBe("fixture");
  expect(persistProjectAliases([{ source: "next", target: "fixture", displayName: "Updated" }])).toBe(true);
  expect(projectStoreSignature("project-aliases.json")).not.toBe(before);
  const db = new Database(path.join(root, "state.sqlite"));
  try {
    db.exec("BEGIN IMMEDIATE");
    expect(canonicalProject("next")).toBe("fixture");
    expect(archiveProjects(root).canonical("next")).toBe("fixture");
    expect(recordedProjectRemote("fixture")).toBe("github.com/example/fixture");
    db.exec("ROLLBACK");
  } finally { db.close(); }
  expect(readProjectDocument(worktreeMapStore, "worktree-map.json")).toEqual({});
});


test("SQLite contention preserves project state and each owner retries after release", () => {
  const root = sandbox();
  for (const [name, store, body] of slice6Cases) store.importLegacy(seed(root, name, body));
  const database = new Database(path.join(root, "state.sqlite"));
  const remote = { project: "repo-0123456789abcdef0123456789abcdef", canonicalRemote: "github.com/example/another" };
  const registration = { source: "another", target: "fixture", displayName: "Fixture" };
  const before = readProjectDocument(projectCurationStore, "project-curation.json");
  const folder = path.join(root, "manual-root"); fs.mkdirSync(folder);
  try {
    database.exec("BEGIN IMMEDIATE");
    expect(persistProjectAliases([registration])).toBe(false);
    expect(setProjectCrown("another", true)).toBe(false);
    expect(createManualProject("Another", folder)).toMatchObject({ ok: false, code: "STORE_ERROR" });
    recordProjectRemote(remote);
    expect(recordedProjectRemote(remote.project)).toBeNull();
    expect(canonicalProject("another")).toBe("another");
    expect(readProjectDocument(projectCurationStore, "project-curation.json")).toEqual(before);
    database.exec("ROLLBACK");
  } finally { database.close(); }
  expect(persistProjectAliases([registration])).toBe(true);
  expect(setProjectCrown("another", true)).toBe(true);
  expect(createManualProject("Another", folder).ok).toBe(true);
  recordProjectRemote(remote);
  expect(canonicalProject("another")).toBe("fixture");
  expect(recordedProjectRemote(remote.project)).toBe(remote.canonicalRemote);
});
