import { afterEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { drainFile, writeDrain, releaseDrain } from "@/lib/selfUpdate/drain";
import { statePath } from "@/lib/configDir";
import { loadTasks } from "@/lib/tasks/store";
import { AgentRegistry } from "@/lib/agent/registry";
import { defaultSeatTickSources, type SeatTickSources } from "@/lib/monitor/seatTickSources";
import { productionBoardMaintenanceController, type BoardMaintenancePorts, type MaintenanceObservation } from "./run";
import { saveRoleMapping } from "@/lib/roles/store";
import { claim, sandbox, input, PROJECT, NOW } from "./testFixture";
import { maintenanceRuns, readMaintenanceProject, readMaintenanceRun, recordMaintenanceChange } from "./store";
import type { TaskWorkEvidence } from "./evidence";
import { composeStructuredFirstMessage } from "@/lib/runtime/structuredFirstMessage";
import { setMergeOnReview } from "@/lib/projects/settings";
import { defaultSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
let held: ReturnType<typeof sandbox>;
afterEach(() => held?.restore());
const tasks = () => loadTasks(statePath("tasks.json"));
function harness(archiveOverride = true, evidenceOrOverrides: TaskWorkEvidence[] | Partial<BoardMaintenancePorts> = []) {
  const evidence = Array.isArray(evidenceOrOverrides) ? evidenceOrOverrides : [];
  const overrides = Array.isArray(evidenceOrOverrides) ? {} : evidenceOrOverrides;
  held = sandbox(); let now = NOW;
  const registry = new AgentRegistry(statePath("fixture-registry.json"));
  const bodies: Record<string, unknown>[] = [], archived: string[] = [];
  let observation: MaintenanceObservation = { state: "running" };
  let response = { status: 202, body: { state: "starting", conversationId: ["conversation", "fixture-worker"].join("_"), launchId: "fixture-launch", path: "/fixtures/worker.jsonl" } as Record<string, unknown> };
  const sources: SeatTickSources = { ...defaultSeatTickSources(), now: () => now, tasks, pipelines: () => [{ repoDir: "/fixtures/repository", project: PROJECT, createdAt: new Date(NOW).toISOString() } as never], registry: () => registry, latestDeployment: () => ({ state: "ok", value: null }) };
  sources.settings = project => ({ ...defaultSeatTickSettings(project), maintenance: { enabled: true, intervalHours: 3, updatedAt: new Date(NOW).toISOString(), setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } } });
  const ports: BoardMaintenancePorts = { sources, auditInput: async () => undefined, evidence: async () => evidence, ...(archiveOverride ? { archive: run => { archived.push(run.runId); } } : {}), locale: () => "uk", timeZone: () => "UTC", launch: async body => { bodies.push(body); return response; }, observe: async () => observation };
  return { controller: productionBoardMaintenanceController(sources, { ...ports, ...overrides }), sources, registry, bodies, archived, run: () => readMaintenanceRun(readMaintenanceProject(PROJECT)!.currentRunId!)!, observe: (value: MaintenanceObservation) => { observation = value; }, respond: (value: typeof response) => { response = value; }, now: (value: number) => { now = value; } };
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
for (const enabled of [true, false]) test(`launch brief reads this project's mergeOnReview setting: ${enabled}`, async () => {
  const h = harness();
  expect(setMergeOnReview(PROJECT, enabled, "fixture", new Date(NOW).toISOString())).not.toBeNull();
  // An unrelated project's setting must not govern this run.
  expect(setMergeOnReview("other-project", !enabled, "fixture", new Date(NOW).toISOString())).not.toBeNull();
  await h.controller.launchIfDue(input());
  expect(String(h.bodies[0].prompt)).toContain(`Project mergeOnReview: ${enabled ? "on" : "off"}`);
});
test("card exists before spawn, with icon, colour, description and task binding in body", async () => {
  const h = harness(); await h.controller.launchIfDue(input());
  const run = h.run(), card = tasks().find(t => t.id === run.taskId)!;
  expect(card.dueAt).toBeUndefined(); expect(card.dueTz).toBeUndefined();
  expect(card).toMatchObject({ icon: "brush-cleaning", color: "slate" }); expect(card.text).toContain("30.09 12:00 · Обслуговування дошки"); expect(card.details).toStartWith("Delegatus board maintenance run");
  expect(h.bodies[0]).toMatchObject({ role: "maintainer", taskId: card.id, cwd: "/fixtures/repository", project: PROJECT, clientAttemptId: run.runId });
});
test("large board-maintenance briefs reach the shared structured composer and keep a stable full-file reference", async () => {
  const evidence: TaskWorkEvidence[] = Array.from({ length: 80 }, (_, task) => ({
    taskId: `maintenance-${task.toString().padStart(8, "0")}`,
    status: "assigned",
    verdict: "quiet",
    lastWorkAt: null,
    lanes: [],
    workers: Array.from({ length: 5 }, (_, worker) => ({
      conversationId: `conversation_${task}_${worker}_${"evidence".repeat(9)}`,
      via: "assignment" as const,
      lifecycle: "unknown" as const,
      lastRecordAt: null,
    })),
  }));
  const h = harness(true, evidence);
  await h.controller.launchIfDue(input());
  const original = String(h.bodies[0]!.prompt);
  expect(Buffer.byteLength(original, "utf8")).toBeGreaterThan(32_000);
  const cwd = path.join(held!.dir, "repository");
  fs.mkdirSync(cwd, { recursive: true });
  const bounded = await composeStructuredFirstMessage(original, cwd);
  expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(32_000);
  const file = bounded.match(/Full structured first message file: (.+)\n/)?.[1];
  expect(file).toBeDefined();
  expect(fs.readFileSync(file!, "utf8")).toBe(original);
  expect(await composeStructuredFirstMessage(original, cwd)).toBe(bounded);

  const run = h.run();
  const { patchMaintenanceRun } = await import("./store");
  patchMaintenanceRun(run.runId, { conversationId: null, state: "launching" });
  await h.controller.reconcile(PROJECT);
  expect(await composeStructuredFirstMessage(String(h.bodies[1]!.prompt), cwd)).toBe(bounded);
});
test("no account leaves one blocked visible card, success summarizes, hides and archives", async () => {
  const h = harness(); h.respond({ status: 409, body: { code: "project_account_refused", error: "fixture no allowed account" } });
  await h.controller.launchIfDue(input()); const blocked = tasks()[0]; expect(blocked.status).toBe("blocked"); expect(blocked.board).toBe("shown");
  h.now(NOW + 3 * 3600000); h.respond({ status: 202, body: { state: "starting", conversationId: ["conversation", "fixture-worker"].join("_"), path: "/fixtures/worker.jsonl" } }); await h.controller.launchIfDue(input());
  const run = h.run(); recordMaintenanceChange(run.runId, { at: run.claimedAt, taskId: "aabbccdd", tool: "update_task", fields: ["status"], statusFrom: "assigned", statusTo: "inbox" });
  h.observe({ state: "ended", finalText: "attention: aabbccdd | Choose | keep | split | waits: start implementation\nleft: ddeeffaa | open pipeline\nVerdict: pass" }); await h.controller.reconcile(PROJECT);
  const done = tasks().find(t => t.id === run.taskId)!; expect(done).toMatchObject({ status: "done", board: "hidden" }); expect(done.text).toContain("змінено 1 задач"); expect(done.text).toContain("Choose"); expect(h.archived).toEqual([run.runId]); expect(tasks().find(t => t.id === blocked.id)?.status).toBe("done");
  const ended = readMaintenanceRun(run.runId)!; expect(ended.log.leftAlone).toHaveLength(1);
  const snapshot = JSON.stringify(tasks()); await h.controller.reconcile(PROJECT); expect(JSON.stringify(tasks())).toBe(snapshot);
});
test("a launch refused for lack of an account records the engine the maintainer row runs on", async () => {
  const h = harness(); h.respond({ status: 409, body: { code: "ENGINE_NOT_CONNECTED", error: "fixture engine not connected" } });
  await h.controller.launchIfDue(input());
  expect(maintenanceRuns(PROJECT)).toHaveLength(1); expect(maintenanceRuns(PROJECT)[0]!.failure).toMatchObject({ kind: "no-account", engine: "codex" });
  expect(tasks()[0]!.text).toContain("немає доступного акаунта Codex");
  saveRoleMapping({ maintainer: { config: { engine: "claude", model: "opus", effort: "medium" } } });
  h.now(NOW + 3 * 3600000); await h.controller.launchIfDue(input());
  const claude = maintenanceRuns(PROJECT)[1]!;
  expect(claude.failure).toMatchObject({ kind: "no-account", engine: "claude" });
  expect(tasks().find(t => t.id === claude.taskId)!.text).toContain("немає доступного акаунта Claude");
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
  const { taskShowsOnBoard } = await import("@/lib/tasks/boardVisibility");
  const { saveTasks } = await import("@/lib/tasks/store");
  const transcriptPath = "/fixtures/worker.jsonl";
  const conversation = h.registry.ensureConversation("codex", transcriptPath, null);
  patchMaintenanceRun(old.runId, { conversationId: conversation.id, launchId: "fixture-launch", transcriptPath });
  saveTasks(tasks().map(task => task.id === oldTaskId ? { ...task, assignments: [...task.assignments, { path: transcriptPath, conversationId: conversation.id, panePid: null, state: "delivered" as const, error: null, at: new Date(NOW).toISOString() }] } : task), statePath("tasks.json"));
  h.observe({ state: "failed", failure: { kind: "host-died", detail: "host exited over an open turn" } }); await h.controller.reconcile(PROJECT);
  const cardBefore = tasks().find(t => t.id === oldTaskId)!;
  expect(taskShowsOnBoard(cardBefore, true)).toBe(true);
  h.now(NOW + 3 * 3600000); await h.controller.launchIfDue(input()); const latest = h.run();
  h.observe({ state: "failed", failure: { kind: "host-died", detail: "host exited over an open turn" } }); await h.controller.reconcile(PROJECT);
  expect(readMaintenanceRun(latest.runId)!.supersededTaskIds).toContain(oldTaskId);
  expect(boardFor(PROJECT).prefs.hidden).toContain(transcriptPath);
  const cardAfter = tasks().find(t => t.id === oldTaskId)!;
  expect(taskShowsOnBoard(cardAfter, false)).toBe(false);
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

const holdUpdate = () => writeDrain(drainFile(), { id: "maintenance-drain", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
test("update admission holds fresh maintenance claims and release admits one run", async () => {
  const h = harness(); holdUpdate();
  await h.controller.launchIfDue(input()); await h.controller.launchIfDue(input());
  expect(h.bodies).toHaveLength(0); expect(readMaintenanceProject(PROJECT)).toBeNull();
  releaseDrain(drainFile(), "maintenance-drain");
  await h.controller.launchIfDue(input()); await h.controller.launchIfDue(input());
  expect(h.bodies).toHaveLength(1);
});
test("update admission rechecks after evidence and retains an undispatched claim across cold recovery", async () => {
  let entered!: () => void, resume!: () => void;
  const collecting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const h = harness(true, { evidence: async () => { entered(); await gate; return []; } });
  const launch = h.controller.launchIfDue(input());
  await collecting; holdUpdate(); resume(); await launch;
  const run = h.run();
  expect(h.bodies).toHaveLength(0); expect(run.launchId).toBeNull();
  h.now(NOW + 7 * 3600000);
  const recovered = productionBoardMaintenanceController(h.sources, { auditInput: async () => undefined, observe: async () => ({ state: "running" }), evidence: async () => [], launch: async body => {
    h.bodies.push(body); return { status: 202, body: { state: "starting", conversationId: "conversation_fixture_held", launchId: "held-launch" } };
  } });
  await recovered.reconcile(PROJECT);
  expect(h.run().state).not.toBe("failed"); expect(h.bodies).toHaveLength(0);
  releaseDrain(drainFile(), "maintenance-drain");
  await recovered.reconcile(PROJECT); await recovered.reconcile(PROJECT);
  expect(h.bodies).toHaveLength(1); expect(h.bodies[0].clientAttemptId).toBe(run.runId);
});
test("submitted maintenance settles its receipt during update hold", async () => {
  const h = harness(); await h.controller.launchIfDue(input()); holdUpdate();
  h.observe({ state: "ended", finalText: "Verdict: pass" });
  await h.controller.reconcile(PROJECT);
  expect(maintenanceRuns(PROJECT)[0].state).toBe("succeeded"); expect(h.bodies).toHaveLength(1);
});

test("an undispatched launch payload retains its key and restarts its dispatch clock after update admission", async () => {
  const h = harness(); const run = claim();
  const { patchMaintenanceRun } = await import("./store");
  const body = { clientAttemptId: run.runId, role: "maintainer", prompt: "fixture maintenance" };
  patchMaintenanceRun(run.runId, { state: "launching", launchBody: body, launchedAt: new Date(NOW).toISOString() });
  holdUpdate(); h.now(NOW + 7 * 3600000);
  await h.controller.reconcile(PROJECT);
  expect(h.bodies).toHaveLength(0); expect(h.run().launchBody).toEqual(body);
  releaseDrain(drainFile(), "maintenance-drain");
  await h.controller.reconcile(PROJECT); await h.controller.reconcile(PROJECT);
  expect(h.bodies).toEqual([body]);
  expect(h.run().launchedAt).toBe(new Date(NOW + 7 * 3600000).toISOString());
  expect(readMaintenanceProject(PROJECT)!.lastLaunchAt).toBe(h.run().launchedAt);
});
test("admission deferred by the production spawn lane retries its payload after release", async () => {
  let refuse = true;
  const h = harness(true, { launch: async body => {
    if (refuse) { holdUpdate(); return { status: 503, body: { code: "AUTO_UPDATE_DRAIN" } }; }
    h.bodies.push(body); return { status: 202, body: { state: "starting", conversationId: "conversation_fixture_resumed", launchId: "resumed-launch" } };
  } });
  await h.controller.launchIfDue(input()); const run = h.run();
  expect(run.state).toBe("launching"); expect(run.admissionDeferred).toBe(true);
  expect(h.bodies).toHaveLength(0);
  await h.controller.reconcile(PROJECT); expect(h.bodies).toHaveLength(0);
  h.now(NOW + 7 * 3600000); refuse = false; releaseDrain(drainFile(), "maintenance-drain");
  await h.controller.reconcile(PROJECT);
  expect(h.bodies).toEqual([run.launchBody!]); expect(h.run().admissionDeferred).toBe(false);
});
test("a maintenance receipt arriving before its binding checkpoint remains recoverable under hold", async () => {
  const h = harness(); const run = claim();
  const { patchMaintenanceRun } = await import("./store");
  patchMaintenanceRun(run.runId, { state: "launching", launchedAt: new Date(NOW).toISOString() });
  const receipt = { state: "completed", conversationId: "conversation_fixture_submitted", launchId: "submitted-launch" };
  const original = h.registry.spawnReceiptForClientAttempt.bind(h.registry);
  h.registry.spawnReceiptForClientAttempt = id => id === run.clientAttemptId ? receipt as never : original(id);
  h.observe({ state: "ended", conversationId: receipt.conversationId, launchId: receipt.launchId, finalText: "Verdict: pass" });
  holdUpdate(); await h.controller.reconcile(PROJECT);
  expect(maintenanceRuns(PROJECT)[0].state).toBe("succeeded"); expect(h.bodies).toHaveLength(0);
});

test("Casablanca launch admission and dispatch follow permanent UTC", async () => {
  const h = harness();
  const request = input();
  const window = { timeZone: "Africa/Casablanca", weekdays: [7], startHour: 2, endHour: 3 };
  request.settings.maintenance.window = window;
  const original = h.sources.settings;
  h.sources.settings = project => {
    const settings = original(project);
    return { ...settings, maintenance: { ...settings.maintenance!, window } };
  };
  h.now(Date.parse("2026-10-25T01:30:00Z"));
  expect(await h.controller.launchIfDue(request)).toContain("window");
  expect(readMaintenanceProject(PROJECT)).toBeNull();
  expect(h.bodies).toHaveLength(0);
  h.now(Date.parse("2026-10-25T02:30:00Z"));
  await h.controller.launchIfDue(request);
  expect(h.bodies).toHaveLength(1);
});

test("closed windows defer launches while a running turn still settles", async () => {
  const h = harness();
  const request = input();
  request.settings.maintenance.window = { timeZone: "Etc/UTC", weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 };
  // Poll on a weekend after several missed intervals: no catch-up launch.
  h.now(Date.parse("2026-10-10T12:00:00Z"));
  expect(await h.controller.launchIfDue(request)).toContain("window");
  expect(readMaintenanceProject(PROJECT)).toBeNull();
  h.now(Date.parse("2026-10-12T09:00:00Z"));
  await h.controller.launchIfDue(request);
  await h.controller.launchIfDue(request);
  expect(h.bodies).toHaveLength(1);
  // A running turn still reconciles after the window closes.
  h.now(Date.parse("2026-10-12T17:00:00Z"));
  h.observe({ state: "ended", finalText: "Verdict: pass" });
  await h.controller.reconcile(PROJECT);
  expect(maintenanceRuns(PROJECT)[0].state).toBe("succeeded");
  await h.controller.launchIfDue(request);
  expect(h.bodies).toHaveLength(1);
});

for (const change of ["clock", "setting"]) test(`a window ${change} change during evidence preparation prevents dispatch`, async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const h = harness(true, { evidence: async () => { entered(); await pending; return []; } });
  const open = { timeZone: "Etc/UTC", weekdays: [3], startHour: 12, endHour: 13 };
  const original = h.sources.settings;
  let window = open;
  h.sources.settings = project => ({ ...original(project), maintenance: { ...input().settings.maintenance, window, updatedAt: new Date(NOW).toISOString(), setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } } });
  const request = input(); request.settings.maintenance.window = open;
  const launch = h.controller.launchIfDue(request);
  await ready;
  if (change === "clock") h.now(NOW + 60 * 60_000);
  else window = { ...open, weekdays: [4] };
  release();
  expect(await launch).toContain("window");
  expect(h.bodies).toHaveLength(0);
  window = { ...open, endHour: 14 };
  await h.controller.reconcile(PROJECT);
  expect(h.bodies).toHaveLength(1);
});

test("skip, coalescing and cooldown survive fresh controller processes", async () => {
  held = sandbox();
  const window = { timeZone: "Etc/UTC", weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 };
  writeSeatTickSettings(PROJECT, { ...defaultSeatTickSettings(PROJECT), maintenance: { enabled: true, intervalHours: 3, window, updatedAt: "2026-10-09T09:00:00.000Z", setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } } });
  const restart = async (at: string) => {
    const program = `
      import { productionBoardMaintenanceController } from "./src/lib/boardMaintenance/run";
      import { defaultSeatTickSources } from "./src/lib/monitor/seatTickSources";
      import { readSeatTickSettings, effectiveSeatTickSettings } from "./src/lib/monitor/seatTickSettings";
      import { maintenanceRuns } from "./src/lib/boardMaintenance/store";
      import { input, PROJECT } from "./src/lib/boardMaintenance/testFixture";
      const now = Date.parse(${JSON.stringify(at)});
      const sources = { ...defaultSeatTickSources(), now: () => now, tasks: () => [], pipelines: () => [{ project: PROJECT, repoDir: "/fixtures/repository" }], latestDeployment: () => ({ state: "ok", value: null }) };
      let launches = 0;
      const controller = productionBoardMaintenanceController(sources, { auditInput: async () => undefined, evidence: async () => [], archive: () => {}, locale: () => "en", timeZone: () => "UTC", observe: async () => ({ state: "ended", finalText: "Verdict: pass" }), launch: async () => { launches++; return { status: 202, body: { conversationId: "conversation_fixture_window", launchId: "fixture-window-launch" } }; } });
      const request = input(); request.now = now; request.settings = effectiveSeatTickSettings(readSeatTickSettings(PROJECT), now, 300000);
      await controller.reconcile(PROJECT);
      await controller.launchIfDue(request); await controller.launchIfDue(request);
      await controller.reconcile(PROJECT);
      console.log(JSON.stringify({ launches, runs: maintenanceRuns(PROJECT).length }));
    `;
    const child = Bun.spawn([process.execPath, "-e", program], { cwd: process.cwd(), env: { ...process.env, LLV_STATE_DIR: held.dir }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`maintenance child exited ${code}: ${stderr}`);
    return JSON.parse(stdout);
  };
  expect(await restart("2026-10-10T12:00:00Z")).toEqual({ launches: 0, runs: 0 });
  expect(await restart("2026-10-12T09:00:00Z")).toEqual({ launches: 1, runs: 1 });
  expect(await restart("2026-10-12T09:30:00Z")).toEqual({ launches: 0, runs: 1 });
  expect(await restart("2026-10-12T12:00:00Z")).toEqual({ launches: 1, runs: 2 });
});

test("a recovered undispatched claim stays held outside its current window", async () => {
  const h = harness(); claim();
  const settings = h.sources.settings;
  h.sources.settings = project => ({ ...settings(project), maintenance: { enabled: true, intervalHours: 3, updatedAt: new Date(NOW).toISOString(), setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null }, window: { timeZone: "Etc/UTC", weekdays: [1], startHour: 9, endHour: 17 } } });
  expect(await h.controller.reconcile(PROJECT)).toContain("window");
  expect(h.bodies).toHaveLength(0);
});

for (const mode of ["off", "malformed"]) test(`a ${mode} maintenance setting cannot dispatch a recovered claim`, async () => {
  const h = harness(); const run = claim();
  const { readSeatTickSettings } = await import("@/lib/monitor/seatTickSettings");
  const initial = h.sources.settings(PROJECT);
  writeSeatTickSettings(PROJECT, { ...initial, maintenance: { ...initial.maintenance!, enabled: mode !== "off", window: mode === "off" ? null : { timeZone: "Invalid/Zone", weekdays: [1], startHour: 9, endHour: 17 } } });
  h.sources.settings = readSeatTickSettings;
  expect(await h.controller.reconcile(PROJECT)).toContain("maintenance is off");
  expect(h.bodies).toHaveLength(0);
  expect(tasks()).toHaveLength(0);
  writeSeatTickSettings(PROJECT, initial);
  await h.controller.reconcile(PROJECT);
  expect(h.bodies).toHaveLength(1);
  expect(h.bodies[0].clientAttemptId).toBe(run.runId);
});

test("a submitted receipt reconciles outside the window before its binding checkpoint", async () => {
  const h = harness(); const run = claim();
  const { patchMaintenanceRun } = await import("./store");
  patchMaintenanceRun(run.runId, { state: "launching", launchedAt: new Date(NOW).toISOString() });
  const receipt = { state: "starting", conversationId: "conversation_fixture_window_receipt", launchId: "fixture-window-receipt" };
  h.registry.spawnReceiptForClientAttempt = id => id === run.clientAttemptId ? receipt as never : null;
  const original = h.sources.settings;
  h.sources.settings = project => ({ ...original(project), maintenance: { ...input().settings.maintenance, window: { timeZone: "Etc/UTC", weekdays: [1], startHour: 0, endHour: 1 }, updatedAt: new Date(NOW).toISOString(), setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } } });
  h.observe({ state: "ended", conversationId: receipt.conversationId, launchId: receipt.launchId, finalText: "Verdict: pass" });
  await h.controller.reconcile(PROJECT);
  expect(readMaintenanceRun(run.runId)!.state).toBe("succeeded");
  expect(h.bodies).toHaveLength(0);
});


test("request audit refuses a final without its own manifest on the production controller", async () => {
  const h = harness();
  h.sources.seatFor = () => ({ active: { ...input().seat!, state: "active" }, pending: null, history: [] }) as never;
  const controller = productionBoardMaintenanceController(h.sources, { evidence: async () => [], archive: () => {}, launch: async () => ({ status: 202, body: { state: "starting" } }), observe: async () => ({ state: "ended", finalText: "Verdict: pass" }) });
  await controller.launchIfDue(input());
  const run = maintenanceRuns(PROJECT).at(-1)!;
  expect(run.launchBody).toBeDefined();
  await controller.reconcile(PROJECT);
  expect(readMaintenanceRun(run.runId)?.state).toBe("failed");
  expect(readMaintenanceProject(PROJECT)?.audit?.through).toBeNull();
  expect(readMaintenanceProject(PROJECT)?.audit?.window?.upper).toBe(run.claimedAt);
});

test("request audit pins payload and refuses the replaced owner after the last native launch await", async () => {
  const { auditFixture } = await import("./testFixture");
  const h = harness(true, { auditInput: async run => ({ ...auditFixture(run), revision: 0 }) });
  h.sources.seatFor = () => ({ active: input().seat!, pending: null, history: [] }) as never;
  let release!: () => void; let entered!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let effects = 0;
  const controller = productionBoardMaintenanceController(h.sources, { auditInput: async run => ({ ...auditFixture(run), revision: 0 }), evidence: async () => [], launch: async (_body, authorize) => { entered(); await barrier; authorize!(); effects++; return { status: 202, body: {} }; } });
  const launched = controller.launchIfDue(input());
  await Promise.race([arrived, launched.then(() => { throw Error("launch returned before its barrier"); })]);
  const run = h.run(); const body = run.launchBody;
  h.sources.seatFor = () => ({ active: { ...input().seat!, seatEpoch: 2 }, pending: null, history: [] }) as never;
  release();
  await expect(launched).rejects.toThrow("authority changed");
  expect(effects).toBe(0); expect(readMaintenanceRun(run.runId)?.launchBody).toEqual(body);
  expect(readMaintenanceRun(run.runId)?.state).toBe("failed");
  expect(readMaintenanceProject(PROJECT)?.currentRunId).toBeNull();
  expect(readMaintenanceProject(PROJECT)?.audit?.window?.upper).toBe(run.claimedAt);
});

test("request audit ignores stale observe after its run settles elsewhere", async () => {
  const h = harness(); await h.controller.launchIfDue(input()); const run = h.run();
  let release!: () => void; let entered!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const observer = productionBoardMaintenanceController(h.sources, { observe: async () => { entered(); await barrier; return { state: "ended", finalText: "Verdict: pass" }; } });
  const observation = observer.reconcile(PROJECT); await arrived;
  const { patchMaintenanceRun } = await import("./store");
  patchMaintenanceRun(run.runId, { state: "failed", failure: { kind: "agent-fail", detail: "independent terminal result" } });
  release(); await observation;
  expect(readMaintenanceRun(run.runId)?.failure?.detail).toBe("independent terminal result");
});

test("audit preparation refuses native seat replacement during its evidence await", async () => {
  const h = harness();
  h.sources.seatFor = () => ({ active: input().seat!, pending: null, history: [] }) as never;
  const id = input().seat!.conversationId;
  const snapshot = structuredClone(h.registry.readOnlySnapshot());
  snapshot.conversations[id] = { id, engine: "codex", projectOwnership: { project: PROJECT }, generations: [{ id: "original-generation", path: "fixture-seat.jsonl", launchProfile: {} }] } as never;
  h.sources.registry = () => ({ conversation: () => snapshot.conversations[id], readOnlySnapshot: () => snapshot, spawnReceiptForClientAttempt: () => null }) as never;
  let dispatches = 0;
  const controller = productionBoardMaintenanceController(h.sources, {
    evidence: async () => { snapshot.conversations[id].generations[0].id = "replacement-generation"; return []; },
    launch: async () => { dispatches++; return { status: 202, body: {} }; },
  });
  expect(await controller.launchIfDue(input())).toContain("claim replaced");
  expect(dispatches).toBe(0);
  const stale = maintenanceRuns(PROJECT).at(-1)!;
  expect(stale.launchBody).toBeUndefined(); expect(stale.state).toBe("failed");
  expect(readMaintenanceProject(PROJECT)?.currentRunId).toBeNull();
});

test("rotated audit claim is reconciled, reverified, settled, and then starts the next window", async () => {
  const { auditFixture } = await import("./testFixture");
  const makeAudit: NonNullable<BoardMaintenancePorts["auditInput"]> = async (run, _sources, state) => {
    const audit = auditFixture(run);
    audit.occurrences = [];
    if (state?.window) {
      audit.window = structuredClone(state.window);
      audit.window.sources = [{ ...auditFixture(run).window.sources[0], complete: true, gap: null }];
      audit.window.gaps = audit.window.gaps.filter(gap => gap !== "claim-replaced" && gap !== "seat-lineage-unavailable" && !gap.startsWith("seat-source-unverified:"));
      audit.unread = { [audit.window.sources[0].key]: null };
    } else if (state?.through) {
      audit.window = { ...audit.window, lower: state.through, upper: run.claimedAt, sources: [], gaps: [], decisionScanComplete: true };
      audit.unread = {};
    } else {
      audit.window.sources = [];
      audit.window.gaps = ["seat-lineage-unavailable", `seat-source-unverified:${run.seat.conversationId}`];
      audit.window.decisionScanComplete = true;
      audit.unread = {};
    }
    return { ...audit, revision: state?.revision ?? 0 };
  };
  const h = harness(true, { auditInput: makeAudit });
  h.sources.seatFor = () => ({ active: input().seat!, pending: null, history: [] }) as never;
  const controller = productionBoardMaintenanceController(h.sources, {
    auditInput: makeAudit, evidence: async () => [],
    launch: async () => ({ status: 202, body: { state: "starting", conversationId: "conversation_fixture_worker", launchId: "fixture-worker" } }),
    observe: async run => ({ state: "ended", finalText: `audit-manifest: ${JSON.stringify({ version: 1, runId: run.runId, revision: run.audit!.revision, lower: run.audit!.window.lower, upper: run.audit!.window.upper, rows: 0, occurrences: [] })}\nVerdict: pass` }),
  });
  await controller.launchIfDue(input());
  const previous = maintenanceRuns(PROJECT).at(-1)!;
  expect(previous).toMatchObject({ state: "launching", launchedAt: expect.any(String), audit: { revision: 1 } });
  h.sources.seatFor = () => ({ active: { ...input().seat!, seatEpoch: 2 }, pending: null, history: [] }) as never;
  expect(await controller.reconcile(PROJECT)).toBe("maintenance: claim replaced");
  expect(readMaintenanceRun(previous.runId)?.state).toBe("failed");
  expect(readMaintenanceProject(PROJECT)?.currentRunId).toBeNull();
  expect(readMaintenanceRun(previous.runId)?.log.audit?.window.gaps).toContain("claim-replaced");
  expect(readMaintenanceProject(PROJECT)?.audit).toMatchObject({ through: null, window: { upper: previous.claimedAt, gaps: expect.arrayContaining(["claim-replaced", "seat-lineage-unavailable"]) } });
  h.now(NOW + 4 * 3600000);
  const resumedRequest = input(); resumedRequest.now = NOW + 4 * 3600000; resumedRequest.seat = { ...resumedRequest.seat!, seatEpoch: 2 };
  expect(await controller.launchIfDue(resumedRequest)).toContain("launched");
  const resumed = maintenanceRuns(PROJECT).at(-1)!;
  expect(resumed.runId).not.toBe(previous.runId);
  expect(resumed.launchBody).toBeDefined();
  expect(resumed.audit?.window).toMatchObject({ lower: readMaintenanceProject(PROJECT)?.audit?.window?.lower, upper: previous.claimedAt, gaps: [] });
  await controller.reconcile(PROJECT);
  expect(readMaintenanceRun(resumed.runId)?.state).toBe("succeeded");
  expect(readMaintenanceProject(PROJECT)?.audit).toMatchObject({ through: previous.claimedAt, window: null });
  h.now(NOW + 7 * 3600000);
  const nextRequest = input(); nextRequest.now = NOW + 7 * 3600000; nextRequest.seat = { ...nextRequest.seat!, seatEpoch: 2 };
  expect(await controller.launchIfDue(nextRequest)).toContain("launched");
  const nextWindow = maintenanceRuns(PROJECT).at(-1)!;
  expect(nextWindow.runId).not.toBe(resumed.runId);
  await controller.reconcile(PROJECT);
  expect(readMaintenanceRun(nextWindow.runId)?.state).toBe("succeeded");
  expect(readMaintenanceProject(PROJECT)?.audit).toMatchObject({ through: nextWindow.claimedAt, window: null });
});


test("production audit input covers rotated seats, exact window and revised operator forms", async () => {
  const h = harness(); const run = claim();
  const { buildMaintenanceAuditInput } = await import("./audit");
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const { claimInstall } = await import("@/lib/team/members");
  const { messageTextDigest } = await import("@/lib/team/events");
  const { viewerReadTools, openPinnedTranscript } = await import("@/lib/mcp/bindings");
  resetTeamStoreForTests();
  const store = teamStore();
  const owner = claimInstall(store, "Fixture owner", { surface: "desktop", browser: "chrome" }, NOW - 3600000).member;
  const ids = [input().seat!.conversationId, "conversation_fixture-previous-seat"];
  const snapshot = structuredClone(h.registry.readOnlySnapshot());
  const times = [NOW - 1000, NOW, NOW - 3600000];
  for (const [index, id] of ids.entries()) {
    const transcript = path.join(held.dir, `audit-${index}.jsonl`);
    const records = (index ? [times[2]] : times.slice(0, 2)).map((time, i) => {
      const text = `fixture request ${index}-${i}`;
      store.recordMessageAuthor({ clientMessageId: `fixture-message-${index}-${i}`, conversationId: id, memberId: owner.id, at: new Date(time).toISOString(), textDigest: messageTextDigest(text) });
      return { type: "response_item", timestamp: new Date(time).toISOString(), payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } };
    });
    fs.writeFileSync(transcript, records.map(r => JSON.stringify(r)).join("\n") + "\n");
    snapshot.conversations[id] = { id, engine: "codex", projectOwnership: { project: PROJECT }, generations: [{ id: `native-${index}`, path: transcript, launchProfile: {}, createdAt: new Date(NOW - 4000000).toISOString() }], continuityPaths: [], abandonedContinuityPaths: [], migration: null } as never;
  }
  fs.writeFileSync(statePath("orchestrator-seats.json"), JSON.stringify({ schemaVersion: 1, nextSeatEpoch: 3, seats: {}, pending: {}, revocations: [], history: [], seatLineage: ids.map((conversationId, i) => ({ project: PROJECT, conversationId, seatEpoch: i + 1 })) }));
  h.sources.registry = () => ({ ...h.registry, conversation: (id: string) => snapshot.conversations[id], readOnlySnapshot: () => snapshot }) as never;
  const form = { id: `pr_${"a".repeat(32)}`, taskId: "fixture-form-task", project: PROJECT, title: "Fixture questions", createdAt: new Date(NOW - 86400000).toISOString(), source: { conversationId: ids[0] }, publicationKey: "fixture-publication", inputDigest: "fixture-input", variants: [], questions: [{ id: "question", text: "Next action", options: [{ label: "Wait", recommended: true }] }], decision: { chosen: [], comment: "", skipped: true, answers: [{ questionId: "question", options: [], skipped: true }], at: new Date(NOW - 500).toISOString(), decidedBy: { kind: "member", memberId: owner.id }, revision: 2, delivery: { state: "pending", clientMessageId: "fixture-decision", conversationId: ids[0], text: "fixture" } } };
  h.sources.tasks = () => [{ id: form.taskId, project: PROJECT, prototypeReviews: [form] }] as never;
  const registryModule = await import("@/lib/agent/registry");
  const registrySpy = spyOn(registryModule, "agentRegistry").mockReturnValue({ conversationForPath: (file: string) => Object.values(snapshot.conversations).find(c => c.generations.some(g => g.path === file)) } as never);
  const reader = viewerReadTools({ pinnedTranscript: (file: string) => openPinnedTranscript(file, { roots: [["codex-sessions", held.dir]], pathAllowed: candidate => candidate.startsWith(held.dir + path.sep) }), selectedContext: { registry: () => ({ readOnlySnapshot: () => snapshot }) } } as never);
  const ports = { artifact: (file: string) => { const stat = fs.statSync(file); return { artifact: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, size: stat.size }; }, read: async (file: string, since: string, cursor?: string) => await reader.conversation_messages({ transcriptPath: file, since, cursor, full: true, kinds: ["message"], roles: ["user"], maxChars: 16000 }) as never };
  try {
    const audit = await buildMaintenanceAuditInput(run, h.sources, { version: 1, revision: 0, through: new Date(NOW - 3600000).toISOString(), window: null }, ports);
    expect(audit.window.sources.map(s => s.gap)).toEqual([null, null, null]);
    expect(audit.window.sources).toHaveLength(3); expect(audit.operator).toEqual({ kind: "member", memberId: owner.id });
    expect(audit.occurrences.map(o => o.at).sort()).toEqual([new Date(NOW - 3600000).toISOString(), new Date(NOW - 1000).toISOString(), new Date(NOW - 500).toISOString()]);
    expect(audit.occurrences.every(o => o.verified)).toBe(true);
    const missingRoster = { ...audit.window, sources: audit.window.sources.filter(source => source.conversationId !== ids[1]), gaps: ["operator-anchor-unverified", "seat-lineage-unavailable", `seat-source-unverified:${ids[1]}`, "claim-replaced"] };
    const recovered = await buildMaintenanceAuditInput(run, h.sources, { version: 1, revision: 1, through: null, window: missingRoster }, ports);
    expect(recovered.operator).toEqual({ kind: "member", memberId: owner.id });
    expect(recovered.window.gaps).toEqual([]);
    expect(recovered.window.sources.some(source => source.conversationId === ids[1])).toBe(true);
    const frozen = structuredClone(audit);
    fs.appendFileSync(snapshot.conversations[ids[0]].generations[0].path, JSON.stringify({ type: "response_item", timestamp: new Date(NOW + 1000).toISOString(), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "later request" }] } }) + "\n");
    const next = await buildMaintenanceAuditInput({ ...run, claimedAt: new Date(NOW + 3600000).toISOString() }, h.sources, { version: 1, revision: 1, through: null, window: frozen.window }, ports);
    expect(next.window.upper).toBe(frozen.window.upper); expect(next.occurrences).toEqual(frozen.occurrences);
    const decisionInput = JSON.parse(audit.occurrences.find(o => o.source === audit.window.sources.find(s => s.kind === "decision")!.key)!.text);
    expect(decisionInput.decision).toMatchObject({ revision: 2, skipped: true, answers: [{ skipped: true }] });
    const oversizedForm = structuredClone(form);
    oversizedForm.decision.comment = "я".repeat(24000);
    h.sources.tasks = () => [{ id: form.taskId, project: PROJECT, prototypeReviews: [oversizedForm] }] as never;
    const oversized = await buildMaintenanceAuditInput(run, h.sources, { version: 1, revision: 0, through: frozen.window.lower, window: null }, ports);
    const oversizeSource = oversized.window.sources.find(s => s.kind === "decision")!;
    expect(oversizeSource.gap).toBe(`decision-record-oversize:${oversizeSource.key}`);
    expect(oversized.unread[oversizeSource.key]).toEqual({ seq: 0, requestIndex: 0 });
    expect(oversized.occurrences.some(o => o.source === oversizeSource.key)).toBe(false);
    h.sources.tasks = () => [{ id: form.taskId, project: PROJECT, prototypeReviews: [form] }] as never;
    const { initializeStateCollections } = await import("@/lib/state/sqliteStateStore");
    const { SEAT_DECISIONS_COLLECTION } = await import("@/lib/prototypeReview/seatRounds");
    const tailId = `pr_${(257).toString(16).padStart(32, "0")}`;
    const tail = { ...structuredClone(form), id: tailId, taskId: null, decision: { ...structuredClone(form.decision), delivery: { ...form.decision.delivery, clientMessageId: "fixture-tail-decision" } } };
    initializeStateCollections(statePath("state.sqlite"), [{ collection: SEAT_DECISIONS_COLLECTION, schemaVersion: 1, migrationId: "seat-decisions-v1", key: (raw: unknown) => (raw as { id: string }).id,
      loadRecords: () => [...Array.from({ length: 256 }, (_, i) => ({ id: `pr_${(i + 1).toString(16).padStart(32, "0")}` })), tail] }]);
    const bounded = await buildMaintenanceAuditInput(run, h.sources, { version: 1, revision: 0, through: frozen.window.lower, window: null }, ports);
    expect(bounded.window.decisionScanComplete).toBe(false);
    expect(bounded.window.decisionCursor).toBe(`pr_${(256).toString(16).padStart(32, "0")}`);
    const continued = await buildMaintenanceAuditInput(run, h.sources, { version: 1, revision: 1, through: null, window: bounded.window }, ports);
    expect(continued.window.upper).toBe(bounded.window.upper);
    expect(continued.window.decisionScanComplete).toBe(true);
    expect(continued.window.gaps).not.toContain("seat-decisions-unread");
    const tailSource = continued.window.sources.find(s => s.decision?.roundId === tailId)!;
    expect(continued.occurrences.some(o => o.source === tailSource.key && o.verified)).toBe(true);
    form.decision.revision = 3; form.decision.at = new Date(NOW + 1000).toISOString(); Object.assign(form.decision, { rejected: true });
    const rejected = await buildMaintenanceAuditInput(run, h.sources, { version: 1, revision: 1, through: null, window: frozen.window }, ports);
    expect(rejected.window.sources.find(s => s.kind === "decision")!.gap).toBe("decision-replaced");
    fs.renameSync(snapshot.conversations[ids[0]].generations[0].path, snapshot.conversations[ids[0]].generations[0].path + ".old");
    fs.writeFileSync(snapshot.conversations[ids[0]].generations[0].path, "replacement");
    const replaced = await buildMaintenanceAuditInput(run, h.sources, { version: 1, revision: 1, through: null, window: frozen.window }, ports);
    expect(replaced.window.sources.find(s => s.path === snapshot.conversations[ids[0]].generations[0].path)!.gap).toBe("artifact-replaced");
  } finally { registrySpy.mockRestore(); resetTeamStoreForTests(); }
});


