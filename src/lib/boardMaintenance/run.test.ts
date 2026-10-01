import { afterEach, expect, test } from "bun:test";
import { statePath } from "@/lib/configDir";
import { loadTasks } from "@/lib/tasks/store";
import { AgentRegistry } from "@/lib/agent/registry";
import { defaultSeatTickSources, type SeatTickSources } from "@/lib/monitor/seatTickSources";
import { productionBoardMaintenanceController, type BoardMaintenancePorts, type MaintenanceObservation } from "./run";
import { claim, sandbox, input, PROJECT, NOW } from "./testFixture";
import { readMaintenanceProject, readMaintenanceRun, recordMaintenanceChange } from "./store";
let held: ReturnType<typeof sandbox>;
afterEach(() => held?.restore());
const tasks = () => loadTasks(statePath("tasks.json"));
function harness(archiveOverride = true) {
  held = sandbox(); let now = NOW;
  const registry = new AgentRegistry(statePath("fixture-registry.json"));
  const bodies: Record<string, unknown>[] = [], archived: string[] = [];
  let observation: MaintenanceObservation = { state: "running" };
  let response = { status: 202, body: { state: "starting", conversationId: ["conversation", "fixture-worker"].join("_"), launchId: "fixture-launch", path: "/fixtures/worker.jsonl" } as Record<string, unknown> };
  const sources: SeatTickSources = { ...defaultSeatTickSources(), now: () => now, tasks, pipelines: () => [{ repoDir: "/fixtures/repository", project: PROJECT, createdAt: new Date(NOW).toISOString() } as never], registry: () => registry, latestDeployment: () => ({ state: "ok", value: null }) };
  const ports: BoardMaintenancePorts = { sources, evidence: async () => [], ...(archiveOverride ? { archive: run => { archived.push(run.runId); } } : {}), locale: () => "uk", timeZone: () => "UTC", launch: async body => { bodies.push(body); return response; }, observe: async () => observation };
  return { controller: productionBoardMaintenanceController(sources, ports), sources, registry, bodies, archived, run: () => readMaintenanceRun(readMaintenanceProject(PROJECT)!.currentRunId!)!, observe: (value: MaintenanceObservation) => { observation = value; }, respond: (value: typeof response) => { response = value; }, now: (value: number) => { now = value; } };
}
test("off, no seat, live run and deploy defer without spending the slot", async () => {
  const h = harness(); await h.controller.launchIfDue(input(false)); expect(h.bodies).toHaveLength(0);
  await h.controller.launchIfDue({ ...input(), seat: null }); expect(readMaintenanceProject(PROJECT)).toBeNull();
  h.sources.latestDeployment = () => ({ state: "ok", value: { terminal: false } as never });
  expect(await h.controller.launchIfDue(input())).toContain("deployment"); expect(readMaintenanceProject(PROJECT)).toBeNull();
  h.sources.latestDeployment = () => ({ state: "ok", value: null });
  await h.controller.launchIfDue(input()); await h.controller.launchIfDue(input()); expect(h.bodies).toHaveLength(1);
});
test("wakes off spends no maintenance slot, and resuming wakes launches once", async () => {
  const h = harness();
  const paused = input(); paused.settings.enabled = false;
  expect(await h.controller.launchIfDue(paused)).toContain("wakes are off");
  expect(readMaintenanceProject(PROJECT)).toBeNull(); expect(tasks()).toHaveLength(0);
  await h.controller.launchIfDue(input()); await h.controller.launchIfDue(input());
  expect(h.bodies).toHaveLength(1);
});
test("a recovered claim waits while wakes are off without dispatching or losing its key", async () => {
  const h = harness(); const run = claim();
  const originalSettings = h.sources.settings;
  h.sources.settings = project => ({ ...originalSettings(project), enabled: false });
  expect(await h.controller.reconcile(PROJECT)).toContain("wakes are off");
  expect(h.bodies).toHaveLength(0); expect(tasks()).toHaveLength(0);
  h.sources.settings = originalSettings;
  await h.controller.reconcile(PROJECT);
  expect(h.bodies[0].clientAttemptId).toBe(run.runId);
});
test("card exists before spawn, with icon, colour, description and task binding in body", async () => {
  const h = harness(); await h.controller.launchIfDue(input());
  const run = h.run(), card = tasks().find(t => t.id === run.taskId)!;
  expect(card).toMatchObject({ icon: "brush-cleaning", color: "slate" }); expect(card.text).toContain("Обслуговування дошки — 30.09 12:00"); expect(card.details).toStartWith("Delegatus board maintenance run");
  expect(h.bodies[0]).toMatchObject({ role: "maintainer", taskId: card.id, cwd: "/fixtures/repository", project: PROJECT, clientAttemptId: run.runId });
});
test("no account leaves one blocked visible card, success summarizes, hides and archives", async () => {
  const h = harness(); h.respond({ status: 409, body: { code: "project_account_refused", error: "fixture no allowed account" } });
  await h.controller.launchIfDue(input()); const blocked = tasks()[0]; expect(blocked.status).toBe("blocked"); expect(blocked.board).toBe("shown");
  h.now(NOW + 3 * 3600000); h.respond({ status: 202, body: { state: "starting", conversationId: ["conversation", "fixture-worker"].join("_"), path: "/fixtures/worker.jsonl" } }); await h.controller.launchIfDue(input());
  const run = h.run(); recordMaintenanceChange(run.runId, { at: run.claimedAt, taskId: "aabbccdd", tool: "update_task", fields: ["status"], statusFrom: "assigned", statusTo: "inbox" });
  h.observe({ state: "ended", finalText: "attention: aabbccdd | Choose | keep | split\nleft: ddeeffaa | open pipeline\nVerdict: pass" }); await h.controller.reconcile(PROJECT);
  const done = tasks().find(t => t.id === run.taskId)!; expect(done).toMatchObject({ status: "done", board: "hidden" }); expect(done.text).toContain("змінено 1 задач"); expect(done.text).toContain("Choose"); expect(h.archived).toEqual([run.runId]); expect(tasks().find(t => t.id === blocked.id)?.status).toBe("done");
  const ended = readMaintenanceRun(run.runId)!; expect(ended.log.leftAlone).toHaveLength(1);
  const snapshot = JSON.stringify(tasks()); await h.controller.reconcile(PROJECT); expect(JSON.stringify(tasks())).toBe(snapshot);
});
test("reconcile resumes claimed card and spawn under same key", async () => {
  const h = harness(); const run = claim(); await h.controller.reconcile(PROJECT);
  expect(h.bodies[0].clientAttemptId).toBe(run.runId); expect(tasks()).toHaveLength(1);
});

