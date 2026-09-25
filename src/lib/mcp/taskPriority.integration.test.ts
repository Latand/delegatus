/**
 * Task priority through MCP and HTTP: create_task and update_task take it,
 * list_tasks filters by it and carries it in compact rows only when it is not
 * normal, on the indexed read and the in-memory one alike, and both task tools
 * say when to use each level.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { TaskWithRevision } from "@/lib/tasks/revision";

// Establish every state root before importing production bindings.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-priority-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent.sock");
const { viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore } = await import("./server");
const { TASKS_FILE, loadTasks } = await import("@/lib/tasks/store");
const { renderTaskPriorityRule } = await import("@/lib/tasks/priority");
const { NextRequest } = await import("next/server");
const { POST } = await import("@/app/api/tasks/route");
const { PATCH } = await import("@/app/api/tasks/[id]/route");
expect(TASKS_FILE.startsWith(sandbox + path.sep)).toBe(true);

type Row = { id: string; priority?: string; revision: string; project: string; updatedAt: string };
type Answer = { ok: boolean; task: TaskWithRevision; tasks: Row[]; notes?: string[]; changedFields?: string[] };

async function protocol() {
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, `receipts-${Math.random().toString(36).slice(2)}.sqlite`));
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(), receipts));
  const client = new Client({ name: "task-priority-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: { clientRequestId: `priority-${Math.random().toString(36).slice(2)}-${++sequence}`, ...args } })).structuredContent as Answer;
  return { client, call, close: async () => { await client.close(); await server.close(); receipts.close(); } };
}

const stored = (id: string) => loadTasks().find((row) => row.id === id)! as TaskWithRevision;
const json = (url: string, method: string, body: Record<string, unknown>) =>
  new NextRequest(url, { method, headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body) });

test("create_task and update_task take a priority; normal clears it; list_tasks filters by it and shows it only when not normal", async () => {
  const p = await protocol();
  try {
    const high = await p.call("create_task", { project: "priority-project", text: "Fix the broken deploy", priority: "high" });
    expect(high).toMatchObject({ ok: true, task: { priority: "high" } });
    expect(high.changedFields).toContain("priority");
    const normal = await p.call("create_task", { project: "priority-project", text: "Write the notes" });
    const low = await p.call("create_task", { project: "priority-project", text: "Tidy the helpers", priority: "low" });
    const odd = await p.call("create_task", { project: "priority-project", text: "Odd one", priority: "asap" });
    expect(odd.ok).toBe(true);
    expect("priority" in odd.task).toBe(false);
    expect(odd.notes).toEqual(['priority "asap" is not one of high, normal, low, so the task is normal']);
    expect(stored(high.task.id).priority).toBe("high");
    expect("priority" in stored(normal.task.id)).toBe(false);

    const list = async (args: Record<string, unknown> = {}) => (await p.call("list_tasks", { project: "priority-project", ...args })).tasks;
    const rows = await list();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(high.task.id)?.priority).toBe("high");
    expect(byId.get(low.task.id)?.priority).toBe("low");
    expect("priority" in byId.get(normal.task.id)!).toBe(false);
    expect("priority" in byId.get(odd.task.id)!).toBe(false);
    expect((await list({ priority: "high" })).map((row) => row.id)).toEqual([high.task.id]);
    expect((await list({ priority: ["normal"] })).map((row) => row.id).sort()).toEqual([normal.task.id, odd.task.id].sort());
    expect((await list({ priority: "high,low" })).map((row) => row.id).sort()).toEqual([high.task.id, low.task.id].sort());
    /* An unknown value is ignored, as the other filters ignore theirs. */
    expect(await list({ priority: "urgent" })).toHaveLength(4);

    const before = stored(low.task.id);
    const raised = await p.call("update_task", { taskId: low.task.id, priority: "high" });
    expect(raised).toMatchObject({ ok: true, task: { priority: "high" } });
    expect(raised.changedFields).toEqual(["priority"]);
    expect(stored(low.task.id).revision).not.toBe(before.revision);
    expect(stored(low.task.id).updatedAt).toBe(before.updatedAt);
    expect((await list({ priority: "high" })).map((row) => row.id).sort()).toEqual([high.task.id, low.task.id].sort());

    const reset = await p.call("update_task", { taskId: low.task.id, priority: "normal" });
    expect(reset.ok).toBe(true);
    expect("priority" in stored(low.task.id)).toBe(false);
    expect((await list({ priority: "high" })).map((row) => row.id)).toEqual([high.task.id]);
  } finally { await p.close(); }
});

test("the HTTP routes the board uses create and patch a priority", async () => {
  const created = await POST(json("http://localhost/api/tasks", "POST", { project: "priority-http", text: "Answer the incident", placement: "unplaced", priority: "high" }));
  expect(created.status).toBe(200);
  const task = (await created.json() as { task: TaskWithRevision }).task;
  expect(task.priority).toBe("high");
  const patched = await PATCH(
    json(`http://localhost/api/tasks/${task.id}`, "PATCH", { priority: "low", expectedProject: task.project, expectedRevision: task.revision }),
    { params: Promise.resolve({ id: task.id }) },
  );
  expect(patched.status).toBe(200);
  expect(stored(task.id).priority).toBe("low");
  const refused = await PATCH(json(`http://localhost/api/tasks/${task.id}`, "PATCH", { priority: "soon" }), { params: Promise.resolve({ id: task.id }) });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ code: "TASK_INVALID_FIELD", field: "priority" });
});

test("the in-memory list filters and answers priority the same way", async () => {
  const tasks = [
    { id: "t-high", project: "memory", status: "inbox", placement: "unplaced", text: "High", priority: "high", assignments: [], updatedAt: "2026-09-25T10:00:03.000Z" },
    { id: "t-normal", project: "memory", status: "inbox", placement: "unplaced", text: "Normal", assignments: [], updatedAt: "2026-09-25T10:00:02.000Z" },
    { id: "t-low", project: "memory", status: "inbox", placement: "unplaced", text: "Low", priority: "low", assignments: [], updatedAt: "2026-09-25T10:00:01.000Z" },
  ];
  const bindings = viewerMcpBindings(undefined, undefined, { loadTasks: () => tasks, getPipelines: () => ({ pipelines: [] }) } as never);
  const list = async (args: Record<string, unknown>) => ((await bindings.list_tasks({ clientRequestId: `memory-${Math.random()}`, project: "memory", ...args })) as { tasks: Row[] }).tasks;
  expect((await list({})).map((row) => [row.id, row.priority ?? null])).toEqual([["t-high", "high"], ["t-normal", null], ["t-low", "low"]]);
  expect((await list({ priority: "low" })).map((row) => row.id)).toEqual(["t-low"]);
  expect((await list({ priority: "normal" })).map((row) => row.id)).toEqual(["t-normal"]);
});

test("both task tools say when to use each level, and list_tasks names the filter", async () => {
  const p = await protocol();
  try {
    const { tools } = await p.client.listTools();
    const describe = (name: string) => tools.find((tool) => tool.name === name)!;
    expect(describe("create_task").description).toContain(renderTaskPriorityRule());
    expect(describe("update_task").description).toContain(renderTaskPriorityRule());
    const property = (name: string, field: string) => (describe(name).inputSchema.properties as Record<string, { description?: string; enum?: string[] }>)[field];
    expect(property("create_task", "priority")?.description).toContain("high, normal, low");
    expect(property("update_task", "priority")?.enum).toEqual(["high", "normal", "low"]);
    expect(property("list_tasks", "priority")?.description).toContain("only when it is not normal");
  } finally { await p.close(); }
});