test("request audit validates the actual final-tail reader and refuses a final displaced beyond 128 KiB", async () => {
  const h = harness(); const run = claim();
  const { auditFixture } = await import("./testFixture");
  const { observeMaintenanceRun } = await import("./run");
  const { parseMaintenanceReport } = await import("./text");
  const registryModule = await import("@/lib/agent/registry");
  const audit = auditFixture(run); const file = path.join(held.dir, "final-reader.jsonl");
  const final = `audit-manifest: ${JSON.stringify({ version: 1, runId: run.runId, revision: 1, lower: audit.window.lower, upper: audit.window.upper, rows: 0, occurrences: audit.occurrences.map(o => ({ key: o.key, requests: 0, nextIndex: 0 })) })}\nVerdict: pass`;
  const at = new Date(NOW + 1000).toISOString();
  const fake = { spawnReceiptForClientAttempt: () => ({ state: "completed", conversationId: "conversation_fixture-final", launchId: "fixture-final", artifactPath: file }), conversation: () => ({ engine: "codex", generations: [{ path: file }] }) };
  const spy = spyOn(registryModule, "agentRegistry").mockReturnValue(fake as never);
  h.sources.registry = () => fake as never;
  h.sources.liveness = async () => [{ reason: "host_gone_turn_settled", lastRecordAt: at }] as never;
  try {
    const envelope = (text: string) => JSON.stringify({ type: "response_item", timestamp: at, payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] } }) + "\n";
    fs.writeFileSync(file, envelope(final));
    const observed = await observeMaintenanceRun(run, h.sources);
    expect(observed.state).toBe("ended");
    expect(parseMaintenanceReport(observed.finalText ?? "", audit).audit).toMatchObject({ complete: true, error: null });
    const nearBudget = `${"left: aabbccdd | ".concat("я".repeat(290), "\n").repeat(150)}${final}`;
    expect(Buffer.byteLength(nearBudget)).toBeGreaterThan(85 * 1024);
    fs.writeFileSync(file, envelope(nearBudget));
    const whole = await observeMaintenanceRun(run, h.sources);
    expect(whole.finalText).toBe(nearBudget);
    expect(parseMaintenanceReport(whole.finalText ?? "", audit).audit).toMatchObject({ complete: true, error: null });
    fs.appendFileSync(file, JSON.stringify({ type: "trace", padding: "я".repeat(140000) }) + "\n");
    const displaced = await observeMaintenanceRun(run, h.sources);
    expect(parseMaintenanceReport(displaced.finalText ?? "", audit).audit).toMatchObject({ complete: false, error: "manifest-identity-or-count" });
    fs.writeFileSync(file, envelope(final.replace(run.runId, "foreign-run")));
    const foreign = await observeMaintenanceRun(run, h.sources);
    expect(parseMaintenanceReport(foreign.finalText ?? "", audit).audit!.error).not.toBeNull();
  } finally { spy.mockRestore(); }
});


