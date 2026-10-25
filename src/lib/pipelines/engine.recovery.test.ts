// Pre-S5 embedded-flow execution cases stay as history until S8 deletion.
// Supported run-reviewer cases and flows/retirement.test.ts remain active.
import { expect, spyOn, test, path, AccountMutationBusyError, accountManager, engineModule, adoptAttempt, defaultPipelinePorts, terminalFlowStageVerdict, tickPipelines, verdictRoutesAsFail, AgentRegistry, setAgentRegistryForTests, createPipelineFromRequest, loadPipelines, savePipelines, projectPipelineEvents, saveTasks, patchPipeline, RUN_STAGES, ORIGIN_MAIN_SHA, entry, harness, REMOTE_BRANCH, create, forbiddenSleep, frozenWallClock, PASS_TEXT, makeStructuredAttempt, pinStageHead, publishHarness, PUBLISH_STAGES, deliveryRefusalPark, SKIP_STAGES, FAIL_EDGE_STAGES, HOST_UNAVAILABLE, failedReceipt, UNVERIFIED_DELIVERY, reviewFlowPausedOnUnscannedImplementer, REVIEWER_BUSY, reviewFlowEndedOnBusyAccount, interruptedSpawnAttempt, legacySpawnAttempt, stageDigest, buildStageOf, REVIEW_FINDING_BLOCK, flowWithFindings, parkedReviewStage, stagedRecoveryHarness, aliveStagedLaunch } from "./engine.fixture";
import type { PipelinePorts } from "./engine.fixture";
import { shortId } from "@/lib/shortIds";
import fs from "node:fs";
import os from "node:os";

test("a pass whose commit failed retries settlement without rerunning stage work before publishing", async () => {
  const h = harness();
  const box = publishHarness(h);
  const pipeline = await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const exec = h.ports.exec;
  h.ports.exec = async (command, args, cwd) => args[0] === "commit"
    ? { code: 1, stdout: "", stderr: "commit temporarily unavailable" }
    : (await exec(command, args, cwd));
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({ state: "needs_decision", lastPassedCommit: ORIGIN_MAIN_SHA,
    cursor: { stageId: "build", state: "committing" } });
  expect(parked.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
  expect(parked.stateDetail).toContain("retry-stage");
  h.ports.exec = exec;
  expect((await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
  expect(loadPipelines()[0]).toMatchObject({ publishedCommit: box.passedSha,
    cursor: { stageId: "review", state: "pending" } });
  expect(box.order).toEqual(["commit", `push:${box.passedSha}`]);
});


test.each([false, true])("another lane's takeover keeps the old publication park fenced (legacy HEAD park: %s)", async (legacyHeadPark) => {
  const { h, box, id } = await deliveryRefusalPark();
  if (legacyHeadPark) {
    const parked = loadPipelines()[0]!;
    parked.stateDetail = `the worktree moved to ${"8".repeat(40)} after accepting ${box.passedSha}; commit and publish the current head before completing this stage`;
    parked.runs[0]!.attempts[0]!.state = "needs_decision";
    parked.runs[0]!.attempts[0]!.error = parked.stateDetail;
    savePipelines([parked]);
  }
  expect((await patchPipeline(id, { action: "takeover", expectedOwner: id, expectedEpoch: 1,
    reason: "recover the owner" }, h.ports)).error).toBeUndefined();
  const target = loadPipelines()[0]!.delivery!.target;
  const next = await createPipelineFromRequest({ task: "Successor", repoDir: "/repo", autoStart: false,
    stages: RUN_STAGES as never, ...REMOTE_BRANCH, delivery: { branch: target.branch } }, h.ports);
  expect(next.pipeline!.delivery).toMatchObject({ disposition: "comparison", ownerId: id, epoch: 2 });
  expect((await patchPipeline(next.pipeline!.id, { action: "takeover", expectedOwner: id, expectedEpoch: 2,
    reason: "select the successor" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  const old = loadPipelines().find((item) => item.id === id)!;
  expect(old).toMatchObject({ state: "needs_decision", delivery: { active: false, publish: "disabled" },
    cursor: { stageId: "build", state: "committing" } });
  expect((await patchPipeline(id, { action: "publish" }, h.ports)).error).toContain(next.pipeline!.id);
  expect(box.order).toEqual(["commit"]);
  expect(h.spawnInputs).toHaveLength(1);
});


test.each([
  ["budget spent: 2 findings left", "passed"],
  ["the worktree needs a decision", "passed"],
  ["budget spent: 2 findings left", "needs_decision"],
  ["the worktree needs a decision", "needs_decision"],
] as const)("takeover and publish preserve an unrelated park: %s (%s)", async (detail, attemptState) => {
  const { h, id } = await deliveryRefusalPark();
  const parked = loadPipelines()[0]!;
  parked.stateDetail = detail;
  parked.runs[0]!.attempts[0]!.state = attemptState;
  parked.runs[0]!.attempts[0]!.error = detail;
  savePipelines([parked]);
  expect((await patchPipeline(id, { action: "takeover", expectedOwner: id, expectedEpoch: 1,
    reason: "recover the delivery only" }, h.ports)).error).toBeUndefined();
  expect((await patchPipeline(id, { action: "publish" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: detail,
    delivery: { active: true, epoch: 2 }, cursor: { stageId: "build", state: "committing" } });
  expect(h.spawnInputs).toHaveLength(1);
});


test("an older remote-branch lane without origin parks with its producer head before review ingress", async () => {
  const h = harness();
  const box = publishHarness(h, { origin: false });
  const legacy = await create(h.ports, PUBLISH_STAGES as never);
  legacy.publication = "remote-branch";
  savePipelines([legacy]);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  /* The builder's commit remains accepted while the successor waits. */
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", lastPassedCommit: box.passedSha, publishedCommit: null,
    cursor: { stageId: "build", state: "committing" } });

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const waiting = loadPipelines()[0]!;
  expect(waiting.state).toBe("needs_decision");
  expect(waiting.cursor).toMatchObject({ stageId: "build", state: "committing" });
  expect(waiting.stateDetail).toContain("set-delivery-remote");
  /* The flow is not created before the accepted head can be published. */
  expect(box.order).toEqual(["commit"]);
  expect(h.flows.size).toBe(0);
  expect(waiting.lastPassedCommit).toBe(box.passedSha);
});


test.skip("retrying a parked review stage republishes a local repair before the reviewer relaunches", async () => {
  const h = harness();
  const box = publishHarness(h);
  const pipeline = await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  h.flows.get("flow-1")!.state = "done_comment";
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");

  /* The operator commits a repair in the shared worktree. Without republication
     the retried reviewer fences on a remote that never learned about it. */
  const repairHead = "9".repeat(40);
  box.setLocalHead(repairHead);
  await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);

  expect(box.remote()).toBe(repairHead);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", lastPassedCommit: repairHead, publishedCommit: repairHead });
  expect(box.order).toEqual(["commit", `push:${box.passedSha}`, "createFlow", `push:${repairHead}`]);
});


test.skip("a skipped stage publishes the accepted head before its review flow is created", async () => {
  const h = harness();
  const box = publishHarness(h);
  const pipeline = await create(h.ports, SKIP_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "needs_decision", "operator call")], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");

  /* Nothing on the skip route publishes: the branch is unpublished when the
     cursor reaches review. */
  box.setRemote(null);
  await patchPipeline(pipeline.id, { action: "skip-stage" }, h.ports);
  const beforeIngress = box.order.length;
  await tickPipelines([entry("/codex/stage-1.jsonl"), entry("/codex/stage-2.jsonl")], h.ports);

  const accepted = loadPipelines()[0]!.lastPassedCommit;
  expect(box.remote()).toBe(accepted);
  expect(box.order.slice(beforeIngress)).toEqual([`push:${accepted}`, "createFlow"]);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", publishedCommit: accepted });
});


test.skip("a fail edge into a review stage publishes the accepted head before its review flow is created", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, FAIL_EDGE_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  /* A failed stage commits nothing; the worktree is clean at the accepted head. */
  box.setDirty(false);
  box.setRemote(null);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail", "needs a reviewer")], h.ports);

  const beforeIngress = box.order.length;
  await tickPipelines([entry("/codex/stage-1.jsonl"), entry("/codex/stage-2.jsonl")], h.ports);

  const accepted = loadPipelines()[0]!.lastPassedCommit;
  expect(box.remote()).toBe(accepted);
  expect(box.order.slice(beforeIngress)).toEqual([`push:${accepted}`, "createFlow"]);
  expect(loadPipelines()[0]!.state).toBe("running");
});


test.skip("review ingress re-probes the remote instead of trusting a stale publishedCommit", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  expect(loadPipelines()[0]!.publishedCommit).toBe(box.passedSha);

  /* The durable record says published, but origin does not have it — a migrated
     record, or a branch deleted on the remote. Ingress must not believe it. */
  box.setRemote(null);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  expect(box.remote()).toBe(box.passedSha);
  expect(box.order).toEqual(["commit", `push:${box.passedSha}`, `push:${box.passedSha}`, "createFlow"]);
  expect(loadPipelines()[0]!.state).toBe("running");
});


test.skip("a worktree head that is not the accepted review head parks without publishing anything", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, FAIL_EDGE_STAGES as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const accepted = loadPipelines()[0]!.lastPassedCommit;

  /* The failed stage committed on its own. That revision was never accepted by
     the pipeline, so it must never reach origin. */
  const unaccepted = "c".repeat(40);
  box.setDirty(false);
  box.setRemote(null);
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail", "self-committed")], h.ports);
  box.setLocalHead(unaccepted);
  const beforeIngress = box.order.length;

  await tickPipelines([entry("/codex/stage-1.jsonl"), entry("/codex/stage-2.jsonl")], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toBe(
    `review stage head mismatch: the accepted review head is ${shortId(accepted)}, but the pipeline worktree is at ${shortId(unaccepted)}; nothing was published`,
  );
  expect(box.remote()).toBeNull();
  expect(box.order.slice(beforeIngress)).toEqual([]);
  expect(h.flows.size).toBe(0);
});


test.skip("a remote that diverged from the accepted head parks review ingress and keeps both revisions", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  /* Someone else's repair landed on the branch; the accepted head does not
     contain it, so publication must refuse rather than fast-forward over it. */
  const foreignRepair = "d".repeat(40);
  box.setDivergentRemote(foreignRepair);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain(`review stage could not publish the accepted head ${shortId(box.passedSha)}`);
  expect(parked.stateDetail).toContain("diverged");
  expect(box.remote()).toBe(foreignRepair);
  expect(h.flows.size).toBe(0);
});


test.skip("a push that fails at review ingress parks before the review flow exists", async () => {
  const h = harness();
  const box = publishHarness(h);
  await create(h.ports, PUBLISH_STAGES as never, REMOTE_BRANCH);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);

  box.setRemote(null);
  box.setPushFails(true);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain(`review stage could not publish the accepted head ${shortId(box.passedSha)}`);
  expect(parked.stateDetail).toContain("publishing the pipeline branch:");
  expect(h.flows.size).toBe(0);
  expect(parked.lastPassedCommit).toBe(box.passedSha);
});


test("a pipeline without a recorded task adopts the fallback task its admission minted, on the tick and at the stage reservation (#1586)", async () => {
  const h = harness();
  const created = await create(h.ports);
  expect(created.taskIds).toEqual([]);
  const other = {
    id: "other-fallback", project: created.project, status: "inbox" as const, text: "Another pipeline's fallback", placement: "unplaced" as const,
    origin: { kind: "pipeline" as const, key: "some-other-pipeline", refinement: "pending" as const }, assignments: [], createdAt: "2026-09-09T12:00:00.000Z", updatedAt: "2026-09-09T12:00:00.000Z",
  };
  const fallback = { ...other, id: "created-fallback", text: "Ship pipelines", origin: { kind: "pipeline" as const, key: created.id, refinement: "pending" as const } };
  saveTasks([other, fallback]);
  await tickPipelines([], h.ports);
  /* The controller pass binds the fallback before any stage is reserved. */
  expect(loadPipelines().find((pipeline) => pipeline.id === created.id)!.taskIds).toEqual(["created-fallback"]);
  /* Recovery of the same pipeline reuses the same binding; a bound pipeline is left alone. */
  await tickPipelines([], h.ports);
  expect(loadPipelines().find((pipeline) => pipeline.id === created.id)!.taskIds).toEqual(["created-fallback"]);
  const bound = loadPipelines().find((pipeline) => pipeline.id === created.id)!;
  expect(engineModule.adoptPipelineFallbackTask(bound, [other, fallback])).toBe(false);
  /* The reservation callback binds a fallback minted for a pipeline whose
     record still shows none, before the stage's agent is actuated. */
  const unbound = { ...bound, taskIds: [] as string[] };
  expect(engineModule.adoptPipelineFallbackTask(unbound, [other, fallback])).toBe(true);
  expect(unbound.taskIds).toEqual(["created-fallback"]);
  expect(engineModule.adoptPipelineFallbackTask({ ...bound, taskIds: [] }, [other])).toBe(false);
});


const CALLBACK_EXIT = "Codex callback listener failed before dispatch: exited with code 23; stderr: EADDRINUSE: callback bind refused";
const CALLBACK_SIGNAL = "Codex callback listener failed before dispatch: exited on signal SIGTERM; stderr: EADDRINUSE: callback bind refused";
const CALLBACK_TIMEOUT = "Codex callback listener failed before dispatch: timed out after 10000ms; stderr: callback bind pending";

test("issue 3066: a repeated diagnosed callback startup failure remains an automatic launch retry", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const scheduled: number[] = [];
  let launches = 0;
  h.ports.spawnAgent = async (_input, onReserved) => {
    launches++;
    await onReserved({ launchId: `launch-callback-${launches}`, conversationId: `conversation_callback_${launches}` });
    throw new Error(CALLBACK_EXIT);
  };
  h.ports.spawnReceipt = launchId => failedReceipt(launchId,
    launchId.replace("launch-callback-", "conversation_callback_"), CALLBACK_EXIT);
  h.ports.claimSpawnRetry = () => "claimed";
  h.ports.scheduleTick = delayMs => { scheduled.push(delayMs); };
  h.ports.sleep = forbiddenSleep;

  await tickPipelines([], h.ports);
  expect(scheduled).toEqual([1_000]);
  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);

  const pipeline = loadPipelines()[0]!;
  expect(launches).toBe(2);
  expect(pipeline).toMatchObject({ state: "running", cursor: { stageId: "plan", state: "pending" } });
  expect(pipeline.runs[0]!.attempts).toHaveLength(1);
  expect(pipeline.runs[0]!.attempts[0]!.retiredLaunches).toEqual([
    expect.objectContaining({ launchId: "launch-callback-1", error: CALLBACK_EXIT }),
    expect.objectContaining({ launchId: "launch-callback-2", error: CALLBACK_EXIT }),
  ]);
  expect(pipeline.runs[0]!.attempts[0]!.controllerWait).toMatchObject({ rounds: 2 });
  expect(scheduled).toEqual([1_000, 2_000]);
});

