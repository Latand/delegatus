import { afterAll, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
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
const { saveTasks, loadTasks, taskSelectionSource } = await import("@/lib/tasks/store");
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
  const receiptsFile = path.join(sandbox, "receipts.sqlite");
  const receipts = new SqliteMcpReceiptStore(receiptsFile);
  const server = createViewerMcpServer(createMcpToolService(bindings, receipts));
  const client = new Client({ name: "task-due-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let sequence = 0;
  let tasksDb: Database | undefined;
  try {
    setSystemTime(new Date(now));
    saveTasks([initial]);
    await Promise.all([client.connect(a), server.connect(b)]);
    const schema = (await client.listTools()).tools.find(tool => tool.name === "update_task")!.inputSchema;
    expect(schema.properties).toHaveProperty("dueReason");
    const before = loadTasks()[0]!;
    tasksDb = new Database(taskSelectionSource()!.filename, { readonly: true });
    const storedRows = () => tasksDb!.query("SELECT * FROM state_rows WHERE collection='tasks' ORDER BY row_key").all();
    const beforeRows = storedRows();
    for (const [patch, code] of [
      [{ dueAt: future }, "TASK_DUE_REASON_REQUIRED"],
      [{ dueAt: future, dueReason: " " }, "TASK_DUE_REASON_REQUIRED"],
      [{ dueAt: future, dueReason: "x".repeat(201) }, "TASK_DUE_REASON_REQUIRED"],
      [{ dueAt: past, dueReason: "Move" }, "TASK_DUE_PAST"],
      [{ dueAt: null }, "TASK_DUE_REQUIRED"],
      [{ dueAt: null, dueTz: null }, "TASK_DUE_REQUIRED"],
    ] as const) {
      await expect(bindings.update_task({ taskId: initial.id, ...patch })).rejects.toMatchObject({ details: { code, field: code === "TASK_DUE_REASON_REQUIRED" ? "dueReason" : "dueAt", status: 400 } });
      expect(loadTasks()[0]).toEqual(before);
      expect(storedRows()).toEqual(beforeRows);
    }
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name,
      arguments: { clientRequestId: `due-call-${++sequence}`, full: true, ...args } })).structuredContent as { ok: boolean; code?: string; task: BoardTask };
    for (const [patch, code, field] of [
      [{ dueAt: future }, "TASK_DUE_REASON_REQUIRED", "dueReason"],
      [{ dueAt: future, dueReason: "  " }, "TASK_DUE_REASON_REQUIRED", "dueReason"],
      [{ dueAt: future, dueReason: "x".repeat(201) }, "TASK_DUE_REASON_REQUIRED", "dueReason"],
      [{ dueAt: past, dueReason: "Move" }, "TASK_DUE_PAST", "dueAt"],
      [{ dueAt: null }, "TASK_DUE_REQUIRED", "dueAt"],
      [{ dueAt: null, dueTz: null }, "TASK_DUE_REQUIRED", "dueAt"],
    ] as const) {
      expect(await call("update_task", { taskId: initial.id, ...patch })).toMatchObject({ ok: false, code, details: { field } });
      expect(loadTasks()[0]).toEqual(before);
      expect(storedRows()).toEqual(beforeRows);
      const db = new Database(receiptsFile, { readonly: true });
      try { expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM mcp_receipts").get()!.count).toBe(0); }
      finally { db.close(); }
    }
    const moved = await call("update_task", { taskId: initial.id, dueAt: future, dueReason: "Dependency completes tomorrow" });
    expect(moved.ok).toBe(true);
    const replay = (await client.callTool({ name: "update_task", arguments: {
      clientRequestId: `due-call-${sequence}`, full: true, taskId: initial.id, dueAt: future, dueReason: "Dependency completes tomorrow",
    } })).structuredContent;
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect((replay as { task: BoardTask }).task).toEqual(JSON.parse(JSON.stringify(moved.task)));
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
    tasksDb?.close();
    await client.close(); await server.close(); receipts.close();
  }
});

test.each(["claim-writer", "locked-writer", "clock-slip", "clock-past"])("date refusal after %s releases only its receipt claim and retries the same key", async mode => {
  const now = "2026-10-23T12:00:00.000Z";
  const past = "2026-10-22T12:00:00.000Z";
  const future = "2026-10-24T12:00:00.000Z";
  const next = "2026-10-26T12:00:00.000Z";
  const initial: BoardTask = { id: `due-race-${mode}`, project: PROJECT, text: "Finish the due work", status: "inbox", placement: "unplaced",
    assignments: [], createdAt: past, updatedAt: past, dueAt: future, dueTz: "UTC" };
  const receiptsFile = path.join(sandbox, `receipts-${mode}.sqlite`);
  const receipts = new SqliteMcpReceiptStore(receiptsFile);
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(), receipts));
  const client = new Client({ name: "task-due-race-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const claim = receipts.claim.bind(receipts);
  let writer: Database | undefined;
  let writerFinished: Promise<void> | undefined;
  let competingTask: BoardTask | undefined;
  const receiptCount = () => {
    const db = new Database(receiptsFile, { readonly: true });
    try { return db.query<{ count: number }, []>("SELECT count(*) AS count FROM mcp_receipts").get()!.count; }
    finally { db.close(); }
  };
  try {
    setSystemTime(new Date(now));
    saveTasks([initial]);
    const before = loadTasks()[0]!;
    await Promise.all([client.connect(a), server.connect(b)]);
    receipts.claim = (...args: Parameters<typeof claim>) => {
      const result = claim(...args);
      if (mode === "claim-writer") {
        saveTasks([{ ...before, dueAt: past }]);
        competingTask = loadTasks()[0];
      } else if (mode === "locked-writer") {
        // Read-only dispatch admission still sees the future date. The task
        // mutation must wait for this writer, then validate its committed row.
        writer = new Database(taskSelectionSource()!.filename);
        writer.exec("BEGIN IMMEDIATE");
        writerFinished = new Promise(resolve => setTimeout(() => {
          writer!.exec("COMMIT");
          saveTasks([{ ...before, dueAt: past }]);
          competingTask = loadTasks()[0];
          resolve();
        }, 0));
      } else setSystemTime(new Date(mode === "clock-slip" ? "2026-10-25T12:00:00.000Z" : "2026-10-27T12:00:00.000Z"));
      return result;
    };
    const args = { clientRequestId: `due-race-${mode}`, full: true, taskId: initial.id, dueAt: next };
    const call = async () => (await client.callTool({ name: "update_task", arguments: args })).structuredContent;
    expect(await call()).toMatchObject({ ok: false, code: mode === "clock-past" ? "TASK_DUE_PAST" : "TASK_DUE_REASON_REQUIRED" });
    await writerFinished;
    expect(loadTasks()[0]).toEqual(competingTask ?? before);
    expect(receiptCount()).toBe(0);
    receipts.claim = claim;
    setSystemTime(new Date(now));
    saveTasks([before]);
    expect(await call()).toMatchObject({ ok: true, replayed: false });
    expect(receiptCount()).toBe(1);
    expect(await call()).toMatchObject({ ok: true, replayed: true });
    expect(receiptCount()).toBe(1);
  } finally {
    await writerFinished;
    writer?.close();
    receipts.claim = claim;
    setSystemTime();
    await client.close(); await server.close(); receipts.close();
  }
});
