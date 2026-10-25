import { withTaskDue } from "@/lib/tasks/taskDue.fixture";
import { afterAll, expect, spyOn, test } from "bun:test";
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
const { persistProjectAliases } = await import("@/lib/projects/aliases");
expect(persistProjectAliases([
  { source: "mcp-findings-fixture-old", target: "mcp-findings", displayName: "mcp-findings" },
])).toBe(true);
const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
for (const project of ["mcp-findings", "finding-maintenance"]) {
  const clientRequestId = `finding-seat-${project}`;
  const conversationId = `conversation-${project}`;
  beginOrchestratorSeatIntent({ project, mandate: "own the board", clientRequestId, mode: "existing", conversationId });
  completeOrchestratorSeatIntent({ project, clientRequestId, conversationId, path: null });
}
const { viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore, SqliteMcpReceiptStore } = await import("./server");
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
    const initial = answer(await call("create_task", withTaskDue(input)));
    const repeatArgs = { ...input, text: "Reporter title", note: "Repeated", clientRequestId: "repeat-receipt" };
    const repeat = answer(await call("create_task", withTaskDue(repeatArgs)));
    expect(repeat).toMatchObject({ matched: true, task: { id: initial.task.id, text: input.text, finding: { count: 2 }, note: { text: "Repeated", author: { kind: "agent", conversationId: null } } } });
    expect(repeat.changedFields).toContain("finding");
    expect(repeat.changedFields).toContain("note");
    for (const field of ["text", "status", "assignments", "placement"]) expect(repeat.changedFields).not.toContain(field);
    const replay = answer(await call("create_task", withTaskDue(repeatArgs)));
    expect(replay.matched).toBe(true);
    expect(replay.task).toEqual(JSON.parse(JSON.stringify(repeat.task)));
    expect(loadTasks().find(task => task.id === initial.task.id)?.finding?.count).toBe(2);
    await call("update_task", { taskId: initial.task.id, status: "done" });
    const next = answer(await call("create_task", withTaskDue(input)));
    expect(next.task.id).not.toBe(initial.task.id);
    expect(next.task.finding).toMatchObject({ count: 1, previousTaskId: initial.task.id });
    const conflict = await call("update_task", { taskId: initial.task.id, status: "inbox" });
    expect(conflict.isError).toBe(true);
    expect(answer(conflict).code).toBe("TASK_FINDING_KEY_CONFLICT");
    const clear = answer(await call("update_task", { taskId: next.task.id, findingKey: null }));
    expect(clear.task.findingKey).toBeUndefined();
    const changed = answer(await call("update_task", { taskId: next.task.id, findingKey: "new key" }));
    expect(changed.task).toMatchObject({ findingKey: "new key", finding: { count: 1 } });
    const plain = answer(await call("create_task", withTaskDue({ project: input.project, text: input.text })));
    expect(plain.matched).toBeUndefined();
    expect(plain.task.findingKey).toBeUndefined();
    for (const findingKey of ["k".repeat(201)]) {
      expect((await call("create_task", withTaskDue({ ...input, findingKey }))).isError).toBe(true);
      expect((await call("update_task", { taskId: next.task.id, findingKey })).isError).toBe(true);
    }
  } finally { await client.close(); await server.close(); receipts.close(); }
});

test("a recurring create remains an update for maintenance permissions", async () => {
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const { mutateTasks } = await import("@/lib/tasks/store");
  const { createTask } = await import("@/lib/tasks/commands");
  const { claimMaintenanceRun, patchMaintenanceRun, readMaintenanceRun } = await import("@/lib/boardMaintenance/store");
  const worker = "conversation_finding-maintainer";
  const project = "finding-maintenance";
  const snapshot = structuredClone(new AgentRegistry(path.join(sandbox, "finding-registry.json")).readOnlySnapshot());
  snapshot.conversations[worker] = { id: worker, agentRole: "maintainer", projectOwnership: { project }, generations: [], continuityPaths: [], abandonedContinuityPaths: [], migration: null } as never;
  const domain = { callerAttribution: () => ({ kind: "agent", conversationId: worker, role: "builder" }), registrySnapshot: () => snapshot, listPipelineRecords: () => [], operatorLocale: () => "uk" };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain as never));
  let seq = 0;
  const call = (tool: string, args: Record<string, unknown>) => service.callTool(tool, { clientRequestId: `finding-maintenance-${++seq}`, ...args });
  const made = mutateTasks(tasks => {
    const result = createTask(tasks, { project, text: "Збережений заголовок", details: "Operator context", placement: "unplaced", findingKey: "maintenance:recurrence" });
    if (!result.ok) throw new Error(result.error);
    return { tasks: result.tasks, result: result.task };
  });
  const claimed = claimMaintenanceRun({ project, now: Date.now(), intervalHours: 3, seat: { conversationId: "fixture-seat", seatEpoch: 1 }, repoDir: "/fixtures/repository" });
  if (!claimed.claimed) throw new Error("claim expected");
  patchMaintenanceRun(claimed.run.runId, { conversationId: worker, state: "running" });
  try {
    expect(await call("update_task", { taskId: made.id, details: "Replacement" })).toMatchObject({ ok: false, code: "maintainer_details_overwrite_refused" });
    expect(await call("create_task", withTaskDue({ project, text: "Новий звіт", findingKey: made.findingKey, note: "Повторено" }))).toMatchObject({ ok: true, matched: true });
    const run = readMaintenanceRun(claimed.run.runId)!;
    expect(run.counts.created).toBe(0);
    expect(run.log.changes).toHaveLength(1);
    expect(run.log.changes[0]).toMatchObject({ taskId: made.id, tool: "update_task" });
    expect(await call("update_task", { taskId: made.id, details: "Replacement" })).toMatchObject({ ok: false, code: "maintainer_details_overwrite_refused" });
    expect(loadTasks().find(task => task.id === made.id)).toMatchObject({ text: made.text, details: made.details, finding: { count: 2 } });
  } finally { patchMaintenanceRun(claimed.run.runId, { state: "succeeded" }); }
});


