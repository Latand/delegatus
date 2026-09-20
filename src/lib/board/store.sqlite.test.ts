import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { stateImportIncidents } from "@/lib/state/legacyImport";
import { readStateCollectionRevision, readStateImport, StateImportVerificationError, stateRowDigest } from "@/lib/state/sqliteStateStore";
import type { BoardProjectStateV1 } from "@/lib/view/types";

import { MAX_RETIRED_KEY_REVISIONS, pathKey } from "./keys";
import { persistedBoardProjects } from "./storeFixture";
import {
  boardFor,
  BoardStoreError,
  checkpointBoardRollbackMirrorForDemotion,
  importLegacyBoard,
  migrateBoardProjects,
  mutateBoard,
  patchBoard,
  setBoardBusyRetryForTests,
} from "./store";

/* #1870 slice 3: the board store runs on the `board` collection of the
   `state.sqlite` beside its legacy path, one row per project. Every case uses
   its own mkdtemp directory, never the live state directory. */

const CHILD = path.join(import.meta.dir, "store.sqliteChild.ts");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox(): { dir: string; file: string; db: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-board-sqlite-"));
  dirs.push(dir);
  return { dir, file: path.join(dir, "board.json"), db: path.join(dir, "state.sqlite") };
}

function projectState(manual: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: 3,
    updatedAt: "2026-09-01T00:00:00.000Z",
    pathAliases: {},
    prefs: { manual, hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
    ...overrides,
  };
}

function writeLegacy(file: string, body: unknown): string {
  const text = JSON.stringify(body, null, 2) + "\n";
  fs.writeFileSync(file, text);
  return text;
}

function siblings(dir: string, prefix: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
}