test("cooldown starts at durable dispatch time after a restart during claim grace", async () => {
  const h = harness(); claim(); h.now(NOW + 14 * 60000);
  await h.controller.reconcile(PROJECT);
  const run = h.run(); expect(run.launchedAt).toBe(new Date(NOW + 14 * 60000).toISOString());
  h.observe({ state: "ended", finalText: "Verdict: pass" }); await h.controller.reconcile(PROJECT);
  h.now(NOW + 3 * 3600000); await h.controller.launchIfDue(input());
  expect(h.bodies).toHaveLength(1);
  h.now(NOW + 3 * 3600000 + 14 * 60000); await h.controller.launchIfDue(input());
  expect(h.bodies).toHaveLength(2);
});
for (const [name, observation] of [
  ["launch-failed", { state: "failed", failure: { kind: "launch-failed", detail: "receipt failed" } }],
  ["host-died", { state: "failed", failure: { kind: "host-died", detail: "host gone over open turn" } }],
  ["turn-error", { state: "ended", turnError: "engine error", finalText: "Starting the inventory" }],
  ["agent-fail", { state: "ended", finalText: "forge unavailable\nVerdict: fail" }],
  ["timed-out", { state: "running" }],
] as const) test(`${name} settles blocked and visible`, async () => {
  const h = harness(); await h.controller.launchIfDue(input()); const run = h.run(); h.observe(observation as MaintenanceObservation);
  if (name === "timed-out") h.now(NOW + 91 * 60000);
  await h.controller.reconcile(PROJECT); const ended = readMaintenanceRun(run.runId)!;
  expect(ended.failure?.kind).toBe(name); expect(tasks().find(t => t.id === run.taskId)).toMatchObject({ status: "blocked", board: "shown" });
});


