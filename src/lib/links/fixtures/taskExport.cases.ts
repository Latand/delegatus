import { afterAll, afterEach, expect, spyOn, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

import type { BoardTask } from "@/lib/tasks/types";

import type { RoleMemoryRule } from "@/lib/memory/roleTypes";




const original = process.env.LLV_STATE_DIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-export-"));
process.env.LLV_STATE_DIR = root;
const { mutateTasks } = await import("@/lib/tasks/store");
const { roleMemoryCollection, withoutStoredLessonsIn } = await import("@/lib/memory/roleStore");
const { TaskExchange } = await import("../taskExchange");
const { installPrefix } = await import("../stamp");
const { readScanPage } = await import("../taskFeed");
const fixtureId = (prefix: string, suffix: string) => [prefix, "0000", "4000", "8000", suffix].join("-");
const selfId = fixtureId("10000000", "000000000001");
const peerId = fixtureId("20000000", "000000000002");
const self = { id: selfId, prefix: installPrefix(selfId) };
const peer = { id: peerId, install: peerId, store: fixtureId("30000000", "000000000003") };
const project = `repo-${"a".repeat(32)}`;
const at = "2026-10-16T00:00:00.000Z";
const lesson = "Preserve the cobalt river fixture whenever the sample is renewed.";
afterEach(async () => {
  // A worker is scoped to this root and releases it before cleanup.
  const worker = await import("../taskPageWorker").catch(() => null);
  await worker?.shutdownTaskPageWorker();
  setSystemTime();
});
afterAll(() => {
  if (original === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = original;
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture(count = 3) {
  const collection = roleMemoryCollection(true)!;
  collection.boundedPatch(1, tx => tx.put({ kind: "rule", id: "fixture", scope: "machine", rule: lesson,
    why: "Fixture provenance remains on this installation.", state: "active", hints: [], source: {} as RoleMemoryRule["source"], createdAt: at, changedAt: at }));
  const tasks: BoardTask[] = Array.from({ length: count }, (_, index) => ({
    id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`, project, text: `Sample ${index}: ${lesson}`,
    details: `Nested description: ${lesson}`, status: "inbox", placement: "unplaced", assignments: [], sources: [], createdAt: at, updatedAt: at,
  }));
  mutateTasks(() => ({ tasks, result: null }), path.join(root, "tasks.json"));
  return { root, collection, tasks, exchange: new TaskExchange(peer, self), projects: new Set([project]) };
}

test("export payload keeps the fixed fixture bytes and withholds learned text", async () => {
  const f = fixture();
  const expected = readScanPage("", { self, projects: f.projects, skipPrefix: null, includeBoard: false, includePrototypeReview: false, peerTaskWireVersion: 0 });
  const result = await f.exchange.request(f.projects);
  const bytes = JSON.stringify(result.push?.rows);
  expect(bytes).toBe(JSON.stringify(expected.rows));
  expect(bytes).not.toContain(lesson);
  expect(bytes).toContain("[learned rule]");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("7710d44d20edc176b9d6261ea956b0c59e65f2c5d925678839f68fe8abdafe68");
});

test("unchanged failing exchange reuses its page without cloning memory per task", async () => {
  const f = fixture(40);
  const snapshot = spyOn(f.collection, "snapshot");
  try {
    const first = await f.exchange.request(f.projects);
    const calls = snapshot.mock.calls.length;
    const second = await f.exchange.request(f.projects); // no acknowledgement: failed/malformed peer
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(snapshot.mock.calls.length - calls).toBe(0);
    expect(calls).toBeLessThanOrEqual(1);
  } finally { snapshot.mockRestore(); }
});

test("matcher reads revision before cloning and refreshes after a rule write", () => {
  const f = fixture(); const snapshot = spyOn(f.collection, "snapshot");
  try {
    for (let index = 0; index < 10; index++) expect(withoutStoredLessonsIn({ text: lesson }).text).toBe("[learned rule].");
    expect(snapshot).toHaveBeenCalledTimes(1);
    f.collection.boundedPatch(2, tx => tx.put({ ...tx.get("r:fixture")!, rule: "Another fixture rule covers the silver orchard." } as RoleMemoryRule));
    expect(withoutStoredLessonsIn({ text: "Another fixture rule covers the silver orchard." }).text).toBe("[learned rule].");
  } finally { snapshot.mockRestore(); }
});

test("a replaced privacy database with unchanged size and mtime cannot reuse its old matcher", () => {
  const f = fixture();
  const directory = fs.mkdtempSync(path.join(root, "replacement-"));
  const filename = path.join(directory, "state.sqlite");
  const replacement = path.join(directory, "replacement.sqlite");
  const changedLesson = "Another fixture rule covers the silver orchard.";
  process.env.LLV_STATE_DIR = directory;
  try {
    const collection = roleMemoryCollection(true)!;
    collection.boundedPatch(1, tx => tx.put(f.collection.get("r:fixture")!));
    const database = new Database(filename);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.query("VACUUM INTO ?").run(replacement);
    database.close();
    const other = new Database(replacement);
    const row = collection.get("r:fixture")!;
    other.query("UPDATE state_rows SET value_json = ? WHERE collection = ? AND row_key = ?")
      .run(JSON.stringify({ ...row, rule: changedLesson }), "role_memory", "r:fixture");
    other.close();
    expect(fs.statSync(replacement).size).toBe(fs.statSync(filename).size);
    const stamp = new Date(at);
    fs.utimesSync(filename, stamp, stamp);
    fs.utimesSync(replacement, stamp, stamp);
    expect(withoutStoredLessonsIn({ text: lesson }).text).toBe("[learned rule].");
    fs.renameSync(filename, path.join(directory, "previous.sqlite"));
    fs.renameSync(replacement, filename);
    expect(withoutStoredLessonsIn({ text: changedLesson }).text).toBe("[learned rule].");
  } finally { process.env.LLV_STATE_DIR = root; }
});

test("the worker reuses encoded pages and invalidates task, privacy and capability changes", async () => {
  const f = fixture();
  const { TaskPageWorker } = await import("../taskPageWorker");
  const worker = new TaskPageWorker();
  const filter = { self, projects: f.projects, skipPrefix: null, includeBoard: false, includePrototypeReview: false, peerTaskWireVersion: 0 };
  try {
    const first = await worker.build({ kind: "scan", after: "" }, filter);
    expect(first.builds).toBe(1);
    const retry = await worker.build({ kind: "scan", after: "" }, filter);
    expect(retry.builds).toBe(1);
    expect(JSON.stringify(retry.page)).toBe(JSON.stringify(first.page));
    mutateTasks(() => ({ tasks: f.tasks.map(task => ({ ...task, text: "Another fixture rule covers the silver orchard." })), result: null }));
    const changed = await worker.build({ kind: "scan", after: "" }, filter);
    expect(changed.builds).toBe(2);
    expect(JSON.stringify(changed.page)).toContain("silver orchard");
    f.collection.boundedPatch(2, tx => tx.put({ ...tx.get("r:fixture")!, rule: "Another fixture rule covers the silver orchard." } as RoleMemoryRule));
    const privatePage = await worker.build({ kind: "scan", after: "" }, filter);
    expect(privatePage.builds).toBe(3);
    expect(JSON.stringify(privatePage.page)).not.toContain("silver orchard");
    expect((await worker.build({ kind: "scan", after: "" }, { ...filter, includeBoard: true })).builds).toBe(4);
  } finally { await worker.shutdown(); }
});

test("a failed worker withholds export and a fresh worker retries successfully", async () => {
  const f = fixture();
  const { TaskPageWorker, taskPageWorkerLaunch } = await import("../taskPageWorker");
  const runtime = { launch: { executable: process.execPath, workerPath: path.join(root, "absent-worker.ts") } };
  const worker = new TaskPageWorker(runtime);
  const filter = { self, projects: f.projects, skipPrefix: null };
  try {
    await expect(worker.build({ kind: "scan", after: "" }, filter)).rejects.toThrow("nothing was sent");
    runtime.launch = taskPageWorkerLaunch();
    const answer = await worker.build({ kind: "scan", after: "" }, filter);
    expect("rows" in answer.page && answer.page.rows.length).toBe(3);
    expect(JSON.stringify(answer.page)).not.toContain(lesson);
    await worker.shutdown();
    const restarted = await worker.build({ kind: "scan", after: "" }, filter);
    expect(restarted.builds).toBe(1);
  } finally { await worker.shutdown(); }
});

test("scan and log payloads keep the same bytes through the worker", async () => {
  const f = fixture();
  const { taskFeedSource } = await import("@/lib/tasks/store");
  const { readLogPage } = await import("../taskFeed");
  const { readLogPageInWorker, readScanPageInWorker } = await import("../taskPageWorker");
  const start = taskFeedSource()!.revision();
  mutateTasks(() => ({ tasks: f.tasks.map(task => ({ ...task, text: `Changed: ${lesson}` })), result: null }));
  for (const peerTaskWireVersion of [0, 3, 7]) {
    const filter = { self, projects: f.projects, skipPrefix: null, peerTaskWireVersion };
    expect(JSON.stringify(await readScanPageInWorker("", filter))).toBe(JSON.stringify(readScanPage("", filter)));
    expect(JSON.stringify(await readLogPageInWorker([start], filter))).toBe(JSON.stringify(readLogPage([start], filter)));
  }
});

test("cached pages expire at the done deadline and the LRU evicts its oldest scope", async () => {
  const f = fixture();
  const { DONE_TASK_BOARD_RETENTION_MS } = await import("@/lib/tasks/boardVisibility");
  const { TaskPageBuilder } = await import("../taskPageBuild");
  const now = Date.parse(at) + DONE_TASK_BOARD_RETENTION_MS;
  setSystemTime(new Date(now));
  mutateTasks(() => ({ tasks: f.tasks.map(task => ({ ...task, status: "done" as const, doneAt: at, doneAdmissions: [] })), result: null }));
  const builder = new TaskPageBuilder();
  const filter = { self, projects: [project], skipPrefix: null };
  const first = builder.build({ kind: "scan", after: "", filter });
  expect("rows" in first.page && first.page.rows.length).toBe(3);
  expect(builder.build({ kind: "scan", after: "", filter }).builds).toBe(1);
  setSystemTime(new Date(now + 1));
  const expired = builder.build({ kind: "scan", after: "", filter });
  expect("rows" in expired.page && expired.page.rows).toEqual([]);
  // Empty, disjoint scopes still consume an entry and must evict deterministically.
  for (let index = 0; index < 17; index++) builder.build({ kind: "scan", after: "", filter: { ...filter, projects: [`repo-${String(index).padStart(32, "0")}`] } });
  const before = builder.build({ kind: "scan", after: "", filter: { ...filter, projects: ["repo-" + "0".repeat(32)] } });
  expect(before.builds).toBeGreaterThan(19);
});

test("worker eligibility follows the caller clock and unchanged scanner observations reuse pages", async () => {
  const f = fixture();
  const { TaskPageWorker } = await import("../taskPageWorker");
  const { DONE_TASK_BOARD_RETENTION_MS } = await import("@/lib/tasks/boardVisibility");
  const { TaskPageBuilder } = await import("../taskPageBuild");
  mutateTasks(() => ({ tasks: f.tasks.map(task => ({ ...task, status: "done" as const, doneAt: at, doneAdmissions: [] })), result: null }));
  const now = Date.parse(at) + DONE_TASK_BOARD_RETENTION_MS;
  const filter = { self, projects: f.projects, skipPrefix: null, now };
  const worker = new TaskPageWorker();
  try {
    const live = await worker.build({ kind: "scan", after: "" }, filter);
    expect("rows" in live.page && live.page.rows.length).toBe(3);
    const expired = await worker.build({ kind: "scan", after: "" }, { ...filter, now: now + 1 });
    expect("rows" in expired.page && expired.page.rows).toEqual([]);
  } finally { await worker.shutdown(); }
  const builder = new TaskPageBuilder();
  const request = { kind: "scan" as const, after: "", now, filter: { self, projects: [project], skipPrefix: null }, files: [] };
  const first = builder.build(request);
  expect(builder.build({ ...request, files: [] }).builds).toBe(first.builds);
});

test("pending omission sweeps advance across repeated unchanged log requests", async () => {
  const f = fixture(600);
  const { taskFeedSource } = await import("@/lib/tasks/store");
  const { DONE_TASK_BOARD_RETENTION_MS } = await import("@/lib/tasks/boardVisibility");
  const { TaskPageBuilder } = await import("../taskPageBuild");
  const now = Date.parse(at) + DONE_TASK_BOARD_RETENTION_MS + 2;
  const last = f.tasks.at(-1)!;
  const tasks = f.tasks.map(task => ({ ...task, status: "done" as const, doneAt: at, doneAdmissions: ["late"],
    assignments: task.id === last.id ? [{ conversationId: "late", path: "late", panePid: null, state: "linked" as const, error: null, at }] : [] }));
  mutateTasks(() => ({ tasks, result: null }));
  const builder = new TaskPageBuilder();
  const filter = { self, projects: [project], skipPrefix: null };
  builder.build({ kind: "scan", after: "", filter, now, files: [] });
  const after: [number] = [taskFeedSource()!.revision()];
  const { readLogPage } = await import("../taskFeed");
  const initial = { ...filter, projects: new Set(filter.projects), now, files: [] };
  readLogPage(after, initial);
  readLogPage(after, initial);
  const files = [{ path: "late", conversationId: "late", waitingInput: null, pendingQuestion: {
    kind: "question" as const, toolUseId: "late", transcriptPath: "late", pid: 0, paneTarget: null, askedAt: new Date(now + 1).toISOString(),
  } }];
  const first = builder.build({ kind: "log", after, filter, now, files });
  expect("rows" in first.page && first.page.rows).toEqual([]);
  const second = builder.build({ kind: "log", after, filter, now, files });
  expect("rows" in second.page && second.page.rows.map(row => row.id)).toEqual([last.id]);
}, 30_000);

test("a privacy revision that moves after build refuses final serialization", async () => {
  const f = fixture();
  const { assertTaskExportCurrent } = await import("../taskExportPrivacy");
  const request = await f.exchange.request(f.projects);
  expect(() => assertTaskExportCurrent(request)).not.toThrow();
  f.collection.boundedPatch(2, tx => tx.put({ ...tx.get("r:fixture")!, rule: "Another fixture rule covers the silver orchard." } as RoleMemoryRule));
  expect(() => assertTaskExportCurrent({ ...request })).toThrow("nothing was sent");
  expect(JSON.stringify(request)).not.toContain("privacy-revision");
});

test("an individually unbuildable privacy matcher withholds the task page", async () => {
  const f = fixture();
  const oversized = "oversized ".repeat(1_800);
  f.collection.boundedPatch(2, tx => tx.put({ ...tx.get("r:fixture")!, rule: oversized } as RoleMemoryRule));
  mutateTasks(() => ({ tasks: f.tasks.map(task => ({ ...task, details: oversized })), result: null }));
  const { TaskPageWorker } = await import("../taskPageWorker");
  const entries = ["src/lib/taskPage.worker.ts", ...(process.env.LLV_TASK_PAGE_BUILT_TEST === "1" ? [".next/server/task-page-worker.js"] : [])];
  for (const entry of entries) {
    const worker = new TaskPageWorker({ launch: { executable: process.execPath, workerPath: path.join(process.cwd(), entry) } });
    try { await expect(worker.build({ kind: "scan", after: "" }, { self, projects: f.projects, skipPrefix: null })).rejects.toThrow("nothing was sent"); }
    finally { await worker.shutdown(); }
  }
});

test("unreadable privacy input withholds the page after a successful cached build", async () => {
  const f = fixture(); await f.exchange.request(f.projects);
  const { taskFeedSource } = await import("@/lib/tasks/store");
  const cursor = taskFeedSource()!.revision();
  mutateTasks(() => ({ tasks: f.tasks.map(task => ({ ...task, text: `Changed: ${lesson}` })), result: null }));
  const saved = f.collection.get("r:fixture")!;
  const db = new Database(path.join(f.root, "state.sqlite"));
  db.query("UPDATE state_rows SET value_json = ? WHERE collection = ? AND row_key = ?").run(JSON.stringify({ kind: "rule", id: 7, rule: lesson }), "role_memory", "r:fixture");
  db.query("UPDATE state_collections SET revision = revision + 1 WHERE collection = ?").run("role_memory"); db.close();
  try {
    await expect(Promise.resolve().then(() => f.exchange.request(f.projects))).rejects.toThrow();
    const { readLogPageInWorker } = await import("../taskPageWorker");
    await expect(readLogPageInWorker([cursor], { self, projects: f.projects, skipPrefix: null })).rejects.toThrow();
  }
  finally {
    const restore = new Database(path.join(f.root, "state.sqlite"));
    restore.query("UPDATE state_rows SET value_json = ? WHERE collection = ? AND row_key = ?").run(JSON.stringify(saved), "role_memory", "r:fixture");
    restore.query("UPDATE state_collections SET revision = revision + 1 WHERE collection = ?").run("role_memory"); restore.close();
  }
});

(process.env.LLV_TASK_PAGE_BUILT_TEST === "1" ? test : test.skip)("the compiled worker preserves filtered payload bytes", async () => {
  const f = fixture();
  const { TaskPageWorker } = await import("../taskPageWorker");
  const worker = new TaskPageWorker({ launch: { executable: process.execPath, workerPath: path.join(process.cwd(), ".next/server/task-page-worker.js") } });
  const filter = { self, projects: f.projects, skipPrefix: null };
  try {
    const result = await worker.build({ kind: "scan", after: "" }, filter);
    expect(JSON.stringify(result.page)).toBe(JSON.stringify(readScanPage("", filter)));
    expect(JSON.stringify(result.page)).not.toContain(lesson);
  } finally { await worker.shutdown(); }
});
