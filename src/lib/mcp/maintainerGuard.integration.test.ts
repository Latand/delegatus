import { withTaskDue } from "@/lib/tasks/taskDue.fixture";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test, spyOn, setSystemTime } from "bun:test";
afterEach(() => setSystemTime());
// The preload has already bound task-store constants to this private root.
const root = process.env.LLV_STATE_DIR!;
if (!root) throw Error("isolated state directory required");
const { AgentRegistry } = await import("@/lib/agent/registry");
const { createMcpToolService, MemoryMcpReceiptStore } = await import("./server");
const { viewerMcpBindings, viewerMcpToolPolicy } = await import("./bindings");
const { loadTasks } = await import("@/lib/tasks/store");
const { claimMaintenanceRun, patchMaintenanceRun, readMaintenanceRun } = await import("@/lib/boardMaintenance/store");
const worker = ["conversation", "fixture-maintainer"].join("_");
const project = "fixture-maintenance";
const snapshot = structuredClone(new AgentRegistry(path.join(root, "fixture-registry.json")).readOnlySnapshot());
snapshot.conversations[worker as `conversation_${string}`] = { id: worker, agentRole: "maintainer", projectOwnership: { project }, generations: [], continuityPaths: [], abandonedContinuityPaths: [], migration: null } as never;
let seq = 0; let role = "maintainer";
const domain = {
  callerAttribution: () => ({ kind: "agent", conversationId: worker, role: "builder" }),
  attentionAuthority: () => ({ kind: "worker", conversationId: worker, role: "builder" }),
  registrySnapshot: () => { snapshot.conversations[worker as `conversation_${string}`].agentRole = role; return snapshot; },
  authorizedSeats: () => [{ project, conversationId: "fixture-seat" }, { project: "fixture-request-audit", conversationId: "fixture-audit-seat" }],
  listPipelineRecords: () => [], operatorLocale: () => "uk",
};
const service = createMcpToolService(viewerMcpBindings(undefined, undefined, domain as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain as never));
const call = (tool: string, args: Record<string, unknown>) => service.callTool(tool, { clientRequestId: `maintenance-test-${++seq}`, ...args });
test("durable maintainer role fences writes on the service wire, independent of claimed role", async () => {
  const denied = await call("send_message", { conversationId: "fixture-target", text: "fixture" }); expect(denied).toMatchObject({ ok: false, code: "maintainer_tool_refused" });
  const result = claimMaintenanceRun({ project, now: Date.now(), intervalHours: 3, seat: { conversationId: "fixture-seat", seatEpoch: 1 }, repoDir: "/fixtures/repository" }); if (!result.claimed) throw new Error("claim expected");
  patchMaintenanceRun(result.run.runId, { conversationId: worker, state: "running" });
  const created = await call("create_task", withTaskDue({ project, text: "Перевірка дошки", details: "fixture new task", icon: "brush-cleaning", color: "slate" })); expect(created.ok).toBe(true);
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
  expect(await call("create_task", withTaskDue({ project, text: "Після retention" }))).toMatchObject({ ok: false, code: "maintainer_run_ended" });
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


for (const tool of ["create_task", "update_task"] as const) for (const change of ["null", "role", "generation", "project", "claim"] as const) test(`last task-store await refuses ${tool} after maintainer ${change} replacement`, async () => {
  const id = `conversation_fixture-race-${tool}-${change}`;
  const record = { id, agentRole: "maintainer", projectOwnership: { project }, generations: [{ id: "native-one", path: "fixture-native", launchProfile: {}, host: { identity: "owner-one", epoch: 1 } }], continuityPaths: [], abandonedContinuityPaths: [], migration: null };
  const local = structuredClone(snapshot); local.conversations[id] = record as never;
  let callerId: string | null = id;
  const manual = { ...domain, registrySnapshot: () => local, callerAttribution: () => ({ kind: "agent", conversationId: callerId }), attentionAuthority: () => callerId ? ({ kind: "worker", conversationId: callerId, role: "maintainer" }) : ({ kind: "unidentified" }) };
  const tools = createMcpToolService(viewerMcpBindings(undefined, undefined, manual as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(manual as never));
  const { mutateTasks } = await import("@/lib/tasks/store");
  const taskId = `fixture-target-${tool}-${change}`;
  const at = "2026-09-30T12:00:00.000Z";
  mutateTasks(tasks => ({ tasks: [...tasks, { id: taskId, project, text: "Збережена задача", status: "inbox", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at }], result: undefined }));
  const before = loadTasks();
  const locks = await import("@/lib/state/lockWait");
  const originalWait = locks.waitForStateLock;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const spy = spyOn(locks, "waitForStateLock").mockImplementation(async (site, operation, options) => {
    if (site === (tool === "create_task" ? "mcp.tasks.create" : "tasks.mutation")) { enter(); await barrier; }
    return originalWait(site, operation, options);
  });
  try {
    const pending = tools.callTool(tool, { clientRequestId: `race-${tool}-${change}`, ...(tool === "create_task" ? withTaskDue({ project, text: "Нова задача" }) : { taskId, text: "Застаріла зміна" }) });
    await entered;
    if (change === "null") callerId = null;
    if (change === "role") record.agentRole = "builder";
    if (change === "generation") record.generations[0].id = "native-two";
    if (change === "project") record.projectOwnership.project = "another-project";
    if (change === "claim") record.generations[0].host.epoch++;
    const changed = local.conversations[id];
    Object.assign(changed, record);
    release();
    expect(await pending).toMatchObject({ ok: false, code: "maintainer_authority_changed" });
    expect(loadTasks()).toEqual(before);
  } finally { release(); spy.mockRestore(); }
});


test("two audited requests use real task services and recover a Done owner after a lost log", async () => {
  const { auditFixture } = await import("@/lib/boardMaintenance/testFixture");
  const { auditRequestKey, auditSourceMarker } = await import("@/lib/boardMaintenance/audit");
  const { saveMaintenanceAuditLaunch } = await import("@/lib/boardMaintenance/store");
  const { taskRevision } = await import("@/lib/tasks/revision");
  const { parseMaintenanceReport } = await import("@/lib/boardMaintenance/text");
  const auditProject = "fixture-request-audit";
  const now = Date.parse("2026-11-08T03:00:00.000Z");
  setSystemTime(now);
  const claim = claimMaintenanceRun({ project: auditProject, now, intervalHours: 3, seat: { conversationId: "fixture-seat", seatEpoch: 1 }, repoDir: root });
  if (!claim.claimed) throw Error("expected claim");
  const seatFile = path.join(root, "orchestrator-seats.json");
  const seats = fs.existsSync(seatFile) ? JSON.parse(fs.readFileSync(seatFile, "utf8")) : { schemaVersion: 1, nextSeatEpoch: 3, seats: {}, pending: {}, revocations: [], history: [] };
  seats.seats[auditProject] = { project: auditProject, ...claim.run.seat, path: null, mandate: "fixture", state: "active", intent: { clientRequestId: "fixture-audit-seat", mode: "spawn", launchId: null, error: null }, designatedAt: claim.run.claimedAt, activatedAt: claim.run.claimedAt };
  fs.writeFileSync(seatFile, JSON.stringify(seats));
  const input = auditFixture(claim.run);
  const repeated = { ...input.occurrences[0], key: "fixture-repeated-occurrence", seq: 2, text: "Repeat the second request." };
  input.occurrences.push(repeated);
  saveMaintenanceAuditLaunch(claim.run.runId, input, { prompt: JSON.stringify(input) });
  const id = "conversation_fixture-auditor";
  patchMaintenanceRun(claim.run.runId, { conversationId: id, state: "running" });
  const local = structuredClone(snapshot);
  local.conversations[id] = { id, agentRole: "maintainer", projectOwnership: { project: auditProject }, generations: [], continuityPaths: [], abandonedContinuityPaths: [], migration: null } as never;
  const source = input.window.sources[0];
  local.conversations[source.conversationId] = { id: source.conversationId, engine: "codex", projectOwnership: { project: auditProject }, generations: [{ id: source.generation, path: source.path, launchProfile: {} }], continuityPaths: [], abandonedContinuityPaths: [], migration: null } as never;
  const manual = { ...domain, registrySnapshot: () => local, callerAttribution: () => ({ kind: "agent", conversationId: id }), attentionAuthority: () => ({ kind: "worker", conversationId: id, role: "maintainer" }) };
  const factory = () => createMcpToolService(viewerMcpBindings(undefined, undefined, manual as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(manual as never));
  const keys = [0, 1].map(i => auditRequestKey(input.occurrences[0].key, i));
  const before = loadTasks().filter(t => t.project === auditProject);
  const args = { project: auditProject, text: "Довести прийнятий запит до обліку", findingKey: keys[1], details: auditSourceMarker(keys[1]), dueAt: new Date(now + 3600000).toISOString(), dueTz: "Europe/Kyiv", clientRequestId: keys[1] };
  for (const invalid of [{ ...args, details: undefined }, { ...args, clientRequestId: "unbound-audit-operation" }, { ...args, findingKey: keys[0] }]) {
    expect(await factory().callTool("create_task", invalid)).toMatchObject({ ok: false, code: "maintainer_audit_refused" });
    expect(loadTasks().filter(t => t.project === auditProject)).toEqual(before);
  }
  const sourceConversation = local.conversations[source.conversationId];
  sourceConversation.projectOwnership!.project = "revoked-source-project";
  expect(await factory().callTool("create_task", args)).toMatchObject({ ok: false, code: "maintainer_audit_refused" });
  expect(loadTasks().filter(t => t.project === auditProject)).toEqual(before);
  sourceConversation.projectOwnership!.project = auditProject;
  const ledger = await import("@/lib/boardMaintenance/store");
  const log = spyOn(ledger, "recordMaintenanceChange").mockImplementation(() => { throw Error("injected lost log"); });
  try { expect(await factory().callTool("create_task", args)).toMatchObject({ ok: true }); } finally { log.mockRestore(); }
  const task = loadTasks().find(t => t.project === auditProject)!;
  expect(task.details).toBe(auditSourceMarker(keys[1]));
  expect(task.dueAt).toBe(args.dueAt); expect(task.dueTz).toBe(args.dueTz);
  expect(readMaintenanceRun(claim.run.runId)?.log.logGaps).toBe(1);
  const first = { ...task };
  expect(await factory().callTool("update_task", { taskId: task.id, expectedProject: auditProject, expectedRevision: taskRevision(task), replaceLine: { index: 0, text: "overwrite source proof" }, clientRequestId: "fixture-marker-removal" })).toMatchObject({ ok: false, code: "maintainer_delete_refused" });
  expect(loadTasks().find(t => t.id === task.id)).toEqual(first);
  expect(await factory().callTool("update_task", { taskId: task.id, expectedProject: auditProject, expectedRevision: taskRevision(task), appendLine: auditSourceMarker(keys[1]), clientRequestId: keys[1] })).toMatchObject({ ok: true, changedFields: [] });
  expect(loadTasks().find(t => t.id === task.id)).toEqual(first);
  expect(await factory().callTool("update_task", { taskId: task.id, status: "done", expectedProject: auditProject, expectedRevision: taskRevision(task), clientRequestId: "fixture-finish-audit-owner" })).toMatchObject({ ok: true });
  expect(await factory().callTool("create_task", args)).toMatchObject({ ok: true, replay: true, matched: true });
  const childCode = `
    import {createMcpToolService, MemoryMcpReceiptStore} from './src/lib/mcp/server';
    import {viewerMcpBindings,viewerMcpToolPolicy} from './src/lib/mcp/bindings';
    const snapshot=${JSON.stringify(local)};
    const domain={registrySnapshot:()=>snapshot,callerAttribution:()=>({kind:'agent',conversationId:${JSON.stringify(id)}}),attentionAuthority:()=>({kind:'worker',conversationId:${JSON.stringify(id)},role:'maintainer'}),authorizedSeats:()=>[{project:${JSON.stringify(auditProject)},conversationId:'fixture-audit-seat'}],listPipelineRecords:()=>[],operatorLocale:()=> 'uk'};
    const service=createMcpToolService(viewerMcpBindings(undefined,undefined,domain as never),new MemoryMcpReceiptStore(),viewerMcpToolPolicy(domain as never));
    process.stdout.write(JSON.stringify(await service.callTool('create_task',${JSON.stringify(args)})));
  `;
  const child = Bun.spawn([process.execPath, "-e", childCode], { env: { ...process.env, LLV_STATE_DIR: root }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text(); const childError = await new Response(child.stderr).text();
  expect(await child.exited, childError).toBe(0); expect(JSON.parse(output)).toMatchObject({ ok: true, replay: true, matched: true });
  const after = loadTasks().filter(t => t.project === auditProject);
  expect(after.length - before.length).toBe(1); expect(after[0].status).toBe("done"); expect(after[0].dueAt).toBe(first.dueAt);
  const repeatKey = auditRequestKey(repeated.key, 0);
  const append = { taskId: task.id, expectedProject: auditProject, expectedRevision: taskRevision(after[0]), appendLine: auditSourceMarker(repeatKey), clientRequestId: repeatKey };
  expect(await factory().callTool("update_task", append)).toMatchObject({ ok: true });
  const owner = loadTasks().find(t => t.id === task.id)!;
  expect(owner.status).toBe("done"); expect(owner.dueAt).toBe(first.dueAt); expect(owner.dueTz).toBe(first.dueTz);
  expect(await factory().callTool("update_task", { ...append, expectedRevision: taskRevision(owner), dueAt: new Date(now + 7200000).toISOString() })).toMatchObject({ ok: false, code: "maintainer_audit_refused" });
  expect(loadTasks().find(t => t.id === task.id)).toEqual(owner);
  expect(await factory().callTool("create_task", { ...args, findingKey: repeatKey, details: auditSourceMarker(repeatKey), clientRequestId: repeatKey })).toMatchObject({ ok: true, replay: true, matched: true, taskId: task.id });
  expect(loadTasks().filter(t => t.project === auditProject)).toHaveLength(1);
  const rows = keys.map((key, i) => ({ key, occurrence: input.occurrences[0].key, requestIndex: i, at: input.occurrences[0].at, request: i ? "abandoned accepted request" : "already done request", outcome: i ? "filed" : "done", taskId: i ? task.id : null, code: "observed", merge: "unread", install: "unread", acceptance: "observed", checkedAt: input.snapshotAt, next: "", dueAt: i ? task.dueAt : null, dueTz: i ? task.dueTz : null, mutation: i ? { key, state: "readback" } : null }));
  rows.push({ ...rows[1], key: repeatKey, occurrence: repeated.key, requestIndex: 0, request: "Repeated outcome already accounted", outcome: "updated", mutation: { key: repeatKey, state: "readback" } });
  const manifest = { version: 1, runId: input.runId, revision: input.revision, lower: input.window.lower, upper: input.window.upper, rows: 3, occurrences: [{ key: input.occurrences[0].key, requests: 2, nextIndex: 2 }, { key: repeated.key, requests: 1, nextIndex: 1 }] };
  const report = [...rows.map(row => `audit-row: ${JSON.stringify(row)}`), `audit-manifest: ${JSON.stringify(manifest)}`, "Verdict: pass"].join("\n");
  expect(parseMaintenanceReport(report, input, loadTasks()).audit).toMatchObject({ complete: true, error: null });
});
