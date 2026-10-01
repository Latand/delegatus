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
const { loadTasks, saveTasks } = await import("@/lib/tasks/store");

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