test("new agent tasks require dates before any receipt, including direct bindings", async () => {
  const { updateOperatorSettings } = await import("@/lib/operator/settings");
  expect(updateOperatorSettings({ timeZone: "Asia/Tokyo" })).not.toBeNull();
  const bindings = viewerMcpBindings();
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, "due-policy-receipts.sqlite"));
  const claims = spyOn(receipts, "claim");
  const service = createMcpToolService(bindings, receipts);
  const input = { project: "mcp-findings", text: "A new dated outcome", clientRequestId: "due-policy-create", full: true, requireDue: false, defaultDue: true };
  const before = JSON.stringify(loadTasks());
  const { loadTasksFile } = await import("@/lib/tasks/store");
  const beforeReceipts = JSON.stringify(loadTasksFile().recentCreates);
  try {
    for (const dueAt of [undefined, null, ""]) {
      expect(await service.callTool("create_task", { ...input, dueAt })).toMatchObject({ ok: false, code: "TASK_DUE_REQUIRED", details: { field: "dueAt" } });
      await expect(bindings.create_task({ ...input, dueAt })).rejects.toMatchObject({ details: { code: "TASK_DUE_REQUIRED", field: "dueAt" } });
    }
    await expect(bindings.create_task({ ...input, dueAt: "2000-01-01T00:00:00Z" })).rejects.toMatchObject({ details: { code: "TASK_DUE_PAST", field: "dueAt" } });
    for (const dueAt of [42, "invalid", {}, []]) {
      await expect(bindings.create_task({ ...input, dueAt })).rejects.toMatchObject({ details: { code: "TASK_INVALID_FIELD" } });
    }
    expect(claims).not.toHaveBeenCalled();
    expect(JSON.stringify(loadTasks())).toBe(before);
    expect(JSON.stringify(loadTasksFile().recentCreates)).toBe(beforeReceipts);
    // Project admission must still run before a receipt is reserved.
    expect(await service.callTool("create_task", withTaskDue({ ...input, project: "due-policy-no-such-project" })))
      .toMatchObject({ ok: false, code: "unknown_project" });
    expect(claims).not.toHaveBeenCalled();
    // The refused key is still usable for the corrected request.
    const made = await service.callTool("create_task", withTaskDue(input));
    expect(made).toMatchObject({ ok: true, task: { dueTz: "Asia/Tokyo", dueAt: withTaskDue({}).dueAt } });
    expect(claims).toHaveBeenCalledTimes(1);
    const restarted = createMcpToolService(viewerMcpBindings(), receipts);
    expect(await restarted.callTool("create_task", withTaskDue(input))).toMatchObject({ ok: true, replayed: true });
  } finally { claims.mockRestore(); receipts.close(); }
});

test("the protocol requires dueAt and reports TASK_DUE_REQUIRED without reserving a receipt", async () => {
  const receipts = new MemoryMcpReceiptStore();
  const claims = spyOn(receipts, "claim");
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(), receipts));
  const client = new Client({ name: "task-date-policy-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    const tool = (await client.listTools()).tools.find(tool => tool.name === "create_task")!;
    expect(tool.inputSchema.required).toContain("dueAt");
    for (const dueAt of [undefined, null, ""]) {
      const result = await client.callTool({ name: "create_task", arguments: { project: "mcp-findings", text: "Missing a date", clientRequestId: "missing-date-protocol", dueAt } });
      expect(result.structuredContent).toMatchObject({ ok: false, code: "TASK_DUE_REQUIRED", details: { field: "dueAt" } });
      expect(result.isError).toBe(true);
    }
    expect(claims).not.toHaveBeenCalled();
  } finally { claims.mockRestore(); await client.close(); await server.close(); }
});