test.skipIf(!process.env.LLV_CALLBACK_REPLAY_FILE)("callback persisted budget checkpoint", async () => {
  const checkpoint = JSON.parse(fs.readFileSync(process.env.LLV_CALLBACK_REPLAY_FILE!, "utf8"));
  const h = harness();
  h.ports.now = () => checkpoint.at;
  savePipelines([checkpoint.pipeline]);
  let calls = 0;
  h.ports.spawnAgent = async (_input, onReserved) => {
    calls++;
    await onReserved({ launchId: "launch-after-restart", conversationId: "conversation_after_restart" });
    throw new Error(CALLBACK_EXIT);
  };
  h.ports.spawnReceipt = () => failedReceipt("launch-after-restart", "conversation_after_restart", CALLBACK_EXIT);
  await tickPipelines([], h.ports);
  expect(calls).toBe(1);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision",
    stateDetail: `stage spawn failed after 1 retries over 600s: ${CALLBACK_EXIT}` });
});

test("callback retry budget survives a real controller process restart", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  frozenWallClock(h);
  h.ports.spawnAgent = async (_input, onReserved) => {
    await onReserved({ launchId: "launch-before-restart", conversationId: "conversation_before_restart" });
    throw new Error(CALLBACK_EXIT);
  };
  h.ports.spawnReceipt = () => failedReceipt("launch-before-restart", "conversation_before_restart", CALLBACK_EXIT);
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  expect(pipeline.runs[0]!.attempts[0]!.controllerWait?.rounds).toBe(1);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "callback-replay-"));
  const checkpoint = path.join(root, "checkpoint.json");
  fs.writeFileSync(checkpoint, JSON.stringify({ pipeline,
    at: new Date(Date.parse(pipeline.runs[0]!.attempts[0]!.controllerWait!.startedAt) + 600_000).toISOString() }));
  const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^callback persisted budget checkpoint$"], {
    env: { ...process.env, LLV_CALLBACK_REPLAY_FILE: checkpoint, DELEGATUS_CPU_PRESSURE: "off" }, stdout: "pipe", stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([child.exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("owned controller restart fixture exceeded its deadline")), 60_000);
    })]);
    expect(child.exitCode, await output + await stderr).toBe(0);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 70_000);

test.each([HOST_UNAVAILABLE, CALLBACK_EXIT, CALLBACK_TIMEOUT, CALLBACK_SIGNAL])("a transient transport failure after reservation retries the same attempt from its failed receipt: %s", async (failure) => {
  const h = harness();
  const created = await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  const receipts = new Map<string, ReturnType<PipelinePorts["spawnReceipt"]>>();
  const claims: string[] = [];
  const clientAttemptIds: string[] = [];
  const scheduled: number[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    clientAttemptIds.push(input.clientAttemptId);
    if (spawnCalls === 1) {
      await onReserved({ launchId: "launch-host-1", conversationId: "conversation_host_1" });
      receipts.set("launch-host-1", failedReceipt("launch-host-1", "conversation_host_1", failure));
      throw new Error(failure);
    }
    return baseSpawn(input, onReserved);
  };
  h.ports.spawnReceipt = (launchId) => receipts.get(launchId) ?? null;
  h.ports.claimSpawnRetry = (launchId, claimId) => {
    claims.push(`${launchId}:${claimId}`);
    return "claimed";
  };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  await tickPipelines([], h.ports);
  let pipeline = loadPipelines()[0]!;
  expect(spawnCalls).toBe(1);
  expect(claims).toEqual([`launch-host-1:${created.id}:plan:launch-host-1`]);
  expect(pipeline).toMatchObject({
    state: "running",
    stateDetail: expect.stringContaining(failure),
    cursor: { stageId: "plan", state: "pending" },
  });
  const waiting = pipeline.runs[0]!.attempts.at(-1)!;
  expect(pipeline.runs[0]!.attempts).toHaveLength(1);
  expect(waiting).toMatchObject({ n: 1, state: "pending", launchId: null, conversationId: null, error: null });
  expect(waiting.controllerWait).toMatchObject({ rounds: 1 });
  expect(waiting.retiredLaunches).toEqual([{
    launchId: "launch-host-1",
    conversationId: "conversation_host_1",
    error: failure,
    retiredAt: expect.any(String),
  }]);
  expect(scheduled).toEqual([1_000]);

  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  pipeline = loadPipelines()[0]!;
  expect(spawnCalls).toBe(2);
  expect(new Set(clientAttemptIds).size).toBe(2);
  expect(pipeline).toMatchObject({ state: "running", stateDetail: null, cursor: { stageId: "plan", state: "running" } });
  expect(pipeline.runs[0]!.attempts).toHaveLength(1);
  expect(pipeline.runs[0]!.attempts[0]).toMatchObject({
    n: 1,
    state: "running",
    launchId: "launch-1",
    conversationId: "conversation_stage_1",
    retiredLaunches: [{ launchId: "launch-host-1", conversationId: "conversation_host_1" }],
  });
  expect(pipeline.runs[0]!.attempts[0]!.controllerWait).toBeUndefined();
});

test.each([
  "Codex callback listener ownership could not be verified; stderr: EACCES",
  "Codex callback listener ownership could not be verified; stderr: runtime host is unavailable; structured initial message",
  "Codex callback setup cleanup identity could not be verified",
  "Codex callback listener did not start or its ownership could not be verified",
])("callback ownership and ambiguous legacy failures stay refused: %s", async (failure) => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  let calls = 0;
  const claims: string[] = [];
  h.ports.spawnAgent = async (_input, onReserved) => {
    calls++;
    await onReserved({ launchId: "launch-unverified", conversationId: "conversation_unverified" });
    throw new Error(failure);
  };
  h.ports.spawnReceipt = () => failedReceipt("launch-unverified", "conversation_unverified", failure);
  h.ports.claimSpawnRetry = id => { claims.push(id); return "claimed"; };
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(calls).toBe(1);
  expect(claims).toEqual([]);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: failure });
});


test.each([
  { fate: "no receipt", receipt: null },
  { fate: "a receipt still starting", receipt: { state: "starting", launchId: "launch-host-unknown", conversationId: "conversation_host_unknown", sessionId: null, "transcript": null, paneId: null } },
] as const)("a runtime-host transport failure with $fate parks without re-dispatching (#1678)", async ({ receipt }) => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const scheduled: number[] = [];
  const claims: string[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async (_input, onReserved) => {
    spawnCalls += 1;
    await onReserved({ launchId: "launch-host-unknown", conversationId: "conversation_host_unknown" });
    throw new Error(HOST_UNAVAILABLE);
  };
  h.ports.spawnReceipt = () => receipt;
  h.ports.claimSpawnRetry = (launchId) => { claims.push(launchId); return "claimed"; };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(spawnCalls).toBe(1);
  expect(claims).toEqual([]);
  expect(scheduled).toEqual([]);
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: HOST_UNAVAILABLE });
  expect(parked.runs[0]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    launchId: "launch-host-unknown",
    conversationId: "conversation_host_unknown",
    error: HOST_UNAVAILABLE,
  });
  expect(parked.runs[0]!.attempts[0]!.retiredLaunches).toBeUndefined();
});

