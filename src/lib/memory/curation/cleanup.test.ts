import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTask } from "@/lib/tasks/commands";
import { loadTasks, loadTasksFile, saveTasks } from "@/lib/tasks/store";
import { groupHideState } from "@/lib/tasks/groupHide";
import { initializeStateCollections, SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { lifecycleJournalPath, readLifecycleJournal } from "@/lib/lifecycle/journal";
import { retireCuratorPlaceholdersAtStartup } from "./cleanup";
import { readPass, type CuratorPass } from "./store";

const NOW = "2026-10-17T12:00:00.000Z";
let directory: string, previous: string | undefined;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-curator-retirement-"));
  previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function seed(id: string, project: string, curator = true) {
  const made = createTask([], { project, text: "Role memory curation", placement: "unplaced" }, [], { now: () => NOW, id: () => id });
  if (!made.ok) throw new Error(made.error);
  if (!curator) return made.task;
  const pass: CuratorPass = { kind: "pass", id: `curate_${id}`, project, repoDir: null, scopes: [], clientAttemptId: `curate_${id}`, claimedAt: NOW,
    state: "succeeded", endedAt: NOW, failure: null, conversationId: `conversation_${id}`, launchId: `launch_${id}`, transcriptPath: null, launchedAt: NOW,
    counts: { calls: 0, changed: 0, rewritten: 0, merged: 0, moved: 0, split: 0, archived: 0, restored: 0 } };
  const spec = { collection: "role_memory_curation", schemaVersion: 1, migrationId: "role-memory-curation-v1", key: (row: CuratorPass) => `r:${row.id}`, loadRecords: () => [] };
  const database = path.join(directory, "state.sqlite");
  initializeStateCollections(database, [spec]);
  new SqliteStateCollection<CuratorPass>(database, { ...spec, busyMessage: "fixture busy", clone: structuredClone, decode: value => value as CuratorPass }).boundedPatch(1, tx => tx.put(pass));
  return { ...made.task, status: "assigned" as const, origin: { kind: "launch" as const, key: pass.id, refinement: "titled" as const } };
}
test("startup retires proven curator placeholders across projects and preserves a same-title ordinary task", async () => {
  const ordinary = seed("ordinary", "project-a", false);
  const spoofed = { ...ordinary, id: "unproven", origin: { kind: "launch" as const, key: "curate_unproven", refinement: "titled" as const } };
  saveTasks([seed("a1", "project-a"), seed("b1", "project-b"), seed("a2", "project-a"), ordinary, spoofed], path.join(directory, "tasks.json"));
  expect(await retireCuratorPlaceholdersAtStartup(NOW)).toEqual({ "project-a": 2, "project-b": 1 });
  const tasks = loadTasks(path.join(directory, "tasks.json"));
  for (const id of ["a1", "a2", "b1"]) {
    const task = tasks.find(row => row.id === id)!;
    expect(task).toMatchObject({ status: "done", board: "hidden" });
    expect(groupHideState(task, { members: [], pipelines: [] }).hidden).toBe(true);
  }
  expect(tasks.find(task => task.id === "ordinary")).toEqual(ordinary);
  expect(tasks.find(task => task.id === "unproven")).toEqual(spoofed);
  expect(readPass("curate_a1")?.conversationId).toBe("conversation_a1");
  const before = loadTasksFile(path.join(directory, "tasks.json"));
  expect(await retireCuratorPlaceholdersAtStartup(NOW)).toEqual({});
  expect(loadTasksFile(path.join(directory, "tasks.json"))).toEqual(before);
  const child = Bun.spawn([process.execPath, "--eval", `import { retireCuratorPlaceholdersAtStartup } from './src/lib/memory/curation/cleanup.ts'; console.log(JSON.stringify(await retireCuratorPlaceholdersAtStartup('${NOW}')));`], {
    env: { ...process.env, LLV_STATE_DIR: directory }, stdout: "pipe", stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, error).toBe(0);
  expect(JSON.parse(output)).toEqual({});
  expect(loadTasksFile(path.join(directory, "tasks.json"))).toEqual(before);
  expect(readLifecycleJournal().events.map(event => [event.project, event.summary])).toEqual([
    ["project-a", "Retired and hid 2 curator placeholder tasks."], ["project-b", "Retired and hid 1 curator placeholder tasks."],
  ]);
});
test("loss of startup authority writes neither tasks nor a migration marker", async () => {
  saveTasks([seed("held", "project-a")], path.join(directory, "tasks.json"));
  const before = loadTasksFile(path.join(directory, "tasks.json"));
  await expect(retireCuratorPlaceholdersAtStartup(NOW, () => { throw new Error("release retired"); })).rejects.toThrow("release retired");
  expect(loadTasksFile(path.join(directory, "tasks.json"))).toEqual(before);
});
test("a journal failure replays the committed per-project count on the next startup", async () => {
  saveTasks([seed("retry", "project-a")], path.join(directory, "tasks.json"));
  const journal = lifecycleJournalPath();
  fs.mkdirSync(journal);
  await expect(retireCuratorPlaceholdersAtStartup(NOW)).rejects.toThrow();
  expect(loadTasks(path.join(directory, "tasks.json"))[0].status).toBe("done");
  fs.rmdirSync(journal);
  expect(await retireCuratorPlaceholdersAtStartup(NOW)).toEqual({});
  expect(readLifecycleJournal().events).toHaveLength(1);
  expect(readLifecycleJournal().events[0].summary).toContain("1 curator placeholder");
});