test("production audit input retains partial pages, cursor resets and unverified or truncated occurrences", async () => {
  const h = harness(); const run = claim();
  const { auditFixture } = await import("./testFixture");
  const { buildMaintenanceAuditInput } = await import("./audit");
  const audit = auditFixture(run); const source = audit.window.sources[0];
  const prior = { version: 1 as const, revision: 1, through: null, window: audit.window };
  const record = { seq: 5, ts: audit.occurrences[0].at, text: "operator request", author: { kind: "operator" } };
  const artifact = () => ({ artifact: source.artifact!, size: source.size });
  let reads = 0;
  const partial = await buildMaintenanceAuditInput(run, h.sources, prior, { artifact, read: async (_path, _since, cursor) => { reads++; return cursor ? { records: [{ ...record, seq: 1 }], hasMore: false } : { records: [record], hasMore: true, cursor: "ephemeral-page", scanned: { capped: true } }; } });
  expect(reads).toBe(2); expect(partial.occurrences.map(o => o.seq)).toEqual([5, 1]); expect(partial.unread[source.key]).toBeNull();
  for (const [flag, gap] of [["truncated", "record-truncated"], ["unknown-author", "author-unverified"], ["foreign-member", "author-unverified"]]) {
    const value = await buildMaintenanceAuditInput(run, h.sources, prior, { artifact, read: async () => ({ records: [{ ...record, ...(flag === "truncated" ? { truncated: true } : { author: flag === "foreign-member" ? { kind: "member", memberId: "unverified-member" } : undefined }) }], hasMore: false }) });
    expect(value.occurrences[0].gap).toBe(gap);
  }
  const reset = await buildMaintenanceAuditInput(run, h.sources, prior, { artifact, read: async () => ({ records: [], hasMore: false, cursorReset: true }) });
  expect(reset.window.sources[0].gap).toBe("cursor-reset"); expect(reset.window.sources[0].from).toBeNull();
  const capped = await buildMaintenanceAuditInput(run, h.sources, prior, { artifact, read: async () => ({ records: [record], hasMore: false, scanned: { capped: true } }) });
  expect(capped.window.sources[0].gap).toBe("page-continuation-missing");
  const missing = await buildMaintenanceAuditInput(run, h.sources, { ...prior, window: { ...prior.window, sources: [{ ...source, from: { seq: 3, requestIndex: 1 } }] } }, { artifact, read: async () => ({ records: [record], hasMore: false }) });
  expect(missing.window.sources[0].gap).toBe("occurrence-unavailable");
});