test.each([null, "starting"] as const)("a callback launch with %s evidence stays fenced", async (state) => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  let calls = 0;
  const claims: string[] = [];
  h.ports.spawnAgent = async (_input, onReserved) => {
    calls++;
    await onReserved({ launchId: "launch-callback", conversationId: "conversation_callback" });
    throw new Error(CALLBACK_EXIT);
  };
  h.ports.spawnReceipt = () => state === null ? null : { ...failedReceipt("launch-callback", "conversation_callback", CALLBACK_EXIT), state };
  h.ports.claimSpawnRetry = id => { claims.push(id); return "claimed"; };
  await tickPipelines([], h.ports);
  expect(calls).toBe(1);
  expect(claims).toEqual([]);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: CALLBACK_EXIT });
});


test.each([HOST_UNAVAILABLE, CALLBACK_EXIT, CALLBACK_SIGNAL])("transport retries are bounded and preserve repeated causes: %s", async (failure) => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const scheduled: number[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async (_input, onReserved) => {
    spawnCalls += 1;
    await onReserved({ launchId: `launch-host-${spawnCalls}`, conversationId: `conversation_host_${spawnCalls}` });
    throw new Error(failure);
  };
  h.ports.spawnReceipt = (launchId) => failedReceipt(launchId, launchId.replace("launch-host-", "conversation_host_"), failure);
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  for (let round = 0; round < 40 && loadPipelines()[0]!.state === "running"; round += 1) {
    const scheduledBefore = scheduled.length;
    await tickPipelines([], h.ports);
    if (loadPipelines()[0]!.state === "running") {
      expect(scheduled.length).toBe(scheduledBefore + 1);
      advance(scheduled.at(-1)!);
    }
  }

  const parked = loadPipelines()[0]!;
  expect(spawnCalls).toBe(16);
  expect(scheduled).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 57_000]);
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: `stage spawn failed after 15 retries over 600s: ${failure}`,
    cursor: { stageId: "plan", state: "spawning" },
  });
  expect(parked.runs[0]!.attempts).toHaveLength(1);
  /* The last launch stays on the attempt: its receipt is what retry-stage claims. */
  expect(parked.runs[0]!.attempts[0]).toMatchObject({
    n: 1,
    state: "needs_decision",
    launchId: "launch-host-16",
    conversationId: "conversation_host_16",
    error: parked.stateDetail,
  });
  expect(parked.runs[0]!.attempts[0]!.retiredLaunches).toHaveLength(15);
  expect(parked.runs[0]!.attempts[0]!.retiredLaunches!.at(-1)).toMatchObject({ launchId: "launch-host-15" });
  expect(parked.runs[0]!.attempts[0]!.retiredLaunches!.every(launch => launch.error === failure)).toBe(true);
});


test("a busy account mutation after reservation retries once its receipt has failed (#1678)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  const scheduled: number[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    if (spawnCalls === 1) {
      await onReserved({ launchId: "launch-busy-1", conversationId: "conversation_busy_1" });
      throw new AccountMutationBusyError("account mutation is busy in this process; retry shortly");
    }
    return baseSpawn(input, onReserved);
  };
  h.ports.spawnReceipt = (launchId) => launchId === "launch-busy-1"
    ? failedReceipt("launch-busy-1", "conversation_busy_1", "account mutation is busy in this process; retry shortly")
    : null;
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  await tickPipelines([], h.ports);
  let pipeline = loadPipelines()[0]!;
  expect(pipeline).toMatchObject({
    state: "running",
    stateDetail: expect.stringMatching(/^stage spawn deferred: account mutation is busy in this process; retry at /),
  });
  expect(pipeline.runs[0]!.attempts[0]).toMatchObject({
    state: "pending",
    launchId: null,
    retiredLaunches: [{ launchId: "launch-busy-1", conversationId: "conversation_busy_1" }],
  });

  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  pipeline = loadPipelines()[0]!;
  expect(spawnCalls).toBe(2);
  expect(pipeline.runs[0]!.attempts).toHaveLength(1);
  expect(pipeline.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "running", launchId: "launch-1" });
});


test("a spawn interrupted by a restart retries from a transient failed receipt instead of parking (#1678)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts.push({
    n: 1,
    state: "spawning",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-interrupted",
    conversationId: "conversation_interrupted",
    sessionId: null,
    agentPath: null,
    paneId: null,
    flowId: null,
    startedAt: h.ports.now(),
    completedAt: null,
    input: null,
    activatedBy: null,
    output: null,
    verdict: null,
    error: null,
  });
  pipeline.cursor = { stageId: "plan", state: "spawning", input: null, activatedBy: null };
  savePipelines([pipeline]);
  const scheduled: number[] = [];
  const claims: string[] = [];
  h.ports.spawnReceipt = (launchId) => launchId === "launch-interrupted"
    ? failedReceipt("launch-interrupted", "conversation_interrupted", "structured spawn runtime host is unavailable; start agent-log-viewer through its CLI and check the CLI log for the host startup failure")
    : null;
  h.ports.claimSpawnRetry = (launchId) => { claims.push(launchId); return "claimed"; };
  Object.assign(h.ports, { scheduleTick: (delayMs: number) => { scheduled.push(delayMs); } });

  await tickPipelines([], h.ports);
  let current = loadPipelines()[0]!;
  expect(claims).toEqual(["launch-interrupted"]);
  expect(current).toMatchObject({ state: "running", cursor: { stageId: "plan", state: "pending" } });
  expect(current.runs[0]!.attempts[0]).toMatchObject({
    state: "pending",
    launchId: null,
    retiredLaunches: [{ launchId: "launch-interrupted", conversationId: "conversation_interrupted" }],
  });
  expect(scheduled).toEqual([1_000]);

  h.advanceWallClock(1_000);
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "running", launchId: "launch-1" });
});


test("a spawn interrupted by a restart still parks on a deterministic failed receipt (#1678)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts.push({
    n: 1,
    state: "spawning",
    effectiveRole: structuredClone(pipeline.stages[0]!.effectiveRole),
    launchId: "launch-refused",
    conversationId: "conversation_refused",
    sessionId: null,
    agentPath: null,
    paneId: null,
    flowId: null,
    startedAt: h.ports.now(),
    completedAt: null,
    input: null,
    activatedBy: null,
    output: null,
    verdict: null,
    error: null,
  });
  pipeline.cursor = { stageId: "plan", state: "spawning", input: null, activatedBy: null };
  savePipelines([pipeline]);
  const claims: string[] = [];
  h.ports.spawnReceipt = () => failedReceipt("launch-refused", "conversation_refused", "pipeline spawn attempt conflicts with its original request");
  h.ports.claimSpawnRetry = (launchId) => { claims.push(launchId); return "claimed"; };

  await tickPipelines([], h.ports);

  expect(claims).toEqual([]);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: "pipeline spawn attempt conflicts with its original request" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "needs_decision", launchId: "launch-refused" });
});


test("a pipeline spawn that finds no runtime host fails its own receipt before it throws (#1678)", async () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "pipeline-no-host-registry.json"));
  const cwd = process.env.LLV_STATE_DIR!;
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  delete process.env.LLV_RUNTIME_HOST_SOCKET;
  setAgentRegistryForTests(registry);
  const resolveSpawn = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({
    kind: "available",
    account: {
      engine: "codex",
      accountId: "no-host",
      kind: "managed",
      home: process.env.LLV_STATE_DIR!,
      transcriptRoot: process.env.LLV_STATE_DIR!,
      env: { NODE_ENV: "test" },
    },
  }));
  const reservations: Array<{ launchId: string; conversationId: string }> = [];
  try {
    const ports = defaultPipelinePorts();
    await expect(ports.spawnAgent({
      role: {
        roleId: "builder",
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        access: "read-write",
        promptScaffold: "Builder guidance",
      },
      runtimeProfile: { access: "read-write", sandbox: "full" },
      cwd,
      project: "repo-00000000000000000000000000000001",
      requestedAccountId: null,
      title: "Build scoped change · build",
      ["prompt"]: "Build the scoped change",
      parentPath: null,
      clientAttemptId: "pipeline_no_host_attempt",
      membership: {
        kind: "pipeline",
        containerId: "pipeline-no-host",
        role: "builder",
        slot: "build:1",
        stageId: "build",
        stageOrder: 0,
        round: 1,
        parentConversationId: null,
      },
      creatorConversationId: null,
    }, (created) => { reservations.push(created); })).rejects.toThrow("pipeline structured runtime host is unavailable");
    const reservation = reservations[0];
    if (!reservation) throw new Error("pipeline reservation was not captured");
    expect(ports.spawnReceipt(reservation.launchId)).toMatchObject({
      state: "failed",
      launchId: reservation.launchId,
      conversationId: reservation.conversationId,
      error: "pipeline structured runtime host is unavailable; start agent-log-viewer through its CLI and check the CLI log for the host startup failure",
    });
    expect(await ports.claimSpawnRetry(reservation.launchId, "pipeline-no-host:build:claim")).toBe("claimed");
  } finally {
    resolveSpawn.mockRestore();
    setAgentRegistryForTests(null);
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
  }
});


/* #1750: six production lanes parked on a transient runtime-host failure whose
   retry the engine could not reach. The receipts were `failed` on disk within
   two seconds, and the catch that retires a failed launch read them through a
   registry projection captured BEFORE the launch was reserved, so it saw
   `null` and rethrew. A controller tick always reads the projection before it
   spawns — the pass reconciles every running attempt first — so the projection
   is primed here exactly as a tick primes it. */
test("a spawn that throws leaves its own failed receipt readable through the same ports (#1750)", async () => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "pipeline-failure-projection-registry.json"));
  const cwd = process.env.LLV_STATE_DIR!;
  const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
  delete process.env.LLV_RUNTIME_HOST_SOCKET;
  setAgentRegistryForTests(registry);
  const resolveSpawn = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(() => ({
    kind: "available",
    account: {
      engine: "codex",
      accountId: "stale-projection",
      kind: "managed",
      home: process.env.LLV_STATE_DIR!,
      transcriptRoot: process.env.LLV_STATE_DIR!,
      env: { NODE_ENV: "test" },
    },
  }));
  const reservations: Array<{ launchId: string; conversationId: string }> = [];
  try {
    const ports = defaultPipelinePorts();
    /* The read a tick makes before it ever reaches the spawn. */
    expect(ports.spawnReceipt("launch-not-yet-reserved")).toBeNull();
    await expect(ports.spawnAgent({
      role: {
        roleId: "builder",
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        access: "read-write",
        promptScaffold: "Builder guidance",
      },
      runtimeProfile: { access: "read-write", sandbox: "full" },
      cwd,
      project: "repo-00000000000000000000000000000001",
      requestedAccountId: null,
      title: "Build scoped change · build",
      ["prompt"]: "Build the scoped change",
      parentPath: null,
      clientAttemptId: "pipeline_stale_projection_attempt",
      membership: {
        kind: "pipeline",
        containerId: "pipeline-stale-projection",
        role: "builder",
        slot: "build:1",
        stageId: "build",
        stageOrder: 0,
        round: 1,
        parentConversationId: null,
      },
      creatorConversationId: null,
    }, (created) => { reservations.push(created); })).rejects.toThrow("pipeline structured runtime host is unavailable");
    const reservation = reservations[0];
    if (!reservation) throw new Error("pipeline reservation was not captured");
    expect(ports.spawnReceipt(reservation.launchId)).toMatchObject({
      state: "failed",
      launchId: reservation.launchId,
      conversationId: reservation.conversationId,
    });
  } finally {
    resolveSpawn.mockRestore();
    setAgentRegistryForTests(null);
    if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
    else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
  }
});


