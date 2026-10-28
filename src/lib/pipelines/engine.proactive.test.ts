import { afterAll, afterEach, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { expect, test, harness, createPipelineFromRequest, loadPipelines, savePipelines, tickPipelines, finishReported, engineModule, patchPipeline, closeAndDrain, defaultPipelinePorts, accountManager, realProvisioningRepo } from "./engine.fixture";
import { admitProactiveTask, decideProactiveTask, proactiveDecisionToken, readProactiveAllowance } from "@/lib/tasks/proactive";
import { candidate, NOW } from "@/lib/tasks/proactive.fixture";
import { applySeatTickSettingsChange, defaultSeatTickSettings, readSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { agentRegistry } from "@/lib/agent/registry";
import { sessionKeyFromTranscript } from "@/lib/agent/sessionKey";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { proactiveObservation } from "@/lib/accounts/proactiveReserve.fixture";
import { assertProactivePipelineExecution, assertProactiveTaskExecution, proactiveConversationTaskIds, proactiveConversationContext } from "@/lib/tasks/proactiveExecution";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { emptyLaunchProfile, launchProfileCodexSandbox } from "@/lib/accounts/migration/contracts";
import { TASKS_FILE, loadTasksByIds, mutateTasks } from "@/lib/tasks/store";
import { createTask, patchTask } from "@/lib/tasks/commands";
import { setProjectWorkerLimit } from "@/lib/operator/workerLimit";
import { bindAccountToProject } from "@/lib/accounts/projectBindings";
import { proactiveGraphDigest, reserveProactiveLane } from "@/lib/tasks/proactiveLane";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { setCodexCloudEnvironmentId } from "@/lib/projects/settings";
import { settlePipelineControllerJobs } from "./controllerJobs";
import { requestDigest } from "@/lib/mcp/server";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { mergeAdmission, mergeEligible } from "@/lib/forge/autoMerge";
import { mergeOnReviewSetting } from "@/lib/projects/settings";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { legacyDatabasePath } from "@/lib/state/legacyImport";

const clock = spyOn(Date, "now").mockImplementation(() => NOW);
afterEach(() => { clock.mockImplementation(() => NOW); });
afterAll(() => clock.mockRestore());
const stages = [
  { id: "scope", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review the frozen scope", next: "build", onFail: { to: "build", maxRounds: 1 } },
  { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build the reviewed outcome", next: "review" },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review the implemented outcome", next: null, onFail: { to: "build", maxRounds: 1 } },
] as const;
async function fixture(name: string, cloud = false, repoDir = "/repo", project = `proactive-${name}`, graph: readonly { id: string; [key: string]: unknown }[] = stages) {
  savePipelines([]);
  const h = harness();
  h.advanceWallClock(NOW - 1_000_000);
  h.ports.projectForCwd = () => project;
  h.setConversationActive(false); h.setPaneAlive(false);
  const at = new Date(NOW).toISOString();
  const intent = beginOrchestratorSeatIntent({ project, mandate: "Maintain this project", clientRequestId: `seat-${name}`, mode: "existing", now: at });
  if (!("seat" in intent)) throw new Error("seat intent absent");
  const seat = completeOrchestratorSeatIntent({ project, clientRequestId: `seat-${name}`, conversationId: `conversation_seat_${name}`, path: null, now: at });
  if (!("seat" in seat)) throw new Error("seat absent");
  const changed = applySeatTickSettingsChange(defaultSeatTickSettings(project), { enabled: true, autonomy: { enabled: true, hours: null, proactive: { enabled: true } } },
    { at, actor: { kind: "gateway", project: null, conversationId: null, seatEpoch: null } });
  if (!changed.ok) throw new Error(changed.error);
  writeSeatTickSettings(project, changed.settings);
  const { task } = await admitProactiveTask({ ...candidate(`candidate-${name}`), project },
    { project, startedAt: at, conversationId: seat.seat.conversationId!, seatEpoch: seat.seat.seatEpoch });
  agentRegistry().recordQuotaObservation(proactiveObservation());
  const request = { task: task.text, spec: "Retain the useful filter", repoDir, taskIds: [task.id], publication: cloud ? "remote-branch" as const : "internal" as const,
    stages: structuredClone(graph).map(stage => cloud && stage.id === "build" ? { ...stage, runtime: "codex-cloud", engine: "codex", model: "gpt-6.1-sol" } : stage) as never };
  const made = await createPipelineFromRequest(request, h.ports);
  if (!made.pipeline) throw new Error(made.error);
  const id = made.pipeline.id;
  const current = () => loadPipelines().find(row => row.id === id)!;
  const tick = async (n = 3) => { for (let i = 0; i < n; i++) await tickPipelines([], h.ports); };
  const pass = async (verdict: "pass" | "fail" | "needs_decision" = "pass") => {
    const report = await engineModule.reportStageCompletion({ verdict, ...(verdict !== "pass" ? { findings: [{ severity: "P1", text: "Scope authority is required" }] } : {}) },
      { kind: "agent", role: "reviewer", conversationId: "conversation_stage_1" }, h.ports);
    expect(report.error).toBeUndefined();
    const entry = finishReported(h, "/codex/stage-1.jsonl", "pass", "Frozen scope checked");
    await tickPipelines([entry], h.ports);
    await tick();
  };
  const complete = async () => {
    await tick(); await pass();
    for (const [n, role] of [[2, "builder"], [3, "reviewer"]] as const) {
      expect((await engineModule.reportStageCompletion({ verdict: "pass" },
        { kind: "agent", role, conversationId: `conversation_stage_${n}` }, h.ports)).error).toBeUndefined();
      await tickPipelines([finishReported(h, `/codex/stage-${n}.jsonl`, "pass", "Checked")], h.ports);
      await tick();
    }
  };
  return { h, task, project, at, request, id, current, tick, pass, complete, seatConversationId: seat.seat.conversationId! };
}

test("an eligible unadopted outcome runs independent scope review, then dispatches implementation", async () => {
  const f = await fixture("positive");
  await f.tick();
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.h.spawnInputs[0]!.role.roleId).toBe("reviewer");
  const evidence = JSON.parse(f.h.spawnInputs[0]!.prompt.split("\n").at(-1)!);
  expect(evidence.task).toMatchObject({ text: f.task.text, details: f.task.details, scopeRevision: 0 });
  expect(evidence.graph.map((stage: { id: string }) => stage.id)).toEqual(["scope", "build", "review"]);
  await f.pass();
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.role.roleId).toBe("builder");
  expect(() => assertProactivePipelineExecution(f.current(), "effect")).not.toThrow();
});

test("the orchestrator's own retained task consumes no worker slot", async () => {
  const f = await fixture("seat-capacity");
  setProjectWorkerLimit(f.project, 1, { kind: "operator", via: "fixture" }, null);
  mutateTasks(tasks => {
    const created = createTask(tasks, { project: f.project, text: "Project coordination", placement: "unplaced" }, [],
      { id: () => "coordination-task", now: () => f.at });
    if (!created.ok) throw new Error(created.error);
    const result = patchTask(created.tasks, created.task.id, { status: "assigned" }, f.at);
    if (!result.ok) throw new Error(result.error);
    result.task.assignments = [{ conversationId: f.seatConversationId, state: "linked", path: null, panePid: null, at: f.at, error: null }];
    return { tasks: result.tasks, result: undefined };
  });
  await f.tick();
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("a completed proactive outcome retains authority for its reviewed publication", async () => {
  const f = await fixture("completed-effect");
  await f.complete();
  expect(f.current()).toMatchObject({ state: "completed", closedAt: expect.any(String) });
  expect(() => assertProactivePipelineExecution(f.current(), "effect")).not.toThrow();
});

test("the first prompt uses its receipt account before a native generation exists", async () => {
  const f = await fixture("first-prompt");
  await f.tick();
  const registry = agentRegistry();
  const lane = f.current();
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: lane.worktreeDir, taskIds: [f.task.id], accountId: "account-limited",
    conversationId: "conversation_first_prompt", role: "reviewer", origin: { kind: "container", container: "pipeline", containerId: f.id, creatorConversationId: null },
    memberships: [{ kind: "pipeline", containerId: f.id, role: "reviewer", slot: "scope:1", stageId: "scope", stageOrder: 0, round: 1, parentConversationId: null }],
    launchProfile: emptyLaunchProfile({ cwd: lane.worktreeDir, readOnly: true, model: "gpt-5.6-sol" }) });
  if (begun.kind !== "created") throw new Error("expected a fresh receipt");
  const attempt = lane.runs[0]!.attempts.at(-1)!;
  attempt.conversationId = begun.receipt.conversationId; attempt.launchId = begun.receipt.launchId; attempt.state = "spawning";
  savePipelines([lane]);
  const context = () => proactiveConversationContext(begun.receipt.conversationId, registry, { id: null, engine: "codex" });
  expect(context()?.account?.id).toBe("account-limited");
  expect(() => assertProactiveTaskExecution(proactiveConversationTaskIds([begun.receipt.conversationId], registry), undefined, context)).not.toThrow();
  expect(registry.spawnReceipt(begun.receipt.launchId)!.proactiveTaskIds).toEqual([f.task.id]);
});

test("the production scope launch writes a profile the engine reads as read-only", async () => {
  const { root, repo, git } = await realProvisioningRepo("scope-launch-profile");
  let restore = () => {};
  let launchId: string | null = null;
  try {
    await git(repo, "commit", "--allow-empty", "-m", "base");
    const project = projectInfoFromCwd(repo)?.project;
    if (!project) throw new Error("fixture repository has no project identity");
    const f = await fixture("physical-read-only", false, repo, project);
    await f.tick();
    const worktree = f.current().worktreeDir;
    await git(repo, "worktree", "add", "--detach", worktree, "HEAD");
    const selected = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({ kind: "available", account: {
      engine: "codex", accountId: "account-limited", kind: "managed", home: root, transcriptRoot: root, env: { NODE_ENV: "test" },
    } }));
    restore = () => selected.mockRestore();
    await expect(defaultPipelinePorts().spawnAgent(f.h.spawnInputs[0]!, receipt => { launchId = receipt.launchId; throw new Error("profile captured before actuation"); }))
      .rejects.toThrow("profile captured before actuation");
    const receipt = agentRegistry().spawnReceipt(launchId!);
    expect(receipt?.launchProfile).toMatchObject({ readOnly: true, sandbox: null });
    expect(launchProfileCodexSandbox(receipt!.launchProfile)).toBe("read-only");
  } finally {
    restore();
    if (launchId) agentRegistry().failStructuredSpawn(launchId, "fixture ended before actuation", { announce: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each(["eligible-first", "eligible-last", "all-reserved", "stale", "missing", "revoked-in-catalog"])("Cloud candidate reserve filtering: %s", async kind => {
  const f = await fixture(`cloud-pool-${kind}`, true);
  expect(setCodexCloudEnvironmentId(f.project, "proactive-cloud")).toBe(true);
  const reserve = proactiveObservation("account-reserved");
  reserve.limits!.weekly!.usedPercent = 80;
  if (kind === "stale") reserve.observedAt = new Date(NOW - 300_001).toISOString();
  if (kind === "missing") reserve.limits!.weekly = null;
  agentRegistry().recordQuotaObservation(reserve);
  const eligible = proactiveObservation();
  agentRegistry().recordQuotaObservation(eligible);
  const order = kind === "eligible-first" ? ["account-limited", "account-reserved"] : ["account-reserved", "account-limited"];
  const submitted: string[] = [];
  f.h.ports.resolveProjectSpawn = (_engine, request) => {
    const id = request.requestedId ?? order.find(id => !request.unavailableIds?.includes(id));
    return id ? { kind: "available", account: { engine: "codex", accountId: id, kind: "managed",
      home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { NODE_ENV: "test" } } } : { kind: "unavailable" } as never;
  };
  f.h.ports.cloudClient = {
    supportsModel: () => true,
    hasEnvironment: async input => {
      input.assertCurrent();
      if (kind === "revoked-in-catalog") {
        const settings = readSeatTickSettings(f.project); settings.autonomy!.proactive!.enabled = false;
        writeSeatTickSettings(f.project, settings);
      }
      return true;
    },
    submit: async input => { input.assertCurrent(); submitted.push(input.account.accountId!);
      return { taskId: "pool-model", taskUrl: "https://example.com/cloud/pool-model" }; },
    poll: async () => ({ state: "pending", model: "gpt-6.1-sol" }),
    readFinalMessage: async () => { throw new Error("unexpected final read"); }, readDiff: async () => "",
  };
  await f.tick();
  if (kind === "all-reserved") { eligible.limits!.weekly!.usedPercent = 80; agentRegistry().recordQuotaObservation(eligible); }
  await f.pass();
  for (let n = 0; n < 4; n++) { await f.tick(1); await settlePipelineControllerJobs(); }
  expect(submitted).toEqual(["all-reserved", "revoked-in-catalog"].includes(kind) ? [] : ["account-limited"]);
});

test("an unadopted Cloud continuation reconciles the running model receipt after permission ends", async () => {
  const f = await fixture("cloud-continuation", true);
  expect(setCodexCloudEnvironmentId(f.project, "proactive-cloud")).toBe(true);
  let submits = 0, polls = 0, completed = false;
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "codex", accountId: "account-limited", kind: "managed",
    home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { NODE_ENV: "test" } } });
  f.h.ports.cloudClient = {
    supportsModel: () => true, hasEnvironment: async () => true,
    submit: async input => { input.assertCurrent(); submits++; return { taskId: "proactive-cloud-model", taskUrl: "https://example.com/cloud/proactive-cloud-model" }; },
    poll: async () => { polls++; return { state: completed ? "completed" : "pending", model: "gpt-6.1-sol" }; },
    readFinalMessage: async () => ({ message: '```json\n{"status":"pass","findings":[]}\n```', model: "gpt-6.1-sol" }),
    readDiff: async () => "",
  };
  await f.tick(); await f.pass();
  for (let n = 0; n < 4 && !submits; n++) { await f.tick(1); await settlePipelineControllerJobs(); }
  expect(submits).toBe(1);
  const setting = readSeatTickSettings(f.project); setting.autonomy!.proactive!.enabled = false; writeSeatTickSettings(f.project, setting);
  f.h.advanceWallClock(60_000);
  await f.tick(1); await settlePipelineControllerJobs();
  expect(polls).toBe(1);
  completed = true; f.h.advanceWallClock(60_000);
  await f.tick(1); await settlePipelineControllerJobs(); await f.tick(2);
  expect(submits).toBe(1);
  expect(f.current().runs[1]!.attempts.at(-1)!.cloud?.taskId).toBe("proactive-cloud-model");
  expect(f.current().state).toBe("needs_decision");
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("skipping a failed scope review cannot dispatch implementation without its pass", async () => {
  const f = await fixture("unreviewed-skip");
  await f.tick(); await f.pass("fail");
  const skipped = await patchPipeline(f.id, { action: "skip-stage" }, f.h.ports);
  expect(skipped.error).toBeUndefined();
  await f.tick();
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.current().stateDetail).toContain("requires independent scope review");
});

test("a failed scope review retries inside the original outcome reservation", async () => {
  const f = await fixture("scope-retry");
  await f.tick(); await f.pass("fail");
  const retried = await patchPipeline(f.id, { action: "retry-stage" }, f.h.ports);
  expect(retried.error).toBeUndefined();
  await f.tick();
  expect(f.h.spawnInputs.map(input => input.role.roleId)).toEqual(["reviewer", "reviewer"]);
  expect(f.current().runs[0]!.attempts).toHaveLength(2);
  expect(readProactiveAllowance(f.project, f.at, NOW)).toEqual({ episodeUsed: 1, rollingUsed: 1 });
});

test("a scope pass grants nothing until the read-only settlement succeeds", async () => {
  const f = await fixture("dirty-review");
  await f.tick();
  const execute = f.h.ports.exec;
  f.h.ports.exec = (command, args, ...rest) => command === "git" && args[0] === "status"
    ? Promise.resolve({ code: 0, stdout: "?? retained-work.txt\n", stderr: "" }) : execute(command, args, ...rest);
  await f.pass();
  expect(f.current().stateDetail).toContain("read-only stage");
  f.h.ports.exec = execute;
  const skipped = await patchPipeline(f.id, { action: "skip-stage" }, f.h.ports);
  expect(skipped.error).toBeUndefined();
  await f.tick();
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.current().stateDetail).toContain("requires independent scope review");
});

test.each(["parent", "child", "wakes", "expiry", "seat", "reject", "scope", "restore", "graph", "links", "80", "stale", "windows", "workers", "owed", "owed-assigned", "owed-resource", "pool"])("prepared review refuses dispatch after %s changes at the final reservation boundary", async kind => {
  const f = await fixture(kind);
  const spawn = f.h.ports.spawnAgent;
  f.h.ports.spawnAgent = async (input, reserved, prepare) => {
    const changed = readSeatTickSettings(f.project);
    if (kind === "parent") changed.autonomy!.enabled = false;
    if (kind === "child") changed.autonomy!.proactive!.enabled = false;
    if (kind === "wakes") changed.enabled = false;
    if (kind === "expiry") changed.autonomy!.until = new Date(NOW - 1).toISOString();
    if (["parent", "child", "wakes", "expiry"].includes(kind)) writeSeatTickSettings(f.project, changed);
    if (kind === "seat") {
      beginOrchestratorSeatIntent({ project: f.project, mandate: "Successor", clientRequestId: "new-seat", mode: "existing", now: f.at });
      completeOrchestratorSeatIntent({ project: f.project, clientRequestId: "new-seat", conversationId: "conversation_new_seat", path: null, now: f.at });
    }
    if (kind === "reject") await decideProactiveTask(f.task.id, "reject", "operator", proactiveDecisionToken(f.task));
    if (kind === "scope" || kind === "restore") {
      const edit = (text: string) => mutateTasks(tasks => {
        const result = patchTask(tasks, f.task.id, { text }, f.at);
        if (!result.ok) throw new Error(result.error);
        return { tasks: result.tasks, result: undefined };
      });
      edit("Another scope"); if (kind === "restore") edit(f.task.text);
    }
    if (kind === "graph") { const lane = f.current(); lane.stages[1]!.prompt += " changed"; savePipelines([lane]); }
    if (kind === "links") { const lane = f.current(); lane.taskIds = []; savePipelines([lane]); }
    const sample = proactiveObservation();
    if (kind === "80") sample.limits!.weekly!.usedPercent = 80;
    if (kind === "stale") sample.observedAt = new Date(NOW - 300_001).toISOString();
    if (kind === "windows") sample.limits!.weekly = null;
    if (["80", "stale", "windows"].includes(kind)) agentRegistry().recordQuotaObservation(sample);
    if (kind === "pool") expect(bindAccountToProject("codex", "another-account", f.project).ok).toBe(true);
    if (kind === "workers" || kind.startsWith("owed")) {
      mutateTasks(tasks => {
        const status = kind === "owed-resource" ? "blocked" : kind === "workers" || kind === "owed-assigned" ? "assigned" : "inbox";
        const created = createTask(tasks, { project: f.project, text: "Accepted work", placement: "unplaced" }, [], { id: () => `accepted-${kind}`, now: () => f.at });
        if (!created.ok) throw new Error(created.error);
        const result = patchTask(created.tasks, created.task.id, { status }, f.at);
        if (!result.ok) throw new Error(result.error);
        if (kind === "owed-resource") result.task.hold = { kind: "resource", note: "Waiting for capacity", since: f.at, by: "operator" };
        if (kind === "workers") result.task.assignments = [{ conversationId: "conversation_accepted_worker", state: "linked", path: null, panePid: null, at: f.at, error: null }];
        return { tasks: result.tasks, result: undefined };
      });
      if (kind === "workers") setProjectWorkerLimit(f.project, 1, { kind: "operator", via: "fixture" }, null);
    }
    // The engine's real final-boundary callback must refuse before the fake
    // provider can record a model call.
    await reserved({ launchId: "held-launch", conversationId: "conversation_held", accountId: "account-limited" });
    return await spawn(input, reserved, prepare);
  };
  await f.tick();
  expect(f.h.spawnInputs).toHaveLength(0);
  expect(f.current().state).toBe("needs_decision");
  const cause = ["parent", "child", "wakes", "expiry"].includes(kind) ? "permission"
    : ["scope", "restore", "graph", "links"].includes(kind) ? "frozen"
    : kind.startsWith("owed") ? "precedence" : ({ "80": "80%", windows: "window", workers: "worker capacity" } as Record<string, string>)[kind] ?? kind;
  expect(f.current().stateDetail).toContain(cause);
});

test("a scope decision cannot follow its fail edge, retry, skip, or a successor; operator adoption preserves retained work", async () => {
  const f = await fixture("hold");
  await f.tick(); await f.pass("needs_decision");
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.current().state).toBe("needs_decision");
  for (const action of ["retry-stage", "skip-stage", "resolve-decision"] as const) {
    const result = await patchPipeline(f.id, { action } as never, f.h.ports);
    expect(result.error).toContain("held");
  }
  const successor = structuredClone(f.current()); successor.id = "successor-hold";
  await expect(reserveProactiveLane(successor, "successor-hold")).rejects.toThrow("held");
  await decideProactiveTask(f.task.id, "adopt", "operator", proactiveDecisionToken(f.task));
  expect(() => assertProactivePipelineExecution(f.current(), "effect")).not.toThrow();
  expect(loadTasksByIds(new Set([f.task.id]))[0]!.details).toBe(f.task.details);
});

test("a queued skip rechecks rejection before touching the checkout or advancing", async () => {
  const f = await fixture("queued-skip");
  await f.tick(); await f.pass("fail");
  const queued = await engineModule.patchPipeline(f.id, { action: "skip-stage" }, f.h.ports);
  expect(queued.pipeline?.remoteAction?.state).toBe("pending");
  await decideProactiveTask(f.task.id, "reject", "operator", proactiveDecisionToken(f.task));
  const calls = f.h.calls.length;
  await engineModule.settlePendingRemoteActions(f.h.ports);
  expect(f.current().remoteAction).toMatchObject({ state: "settled", error: expect.stringContaining("rejected") });
  expect(f.current().cursor?.stageId).toBe("scope");
  expect(f.h.calls).toHaveLength(calls);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("concurrent and replayed lane creation retains one reservation through aliases", async () => {
  const f = await fixture("reservation");
  const competitor = structuredClone(f.current()); competitor.id = "competing-lane";
  const results = await Promise.allSettled([reserveProactiveLane(f.current(), f.current().creationRequest!.key), reserveProactiveLane(competitor, "competitor")]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  const alias = `renamed-${f.project}`;
  expect(persistProjectAliases([{ source: f.project, target: alias, displayName: "Project" }])).toBe(true);
  const current = f.current();
  expect(() => assertProactivePipelineExecution(current, "prepare")).not.toThrow();
  await expect(reserveProactiveLane({ ...current, id: "another-lane" }, "another-lane")).rejects.toThrow("reserved");
});

test("a fresh process sees the same reservation and cannot admit a competing lane", async () => {
  const f = await fixture("restart");
  await f.tick(); await f.pass();
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "proactive-restart-"));
  try {
    const input = path.join(root, "lane.json");
    const read = async (lane: ReturnType<typeof f.current>, action = "reserve-lane") => {
      fs.writeFileSync(input, JSON.stringify(lane));
      const child = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/tasks/proactive.fixture.ts"), TASKS_FILE, input, action],
        { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
      try {
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        if (exit !== 0) throw new Error(stderr);
        return JSON.parse(stdout.split("RESULT ")[1]!);
      } finally { if (child.exitCode === null) child.kill(); await child.exited; }
    };
    expect(await read(f.current())).toEqual({ laneId: f.id });
    expect(await read(f.current(), "lane-error")).toEqual({ error: null });
    expect(await read({ ...f.current(), id: "foreign-lane" })).toMatchObject({ error: expect.stringContaining("reserved") });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a quiescent closed outcome admits its successor in the same allowance and requires a fresh scope review", async () => {
  const f = await fixture("successor");
  await f.tick(); await f.pass();
  expect((await closeAndDrain(f.id, { action: "close" }, f.h.ports)).error).toBeUndefined();
  expect(f.current().closeReport?.status).toBe("settled");
  expect(() => assertProactivePipelineExecution(f.current(), "effect")).toThrow("closed or hidden");
  const result = await createPipelineFromRequest(f.request, f.h.ports, {
    creationRequest: { key: "proactive-successor", digest: requestDigest("create_pipeline", f.request) },
  });
  expect(result.error).toBeUndefined();
  expect(result.pipeline!.id).not.toBe(f.id);
  await f.tick();
  expect(f.h.spawnInputs).toHaveLength(3);
  expect(f.h.spawnInputs.at(-1)!.role.roleId).toBe("reviewer");
  const successor = loadPipelines().find(lane => lane.id === result.pipeline!.id)!;
  expect(() => assertProactivePipelineExecution(successor, "effect")).toThrow("requires independent scope review");
  expect(readProactiveAllowance(f.project, f.at, NOW)).toEqual({ episodeUsed: 1, rollingUsed: 1 });
});

test.each([["merging", false], ["blocked", true], ["blocked", false]] as const)("closed outcome release respects its merge receipt: %s / uncertain %s", async (state, effectUncertain) => {
  const f = await fixture(`merge-reservation-${state}-${effectUncertain}`);
  await f.complete();
  const lane = f.current();
  const setting = { ...mergeOnReviewSetting(f.project), enabled: true, changedAt: f.at };
  const admitted = mergeAdmission(lane, NOW, { setting: () => setting,
    pullRequestOf: () => ({ repository: "acme/fixture", number: 17 }), hasPublishedPrototype: () => false });
  if (!("merge" in admitted)) throw new Error(admitted.reason);
  lane.merge = admitted.merge; lane.merge.state = state; lane.merge.effectUncertain = effectUncertain;
  savePipelines([lane]);
  expect((await closeAndDrain(f.id, { action: "close" }, f.h.ports)).error).toBeUndefined();
  expect(f.current().closeReport?.status).toBe("settled");
  const result = await createPipelineFromRequest(f.request, f.h.ports, {
    creationRequest: { key: "pending-merge-successor", digest: requestDigest("create_pipeline", f.request) },
  });
  if (state === "merging" || effectUncertain) expect(result.error).toContain("reserved");
  else {
    expect(result.error).toBeUndefined();
    expect(() => assertProactivePipelineExecution(result.pipeline!, "effect")).toThrow("requires independent scope review");
  }
  expect(readProactiveAllowance(f.project, f.at, NOW)).toEqual({ episodeUsed: 1, rollingUsed: 1 });
});


test.each(["parent", "child", "expiry", "reject", "continue", "adopt"])("native pending discretionary turns retain guarded custody: %s", async kind => {
  const f = await fixture(`native-pending-${kind}`);
  await f.tick(); await f.pass();
  const { migrationDeliveryFixture } = await import("@/test-helpers/migrationDelivery");
  const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
  const { kickStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliverySignal");
  const { NativeCodexQueue } = await import("@/lib/runtime/nativeCodexQueue");
  const delivery = migrationDeliveryFixture();
  const registry = delivery.registry;
  const lane = f.current();
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: delivery.root, transport: "structured", conversationId: delivery.conversation.id,
    origin: { kind: "container", container: "pipeline", containerId: f.id, creatorConversationId: null },
    clientAttemptId: `pending-${kind}`, taskIds: [f.task.id],
    memberships: [{ kind: "pipeline", containerId: f.id, role: "builder", slot: "build:1", stageId: "build", stageOrder: 1, round: 1, parentConversationId: null }],
    launchProfile: emptyLaunchProfile({ cwd: delivery.root, model: "gpt-5.6-sol", title: "Continue the reviewed filter improvement" }) });
  if (begun.kind !== "created") throw new Error("fresh native receipt required");
  lane.runs[1]!.attempts.at(-1)!.conversationId = delivery.conversation.id;
  savePipelines([lane]);
  agentRegistry().recordQuotaObservation(proactiveObservation("account-a"));
  let active = true, adds = 0, starts = 0;
  const host = delivery.host;
  const health = host.health.bind(host);
  host.health = async () => ({ ...await health(), status: active ? "active" : "idle", activeTurnRef: active ? "current-turn" : null, activeFlags: ["native-queue"] });
  const input = [{ type: "text" as const, text: "Preserve this pending payload" }];
  const binding = { threadId: delivery.key.sessionId, accountId: "account-a" };
  Object.assign(host, { nativeQueue: {
    queue: new NativeCodexQueue({ rpc: async (method, params) => {
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      if (method === "thread/queue/add") { adds++; return { queuedSubmission: { id: "pending-native", clientUserMessageId: params.clientUserMessageId, input } }; }
      throw new Error(`unexpected native call ${method}`);
    } }, binding.threadId),
    prepare: async () => input, evidence: async () => null,
    sendWithdrawn: async () => { if (active) throw new Error("fixture turn still active"); starts++; return { turnId: "guarded-turn" }; },
  } });
  delivery.client.nativeQueueRead = async id => delivery.journal.nativeQueueRead(id);
  delivery.client.nativeQueueTransition = async (id, change) => delivery.journal.nativeQueueTransition(id, change);
  const bind = () => bindStructuredDeliveryQueue([{ key: delivery.key, host }], { registry, client: delivery.client,
    hostlessSettleIntervalMs: 0, watchdogIntervalMs: 0, settlementSweepMs: 0 });
  try {
    if (kind === "adopt") await decideProactiveTask(f.task.id, "adopt", "operator", proactiveDecisionToken(f.task));
    await bind();
    expect(delivery.journal.executeOperation({ kind: "native-queue", action: "add", binding, operationId: "pending-guarded", idempotencyKey: "pending-guarded",
      conversationId: delivery.conversation.id, text: input[0].text }).receipt.status).toBe("queued");
    await kickStructuredDeliveryQueue();
    expect(adds).toBe(kind === "adopt" ? 1 : 0);
    expect(starts).toBe(0);
    const settings = readSeatTickSettings(f.project);
    if (kind === "parent") settings.autonomy!.enabled = false;
    if (kind === "child") settings.autonomy!.proactive!.enabled = false;
    if (kind === "expiry") settings.autonomy!.until = new Date(NOW - 1).toISOString();
    writeSeatTickSettings(f.project, settings);
    if (kind === "reject") await decideProactiveTask(f.task.id, "reject", "operator", proactiveDecisionToken(f.task));
    // A replacement controller must recover the original durable operation.
    await bindStructuredDeliveryQueue([], { client: null }); active = false;
    await bind(); await kickStructuredDeliveryQueue();
    expect(adds).toBe(kind === "adopt" ? 1 : 0);
    expect(starts).toBe(kind === "continue" ? 1 : 0);
    const entry = delivery.journal.nativeQueueRead(delivery.conversation.id)[0]!;
    expect(entry.versions[0]!.text).toBe(input[0].text);
    expect(entry.state).toBe(kind === "continue" ? "dispatching" : kind === "adopt" ? "queued" : "refused");
  } finally { await delivery.cleanup(); }
});

test.each(["write-boundary", "open-ack", "closed-merged", "hidden-merged", "closed-unmerged", "closed-ack", "head-changed", "review-changed"])("unadopted merge custody survives restart: %s", async kind => {
  const f = await fixture(`merge-custody-${kind}`);
  await f.complete();
  const { sweepAutoMerge, MERGE_SETTLE_MS, MERGE_POLL_MS } = await import("@/lib/forge/autoMerge");
  const { findPipelineRecord } = await import("./store");
  let now = NOW, writes = 0, reads = 0, state = "OPEN";
  let boundary: ReturnType<typeof f.current> | undefined;
  const head = f.current().lastPassedCommit!;
  const ports: import("@/lib/forge/autoMerge").AutoMergePorts = {
    now: () => now, loadPipelines,
    mutate: async (id, change) => { const lanes = loadPipelines(); const lane = lanes.find(row => row.id === id); if (!lane || !change(lane)) return false; savePipelines(lanes); return true; },
    setting: () => ({ enabled: true, changedAt: new Date(NOW - 3_600_000).toISOString(), changedBy: "operator" }),
    pullRequestOf: () => ({ repository: "acme/widgets", number: 11 }), cachedState: () => null,
    run: async args => {
      if (args[0] === "pr" && args[1] === "view") { reads++; return JSON.stringify({ state, headRefOid: head, baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
        mergeCommit: state === "MERGED" ? { oid: "f".repeat(40) } : null }); }
      if (args[0] === "repo") return JSON.stringify({ squashMergeAllowed: true });
      if (args[1]?.includes("/reviews") || args[1]?.includes("/comments")) return "";
      if (args[1]?.includes("/branches/")) return args[1].includes("/rules/") ? "[]" : '["ci"]';
      throw new Error(`unexpected read ${args.join(" ")}`);
    },
    write: async (_args, _repo, beforeDispatch) => {
      if (kind === "head-changed" || kind === "review-changed") {
        const current = f.current();
        if (kind === "head-changed") current.lastPassedCommit = "f".repeat(40);
        else current.runs.find(run => run.stageId === "review")!.attempts.at(-1)!.reviewHeadSha = "f".repeat(40);
        savePipelines([current]);
      }
      beforeDispatch?.(); writes++; boundary = structuredClone(findPipelineRecord(f.id)!);
      if (kind === "closed-ack") state = "CLOSED";
      return "";
    },
    finishTask: () => "missing",
  };
  for (let n = 0; n < 10 && !writes; n++) { await sweepAutoMerge(ports); now += MERGE_SETTLE_MS + MERGE_POLL_MS; }
  if (kind === "head-changed" || kind === "review-changed") {
    expect(writes).toBe(0);
    expect(f.current().merge).toMatchObject({ state: "blocked", reason: expect.stringContaining("result-review evidence") });
    expect(f.current().merge?.effectUncertain).toBeUndefined();
    return;
  }
  expect(writes).toBe(1);
  expect(boundary?.merge).toMatchObject({ state: "merging", effectUncertain: true });
  if (kind === "closed-ack") {
    expect(f.current().merge).toMatchObject({ state: "blocked", nextReadAt: null });
    expect(f.current().merge?.effectUncertain).toBeUndefined();
    return;
  }
  expect(f.current().merge?.effectUncertain).toBe(true); // OPEN acknowledgement keeps custody.
  if (kind === "write-boundary") savePipelines([boundary!]);
  // Read the actual writer output in another interpreter, with cold module state.
  const child = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/tasks/proactive.fixture.ts"), TASKS_FILE, f.id, "pipeline-record"],
    { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(err);
    const decoded = JSON.parse(out.split("RESULT ")[1]!);
    expect(decoded.merge.effectUncertain).toBe(true);
    savePipelines([decoded]);
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
  if (kind.startsWith("closed")) {
    const result = await closeAndDrain(f.id, { action: "close" }, f.h.ports);
    expect(result.error).toBeUndefined(); expect(f.current().state).toBe("closed");
    const { archiveSettledPipelines } = await import("./store");
    expect(await archiveSettledPipelines(NOW + 30 * 86_400_000)).toBe(0);
    expect(f.current().merge?.effectUncertain).toBe(true);
    const held = await createPipelineFromRequest(f.request, f.h.ports, {
      creationRequest: { key: "held-before-merge-settles", digest: requestDigest("create_pipeline", f.request) },
    });
    expect(held.error).toContain("reserved");
  }
  if (kind === "hidden-merged") { const lane = f.current(); lane.hiddenAt = f.at; savePipelines([lane]); }
  const before = reads;
  now += MERGE_POLL_MS; await sweepAutoMerge(ports);
  expect(reads).toBeGreaterThan(before); expect(writes).toBe(1);
  expect(f.current().merge?.effectUncertain).toBe(true);
  const paced = reads; await sweepAutoMerge(ports); expect(reads).toBe(paced);
  state = kind === "closed-unmerged" ? "CLOSED" : "MERGED";
  now += MERGE_POLL_MS; await sweepAutoMerge(ports);
  expect(writes).toBe(1);
  expect(f.current().merge?.effectUncertain).toBeUndefined();
  expect(f.current().merge?.state).toBe(state === "MERGED" ? "merged" : "blocked");
  if (kind.startsWith("closed")) {
    const next = await createPipelineFromRequest(f.request, f.h.ports, {
      creationRequest: { key: "next-after-merge", digest: requestDigest("create_pipeline", f.request) },
    });
    expect(next.error).toBeUndefined(); expect(next.pipeline?.id).not.toBe(f.id);
  }
});


test.each(["review-before-build", "unreachable-review", "write-after-review"])("proactive success graph requires result review after implementation: %s", async kind => {
  const graph: { id: string; [key: string]: unknown }[] = structuredClone(stages).map(stage => ({ ...stage }));
  if (kind === "review-before-build") {
    graph[0]!.next = "review"; graph[2]!.next = "build"; graph[1]!.next = null;
  } else if (kind === "unreachable-review") graph[1]!.next = null;
  else {
    graph[2]!.next = "final-build";
    graph.push({ ...graph[1]!, id: "final-build", next: null });
  }
  await expect(fixture(`graph-${kind}`, false, "/repo", `graph-${kind}`, graph)).rejects.toThrow("result-review");
});

test("proactive success graph follows edges when stage array order differs", async () => {
  const f = await fixture("graph-edges", false, "/repo", "graph-edges", [stages[0], stages[2], stages[1]]);
  await f.complete();
  expect(f.current().state).toBe("completed");
  expect(mergeEligible(f.current())).toBe(true);
});

test.each(["different", "missing"])("proactive automatic merge requires evidence for its final head: %s", async kind => {
  const f = await fixture(`review-head-${kind}`);
  await f.complete();
  const lane = f.current();
  expect(mergeEligible(lane)).toBe(true);
  const review = lane.runs.find(run => run.stageId === "review")!.attempts.at(-1)!;
  review.reviewHeadSha = kind === "different" ? "f".repeat(40) : null;
  review.outputBaseHead = undefined;
  if (review.report) review.report.provenance.head = null;
  const admission = mergeAdmission(lane, NOW, { setting: () => ({ ...mergeOnReviewSetting(f.project), enabled: true, changedAt: f.at }),
    pullRequestOf: () => ({ repository: "acme/fixture", number: 17 }), hasPublishedPrototype: () => false });
  expect(admission).toEqual({ reason: "lane has not met the review merge bar" });
});

test.each(["assigned", "done"] as const)("retained live lane occupies worker capacity with card status %s", async status => {
  const f = await fixture(`card-capacity-${status}`);
  setProjectWorkerLimit(f.project, 1, { kind: "operator", via: "fixture" }, null);
  const ordinary = mutateTasks(tasks => {
    const made = createTask(tasks, { project: f.project, text: "Requested filter correction", placement: "unplaced" }, [],
      { id: () => `ordinary-${status}`, now: () => f.at });
    if (!made.ok) throw new Error(made.error);
    return { tasks: made.tasks, result: made.task };
  });
  const made = await createPipelineFromRequest({ task: ordinary.text, repoDir: "/repo", taskIds: [ordinary.id], publication: "internal",
    stages: [{ id: "work", kind: "run", role: { roleId: "builder" }, prompt: "Apply the requested correction", next: null }] }, f.h.ports);
  if (!made.pipeline) throw new Error(made.error);
  const ordinaryLane = made.pipeline;
  const begun = beginLegacySpawnFixture(agentRegistry(), { engine: "codex", cwd: ordinaryLane.worktreeDir, taskIds: [ordinary.id],
    conversationId: `conversation_ordinary_${status}`, role: "builder", origin: { kind: "container", container: "pipeline", containerId: ordinaryLane.id, creatorConversationId: null },
    memberships: [{ kind: "pipeline", containerId: ordinaryLane.id, role: "builder", slot: "work:1", stageId: "work", stageOrder: 0, round: 1, parentConversationId: null }],
    launchProfile: emptyLaunchProfile({ cwd: ordinaryLane.worktreeDir, model: "gpt-5.6-sol" }) });
  if (begun.kind !== "created") throw new Error("fresh ordinary worker required");
  mutateTasks(tasks => {
    const result = patchTask(tasks, ordinary.id, { status }, f.at);
    if (!result.ok) throw new Error(result.error);
    result.task.assignments = [{ conversationId: begun.receipt.conversationId, launchId: begun.receipt.launchId,
      state: "linked", path: null, panePid: null, at: f.at, error: null }];
    return { tasks: result.tasks, result: undefined };
  });
  const spawn = f.h.ports.spawnAgent;
  f.h.ports.spawnAgent = async (input, reserved, prepare) => {
    if (input.membership.containerId === f.id) {
      await reserved({ launchId: "held-proactive", conversationId: "conversation_held_proactive", accountId: "account-limited" });
    }
    return spawn(input, reserved, prepare);
  };
  await f.tick();
  expect(f.h.spawnInputs.filter(input => input.membership.containerId === f.id)).toHaveLength(0);
  expect(f.current().stateDetail).toContain("capacity is exhausted");
  expect(loadPipelines().find(lane => lane.id === ordinaryLane.id)?.state).toBe("running");
  expect((await closeAndDrain(ordinaryLane.id, { action: "close" }, f.h.ports)).error).toBeUndefined();
  expect(loadPipelines().find(lane => lane.id === ordinaryLane.id)?.closeReport?.status).toBe("settled");
  expect(() => assertProactivePipelineExecution(f.current(), "dispatch")).not.toThrow();
  expect((await patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
  await f.tick();
  expect(f.h.spawnInputs.filter(input => input.membership.containerId === f.id)).toHaveLength(1);
});


test.each(["skipped", "accepted", "budget-spent"])("proactive result review retains explicit merge exceptions: %s", async kind => {
  const f = await fixture(`review-exception-${kind}`);
  await f.complete();
  const lane = f.current();
  const review = lane.runs.find(run => run.stageId === "review")!.attempts.at(-1)!;
  review.state = kind === "skipped" ? "skipped" : "failed";
  if (kind === "accepted") lane.reviewAcceptances = [{ clientRequestId: "accepted-review", expectedRevision: "current",
    stageId: "review", attempt: review.n, fixStageId: "build", fixAttempt: 1, reviewedHead: review.reviewHeadSha ?? null,
    currentHead: lane.lastPassedCommit!, at: f.at, actor: { kind: "operator" } }];
  if (kind === "budget-spent") {
    review.budgetSpent = true;
    lane.runs.find(run => run.stageId === "build")!.attempts.at(-1)!.activatedBy = {
      stageId: "review", attempt: review.n, edge: "fail", budgetSpent: true,
    };
  }
  expect(mergeEligible(lane)).toBe(kind !== "budget-spent");
  if (kind === "accepted") {
    lane.reviewAcceptances![0]!.currentHead = "f".repeat(40);
    expect(mergeEligible(lane)).toBe(false);
    lane.reviewAcceptances![0]!.currentHead = lane.lastPassedCommit!;
  }
  const summary = { ...lane.stages[0]!, id: "summary", next: null, onFail: null };
  lane.stages.find(stage => stage.id === "review")!.next = summary.id;
  lane.stages.push(summary);
  expect(mergeEligible(lane)).toBe(true);
  summary.effectiveRole = { ...lane.stages.find(stage => stage.id === "build")!.effectiveRole };
  expect(mergeEligible(lane)).toBe(false);
});


test("proactive review evidence follows only the recorded publication integration", async () => {
  const f = await fixture("review-integration");
  await f.complete();
  const lane = f.current();
  const review = lane.runs.find(run => run.stageId === "review")!.attempts.at(-1)!;
  const passedSha = lane.lastPassedCommit!;
  lane.lastPassedCommit = "f".repeat(40);
  expect(mergeEligible(lane)).toBe(false);
  review.publicationIntegration = { passedSha, acceptedSha: lane.lastPassedCommit, mainSha: "e".repeat(40) };
  expect(mergeEligible(lane)).toBe(true);
  review.publicationIntegration.passedSha = "d".repeat(40);
  expect(mergeEligible(lane)).toBe(false);
});


test("a writable stage named review cannot authorize a proactive merge", async () => {
  const f = await fixture("writable-review");
  await f.complete();
  const lane = f.current();
  lane.runs.find(run => run.stageId === "review")!.attempts = [];
  const builder = lane.stages.find(stage => stage.id === "build")!;
  lane.stages.push({ ...builder, id: "fix-review", next: null, onFail: { to: "build", maxRounds: 1 } });
  const buildRun = structuredClone(lane.runs.find(run => run.stageId === "build")!);
  buildRun.stageId = "fix-review";
  lane.runs.push(buildRun);
  expect(mergeEligible(lane)).toBe(false);
});


test("review probe: invalid task link cannot strand the project reservation", async () => {
  const f = await fixture("invalid-link-probe");
  expect((await closeAndDrain(f.id, { action: "close" }, f.h.ports)).error).toBeUndefined();
  const other = mutateTasks(tasks => {
    const made = createTask(tasks, { project: "other-project", text: "Other requested outcome", placement: "unplaced" }, [],
      { id: () => "cross-project-task", now: () => f.at });
    if (!made.ok) throw new Error(made.error);
    return { tasks: made.tasks, result: made.task };
  });
  const invalid = { ...f.request, taskIds: [f.task.id, other.id] };
  const refused = await createPipelineFromRequest(invalid, f.h.ports, {
    creationRequest: { key: "invalid-link-probe", digest: requestDigest("create_pipeline", invalid) },
  });
  expect(refused.pipeline).toBeUndefined();
  expect(refused.status).toBe(400);
  expect(refused.error).toContain("task project does not match");
  const valid = await createPipelineFromRequest(f.request, f.h.ports, {
    creationRequest: { key: "valid-after-invalid-probe", digest: requestDigest("create_pipeline", f.request) },
  });
  expect(valid.error).toBeUndefined();
});


test("review probe: companion scope cannot enter an unadopted proactive lane", async () => {
  const f = await fixture("linked-edit-probe");
  expect((await closeAndDrain(f.id, { action: "close" }, f.h.ports)).error).toBeUndefined();
  const other = mutateTasks(tasks => {
    const made = createTask(tasks, { project: f.project, text: "Requested companion scope", placement: "unplaced" }, [],
      { id: () => "linked-companion-task", now: () => f.at });
    if (!made.ok) throw new Error(made.error);
    const patched = patchTask(made.tasks, made.task.id, { status: "done" }, f.at);
    if (!patched.ok) throw new Error(patched.error);
    return { tasks: patched.tasks, result: patched.task };
  });
  const request = { ...f.request, taskIds: [f.task.id, other.id] };
  const made = await createPipelineFromRequest(request, f.h.ports, {
    creationRequest: { key: "linked-edit-probe", digest: requestDigest("create_pipeline", request) },
  });
  expect(made.error).toContain("exactly one linked task");
  expect(made.pipeline).toBeUndefined();
  // Refusing a companion must not consume the candidate's next scope review.
  const corrected = await createPipelineFromRequest(f.request, f.h.ports, {
    creationRequest: { key: "without-companion", digest: requestDigest("create_pipeline", f.request) },
  });
  expect(corrected.error).toBeUndefined();
  await f.tick(); await f.pass();
  expect(f.h.spawnInputs.map(input => input.role.roleId)).toEqual(["reviewer", "builder"]);
  const lane = loadPipelines().find(row => row.id === corrected.pipeline!.id)!;
  // Existing records and edits that add a companion also lose authority at effects.
  lane.taskIds.push(other.id);
  // Recreate an older multi-task grant from the real reservation writer's output.
  // Its graph already includes the companion, so graph drift alone cannot fence it.
  type ScopeRow = { key: string; graph: string; laneId: string };
  const reservations = new SqliteStateCollection<ScopeRow>(legacyDatabasePath(TASKS_FILE), {
    collection: "proactive_execution", schemaVersion: 1, key: row => row.key,
    decode: value => value as ScopeRow, clone: structuredClone, busyMessage: "fixture scope receipt is busy",
  });
  try {
    const saved = reservations.snapshot().find(row => row.laneId === lane.id)!;
    reservations.boundedPatch(1, tx => tx.put({ ...saved, graph: proactiveGraphDigest(lane) }));
  } finally { reservations.close(); }
  savePipelines(loadPipelines().map(row => row.id === lane.id ? lane : row));
  expect(() => assertProactivePipelineExecution(lane, "effect")).toThrow("linked task scope changed");
  mutateTasks(tasks => {
    const patched = patchTask(tasks, other.id, { text: "A materially different companion scope" }, f.at);
    if (!patched.ok) throw new Error(patched.error);
    return { tasks: patched.tasks, result: undefined };
  });
  expect(() => assertProactivePipelineExecution(lane, "dispatch")).toThrow("linked task scope changed");
  await decideProactiveTask(f.task.id, "adopt", "operator", proactiveDecisionToken(loadTasksByIds(new Set([f.task.id]))[0]!));
  expect(() => assertProactivePipelineExecution(lane, "dispatch")).not.toThrow();
});

const pausedWorkerStates = ["deferred", "unconfirmed", "failed", "unresolved", "throws", "starting", "exiting", "survivor", "claimed", "pending", "dead", "unhosted"] as const;
test.each([...pausedWorkerStates])("paused lane worker capacity follows retained custody: %s", async kind => {
  const f = await fixture(`paused-worker-${kind}`);
  setProjectWorkerLimit(f.project, 1, { kind: "operator", via: "fixture" }, null);
  const ordinary = mutateTasks(tasks => {
    const made = createTask(tasks, { project: f.project, text: "Requested correction", placement: "unplaced" }, [],
      { id: () => `paused-ordinary-${kind}`, now: () => f.at });
    if (!made.ok) throw new Error(made.error);
    return { tasks: made.tasks, result: made.task };
  });
  const made = await createPipelineFromRequest({ task: ordinary.text, repoDir: "/repo", taskIds: [ordinary.id], publication: "internal",
    stages: [{ id: "work", kind: "run", role: { roleId: "builder" }, prompt: "Apply the correction", next: null }] }, f.h.ports);
  if (!made.pipeline) throw new Error(made.error);
  const ordinaryId = made.pipeline.id;
  const registry = agentRegistry();
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: made.pipeline.worktreeDir, taskIds: [ordinary.id],
    conversationId: `conversation_paused_worker_${kind}`, role: "builder",
    origin: { kind: "container", container: "pipeline", containerId: ordinaryId, creatorConversationId: null },
    memberships: [{ kind: "pipeline", containerId: ordinaryId, role: "builder", slot: "work:1", stageId: "work", stageOrder: 0, round: 1, parentConversationId: null }],
    launchProfile: emptyLaunchProfile({ cwd: made.pipeline.worktreeDir, model: "gpt-5.6-sol" }) });
  if (begun.kind !== "created") throw new Error("fresh ordinary worker required");
  const sessionId = ["20000000", "0000", "4000", "8000", (pausedWorkerStates.indexOf(kind) + 1).toString(16).padStart(12, "0")].join("-");
  const artifactPath = `/codex/${sessionId}.jsonl`;
  const entry = { key: sessionKeyFromTranscript("codex", artifactPath)!, artifactPath, cwd: made.pipeline.worktreeDir,
    accountId: null, status: "dead" as const, host: null, claimEpoch: 0, claimOwner: null, pendingAction: null };
  const settled = kind === "dead" || kind === "unhosted";
  if (kind !== "starting") registry.completeSpawn(begun.receipt.launchId, {
    ...entry, status: kind === "unhosted" ? "unhosted" : settled || ["exiting", "survivor", "claimed", "pending"].includes(kind) ? "dead" : "live",
    claimOwner: kind === "claimed" ? "pending-owner" : null, pendingAction: kind === "pending" ? "resume" : null,
    ...(kind === "exiting" ? { pendingHostExits: [{ process: captureProcessIdentity(process.pid), launchId: null }] } : {}),
    ...(kind === "survivor" ? { structuredTerminationSurvivors: [captureProcessIdentity(process.pid)] } : {}),
  });
  mutateTasks(tasks => {
    const patched = patchTask(tasks, ordinary.id, { status: "done" }, f.at);
    if (!patched.ok) throw new Error(patched.error);
    return { tasks: patched.tasks, result: undefined };
  });
  await f.tick();
  const spawns = () => f.h.spawnInputs.filter(input => input.membership.containerId === f.id);
  expect(spawns()).toHaveLength(0);
  expect(f.current().stateDetail).toContain("capacity is exhausted");
  const ordinaryLane = loadPipelines().find(lane => lane.id === ordinaryId)!;
  const attempt = ordinaryLane.runs[0]!.attempts.at(-1)!;
  expect(attempt.state).toBe("running");
  attempt.conversationId = begun.receipt.conversationId;
  attempt.launchId = begun.receipt.launchId;
  attempt.agentPath = artifactPath;
  attempt.paneId = null;
  savePipelines(loadPipelines().map(lane => lane.id === ordinaryId ? ordinaryLane : lane));
  f.h.setConversationActive(true);
  f.h.ports.stopStageAgent = async () => {
    if (kind === "throws") throw new Error("stop confirmation unavailable");
    if (kind === "failed") return { outcome: "failed", error: "stop confirmation unavailable" };
    if (kind === "unconfirmed") return { outcome: "unconfirmed", operationId: null, detail: "stop confirmation unavailable" };
    if (kind === "unresolved") return { outcome: "unresolved", error: "host still alive", survivors: [captureProcessIdentity(process.pid)] };
    return { outcome: settled ? "stopped" : "deferred" };
  };
  expect((await patchPipeline(ordinaryId, { action: "pause", reason: "Hold requested work" }, f.h.ports)).error).toBeUndefined();
  const paused = loadPipelines().find(lane => lane.id === ordinaryId)!;
  expect(paused.state).toBe("paused");
  expect(!!paused.runs[0]!.attempts.at(-1)!.suspension?.stoppedAt).toBe(settled);
  const check = () => assertProactivePipelineExecution(f.current(), "dispatch");
  expect((await patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
  await f.tick();
  expect(spawns()).toHaveLength(settled ? 1 : 0);
  if (settled) expect(check).not.toThrow();
  else expect(check).toThrow("worker capacity is exhausted");
  // A fresh process must observe the same retained capacity while the lane is paused.
  if (!settled) {
    const child = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/tasks/proactive.fixture.ts"), TASKS_FILE, f.id, "lane-dispatch"],
      { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code) throw new Error(err);
      expect(JSON.parse(out.split("RESULT ")[1]!).error).toContain("worker capacity is exhausted");
    } finally { if (child.exitCode === null) child.kill(); await child.exited; }
    if (["deferred", "unconfirmed", "failed", "throws", "starting", "claimed", "pending"].includes(kind)) {
      if (kind === "starting") registry.completeSpawn(begun.receipt.launchId, entry);
      else registry.upsert(entry);
      f.h.ports.stopStageAgent = async () => ({ outcome: "stopped" });
      expect((await patchPipeline(ordinaryId, { action: "pause", reason: "Confirm stopped host" }, f.h.ports)).error).toBeUndefined();
      expect(() => assertProactivePipelineExecution(f.current(), "dispatch")).not.toThrow();
      expect((await patchPipeline(f.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
      await f.tick();
      expect(spawns()).toHaveLength(1);
    }
  }
});

const standaloneStates = ["dead", "unhosted", "live", "claimed", "pending", "starting", "exiting", "survivor"] as const;
test.each([...standaloneStates])("review probe: standalone worker capacity follows retained custody: %s", async kind => {
  const f = await fixture(`standalone-${kind}`);
  setProjectWorkerLimit(f.project, 1, { kind: "operator", via: "fixture" }, null);
  const ordinary = mutateTasks(tasks => {
    const made = createTask(tasks, { project: f.project, text: "Completed requested work", placement: "unplaced" }, [],
      { id: () => `ordinary-${kind}`, now: () => f.at });
    if (!made.ok) throw new Error(made.error);
    return { tasks: made.tasks, result: made.task };
  });
  const registry = agentRegistry();
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: "/repo", taskIds: [ordinary.id],
    conversationId: `conversation_standalone_${kind}`, origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: "/repo", model: "gpt-5.6-sol" }) });
  if (begun.kind !== "created") throw new Error("fresh ordinary conversation required");
  const sessionId = ["10000000", "0000", "4000", "8000", (standaloneStates.indexOf(kind) + 1).toString(16).padStart(12, "0")].join("-");
  const artifactPath = `/codex/${sessionId}.jsonl`;
  if (kind !== "starting") registry.completeSpawn(begun.receipt.launchId, {
    key: sessionKeyFromTranscript("codex", artifactPath)!, artifactPath, cwd: "/repo", accountId: null,
    status: kind === "unhosted" ? "unhosted" : kind === "live" ? "live" : "dead", host: null, claimEpoch: 0,
    claimOwner: kind === "claimed" ? "pending-owner" : null, pendingAction: kind === "pending" ? "resume" : null,
    ...(kind === "exiting" ? { pendingHostExits: [{ process: captureProcessIdentity(process.pid), launchId: null }] } : {}),
    ...(kind === "survivor" ? { structuredTerminationSurvivors: [captureProcessIdentity(process.pid)] } : {}),
  });
  mutateTasks(tasks => {
    const patched = patchTask(tasks, ordinary.id, { status: "done" }, f.at);
    if (!patched.ok) throw new Error(patched.error);
    return { tasks: patched.tasks, result: undefined };
  });
  expect(loadTasksByIds(new Set([ordinary.id]))[0]!.assignments.some(row => row.state === "linked")).toBe(true);
  expect(registry.conversationMemberships(begun.receipt.conversationId).filter(member => member.kind === "pipeline")).toEqual([]);
  const error = () => { try { assertProactivePipelineExecution(f.current(), "dispatch"); return null; } catch (error) { return String(error); } };
  const settled = kind === "dead" || kind === "unhosted";
  if (settled) expect(error()).toBeNull();
  else expect(error()).toContain("worker capacity is exhausted");
  // Capacity is recomputed from the durable registry after a real process restart.
  const child = Bun.spawn([process.execPath, path.join(process.cwd(), "src/lib/tasks/proactive.fixture.ts"), TASKS_FILE, f.id, "lane-dispatch"],
    { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(err);
    const result = JSON.parse(out.split("RESULT ")[1]!);
    if (settled) expect(result).toEqual({ error: null });
    else expect(result.error).toContain("worker capacity is exhausted");
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
});