test("real newest-first transcript pages resume at their durable unread byte cursor after restart", async () => {
  const h = harness(); const run = claim();
  const { auditFixture } = await import("./testFixture");
  const { buildMaintenanceAuditInput } = await import("./audit");
  const { readMessagesPage } = await import("@/lib/session/messagesPage");
  const fixture = auditFixture(run); const source = fixture.window.sources[0];
  const transcript = path.join(held.dir, "newest-first-large.jsonl");
  const records = Array.from({ length: 3201 }, (_, index) => {
    const at = new Date(NOW - (3201 - index) * 1000).toISOString();
    const text = index === 0 ? "older operator request" : `agent insertion ${index}`;
    return JSON.stringify({ type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  });
  fs.writeFileSync(transcript, `${records.join("\n")}\n`);
  const descriptor = fs.openSync(transcript, "r");
  const stat = fs.statSync(transcript);
  const sourceWithArtifact = { ...source, path: transcript, artifact: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, size: stat.size };
  fixture.window.sources[0] = sourceWithArtifact;
  const ports = {
    artifact: (file: string) => { const current = fs.statSync(file); return { artifact: `${current.dev}:${current.ino}:${current.birthtimeMs}`, size: current.size }; },
    read: async (_path: string, since: string, cursor?: string | import("@/lib/session/messagesPage").MessagesPageCursor, durableCursor?: import("@/lib/session/messagesPage").MessagesPageCursor | null) => {
      const encodedCursor = durableCursor ?? cursor ?? null;
      let nativeCursor = (typeof encodedCursor === "string" ? JSON.parse(encodedCursor) : encodedCursor) as import("@/lib/session/messagesPage").MessagesPageCursor | null;
      if (nativeCursor && !Array.isArray(nativeCursor.r)) nativeCursor = { ...nativeCursor, r: [] };
      const page = readMessagesPage({ descriptor, size: stat.size, engine: "codex" }, { kinds: new Set(["message"]), roles: new Set(["user"]), since, limit: 200, maxChars: 16000, cursor: nativeCursor });
      return { ...page, records: page.records.map(record => ({ seq: record.seq, ts: record.ts, text: record.text, author: record.text.startsWith("agent insertion") ? { kind: "agent" } : { kind: "operator" } })) };
    },
  };
  try {
    const first = await buildMaintenanceAuditInput(run, h.sources, { version: 1, revision: 0, through: null, window: fixture.window }, ports);
    expect(first.occurrences).toHaveLength(0);
    const restarted = await buildMaintenanceAuditInput(run, h.sources, { version: 1, revision: 1, through: null, window: first.window }, ports);
    expect(first.window.sources[0]).toMatchObject({ gap: "read-budget-exhausted", scanThrough: { seq: expect.any(Number), at: expect.any(String) } });
    expect(restarted.occurrences.map(o => o.text)).toEqual(["older operator request"]);
    expect(restarted.window.sources[0].gap).toBeNull();
    expect(restarted.window.sources[0].scanThrough).toBeNull();
  } finally { fs.closeSync(descriptor); }
});


test("a failed partial audit resumes the same frozen message request after controller restart", async () => {
  const { auditFixture } = await import("./testFixture");
  const { auditRequestKey } = await import("./audit");
  const h = harness();
  h.sources.seatFor = () => ({ active: input().seat!, pending: null, history: [] }) as never;
  const make = () => productionBoardMaintenanceController(h.sources, { evidence: async () => [], archive: () => {}, auditInput: async (run, _sources, state) => {
    const audit = auditFixture(run);
    if (state?.window) { audit.window = structuredClone(state.window) as typeof audit.window; audit.occurrences[0].requestIndex = state.window.sources[0].from?.requestIndex ?? 0; }
    return { ...audit, revision: state?.revision ?? 0 };
  }, launch: async () => ({ status: 202, body: { state: "starting" } }), observe: async run => {
    const audit = run.audit!; const occurrence = audit.occurrences[0]; const index = occurrence.requestIndex;
    const row = { key: auditRequestKey(occurrence.key, index), occurrence: occurrence.key, requestIndex: index, at: occurrence.at, request: `request ${index}`, outcome: index ? "cancelled" : "done", taskId: null, code: "observed", merge: "unread", install: "unread", acceptance: "observed", checkedAt: run.claimedAt, next: "", dueAt: null, dueTz: null, mutation: null };
    const manifest = { version: 1, runId: run.runId, revision: audit.revision, lower: audit.window.lower, upper: audit.window.upper, rows: 1, occurrences: [{ key: occurrence.key, requests: 2, nextIndex: index + 1 }] };
    return { state: "ended", finalText: `audit-row: ${JSON.stringify(row)}\naudit-manifest: ${JSON.stringify(manifest)}\nVerdict: ${index ? "pass" : "fail"}` };
  } });
  await make().launchIfDue(input()); const first = h.run(); const upper = first.audit!.window.upper;
  await make().reconcile(PROJECT);
  expect(readMaintenanceRun(first.runId)?.state).toBe("failed");
  expect(readMaintenanceProject(PROJECT)?.audit?.window?.sources[0].from).toEqual({ seq: 1, requestIndex: 1 });
  h.now(NOW + 3 * 3600000);
  await make().launchIfDue(input()); const second = h.run();
  expect(second.audit!.window.upper).toBe(upper); expect(second.audit!.occurrences[0].requestIndex).toBe(1);
  await make().reconcile(PROJECT);
  expect(readMaintenanceRun(second.runId)?.log.audit?.rows.map(r => r.requestIndex)).toEqual([1]);
  expect(readMaintenanceProject(PROJECT)?.audit).toMatchObject({ through: upper, window: null, revision: 4 });
});


test("manifest byte admission continues at the next authored part without consuming its requests", async () => {
  const h = harness(); const run = claim();
  const { auditFixture } = await import("./testFixture");
  const { buildMaintenanceAuditInput, auditRequestKey } = await import("./audit");
  const { parseMaintenanceReport } = await import("./text");
  const fixture = auditFixture(run); fixture.window.sources[0].key = "source-" + "s".repeat(10500);
  const source = fixture.window.sources[0];
  const ports = { artifact: () => ({ artifact: source.artifact!, size: source.size }), read: async () => ({ records: [{ seq: 1, ts: fixture.occurrences[0].at, text: "ab", parts: [{ textStart: 0, textEnd: 1, author: { kind: "operator" } }, { textStart: 1, textEnd: 2, author: { kind: "operator" } }] }], hasMore: false }) };
  const first = await buildMaintenanceAuditInput(run, h.sources, { version: 1, revision: 0, through: null, window: fixture.window }, ports);
  expect(first.occurrences.map(o => o.part)).toEqual([0]);
  expect(first.unread[source.key]).toEqual({ seq: 1, part: 1, requestIndex: 0 });
  const o = first.occurrences[0];
  const row = { key: auditRequestKey(o.key, 0), occurrence: o.key, requestIndex: 0, at: o.at, request: "a", outcome: "done", taskId: null, code: "observed", merge: "", install: "", acceptance: "", checkedAt: first.snapshotAt, next: "", dueAt: null, dueTz: null, mutation: null };
  const manifest = { version: 1, runId: run.runId, revision: first.revision, lower: first.window.lower, upper: first.window.upper, rows: 1, occurrences: [{ key: o.key, requests: 1, nextIndex: 1 }] };
  const checkpoint = parseMaintenanceReport(`audit-row: ${JSON.stringify(row)}\naudit-manifest: ${JSON.stringify(manifest)}\nVerdict: pass`, first).audit!;
  expect(checkpoint.error).toBeNull(); expect(checkpoint.window.sources[0].from).toEqual({ seq: 1, part: 1, requestIndex: 0 });
  const next = await buildMaintenanceAuditInput(run, h.sources, { version: 1, revision: 1, through: null, window: checkpoint.window }, ports);
  expect(next.occurrences.map(o => [o.part, o.requestIndex])).toEqual([[1, 0]]);
});


test("native delivery provenance verifies solo operator occurrences and keeps repeated sends separate", async () => {
  const h = harness(); const run = claim();
  const { buildMaintenanceAuditInput } = await import("./audit");
  const { messageTextDigest } = await import("@/lib/runtime/messageTextDigest");
  const registryModule = await import("@/lib/agent/registry");
  const directory = path.join(process.env.LLV_CODEX_HOME!, "sessions"); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "audit-native.jsonl"); const text = "same request";
  const offsets = [1000, 500, 250, 100];
  fs.writeFileSync(file, offsets.map(offset => JSON.stringify({ type: "response_item", timestamp: new Date(NOW - offset).toISOString(), payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })).join("\n") + "\n");
  const snapshot = structuredClone(h.registry.readOnlySnapshot()); const id = run.seat.conversationId;
  snapshot.conversations[id] = { id, engine: "codex", projectOwnership: { project: PROJECT }, generations: [{ id: "fixture-native-generation", path: file, launchProfile: {}, createdAt: new Date(NOW - 5000).toISOString() }], continuityPaths: [], abandonedContinuityPaths: [], migration: null } as never;
  for (const [index, offset] of offsets.slice(0, 3).entries()) snapshot.heldDeliveries[`fixture-delivery-${index}`] = { conversationId: id, state: "delivered", deliveredAt: new Date(NOW - offset).toISOString(), contentDigest: messageTextDigest(text), clientMessageId: `fixture-send-${index}`, command: { origin: { kind: index === 2 ? "agent" : "operator", ...(index === 2 ? { role: "builder" } : {}) } } } as never;
  const registry = { readOnlySnapshot: () => snapshot, conversation: (value: string) => snapshot.conversations[value], conversationForPath: (value: string) => value === file ? snapshot.conversations[id] : null };
  h.sources.registry = () => registry as never;
  const spy = spyOn(registryModule, "agentRegistry").mockReturnValue(registry as never);
  try {
    const audit = await buildMaintenanceAuditInput(run, h.sources);
    expect(audit.window.sources[0].gap).toBeNull();
    expect(audit.occurrences.filter(o => o.verified).map(o => o.at).sort()).toEqual([new Date(NOW - 1000).toISOString(), new Date(NOW - 500).toISOString()]);
    expect(audit.occurrences.filter(o => !o.verified)).toHaveLength(1);
    expect(new Set(audit.occurrences.map(o => o.key)).size).toBe(3);
  } finally { spy.mockRestore(); }
});


test("request audit freezes its window with the original launch body across a controller restart", async () => {
  const h = harness(); h.sources.seatFor = () => ({ active: input().seat!, pending: null, history: [] }) as never;
  const bodies: Record<string, unknown>[] = [];
  const ports = { evidence: async () => [], archive: () => {}, launch: async (body: Record<string, unknown>) => { bodies.push(body); return { status: 202, body: { state: "starting" } }; }, observe: async () => ({ state: "running" as const }) };
  await productionBoardMaintenanceController(h.sources, ports).launchIfDue(input());
  const first = h.run();
  expect(first.audit?.window.upper).toBe(first.claimedAt);
  expect(first.audit?.window.lower).toBe("1970-01-01T00:00:00.000Z");
  h.now(NOW + 60000);
  await productionBoardMaintenanceController(h.sources, { ...ports, evidence: async () => { throw Error("stored launch must not rebuild its input"); } }).reconcile(PROJECT);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  expect(readMaintenanceRun(first.runId)?.audit).toEqual(first.audit);
});
