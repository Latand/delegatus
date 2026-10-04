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
  expect(await call("update_task", { taskId: task.id, replaceLine: { index: 0, text: "   " } })).toMatchObject({ ok: false, code: "maintainer_delete_refused" });
  expect(await call("update_task", { taskId: task.id, details: "   " })).toMatchObject({ ok: false, code: "maintainer_delete_refused" });
  expect(loadTasks().find(t => t.id === task.id)?.details).toBe("fixture new task");
  expect(await call("update_task", { taskId: task.id, project: "another-project" })).toMatchObject({ ok: false, code: "maintainer_project_refused" });
  const updated = await call("update_task", { taskId: task.id, text: "Оновлена перевірка дошки", appendLine: "Maintenance: fixture evidence" }); expect(updated.ok).toBe(true);
  const log = readMaintenanceRun(result.run.runId)!.log; expect(log.changes).toHaveLength(2); expect(log.changes[1].textBefore).toBe(task.text);
  const count = readMaintenanceRun(result.run.runId)!.counts.writes;
  patchMaintenanceRun(result.run.runId, { state: "succeeded" });
  expect(await call("update_task", { taskId: task.id, text: "Пізня зміна" })).toMatchObject({ ok: false, code: "maintainer_run_ended" });
  expect(readMaintenanceRun(result.run.runId)!.counts.writes).toBe(count);
  for (let i = 1; i <= 10; i++) {
    const next = claimMaintenanceRun({ project, now: Date.now() + i * 3 * 3600000, intervalHours: 3, seat: { conversationId: "fixture-seat", seatEpoch: 1 }, repoDir: "/fixtures/repository" });
    if (!next.claimed) throw new Error(`claim ${i} expected`);
    patchMaintenanceRun(next.run.runId, { state: "succeeded" });
  }
  expect(readMaintenanceRun(result.run.runId)).toBeNull();
  expect(await call("update_task", { taskId: task.id, text: "Після retention" })).toMatchObject({ ok: false, code: "maintainer_run_ended" });
  expect(await call("create_task", { project, text: "Після retention" })).toMatchObject({ ok: false, code: "maintainer_run_ended" });
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