test("an unverified first delivery retries when the stage transcript was never created (#1750)", async () => {
  const h = harness();
  const created = await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  const scheduled: number[] = [];
  const probed: string[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    if (spawnCalls === 1) {
      await onReserved({ launchId: "launch-unverified", conversationId: "conversation_unverified" });
      throw new Error(UNVERIFIED_DELIVERY);
    }
    return baseSpawn(input, onReserved);
  };
  h.ports.spawnReceipt = (launchId) => launchId === "launch-unverified"
    ? {
      state: "failed",
      launchId,
      conversationId: "conversation_unverified",
      sessionId: null,
      ["transcript"]: null,
      stagedTranscript: "/codex/never-created.jsonl",
      paneId: null,
      staged: true,
      error: UNVERIFIED_DELIVERY,
    }
    : null;
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
    transcriptPresent: (pathname: string) => { probed.push(pathname); return false; },
  });

  await tickPipelines([], h.ports);
  let pipeline = loadPipelines()[0]!;
  expect(spawnCalls).toBe(1);
  expect(probed).toEqual(["/codex/never-created.jsonl"]);
  const waiting = pipeline.runs[0]!.attempts.at(-1)!;
  expect(waiting).toMatchObject({ n: 1, state: "pending", launchId: null, conversationId: null, error: null });
  /* The class rides the budget that outlasts a deploy, not the controller's
     thirty seconds. */
  expect(waiting.controllerWait).toMatchObject({ rounds: 1, budgetMs: 600_000, retryMaxMs: 60_000 });
  expect(waiting.retiredLaunches).toEqual([{
    launchId: "launch-unverified",
    conversationId: "conversation_unverified",
    error: UNVERIFIED_DELIVERY,
    retiredAt: expect.any(String),
  }]);
  expect(created.id).toBe(pipeline.id);

  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  pipeline = loadPipelines()[0]!;
  expect(spawnCalls).toBe(2);
  expect(pipeline).toMatchObject({ state: "running", cursor: { stageId: "plan", state: "running" } });
  expect(pipeline.runs[0]!.attempts).toHaveLength(1);
  expect(pipeline.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "running", conversationId: "conversation_stage_1" });
});


test("an unverified first delivery never sends a second prompt where the stage transcript exists (#1750)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const scheduled: number[] = [];
  const claims: string[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async (_input, onReserved) => {
    spawnCalls += 1;
    await onReserved({ launchId: "launch-unverified-live", conversationId: "conversation_unverified_live" });
    throw new Error(UNVERIFIED_DELIVERY);
  };
  h.ports.spawnReceipt = (launchId) => ({
    state: "failed",
    launchId,
    conversationId: "conversation_unverified_live",
    sessionId: null,
    ["transcript"]: null,
    stagedTranscript: "/codex/stage-unverified.jsonl",
    paneId: null,
    staged: true,
    error: UNVERIFIED_DELIVERY,
  });
  h.ports.claimSpawnRetry = (launchId) => { claims.push(launchId); return "claimed"; };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
    transcriptPresent: () => true,
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(spawnCalls).toBe(1);
  /* Nothing was claimed, nothing was retired, and no second prompt was made. */
  expect(claims).toEqual([]);
  expect(scheduled).toEqual([]);
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: `${UNVERIFIED_DELIVERY}; the stage transcript exists, so the prompt may already have reached the agent and is not sent again`,
  });
  expect(parked.runs[0]!.attempts[0]!.retiredLaunches).toBeUndefined();
});


test("a non-transient spawn failure still parks at once (#1750)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const scheduled: number[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async () => {
    spawnCalls += 1;
    throw new Error("stage worktree is not a git repository");
  };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(spawnCalls).toBe(1);
  expect(scheduled).toEqual([]);
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: "stage worktree is not a git repository" });
  expect(parked.runs[0]!.attempts[0]!.controllerWait).toBeUndefined();
});


test.each([HOST_UNAVAILABLE, CALLBACK_EXIT])("a failed receipt that settles before its retry claim parks instead of re-dispatching: %s", async (failure) => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const scheduled: number[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async (_input, onReserved) => {
    spawnCalls += 1;
    await onReserved({ launchId: "launch-host-settled", conversationId: "conversation_host_settled" });
    throw new Error(failure);
  };
  h.ports.spawnReceipt = () => failedReceipt("launch-host-settled", "conversation_host_settled", failure);
  h.ports.claimSpawnRetry = () => "settled";
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(spawnCalls).toBe(1);
  expect(scheduled).toEqual([]);
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: failure });
  expect(parked.runs[0]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    launchId: "launch-host-settled",
    conversationId: "conversation_host_settled",
  });
  expect(parked.runs[0]!.attempts[0]!.retiredLaunches).toBeUndefined();
});


test.skip("a review flow paused on an unscanned implementer transcript resumes on a bounded wait (#1678)", async () => {
  const h = harness();
  const { flow, pauseOnScan } = await reviewFlowPausedOnUnscannedImplementer(h);
  const advance = frozenWallClock(h);
  const scheduled: number[] = [];
  Object.assign(h.ports, { scheduleTick: (delayMs: number) => { scheduled.push(delayMs); } });

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  let pipeline = loadPipelines()[0]!;
  expect(h.calls.filter((call) => call === "flow-patch:flow-1:resume")).toHaveLength(1);
  expect(flow).toMatchObject({ state: "spawning", pausedState: null });
  expect(pipeline).toMatchObject({
    state: "running",
    stateDetail: expect.stringMatching(/^review flow waiting for its implementer transcript to be scanned; retry at /),
    cursor: { stageId: "review", state: "reviewing" },
  });
  expect(pipeline.runs[1]!.attempts[0]).toMatchObject({ state: "reviewing", error: null, flowId: "flow-1" });
  expect(pipeline.runs[1]!.attempts[0]!.controllerWait).toMatchObject({ rounds: 1 });
  expect(scheduled).toEqual([1_000]);

  /* The flows phase re-pauses on the same stale snapshot; the next resume is
     not due until the booked backoff passes. */
  pauseOnScan();
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(h.calls.filter((call) => call === "flow-patch:flow-1:resume")).toHaveLength(1);
  expect(loadPipelines()[0]).toMatchObject({ state: "running" });
  advance(scheduled.at(-1)!);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(h.calls.filter((call) => call === "flow-patch:flow-1:resume")).toHaveLength(2);
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.controllerWait).toMatchObject({ rounds: 2 });
  expect(scheduled).toEqual([1_000, 2_000]);

  /* The snapshot caught up: the flow spawned its reviewer and the wait is over. */
  flow.state = "reviewing";
  flow.stateDetail = null;
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  pipeline = loadPipelines()[0]!;
  expect(pipeline).toMatchObject({ state: "running", stateDetail: null, cursor: { stageId: "review", state: "reviewing" } });
  expect(pipeline.runs[1]!.attempts[0]!.controllerWait).toBeUndefined();
});


test.skip("a review flow whose implementer transcript the scan never lists parks after the bounded resumes (#1678)", async () => {
  const h = harness();
  const { flow, pauseOnScan } = await reviewFlowPausedOnUnscannedImplementer(h);
  const advance = frozenWallClock(h);
  const scheduled: number[] = [];
  Object.assign(h.ports, { scheduleTick: (delayMs: number) => { scheduled.push(delayMs); } });

  for (let round = 0; round < 40 && loadPipelines()[0]!.state === "running"; round += 1) {
    const scheduledBefore = scheduled.length;
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
    if (loadPipelines()[0]!.state === "running") {
      expect(scheduled.length).toBe(scheduledBefore + 1);
      pauseOnScan();
      advance(scheduled.at(-1)!);
    }
  }

  const parked = loadPipelines()[0]!;
  expect(h.calls.filter((call) => call === "flow-patch:flow-1:resume")).toHaveLength(15);
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: "review flow paused in spawning: implementer transcript is missing (after 15 automatic resumes over 600s)",
  });
  expect(parked.runs[1]!.attempts[0]).toMatchObject({ state: "needs_decision", error: parked.stateDetail });
  expect(flow.state).toBe("paused");

  /* An exhausted park is not resumed again behind the operator's back. */
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(h.calls.filter((call) => call === "flow-patch:flow-1:resume")).toHaveLength(15);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
});


test.skip("a review flow paused on a transcript the Viewer does not know parks at once (#1678)", async () => {
  const h = harness();
  await reviewFlowPausedOnUnscannedImplementer(h);
  h.ports.pathForConversation = () => null;
  h.ports.conversationRegistered = () => false;

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  expect(h.calls).not.toContain("flow-patch:flow-1:resume");
  expect(loadPipelines()[0]).toMatchObject({
    state: "needs_decision",
    stateDetail: "review flow paused in spawning: implementer transcript is missing",
  });
});


test.skip("a reviewer launch the flow ended on a busy account lock is retried on a bounded wait (#1678)", async () => {
  const h = harness();
  const { flow, busy } = await reviewFlowEndedOnBusyAccount(h);
  const advance = frozenWallClock(h);
  const scheduled: number[] = [];
  Object.assign(h.ports, { scheduleTick: (delayMs: number) => { scheduled.push(delayMs); } });
  const retries = () => h.calls.filter((call) => call === "flow-patch:flow-1:retry-round").length;

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  let pipeline = loadPipelines()[0]!;
  expect(retries()).toBe(1);
  expect(flow).toMatchObject({ state: "spawning", stateDetail: null });
  expect(pipeline).toMatchObject({
    state: "running",
    stateDetail: expect.stringMatching(/^review flow reviewer launch deferred: account mutation is busy; retry at /),
    cursor: { stageId: "review", state: "reviewing" },
  });
  expect(pipeline.runs[1]!.attempts[0]).toMatchObject({ state: "reviewing", error: null, flowId: "flow-1" });
  expect(pipeline.runs[1]!.attempts[0]!.controllerWait).toMatchObject({ rounds: 1 });
  expect(scheduled).toEqual([1_000]);

  /* A tick while the fresh round is still waiting to launch keeps the budget. */
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.controllerWait).toMatchObject({ rounds: 1 });

  busy();
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(retries()).toBe(1);
  expect(loadPipelines()[0]).toMatchObject({ state: "running" });
  advance(scheduled.at(-1)!);
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(retries()).toBe(2);
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.controllerWait).toMatchObject({ rounds: 2 });

  /* The lock cleared: the fresh round launched and the wait is over. */
  flow.state = "reviewing";
  flow.rounds.at(-1)!.spawnStartedAt = h.ports.now();
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  pipeline = loadPipelines()[0]!;
  expect(pipeline).toMatchObject({ state: "running", stateDetail: null, cursor: { stageId: "review", state: "reviewing" } });
  expect(pipeline.runs[1]!.attempts[0]!.controllerWait).toBeUndefined();
});


