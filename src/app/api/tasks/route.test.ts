import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tasks-read-model-"));
process.env.LLV_STATE_DIR = sandbox;

const route = await import("./route");
const { buildPipeline, loadPipelines, savePipelines } = await import("@/lib/pipelines/store");
const { loadTasks, loadTasksForList, mutateTasks, saveTasks } = await import("@/lib/tasks/store");

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("GET derives pipelineIds including closed history and filters stale task ids", async () => {
  const task: BoardTask = {
    id: "task-read-1",
    project: "viewer",
    status: "assigned",
    text: "Read model",
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const pipeline = buildPipeline({
    id: "history1",
    task: "History",
    taskIds: [task.id, "deleted-task"],
    project: "viewer",
    repoDir: "/repo",
    stages: [{
      id: "run",
      kind: "run",
      "prompt": "run",
      next: null,
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null },
    }],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });
  pipeline.state = "closed";
  pipeline.cursor = null;
  pipeline.closedAt = "later";
  pipeline.hiddenAt = "later";
  saveTasks([task]);
  savePipelines([pipeline]);

  const response = await route.GET(new NextRequest("http://localhost/api/tasks"));
  const body = await response.json() as { tasks: Array<BoardTask & { pipelineIds: string[] }> };

  expect(body.tasks).toEqual([{ ...task, pipelineIds: [pipeline.id] }]);
  /* The read model is derived per answer; neither store is written with it. */
  expect((loadTasks()[0] as BoardTask & { pipelineIds?: string[] }).pipelineIds).toBeUndefined();
  expect((loadPipelines()[0] as Pipeline).taskIds).toEqual([task.id, "deleted-task"]);
});


test("GET answers from the shared frozen list without writing into it, and a write reaches the next GET", async () => {
  const row = (id: string, project: string): BoardTask => ({
    id, project, status: "inbox", text: `Shared ${id}`, placement: "unplaced", assignments: [],
    createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z",
  });
  saveTasks([row("shared-1", "viewer"), row("shared-2", "elsewhere")]);
  savePipelines([]);
  const shared = loadTasksForList();
  expect(Object.isFrozen(shared[0])).toBe(true);
  const snapshot = JSON.stringify(shared);

  const read = async (url: string) => (await (await route.GET(new NextRequest(url))).json()) as { tasks: Array<BoardTask & { pipelineIds: string[] }> };
  const first = await read("http://localhost/api/tasks?project=viewer");
  expect(first.tasks.map((task) => [task.id, task.pipelineIds])).toEqual([["shared-1", []]]);
  expect(loadTasksForList()).toBe(shared);
  expect(JSON.stringify(loadTasksForList())).toBe(snapshot);

  mutateTasks((current) => ({ tasks: current.map((task) => task.id === "shared-1" ? { ...task, text: "Written between reads" } : task), result: null }));
  const second = await read("http://localhost/api/tasks?project=viewer");
  expect(second.tasks[0]?.text).toBe("Written between reads");
  expect(shared[0]?.text).toBe("Shared shared-1");
});

test("empty-project health read loads a board larger than 4 MiB and answers a bounded task list", async () => {
  const tasks: BoardTask[] = Array.from({ length: 1500 }, (_, index) => ({
    id: `health-task-${index}`, project: `health-project-${index % 3}`, status: "inbox",
    text: "x".repeat(3000), placement: "unplaced", assignments: [],
    createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
  }));
  saveTasks(tasks);
  savePipelines([]);
  const full = await route.GET(new NextRequest("http://localhost/api/tasks"));
  expect(full.status).toBe(200);
  expect(Buffer.byteLength(await full.text())).toBeGreaterThan(4 * 1024 * 1024);

  const bounded = await route.GET(new NextRequest("http://localhost/api/tasks?project="));
  expect(bounded.status).toBe(200);
  expect(await bounded.text()).toBe('{"tasks":[]}');
  // Empty projects cannot own tasks, so the probe remains empty as the board grows.
  const refused = await route.POST(new NextRequest("http://localhost/api/tasks", {
    method: "POST", headers: { "content-type": "application/json", host: "localhost" },
    body: JSON.stringify({ project: "", text: "Invalid project", placement: "unplaced" }),
  }));
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toBe("project is required");
  expect(loadTasksForList()).toHaveLength(tasks.length);
});

