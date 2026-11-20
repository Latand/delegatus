import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";

import { openCurrentDatabase } from "./currentDatabase";
import { initializeStateCollections, SqliteStateCollection } from "./sqliteStateStore";
import { doneActivation, readDoneMemory, resetDoneCollectionsForTests, writeDoneProjection } from "@/lib/done/store";
import { buildPipeline, loadPipelines, savePipelines } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import { saveTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";

const directories: string[] = [];

afterEach(() => {
  resetDoneCollectionsForTests();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

test("state write transactions skip task-time preparation on non-task commits while still indexing task writes", () => {
  const dir = tempDir("state-task-times-");
  const filename = path.join(dir, "state.sqlite");
  initializeStateCollections(filename, [{
    collection: "widgets",
    schemaVersion: 1,
    migrationId: "widgets-v1",
    loadRecords: () => [],
    key: (row: { id: string }) => row.id,
  }]);
  const widgets = new SqliteStateCollection<{ id: string; value: number }>(filename, {
    collection: "widgets",
    schemaVersion: 1,
    busyMessage: "widgets busy",
    key: row => row.id,
    decode: value => value && typeof value === "object" ? value as { id: string; value: number } : null,
    clone: structuredClone,
  });
  try {
    widgets.patchSync(() => ({ records: [{ id: "w-0", value: 0 }] }));
    const prepareSpy = spyOn(Database.prototype, "prepare");
    try {
      for (let i = 1; i <= 5; i += 1) {
        widgets.patchSync(() => ({ records: [{ id: "w-0", value: i }] }));
      }
      expect(prepareSpy).toHaveBeenCalledTimes(0);
    } finally {
      prepareSpy.mockRestore();
    }
  } finally {
    widgets.close();
  }

  // Task commits still populate task_due_ms/task_hold_ms/task_updated_ms and drain task_time_pending.
  const tasksFile = path.join(dir, "tasks.json");
  const task: BoardTask = {
    id: "task-1",
    project: "dir-fixture",
    status: "inbox",
    text: "Verify task time projection",
    placement: "auto",
    assignments: [],
    dueAt: "2026-11-20T12:00:00.000Z",
    dueTz: "UTC",
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T11:00:00.000Z",
  };
  saveTasks([task], tasksFile);
  const checkDb = new Database(filename, { readonly: true });
  try {
    const row = checkDb.query<{ task_due_ms: number | null; task_updated_ms: number | null }, []>(
      "SELECT task_due_ms, task_updated_ms FROM state_rows WHERE collection='tasks' AND row_key='t:task-1'",
    ).get();
    expect(row).toEqual({
      task_due_ms: Date.parse("2026-11-20T12:00:00.000Z"),
      task_updated_ms: Date.parse("2026-11-20T11:00:00.000Z"),
    });
    expect(checkDb.query("SELECT 1 FROM task_time_pending LIMIT 1").get()).toBeNull();
  } finally {
    checkDb.close();
  }
});

test("openCurrentDatabase caches bound method wrappers and resets them after inode replacement", () => {
  const dir = tempDir("current-db-cache-");
  const filename = path.join(dir, "sample.sqlite");
  const handle = openCurrentDatabase(filename, () => new Database(filename));
  try {
    handle.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO items VALUES (1, 'first')");
    const q1 = handle.query;
    const q2 = handle.query;
    expect(q1).toBe(q2);

    const replacement = path.join(dir, "replacement.sqlite");
    const next = new Database(replacement);
    next.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO items VALUES (1, 'second')");
    next.close();
    fs.renameSync(replacement, filename);

    const row = handle.query<{ label: string }, []>("SELECT label FROM items WHERE id = 1").get();
    expect(row?.label).toBe("second");
    expect(handle.query).not.toBe(q1);
  } finally {
    handle.close();
  }
});

test("cloneLoadedPipeline clones once per pipeline without re-cloning attempt accounting", () => {
  const dir = tempDir("pipeline-clone-once-");
  const priorStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = dir;
  try {
    const startMs = Date.parse("2026-11-20T10:00:00.000Z");
    const endMs = Date.parse("2026-11-20T10:01:00.000Z");
    const sample = buildPipeline({
      id: "pipe-clone-test",
      task: "Clone once",
      project: "dir-fixture",
      repoDir: "/tmp/fixture-repo",
      stages: [{
        id: "build", kind: "run", prompt: "Build", next: null,
        role: { roleId: "builder", params: { scope: "original" } },
        outputs: ["evidence"],
        effectiveRole: {
          roleId: "builder",
          engine: "codex",
          model: "gpt-6.1-sol",
          effort: "high",
          access: "read-only",
          promptScaffold: "Build {{scope}}",
        },
      }],
      srcPath: null,
      srcConversationId: null,
      now: "2026-11-20T10:00:00.000Z",
    });
    sample.state = "running";
    sample.runs[0]!.attempts = Array.from({ length: 6 }, (_, index) => ({
      n: index + 1,
      state: index < 5 ? "passed" : "running",
      effectiveRole: structuredClone(sample.stages[0]!.effectiveRole),
      launchId: null,
      conversationId: null,
      sessionId: null,
      agentPath: null,
      paneId: null,
      flowId: null,
      startedAt: "2026-11-20T10:00:00.000Z",
      completedAt: index < 5 ? "2026-11-20T10:01:00.000Z" : null,
      input: null,
      activatedBy: null,
      output: null,
      verdict: index < 5 ? { status: "pass", findings: [] } : null,
      error: null,
      accounting: {
        admittedAt: "2026-11-20T10:00:00.000Z",
        startedAt: "2026-11-20T10:00:00.000Z",
        spans: [{ kind: "model", start: startMs, end: endMs }],
        repeatReason: index === 0 ? null : "review-finding",
        time: {
          intervalMs: 60_000,
          modelMs: 60_000,
          toolsMs: null,
          checkQueueMs: null,
          checkRunnerMs: null,
          unknownMs: 0,
          toleranceMs: 0,
        },
      },
    }));
    savePipelines([sample]);
    // Warm cache.
    const first = loadPipelines();
    expect(first).toHaveLength(1);
    const cloneSpy = spyOn(globalThis, "structuredClone");
    let loaded: Pipeline[];
    try {
      loaded = loadPipelines();
      // Exactly one structuredClone for the pipeline (not 1 + 6 attempt.accounting re-clones).
      expect(cloneSpy).toHaveBeenCalledTimes(1);
    } finally {
      cloneSpy.mockRestore();
    }
    expect(loaded[0]!.runs[0]!.attempts).toHaveLength(6);
    // Returned copy is still detached from cached state.
    loaded[0]!.runs[0]!.attempts[0]!.accounting!.spans![0]!.end = startMs;
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accounting!.spans![0]!.end).toBe(endMs);
  } finally {
    if (priorStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = priorStateDir;
  }
});

test("done readDoneMemory and writeDoneProjection avoid deep-cloning untouched rows", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  doneActivation(now);
  const items = Array.from({ length: 40 }, (_, index) => ({
    key: `pr:fixture:${index}`,
    kind: "pr" as const,
    look: "visible" as const,
    project: "dir-fixture",
    at: "2026-11-20T12:00:00.000Z",
    createdAt: "2026-11-20T12:00:00.000Z",
    title: `PR ${index}`,
    icon: null,
    refs: {},
    frame: null,
    frameCheckedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
  }));
  writeDoneProjection({ upserts: items }, now);
  // Warm readonly cache.
  readDoneMemory();
  const snapshotSpy = spyOn(SqliteStateCollection.prototype, "snapshot");
  try {
    const memory = readDoneMemory();
    expect(memory.settled.size).toBe(0);
    const outcome = writeDoneProjection({ upserts: items }, now);
    expect(outcome.updated).toBe(0);
    // Zero full-snapshot clones of all 40 untouched rows.
    expect(snapshotSpy).toHaveBeenCalledTimes(0);
  } finally {
    snapshotSpy.mockRestore();
  }
});