test.skip("a reviewer launch that stays contended parks after the bounded retries (#1678)", async () => {
  const h = harness();
  const { busy } = await reviewFlowEndedOnBusyAccount(h);
  const advance = frozenWallClock(h);
  const scheduled: number[] = [];
  Object.assign(h.ports, { scheduleTick: (delayMs: number) => { scheduled.push(delayMs); } });

  for (let round = 0; round < 40 && loadPipelines()[0]!.state === "running"; round += 1) {
    const scheduledBefore = scheduled.length;
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
    if (loadPipelines()[0]!.state === "running") {
      expect(scheduled.length).toBe(scheduledBefore + 1);
      busy();
      advance(scheduled.at(-1)!);
    }
  }

  const parked = loadPipelines()[0]!;
  expect(h.calls.filter((call) => call === "flow-patch:flow-1:retry-round")).toHaveLength(15);
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: `review loop ended in needs_decision: ${REVIEWER_BUSY} (after 15 automatic launch retries over 600s)`,
  });
  expect(parked.runs[1]!.attempts[0]).toMatchObject({ state: "needs_decision", error: parked.stateDetail });

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(h.calls.filter((call) => call === "flow-patch:flow-1:retry-round")).toHaveLength(15);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
});


test.skip("a busy-account round that had already begun a launch parks without a retry (#1678)", async () => {
  const h = harness();
  const { flow } = await reviewFlowEndedOnBusyAccount(h);
  flow.rounds.at(-1)!.spawnStartedAt = h.ports.now();

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);

  expect(h.calls).not.toContain("flow-patch:flow-1:retry-round");
  expect(loadPipelines()[0]).toMatchObject({
    state: "needs_decision",
    stateDetail: `review loop ended in needs_decision: ${REVIEWER_BUSY}`,
  });
});


test.skip("a review flow paused on the scan in a phase past spawning parks at once (#1678 review)", async () => {
  const h = harness();
  const { flow } = await reviewFlowPausedOnUnscannedImplementer(h);
  flow.pausedState = "fixing";
  flow.rounds.push({ n: 1, reviewerPath: "/codex/reviewer.jsonl", reviewerConversationId: "conversation_reviewer", sessionId: "reviewer-session", launchId: "launch-reviewer", spawnStartedAt: h.ports.now(), verdict: "REQUEST_CHANGES", error: null } as never);

  await tickPipelines([entry("/codex/reviewer.jsonl")], h.ports);

  expect(h.calls).not.toContain("flow-patch:flow-1:resume");
  expect(loadPipelines()[0]).toMatchObject({
    state: "needs_decision",
    stateDetail: "review flow paused in fixing: implementer transcript is missing",
  });
  expect(loadPipelines()[0]!.runs[1]!.attempts[0]!.controllerWait).toBeUndefined();
});


test("a failed staged read-write startup keeps dirty work and automatically relaunches (#1678)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build {{task}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  const baseExec = h.ports.exec;
  h.ports.exec = (command, args, cwd) => args[0] === "status"
    ? { code: 0, stdout: " M src/partial-edit.ts\n", stderr: "" } : baseExec(command, args, cwd);
  const claims: string[] = [];
  const spawnAgent = h.ports.spawnAgent;
  let calls = 0;
  h.ports.spawnAgent = async (input, onReserved) => {
    if (++calls > 1) return spawnAgent(input, onReserved);
    await onReserved({ launchId: "launch-staged", conversationId: "conversation_staged" });
    throw new Error(HOST_UNAVAILABLE);
  };
  h.ports.spawnReceipt = (id) => id === "launch-staged" ? { ...failedReceipt(id, "conversation_staged", HOST_UNAVAILABLE), staged: true } : null;
  h.ports.claimSpawnRetry = (id) => { claims.push(id); return "claimed"; };
  const stoppedLaunches: Array<string | null | undefined> = [];
  h.ports.stopStageAgent = async (target) => {
    stoppedLaunches.push(target.launchId);
    return target.launchId ? { outcome: "not-running" } : { outcome: "failed", error: "missing launch identity" };
  };
  Object.assign(h.ports, { sleep: forbiddenSleep });
  await tickPipelines([], h.ports);
  expect(stoppedLaunches).toEqual(["launch-staged"]);
  expect(claims).toEqual(["launch-staged"]);
  expect(loadPipelines()[0]!.state).toBe("running");
  const { projectPipelineEvents } = await import("@/lib/lifecycle/projector");
  const recoveryEvents = projectPipelineEvents(loadPipelines()).filter((event) =>
    event.type === "stage_waiting" || event.type === "stage_relaunched");
  expect(recoveryEvents.map((event) => event.type)).toEqual(["stage_waiting", "stage_relaunched"]);
  expect(recoveryEvents.every((event) => event.summary?.includes("failed startup") === true)).toBe(true);
  const recoveryKeys = recoveryEvents.map((event) => event.key);
  h.advanceWallClock(5_000);
  await tickPipelines([], h.ports);
  expect(calls).toBe(2);
  expect(h.spawnInputs[0]!.prompt).toContain("failed startup");
  expect(h.spawnInputs[0]!.prompt).toContain("keeping uncommitted work");
  expect(h.calls.some((call) => /reset|clean/.test(call))).toBe(false);
  expect(projectPipelineEvents(loadPipelines()).filter((event) =>
    event.type === "stage_waiting" || event.type === "stage_relaunched").map((event) => event.key)).toEqual(recoveryKeys);
});


test("a failed receipt that staged a session still retries a read-only stage (#1678 review)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const baseSpawn = h.ports.spawnAgent;
  const scheduled: number[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    if (spawnCalls === 1) {
      await onReserved({ launchId: "launch-staged-ro", conversationId: "conversation_staged_ro" });
      throw new Error(HOST_UNAVAILABLE);
    }
    return baseSpawn(input, onReserved);
  };
  h.ports.spawnReceipt = (launchId) => launchId === "launch-staged-ro"
    ? { ...failedReceipt("launch-staged-ro", "conversation_staged_ro", HOST_UNAVAILABLE), staged: true }
    : null;
  Object.assign(h.ports, { scheduleTick: (delayMs: number) => { scheduled.push(delayMs); }, sleep: forbiddenSleep });

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
    state: "pending",
    launchId: null,
    retiredLaunches: [{ launchId: "launch-staged-ro" }],
  });
  h.advanceWallClock(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  expect(spawnCalls).toBe(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "running", launchId: "launch-1" });
});


test("a read-write launch the deploy handover failed after staging waits and relaunches when its worktree is untouched (#1835)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build {{task}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  const baseSpawn = h.ports.spawnAgent;
  const scheduled: number[] = [];
  let spawnCalls = 0;
  /* The incident's header build attempt 2: the runtime host went away while
     the release changed hands, after the launch had staged its session. */
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    if (spawnCalls === 1) {
      await onReserved({ launchId: "launch-handover", conversationId: "conversation_handover" });
      throw new Error(HOST_UNAVAILABLE);
    }
    return baseSpawn(input, onReserved);
  };
  h.ports.spawnReceipt = (launchId) => launchId === "launch-handover"
    ? { ...failedReceipt("launch-handover", "conversation_handover", HOST_UNAVAILABLE), staged: true }
    : null;
  Object.assign(h.ports, { scheduleTick: (delayMs: number) => { scheduled.push(delayMs); }, sleep: forbiddenSleep });

  await tickPipelines([], h.ports);

  const waiting = loadPipelines()[0]!;
  expect(waiting.state).toBe("running");
  expect(waiting.stateDetail).toStartWith("waiting to relaunch after failed startup: ");
  expect(waiting.runs[0]!.attempts[0]).toMatchObject({
    state: "pending",
    launchId: null,
    retiredLaunches: [{ launchId: "launch-handover" }],
  });

  /* The successor answers: the same attempt launches once more. */
  h.advanceWallClock(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  expect(spawnCalls).toBe(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "running", launchId: "launch-1" });
});


test("a spawn interrupted by a long restart starts its retry budget at the first sighting (#1678 review)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const scheduled: number[] = [];
  Object.assign(h.ports, { scheduleTick: (delayMs: number) => { scheduled.push(delayMs); } });
  const twentyMinutesAgo = new Date(Date.parse(h.ports.now()) - 20 * 60_000).toISOString();
  interruptedSpawnAttempt(h, twentyMinutesAgo);

  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current).toMatchObject({ state: "running", cursor: { stageId: "plan", state: "pending" } });
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "pending", launchId: null, retiredLaunches: [{ launchId: "launch-interrupted" }] });
  expect(current.runs[0]!.attempts[0]!.controllerWait).toMatchObject({ rounds: 1 });
  expect(scheduled).toEqual([1_000]);
});


test("a spawn interrupted by a restart with its wait already spent parks with the rounds and seconds (#1678 review)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const claims: string[] = [];
  h.ports.claimSpawnRetry = (launchId) => { claims.push(launchId); return "claimed"; };
  const now = Date.parse(h.ports.now());
  const elevenMinutesAgo = new Date(now - 11 * 60_000).toISOString();
  interruptedSpawnAttempt(h, elevenMinutesAgo, { startedAt: elevenMinutesAgo, rounds: 3, retryAfter: new Date(now - 60_000).toISOString() });

  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(claims).toEqual(["launch-interrupted"]);
  expect(parked).toMatchObject({
    state: "needs_decision",
    stateDetail: expect.stringMatching(new RegExp(`^stage spawn failed after 3 retries over 66\\ds: ${HOST_UNAVAILABLE.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}$`)),
  });
  expect(parked.runs[0]!.attempts[0]).toMatchObject({ state: "needs_decision", launchId: "launch-interrupted" });
});


test("a busy lock a minute into a runtime-host wait keeps the host's ten-minute budget (#1678 review 2)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  const scheduled: number[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    if (spawnCalls <= 7) {
      await onReserved({ launchId: `launch-host-${spawnCalls}`, conversationId: `conversation_host_${spawnCalls}` });
      throw new Error(HOST_UNAVAILABLE);
    }
    if (spawnCalls === 8) throw new AccountMutationBusyError("account mutation is busy in this process; retry shortly");
    return baseSpawn(input, onReserved);
  };
  h.ports.spawnReceipt = (launchId) => launchId.startsWith("launch-host-")
    ? failedReceipt(launchId, launchId.replace("launch-host-", "conversation_host_"), HOST_UNAVAILABLE)
    : null;
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });

  /* Seven host failures spend 1+2+4+8+16+32+60 = 123 s of the ten-minute budget. */
  for (let round = 0; round < 7; round += 1) {
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.state).toBe("running");
    advance(scheduled.at(-1)!);
  }
  expect(spawnCalls).toBe(7);

  /* The eighth activation meets the busy lock 123 s in; the wait keeps the host budget. */
  await tickPipelines([], h.ports);
  let pipeline = loadPipelines()[0]!;
  expect(spawnCalls).toBe(8);
  expect(pipeline).toMatchObject({
    state: "running",
    stateDetail: expect.stringMatching(/^stage spawn deferred: The account store is temporarily busy; try again shortly\.; retry at /),
  });
  expect(pipeline.runs[0]!.attempts[0]!.controllerWait).toMatchObject({ rounds: 8, budgetMs: 600_000, retryMaxMs: 60_000 });
  expect(scheduled.at(-1)).toBe(60_000);

  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  pipeline = loadPipelines()[0]!;
  expect(spawnCalls).toBe(9);
  expect(pipeline).toMatchObject({ state: "running", stateDetail: null, cursor: { stageId: "plan", state: "running" } });
  expect(pipeline.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "running", launchId: "launch-1" });
});