test("restart replays the stored spawn payload and does not repeat settlement details", async () => {
  const h = harness(); await h.controller.launchIfDue(input()); const run = h.run();
  const { patchMaintenanceRun } = await import("./store");
  patchMaintenanceRun(run.runId, { conversationId: null, state: "launching" });
  await h.controller.reconcile(PROJECT);
  expect(h.bodies).toHaveLength(2); expect(h.bodies[1]).toEqual(h.bodies[0]);
  h.observe({ state: "ended", finalText: "Verdict: pass" });
  let calls = 0;
  const { reconcileBoardMaintenance } = await import("./run");
  const ports = { sources: h.sources, observe: async () => ({ state: "ended" as const, finalText: "Verdict: pass" }), archive: () => { calls++; if (calls === 1) throw new Error("fixture archive race"); }, locale: () => "uk" as const };
  await expect(reconcileBoardMaintenance(PROJECT, ports)).rejects.toThrow("fixture archive race");
  await reconcileBoardMaintenance(PROJECT, ports);
  const card = tasks().find(t => t.id === run.taskId)!;
  expect(card.details!.split("\n").filter(l => l.startsWith("Result:"))).toHaveLength(1);
});


test("a full board still creates one bound visible card and records a failed launch", async () => {
  const h = harness();
  const { saveTasks } = await import("@/lib/tasks/store");
  const { BOARD_TASKS_PER_PROJECT_LIMIT } = await import("@/lib/tasks/commands");
  const full = Array.from({ length: BOARD_TASKS_PER_PROJECT_LIMIT }, (_, i) => ({ id: `fixture-task-${i}`, project: PROJECT, text: "Fixture task", status: "inbox" as const, placement: "unplaced" as const, assignments: [], createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }));
  saveTasks(full, statePath("tasks.json"));
  h.respond({ status: 409, body: { code: "project_account_refused", error: "fixture no account" } });
  await h.controller.launchIfDue(input());
  const runs = await import("./store");
  const failed = runs.maintenanceRuns(PROJECT)[0];
  expect(failed.state).toBe("failed"); expect(tasks().find(t => t.id === failed.taskId)).toMatchObject({ status: "blocked", board: "shown" });
  expect(h.bodies[0].taskId).toBe(failed.taskId);
  h.now(NOW + 3 * 3600000);
  await h.controller.launchIfDue(input());
  const retry = runs.maintenanceRuns(PROJECT).at(-1)!;
  h.observe({ state: "failed", failure: { kind: "host-died", detail: "host exited over an open turn" } });
  await h.controller.reconcile(PROJECT);
  expect(tasks().find(t => t.id === retry.taskId)).toMatchObject({ status: "blocked", board: "shown" });
  expect(tasks().find(t => t.id === failed.taskId)).toMatchObject({ status: "done", board: "hidden" });
});

test("needs_decision remains blocked and visible with its operator reason", async () => {
  const h = harness(); await h.controller.launchIfDue(input()); const run = h.run();
  h.observe({ state: "ended", finalText: "Cannot read the forge without operator access.\nVerdict: needs_decision" });
  await h.controller.reconcile(PROJECT);
  const ended = readMaintenanceRun(run.runId)!;
  expect(ended).toMatchObject({ state: "failed", failure: { kind: "needs-decision" }, log: { verdict: "needs_decision" } });
  expect(ended.failure?.detail).toContain("operator access");
  expect(tasks().find(t => t.id === run.taskId)).toMatchObject({ status: "blocked", board: "shown" });
  expect(h.archived).toHaveLength(0);
});

