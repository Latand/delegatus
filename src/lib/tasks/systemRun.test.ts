import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { admitReservedLaunch } from "./launchMembership";
import { groupHideState } from "./groupHide";
import { createTask } from "./commands";
import { loadTasks, saveTasks } from "./store";
import { withSystemRunTask } from "./systemRun";
import { commitTaskMembership } from "./membership";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";
import { buildTaskBands } from "@/components/scheme/taskBands";
import type { SchemeLayout } from "@/components/scheme/layout";
import { buildKanbanModel } from "@/components/kanban/kanbanModel";
import type { FileEntry } from "@/lib/types";

const NOW = "2026-10-17T12:00:00.000Z";
let directory: string;
let previous: string | undefined;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-system-run-"));
  previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function admit(body: Record<string, unknown>) {
  admitReservedLaunch({ engine: "codex", cwd: directory, explicitProject: String(body.project), clientAttemptId: String(body.clientAttemptId), taskIds: [String(body.taskId)] },
    { conversationId: `conversation_${body.clientAttemptId}`, launchId: `launch_${body.clientAttemptId}` }, reason => { throw new Error(reason); }, {
      commit: input => commitTaskMembership(input, path.join(directory, "tasks.json")), pipelineContext: () => null, projectForCwd: () => "fixture",
    });
}
test("service launches reuse one hidden task per project through admission and attribution", async () => {
  for (const attempt of ["curator-first", "relay-owner", "curator-first"]) {
    const body = await withSystemRunTask({ project: "fixture", cwd: directory, clientAttemptId: attempt }, NOW);
    admit(body);
    const tasks = loadTasks(path.join(directory, "tasks.json"));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "done", board: "hidden" });
    expect(groupHideState(tasks[0], { members: [{ path: "transcript.jsonl", pendingQuestion: null, waitingInput: null }], pipelines: [] }).hidden).toBe(true);
  }
  const other = await withSystemRunTask({ project: "other-fixture", clientAttemptId: "other" }, NOW);
  admit(other);
  expect(loadTasks(path.join(directory, "tasks.json"))).toHaveLength(2);
});
test("the board has no card for a live service conversation, while retaining its hidden history", async () => {
  const body = await withSystemRunTask({ project: "fixture", clientAttemptId: "live-curator" }, NOW);
  admit(body);
  const tasks = loadTasks(path.join(directory, "tasks.json"));
  const file = { path: "curator.jsonl", conversationId: "conversation_live-curator", project: "fixture", title: "Role memory curation", root: "codex-sessions", kind: "session", fmt: "codex", engine: "codex", mtime: Date.parse(NOW) / 1000,
    size: 100, activity: "live", proc: null, pid: null, parent: null, model: null, pendingQuestion: null, waitingInput: null, name: "curator" } as FileEntry;
  const node = { file, x: 0, y: 0, w: 600, h: 680, isRoot: true, tasks: [], under: [], lineageOrderKey: "1" };
  const layout = { nodes: [node], groups: [], stacks: [], decks: [], drafts: [], slots: [], regionTasks: [], edges: [], links: [], loops: [], byPath: new Map([[file.path, node]]), width: 600, height: 680 } as unknown as SchemeLayout;
  const projection = projectTaskWorkflows(tasks, [], [], [file]);
  const bands = buildTaskBands(layout, { tasks, projection, untitled: "Untitled", deferDoneVisibility: true });
  const model = buildKanbanModel({ bands, tasks, pipelines: [], projection, files: [file], now: Date.parse(NOW) / 1000 });
  expect(Object.values(model.columns).flatMap(column => column.cards)).toHaveLength(0);
  expect(model.unlinked).toHaveLength(0);
  expect(model.hiddenGroups).toHaveLength(1);
  expect(model.hiddenGroups[0].members[0].file.conversationId).toBe(file.conversationId);
});
test("a fresh process reuses the same system task", async () => {
  const first = await withSystemRunTask({ project: "fixture", clientAttemptId: "first-process" }, NOW);
  const child = Bun.spawn([process.execPath, "--eval", `import { withSystemRunTask } from './src/lib/tasks/systemRun.ts'; console.log(JSON.stringify(await withSystemRunTask({ project: 'fixture', clientAttemptId: 'next-process' }, '${NOW}')));`], {
    env: { ...process.env, LLV_STATE_DIR: directory }, stdout: "pipe", stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, error).toBe(0);
  expect(JSON.parse(output).taskId).toBe(first.taskId);
  expect(loadTasks(path.join(directory, "tasks.json"))).toHaveLength(1);
});
test("explicit tasks and their launch body stay untouched", async () => {
  const body = { project: "fixture", taskId: "operator-task", title: "Board maintenance" };
  expect(await withSystemRunTask(body, NOW)).toBe(body);
  expect(loadTasks(path.join(directory, "tasks.json"))).toHaveLength(0);
});
test("an admitted legacy replay keeps its placeholder target and hides it", async () => {
  const made = createTask([], { project: "fixture", text: "Legacy service run", placement: "unplaced" }, [], { now: () => NOW, id: () => "legacy" });
  if (!made.ok) throw new Error(made.error);
  saveTasks([{ ...made.task, origin: { kind: "launch", key: "legacy-attempt", refinement: "titled" } }], path.join(directory, "tasks.json"));
  const body = await withSystemRunTask({ project: "fixture", clientAttemptId: "legacy-attempt" }, NOW);
  expect(body.taskId).toBe("legacy");
  admit(body);
  expect(loadTasks(path.join(directory, "tasks.json"))).toHaveLength(1);
  expect(groupHideState(loadTasks(path.join(directory, "tasks.json"))[0], { members: [], pipelines: [] }).hidden).toBe(true);
});
test("a task-store refusal prevents the autonomous launch body from being returned", async () => {
  const unusable = path.join(directory, "unusable");
  fs.writeFileSync(unusable, "file");
  process.env.LLV_STATE_DIR = unusable;
  await expect(withSystemRunTask({ project: "fixture", clientAttemptId: "refused" }, NOW)).rejects.toThrow();
});