/* #1750 moved this: a busy lock sighted on its own used to end at thirty
   seconds, and #1678 review 2 only kept a host outage's ten minutes from being
   cut down to it. The lock a release succession holds is the same condition,
   so the busy class now opens on the host budget rather than inheriting it,
   and a delivery controller between publications is the only class left on
   thirty seconds. */
test("a busy-lock wait alone opens on the budget that outlasts a deploy (#1750)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const scheduled: number[] = [];
  h.ports.spawnAgent = async () => { throw new Error("account mutation is busy; retry shortly"); };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });
  for (let round = 0; round < 8 && loadPipelines()[0]!.state === "running"; round += 1) {
    await tickPipelines([], h.ports);
    if (loadPipelines()[0]!.state === "running") advance(scheduled.at(-1)!);
  }
  const pipeline = loadPipelines()[0]!;
  expect(pipeline.state).toBe("running");
  expect(pipeline.runs[0]!.attempts[0]!.controllerWait).toMatchObject({ rounds: 8, budgetMs: 600_000, retryMaxMs: 60_000 });
});


test("a delivery controller between publications keeps the thirty-second budget (#1750)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const scheduled: number[] = [];
  h.ports.spawnAgent = async () => { throw new Error("structured delivery controller is unavailable"); };
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: forbiddenSleep,
  });
  for (let round = 0; round < 12 && loadPipelines()[0]!.state === "running"; round += 1) {
    await tickPipelines([], h.ports);
    if (loadPipelines()[0]!.state === "running") advance(scheduled.at(-1)!);
  }
  expect(loadPipelines()[0]).toMatchObject({
    state: "needs_decision",
    stateDetail: "stage spawn failed after 6 retries over 30s: structured delivery controller is unavailable",
  });
});


test.skip("the reviewer launch deferral keeps its status line through a tick before the retry is due (#1678 review 2)", async () => {
  const h = harness();
  const { busy } = await reviewFlowEndedOnBusyAccount(h);
  frozenWallClock(h);
  Object.assign(h.ports, { scheduleTick: () => {} });

  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  const deferred = loadPipelines()[0]!.stateDetail;
  expect(deferred).toMatch(/^review flow reviewer launch deferred: account mutation is busy; retry at /);

  /* The fresh round met the lock again before the backoff fell due. */
  busy();
  await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", stateDetail: deferred });
  expect(h.calls.filter((call) => call === "flow-patch:flow-1:retry-round")).toHaveLength(1);
});


test("a retry after an in-activation handshake retry never reuses a client attempt id (#1678 review 2)", async () => {
  const h = harness();
  const created = await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  const clientAttemptIds: string[] = [];
  const scheduled: number[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    clientAttemptIds.push(input.clientAttemptId);
    if (spawnCalls === 1) throw new Error("structured initial message was not acknowledged");
    if (spawnCalls === 2) {
      await onReserved({ launchId: "launch-host-2", conversationId: "conversation_host_2" });
      throw new Error(HOST_UNAVAILABLE);
    }
    return baseSpawn(input, onReserved);
  };
  h.ports.spawnReceipt = (launchId) => launchId === "launch-host-2"
    ? failedReceipt("launch-host-2", "conversation_host_2", HOST_UNAVAILABLE)
    : null;
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: async () => {},
  });

  await tickPipelines([], h.ports);
  expect(spawnCalls).toBe(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ spawnCalls: 2, controllerWait: { rounds: 1 } });
  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);

  expect(spawnCalls).toBe(3);
  expect(new Set(clientAttemptIds).size).toBe(3);
  expect(clientAttemptIds[0]).toBe(`pipeline_${created.id}_plan_1`);
  expect(clientAttemptIds[2]).not.toBe(clientAttemptIds[1]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", launchId: "launch-1" });
});


test("a retry after a restart never reuses the retired launch's client attempt id (#1678 review 2)", async () => {
  const h = harness();
  const created = await create(h.ports);
  await tickPipelines([], h.ports);
  Object.assign(h.ports, { scheduleTick: () => {} });
  interruptedSpawnAttempt(h, h.ports.now());

  await tickPipelines([], h.ports);
  h.advanceWallClock(1_000);
  await tickPipelines([], h.ports);

  const spawnCall = h.calls.find((call) => call.startsWith("spawn:"))!;
  expect(spawnCall).toBeDefined();
  expect(spawnCall).not.toContain(`spawn:pipeline_${created.id}_plan_1:`);
  /* The fixture carries no call count, so the retry starts past every id an
     uncounted engine could have spent: the round the recovery booked plus
     the three calls of one activation (#1678 review 3). */
  expect(spawnCall).toContain("spawn:handshake_retry_4_");
});


test("a spawn call is counted before it is made, so a restart that interrupts it cannot hand its client attempt id to the retry (#1678 review 2)", async () => {
  const h = harness();
  const created = await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  const clientAttemptIds: string[] = [];
  const countedBeforeCall: Array<number | undefined> = [];
  const scheduled: number[] = [];
  let spawnCalls = 0;
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    clientAttemptIds.push(input.clientAttemptId);
    countedBeforeCall.push(loadPipelines()[0]!.runs[0]!.attempts[0]!.spawnCalls);
    if (spawnCalls === 1) throw new Error("structured initial message was not acknowledged");
    if (spawnCalls === 2) {
      await onReserved({ launchId: "launch-host-2", conversationId: "conversation_host_2" });
      throw new Error(HOST_UNAVAILABLE);
    }
    return baseSpawn(input, onReserved);
  };
  h.ports.spawnReceipt = (launchId) => launchId.startsWith("launch-host-")
    ? failedReceipt(launchId, launchId.replace("launch-host-", "conversation_host_"), HOST_UNAVAILABLE)
    : null;
  Object.assign(h.ports, {
    scheduleTick: (delayMs: number) => { scheduled.push(delayMs); },
    sleep: async () => {},
  });

  /* One activation: a handshake retry, then a retired host launch. Each call
     found its own number already persisted when it was made. */
  await tickPipelines([], h.ports);
  expect(spawnCalls).toBe(2);
  expect(countedBeforeCall).toEqual([1, 2]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "pending", spawnCalls: 2, retiredLaunches: [{ launchId: "launch-host-2" }] });

  /* The third call (handshake_retry_2) reserved its launch and the process
     died before the call returned: the persisted attempt is exactly what the
     engine wrote before that call, plus the reservation. */
  advance(scheduled.at(-1)!);
  const interrupted = loadPipelines()[0]!;
  const attempt = interrupted.runs[0]!.attempts[0]!;
  attempt.state = "spawning";
  attempt.launchId = "launch-host-3";
  attempt.conversationId = "conversation_host_3";
  attempt.spawnCalls = 3;
  interrupted.cursor = { stageId: "plan", state: "spawning", input: null, activatedBy: null };
  savePipelines([interrupted]);
  const interruptedId = `handshake_retry_2_pipeline_${created.id}_plan_1`;

  await tickPipelines([], h.ports);
  expect(spawnCalls).toBe(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
    state: "pending",
    launchId: null,
    retiredLaunches: [{ launchId: "launch-host-2" }, { launchId: "launch-host-3" }],
  });

  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  expect(spawnCalls).toBe(3);
  expect(clientAttemptIds[2]).toBe(`handshake_retry_3_pipeline_${created.id}_plan_1`);
  expect(clientAttemptIds).not.toContain(interruptedId);
  expect(new Set([...clientAttemptIds, interruptedId]).size).toBe(4);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", launchId: "launch-1", spawnCalls: 4 });
});


test("a spawn wait persisted by the engine before #1678 retries under an id that engine never spent (#1678 review 3)", async () => {
  const h = harness();
  const { legacy, attempt, spent, clientAttemptIds, advance, scheduled } = await legacySpawnAttempt(h);
  /* Its last activation: a handshake retry, then a reservation that met an
     unavailable runtime host. It booked round one and kept the launch. */
  expect(attempt).toMatchObject({ state: "pending", controllerWait: { rounds: 1 } });
  savePipelines([legacy]);

  /* The deploy lands during a publication handoff, so the first activation
     of this engine only waits; the count it records must keep the bound. */
  Object.assign(h.ports, { structuredDeliveryPublication: () => "rebinding" as const });
  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  expect(clientAttemptIds).toHaveLength(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "pending", controllerWait: { rounds: 2 } });

  Object.assign(h.ports, { structuredDeliveryPublication: () => "ready" as const });
  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  expect(clientAttemptIds).toHaveLength(1);
  expect(spent).not.toContain(clientAttemptIds[0]);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", launchId: "launch-1" });
});


test("a spawn the engine before #1678 left interrupted retries under an id that engine never spent (#1678 review 3)", async () => {
  const h = harness();
  const { legacy, attempt, spent, clientAttemptIds, advance, scheduled } = await legacySpawnAttempt(h);
  /* A restart interrupted its handshake retry after the reservation, before
     any wait was booked; the spawn layer then failed that receipt. */
  attempt.state = "spawning";
  delete attempt.controllerWait;
  legacy.cursor = { stageId: "plan", state: "spawning", input: null, activatedBy: null };
  legacy.stateDetail = null;
  savePipelines([legacy]);

  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "pending", retiredLaunches: [{ launchId: "launch-legacy-2" }] });

  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);
  expect(clientAttemptIds).toHaveLength(1);
  expect(spent).not.toContain(clientAttemptIds[0]);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", launchId: "launch-1" });
});


test("override-stage with expectedStageDigest writes only against the digest the stage still has, whatever another client changed", async () => {
  const { ports } = harness();
  const created = await create(ports);
  const seen = stageDigest(buildStageOf());
  const saved = await patchPipeline(created.id, { action: "override-stage", stageId: "build", "prompt": "Build from {{prev.output}}\n\nMine.", expectedStageDigest: seen }, ports);
  expect(saved.error).toBeUndefined();
  expect(buildStageOf().prompt).toBe("Build from {{prev.output}}\n\nMine.");

  /* Each change another client can make through override-stage moves the digest, and a write against the old one changes nothing. */
  const changes: Array<[string, Parameters<typeof patchPipeline>[1]]> = [
    ["prompt", { action: "override-stage", stageId: "build", "prompt": "Build from {{prev.output}}\n\nTheirs." }],
    ["account", { action: "override-stage", stageId: "build", account: "account-b" }],
    ["role", { action: "override-stage", stageId: "build", role: { roleId: "architect" } }],
    ["runtime", { action: "override-stage", stageId: "build", engine: "claude", model: "opus", effort: "high" }],
  ];
  for (const [label, change] of changes) {
    const before = stageDigest(buildStageOf());
    expect((await patchPipeline(created.id, change, ports)).error).toBeUndefined();
    const theirs = structuredClone(buildStageOf());
    expect(stageDigest(theirs)).not.toBe(before);
    const refused = await patchPipeline(created.id, { action: "override-stage", stageId: "build", "prompt": `Build from {{prev.output}}\n\nMine after ${label}.`, account: null, expectedStageDigest: before }, ports);
    expect({ label, status: refused.status, code: refused.code, field: refused.field }).toEqual({ label, status: 409, code: "STAGE_CHANGED", field: "expectedStageDigest" });
    expect(buildStageOf()).toEqual(theirs);
  }

  /* A write against the digest the stage has now goes through. */
  const current = stageDigest(buildStageOf());
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", "prompt": "Build from {{prev.output}}\n\nMine at last.", expectedStageDigest: current }, ports)).error).toBeUndefined();
  expect(buildStageOf().prompt).toBe("Build from {{prev.output}}\n\nMine at last.");
});


