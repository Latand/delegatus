import { afterAll, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BoardTask } from "@/lib/tasks/types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-due-binding-"));
const restore = { ...process.env };
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "absent.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent-control.sock");
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in restore)) delete process.env[key];
  Object.assign(process.env, restore);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore } = await import("./server");
const { saveTasks, loadTasks } = await import("@/lib/tasks/store");
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
const { NextRequest } = await import("next/server");
const { PATCH } = await import("@/app/api/tasks/[id]/route");
const PROJECT = "due-fixture";
beginOrchestratorSeatIntent({ project: PROJECT, mandate: "Maintain the board", clientRequestId: "due-seat", mode: "existing", conversationId: "conversation_fixture" });
completeOrchestratorSeatIntent({ project: PROJECT, clientRequestId: "due-seat", conversationId: "conversation_fixture", path: null });

test("MCP schema and raw binding enforce rescheduling; get_task returns history; operator HTTP can clear", async () => {
  const now = "2026-10-23T12:00:00.000Z";
  const past = "2026-10-22T12:00:00.000Z";
  const future = "2026-10-24T12:00:00.000Z";
  const initial: BoardTask = { id: "due-integration", project: PROJECT, text: "Finish the due work", status: "inbox", placement: "unplaced",
    assignments: [], createdAt: past, updatedAt: past, dueAt: past, dueTz: "UTC" };
  const bindings = viewerMcpBindings();
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, "receipts.sqlite"));
  const server = createViewerMcpServer(createMcpToolService(bindings, receipts));
  const client = new Client({ name: "task-due-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let sequence = 0;
  try {
    setSystemTime(new Date(now));
    saveTasks([initial]);
    await Promise.all([client.connect(a), server.connect(b)]);
    const schema = (await client.listTools()).tools.find(tool => tool.name === "update_task")!.inputSchema;
    expect(schema.properties).toHaveProperty("dueReason");
    const before = loadTasks()[0]!;
    for (const [patch, code] of [
      [{ dueAt: future }, "TASK_DUE_REASON_REQUIRED"],
      [{ dueAt: future, dueReason: " " }, "TASK_DUE_REASON_REQUIRED"],
      [{ dueAt: future, dueReason: "x".repeat(201) }, "TASK_DUE_REASON_REQUIRED"],
      [{ dueAt: past, dueReason: "Move" }, "TASK_DUE_PAST"],
      [{ dueAt: null }, "TASK_DUE_REQUIRED"],
      [{ dueAt: null, dueTz: null }, "TASK_DUE_REQUIRED"],
    ] as const) {
      await expect(bindings.update_task({ taskId: initial.id, ...patch })).rejects.toMatchObject({ details: { code, status: 400 } });
      expect(loadTasks()[0]).toEqual(before);
    }
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name,
      arguments: { clientRequestId: `due-call-${++sequence}`, full: true, ...args } })).structuredContent as { ok: boolean; code?: string; task: BoardTask };
    for (const [patch, code] of [[{ dueAt: future }, "TASK_DUE_REASON_REQUIRED"], [{ dueAt: past, dueReason: "Move" }, "TASK_DUE_PAST"], [{ dueAt: null }, "TASK_DUE_REQUIRED"]] as const) {
      expect(await call("update_task", { taskId: initial.id, ...patch })).toMatchObject({ ok: false, code });
      expect(loadTasks()[0]).toEqual(before);
    }
    const moved = await call("update_task", { taskId: initial.id, dueAt: future, dueReason: "Dependency completes tomorrow" });
    expect(moved.ok).toBe(true);
    expect(moved.task.dueHistory).toMatchObject({ firstAt: past, slips: 1, last: { at: now, from: past, to: future, by: "agent", reason: "Dependency completes tomorrow" } });
    expect((await call("get_task", { taskId: initial.id })).task.dueHistory).toEqual(moved.task.dueHistory);
    // Before the date passes a later planning move needs no reason and adds no slip.
    const planned = await bindings.update_task({ taskId: initial.id, dueAt: "2026-10-25T12:00:00.000Z", full: true });
    expect((planned.task as BoardTask).dueHistory?.slips).toBe(1);
    const response = await PATCH(new NextRequest("http://localhost/api/tasks/due-integration", {
      method: "PATCH", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ dueAt: null }),
    }), { params: Promise.resolve({ id: initial.id }) });
    expect(response.status).toBe(200);
    const cleared = (await response.json()).task as BoardTask;
    expect(cleared.dueAt).toBeUndefined();
    expect(cleared.dueHistory).toBeUndefined();
    expect(loadTasks()[0]!.dueHistory).toBeUndefined();
  } finally {
    setSystemTime();
    await client.close(); await server.close(); receipts.close();
  }
});