test("done checks delivered path-only assignments and permits only a confirmed settled transcript", async () => {
  const id = ["conversation", "fixture-path-only-maintainer"].join("_");
  snapshot.conversations[id as `conversation_${string}`] = { id, agentRole: "maintainer", projectOwnership: { project }, generations: [], continuityPaths: [], abandonedContinuityPaths: [], migration: null } as never;
  const task = loadTasks()[0];
  const transcriptPath = path.join(root, "worker-transcript.jsonl");
  const { mutateTasks } = await import("@/lib/tasks/store");
  mutateTasks(tasks => ({ tasks: tasks.map(t => t.id === task.id ? { ...t, assignments: [{ path: transcriptPath, panePid: null, state: "delivered" as const, at: new Date().toISOString(), error: null }] } : t), result: undefined }));
  const liveness = await import("@/lib/lifecycle/liveness");
  const spy = spyOn(liveness, "agentLivenessSnapshot");
  const manual = { ...domain, registrySnapshot: () => snapshot, callerAttribution: () => ({ kind: "agent", conversationId: id, role: "builder" }), listPipelineRecords: () => [], livenessSources: () => ({}) };
  const tools = createMcpToolService(viewerMcpBindings(undefined, undefined, manual as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(manual as never));
  try {
    spy.mockResolvedValueOnce({ conversations: [{ conversationId: "path-only-worker", transcriptPath, lifecycle: "running", host: { state: "alive" }, turnState: "busy" }] } as never);
    expect(await tools.callTool("update_task", { clientRequestId: "path-only-busy-done", taskId: task.id, status: "done" })).toMatchObject({ ok: false, code: "maintainer_done_refused" });
    expect(spy).toHaveBeenCalledWith({ transcriptPath, limit: 1 }, {});
    spy.mockResolvedValueOnce({ conversations: [{ conversationId: "path-only-worker", transcriptPath, lifecycle: "gone", host: { state: "gone" }, turnState: "unknown" }] } as never);
    expect(await tools.callTool("update_task", { clientRequestId: "path-only-unknown-done", taskId: task.id, status: "done" })).toMatchObject({ ok: false, code: "maintainer_done_refused" });
    spy.mockResolvedValueOnce({ conversations: [{ conversationId: "path-only-worker", transcriptPath, lifecycle: "gone", host: { state: "unknown" }, turnState: "idle", reason: "launch_unproven_expired", evidenceSource: "transcript" }] } as never);
    expect(await tools.callTool("update_task", { clientRequestId: "path-only-settled-done", taskId: task.id, status: "done" })).toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalledTimes(3);
  } finally { spy.mockRestore(); }
});

test("activity and closure agree for historical, live idle and unknown assignments", async () => {
  const id = ["conversation", "fixture-liveness-maintainer"].join("_");
  snapshot.conversations[id as `conversation_${string}`] = { id, agentRole: "maintainer", projectOwnership: { project }, generations: [], continuityPaths: [], abandonedContinuityPaths: [], migration: null } as never;
  const task = loadTasks()[0];
  const { mutateTasks } = await import("@/lib/tasks/store");
  const workerId = "conversation_fixture-history";
  const liveness = await import("@/lib/lifecycle/liveness");
  const { evaluateLiveness } = liveness;
  const spy = spyOn(liveness, "agentLivenessSnapshot");
  const manual = { ...domain, registrySnapshot: () => snapshot, callerAttribution: () => ({ kind: "agent", conversationId: id }), livenessSources: () => ({}), refreshLifecycleJournal: () => ({ appended: 0 }) };
  const tools = createMcpToolService(viewerMcpBindings(undefined, undefined, manual as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(manual as never));
  try {
    for (const [name, host, turn, source, permitted] of [
      ["historical", "unknown", "idle", "transcript", true],
      ["dead", "gone", "idle", "transcript", true],
      ["live-idle", "alive", "idle", "transcript", false],
      ["live-busy", "alive", "busy", "transcript", false],
      ["unreadable", "unknown", "unknown", "unreadable", false],
      ["projected", "unknown", "idle", "projection", false],
      ["severed", "gone", "busy", "transcript", false],
    ] as const) {
      mutateTasks(tasks => ({ tasks: tasks.map(t => t.id === task.id ? { ...t, status: "assigned", assignments: [{ conversationId: workerId, path: null, panePid: null, state: "linked", at: new Date().toISOString(), error: null }] } : t), result: undefined }));
      const decision = evaluateLiveness({ host: { state: host }, turnState: turn, silentForMs: 3600000, stallAfterMs: 600000 });
      const row = { conversationId: workerId, host: { state: host }, turnState: turn, evidenceSource: source, ...decision };
      spy.mockResolvedValue({ conversations: [row], count: 1, selection: { matched: 1, selected: 1 } } as never);
      const activity = await tools.callTool("agent_activity", { clientRequestId: `activity-${name}`, conversationId: workerId, full: true });
      expect((activity as unknown as { conversations: unknown[] }).conversations[0]).toMatchObject(row);
      const result = await tools.callTool("update_task", { clientRequestId: `closure-${name}`, taskId: task.id, status: "done" });
      expect(result.ok).toBe(permitted);
      if (!permitted) expect(result.code).toBe("maintainer_done_refused");
    }
  } finally { spy.mockRestore(); }
});

test("retired seat history hides on the service wire, preserving details and current seats", async () => {
  const maintainerId = "conversation_fixture-history-maintainer";
  const oldId = "conversation_fixture-retired-seat";
  const currentId = "conversation_fixture-current-seat";
  for (const [id, agentRole] of [[maintainerId, "maintainer"], [oldId, "orchestrator"], [currentId, "orchestrator"]] as const) {
    snapshot.conversations[id] = { id, agentRole, projectOwnership: { project }, generations: [], continuityPaths: [], abandonedContinuityPaths: [], migration: null } as never;
  }
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(root, "orchestrator-seats.json"), JSON.stringify({ schemaVersion: 1, nextSeatEpoch: 3, seats: { [project]: { project, seatEpoch: 2, conversationId: currentId, path: null, mandate: "fixture", state: "active", intent: { clientRequestId: "fixture-seat", mode: "spawn", launchId: null, error: null }, designatedAt: at, activatedAt: at } }, pending: {}, revocations: [{ project, conversationId: oldId, seatEpoch: 1, revokedAt: at, successorConversationId: currentId }], history: [] }));
  const { mutateTasks } = await import("@/lib/tasks/store");
  const taskId = "fixture-retired-seat-card";
  mutateTasks(tasks => ({ tasks: [...tasks, { id: taskId, project, text: "Previous orchestrator", details: "Keep this history", status: "assigned", placement: "unplaced", origin: { kind: "launch", key: "fixture-seat-attempt", refinement: "titled" }, assignments: [{ conversationId: oldId, launchId: "fixture-seat-launch", clientAttemptId: "fixture-seat-attempt", path: null, panePid: null, state: "linked", error: null, at }], createdAt: at, updatedAt: at }], result: undefined }));
  const liveness = await import("@/lib/lifecycle/liveness");
  const spy = spyOn(liveness, "agentLivenessSnapshot").mockResolvedValue({ conversations: [{ conversationId: oldId, lifecycle: "gone", host: { state: "gone" }, turnState: "idle", evidenceSource: "transcript" }] } as never);
  const manual = { ...domain, registrySnapshot: () => snapshot, callerAttribution: () => ({ kind: "agent", conversationId: maintainerId }), livenessSources: () => ({}) };
  const tools = createMcpToolService(viewerMcpBindings(undefined, undefined, manual as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(manual as never));
  try {
    const fresh = loadTasks().find(t => t.id === taskId)!;
    const { taskRevision } = await import("@/lib/tasks/revision");
    expect(await tools.callTool("update_task", { clientRequestId: "retired-seat-history", taskId, expectedProject: fresh.project, expectedRevision: taskRevision(fresh), status: "done", hide: true, board: "hidden", appendLine: "Maintenance: retired seat verified" })).toMatchObject({ ok: true });
    const retired = loadTasks().find(t => t.id === taskId)!;
    expect(retired).toMatchObject({ status: "done", board: "hidden", groupHidden: { by: "agent" }, details: "Keep this history\nMaintenance: retired seat verified" });
    expect(retired.assignments[0].conversationId).toBe(oldId);
    const { groupHideState } = await import("@/lib/tasks/groupHide");
    expect(groupHideState(retired, { members: [], pipelines: [], seat: { conversationIds: [currentId], paths: [] } }).hidden).toBe(true);
    mutateTasks(tasks => ({ tasks: tasks.map(t => t.id === taskId ? { ...t, status: "assigned", assignments: [{ ...t.assignments[0], conversationId: currentId }] } : t), result: undefined }));
    expect(await tools.callTool("update_task", { clientRequestId: "current-seat-protected", taskId, status: "done", hide: true })).toMatchObject({ ok: false, code: "maintainer_delete_refused" });
  } finally { spy.mockRestore(); }
});

test("the real transcript projection permits gone history and refuses a verified live idle owner", async () => {
  const maintainerId = "conversation_fixture-real-maintainer";
  const historyId = "conversation_fixture-real-history";
  const transcriptPath = path.join(root, "real-history.jsonl");
  const now = Date.parse("2026-10-01T12:00:00Z"), ended = now - 3600000;
  fs.writeFileSync(transcriptPath, JSON.stringify({ timestamp: new Date(ended).toISOString(), type: "event_msg", payload: { type: "task_complete", last_agent_message: "Done" } }) + "\n");
  snapshot.conversations[maintainerId] = { id: maintainerId, agentRole: "maintainer", projectOwnership: { project }, generations: [], continuityPaths: [], abandonedContinuityPaths: [] } as never;
  snapshot.conversations[historyId] = { id: historyId, generations: [{ path: transcriptPath }], continuityPaths: [], abandonedContinuityPaths: [] } as never;
  const { mutateTasks } = await import("@/lib/tasks/store");
  const taskId = "fixture-real-history-card";
  mutateTasks(tasks => ({ tasks: [...tasks, { id: taskId, project, text: "Finished work", status: "assigned", placement: "unplaced", assignments: [{ conversationId: historyId, path: transcriptPath, panePid: null, state: "linked", at: new Date(ended).toISOString(), error: null }], createdAt: new Date(ended).toISOString(), updatedAt: new Date(ended).toISOString() }], result: undefined }));
  const { readLivenessTranscriptEvidence } = await import("@/lib/lifecycle/transcript");
  const sources = {
    now: () => now, registrySnapshot: () => snapshot, pipelines: () => [], flows: () => [],
    describeTranscript: async () => ({ path: transcriptPath, project, title: "Finished work", engine: "codex" as const, mtimeMs: ended, conversationId: historyId, activity: null, activityReason: null }),
    transcriptEvidence: readLivenessTranscriptEvidence,
    probe: { now: () => now, pidAlive: (pid: number) => pid === 424242, processIdentity: () => "fixture-process-start" },
  };
  const manual = { ...domain, registrySnapshot: () => snapshot, callerAttribution: () => ({ kind: "agent", conversationId: maintainerId }), livenessSources: () => sources, refreshLifecycleJournal: () => ({ appended: 0 }) };
  const tools = createMcpToolService(viewerMcpBindings(undefined, undefined, manual as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(manual as never));
  const activity = await tools.callTool("agent_activity", { clientRequestId: "real-gone-activity", conversationId: historyId, full: true });
  expect((activity as unknown as { conversations: unknown[] }).conversations[0]).toMatchObject({ lifecycle: "gone", reason: "launch_unproven_expired", turnState: "idle", host: { state: "unknown" }, evidenceSource: "transcript" });
  expect(await tools.callTool("update_task", { clientRequestId: "real-gone-closure", taskId, status: "done" })).toMatchObject({ ok: true });
  snapshot.entries["codex:fixture-real-history"] = { key: { engine: "codex", accountId: null, sessionId: "fixture-real-history" }, status: "live", artifactPath: transcriptPath, host: null, updatedAt: new Date(now).toISOString(), structuredHost: { process: { pid: 424242, startIdentity: "fixture-process-start" } } } as never;
  mutateTasks(tasks => ({ tasks: tasks.map(t => t.id === taskId ? { ...t, status: "assigned" } : t), result: undefined }));
  const live = await tools.callTool("agent_activity", { clientRequestId: "real-live-idle-activity", conversationId: historyId, full: true });
  expect((live as unknown as { conversations: unknown[] }).conversations[0]).toMatchObject({ lifecycle: "waiting", reason: "host_alive_turn_idle", turnState: "idle", host: { state: "alive" }, evidenceSource: "transcript" });
  expect(await tools.callTool("update_task", { clientRequestId: "real-live-idle-closure", taskId, status: "done" })).toMatchObject({ ok: false, code: "maintainer_done_refused" });
});