test("a started stage answers a stale digest with STAGE_CHANGED, and an attempt launched before definitions were bound holds its stage until it settles", async () => {
  const { ports } = harness();
  const created = await create(ports);
  const stale = stageDigest(buildStageOf());
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", "prompt": "Build v2" }, ports)).error).toBeUndefined();
  const started = loadPipelines()[0]!;
  started.runs.find((run) => run.stageId === "build")!.attempts.push({
    n: 1, state: "running", effectiveRole: structuredClone(buildStageOf().effectiveRole), launchId: null,
    conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: null, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null,
  });
  savePipelines([started]);
  expect(await patchPipeline(created.id, { action: "override-stage", stageId: "build", "prompt": "x", expectedStageDigest: stale }, ports))
    .toMatchObject({ status: 409, code: "STAGE_CHANGED", field: "expectedStageDigest" });
  const legacy = await patchPipeline(created.id, { action: "override-stage", stageId: "build", "prompt": "x", expectedStageDigest: stageDigest(buildStageOf()) }, ports);
  expect(legacy.status).toBe(409);
  expect(legacy.error).toContain("before attempts recorded their own definition");
  expect(buildStageOf().prompt).toBe("Build v2");
});


test("guard values that are present but malformed, or stated on an action they do not guard, are refused before anything changes", async () => {
  const h = harness();
  const created = await create(h.ports);
  const before = structuredClone(loadPipelines()[0]!);
  const refusals: Array<[Record<string, unknown>, "expectedStageDigest" | "expectedStageId" | "expectedAttempt"]> = [
    [{ action: "override-stage", stageId: "build", "prompt": "x", expectedStageDigest: "abc" }, "expectedStageDigest"],
    [{ action: "override-stage", stageId: "build", "prompt": "x", expectedStageDigest: null }, "expectedStageDigest"],
    [{ action: "override-stage", stageId: "build", "prompt": "x", expectedStageDigest: "g".repeat(64) }, "expectedStageDigest"],
    [{ action: "retry-stage", expectedStageDigest: stageDigest(buildStageOf()) }, "expectedStageDigest"],
    [{ action: "override-stage", stageId: "build", "prompt": "x", expectedStageId: "build" }, "expectedStageId"],
    [{ action: "skip-stage", expectedStageId: "" }, "expectedStageId"],
    [{ action: "retry-stage", expectedStageId: 7 }, "expectedStageId"],
    /* 0 is the stated "no own attempt yet" (see the provisioning-park test); below it, null and fractions are malformed. */
    [{ action: "retry-stage", expectedStageId: "plan", expectedAttempt: -1 }, "expectedAttempt"],
    [{ action: "retry-stage", expectedStageId: "plan", expectedAttempt: null }, "expectedAttempt"],
    [{ action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1.5 }, "expectedAttempt"],
    [{ action: "skip-stage", expectedStageId: "plan", expectedAttempt: "1" }, "expectedAttempt"],
    [{ action: "retry-stage", expectedAttempt: 1 }, "expectedAttempt"],
    [{ action: "pause", expectedAttempt: 1 }, "expectedAttempt"],
  ];
  for (const [request, field] of refusals) {
    const refused = await patchPipeline(created.id, request as never, h.ports);
    expect({ request, status: refused.status, field: refused.field, code: refused.code }).toEqual({ request, status: 400, field, code: undefined });
  }
  expect(loadPipelines()[0]).toEqual(before);
  expect(h.calls.some((call) => call.includes("reset --hard"))).toBe(false);
});


test("retry-stage with the stage and attempt the caller saw retries it; the same expectations again are refused before any effect, and one new attempt starts", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", cursor: { stageId: "plan" } });

  const first = await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, h.ports);
  expect(first.error).toBeUndefined();
  const callsAfterFirst = h.calls.length;
  const second = await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, h.ports);
  expect({ status: second.status, code: second.code, field: second.field }).toEqual({ status: 409, code: "STAGE_CHANGED", field: "expectedStageId" });
  expect(h.calls.length).toBe(callsAfterFirst);

  await tickPipelines([], h.ports);
  expect(h.calls.filter((call) => call.startsWith(`spawn:pipeline_${pipeline.id}_plan_`))).toEqual([
    `spawn:pipeline_${pipeline.id}_plan_1:parent=/codex/creator.jsonl:supersedes=none`,
    `spawn:pipeline_${pipeline.id}_plan_2:parent=/codex/creator.jsonl:supersedes=conversation_stage_1`,
  ]);

  /* Attempt 2 parks too: a retry that still names attempt 1 is refused, one naming attempt 2 retries. */
  await tickPipelines([h.finish("/codex/stage-2.jsonl", "fail", "still blocked")], h.ports);
  const callsBeforeStale = h.calls.length;
  const stale = await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, h.ports);
  expect({ status: stale.status, code: stale.code, field: stale.field }).toEqual({ status: 409, code: "STAGE_CHANGED", field: "expectedAttempt" });
  expect(h.calls.length).toBe(callsBeforeStale);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect((await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 2 }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(h.calls).toContain(`spawn:pipeline_${pipeline.id}_plan_3:parent=/codex/creator.jsonl:supersedes=conversation_stage_2`);
});


test("skip-stage naming another stage or attempt is refused before worktree access; the named attempt is skipped", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "needs_decision", "operator choice")], h.ports);
  const resets = () => h.calls.filter((call) => call.includes("reset --hard") || call.includes("clean -fd")).length;

  const otherStage = await patchPipeline(pipeline.id, { action: "skip-stage", expectedStageId: "build" }, h.ports);
  expect({ status: otherStage.status, code: otherStage.code, field: otherStage.field }).toEqual({ status: 409, code: "STAGE_CHANGED", field: "expectedStageId" });
  const otherAttempt = await patchPipeline(pipeline.id, { action: "skip-stage", expectedStageId: "plan", expectedAttempt: 2 }, h.ports);
  expect({ status: otherAttempt.status, code: otherAttempt.code, field: otherAttempt.field }).toEqual({ status: 409, code: "STAGE_CHANGED", field: "expectedAttempt" });
  expect(resets()).toBe(0);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", cursor: { stageId: "plan" } });

  const skipped = await patchPipeline(pipeline.id, { action: "skip-stage", expectedStageId: "plan", expectedAttempt: 1 }, h.ports);
  expect(skipped.pipeline?.cursor?.stageId).toBe("build");
  expect(resets()).toBe(0);
  /* The pipeline no longer waits on plan: the same skip again changes nothing. */
  const again = await patchPipeline(pipeline.id, { action: "skip-stage", expectedStageId: "plan", expectedAttempt: 1 }, h.ports);
  expect(again.code).toBe("STAGE_CHANGED");
  expect(resets()).toBe(0);
});


test("the attempt retry expects is the stage's latest own attempt, never a lineage-adopted one", async () => {
  const h = harness();
  const created = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "retry me")], h.ports);
  const pipeline = loadPipelines()[0]!;
  adoptAttempt(pipeline, "plan", {
    sourceConversationId: "conversation_stage_1", launchId: "launch-historical", conversationId: "conversation_historical",
    sessionId: "session-historical", agentPath: "/codex/historical.jsonl", paneId: null, startedAt: "1970-01-01T00:12:00.000Z",
  });
  savePipelines([pipeline]);
  expect(loadPipelines()[0]!.runs[0]!.attempts.map((attempt) => [attempt.n, attempt.historical ?? false])).toEqual([[1, false], [2, true]]);

  const onHelper = await patchPipeline(created.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 2 }, h.ports);
  expect({ code: onHelper.code, field: onHelper.field }).toEqual({ code: "STAGE_CHANGED", field: "expectedAttempt" });
  expect((await patchPipeline(created.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, h.ports)).error).toBeUndefined();
});


test("a launch-receipt retry keeps its meaning with the guard stated beside it", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  const firstAttempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  h.ports.spawnReceipt = (candidate) => candidate === firstAttempt.launchId ? {
    state: "failed", launchId: firstAttempt.launchId!, conversationId: firstAttempt.conversationId!,
    sessionId: firstAttempt.sessionId, "transcript": firstAttempt.agentPath, paneId: firstAttempt.paneId,
  } : null;
  /* A receipt for a different launch is still refused as before, guard or not. */
  expect(await patchPipeline(pipeline.id, { action: "retry-stage", stageId: "plan", launchId: "launch-other", expectedStageId: "plan", expectedAttempt: 1 }, h.ports))
    .toEqual({ error: "the clicked launch is no longer the current failed attempt", status: 409 });
  const retried = await patchPipeline(pipeline.id, { action: "retry-stage", stageId: "plan", launchId: firstAttempt.launchId!, expectedStageId: "plan", expectedAttempt: 1 }, h.ports);
  expect(retried.error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(h.calls).toContain(`spawn:pipeline_${pipeline.id}_plan_2:parent=/codex/creator.jsonl:supersedes=conversation_stage_1`);
});


test("the digest follows the stored role snapshot: a registry edit no override applied changes nothing, and an override re-resolving the same role moves it by the scaffold alone", async () => {
  const h = harness();
  const created = await create(h.ports);
  const before = structuredClone(buildStageOf());
  const lookup = h.ports.roleLookup!;
  h.ports.roleLookup = (roleId) => {
    const resolved = lookup(roleId);
    return roleId === "builder" && resolved ? { ...resolved, promptScaffold: "Builder guidance, revised" } : resolved;
  };
  /* The registry changed; the stored stage, and what its first attempt would snapshot, did not. */
  expect(stageDigest(buildStageOf())).toBe(stageDigest(before));
  const unchanged = await patchPipeline(created.id, { action: "override-stage", stageId: "build", "prompt": "Build from {{prev.output}}\n\nMine.", expectedStageDigest: stageDigest(before) }, h.ports);
  expect(unchanged.error).toBeUndefined();
  expect(buildStageOf().effectiveRole.promptScaffold).toBe(before.effectiveRole.promptScaffold);

  /* Another client re-applies the same role: only the stored scaffold moves, and the digest with it. */
  const seen = stageDigest(buildStageOf());
  expect((await patchPipeline(created.id, { action: "override-stage", stageId: "build", role: { roleId: "builder" } }, h.ports)).error).toBeUndefined();
  const theirs = structuredClone(buildStageOf());
  expect({ engine: theirs.effectiveRole.engine, model: theirs.effectiveRole.model, effort: theirs.effectiveRole.effort, access: theirs.effectiveRole.access, prompt: theirs.prompt })
    .toEqual({ engine: before.effectiveRole.engine, model: before.effectiveRole.model, effort: before.effectiveRole.effort, access: before.effectiveRole.access, prompt: "Build from {{prev.output}}\n\nMine." });
  expect(theirs.effectiveRole.promptScaffold).toBe("Builder guidance, revised");
  expect(stageDigest(theirs)).not.toBe(seen);
  const refused = await patchPipeline(created.id, { action: "override-stage", stageId: "build", "prompt": "Build from {{prev.output}}\n\nMine, again.", expectedStageDigest: seen }, h.ports);
  expect({ status: refused.status, code: refused.code, field: refused.field }).toEqual({ status: 409, code: "STAGE_CHANGED", field: "expectedStageDigest" });
  expect(buildStageOf()).toEqual(theirs);
});


