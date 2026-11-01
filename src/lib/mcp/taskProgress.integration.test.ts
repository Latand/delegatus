import { afterAll, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BoardTask } from "@/lib/tasks/types";
import { withTaskDue } from "@/lib/tasks/taskDue.fixture";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task-progress-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "absent.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent-control.sock");
const { persistProjectAliases } = await import("@/lib/projects/aliases");
persistProjectAliases([{ source: "progress-project-old", target: "progress-project", displayName: "progress-project" }]);
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
beginOrchestratorSeatIntent({ project: "progress-project", mandate: "own the board", clientRequestId: "progress-seat", mode: "existing", conversationId: "conversation_progress_seat" });
completeOrchestratorSeatIntent({ project: "progress-project", clientRequestId: "progress-seat", conversationId: "conversation_progress_seat", path: null });
const { viewerMcpBindings, productionDomainDependencies } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore } = await import("./server");
const { loadTasks } = await import("@/lib/tasks/store");
const { persistedTaskState } = await import("@/lib/tasks/storeFixture");
const { NextRequest } = await import("next/server");
const { POST, GET } = await import("@/app/api/tasks/route");
const { PATCH } = await import("@/app/api/tasks/[id]/route");
const now = "2026-10-26T10:00:00.000Z";
const later = "2026-10-26T11:00:00.000Z";
const by = { kind: "agent" as const, role: "builder", conversationId: "conversation_progress" };
afterAll(() => { setSystemTime(); fs.rmSync(sandbox, { recursive: true, force: true }); });
type Answer = { ok: boolean; task: BoardTask; tasks: BoardTask[]; changedFields: string[]; changes: Record<string, unknown> };

async function protocol() {
  const bindings = viewerMcpBindings(undefined, undefined, {
    ...productionDomainDependencies,
    callerAttribution: () => ({ kind: "agent", role: "builder", conversationId: by.conversationId }),
  });
  const server = createViewerMcpServer(createMcpToolService(bindings, new MemoryMcpReceiptStore()));
  const client = new Client({ name: "progress-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  let seq = 0;
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { clientRequestId: `progress-${++seq}`, ...args } });
  const answer = async (name: string, args: Record<string, unknown>) => (await call(name, args)).structuredContent as Answer;
  return { call, answer, bindings, close: async () => { await client.close(); await server.close(); } };
}
const stored = (id: string) => loadTasks().find(row => row.id === id)!;
const json = (method: string, body: Record<string, unknown>) => new NextRequest("http://localhost/api/tasks", {
  method, headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body),
});

test("MCP creates, updates, reads and clears estimates with server-derived attribution", async () => {
  setSystemTime(new Date(now));
  const p = await protocol();
  try {
    const made = await p.answer("create_task", withTaskDue({ project: "progress-project", text: "Оцінка прогресу", progress: 0,
      by: { kind: "operator" }, setAt: "forged" }));
    const expected = { value: 0, setAt: now, by };
    expect(made).toMatchObject({ ok: true, task: { progress: expected } });
    const id = made.task.id;
    expect(made.changedFields).toContain("progress");
    expect(stored(id).progress).toEqual(expected);
    const absent = await p.answer("create_task", withTaskDue({ project: "progress-project", text: "Ще без оцінки" }));
    const clearedCreate = await p.answer("create_task", withTaskDue({ project: "progress-project", text: "Без початкової оцінки", progress: null }));
    for (const row of [absent.task, clearedCreate.task]) expect(Object.hasOwn(row, "progress")).toBe(false);
    for (const full of [false, true]) {
      expect((await p.answer("get_task", { taskId: id, compact: !full })).task.progress).toEqual(expected);
      const list = await p.answer("list_tasks", { project: "progress-project", full });
      expect(list.tasks.find(row => row.id === id)?.progress).toEqual(expected);
      expect(Object.hasOwn(list.tasks.find(row => row.id === absent.task.id)!, "progress")).toBe(false);
    }
    setSystemTime(new Date(later));
    const changed = await p.answer("update_task", { taskId: id, progress: 100, by: { kind: "operator" }, setAt: "forged" });
    expect(changed).toMatchObject({ ok: true, task: { progress: { value: 100, setAt: later, by } } });
    expect(changed.changedFields).toContain("progress");
    const unchanged = await p.answer("update_task", { taskId: id, details: "Preserve the estimate" });
    expect(unchanged.task.progress).toEqual(changed.task.progress);
    const clear = await p.answer("update_task", { taskId: id, progress: null });
    expect(clear.ok).toBe(true);
    expect(clear.changes.progress).toBeNull();
    expect(clear.changedFields).toContain("progress");
    expect(Object.hasOwn(clear.task, "progress")).toBe(false);
    expect(Object.hasOwn(stored(id), "progress")).toBe(false);
    const refused = await p.call("update_task", { taskId: id, progress: 25, refine: { text: "Назва задачі" } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: "TASK_INVALID_FIELD", details: { field: "progress" } });
    expect(Object.hasOwn(stored(id), "progress")).toBe(false);
  } finally { await p.close(); setSystemTime(); }
});