test("a later successful turn is not failed by an earlier recovered turn", async () => {
  const h = harness(); await h.controller.launchIfDue(input()); const run = h.run();
  h.observe({ state: "ended", finalText: "Inventory and reconciliation completed.\nVerdict: pass", turnError: null });
  await h.controller.reconcile(PROJECT);
  expect(readMaintenanceRun(run.runId)).toMatchObject({ state: "succeeded", failure: null, log: { verdict: "pass" } });
  expect(tasks().find(t => t.id === run.taskId)).toMatchObject({ status: "done", board: "hidden" });
  expect(h.archived).toEqual([run.runId]);
});

test("production observation uses the latest turn extracted from the transcript tail", async () => {
  const h = harness(); const run = { ...claim(), launchedAt: new Date(NOW).toISOString() };
  const { observeMaintenanceRun } = await import("./run");
  const { transcriptErrorFromRecords } = await import("@/lib/spawnNotice/production");
  const records = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "first" } },
    { type: "event_msg", payload: { type: "turn_aborted", turn_id: "first", reason: "provider interruption" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "second" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "second", last_agent_message: "Inventory complete. Verdict: pass" } },
  ];
  const sources = { ...h.sources, registry: () => ({ spawnReceiptForClientAttempt: () => ({ state: "completed", conversationId: "conversation_fixture-worker", launchId: "fixture-launch", artifactPath: "/fixtures/worker.jsonl" }) }) as never,
    liveness: async () => [{ conversationId: "conversation_fixture-worker", reason: "host_alive_turn_idle", lifecycle: "idle", lastRecordAt: new Date(NOW + 1000).toISOString() }] as never };
  const observed = await observeMaintenanceRun(run, sources, () => ({ text: "Inventory complete. Verdict: pass", error: transcriptErrorFromRecords(records, "codex") }));
  expect(observed).toMatchObject({ state: "ended", finalText: "Inventory complete. Verdict: pass", turnError: null });
});

test("superseding a failed run archives its linked worker and removes its hidden band", async () => {
  const h = harness(false); await h.controller.launchIfDue(input()); const old = h.run();
  const oldTaskId = old.taskId!;
  const { patchMaintenanceRun } = await import("./store");
  const { boardFor } = await import("@/lib/board/store");
  const { boardConversationKeys, taskHasBoardMembers, taskShowsOnBoard } = await import("@/lib/tasks/boardVisibility");
  const { saveTasks } = await import("@/lib/tasks/store");
  const transcriptPath = "/fixtures/worker.jsonl";
  const conversation = h.registry.ensureConversation("codex", transcriptPath, null);
  patchMaintenanceRun(old.runId, { conversationId: conversation.id, launchId: "fixture-launch", transcriptPath });
  saveTasks(tasks().map(task => task.id === oldTaskId ? { ...task, assignments: [...task.assignments, { path: transcriptPath, conversationId: conversation.id, panePid: null, state: "delivered" as const, error: null, at: new Date(NOW).toISOString() }] } : task), statePath("tasks.json"));
  h.observe({ state: "failed", failure: { kind: "host-died", detail: "host exited over an open turn" } }); await h.controller.reconcile(PROJECT);
  const cardBefore = tasks().find(t => t.id === oldTaskId)!;
  expect(taskShowsOnBoard(cardBefore, taskHasBoardMembers(cardBefore, boardConversationKeys([{ path: transcriptPath, conversationId: conversation.id }])))).toBe(true);
  h.now(NOW + 3 * 3600000); await h.controller.launchIfDue(input()); const latest = h.run();
  h.observe({ state: "failed", failure: { kind: "host-died", detail: "host exited over an open turn" } }); await h.controller.reconcile(PROJECT);
  expect(readMaintenanceRun(latest.runId)!.supersededTaskIds).toContain(oldTaskId);
  expect(boardFor(PROJECT).prefs.hidden).toContain(transcriptPath);
  const cardAfter = tasks().find(t => t.id === oldTaskId)!;
  expect(taskShowsOnBoard(cardAfter, taskHasBoardMembers(cardAfter, boardConversationKeys([])))).toBe(false);
  expect(tasks().find(t => t.id === latest.taskId)).toMatchObject({ status: "blocked", board: "shown" });
});