test("expectedAttempt 0 states a stage with no attempt of its own: it retries a provisioning park, and is refused once attempt 1 exists", async () => {
  const h = harness();
  savePipelines([]);
  const baseExec = h.ports.exec;
  let failWorktreeAdd = true;
  h.ports.exec = (command, args, cwd) => {
    if (args[0] === "worktree" && failWorktreeAdd) return { code: 128, stdout: "", stderr: "worktree unavailable" };
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && cwd?.includes("-pipeline-")) {
      return failWorktreeAdd ? { code: 128, stdout: "", stderr: "missing worktree" } : { code: 0, stdout: `${loadPipelines()[0]!.branch}\n`, stderr: "" };
    }
    return baseExec(command, args, cwd);
  };
  const created = await createPipelineFromRequest({ task: "Recover provision", repoDir: "/repo", stages: RUN_STAGES as never }, h.ports);
  const id = created.pipeline!.id;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", cursor: { stageId: "plan" } });
  expect(loadPipelines()[0]!.runs.find((run) => run.stageId === "plan")!.attempts).toHaveLength(0);

  /* Naming an attempt that does not exist is refused before anything is reset. */
  const resets = () => h.calls.filter((call) => call.includes("reset --hard") || call.includes("clean -fd")).length;
  const named = await patchPipeline(id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, h.ports);
  expect({ status: named.status, code: named.code, field: named.field }).toEqual({ status: 409, code: "STAGE_CHANGED", field: "expectedAttempt" });
  expect(loadPipelines()[0]!.state).toBe("needs_decision");

  failWorktreeAdd = false;
  const none = await patchPipeline(id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 0 }, h.ports);
  expect(none.pipeline?.state).toBe("provisioning");
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "fail", "blocked")], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", cursor: { stageId: "plan" } });
  expect(loadPipelines()[0]!.runs.find((run) => run.stageId === "plan")!.attempts.map((attempt) => attempt.n)).toEqual([1]);

  /* A menu that still shows "no attempt yet" is stale now. */
  const resetsBefore = resets();
  const stale = await patchPipeline(id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 0 }, h.ports);
  expect({ status: stale.status, code: stale.code, field: stale.field }).toEqual({ status: 409, code: "STAGE_CHANGED", field: "expectedAttempt" });
  expect(resets()).toBe(resetsBefore);
  expect((await patchPipeline(id, { action: "skip-stage", expectedStageId: "plan", expectedAttempt: 0 }, h.ports)).code).toBe("STAGE_CHANGED");
  expect(resets()).toBe(resetsBefore);
  expect((await patchPipeline(id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, h.ports)).error).toBeUndefined();
});


/* Engine scope only (#1695 K6b): the conversation's path, host availability and the successor's turns are
   given to the engine here, and no registry migration, commit or delivery runs. The integration, a real
   switch whose successor turn is started by the message held for it, needs #1709 (K6c). */
test("the engine keeps a switched stage's attempt running across an unavailable host inside the grace, follows its new path, and settles on the successor's verdict without the fail edge (#1695 K6b)", async () => {
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build", next: null, onFail: { to: "recover", maxRounds: 1 } },
    { id: "recover", kind: "run", role: { roleId: "builder" }, prompt: "Recover {{prev.output}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  makeStructuredAttempt();
  pinStageHead(h);
  const stageConversation = loadPipelines()[0]!.runs[0]!.attempts[0]!.conversationId!;
  const sourcePath = "/codex/stage-1.jsonl";
  const successorPath = "/codex/accounts/account-b/stage-1.jsonl";

  /* The switch waits for a turn boundary: the source's turn ends without a verdict, and its host is
     released while the successor starts, well inside the grace a dead host gets. */
  h.durableTurns.set(sourcePath, { turn: "terminal", message: { text: "Halfway through; continuing on the other account.", ts: 5_000_000 } });
  h.setConversationActive(false);
  const releasedAt = h.ports.now();
  h.ports.conversationHostUnavailableSince = async () => releasedAt;
  h.advanceWallClock(60_000);
  await tickPipelines([entry(sourcePath)], h.ports);
  let current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts[0]!.state).toBe("running");
  expect(current.runs.find((run) => run.stageId === "recover")?.attempts ?? []).toEqual([]);

  /* The switch commits: the conversation continues under its successor generation, hosted and working. */
  h.ports.pathForConversation = (id) => (id === stageConversation ? successorPath : null);
  h.ports.conversationHostUnavailableSince = async () => null;
  h.setConversationActive(true);
  h.durableTurns.set(successorPath, { turn: "busy", message: null });
  h.advanceWallClock(5 * 60_000);
  await tickPipelines([{ ...entry(successorPath), activity: "live" }], h.ports);
  current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "running", agentPath: successorPath });

  /* The successor's turn ends with the stage's verdict. */
  h.durableTurns.set(successorPath, { turn: "terminal", message: { text: PASS_TEXT, ts: 5_600_000 } });
  h.setConversationActive(false);
  await tickPipelines([entry(successorPath)], h.ports);
  await tickPipelines([entry(successorPath)], h.ports);

  current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "passed", agentPath: successorPath, conversationId: stageConversation, verdict: { status: "pass" } });
  expect(current.runs.find((run) => run.stageId === "recover")?.attempts ?? []).toEqual([]);
  expect(current.cursor?.activatedBy?.edge ?? null).not.toBe("fail");
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
});


test.skip("a COMMENT review flow routes only on findings the review itself reported (#1785)", async () => {
  /* The reconcile path builds its parent stage's verdict from the round
     artifact, and appends a placeholder line when the round reported no
     finding of its own. That placeholder describes nothing to fix, so it must
     never make a needs_decision routable; a round with a real finding does. */
  const placeholder = harness();
  await parkedReviewStage(placeholder);
  const commentWithoutFindings = flowWithFindings(placeholder, "COMMENT", "The reviewer left a note.\n");
  const placeholderVerdict = terminalFlowStageVerdict(commentWithoutFindings)!;
  expect(placeholderVerdict.verdict.status).toBe("needs_decision");
  expect(placeholderVerdict.verdict.findings!.some((finding) => finding.includes("open the round artifact"))).toBe(true);
  expect(placeholderVerdict.syntheticFindings).toBe(true);
  expect(verdictRoutesAsFail(placeholderVerdict)).toBe(false);

  /* The reconcile path settles the parked stage on that verdict, and it parks. */
  await tickPipelines([entry("/codex/reviewer.jsonl")], placeholder.ports);
  await tickPipelines([entry("/codex/reviewer.jsonl")], placeholder.ports);
  const settled = loadPipelines()[0]!;
  expect(settled.state).toBe("needs_decision");
  const settledAttempt = settled.runs[1]!.attempts.at(-1)!;
  expect(settledAttempt.state).toBe("needs_decision");
  expect(settledAttempt.decisionRequested).toBeUndefined();

  const real = harness();
  await parkedReviewStage(real);
  const commentWithFindings = flowWithFindings(real, "COMMENT", REVIEW_FINDING_BLOCK);
  const realVerdict = terminalFlowStageVerdict(commentWithFindings)!;
  expect(realVerdict.verdict.status).toBe("needs_decision");
  expect(realVerdict.verdict.findings!.some((finding) => finding.includes("open the round artifact"))).toBe(false);
  expect(realVerdict.syntheticFindings).toBeUndefined();
  expect(verdictRoutesAsFail(realVerdict)).toBe(true);

  /* A REQUEST_CHANGES flow is a fail and routes on its status alone, whether or
     not the round wrote findings of its own — exactly as it did before. */
  const changes = harness();
  await parkedReviewStage(changes);
  const changesVerdict = terminalFlowStageVerdict(flowWithFindings(changes, "REQUEST_CHANGES", "Repair the host claim.\n"))!;
  expect(changesVerdict.verdict.status).toBe("fail");
  expect(changesVerdict.syntheticFindings).toBe(true);
  expect(verdictRoutesAsFail(changesVerdict)).toBe(true);
});


test.each(["timeout", "503", "reset", "busy"] as const)("staged publication %s keeps the same launch waiting for recovery", async (mode) => {
  const f = await stagedRecoveryHarness(mode);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", stateDetail: expect.stringContaining("waiting for the runtime host") });
  expect(f.registry.readOnlySnapshot().receipts[f.launchId()]?.state).toBe("path-pending");
  expect(f.starts()).toBe(1);
  expect(f.messages()).toBe(0);
  const original = f.attempt().launchId;
  await f.wake();
  expect(f.messages()).toBe(0);
  await f.wake();
  await f.wake();
  expect(f.attempt()).toMatchObject({ n: 1, state: "running", launchId: original, spawnCalls: 1 });
  expect(loadPipelines()[0]!.stateDetail).toBeNull();
  expect(f.registry.readOnlySnapshot().receipts[original!]?.state).toBe("completed");
  expect(f.stages).toHaveBeenCalledTimes(1);
  expect(f.starts()).toBe(1);
  expect(f.messages()).toBe(1);
  expect(f.attempt().retiredLaunches).toBeUndefined();
});


test.each(["uncertain", "turn-started"] as const)("%s staged delivery resolves by original operation lookup without sending again", async (mode) => {
  const f = await stagedRecoveryHarness(mode);
  await tickPipelines([], f.h.ports);
  f.failStatus(2);
  await f.wake();
  await f.wake();
  await f.wake();
  expect(f.attempt().state).toBe("running");
  expect(f.registry.readOnlySnapshot().receipts[f.launchId()]?.state).toBe("completed");
  expect(new Set(f.lookups)).toEqual(new Set([f.launchId(), `spawn_message_${f.launchId()}`]));
  expect(f.stages).toHaveBeenCalledTimes(1);
  expect(f.messages()).toBe(1);
});


test("an uncertain send missing from lookup exhausts its budget without another first message", async () => {
  const f = await stagedRecoveryHarness("absent");
  await tickPipelines([], f.h.ports);
  await f.wake();
  expect(f.attempt().state).toBe("spawning");
  f.advance(10 * 60_000);
  await f.wake();
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: expect.stringContaining("original launch and first-message operation inspected") });
  expect(f.attempt().launchId).toBe(f.launchId());
  expect(f.messages()).toBe(1);
  expect(f.starts()).toBe(1);
});


test("a staged launch whose agent is working is adopted when spawn recovery spends its budget, never parked", async () => {
  const f = await aliveStagedLaunch();
  f.advance(10 * 60_000);
  f.working();
  await f.wake();
  const pipeline = loadPipelines()[0]!;
  expect(pipeline).toMatchObject({ state: "running", stateDetail: null, cursor: { stageId: "build", state: "running" } });
  expect(f.attempt()).toMatchObject({ n: 1, state: "running", launchId: f.launchId(), agentPath: f.transcript, error: null });
  expect(f.attempt().controllerWait).toBeUndefined();
  expect(f.messages()).toBe(1);
  expect(f.starts()).toBe(1);
});