function storedRow(db: string, project: string): { value_json: string; row_revision: number } | null {
  const Database = (process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite")).Database;
  const sqlite = new Database(db, { readonly: true });
  try {
    return sqlite.query<{ value_json: string; row_revision: number }, [string]>(
      "SELECT value_json, row_revision FROM state_rows WHERE collection = 'board' AND row_key = ?",
    ).get(`p:${project}`) ?? null;
  } finally {
    sqlite.close();
  }
}

function spawnChild(args: string[]) {
  return Bun.spawn([process.execPath, CHILD, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
}

async function waitForFile(filename: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filename)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${filename}`);
    await Bun.sleep(5);
  }
}

describe("first-boot import of board.json", () => {
  test("imports every project, verifies the digest and leaves a tombstone", () => {
    const { dir, file, db } = sandbox();
    const projects = {
      alpha: projectState(["/alpha"]),
      beta: projectState(["/beta"], { extension: { kept: true } }),
    };
    const text = writeLegacy(file, { projects });

    expect(boardFor("alpha", file).prefs.manual).toEqual(["/alpha"]);
    expect((boardFor("beta", file) as unknown as Record<string, unknown>).extension).toEqual({ kept: true });

    const record = readStateImport(db, "board");
    expect(record).not.toBeNull();
    expect(record!.rowCount).toBe(2);
    expect(record!.gap).toBeNull();
    expect(record!.sourceSha256).toBe(crypto.createHash("sha256").update(text).digest("hex"));
    expect(record!.rowDigest).toBe(stateRowDigest(
      Object.entries(projects).map(([project, state]) => JSON.stringify({ project, state })),
    ));

    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(file, "README"), "utf8")).toContain("state.sqlite");
    const kept = siblings(dir, "board.json.imported-");
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, kept[0]!), "utf8")).toBe(text);
  });

  test("a store with no legacy file starts empty and still leaves a tombstone", () => {
    const { file, db } = sandbox();
    expect(boardFor("repo", file)).toMatchObject({ revision: 0 });
    expect(readStateImport(db, "board")?.rowCount).toBe(0);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  test("a production-sized board imports with an equal digest and reads back identically", () => {
    const { file, db } = sandbox();
    const projects = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
      `project-${index}`,
      projectState(Array.from({ length: 40 }, (_, item) => `/session-${index}-${item}`)),
    ]));
    writeLegacy(file, { projects });
    const expected = stateRowDigest(Object.entries(projects).map(([project, state]) => JSON.stringify({ project, state })));

    expect(boardFor("project-63", file).prefs.manual).toHaveLength(40);

    expect(readStateImport(db, "board")?.rowDigest).toBe(expected);
    expect(readStateImport(db, "board")?.rowCount).toBe(64);
  });

  test("(b) a NUL-filled legacy file is recorded as a gap with an incident", () => {
    const { file, db } = sandbox();
    fs.writeFileSync(file, Buffer.alloc(4096, 0));
    const before = stateImportIncidents().length;

    expect(boardFor("repo", file).revision).toBe(0);

    expect(readStateImport(db, "board")?.gap).toBe("legacy-unreadable");
    const incident = stateImportIncidents().slice(before).find((entry) => entry.collection === "board");
    expect(incident?.kind).toBe("legacy-unreadable");
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  test("valid JSON with an invalid project state refuses the import and leaves the file untouched", () => {
    const { file, db } = sandbox();
    const text = writeLegacy(file, { projects: { repo: { schemaVersion: 2 } } });
    expect(() => boardFor("repo", file)).toThrow(BoardStoreError);
    expect(readStateImport(db, "board")).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });

  test("(c1) a crash before COMMIT leaves nothing behind and the retry imports", () => {
    const { file, db } = sandbox();
    const text = writeLegacy(file, { projects: { repo: projectState(["/a"]) } });
    expect(() => importLegacyBoard(file, { reconcile: true, hooks: { beforeVerify: () => { throw new Error("crash"); } } }))
      .toThrow("crash");
    expect(readStateImport(db, "board")).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(text);

    expect(importLegacyBoard(file, { reconcile: true }).state).toBe("imported");
    expect(boardFor("repo", file).prefs.manual).toEqual(["/a"]);
  });

  test("(c2) a crash after COMMIT but before the rename finishes without a second import", () => {
    const { dir, file, db } = sandbox();
    writeLegacy(file, { projects: { repo: projectState(["/a"]) } });
    expect(() => importLegacyBoard(file, { reconcile: true, hooks: { afterCommit: () => { throw new Error("crash"); } } }))
      .toThrow("crash");
    const record = readStateImport(db, "board");
    expect(record).not.toBeNull();
    expect(fs.statSync(file).isFile()).toBe(true);

    const outcome = importLegacyBoard(file, { reconcile: true });

    expect(outcome.state).toBe("already-imported");
    expect(outcome.incident).toBeNull();
    expect(readStateImport(db, "board")?.importedAt).toBe(record!.importedAt);
    expect(siblings(dir, "board.json.imported-")).toHaveLength(1);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  test("(c3) a crash after the rename but before the tombstone finishes the tombstone", () => {
    const { file } = sandbox();
    writeLegacy(file, { projects: { repo: projectState(["/a"]) } });
    expect(() => importLegacyBoard(file, { reconcile: true, hooks: { afterRename: () => { throw new Error("crash"); } } }))
      .toThrow("crash");
    expect(fs.existsSync(file)).toBe(false);

    expect(importLegacyBoard(file, { reconcile: true }).state).toBe("already-imported");
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(boardFor("repo", file).prefs.manual).toEqual(["/a"]);
  });

  test("(g) an injected digest mismatch leaves the database unmarked and the legacy file untouched", () => {
    const { file, db } = sandbox();
    const text = writeLegacy(file, { projects: { alpha: projectState(["/a"]), beta: projectState(["/b"]) } });
    expect(() => importLegacyBoard(file, {
      reconcile: true,
      hooks: {
        beforeVerify: (execute) => execute(
          "UPDATE state_rows SET value_json = ? WHERE collection = 'board' AND row_key = 'p:beta'",
          JSON.stringify({ project: "beta", state: projectState(["/tampered"]) }),
        ),
      },
    })).toThrow(StateImportVerificationError);
    expect(readStateImport(db, "board")).toBeNull();
    expect(readStateCollectionRevision(db, "board")).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });
});

describe("writes after the import", () => {
  test("a per-project write leaves every other project's row byte-identical and unmoved", () => {
    const { file, db } = sandbox();
    const beta = projectState(["/beta"], { extension: { kept: true } });
    writeLegacy(file, { projects: { alpha: projectState(["/alpha"]), beta } });
    boardFor("alpha", file);
    const revision = readStateCollectionRevision(db, "board")!;

    expect(mutateBoard("alpha", 3, [{ kind: "restore", path: "/added", placement: "manual" }], file))
      .toMatchObject({ ok: true, applied: true, board: { revision: 4 } });

    expect(readStateCollectionRevision(db, "board")).toBe(revision + 1);
    const stored = storedRow(db, "beta")!;
    expect(stored.value_json).toBe(JSON.stringify({ project: "beta", state: beta }));
    expect(stored.row_revision).toBe(revision);
    expect(storedRow(db, "alpha")!.row_revision).toBe(revision + 1);
    expect(boardFor("beta", file).prefs.manual).toEqual(["/beta"]);
  });

  test("a project a migration folds away is deleted, and the surviving row keeps the merged board", () => {
    const { file, db } = sandbox();
    writeLegacy(file, { projects: { legacy: projectState(["/moved"]), target: projectState(["/held"]) } });
    boardFor("target", file);

    expect(migrateBoardProjects(new Map([["legacy", "target"]]), file)).toBe(true);

    expect(storedRow(db, "legacy")).toBeNull();
    expect(boardFor("target", file).prefs.manual.sort()).toEqual(["/held", "/moved"]);
    expect(boardFor("legacy", file).revision).toBe(0);
  });

  /* The catalog hands this store chains: migrationPlan stops walking at an
     intermediate that has conversations of its own, so one plan holds both
     `source -> middle` and `middle -> final`. Every placement has to reach the
     end of the chain, and no project may be written and deleted in the same
     patch — the collection rejects that outright. */
  test("a chained migration folds through to the final target, with and without a row on the intermediate", () => {
    for (const middleHasRow of [true, false]) {
      const { file, db } = sandbox();
      const projects: Record<string, unknown> = {
        source: projectState(["/from-source"]),
        final: projectState(["/held"]),
        bystander: projectState(["/untouched"]),
        ...(middleHasRow ? { middle: projectState(["/from-middle"]) } : {}),
      };
      writeLegacy(file, { projects });
      boardFor("final", file);
      const bystander = storedRow(db, "bystander")!;

      expect(migrateBoardProjects(new Map([["source", "middle"], ["middle", "final"]]), file)).toBe(true);

      expect(boardFor("final", file).prefs.manual.sort()).toEqual(
        middleHasRow ? ["/from-middle", "/from-source", "/held"] : ["/from-source", "/held"],
      );
      expect(storedRow(db, "source")).toBeNull();
      expect(storedRow(db, "middle")).toBeNull();
      expect(storedRow(db, "bystander")).toEqual(bystander);
    }
  });

  /* A cycle names no final target, so nothing is folded and the call reports
     incomplete rather than picking a winner by iteration order. */
  test("a migration cycle leaves both projects intact and reports incomplete", () => {
    const { file, db } = sandbox();
    writeLegacy(file, { projects: { one: projectState(["/one"]), two: projectState(["/two"]) } });
    boardFor("one", file);
    const before = [storedRow(db, "one")!, storedRow(db, "two")!];

    expect(migrateBoardProjects(new Map([["one", "two"], ["two", "one"]]), file)).toBe(false);

    expect([storedRow(db, "one"), storedRow(db, "two")]).toEqual(before);
  });

  test("the retired-key history cap holds across a reload from SQLite", () => {
    const { file } = sandbox();
    writeLegacy(file, { projects: {} });
    // Every favourite that is set and unset retires one key, past the cap.
    const total = MAX_RETIRED_KEY_REVISIONS + 20;
    for (let index = 0; index < total; index += 1) {
      const revision = boardFor("repo", file).revision;
      const added = mutateBoard("repo", revision, [{ kind: "set-favorite", id: `conv-${index}`, favorite: true }], file);
      expect(added.ok).toBe(true);
      expect(mutateBoard("repo", revision + 1, [{ kind: "set-favorite", id: `conv-${index}`, favorite: false }], file).ok).toBe(true);
    }

    const board = boardFor("repo", file);
    expect(Object.keys(board.keyRevisions ?? {}).length).toBeLessThanOrEqual(MAX_RETIRED_KEY_REVISIONS + 3);
    expect(board.keyRevisionFloor).toBeGreaterThan(0);
    // The evicted history still fences: intent formed before the floor loses.
    expect(mutateBoard("repo", board.revision, [{ kind: "set-favorite", id: "conv-0", favorite: true }], file).ok).toBe(true);
  });

  test("a board written before per-key revisions existed keeps its placements through the import", () => {
    const { file } = sandbox();
    writeLegacy(file, { projects: { repo: {
      schemaVersion: 1,
      revision: 5,
      updatedAt: "2026-07-10T00:00:00.000Z",
      prefs: { manual: ["/a"], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
    } } });

    const board = boardFor("repo", file);

    expect(board.prefs).toMatchObject({ manual: ["/a"], favorites: [], foldedEngineChildIds: [], seenAt: {}, idleCollapseMinutes: 120 });
    expect(board.keyRevisions).toEqual({});
    expect(board.explicitManual).toEqual(["/a"]);
  });
});

describe("cross-process durability", () => {
  test("(a) a writer killed mid-transaction loses only that transaction", async () => {
    const { dir, file, db } = sandbox();
    writeLegacy(file, { projects: { repo: projectState(["/a"]) } });
    boardFor("repo", file);
    const before = readStateCollectionRevision(db, "board");
    const ready = path.join(dir, "ready");

    const child = spawnChild(["hold-mutate", file, ready]);
    await waitForFile(ready);
    child.kill("SIGKILL");
    await child.exited;

    expect(readStateCollectionRevision(db, "board")).toBe(before);
    expect(boardFor("repo", file).prefs.manual).toEqual(["/a"]);
    // The dead writer's lease is reclaimed and the next write lands.
    expect(mutateBoard("repo", 3, [{ kind: "restore", path: "/after", placement: "manual" }], file).ok).toBe(true);
    expect(boardFor("repo", file).prefs.manual).toEqual(["/a", "/after"]);
  });

  test("an importer killed inside its transaction leaves the file for the next importer", async () => {
    const { dir, file, db } = sandbox();
    const text = writeLegacy(file, { projects: { repo: projectState(["/a"]) } });
    const ready = path.join(dir, "ready");

    const child = spawnChild(["hold-import", file, ready]);
    await waitForFile(ready);
    child.kill("SIGKILL");
    await child.exited;

    expect(readStateImport(db, "board")).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(text);
    expect(importLegacyBoard(file, { reconcile: true }).state).toBe("imported");
    expect(boardFor("repo", file).prefs.manual).toEqual(["/a"]);
  });

  test("(d) two processes importing at once import exactly once and agree on the digest", async () => {
    const { dir, file } = sandbox();
    writeLegacy(file, { projects: Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`project-${index}`, projectState([`/p-${index}`])]),
    ) });
    const gate = path.join(dir, "go");
    const children = [0, 1].map(() => spawnChild(["import", file, "", gate]));
    await Bun.sleep(100);
    fs.writeFileSync(gate, "go");
    const outputs = await Promise.all(children.map(async (child) => {
      expect(await child.exited).toBe(0);
      return JSON.parse(await new Response(child.stdout).text()) as { state: string; digest: string; rows: number };
    }));

    expect(outputs.map((output) => output.state).sort()).toEqual(["already-imported", "imported"]);
    expect(outputs[0]!.digest).toBe(outputs[1]!.digest);
    expect(outputs[0]!.rows).toBe(64);
    expect(siblings(dir, "board.json.imported-")).toHaveLength(1);
  });

  test("a write from another process is visible to a reader that already opened the board", async () => {
    const { file, db } = sandbox();
    writeLegacy(file, { projects: { repo: projectState(["/a"]) } });
    // The reader opens the collection first, as a long-lived Viewer worker does.
    expect(boardFor("repo", file).prefs.manual).toEqual(["/a"]);
    const before = readStateCollectionRevision(db, "board")!;

    const child = spawnChild(["restore", file, "1"]);
    expect(await child.exited).toBe(0);

    expect(readStateCollectionRevision(db, "board")).toBe(before + 1);
    const written = Object.keys(persistedBoardProjects(file)).find((project) => project.startsWith("proj-"))!;
    expect(boardFor(written, file).prefs.manual).toEqual(["/p-0"]);
  });

  test("concurrent writers in two processes lose no update", async () => {
    const { dir, file } = sandbox();
    writeLegacy(file, { projects: {} });
    boardFor("repo", file);
    const gate = path.join(dir, "go");
    const children = [0, 1].map(() => spawnChild(["restore", file, "12", gate]));
    await Bun.sleep(100);
    fs.writeFileSync(gate, "go");
    const outputs = await Promise.all(children.map(async (child) => {
      expect(await child.exited).toBe(0);
      return JSON.parse(await new Response(child.stdout).text()) as { manual: number };
    }));

    expect(outputs.map((output) => output.manual)).toEqual([12, 12]);
  });

  /* The import-marker probe runs on a read-only connection opened with
     `busy_timeout = 0`, so a writer that holds the file lock makes it raise
     SQLITE_BUSY on the first touch of the board in a process. The pre-#1870
     store queued on its own write lock and never dropped that write, so the
     probe retries the same bounded way every other write here does. */
  test("a write whose import probe meets a held file lock waits for it instead of failing", async () => {
    const { dir, file } = sandbox();
    writeLegacy(file, { projects: { repo: projectState(["/a"]) } });
    // Imported by a child, so this process has never opened the collection.
    expect(await spawnChild(["import", file]).exited).toBe(0);
    const held = path.join(dir, "held");
    const holder = spawnChild(["hold-database-lock", path.join(dir, "state.sqlite"), held, "400"]);
    await waitForFile(held);

    // Blocks inside the probe's retry until the holder above lets go.
    expect(mutateBoard("repo", 3, [{ kind: "restore", path: "/b", placement: "manual" }], file))
      .toMatchObject({ ok: true, applied: true });

    expect(await holder.exited).toBe(0);
    expect(boardFor("repo", file).prefs.manual).toEqual(["/a", "/b"]);
  });

  test("a probe that never gets the file lock reports the store's busy failure, not a raw SQLite error", async () => {
    const { dir, file } = sandbox();
    writeLegacy(file, { projects: { repo: projectState(["/a"]) } });
    expect(await spawnChild(["import", file]).exited).toBe(0);
    const held = path.join(dir, "held");
    const holder = spawnChild(["hold-database-lock", path.join(dir, "state.sqlite"), held, "4000"]);
    await waitForFile(held);

    setBoardBusyRetryForTests(3);
    try {
      let raised: unknown;
      try { boardFor("repo", file); } catch (error) { raised = error; }
      expect(raised).toBeInstanceOf(BoardStoreError);
      expect((raised as BoardStoreError).message).toBe("board state is busy");
      expect(String((raised as BoardStoreError).cause)).toMatch(/database is locked|SQLITE_BUSY/i);
    } finally {
      setBoardBusyRetryForTests(null);
      holder.kill();
      await holder.exited;
    }
  });
});

describe("(f) rollback mirror and roll-forward", () => {
  test("an untouched mirror is dropped on roll-forward without a second kept copy", () => {
    const { dir, file, db } = sandbox();
    writeLegacy(file, { projects: { repo: projectState(["/a"]) } });
    boardFor("repo", file);
    mutateBoard("repo", 3, [{ kind: "restore", path: "/b", placement: "manual" }], file);

    checkpointBoardRollbackMirrorForDemotion(file);

    const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { projects: Record<string, BoardProjectStateV1> };
    expect(mirror.projects.repo!.prefs.manual).toEqual(["/a", "/b"]);
    expect(readStateImport(db, "board")?.mirrorRevision).toBe(readStateCollectionRevision(db, "board"));

    const outcome = importLegacyBoard(file, { reconcile: true });

    expect(outcome.state).toBe("already-imported");
    expect(outcome.incident).toBeNull();
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(siblings(dir, "board.json.imported-")).toHaveLength(1);
  });

  test("edits a rollback release made to the mirror merge back by project revision with an incident", () => {
    const { file } = sandbox();
    writeLegacy(file, { projects: { alpha: projectState(["/a"]), beta: projectState(["/b"]), gamma: projectState(["/c"]) } });
    boardFor("alpha", file);
    checkpointBoardRollbackMirrorForDemotion(file);
    const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { projects: Record<string, BoardProjectStateV1> };
    // After the fence, a new-code writer moved gamma further than the rollback release did.
    mutateBoard("gamma", 3, [{ kind: "restore", path: "/sqlite-wins", placement: "manual" }], file);
    mutateBoard("gamma", 4, [{ kind: "restore", path: "/sqlite-wins-again", placement: "manual" }], file);
    // The rollback release edits alpha and gamma and creates delta in its JSON.
    mirror.projects.alpha = { ...mirror.projects.alpha!, revision: 4, prefs: { ...mirror.projects.alpha!.prefs, manual: ["/a", "/rollback"] } };
    mirror.projects.gamma = { ...mirror.projects.gamma!, revision: 4, prefs: { ...mirror.projects.gamma!.prefs, manual: ["/rollback-loses"] } };
    mirror.projects.delta = projectState(["/d"]) as unknown as BoardProjectStateV1;
    writeLegacy(file, mirror);

    const outcome = importLegacyBoard(file, { reconcile: true });

    expect(outcome.incident?.kind).toBe("legacy-reconciled");
    expect(outcome.incident?.summary).toMatchObject({ added: 1, replaced: 1, kept: 1, conflicts: ["p:gamma"] });
    expect(boardFor("alpha", file).prefs.manual).toEqual(["/a", "/rollback"]);
    expect(boardFor("beta", file).prefs.manual).toEqual(["/b"]);
    expect(boardFor("gamma", file).prefs.manual).toEqual(["/c", "/sqlite-wins", "/sqlite-wins-again"]);
    expect(boardFor("delta", file).prefs.manual).toEqual(["/d"]);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  test("a project the rollback release dropped stays dropped, and one SQLite changed since the mirror stays", () => {
    const { file } = sandbox();
    writeLegacy(file, { projects: { alpha: projectState(["/a"]), beta: projectState(["/b"]), gamma: projectState(["/c"]) } });
    boardFor("alpha", file);
    checkpointBoardRollbackMirrorForDemotion(file);
    const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { projects: Record<string, BoardProjectStateV1> };
    mutateBoard("gamma", 3, [{ kind: "restore", path: "/sqlite-edit", placement: "manual" }], file);
    // The rollback release folds beta and gamma away.
    delete mirror.projects.beta;
    delete mirror.projects.gamma;
    writeLegacy(file, mirror);

    const outcome = importLegacyBoard(file, { reconcile: true });

    expect(outcome.incident?.summary).toMatchObject({ removed: 1, keys: ["p:beta"], conflicts: ["p:gamma"] });
    expect(boardFor("beta", file).revision).toBe(0);
    expect(boardFor("gamma", file).prefs.manual).toEqual(["/c", "/sqlite-edit"]);
  });

  test("a fresh file an old writer made after the import retired board.json never deletes a project", () => {
    const { dir, file } = sandbox();
    writeLegacy(file, { projects: { alpha: projectState(["/a"]), beta: projectState(["/b"]) } });
    expect(() => importLegacyBoard(file, { reconcile: true, hooks: { afterRename: () => { throw new Error("crash"); } } }))
      .toThrow("crash");
    // The lock is reclaimable; an old writer reads ENOENT as an empty board and writes one project.
    writeLegacy(file, { projects: { fresh: projectState(["/fresh"]) } });

    const outcome = importLegacyBoard(file, { reconcile: true });

    expect(outcome.incident?.summary).toMatchObject({ added: 1, removed: 0 });
    expect(outcome.incident?.message).toContain("no row was deleted");
    expect(boardFor("alpha", file).prefs.manual).toEqual(["/a"]);
    expect(boardFor("beta", file).prefs.manual).toEqual(["/b"]);
    expect(boardFor("fresh", file).prefs.manual).toEqual(["/fresh"]);
    expect(siblings(dir, "board.json.imported-")).toHaveLength(2);
  });

  test("the mirror's revision marker never becomes a board project", () => {
    const { file, db } = sandbox();
    writeLegacy(file, { projects: { repo: projectState(["/a"]) } });
    boardFor("repo", file);
    checkpointBoardRollbackMirrorForDemotion(file);
    const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { projects: Record<string, unknown> };
    expect(Object.keys(mirror.projects)).toHaveLength(2);
    mirror.projects.added = projectState(["/added"]);
    writeLegacy(file, mirror);

    importLegacyBoard(file, { reconcile: true });

    const Database = (process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite")).Database;
    const sqlite = new Database(db, { readonly: true });
    try {
      const keys = sqlite.query<{ row_key: string }, []>("SELECT row_key FROM state_rows WHERE collection = 'board'").all();
      expect(keys.map((row) => row.row_key).sort()).toEqual(["p:added", "p:repo"]);
    } finally {
      sqlite.close();
    }
  });

  test("an old writer's change to the mirror is folded in before the next checkpoint replaces it", () => {
    const { dir, file, db } = sandbox();
    writeLegacy(file, { projects: { repo: projectState(["/a"]) } });
    boardFor("repo", file);
    checkpointBoardRollbackMirrorForDemotion(file);
    const changed = JSON.parse(fs.readFileSync(file, "utf8")) as { projects: Record<string, unknown> };
    changed.projects["old-writer"] = projectState(["/old"]);
    writeLegacy(file, changed);
    const incidentsBefore = stateImportIncidents().length;

    checkpointBoardRollbackMirrorForDemotion(file);

    expect(boardFor("old-writer", file).prefs.manual).toEqual(["/old"]);
    const raised = stateImportIncidents().slice(incidentsBefore);
    expect(raised.map((incident) => incident.kind)).toEqual(["legacy-reconciled"]);
    expect(raised[0]!.summary).toMatchObject({ added: 1, keys: ["p:old-writer"] });
    expect(siblings(dir, "board.json.imported-")).toHaveLength(2);
    expect(readStateImport(db, "board")?.mirrorSha256)
      .toBe(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    expect(importLegacyBoard(file, { reconcile: true }).incident).toBeNull();
  });

  test("a lazy open never reconciles while a release target exists", () => {
    const { dir, file } = sandbox();
    writeLegacy(file, { projects: { repo: projectState(["/a"]) } });
    boardFor("repo", file);
    checkpointBoardRollbackMirrorForDemotion(file);
    const mirrorText = fs.readFileSync(file, "utf8");
    fs.writeFileSync(path.join(dir, "viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:1", revision: "a".repeat(40) }));

    const outcome = importLegacyBoard(file, { reconcile: false });

    expect(outcome.state).toBe("reconcile-deferred");
    expect(fs.readFileSync(file, "utf8")).toBe(mirrorText);
  });

  test("the causal history a rollback release advanced survives the merge", () => {
    const { file } = sandbox();
    writeLegacy(file, { projects: {} });
    patchBoard("repo", 0, { manual: ["/a"] }, file);
    checkpointBoardRollbackMirrorForDemotion(file);
    const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { projects: Record<string, BoardProjectStateV1> };
    const rolled = mirror.projects.repo!;
    mirror.projects.repo = {
      ...rolled,
      revision: rolled.revision + 1,
      keyRevisions: { ...(rolled.keyRevisions ?? {}), [pathKey("/a")]: rolled.revision + 1 },
      prefs: { ...rolled.prefs, manual: ["/a", "/rollback"] },
    };
    writeLegacy(file, mirror);

    importLegacyBoard(file, { reconcile: true });

    const board = boardFor("repo", file);
    expect(board.prefs.manual).toEqual(["/a", "/rollback"]);
    expect(board.keyRevisions?.[pathKey("/a")]).toBe(rolled.revision + 1);
  });
});
