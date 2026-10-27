import { afterAll, afterEach, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { expect, test, harness, createPipelineFromRequest, loadPipelines, savePipelines, tickPipelines, finishReported, engineModule, patchPipeline, closeAndDrain, defaultPipelinePorts, accountManager, realProvisioningRepo } from "./engine.fixture";
import { admitProactiveTask, decideProactiveTask, proactiveDecisionToken, readProactiveAllowance } from "@/lib/tasks/proactive";
import { candidate, NOW } from "@/lib/tasks/proactive.fixture";
import { applySeatTickSettingsChange, defaultSeatTickSettings, readSeatTickSettings, writeSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { agentRegistry } from "@/lib/agent/registry";
import { proactiveObservation } from "@/lib/accounts/proactiveReserve.fixture";
import { assertProactivePipelineExecution, assertProactiveTaskExecution, proactiveConversationTaskIds, proactiveConversationContext } from "@/lib/tasks/proactiveExecution";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { emptyLaunchProfile, launchProfileCodexSandbox } from "@/lib/accounts/migration/contracts";
import { TASKS_FILE, loadTasksByIds, mutateTasks } from "@/lib/tasks/store";
import { createTask, patchTask } from "@/lib/tasks/commands";
import { setProjectWorkerLimit } from "@/lib/operator/workerLimit";
import { bindAccountToProject } from "@/lib/accounts/projectBindings";
import { reserveProactiveLane } from "@/lib/tasks/proactiveLane";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { setCodexCloudEnvironmentId } from "@/lib/projects/settings";
import { settlePipelineControllerJobs } from "./controllerJobs";
import { requestDigest } from "@/lib/mcp/server";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { mergeAdmission } from "@/lib/forge/autoMerge";
import { mergeOnReviewSetting } from "@/lib/projects/settings";

const clock = spyOn(Date, "now").mockImplementation(() => NOW);
afterEach(() => { clock.mockImplementation(() => NOW); });
afterAll(() => clock.mockRestore());
const stages = [
  { id: "scope", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review the frozen scope", next: "build", onFail: { to: "build", maxRounds: 1 } },
  { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build the reviewed outcome", next: "review" },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, access: "read-only", prompt: "Review the implemented outcome", next: null, onFail: { to: "build", maxRounds: 1 } },
] as const;
async function fixture(name: string, cloud = false, repoDir = "/repo", project = `proactive-${name}`) {
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
    stages: structuredClone(stages).map(stage => cloud && stage.id === "build" ? { ...stage, runtime: "codex-cloud", engine: "codex", model: "gpt-6.1-sol" } : stage) as never };
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

test("closing a lane cannot release its outcome while a merge receipt is in flight", async () => {
  const f = await fixture("merge-reservation");
  await f.complete();
  const lane = f.current();
  const setting = { ...mergeOnReviewSetting(f.project), enabled: true, changedAt: f.at };
  const admitted = mergeAdmission(lane, NOW, { setting: () => setting,
    pullRequestOf: () => ({ repository: "acme/fixture", number: 17 }), hasPublishedPrototype: () => false });
  if (!("merge" in admitted)) throw new Error(admitted.reason);
  lane.merge = admitted.merge; lane.merge.state = "merging";
  savePipelines([lane]);
  expect((await closeAndDrain(f.id, { action: "close" }, f.h.ports)).error).toBeUndefined();
  expect(f.current().closeReport?.status).toBe("settled");
  const result = await createPipelineFromRequest(f.request, f.h.ports, {
    creationRequest: { key: "pending-merge-successor", digest: requestDigest("create_pipeline", f.request) },
  });
  expect(result.error).toContain("reserved");
  expect(readProactiveAllowance(f.project, f.at, NOW)).toEqual({ episodeUsed: 1, rollingUsed: 1 });
});
