import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { boardFor, BoardStoreError, migrateBoardProjects, mutateBoard, patchBoard, remapBoardPaths, transferBoardPathPlacements } from "./store";
import { persistedBoardProjects } from "./storeFixture";
import { validateBoardPatchRequest } from "./validation";

function temporaryFile(): string { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-board-")), "board.json"); }

/* A board.json as an older release left it, in its own directory: the store
   imports it on first use, so a legacy shape has to be seeded before the first
   read rather than written over a store that is already on SQLite (#1870). */
function legacyBoardFile(projects: Record<string, unknown>): string {
  const file = temporaryFile();
  fs.writeFileSync(file, JSON.stringify({ projects }), "utf8");
  return file;
}

describe("board store", () => {
  test("increments revisions atomically and rejects stale concurrent writers", () => {
    const file = temporaryFile();
    expect(boardFor("viewer", file).revision).toBe(0);
    const first = patchBoard("viewer", 0, { manual: ["/a"] }, file);
    expect(first).toMatchObject({ ok: true, board: { revision: 1 } });
    const stale = patchBoard("viewer", 0, { hidden: ["/a"] }, file);
    expect(stale).toMatchObject({ ok: false, board: { revision: 1 } });
    expect(boardFor("viewer", file).prefs.manual).toEqual(["/a"]);
  });
  test("favorites persist across a reload and survive a legacy board with no favorites field", () => {
    const file = temporaryFile();
    const added = mutateBoard("viewer", 0, [{ kind: "set-favorite", id: "conv-1", favorite: true }], file);
    expect(added).toMatchObject({ ok: true, board: { revision: 1 } });
    // Survives a fresh read of the persisted store (a reload/deploy).
    expect(boardFor("viewer", file).prefs.favorites).toEqual(["conv-1"]);
    // A board written before favorites existed reads back with an empty list.
    const legacy = legacyBoardFile({ viewer: {
      schemaVersion: 1, revision: 5, updatedAt: "2026-07-10T00:00:00.000Z",
      prefs: { manual: [], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
    } });
    expect(boardFor("viewer", legacy).prefs.favorites).toEqual([]);
    const seeded = mutateBoard("viewer", 5, [{ kind: "set-favorite", id: "conv-2", favorite: true }], legacy);
    expect(seeded).toMatchObject({ ok: true, board: { revision: 6 } });
    expect(boardFor("viewer", legacy).prefs.favorites).toEqual(["conv-2"]);
  });

  test("engine tray fold + disclosure pins persist across a reload and default on legacy boards", () => {
    const file = temporaryFile();
    mutateBoard("viewer", 0, [{ kind: "set-engine-child-fold", id: "conv-child", path: "/child", folded: true }], file);
    const expanded = mutateBoard("viewer", 1, [{ kind: "set-engine-tray-expanded", parentId: "conv-parent", expanded: true }], file);
    expect(expanded).toMatchObject({ ok: true, board: { revision: 2 } });
    // Survive a fresh read of the persisted store (a reload/redeploy).
    const reloaded = boardFor("viewer", file);
    expect(reloaded.prefs.foldedEngineChildIds).toEqual(["conv-child"]);
    expect(reloaded.prefs.expandedEngineTrayParentIds).toEqual(["conv-parent"]);
    // A board written before the tray pins existed reads back with empty lists.
    const legacy = boardFor("viewer", legacyBoardFile({ viewer: {
      schemaVersion: 1, revision: 5, updatedAt: "2026-07-10T00:00:00.000Z",
      prefs: { manual: [], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
    } }));
    expect(legacy.prefs.foldedEngineChildIds).toEqual([]);
    expect(legacy.prefs.expandedEngineTrayParentIds).toEqual([]);
  });
  test("idle-collapse preference defaults to two hours and persists never", () => {
    const file = temporaryFile();
    expect(boardFor("viewer", file).prefs.idleCollapseMinutes).toBe(120);
    mutateBoard("viewer", 0, [{ kind: "set-presentation", idleCollapseMinutes: null }], file);
    expect(boardFor("viewer", file).prefs.idleCollapseMinutes).toBeNull();
  });
  test("a write committed in one process is durable for the next one", async () => {
    /* The board commits through SQLite with WAL and synchronous=FULL (#1870),
       so durability is no longer this store's own fsync of a JSON file: what it
       owes is that a committed write outlives the process that made it. */
    const file = temporaryFile();
    const modulePath = path.join(import.meta.dir, "store.ts");
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const m = await import(${JSON.stringify(modulePath)}); const written = m.patchBoard("viewer", 0, { manual: ["/durable"] }, ${JSON.stringify(file)}); if (!written.ok) process.exit(2); console.log(written.board.revision);`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe("1");
    expect(boardFor("viewer", file)).toMatchObject({ revision: 1, prefs: { manual: ["/durable"] } });
  });
  test("fails closed on an unusable board and preserves its bytes", () => {
    /* Valid JSON the board cannot mean: the import refuses, every read says so,
       and the file is left exactly as it was for a human to look at. Bytes that
       are not JSON at all are the crash signature #1870 exists for — they are
       kept aside as `.unreadable-*` and the board serves empty instead of 500s
       (src/lib/board/store.legacyFile.test.ts). */
    const file = temporaryFile();
    const text = JSON.stringify({ projects: { viewer: { schemaVersion: 2 } } });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
    expect(() => boardFor("viewer", file)).toThrow(BoardStoreError);
    expect(() => patchBoard("viewer", 0, { manual: ["/a"] }, file)).toThrow(BoardStoreError);
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });
  test("accepts missing storage as revision-zero initialization", () => {
    expect(boardFor("viewer", temporaryFile())).toMatchObject({ revision: 0, prefs: { manual: [] } });
  });
  test("loads a legacy schema-one file with empty path aliases", () => {
    const file = legacyBoardFile({ viewer: {
      schemaVersion: 1, revision: 3, updatedAt: "2026-07-10T00:00:00.000Z",
      prefs: { manual: ["/a"], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false },
    } });
    expect(boardFor("viewer", file).pathAliases).toEqual({});
    expect(boardFor("viewer", file).explicitManual).toEqual(["/a"]);
  });
  test("a semantic no-op preserves the revision and rewrites no row", () => {
    const file = temporaryFile();
    const written = patchBoard("viewer", 0, { manual: ["/a"] }, file);
    expect(written.ok).toBe(true);
    const before = persistedBoardProjects(file);
    const result = mutateBoard("viewer", 1, [{ kind: "restore", path: "/a", placement: "manual" }], file);
    expect(result).toMatchObject({ ok: true, board: { revision: 1 } });
    expect(persistedBoardProjects(file)).toEqual(before);
  });
  test("identical semantic intent from two writers advances once", () => {
    const file = temporaryFile();
    const first = mutateBoard("viewer", 0, [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] }], file);
    const replay = mutateBoard("viewer", 0, [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] }], file);
    expect(first).toMatchObject({ ok: true, board: { revision: 1 } });
    expect(replay).toMatchObject({ ok: true, board: { revision: 1 } });
  });
  test("concurrent processes preserve every successful project mutation", async () => {
    const file = temporaryFile();
    const modulePath = path.join(import.meta.dir, "store.ts");
    const writers = Array.from({ length: 40 }, (_, index) => Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const m = await import(${JSON.stringify(modulePath)}); const result = m.patchBoard(${JSON.stringify(`project-${index}`)}, 0, { manual: [${JSON.stringify(`/path-${index}`)}] }, ${JSON.stringify(file)}); if (!result.ok) process.exit(2);`,
      ],
      stdout: "ignore",
      stderr: "pipe",
    }));

    expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual(Array(40).fill(0));
    expect(Object.keys(persistedBoardProjects(file))).toHaveLength(40);
  });
  /* The board's own `board.json.write-lock` queue is gone with the move to
     SQLite (#1870): writers now serialize on the collection lease. A lease whose
     owner was killed mid-write is reclaimed, and the write that killed process
     never made is the only one lost — proved against a real SIGKILL in
     store.sqlite.test.ts, case (a), with cross-process concurrency beside it. */
  test("path remap clears provisional continuity roots and replays idempotently", () => {
    const file = temporaryFile();
    const project = "viewer";
    patchBoard(project, 0, { manual: ["/fork", "/target"], expanded: ["/source"] }, file);
    const first = remapBoardPaths(
      project,
      [{ from: "/source", to: "/target" }, { from: "/fork", to: "/target" }],
      { provisionalManual: ["/fork"], filePath: file },
    );
    const replay = remapBoardPaths(
      project,
      [{ from: "/source", to: "/target" }, { from: "/fork", to: "/target" }],
      { provisionalManual: ["/fork"], filePath: file },
    );
    expect(first).toMatchObject({
      revision: 2,
      pathAliases: { "/source": "/target", "/fork": "/target" },
      prefs: { manual: [], expanded: ["/target"] },
    });
    expect(replay).toEqual(first);
  });
  test("adopting a fork that holds no placement leaves the root pinned", () => {
    const file = temporaryFile();
    const project = "viewer";
    mutateBoard(project, 0, [{ kind: "restore", path: "/root", placement: "manual" }], file);

    /* The default remap reads the target as provisional and would strip the pin,
       because nothing among the sources carries it back (#708). */
    const provisional = remapBoardPaths(project, [{ from: "/fork", to: "/root" }], { filePath: file });
    expect(provisional.prefs.manual).toEqual([]);
    expect(provisional.explicitManual).toEqual([]);

    const restored = temporaryFile();
    mutateBoard(project, 0, [{ kind: "restore", path: "/root", placement: "manual" }], restored);
    const remapped = remapBoardPaths(project, [{ from: "/fork", to: "/root" }], { filePath: restored, targetPlacementAuthoritative: true });

    expect(remapped).toMatchObject({ pathAliases: { "/fork": "/root" }, prefs: { manual: ["/root"] } });
    expect(remapped.explicitManual).toEqual(["/root"]);
    expect(remapBoardPaths(project, [{ from: "/fork", to: "/root" }], { filePath: restored, targetPlacementAuthoritative: true }))
      .toEqual(remapped);
  });
  test("adopting a fork onto its root keeps the root's placement and favourite", () => {
    const file = temporaryFile();
    const project = "viewer";
    mutateBoard(project, 0, [
      { kind: "restore", path: "/root", placement: "manual" },
      { kind: "restore", path: "/fork", placement: "manual" },
      { kind: "set-favorite", id: "conversation_root", favorite: true },
    ], file);

    const remapped = remapBoardPaths(project, [{ from: "/fork", to: "/root" }], { filePath: file });

    expect(remapped).toMatchObject({
      pathAliases: { "/fork": "/root" },
      prefs: { manual: ["/root"], favorites: ["conversation_root"] },
    });
    expect(remapBoardPaths(project, [{ from: "/fork", to: "/root" }], { filePath: file })).toEqual(remapped);
  });
  test("path remap derives provisional cleanup after a concurrent alias write", async () => {
    /* The remap starts against one board and commits against another: the
       reduction runs under the collection lease, so the alias write that landed
       while the call was in flight is what it derives the cleanup from. */
    const file = temporaryFile();
    const project = "viewer";
    const ready = `${file}.reader-ready`;
    const release = `${file}.reader-release`;
    patchBoard(project, 0, { manual: ["/fork"] }, file);
    const modulePath = path.join(import.meta.dir, "store.ts");
    const writer = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const fs = (await import("node:fs")).default; const m = await import(${JSON.stringify(modulePath)}); m.setBoardWriteHookForTests((phase) => { if (phase !== "before-lease") return; m.setBoardWriteHookForTests(null); fs.writeFileSync(${JSON.stringify(ready)}, ""); while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); }); m.remapBoardPaths(${JSON.stringify(project)}, [{ from: "/source", to: "/target" }, { from: "/fork", to: "/target" }], { provisionalManual: ["/fork"], filePath: ${JSON.stringify(file)} });`,
      ],
      stdout: "ignore",
      stderr: "pipe",
    });
    while (!fs.existsSync(ready)) await Bun.sleep(1);
    remapBoardPaths(project, [{ from: "/fork", to: "/target" }], { filePath: file });
    fs.writeFileSync(release, "", "utf8");

    expect(await writer.exited).toBe(0);
    expect(boardFor(project, file)).toMatchObject({
      pathAliases: { "/fork": "/target", "/source": "/target" },
      prefs: { manual: ["/target"] },
    });
  });
  test("project placement transfer preserves destination user intent", () => {
    const file = temporaryFile();
    const paths = ["/hidden", "/manual", "/expanded"];
    mutateBoard("source", 0, [{
      kind: "remap-paths",
      pairs: paths.map((pathname) => ({ from: `/old${pathname}`, to: pathname })),
    }], file);
    mutateBoard("destination", 0, [
      { kind: "close", path: paths[0]! },
      { kind: "restore", path: paths[1]!, placement: "manual" },
      { kind: "restore", path: paths[2]!, placement: "expanded" },
    ], file);

    transferBoardPathPlacements([{
      fromProject: "source",
      toProject: "destination",
      paths,
    }], file);

    expect(boardFor("destination", file).prefs).toMatchObject({
      hidden: [paths[0]],
      manual: [paths[1]],
      expanded: [paths[2]],
    });
  });
  test("hidden patches preserve an exact alias source through unrelated mutations", () => {
    const file = temporaryFile();
    const project = "archive-exact-alias";
    const earlier = "/sessions/earlier.jsonl";
    const current = "/sessions/current.jsonl";
    mutateBoard(project, 0, [{ kind: "remap-paths", pairs: [{ from: earlier, to: current }] }], file);

    expect(patchBoard(project, 1, { hidden: [earlier, current] }, file)).toMatchObject({
      ok: true,
      applied: true,
      board: {
        pathAliases: { [earlier]: current },
        prefs: { hidden: [earlier, current] },
      },
    });

    expect(mutateBoard(project, 2, [{ kind: "set-presentation", taskPanelOpen: true }], file)).toMatchObject({
      ok: true,
      applied: true,
      board: {
        pathAliases: { [earlier]: current },
        prefs: { hidden: [earlier, current], taskPanelOpen: true },
      },
    });
  });
  test("project placement transfer carries continuity aliases with manual placement", () => {
    const file = temporaryFile();
    const source = "/predecessor";
    const successor = "/successor";
    mutateBoard("source", 0, [
      { kind: "restore", path: source, placement: "manual" },
      { kind: "remap-paths", pairs: [{ from: source, to: successor }] },
    ], file);

    transferBoardPathPlacements([{
      fromProject: "source",
      toProject: "destination",
      paths: [source, successor],
    }], file);
    const repaired = remapBoardPaths("destination", [{ from: source, to: successor }], { filePath: file });

    expect(boardFor("source", file).prefs.manual).toEqual([]);
    expect(repaired).toMatchObject({
      pathAliases: { [source]: successor },
      prefs: { manual: [successor] },
    });
  });
  test("project placement transfer resolves destination intent through carried aliases", () => {
    const file = temporaryFile();
    const source = "/predecessor";
    const successor = "/successor";
    mutateBoard("source", 0, [
      { kind: "restore", path: source, placement: "expanded" },
      { kind: "remap-paths", pairs: [{ from: source, to: successor }] },
    ], file);
    mutateBoard("destination", 0, [
      { kind: "restore", path: source, placement: "manual" },
    ], file);

    transferBoardPathPlacements([{
      fromProject: "source",
      toProject: "destination",
      paths: [source, successor],
    }], file);

    expect(boardFor("destination", file)).toMatchObject({
      pathAliases: { [source]: successor },
      prefs: { manual: [successor], expanded: [] },
    });
  });
  test("many stale projects merge by original timestamp with newer membership roles winning", () => {
    const run = (migrations: Map<string, string>) => {
      const file = temporaryFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const state = (
        updatedAt: string,
        prefs: Partial<{ manual: string[]; hidden: string[]; expanded: string[]; viewMode: "scheme" | "list" | null; taskPanelOpen: boolean }>,
        pathAliases: Record<string, string>,
      ) => ({
        schemaVersion: 1,
        revision: 1,
        updatedAt,
        pathAliases,
        prefs: { manual: [], hidden: [], expanded: [], viewMode: null, taskPanelOpen: false, ...prefs },
      });
      fs.writeFileSync(file, JSON.stringify({ projects: {
        canonical: state("2026-07-10T00:01:00.000Z", { expanded: ["/base"], viewMode: "scheme" }, { "/alias": "/base" }),
        older: state("2026-07-10T00:00:00.000Z", { hidden: ["/a"] }, { "/alias": "/old" }),
        newest: state("2026-07-10T00:02:00.000Z", { manual: ["/a"], expanded: ["/b"], viewMode: "list", taskPanelOpen: true }, { "/alias": "/new" }),
      } }), "utf8");
      boardFor("canonical", file);
      expect(migrateBoardProjects(migrations, file)).toBe(true);
      return persistedBoardProjects(file) as Record<string, { prefs: Record<string, unknown>; pathAliases: Record<string, string> }>;
    };

    const forward = run(new Map([["older", "canonical"], ["newest", "canonical"]]));
    const reverse = run(new Map([["newest", "canonical"], ["older", "canonical"]]));

    expect(forward.older).toBeUndefined();
    expect(forward.newest).toBeUndefined();
    expect(forward.canonical.prefs).toEqual({
      manual: ["/a"], hidden: [], expanded: ["/base", "/b"], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], seenAt: {}, viewMode: "list", taskPanelOpen: true,
    });
    expect(forward.canonical.pathAliases).toEqual({ "/alias": "/new" });
    expect(reverse.canonical.prefs).toEqual(forward.canonical.prefs);
    expect(reverse.canonical.pathAliases).toEqual(forward.canonical.pathAliases);
  });
  test("strict bounded PATCH validation rejects unknown and empty changes", async () => {
    const request = (body: unknown) => new Request("http://127.0.0.1:8898/api/board", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await expect(validateBoardPatchRequest(request({ schemaVersion: 1, project: "viewer", baseRevision: 0, patch: { surprise: true } }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(validateBoardPatchRequest(request({ schemaVersion: 1, project: "viewer", baseRevision: 0, patch: {} }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const parsed = await validateBoardPatchRequest(request({ schemaVersion: 1, project: "viewer", baseRevision: 0, patch: { taskPanelOpen: true } }));
    expect(parsed.patch).toEqual({ taskPanelOpen: true });
  });
  test("mutation validation rejects malformed batches and alias cycles", async () => {
    const request = (body: unknown) => new Request("http://127.0.0.1:8898/api/board", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const valid = { schemaVersion: 1, project: "viewer", baseRevision: 0 };
    for (const mutations of [
      [],
      [{ kind: "unknown" }],
      [{ kind: "close", path: "" }],
      [{ kind: "reconcile-roots", roots: Array.from({ length: 513 }, (_, index) => `/root-${index}`), removeManual: [] }],
      [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/one" }, { from: "/old", to: "/two" }] }],
      [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }, { from: "/new", to: "/old" }] }],
      [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] }, { kind: "remap-paths", pairs: [{ from: "/new", to: "/old" }] }],
      [{ kind: "mark-seen", id: "conv-1", at: -1 }],
      [{ kind: "mark-seen", id: "", at: 1_700 }],
      [{ kind: "mark-seen", id: "conv-1", at: 1_700.5 }],
    ]) {
      await expect(validateBoardPatchRequest(request({ ...valid, mutations }))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    const parsed = await validateBoardPatchRequest(request({ ...valid, mutations: [{ kind: "set-presentation", viewMode: "scheme" }] }));
    expect(parsed.mutations).toEqual([{ kind: "set-presentation", viewMode: "scheme" }]);
    /* An acknowledgement travels as an ordinary mutation (#1244). */
    const seen = await validateBoardPatchRequest(request({ ...valid, mutations: [{ kind: "mark-seen", id: "conv-1", at: 1_700 }] }));
    expect(seen.mutations).toEqual([{ kind: "mark-seen", id: "conv-1", at: 1_700 }]);
  });
});
