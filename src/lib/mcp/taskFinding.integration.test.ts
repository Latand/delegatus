import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BoardTask } from "@/lib/tasks/types";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-task-finding-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "absent.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent-control.sock");
const { viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore } = await import("./server");
const { loadTasks } = await import("@/lib/tasks/store");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("published finding schemas, recurrence, receipts and key updates through MCP", async () => {
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, "receipts.sqlite"));
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(), receipts));
  const client = new Client({ name: "finding-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  let seq = 0;
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { full: true, clientRequestId: `finding-${++seq}`, ...args } });
  const answer = (result: Awaited<ReturnType<typeof call>>) => result.structuredContent as { task: BoardTask; matched?: boolean; code?: string; changedFields: string[] };
  const input = { project: "mcp-findings", text: "Keep the original wording", findingKey: "socket:timeout", note: "First seen" };
  try {
    const { tools } = await client.listTools();
    for (const name of ["create_task", "update_task"]) {
      const properties = tools.find(tool => tool.name === name)!.inputSchema.properties as Record<string, { description?: string }>;
      expect(properties.findingKey.description).toContain("200");
      expect(properties.findingKey.description).toContain("never synced");
    }
    const initial = answer(await call("create_task", input));
    const repeatArgs = { ...input, text: "Reporter title", note: "Repeated", clientRequestId: "repeat-receipt" };
    const repeat = answer(await call("create_task", repeatArgs));
    expect(repeat).toMatchObject({ matched: true, task: { id: initial.task.id, text: input.text, finding: { count: 2 }, note: { text: "Repeated", author: { kind: "agent", conversationId: null } } } });
    expect(repeat.changedFields).toContain("finding");
    expect(repeat.changedFields).toContain("note");
    for (const field of ["text", "status", "assignments", "placement"]) expect(repeat.changedFields).not.toContain(field);
    const replay = answer(await call("create_task", repeatArgs));
    expect(replay.matched).toBe(true);
    expect(replay.task).toEqual(JSON.parse(JSON.stringify(repeat.task)));
    expect(loadTasks().find(task => task.id === initial.task.id)?.finding?.count).toBe(2);
    await call("update_task", { taskId: initial.task.id, status: "done" });
    const next = answer(await call("create_task", input));
    expect(next.task.id).not.toBe(initial.task.id);
    expect(next.task.finding).toMatchObject({ count: 1, previousTaskId: initial.task.id });
    const conflict = await call("update_task", { taskId: initial.task.id, status: "inbox" });
    expect(conflict.isError).toBe(true);
    expect(answer(conflict).code).toBe("TASK_FINDING_KEY_CONFLICT");
    const clear = answer(await call("update_task", { taskId: next.task.id, findingKey: null }));
    expect(clear.task.findingKey).toBeUndefined();
    const changed = answer(await call("update_task", { taskId: next.task.id, findingKey: "new key" }));
    expect(changed.task).toMatchObject({ findingKey: "new key", finding: { count: 1 } });
    const plain = answer(await call("create_task", { project: input.project, text: input.text }));
    expect(plain.matched).toBeUndefined();
    expect(plain.task.findingKey).toBeUndefined();
    for (const findingKey of ["k".repeat(201)]) {
      expect((await call("create_task", { ...input, findingKey })).isError).toBe(true);
      expect((await call("update_task", { taskId: next.task.id, findingKey })).isError).toBe(true);
    }
  } finally { await client.close(); await server.close(); receipts.close(); }
});