test("REST creates, patches, lists and undoes a hold without changing another hidden card", async () => {
  const { PATCH } = await import("./[id]/route");
  const createdResponse = await route.POST(new NextRequest("http://localhost/api/tasks", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ project: "motion-fixture", text: "Wait for capacity", placement: "unplaced", hold: { kind: "worker", note: "After a worker is free" } }) }));
  expect(createdResponse.status).toBe(200);
  const created = (await createdResponse.json()).task as BoardTask & { revision: string };
  expect(created.status).toBe("blocked");
  expect(created.hold?.kind).toBe("worker");
  const hidden: BoardTask = { ...created, id: "hidden-hold-fixture", text: "Hidden older work", hold: undefined, groupHidden: { at: created.createdAt, by: "operator", admitted: [] } };
  saveTasks([...loadTasks(), hidden]);
  const send = (row: BoardTask & { revision: string }, body: Record<string, unknown>) => PATCH(new NextRequest("http://localhost/api/tasks", { method: "PATCH", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ ...body, expectedProject: row.project, expectedRevision: row.revision }) }), { params: Promise.resolve({ id: row.id }) });
  const movedResponse = await send(created, { status: "assigned" });
  expect(movedResponse.status).toBe(200);
  const moved = (await movedResponse.json()).task;
  expect(moved.hold).toBeUndefined();
  const restoredResponse = await send(moved, { status: "blocked", restoreHold: created.hold });
  expect(restoredResponse.status).toBe(200);
  expect((await restoredResponse.json()).task.hold).toEqual(created.hold);
  const listed = await route.GET(new NextRequest("http://localhost/api/tasks"));
  const rows = (await listed.json()).tasks as BoardTask[];
  expect(rows.find(row => row.id === created.id)?.hold).toEqual(created.hold);
  expect(rows.find(row => row.id === hidden.id)?.hold).toBeUndefined();
  expect(rows.find(row => row.id === hidden.id)?.groupHidden).toEqual(hidden.groupHidden);
});

test("REST round-trips the 5-of-8 checklist through create, patch and list", async () => {
  const { PATCH } = await import("./[id]/route");
  const steps = [
    ...Array.from({ length: 5 }, (_, index) => ({ id: `fixed-${index + 1}`, text: `Fixed cause ${index + 1}`, state: "done" })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `open-${index + 1}`, text: `Remaining cause ${index + 1}`, state: "open", hold: { kind: "worker", note: "When capacity is free" } })),
  ];
  const createdResponse = await route.POST(new NextRequest("http://localhost/api/tasks", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ project: "motion-fixture", text: "Resolve the audit", placement: "unplaced", steps }) }));
  expect(createdResponse.status).toBe(200);
  const created = (await createdResponse.json()).task as BoardTask & { revision: string };
  expect(created.steps).toHaveLength(8);
  const patchedResponse = await PATCH(new NextRequest("http://localhost/api/tasks", { method: "PATCH", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ steps, expectedProject: created.project, expectedRevision: created.revision }) }), { params: Promise.resolve({ id: created.id }) });
  expect(patchedResponse.status).toBe(200);
  const patched = (await patchedResponse.json()).task as BoardTask;
  expect(patched.steps).toHaveLength(8);
  expect(patched.steps?.[0]).toMatchObject({ id: "fixed-1", state: "done" });
  expect(patched.steps?.[5]).toMatchObject({ id: "open-1", state: "open", hold: { kind: "worker", note: "When capacity is free", by: "operator" } });
  const listed = await route.GET(new NextRequest("http://localhost/api/tasks"));
  expect(((await listed.json()).tasks as BoardTask[]).find(row => row.id === created.id)?.steps).toEqual(patched.steps);
});

test("REST replaces and clears the status note, deriving the operator author", async () => {
  const { PATCH } = await import("./[id]/route");
  const now = "2026-10-02T10:00:00.000Z";
  const task: BoardTask = { id: "note-rest", project: "viewer", text: "Review the card", status: "inbox", placement: "unplaced", assignments: [], createdAt: now, updatedAt: now };
  saveTasks([task]);
  const patch = (body: unknown) => PATCH(new NextRequest("http://localhost/api/tasks/note-rest", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" } }), { params: Promise.resolve({ id: task.id }) });
  const response = await patch({ note: "Waiting for review.", author: { kind: "agent" }, updatedAt: "spoof" });
  expect(response.status).toBe(200);
  const written = await response.json();
  expect(written.task.note).toMatchObject({ text: "Waiting for review.", author: { kind: "operator" } });
  expect(written.task.note.updatedAt).not.toBe("spoof");
  const read = await route.GET(new NextRequest("http://localhost/api/tasks"));
  expect((await read.json()).tasks[0].note).toEqual(written.task.note);
  expect((await patch({ note: "x".repeat(281) })).status).toBe(400);
  expect((await patch({ note: null })).status).toBe(200);
  expect(loadTasks()[0]!.note).toBeUndefined();
});
