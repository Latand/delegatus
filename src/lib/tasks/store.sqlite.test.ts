import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { HOT_STATE_RELEASE_REVISION_ENV, publishHotStateAuthority } from "@/lib/state/hotStateAuthority";
import { stateImportIncidents } from "@/lib/state/legacyImport";
import { readStateCollectionRevision, readStateImport, StateImportVerificationError, stateRowDigest } from "@/lib/state/sqliteStateStore";

import { createTask, patchTask } from "./commands";
import {
  checkpointTaskRollbackMirrorForDemotion,
  importLegacyTasks,
  loadTasks,
  loadTasksFile,
  mutateTasks,
  mutateTasksFile,
} from "./store";
import type { BoardTask } from "./types";

/* #1870 slice 1: the task store runs on the `tasks` collection of the
   `state.sqlite` beside its legacy path. Every case uses its own mkdtemp
   directory, never the live state directory. */

const CHILD = path.join(import.meta.dir, "store.sqliteChild.ts");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox(): { dir: string; file: string; db: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-task-sqlite-"));
  dirs.push(dir);
  return { dir, file: path.join(dir, "tasks.json"), db: path.join(dir, "state.sqlite") };
}

function task(id: string, overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    project: "proj",
    status: "inbox",
    text: `task ${id}`,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
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

describe("first-boot import of tasks.json", () => {
  test("imports every task, receipt and migration marker, verifies the digest and leaves a tombstone", () => {
    const { dir, file, db } = sandbox();
    const legacyRows = [
      { ...task("a"), extension: { kept: true } },
      task("b", { status: "done" }),
    ];
    const text = writeLegacy(file, {
      tasks: legacyRows,
      recentCreates: [{ clientRequestId: "req-1", taskId: "a" }],
      migrations: { "board-visibility-v1": "2026-09-02T00:00:00.000Z" },
    });

    const state = loadTasksFile(file);

    expect(state.tasks.map((row) => row.id)).toEqual(["a", "b"]);
    expect((state.tasks[0] as BoardTask & { extension?: unknown }).extension).toEqual({ kept: true });
    expect(state.recentCreates).toEqual([{ clientRequestId: "req-1", taskId: "a" }]);
    expect(state.migrations).toEqual({ "board-visibility-v1": "2026-09-02T00:00:00.000Z" });

    const record = readStateImport(db, "tasks");
    expect(record).not.toBeNull();
    expect(record!.rowCount).toBe(4);
    expect(record!.gap).toBeNull();
    expect(record!.sourceSha256).toBe(crypto.createHash("sha256").update(text).digest("hex"));
    expect(record!.rowDigest).toBe(stateRowDigest([
      ...legacyRows.map((row) => JSON.stringify(row)),
      JSON.stringify({ clientRequestId: "req-1", taskId: "a" }),
      JSON.stringify({ name: "board-visibility-v1", appliedAt: "2026-09-02T00:00:00.000Z" }),
    ]));

    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(file, "README"), "utf8")).toContain("state.sqlite");
    const kept = siblings(dir, "tasks.json.imported-");
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, kept[0]!), "utf8")).toBe(text);
  });

  test("a store with no legacy file starts empty and still leaves a tombstone", () => {
    const { file, db } = sandbox();
    expect(loadTasks(file)).toEqual([]);
    expect(readStateImport(db, "tasks")?.rowCount).toBe(0);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  test("a production-sized corpus imports with an equal digest and loads back identically", () => {
    const { file, db } = sandbox();
    const tasks = Array.from({ length: 1_340 }, (_, index) => task(`t-${index}`, {
      status: index % 3 === 0 ? "done" : "inbox",
      text: `task ${index}\n${"x".repeat(index % 700)}`,
    }));
    const recentCreates = Array.from({ length: 100 }, (_, index) => ({ clientRequestId: `req-${index}`, taskId: `t-${index}` }));
    writeLegacy(file, { tasks, recentCreates });
    const expected = stateRowDigest([...tasks, ...recentCreates].map((row) => JSON.stringify(row)));

    const loaded = loadTasksFile(file);

    expect(readStateImport(db, "tasks")?.rowDigest).toBe(expected);
    expect(loaded.tasks.map((row) => row.id)).toEqual(tasks.map((row) => row.id));
    expect(loaded.recentCreates).toEqual(recentCreates);
  });

  test("(b) a NUL-filled legacy file is recorded as a gap with an incident (the board side is in store.legacyFile.test.ts)", () => {
    const { file, db } = sandbox();
    fs.writeFileSync(file, Buffer.alloc(4096, 0));
    const before = stateImportIncidents().length;

    expect(loadTasks(file)).toEqual([]);

    expect(readStateImport(db, "tasks")?.gap).toBe("legacy-unreadable");
    const incident = stateImportIncidents().slice(before).find((entry) => entry.collection === "tasks");
    expect(incident?.kind).toBe("legacy-unreadable");
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  test("duplicate create receipts import as the newest per request, digested as imported and reported", () => {
    const { file, db } = sandbox();
    writeLegacy(file, {
      tasks: [task("live")],
      recentCreates: [
        { clientRequestId: "retried", taskId: "deleted" },
        { clientRequestId: "retried", taskId: "live" },
      ],
    });

    const outcome = importLegacyTasks(file, { reconcile: true });

    expect(outcome.state).toBe("imported");
    expect(outcome.incident?.kind).toBe("legacy-repaired");
    expect(outcome.incident?.message).toContain("dropped 1 older duplicate create receipt");
    const record = readStateImport(db, "tasks")!;
    expect(record.rowCount).toBe(2);
    expect(record.rowDigest).toBe(stateRowDigest([
      JSON.stringify(task("live")),
      JSON.stringify({ clientRequestId: "retried", taskId: "live" }),
    ]));
    expect(loadTasksFile(file).recentCreates).toEqual([{ clientRequestId: "retried", taskId: "live" }]);
  });

  test("valid JSON with an invalid task row refuses the import and leaves the file untouched", () => {
    const { file, db } = sandbox();
    const text = writeLegacy(file, { tasks: [{ id: "broken" }] });
    expect(() => loadTasks(file)).toThrow("invalid persisted task row");
    expect(readStateImport(db, "tasks")).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });

  test("(c1) a crash before COMMIT leaves nothing behind and the retry imports", () => {
    const { file, db } = sandbox();
    const text = writeLegacy(file, { tasks: [task("a")] });
    expect(() => importLegacyTasks(file, { reconcile: true, hooks: { beforeVerify: () => { throw new Error("crash"); } } }))
      .toThrow("crash");
    expect(readStateImport(db, "tasks")).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(text);

    expect(importLegacyTasks(file, { reconcile: true }).state).toBe("imported");
    expect(loadTasks(file).map((row) => row.id)).toEqual(["a"]);
  });

  test("(c2) a crash after COMMIT but before the rename finishes without a second import", () => {
    const { dir, file, db } = sandbox();
    writeLegacy(file, { tasks: [task("a")] });
    expect(() => importLegacyTasks(file, { reconcile: true, hooks: { afterCommit: () => { throw new Error("crash"); } } }))
      .toThrow("crash");
    const record = readStateImport(db, "tasks");
    expect(record).not.toBeNull();
    expect(fs.statSync(file).isFile()).toBe(true);

    const outcome = importLegacyTasks(file, { reconcile: true });

    expect(outcome.state).toBe("already-imported");
    expect(outcome.incident).toBeNull();
    expect(readStateImport(db, "tasks")?.importedAt).toBe(record!.importedAt);
    expect(siblings(dir, "tasks.json.imported-")).toHaveLength(1);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  test("(c3) a crash after the rename but before the tombstone finishes the tombstone", () => {
    const { file } = sandbox();
    writeLegacy(file, { tasks: [task("a")] });
    expect(() => importLegacyTasks(file, { reconcile: true, hooks: { afterRename: () => { throw new Error("crash"); } } }))
      .toThrow("crash");
    expect(fs.existsSync(file)).toBe(false);

    expect(importLegacyTasks(file, { reconcile: true }).state).toBe("already-imported");
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(loadTasks(file).map((row) => row.id)).toEqual(["a"]);
  });

  test("(g) an injected digest mismatch leaves the database unmarked and the legacy file untouched", () => {
    const { file, db } = sandbox();
    const text = writeLegacy(file, { tasks: [task("a"), task("b")] });
    expect(() => importLegacyTasks(file, {
      reconcile: true,
      hooks: {
        beforeVerify: (execute) => execute(
          "UPDATE state_rows SET value_json = ? WHERE collection = 'tasks' AND row_key = 't:b'",
          JSON.stringify(task("b", { text: "tampered" })),
        ),
      },
    })).toThrow(StateImportVerificationError);
    expect(readStateImport(db, "tasks")).toBeNull();
    expect(readStateCollectionRevision(db, "tasks")).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(text);
  });
});

describe("writes after the import", () => {
  test("only the changed task row is rewritten; untouched rows stay exactly as stored", () => {
    const { file, db } = sandbox();
    const legacyB = { ...task("b"), legacyOnly: 1 };
    writeLegacy(file, { tasks: [task("a"), legacyB] });
    loadTasks(file);
    const revision = readStateCollectionRevision(db, "tasks")!;

    mutateTasks((tasks) => ({ tasks: tasks.map((row) => row.id === "a" ? { ...row, text: "edited" } : row), result: undefined }), file);

    expect(readStateCollectionRevision(db, "tasks")).toBe(revision + 1);
    const rows = loadTasks(file);
    expect(rows.find((row) => row.id === "a")?.text).toBe("edited");
    const Database = (process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite")).Database;
    const sqlite = new Database(db, { readonly: true });
    try {
      const stored = sqlite.query<{ value_json: string; row_revision: number }, []>(
        "SELECT value_json, row_revision FROM state_rows WHERE collection = 'tasks' AND row_key = 't:b'",
      ).get()!;
      expect(stored.value_json).toBe(JSON.stringify(legacyB));
      expect(stored.row_revision).toBe(revision);
    } finally {
      sqlite.close();
    }
  });

  test("a create and its receipt replay stay idempotent across the import", () => {
    const { file } = sandbox();
    writeLegacy(file, { tasks: [] });
    const create = () => mutateTasksFile((state) => {
      const created = createTask(state.tasks, { project: "proj", text: "Once", placement: "unplaced", clientRequestId: "same-request" }, state.recentCreates);
      if (!created.ok) throw new Error(created.error);
      return {
        state: created.replay ? undefined : { tasks: created.tasks, recentCreates: created.recentCreates },
        result: created.task.id,
      };
    }, file);

    const first = create();
    const replay = create();

    expect(replay).toBe(first);
    expect(loadTasks(file)).toHaveLength(1);
    expect(loadTasksFile(file).recentCreates).toEqual([{ clientRequestId: "same-request", taskId: first }]);
  });

  test("migration markers survive a tasks-only write", () => {
    const { file } = sandbox();
    writeLegacy(file, { tasks: [task("a")], migrations: { once: "2026-09-01T00:00:00.000Z" } });
    mutateTasks((tasks) => ({ tasks: tasks.filter((row) => row.id !== "a"), result: undefined }), file);
    const state = loadTasksFile(file);
    expect(state.tasks).toEqual([]);
    expect(state.migrations).toEqual({ once: "2026-09-01T00:00:00.000Z" });
  });

  test("a write from another process moves the collection revision the files route keys on", async () => {
    const { file, db } = sandbox();
    writeLegacy(file, { tasks: [task("a")] });
    loadTasks(file);
    const before = readStateCollectionRevision(db, "tasks")!;

    const child = spawnChild(["append", file, "1"]);
    expect(await child.exited).toBe(0);

    expect(readStateCollectionRevision(db, "tasks")).toBe(before + 1);
    expect(loadTasks(file)).toHaveLength(2);
  });
});

describe("cross-process durability", () => {
  test("(a) a writer killed mid-transaction loses only that transaction", async () => {
    const { dir, file, db } = sandbox();
    writeLegacy(file, { tasks: [task("a")] });
    loadTasks(file);
    const before = readStateCollectionRevision(db, "tasks");
    const ready = path.join(dir, "ready");

    const child = spawnChild(["hold-mutate", file, ready]);
    await waitForFile(ready);
    child.kill("SIGKILL");
    await child.exited;

    expect(readStateCollectionRevision(db, "tasks")).toBe(before);
    expect(loadTasks(file).map((row) => row.id)).toEqual(["a"]);
    // The dead writer's lease is reclaimed and the next write lands.
    mutateTasks((tasks) => ({ tasks: [...tasks, task("b")], result: undefined }), file);
    expect(loadTasks(file).map((row) => row.id)).toEqual(["a", "b"]);
  });

  test("an importer killed inside its transaction leaves the file for the next importer", async () => {
    const { dir, file, db } = sandbox();
    const text = writeLegacy(file, { tasks: [task("a")] });
    const ready = path.join(dir, "ready");

    const child = spawnChild(["hold-import", file, ready]);
    await waitForFile(ready);
    child.kill("SIGKILL");
    await child.exited;

    expect(readStateImport(db, "tasks")).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe(text);
    expect(importLegacyTasks(file, { reconcile: true }).state).toBe("imported");
    expect(loadTasks(file).map((row) => row.id)).toEqual(["a"]);
  });

  test("(d) two processes importing at once import exactly once and agree on the digest", async () => {
    const { dir, file } = sandbox();
    writeLegacy(file, { tasks: Array.from({ length: 200 }, (_, index) => task(`t-${index}`)) });
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
    expect(siblings(dir, "tasks.json.imported-")).toHaveLength(1);
    expect(loadTasks(file)).toHaveLength(200);
  });

  test("concurrent writers in two processes lose no update", async () => {
    const { dir, file } = sandbox();
    writeLegacy(file, { tasks: [] });
    loadTasks(file);
    const gate = path.join(dir, "go");
    const children = [0, 1].map(() => spawnChild(["append", file, "15", gate]));
    await Bun.sleep(100);
    fs.writeFileSync(gate, "go");
    for (const child of children) expect(await child.exited).toBe(0);

    expect(loadTasks(file)).toHaveLength(30);
  });
});

describe("(f) rollback mirror and roll-forward", () => {
  test("an untouched mirror is dropped on roll-forward without a second kept copy", () => {
    const { dir, file, db } = sandbox();
    writeLegacy(file, { tasks: [task("a")], recentCreates: [{ clientRequestId: "req", taskId: "a" }] });
    loadTasks(file);
    mutateTasks((tasks) => ({ tasks: [...tasks, task("b")], result: undefined }), file);

    checkpointTaskRollbackMirrorForDemotion(file);

    const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: BoardTask[]; recentCreates: unknown[] };
    expect(mirror.tasks.map((row) => row.id)).toEqual(["a", "b"]);
    expect(mirror.recentCreates).toEqual([{ clientRequestId: "req", taskId: "a" }]);
    expect(readStateImport(db, "tasks")?.mirrorRevision).toBe(readStateCollectionRevision(db, "tasks"));

    const outcome = importLegacyTasks(file, { reconcile: true });

    expect(outcome.state).toBe("already-imported");
    expect(outcome.incident).toBeNull();
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(siblings(dir, "tasks.json.imported-")).toHaveLength(1);
  });

  test("edits a rollback release made to the mirror merge back by revision with an incident", () => {
    const { file } = sandbox();
    writeLegacy(file, { tasks: [task("a"), task("b"), task("c")] });
    loadTasks(file);
    // After the fence, the new release changed "c" later than the rollback release did.
    checkpointTaskRollbackMirrorForDemotion(file);
    const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: (BoardTask & { revision?: string })[] };
    mutateTasks((tasks) => ({
      tasks: tasks.map((row) => row.id === "c" ? { ...row, text: "sqlite wins", updatedAt: "2026-09-19T12:00:00.000Z" } : row),
      result: undefined,
    }), file);
    // The rollback release edits "a" and "c" and creates "d" in its JSON.
    mirror.tasks = mirror.tasks.map((row) => {
      if (row.id === "a") return { ...row, text: "rollback edit", updatedAt: "2026-09-19T10:00:00.000Z", revision: `task-v1:${crypto.randomUUID()}` };
      if (row.id === "c") return { ...row, text: "rollback loses", updatedAt: "2026-09-19T11:00:00.000Z", revision: `task-v1:${crypto.randomUUID()}` };
      return row;
    });
    mirror.tasks.push(task("d"));
    writeLegacy(file, mirror);

    const outcome = importLegacyTasks(file, { reconcile: true });

    expect(outcome.incident?.kind).toBe("legacy-reconciled");
    expect(outcome.incident?.summary).toMatchObject({ added: 1, replaced: 1, kept: 1 });
    const byId = new Map(loadTasks(file).map((row) => [row.id, row.text]));
    expect(byId.get("a")).toBe("rollback edit");
    expect(byId.get("b")).toBe("task b");
    expect(byId.get("c")).toBe("sqlite wins");
    expect(byId.get("d")).toBe("task d");
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  test("a presentation-only SQLite edit survives roll-forward while the rollback release edits another row", () => {
    const { file } = sandbox();
    writeLegacy(file, { tasks: [task("a"), task("b")] });
    loadTasks(file);
    checkpointTaskRollbackMirrorForDemotion(file);
    const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: BoardTask[] };
    // A new-code MCP process colours "a" in SQLite; a colour leaves updatedAt unchanged.
    mutateTasks((tasks) => {
      const colored = patchTask(tasks, "a", { color: "coral" });
      if (!colored.ok) throw new Error("colour refused");
      return { tasks: colored.tasks, result: undefined };
    }, file);
    expect(loadTasks(file).find((row) => row.id === "a")?.color).toBe("coral");
    // The rollback release edits only "b" in its JSON.
    mirror.tasks = mirror.tasks.map((row) => row.id === "b" ? { ...row, text: "rollback edit", updatedAt: "2026-09-19T10:00:00.000Z" } : row);
    writeLegacy(file, mirror);

    const outcome = importLegacyTasks(file, { reconcile: true });

    const byId = new Map(loadTasks(file).map((row) => [row.id, row]));
    expect(byId.get("a")?.color).toBe("coral");
    expect(byId.get("b")?.text).toBe("rollback edit");
    expect(outcome.incident?.kind).toBe("legacy-reconciled");
    expect(outcome.incident?.summary).toMatchObject({ replaced: 1, keys: ["t:b"] });
    expect(outcome.incident?.summary?.conflicts).toEqual(["t:a"]);
  });

  test("a task the rollback release deleted stays deleted, and one SQLite changed since the mirror stays", () => {
    const { file } = sandbox();
    writeLegacy(file, { tasks: [task("a"), task("b"), task("c")] });
    loadTasks(file);
    checkpointTaskRollbackMirrorForDemotion(file);
    const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: BoardTask[] };
    mutateTasks((tasks) => ({
      tasks: tasks.map((row) => row.id === "c" ? { ...row, text: "sqlite edit", updatedAt: "2026-09-19T12:00:00.000Z" } : row),
      result: undefined,
    }), file);
    // The rollback release deletes "b" and "c" from its JSON.
    mirror.tasks = mirror.tasks.filter((row) => row.id === "a");
    writeLegacy(file, mirror);

    const outcome = importLegacyTasks(file, { reconcile: true });

    expect(outcome.incident?.summary).toMatchObject({ removed: 1, keys: ["t:b"], conflicts: ["t:c"] });
    expect(loadTasks(file).map((row) => row.id)).toEqual(["a", "c"]);
  });

  test("a mirror an old writer changed is reconciled, kept aside and reported before the next checkpoint replaces it", () => {
    const { dir, file, db } = sandbox();
    writeLegacy(file, { tasks: [task("a")] });
    loadTasks(file);
    checkpointTaskRollbackMirrorForDemotion(file);
    // An old-code MCP process writes a task into the file while it is writable.
    const changed = JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: BoardTask[] };
    changed.tasks.push(task("old-writer"));
    writeLegacy(file, changed);
    const incidentsBefore = stateImportIncidents().length;

    checkpointTaskRollbackMirrorForDemotion(file);

    expect(loadTasks(file).map((row) => row.id)).toEqual(["a", "old-writer"]);
    const mirrored = JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: BoardTask[] };
    expect(mirrored.tasks.map((row) => row.id)).toEqual(["a", "old-writer"]);
    const raised = stateImportIncidents().slice(incidentsBefore);
    expect(raised.map((incident) => incident.kind)).toEqual(["legacy-reconciled"]);
    expect(raised[0]!.summary).toMatchObject({ added: 1, keys: ["t:old-writer"] });
    expect(raised[0]!.preservedAs && fs.existsSync(raised[0]!.preservedAs)).toBe(true);
    expect(siblings(dir, "tasks.json.imported-")).toHaveLength(2);
    // The recorded mirror is the new file, so roll-forward drops it quietly.
    expect(readStateImport(db, "tasks")?.mirrorSha256)
      .toBe(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    expect(importLegacyTasks(file, { reconcile: true }).incident).toBeNull();
  });

  test("the fence owner's checkpoint reconciles an old writer while ordinary writes stay fenced", () => {
    const { dir, file } = sandbox();
    writeLegacy(file, { tasks: [task("a")] });
    loadTasks(file);
    checkpointTaskRollbackMirrorForDemotion(file);
    const changed = JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: BoardTask[] };
    changed.tasks.push(task("old-writer"));
    writeLegacy(file, changed);
    const revision = "c".repeat(40);
    fs.writeFileSync(path.join(dir, "viewer-release.json"), JSON.stringify({ revision, endpoint: "http://127.0.0.1:19005", hotStateBackend: "sqlite-v1" }));
    publishHotStateAuthority(dir, "fencing", revision);
    const previous = process.env[HOT_STATE_RELEASE_REVISION_ENV];
    process.env[HOT_STATE_RELEASE_REVISION_ENV] = revision;
    try {
      expect(() => mutateTasks((tasks) => ({ tasks: [...tasks, task("late")], result: undefined }), file)).toThrow("fenced");

      checkpointTaskRollbackMirrorForDemotion(file);

      expect(loadTasks(file).map((row) => row.id)).toEqual(["a", "old-writer"]);
      const mirrored = JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: BoardTask[] };
      expect(mirrored.tasks.map((row) => row.id)).toEqual(["a", "old-writer"]);
    } finally {
      if (previous === undefined) delete process.env[HOT_STATE_RELEASE_REVISION_ENV];
      else process.env[HOT_STATE_RELEASE_REVISION_ENV] = previous;
    }
  });

  test("a rollback release's duplicate receipt pair merges on roll-forward and the next checkpoint succeeds", () => {
    const { file } = sandbox();
    writeLegacy(file, { tasks: [task("a")], recentCreates: [{ clientRequestId: "retried", taskId: "a" }] });
    loadTasks(file);
    checkpointTaskRollbackMirrorForDemotion(file);
    // The rollback release deletes "a", then the retried create appends a second receipt for "b".
    const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: BoardTask[]; recentCreates: unknown[] };
    mirror.tasks = [task("b")];
    mirror.recentCreates.push({ clientRequestId: "retried", taskId: "b" });
    writeLegacy(file, mirror);

    const outcome = importLegacyTasks(file, { reconcile: true });

    expect(outcome.incident?.kind).toBe("legacy-reconciled");
    expect(outcome.incident?.message).toContain("dropped 1 older duplicate create receipt");
    expect(loadTasks(file).map((row) => row.id)).toEqual(["b"]);
    expect(loadTasksFile(file).recentCreates).toEqual([{ clientRequestId: "retried", taskId: "b" }]);
    const replay = mutateTasksFile((state) => {
      const created = createTask(state.tasks, { project: "proj", text: "Once", placement: "unplaced", clientRequestId: "retried" }, state.recentCreates);
      if (!created.ok) throw new Error(created.error);
      return { state: undefined, result: created };
    }, file);
    expect(replay.ok && replay.replay && replay.task.id).toBe("b");

    expect(() => checkpointTaskRollbackMirrorForDemotion(file)).not.toThrow();
    const next = JSON.parse(fs.readFileSync(file, "utf8")) as { recentCreates: unknown[] };
    expect(next.recentCreates).toEqual([{ clientRequestId: "retried", taskId: "b" }]);
  });

  test("receipts and migration markers a rollback release dropped are unioned back on roll-forward", () => {
    const { file } = sandbox();
    writeLegacy(file, {
      tasks: [task("a")],
      recentCreates: [{ clientRequestId: "req", taskId: "a" }],
      migrations: { once: "2026-09-01T00:00:00.000Z" },
    });
    loadTasks(file);
    checkpointTaskRollbackMirrorForDemotion(file);
    // An older release that knows neither section rewrites the file without them.
    const mirror = JSON.parse(fs.readFileSync(file, "utf8")) as { tasks: BoardTask[] };
    writeLegacy(file, { tasks: [...mirror.tasks, task("b")] });

    const outcome = importLegacyTasks(file, { reconcile: true });

    expect(outcome.incident?.summary).toMatchObject({ added: 1, removed: 0, keys: ["t:b"] });
    const state = loadTasksFile(file);
    expect(state.tasks.map((row) => row.id)).toEqual(["a", "b"]);
    expect(state.recentCreates).toEqual([{ clientRequestId: "req", taskId: "a" }]);
    expect(state.migrations).toEqual({ once: "2026-09-01T00:00:00.000Z" });
  });

  test("a lazy open never reconciles while a release target exists", () => {
    const { dir, file } = sandbox();
    writeLegacy(file, { tasks: [task("a")] });
    loadTasks(file);
    checkpointTaskRollbackMirrorForDemotion(file);
    const mirrorText = fs.readFileSync(file, "utf8");
    fs.writeFileSync(path.join(dir, "viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:1", revision: "a".repeat(40) }));

    const outcome = importLegacyTasks(file, { reconcile: false });

    expect(outcome.state).toBe("reconcile-deferred");
    expect(fs.readFileSync(file, "utf8")).toBe(mirrorText);
  });
});