test("production evidence gathering reads transcript and real branch activity; failed reads remain unknown", async () => {
  const h = harness();
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const repo = statePath("fixture-repo"); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "noreply@example.invalid", GIT_AUTHOR_DATE: new Date(NOW).toISOString(), GIT_COMMITTER_DATE: new Date(NOW).toISOString() }, stdio: "pipe" });
  git("init"); git("commit", "--allow-empty", "-m", "Fixture change"); git("branch", "fixture-branch");
  const task = { id: "aabbccdd", project: PROJECT, status: "assigned", assignments: [{ conversationId: "fixture-worker" }] };
  const pipeline = { id: "fixture-lane", project: PROJECT, taskIds: [task.id], state: "running", branch: "fixture-branch", runs: [{ stageId: "build", attempts: [{ conversationId: "fixture-worker", startedAt: new Date(NOW - 3 * 3600000).toISOString() }] }] };
  const { maintenanceWorkEvidence } = await import("./run");
  const sources = { ...h.sources, tasks: () => [task] as never, pipelines: () => [pipeline] as never, liveness: async () => [{ conversationId: "fixture-worker", lifecycle: "running", lastRecordAt: new Date(NOW - 4 * 3600000).toISOString() }] as never };
  const proof = await maintenanceWorkEvidence(PROJECT, NOW, sources, repo);
  expect(proof[0].verdict).toBe("working"); expect(proof[0].lanes[0].branchCommitAt).toBe(new Date(NOW).toISOString()); expect(proof[0].workers).toHaveLength(2);
  const unknown = await maintenanceWorkEvidence(PROJECT, NOW, { ...sources, liveness: async () => { throw new Error("fixture unreadable"); } }, "/fixtures/missing-repository");
  expect(unknown[0].verdict).toBe("quiet"); expect(unknown[0].workers[0].lifecycle).toBe("unknown"); expect(unknown[0].lanes[0].branchCommitAt).toBeNull();
});


test("production observation distinguishes failed receipts, dead hosts, idle turns and provider waits", async () => {
  const h = harness(); const run = claim();
  const { observeMaintenanceRun } = await import("./run");
  let receipt = { state: "completed", conversationId: "fixture-worker", launchId: "fixture-launch", artifactPath: "/fixtures/worker.jsonl", error: null } as Record<string, unknown>;
  let activity = { conversationId: "fixture-worker", reason: "host_alive_turn_idle", lifecycle: "idle", host: { state: "alive" }, lastRecordAt: new Date(NOW + 1000).toISOString() };
  const sources = { ...h.sources, registry: () => ({ spawnReceiptForClientAttempt: () => receipt }) as never, liveness: async () => [activity] as never };
  expect((await observeMaintenanceRun(run, sources)).state).toBe("ended");
  activity = { ...activity, reason: "provider_throttled", lifecycle: "waiting" }; expect((await observeMaintenanceRun(run, sources)).state).toBe("running");
  activity = { ...activity, reason: "host_gone_turn_open", lifecycle: "stalled", host: { state: "gone" } }; expect((await observeMaintenanceRun(run, sources)).failure?.kind).toBe("host-died");
  receipt = { ...receipt, state: "failed", error: "fixture launch failed" }; expect((await observeMaintenanceRun(run, sources)).failure?.kind).toBe("launch-failed");
});

for (const state of ["terminal", "unreadable"] as const) test(`${state} deployment ledger permits maintenance`, async () => {
  const h = harness();
  h.sources.latestDeployment = () => state === "terminal"
    ? { state: "ok", value: { terminal: true } as never }
    : { state: "unreadable", error: "fixture unreadable" };
  await h.controller.launchIfDue(input());
  expect(h.bodies).toHaveLength(1);
});
