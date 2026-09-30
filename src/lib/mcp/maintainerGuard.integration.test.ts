import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test, spyOn } from "bun:test";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-maintenance-mcp-"));
const original = process.env.LLV_STATE_DIR; process.env.LLV_STATE_DIR = root;
const { AgentRegistry } = await import("@/lib/agent/registry");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");
const { loadTasks } = await import("@/lib/tasks/store");
const { claimMaintenanceRun, patchMaintenanceRun, readMaintenanceRun } = await import("@/lib/boardMaintenance/store");
const worker = ["conversation", "fixture-maintainer"].join("_");
const project = "fixture-maintenance";
const snapshot = new AgentRegistry(path.join(root, "fixture-registry.json")).readOnlySnapshot();
snapshot.conversations[worker as `conversation_${string}`] = { id: worker, agentRole: "maintainer", projectOwnership: { project }, generations: [], continuityPaths: [], abandonedContinuityPaths: [], migration: null } as never;
let seq = 0; let role = "maintainer";
const domain = {
  callerAttribution: () => ({ kind: "agent", conversationId: worker, role: "builder" }),
  attentionAuthority: () => ({ kind: "worker", conversationId: worker, role: "builder" }),
  registrySnapshot: () => { snapshot.conversations[worker as `conversation_${string}`].agentRole = role; return snapshot; },
  listPipelineRecords: () => [], operatorLocale: () => "uk",
};
const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain as never));
const call = (tool: string, args: Record<string, unknown>) => service.callTool(tool, { clientRequestId: `maintenance-test-${++seq}`, ...args });
afterAll(() => { if (original === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = original; fs.rmSync(root, { recursive: true, force: true }); });
test("durable maintainer role fences writes on the service wire, independent of claimed role", async () => {
  const denied = await call("send_message", { conversationId: "fixture-target", text: "fixture" }); expect(denied).toMatchObject({ ok: false, code: "maintainer_tool_refused" });
  const result = claimMaintenanceRun({ project, now: Date.now(), intervalHours: 3, seat: { conversationId: "fixture-seat", seatEpoch: 1 }, repoDir: "/fixtures/repository" }); if (!result.claimed) throw new Error("claim expected");
  patchMaintenanceRun(result.run.runId, { conversationId: worker, state: "running" });
  const created = await call("create_task", { project, text: "Перевірка дошки", details: "fixture new task", icon: "brush-cleaning", color: "slate" }); expect(created.ok).toBe(true);
  const task = loadTasks()[0];
  expect(await call("update_task", { taskId: task.id, board: "hidden" })).toMatchObject({ ok: false, code: "maintainer_delete_refused" });
  expect(await call("update_task", { taskId: task.id, removeLine: { index: 0 } })).toMatchObject({ ok: false, code: "maintainer_delete_refused" });
  expect(await call("update_task", { taskId: task.id, project: "another-project" })).toMatchObject({ ok: false, code: "maintainer_project_refused" });
  const updated = await call("update_task", { taskId: task.id, text: "Оновлена перевірка дошки", appendLine: "Maintenance: fixture evidence" }); expect(updated.ok).toBe(true);
  const log = readMaintenanceRun(result.run.runId)!.log; expect(log.changes).toHaveLength(2); expect(log.changes[1].textBefore).toBe(task.text);
  const count = readMaintenanceRun(result.run.runId)!.counts.writes;
  patchMaintenanceRun(result.run.runId, { state: "succeeded" });
  expect(await call("update_task", { taskId: task.id, text: "Пізня зміна" })).toMatchObject({ ok: false, code: "maintainer_run_ended" });
  expect(readMaintenanceRun(result.run.runId)!.counts.writes).toBe(count);
});
test("builder retains normal task writes", async () => {
  const id = ["conversation", "fixture-builder"].join("_");
  snapshot.conversations[id as `conversation_${string}`] = { id, agentRole: "builder", projectOwnership: { project }, generations: [], continuityPaths: [], abandonedContinuityPaths: [], migration: null } as never;
  const builderDomain = { ...domain, callerAttribution: () => ({ kind: "agent", conversationId: id, role: "builder" }) };
  role = "builder";
  const builder = createMcpToolService(viewerMcpBindings(undefined, undefined, builderDomain as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(builderDomain as never));
  const task = loadTasks()[0]; expect(await builder.callTool("update_task", { clientRequestId: "builder-whole-details", taskId: task.id, details: "fixture replaced" })).toMatchObject({ ok: true });
});


test("done refusal re-reads open pipelines and uses live-agent evidence on the service wire", async () => {
  const id = ["conversation", "fixture-manual-maintainer"].join("_");
  snapshot.conversations[id as `conversation_${string}`] = { id, agentRole: "maintainer", projectOwnership: { project }, generations: [], continuityPaths: [], abandonedContinuityPaths: [], migration: null } as never;
  const task = loadTasks()[0];
  let pipelines = [{ id: "fixture-open-lane", state: "running", taskIds: [task.id] }];
  const manual = { ...domain, registrySnapshot: () => snapshot, callerAttribution: () => ({ kind: "agent", conversationId: id, role: "builder" }), listPipelineRecords: () => pipelines, livenessSources: () => ({}) };
  const tools = createMcpToolService(viewerMcpBindings(undefined, undefined, manual as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(manual as never));
  expect(await tools.callTool("update_task", { clientRequestId: "manual-pipeline-done", taskId: task.id, status: "done" })).toMatchObject({ ok: false, code: "maintainer_done_refused" });
  pipelines = [];
  const { mutateTasks } = await import("@/lib/tasks/store");
  mutateTasks(tasks => ({ tasks: tasks.map(t => t.id === task.id ? { ...t, assignments: [{ conversationId: "fixture-live-worker", path: null, panePid: null, state: "linked" as const, at: new Date().toISOString(), error: null }] } : t), result: undefined }));
  const liveness = await import("@/lib/lifecycle/liveness");
  const spy = spyOn(liveness, "agentLivenessSnapshot").mockResolvedValue({ conversations: [{ conversationId: "fixture-live-worker", lifecycle: "running", host: { state: "alive" }, turnState: "busy" }] } as never);
  try {
    expect(await tools.callTool("update_task", { clientRequestId: "manual-live-done", taskId: task.id, status: "done" })).toMatchObject({ ok: false, code: "maintainer_done_refused" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await tools.callTool("update_task", { clientRequestId: "manual-overwrite", taskId: task.id, details: "whole replacement" })).toMatchObject({ ok: false, code: "maintainer_details_overwrite_refused" });
  } finally { spy.mockRestore(); }
});