test("MCP schema and direct bindings refuse invalid estimates atomically on both tools", async () => {
  setSystemTime(new Date(now));
  const p = await protocol();
  try {
    const made = await p.answer("create_task", withTaskDue({ project: "progress-project", text: "Перевірка оцінки", progress: 50, findingKey: "progress-validation" }));
    for (const progress of [-1, 101, 0.5, "50", true, false, [], {}, { value: 50, setAt: now, by }]) {
      for (const [name, args] of [
        ["create_task", withTaskDue({ project: "progress-project", text: "Не створювати", progress })],
        ["create_task", withTaskDue({ project: "progress-project", text: "Не змінювати", findingKey: "progress-validation", progress })],
        ["update_task", { taskId: made.task.id, progress, text: "Не змінювати" }],
      ] as const) {
        const before = persistedTaskState();
        expect((await p.call(name, args)).isError).toBe(true);
        await expect(p.bindings[name]({ ...args, clientRequestId: "progress-direct-invalid" })).rejects.toMatchObject({ details: { code: "TASK_INVALID_FIELD", field: "progress" } });
        expect(persistedTaskState()).toBe(before);
      }
    }
  } finally { await p.close(); setSystemTime(); }
});

test("HTTP writes and the board task read model retain progress, clear and absence", async () => {
  setSystemTime(new Date(now));
  try {
    const response = await POST(json("POST", { project: "progress-http", text: "Оцінка на дошці", placement: "unplaced", progress: 35 }));
    expect(response.status).toBe(200);
    const { task } = await response.json() as { task: BoardTask };
    const expected = { value: 35, setAt: now, by: { kind: "operator" as const } };
    expect(task.progress).toEqual(expected);
    const read = async () => (await (await GET(new NextRequest("http://localhost/api/tasks?project=progress-http"))).json() as { tasks: BoardTask[] }).tasks;
    expect((await read()).find(row => row.id === task.id)?.progress).toEqual(expected);
    const ctx = { params: Promise.resolve({ id: task.id }) };
    for (const progress of [-1, 101, 1.5, "50", false, [], { value: 50 }]) {
      const before = persistedTaskState();
      const refusedCreate = await POST(json("POST", { project: "progress-http", text: "Не створювати", placement: "unplaced", progress }));
      expect(refusedCreate.status).toBe(400);
      const refused = await PATCH(json("PATCH", { progress, text: "Не змінювати" }), ctx);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "TASK_INVALID_FIELD", field: "progress" });
      expect(persistedTaskState()).toBe(before);
    }
    setSystemTime(new Date(later));
    const updated = await PATCH(json("PATCH", { progress: 70, by, setAt: "forged" }), ctx);
    expect(updated.status).toBe(200);
    expect((await updated.json() as { task: BoardTask }).task.progress).toEqual({ ...expected, value: 70, setAt: later });
    const clear = await PATCH(json("PATCH", { progress: null }), ctx);
    expect(clear.status).toBe(200);
    expect(Object.hasOwn((await clear.json() as { task: BoardTask }).task, "progress")).toBe(false);
    expect(Object.hasOwn((await read()).find(row => row.id === task.id)!, "progress")).toBe(false);
  } finally { setSystemTime(); }
});
