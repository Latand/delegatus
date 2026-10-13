import { expect, spyOn, test, crypto, spawn, fs, os, path, engineModule, IDLE_TURN_QUIET_MS, interruptedTurnRecoveryParkDetail, defaultPipelinePorts, reconcileEmbeddedReviewFlows, tickPipelines, AgentRegistry, setAgentRegistryForTests, newRound, createPipelineFromRequest, loadPipelines, savePipelines, pipelineIdentity, durableStageTurnEvidence, patchPipeline, closeAndDrain, RUN_STAGES, entry, harness, create, withRuntimeSnapshot, HISTORICAL_VERDICT_MISS, PASS_TEXT, makeStructuredAttempt, pinStageHead, BUDGET_STAGES, movingHeadHarness, driveWithController, stagedRecoveryHarness, activationDrainFixture, reserveActivationOnly, expectPipelineLeaseAbsent, frozenSurvivorStartup, restartCutStage, cutByRestart, idleStageHostFixture, runtimeReleaseOf, SILENT_RUN, attemptThatWorkedOnAfterRestart, stageWhoseStopMovesTheTranscript } from "./engine.fixture";
import type { Flow, BoardTask, PipelinePorts } from "./engine.fixture";


test("activation drain preserves uncertain read-write delivery and the staged recovery budget", async () => {
  const f = await stagedRecoveryHarness("uncertain");
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = "1";
  try {
    await tickPipelines([], f.h.ports);
    for (let i = 0; i < 4; i++) await f.wake();
    expect(f.starts()).toBe(1);
    expect(f.messages()).toBe(1);
    expect(f.attempt()).toMatchObject({ n: 1, launchId: f.launchId(), spawnCalls: 1, state: "running" });
  } finally { delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; }
});

test("activation drain close custody survives a failed teardown and retries after restart", async () => {
  const f = await activationDrainFixture(true);
  f.h.ports.stageHostResident = async () => true;
  f.h.ports.stopStageAgent = async () => ({ outcome: "failed", error: "fixture host still running" });
  try {
    await patchPipeline(f.id, { action: "close" }, f.h.ports);
    f.release(); await f.ticking;
    expect(loadPipelines()[0]).toMatchObject({ state: "closed", closeReport: { stillRunning: [{ error: "fixture host still running" }] } });
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation).toBeUndefined();
    f.h.ports.stopStageAgent = async () => ({ outcome: "stopped" });
    await patchPipeline(f.id, { action: "close" }, f.h.ports);
    await engineModule.drainStageActivations(f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("closed");
    expect(loadPipelines()[0]!.activationCloseRequested).toBeUndefined();
  } finally { f.release(); await f.ticking; delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; }
});

test("activation drain excludes another process while the reserved owner is alive", async () => {
  const f = await activationDrainFixture();
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      const { drainStageActivations, defaultPipelinePorts } = await import("./src/lib/pipelines/engine.ts");
      await drainStageActivations({ ...defaultPipelinePorts(), structuredDeliveryPublication: () => "ready",
        spawnAgent: async () => { process.exit(3); },
      });
    `], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    f.release(); await f.ticking;
    expect(f.calls()).toBe(1);
    expect(f.launches()).toBe(1);
  } finally { f.release(); await f.ticking; delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; }
});

test("activation drain recovers its living process claim after final reacquisition fails", async () => {
  const f = await activationDrainFixture(true);
  const store = await import("./store");
  const mutate = store.withPipelineMutation;
  let fail = true;
  const broken = spyOn(store, "withPipelineMutation").mockImplementation((...args) => {
    if (fail) { fail = false; return Promise.reject(new Error("fixture final mutation busy")); }
    return mutate(...args);
  });
  try {
    f.release();
    await expect(f.ticking).rejects.toThrow("fixture final mutation busy");
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation?.phase).toBe("dispatching");
    f.h.ports.spawnReceipt = () => ({ state: "completed", launchId: "activation-launch", conversationId: "conversation_activation",
      sessionId: "activation-session", transcript: "/codex/activation.jsonl", paneId: null });
    await engineModule.drainStageActivations(f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ launchId: "activation-launch", state: "running", spawnCalls: 1 });
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation).toBeUndefined();
    expect(f.calls()).toBe(1);
  } finally { broken.mockRestore(); f.release(); await f.ticking.catch(() => {}); delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; }
});

test("activation drain settled checkpoint survives a crash without spending another retry", async () => {
  const h = await reserveActivationOnly();
  const pipelines = loadPipelines();
  const pipeline = pipelines[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  attempt.state = "pending";
  attempt.spawnCalls = 1;
  attempt.controllerWait = { startedAt: h.ports.now(), retryAfter: new Date(Date.parse(h.ports.now()) + 60_000).toISOString(), rounds: 1 } as typeof attempt.controllerWait;
  attempt.activation!.phase = "settled";
  // The recorded process has exited; no live process is signalled by this test.
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "pipe", stderr: "pipe" });
  await child.exited;
  attempt.activation!.owner = { pid: child.pid, startIdentity: "exited-fixture", bootEpoch: "fixture" };
  pipeline.cursor!.state = "pending";
  savePipelines(pipelines);
  const before = structuredClone(attempt.controllerWait);
  let calls = 0;
  h.ports.spawnAgent = async () => { calls++; throw new Error("retry is not due"); };
  await engineModule.drainStageActivations(h.ports);
  const recovered = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(recovered.activation).toBeUndefined();
  expect(recovered.controllerWait).toEqual(before);
  expect(recovered.spawnCalls).toBe(1);
  expect(recovered.state).toBe("pending");
  expect(calls).toBe(0);
});

test("activation drain keeps a settled staged launch across a crash and pause", async () => {
  const f = await stagedRecoveryHarness();
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = "1";
  const store = await import("./store");
  const mutate = store.withPipelineMutation;
  const broken = spyOn(store, "withPipelineMutation").mockImplementation((...args) => {
    if (loadPipelines()[0]?.runs[0]?.attempts[0]?.activation?.phase === "settled") {
      return Promise.reject(new Error("fixture crash after settled checkpoint"));
    }
    return mutate(...args);
  });
  try {
    await expect(tickPipelines([], f.h.ports)).rejects.toThrow("fixture crash after settled checkpoint");
    broken.mockRestore();
    expect(f.attempt().activation?.phase).toBe("settled");
    const id = loadPipelines()[0]!.id;
    await patchPipeline(id, { action: "pause" }, f.h.ports);
    await engineModule.drainStageActivations(f.h.ports);
    expect(f.attempt().state).toBe("spawning");
    expect(f.attempt().launchId).toBe(f.launchId());
    expect(loadPipelines()[0]!.state).toBe("paused");
    await patchPipeline(id, { action: "resume" }, f.h.ports);
    for (let i = 0; i < 4; i++) await f.wake();
    expect(f.starts()).toBe(1);
    expect(f.messages()).toBe(1);
    expect(f.attempt()).toMatchObject({ n: 1, state: "running", launchId: f.launchId(), spawnCalls: 1 });
  } finally { broken.mockRestore(); delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; }
});


test.each([false, true])("close drain answers before a five second stop and releases the lease (activation: %s)", async (enabled) => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const retry = structuredClone(loadPipelines()[0]!);
  retry.id = "pipeline-close-unrelated";
  Object.assign(retry, pipelineIdentity(retry.id, retry.task, retry.repoDir));
  retry.state = "needs_decision";
  retry.delivery = undefined;
  retry.runs.forEach((run) => { run.attempts = []; });
  retry.cursor!.state = "pending";
  savePipelines([...loadPipelines(), retry]);
  const oldDrain = process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = enabled ? "1" : "0";
  let stops = 0;
  let entered!: () => void;
  let finishStop!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const stopHeld = new Promise<void>((resolve) => { finishStop = resolve; });
  /* The stop stands for a five-second one: it does not return until the test
     lets it, and it records how many pipeline leases are held while it runs. */
  const leasesHeldDuringStop: number[] = [];
  h.ports.stopStageAgent = async () => {
    stops++;
    leasesHeldDuringStop.push(starts.size);
    entered();
    await stopHeld;
    return { outcome: "stopped" };
  };
  const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
  type LeaseProbe = { options: { collection: string }; filename: string; acquireLease(wait?: number): Promise<string>; releaseLease(token: string): Promise<void> };
  const prototype = SqliteStateCollection.prototype as unknown as LeaseProbe;
  const acquire = prototype.acquireLease;
  const relinquish = prototype.releaseLease;
  const starts = new Map<string, number>();
  const holds: number[] = [];
  const acquired = spyOn(prototype, "acquireLease").mockImplementation(async function(this: LeaseProbe, wait) {
    const token = await acquire.call(this, wait);
    if (this.options.collection === "pipelines") starts.set(token, performance.now());
    return token;
  });
  const released = spyOn(prototype, "releaseLease").mockImplementation(async function(this: LeaseProbe, token) {
    await relinquish.call(this, token);
    const start = starts.get(token);
    if (start !== undefined) { holds.push(performance.now() - start); starts.delete(token); }
  });
  let draining: Promise<void> | undefined;
  try {
    const begin = performance.now();
    const closed = await patchPipeline(pipeline.id, { action: "close" }, h.ports);
    const elapsed = performance.now() - begin;
    console.log(`close activation=${enabled}: answer=${elapsed.toFixed(1)}ms, max lease=${Math.max(...holds).toFixed(1)}ms`);
    // Answered before the stop: no stop has even been asked for yet.
    expect(closed.pipeline?.state).toBe("closed");
    expect(closed.close?.pending).toHaveLength(1);
    expect(stops).toBe(0);
    draining = engineModule.drainStageActivations(h.ports);
    await started;
    const again = await patchPipeline(pipeline.id, { action: "close" }, h.ports);
    expect(again.close?.pending).toEqual(closed.close?.pending);
    expect((await createPipelineFromRequest({ task: "Unrelated draft", repoDir: "/repo", autoStart: false, stages: [...RUN_STAGES] }, h.ports)).pipeline).toBeDefined();
    expect((await patchPipeline(retry.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
    expect((await patchPipeline(pipeline.id, { action: "delete" }, h.ports)).status).toBe(409);
    finishStop();
    await engineModule.drainStageActivations(h.ports);
    expect(stops).toBe(1);
    await draining;
    const final = loadPipelines().find((item) => item.id === pipeline.id)!;
    expect(final.closeReport?.pending).toEqual([]);
    expect(final.closeReport?.stopped).toHaveLength(1);
    expect((await patchPipeline(pipeline.id, { action: "delete" }, h.ports)).error).toBeUndefined();
    await patchPipeline(pipeline.id, { action: "close" }, h.ports);
    await engineModule.drainStageActivations(h.ports);
    expect(stops).toBe(1);
    console.log(`close activation=${enabled}: final max lease=${Math.max(...holds).toFixed(1)}ms across ${holds.length} holds`);
    /* The lease is released before the stop, never held across it: the calls
       above ran while the stop was still in flight, and it saw no lease. */
    expect(leasesHeldDuringStop).toEqual([0]);
  } finally {
    finishStop();
    await draining;
    acquired.mockRestore(); released.mockRestore();
    if (oldDrain === undefined) delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; else process.env.LLV_PIPELINE_ACTIVATION_DRAIN = oldDrain;
  }
}, 15_000);


test.each([false, true])("close drain resumes after the closing process exits before teardown (activation: %s)", async (enabled) => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const child = Bun.spawn([process.execPath, "-e", `
    const { patchPipeline } = await import("./src/lib/pipelines/engine.ts");
    const answer = await patchPipeline(${JSON.stringify(pipeline.id)}, { action: "close" });
    if (answer.pipeline?.state !== "closed" || answer.close?.status !== "pending") process.exit(2);
    process.exit(0);
  `], { cwd: process.cwd(), env: { ...process.env, LLV_PIPELINE_ACTIVATION_DRAIN: enabled ? "1" : "0" }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect(loadPipelines()[0]!.closeReport?.pending).toHaveLength(1);
  let stops = 0;
  h.ports.stopStageAgent = async (target) => {
    expect(target.conversationId).toBe("conversation_stage_1");
    stops++;
    return { outcome: "stopped" };
  };
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(stops).toBe(1);
  expect(loadPipelines()[0]!.closeReport).toMatchObject({ status: "settled", pending: [], stopped: [{ conversationId: "conversation_stage_1" }] });
});

test("close drain recovers a dead executor and skips already checkpointed hosts", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const stored = loadPipelines();
  const first = stored[0]!.runs[0]!.attempts[0]!;
  stored[0]!.runs[1]!.attempts.push({ ...structuredClone(first), conversationId: "conversation_second", agentPath: "/codex/second.jsonl", paneId: null });
  savePipelines(stored);
  await patchPipeline(pipeline.id, { action: "close" }, h.ports);
  const child = Bun.spawn([process.execPath, "-e", `
    const { defaultPipelinePorts, drainStageActivations } = await import("./src/lib/pipelines/engine.ts");
    let count = 0;
    await drainStageActivations({ ...defaultPipelinePorts(), stopStageAgent: async () => {
      if (++count === 2) process.exit(0);
      return { outcome: "stopped" };
    } });
    process.exit(2);
  `], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect(loadPipelines()[0]!.closeTeardown).toMatchObject({ phase: "running", owner: { pid: child.pid } });
  expect(loadPipelines()[0]!.closeReport?.stopped).toHaveLength(1);
  const stops: string[] = [];
  h.ports.stopStageAgent = async (target) => { stops.push(target.conversationId!); return { outcome: "stopped" }; };
  await engineModule.drainStageActivations(h.ports);
  await engineModule.drainStageActivations(h.ports);
  expect(stops).toEqual(["conversation_second"]);
  expect(loadPipelines()[0]!.closeReport?.stopped).toHaveLength(2);
});


test("close drain keeps a slow embedded flow and worktree inspection outside the lease", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const records = loadPipelines();
  records[0]!.runs[0]!.attempts[0]!.flowId = "close-flow";
  savePipelines(records);
  h.ports.stopStageAgent = async () => ({ outcome: "stopped" });
  h.ports.getFlow = () => ({ id: "close-flow", state: "reviewing" } as Flow);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  h.ports.closeFlow = async () => { expectPipelineLeaseAbsent(); entered(); await gate; return { stoppedReviewer: { round: 1 } } as never; };
  const exec = h.ports.exec;
  h.ports.exec = async (command, args, cwd) => { expectPipelineLeaseAbsent(); return (await exec(command, args, cwd)); };
  const accepted = await patchPipeline(pipeline.id, { action: "close" }, h.ports);
  expect(accepted.close?.status).toBe("pending");
  const draining = engineModule.drainStageActivations(h.ports);
  await started;
  try {
    expect((await patchPipeline(pipeline.id, { action: "delete" }, h.ports)).status).toBe(409);
    expect(loadPipelines()[0]!.closeReport).toMatchObject({ pending: [], status: "pending", stopped: [{ stageId: "plan" }] });
    expect(loadPipelines()[0]!.closeTeardown?.flow?.id).toBe("close-flow");
  } finally { release(); await draining; }
  expect(loadPipelines()[0]!.closeReport).toMatchObject({ status: "settled", reviewers: [{ flowId: "close-flow", round: 1 }] });
});


test.each([false, true])("retrying a failed flow close deduplicates hosts and preserves confirmed stops (unconfirmed: %s)", async (unconfirmed) => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const records = loadPipelines();
  records[0]!.runs[0]!.attempts[0]!.flowId = "close-flow-retry";
  savePipelines(records);
  let stops = 0;
  let closes = 0;
  h.ports.stopStageAgent = async () => ++stops === 1 && unconfirmed
    ? { outcome: "unconfirmed", operationId: "close-queued", detail: "termination pending" } : { outcome: "stopped" };
  h.ports.getFlow = () => ({ id: "close-flow-retry", state: "reviewing" } as Flow);
  h.ports.closeFlow = async () => ++closes === 1 ? { error: "reviewer is still running" } : {};
  await closeAndDrain(pipeline.id, { action: "close" }, h.ports);
  expect(loadPipelines()[0]!.closeReport?.stillRunning).toHaveLength(1);
  const retried = await closeAndDrain(pipeline.id, { action: "close" }, h.ports);
  expect(retried.close).toMatchObject({ status: "settled", pending: [], stillRunning: [] });
  expect(stops).toBe(unconfirmed ? 2 : 1);
  expect(closes).toBe(2);
});


test("close checkpoints a frozen host after its conversation path rebinds during stop", async () => {
  const h = harness();
  const pipeline = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await patchPipeline(pipeline.id, { action: "close" }, h.ports);
  let stops = 0;
  h.ports.stopStageAgent = async (target) => {
    stops++;
    expect(target.agentPath).toBe("/codex/stage-1.jsonl");
    const { withPipelineMutation } = await import("./store");
    await withPipelineMutation((pipelines, persist) => {
      const current = pipelines.find((item) => item.id === pipeline.id)!;
      current.runs[0]!.attempts[0]!.agentPath = "/codex/rebound-stage.jsonl";
      current.runs[0]!.attempts[0]!.paneId = "%new";
      persist([current]);
    });
    return { outcome: "stopped" };
  };
  await engineModule.drainStageActivations(h.ports);
  await engineModule.drainStageActivations(h.ports);
  expect(stops).toBe(1);
  expect(loadPipelines()[0]!.closeReport).toMatchObject({ status: "settled", pending: [], stopped: [{ agentPath: "/codex/stage-1.jsonl" }] });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ agentPath: "/codex/rebound-stage.jsonl", paneId: "%new" });
});

for (const enabled of [false, true]) {
  test.each(["host-stop", "flow-close", "settled"] as const)(`late adoption retains close custody at %s (activation: ${enabled})`, async (seam) => {
    const h = harness();
    const pipeline = await create(h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const records = loadPipelines();
    const source = records[0]!.runs[0]!.attempts[0]!;
    if (seam === "flow-close") source.flowId = "late-close-flow";
    savePipelines(records);
    const childRef = { launchId: "late-child-launch", conversationId: "conversation_late_child",
      sessionId: "late-child-session", agentPath: "/codex/late-child.jsonl", paneId: "%late-child", startedAt: h.ports.now() };
    const oldDrain = process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
    process.env.LLV_PIPELINE_ACTIVATION_DRAIN = enabled ? "1" : "0";
    const stops: string[] = [];
    const adopt = async () => {
      expectPipelineLeaseAbsent();
      // A separate process commits adoption and exits before the controller
      // resumes: recovery must read the obligation from the durable store.
      const child = Bun.spawn([process.execPath, "-e", `
        const { adoptPipelineAttemptFromSource } = await import("./src/lib/pipelines/engine.ts");
        const result = await adoptPipelineAttemptFromSource(${JSON.stringify(source.conversationId)}, ${JSON.stringify(childRef)});
        process.exit(result ? 0 : 2);
      `], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(0);
      const adopted = loadPipelines()[0]!;
      expect(adopted.state).toBe("closed");
      expect(adopted.closeReport?.status).toBe("pending");
      expect(adopted.closeReport?.pending.some((target) => target.conversationId === childRef.conversationId)).toBe(true);
      expect(adopted.hiddenAt).toBeNull();
      expect((await patchPipeline(pipeline.id, { action: "delete" }, h.ports)).status).toBe(409);
      const { archiveSettledPipelines } = await import("./store");
      expect(await archiveSettledPipelines(Date.parse(h.ports.now()) + 30 * 86_400_000)).toBe(0);
    };
    h.ports.stopStageAgent = async (target) => {
      stops.push(target.conversationId!);
      if (target.conversationId === source.conversationId && seam === "host-stop") await adopt();
      if (target.conversationId === childRef.conversationId) expect(target).toMatchObject({
        launchId: childRef.launchId, conversationId: childRef.conversationId, agentPath: childRef.agentPath, paneId: childRef.paneId,
      });
      return { outcome: "stopped" };
    };
    h.ports.getFlow = () => ({ id: "late-close-flow", state: "reviewing" } as Flow);
    h.ports.closeFlow = async () => { await adopt(); return {}; };
    try {
      await patchPipeline(pipeline.id, { action: "close" }, h.ports);
      await engineModule.drainStageActivations(h.ports);
      if (seam === "settled") await adopt();
      // Check the old executor did not overwrite the adoption transaction.
      // The next controller pass must recover without any caller replay.
      expect(loadPipelines()[0]!.closeReport).toMatchObject({ status: "pending",
        pending: [{ conversationId: childRef.conversationId, launchId: childRef.launchId }] });
      expect(loadPipelines()[0]!.hiddenAt).toBeNull();
      expect((await patchPipeline(pipeline.id, { action: "delete" }, h.ports)).status).toBe(409);
      await tickPipelines([], h.ports);
      await engineModule.drainStageActivations(h.ports);
      // Replaying adoption and close must not enqueue a confirmed host again.
      await engineModule.adoptPipelineAttemptFromSource(source.conversationId!, childRef);
      await patchPipeline(pipeline.id, { action: "close" }, h.ports);
      await engineModule.drainStageActivations(h.ports);
      expect(stops).toEqual([source.conversationId!, childRef.conversationId]);
      expect(loadPipelines()[0]!.closeReport).toMatchObject({ status: "settled", pending: [],
        stopped: [{ conversationId: source.conversationId }, { conversationId: childRef.conversationId }] });
      expect((await patchPipeline(pipeline.id, { action: "delete" }, h.ports)).error).toBeUndefined();
    } finally {
      if (oldDrain === undefined) delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
      else process.env.LLV_PIPELINE_ACTIVATION_DRAIN = oldDrain;
    }
  });
}

for (const enabled of [false, true]) {
  test.each(["before-stop", "during-stop", "crash-resume", "survivor", "survivor-after-checkpoint", "survivor-crash-resume", "survivor-startup-alive", "survivor-startup-unverified"] as const)(`reviewer identity advances during close at %s (activation: ${enabled})`, async (seam) => {
    const h = harness();
    const pipeline = await create(h.ports, [
      { id: "build", kind: "run", prompt: "build", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "review", next: null },
    ] as never);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
    await tickPipelines([entry("/codex/stage-1.jsonl")], h.ports);
    const flow = h.flows.get("flow-1")!;
    const round = (n: number) => ({ n, launchId: `review-launch-${n}`, reviewerConversationId: `conversation_reviewer_${n}`,
      reviewerPath: `/codex/reviewer-${n}.jsonl`, startedAt: h.ports.now() });
    flow.rounds = [round(1) as never];
    flow.state = "reviewing";
    let newerAttempt: import("./types").PipelineStageAttempt | undefined;
    let attemptBeforeNewStop: typeof newerAttempt;
    const sync = async () => {
      const { withPipelineMutation } = await import("./store");
      await withPipelineMutation((pipelines, persist) => {
        expect(reconcileEmbeddedReviewFlows(pipelines, [flow], h.ports.now())).toBe(true);
        if (flow.rounds.length === 2) newerAttempt = structuredClone(pipelines[0]!.runs[1]!.attempts[0]!);
        persist();
      });
    };
    await sync();
    const oldDrain = process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
    process.env.LLV_PIPELINE_ACTIVATION_DRAIN = enabled ? "1" : "0";
    const survivor = seam.startsWith("survivor") ? Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"],
      { stdout: "ignore", stderr: "ignore" }) : null;
    const { captureProcessIdentity } = await import("@/lib/processIdentity");
    const survivorIdentity = survivor ? captureProcessIdentity(survivor.pid) : null;
    if (survivorIdentity && seam === "survivor-startup-unverified") survivorIdentity.startIdentity = null;
    const stops: string[] = [];
    let closes = 0;
    h.ports.stopStageAgent = async (target) => {
      stops.push(target.conversationId!);
      if (target.conversationId === "conversation_reviewer_2") {
        attemptBeforeNewStop = structuredClone(loadPipelines()[0]!.runs[1]!.attempts[0]!);
      }
      if (target.conversationId === "conversation_reviewer_1" && (seam === "during-stop" || (seam === "survivor" && stops.length === 2))) {
        await sync();
      }
      if (target.conversationId === "conversation_reviewer_1" && stops.length === 2 && survivorIdentity && seam !== "survivor-crash-resume") {
        return { outcome: "unresolved", error: "descendant survived", survivors: [survivorIdentity] };
      }
      return { outcome: "not-running" };
    };
    h.ports.closeFlow = async () => { closes++; flow.state = "closed"; return {}; };
    try {
      await patchPipeline(pipeline.id, { action: "close" }, h.ports);
      flow.rounds.push(round(2) as never);
      const crash = seam === "crash-resume" || seam === "survivor-crash-resume";
      if (seam === "before-stop" || crash) await sync();
      if (crash) {
        const child = Bun.spawn([process.execPath, "-e", `
          const { defaultPipelinePorts, drainStageActivations } = await import("./src/lib/pipelines/engine.ts");
          await drainStageActivations({ ...defaultPipelinePorts(), stopStageAgent: async (target) => {
            if (target.conversationId === "conversation_reviewer_2") process.exit(0);
            if (target.conversationId === "conversation_reviewer_1" && ${JSON.stringify(survivorIdentity)} !== null) {
              return { outcome: "unresolved", error: "descendant survived", survivors: [${JSON.stringify(survivorIdentity)}] };
            }
            return { outcome: "stopped" };
          } });
          process.exit(2);
        `], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
        expect(await child.exited).toBe(0);
        expect(loadPipelines()[0]!.closeReport?.stopped.map((host) => host.conversationId))
          .toEqual(survivor ? ["conversation_stage_1"] : ["conversation_stage_1", "conversation_reviewer_1"]);
      }
      if (seam === "survivor-after-checkpoint" || seam.startsWith("survivor-startup-")) {
        await engineModule.drainStageActivations(h.ports);
        await sync();
      }
      for (let i = 0; i < 3; i++) await engineModule.drainStageActivations(h.ports);
      if (survivor) {
        const retained = loadPipelines()[0]!;
        expect(retained.closeReport?.stillRunning.map((host) => host.conversationId)).toEqual(["conversation_reviewer_1"]);
        expect(retained.closeTeardown?.hosts?.find((host) => host.target.conversationId === "conversation_reviewer_1")
          ?.evidence.unresolvedTermination?.survivors).toEqual([survivorIdentity!]);
        expect(retained.runs[1]!.attempts[0]!.unresolvedTermination).toBeUndefined();
        expect(closes).toBe(0);
        expect((await patchPipeline(pipeline.id, { action: "delete" }, h.ports)).status).toBe(409);
        await patchPipeline(pipeline.id, { action: "close" }, h.ports);
        await engineModule.drainStageActivations(h.ports);
        expect(loadPipelines()[0]!.closeReport?.stillRunning).toHaveLength(1);
        const terminate = async () => { survivor.kill(); await survivor.exited; };
        if (seam.startsWith("survivor-startup-")) await frozenSurvivorStartup(pipeline.id, terminate);
        else await terminate();
      }
      await patchPipeline(pipeline.id, { action: "close" }, h.ports);
      await engineModule.drainStageActivations(h.ports);
      await patchPipeline(pipeline.id, { action: "close" }, h.ports);
      await engineModule.drainStageActivations(h.ports);
      expect(stops).toEqual(crash ? ["conversation_reviewer_2", ...(survivor ? ["conversation_reviewer_1", "conversation_reviewer_1"] : [])]
        : ["conversation_stage_1", "conversation_reviewer_1", "conversation_reviewer_2",
          ...(survivor ? ["conversation_reviewer_1", "conversation_reviewer_1"] : [])]);
      expect(closes).toBe(1);
      expect(attemptBeforeNewStop).toEqual(newerAttempt!);
      const closed = loadPipelines()[0]!;
      expect(closed.closeReport).toMatchObject({ status: "settled", pending: [], unconfirmed: [], stillRunning: [] });
      expect(closed.runs[1]!.attempts[0]).toMatchObject({ launchId: "review-launch-2", conversationId: "conversation_reviewer_2" });
    } finally {
      if (survivor && survivor.exitCode === null) { survivor.kill(); await survivor.exited; }
      if (oldDrain === undefined) delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
      else process.env.LLV_PIPELINE_ACTIVATION_DRAIN = oldDrain;
    }
  });
}


test.each(["path-pending", "starting", "closed", "closed-pending"] as const)("never-started %s launch becomes terminal and permits a fenced retry (#1972)", async (shape) => {
  const closed = shape.startsWith("closed");
  const f = await stagedRecoveryHarness();
  await tickPipelines([], f.h.ports);
  const original = { ...f.attempt() };
  const receipt = f.registry.readOnlySnapshot().receipts[original.launchId!]!;
  const stopped = "structured launch recovery: " + JSON.stringify({
    phase: "unpublished", startedAt: Date.parse(receipt.createdAt), checks: 2,
    nextTryAt: 0, stopped: shape !== "closed-pending",
    reason: "runtime host recovery exhausted after 2 checks; original launch and first-message operation inspected; last result: runtime host request timed out",
  });
  f.registry.preserveSpawnArtifactOwnership(receipt.launchId, stopped);
  // The staged fixture's writer retires before the controller proves no agent started.
  const writer = f.registry.readOnlySnapshot().entries[`codex:${receipt.key!.sessionId}`]!;
  expect(f.registry.setStructuredHostClaimed(receipt.key!, { ...writer.structuredHost!, process: null },
    "dead", writer.claimOwner!, writer.claimEpoch, true)).toMatchObject({ status: "dead", claimOwner: null });
  const records = loadPipelines();
  records[0]!.state = closed ? "closed" : "needs_decision";
  if (closed) {
    records[0]!.cursor = null; records[0]!.closedAt = f.h.ports.now();
    records[0]!.runs[0]!.attempts[0]!.completedAt = records[0]!.closedAt;
  }
  records[0]!.stateDetail = "stage spawn recovery stopped: runtime host recovery exhausted; original launch retained";
  records[0]!.runs[0]!.attempts[0]!.state = "needs_decision";
  records[0]!.runs[0]!.attempts[0]!.error = records[0]!.stateDetail;
  savePipelines(records);
  setAgentRegistryForTests(f.registry);
  try {
    const real = defaultPipelinePorts();
    f.h.ports.spawnReceipt = (id) => {
      const read = real.spawnReceipt(id);
      // Older controllers retained the same unpublished receipt as starting.
      return shape === "starting" && read?.state === "path-pending" ? { ...read, state: "starting", error: null } : read;
    };
    f.h.ports.failStageLaunch = real.failStageLaunch;
    f.h.ports.claimSpawnRetry = real.claimSpawnRetry;
    await tickPipelines([], f.h.ports);
    expect(f.registry.readOnlySnapshot().receipts[receipt.launchId]!.state).toBe("failed");
    expect(f.attempt().state).toBe("failed");
    const { projectLaunchConversations } = await import("@/lib/agent/spawnProjection");
    const card = projectLaunchConversations([], f.registry.readOnlySnapshot()).cards[0]!;
    expect(card.spawn?.state).toBe("failed");
    expect(card.activity).not.toBe("live");
    const { buildSchemeLayout } = await import("@/components/scheme/layout");
    const { buildTaskBands } = await import("@/components/scheme/taskBands");
    const { projectTaskWorkflows } = await import("@/components/tasks/taskWorkflowModel");
    const { buildKanbanModel } = await import("@/components/kanban/kanbanModel");
    const task: BoardTask = {
      id: "task-never-started", project: card.project, text: "Completed by the successor", status: "done", placement: "unplaced",
      assignments: [{ path: card.path, conversationId: card.conversationId!, panePid: null, state: "delivered", error: null, at: receipt.createdAt }],
      createdAt: receipt.createdAt, updatedAt: receipt.createdAt,
    };
    const pipelines = loadPipelines();
    const projection = projectTaskWorkflows([task], pipelines, [], [card]);
    const layout = buildSchemeLayout([], [card], [card]);
    const bands = buildTaskBands(layout, { tasks: [task], projection, untitled: "Task" });
    const board = buildKanbanModel({ bands, tasks: [task], pipelines, projection, files: [card], now: Date.now() / 1000 });
    expect(board.columns.done.cards.find((item) => item.task?.id === task.id)?.working).toBe(0);
    expect(board.columns.done.working).toBe(0);
    expect(board.totals.working).toBe(0);
    if (closed) return;
    const retried = await patchPipeline(records[0]!.id, { action: "retry-stage" }, f.h.ports);
    expect(retried.error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    const next = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    expect(next.n).toBe(2);
    expect(next.launchId).not.toBe(original.launchId);
    expect(f.registry.readOnlySnapshot().receipts[receipt.launchId]!.retryClaim).not.toBeNull();
    const oldEntry = f.registry.readOnlySnapshot().entries["codex:" + receipt.key!.sessionId]!;
    expect(f.registry.settleSpawn(receipt.launchId, oldEntry).kind).toBe("conflict");
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.launchId).toBe(next.launchId);
  } finally { setAgentRegistryForTests(null); }
});

/* Integration (#1695 K6c, #1709): a real, isolated registry switches the stage's conversation to another
   account through the structured reconfigure; the message the operator sent while the switch waited is
   carried by the commit and delivered by the ordinary migration tick; that delivery is what starts the
   successor's turn, and the stage settles on the successor's verdict. No host, socket or account is touched. */
test("a stage conversation switched to another account continues on the message held for the switch and settles on the successor's verdict without the fail edge (#1695 K6c)", async () => {
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { advanceConversationMigration, reconcileMigrations } = await import("@/lib/accounts/migration/coordinator");
  const { applyStructuredReconfigure } = await import("@/lib/runtime/structuredReconfigure");
  const { procBackend } = await import("@/lib/proc");
  const { boardFor } = await import("@/lib/board/store");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "k6c-switched-stage-registry.json"));
  const sourcePath = "/codex/k6c-stage-source.jsonl";
  const successorPath = "/codex/accounts/account-b/k6c-stage-successor.jsonl";
  const profile = emptyLaunchProfile({ cwd: "/repo", project: "repo" });
  const hostProcess = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
  const observe = (turn: "busy" | "idle", observedAt: string) => registry.reconcileConversations([{
    engine: "codex", path: sourcePath, accountId: "account-a", launchProfile: profile,
    turn: { state: turn, source: "assistant", terminalAt: turn === "idle" ? observedAt : null }, observedAt,
  }] as never);
  const recordHost = (activeTurnRef: string | null) => registry.upsert({
    key: { engine: "codex", sessionId: stageConversationGeneration() },
    artifactPath: sourcePath, cwd: "/repo", accountId: "account-a", launchProfile: profile,
    status: activeTurnRef ? "live" : "idle", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:k6c", process: hostProcess, eventCursor: 1, protocolVersion: "v2", writerClaimEpoch: 1, activeTurnRef, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: `structured-host:${JSON.stringify(hostProcess)}`, pendingAction: null,
  });
  observe("busy", "2026-07-21T10:00:10.000Z");
  const stageConversation = registry.conversationForPath(sourcePath)!.id;
  function stageConversationGeneration() { return registry.conversation(stageConversation)!.generations[0]!.id; }
  recordHost("turn-source");

  const h = harness();
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, onReserved) => {
    const spawned = await spawn(input, (reserved) => onReserved({ ...reserved, conversationId: stageConversation }));
    return { ...spawned, conversationId: stageConversation, transcript: sourcePath };
  };
  /* Where the conversation lives now, as the registry says: the engine follows it across the switch. */
  const basePath = h.ports.pathForConversation;
  const baseConversation = h.ports.conversationIdForPath;
  h.ports.pathForConversation = (id) => id === stageConversation ? registry.conversation(stageConversation)?.generations.at(-1)?.path ?? null : basePath(id);
  h.ports.conversationIdForPath = (pathname) => registry.conversationForPath(pathname)?.id ?? baseConversation(pathname);
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build", next: null, onFail: { to: "recover", maxRounds: 1 } },
    { id: "recover", kind: "run", role: { roleId: "builder" }, prompt: "Recover {{prev.output}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  makeStructuredAttempt();
  pinStageHead(h);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.conversationId).toBe(stageConversation);

  /* The successor engine answers only what it is sent. */
  const successor = {
    received: [] as string[],
    receive(text: string) {
      this.received.push(text);
      h.durableTurns.set(successorPath, { turn: "busy", message: null });
      h.setConversationActive(true);
    },
    finishTurn() {
      if (this.received.length === 0) return;
      h.durableTurns.set(successorPath, { turn: "terminal", message: { text: PASS_TEXT, ts: 5_600_000 } });
      h.setConversationActive(false);
    },
  };
  const provider = {
    virtualSource: true as const,
    async create(input: { operationId: string }) {
      return { operationId: input.operationId, nativeId: "k6c-stage-successor", path: successorPath, continuityPaths: [], historyHash: "k6c-history", host: { kind: "codex-app-server" as const, identity: "k6c-successor-host", epoch: 1, verifiedAt: "2026-07-21T10:01:00.000Z" } };
    },
    async verify() {},
  };
  const effect = { operationId: "k6c-switch-to-b", conversationId: stageConversation, kind: "reconfigure" as const, model: "gpt-5.6-sol", effort: "medium", fast: false, accountId: "account-b", eventSeq: 11 };
  const applySwitch = () => applyStructuredReconfigure(effect, {
    registry,
    validateAccount: async () => {},
    resolveAccount: ((engine: string, accountId: string) => ({ accountId, home: process.env.LLV_STATE_DIR!, engine })) as never,
    releaseHost: async () => true,
    recover: (async () => true) as never,
    migrate: (conversationId, _target, store, ownsOperation, reconfigureOperationId) =>
      advanceConversationMigration(conversationId, store, provider, { ownsOperation, reconfigureOperationId, deferBoardRepair: true }),
  });

  /* The operator switches the stage's conversation while its turn runs, then tells it to carry on there. */
  expect(await applySwitch()).toBe("pending");
  expect(registry.conversation(stageConversation)!.migration?.phase).toBe("waiting-turn");
  const held = registry.holdDelivery(stageConversation, "Continue the build on the other account.", "k6c-continue");
  expect(held.state).toBe("held");

  /* The source turn ends without a verdict and its host is released, well inside the grace a dead host gets. */
  h.durableTurns.set(sourcePath, { turn: "terminal", message: { text: "Halfway through; continuing on the other account.", ts: 5_000_000 } });
  h.setConversationActive(false);
  const releasedAt = h.ports.now();
  h.ports.conversationHostUnavailableSince = async () => releasedAt;
  h.advanceWallClock(60_000);
  await tickPipelines([entry(sourcePath)], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");

  /* The queue runs the switch again at the turn boundary, and it commits on account B. */
  recordHost(null);
  observe("idle", "2026-07-21T10:00:30.000Z");
  expect(await applySwitch()).toBe("applied");
  expect(registry.conversation(stageConversation)!.generations.at(-1)).toMatchObject({ accountId: "account-b", path: successorPath });

  /* The ordinary migration tick delivers what the switch carried, to the successor, once. */
  const delivered: Array<{ path: string; operationId: string }> = [];
  const port = {
    async deliver({ delivery, path: target }: { delivery: { text: string; command: { operationId: string } }; path: string }) {
      delivered.push({ path: target, operationId: delivery.command.operationId });
      successor.receive(delivery.text);
      return "delivered" as const;
    },
  };
  const tick = () => reconcileMigrations(provider, port, registry, { remapBoardPaths: (project) => boardFor(project), transferBoardPathPlacements: () => {} });
  await tick();
  await tick();
  expect(delivered).toEqual([{ path: successorPath, operationId: held.command.operationId }]);
  expect(successor.received).toEqual(["Continue the build on the other account."]);

  h.ports.conversationHostUnavailableSince = async () => null;
  h.advanceWallClock(5 * 60_000);
  await tickPipelines([{ ...entry(successorPath), activity: "live" }], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running", agentPath: successorPath });

  successor.finishTurn();
  await tickPipelines([entry(successorPath)], h.ports);
  await tickPipelines([entry(successorPath)], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "passed", agentPath: successorPath, conversationId: stageConversation, verdict: { status: "pass" } });
  expect(current.runs.find((run) => run.stageId === "recover")?.attempts ?? []).toEqual([]);
  expect(current.cursor?.activatedBy?.edge ?? null).not.toBe("fail");
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(1);
});

test("null stage tier stores and launches the role preference; default opts out", async () => {
  const h = harness();
  h.ports.roleLookup = () => ({ engine: "codex", model: "gpt-6-astra", effort: "high", serviceTier: "ultrafast", promptScaffold: "Reviewer guidance" });
  const stage = { id: "review", kind: "run", role: { roleId: "reviewer" }, serviceTier: null, prompt: "Review", next: null };
  const pipeline = await create(h.ports, [stage] as never);
  expect(loadPipelines()[0]?.stages[0]).toMatchObject({ serviceTier: null, effectiveRole: { serviceTier: "ultrafast", serviceTierSource: "role-default" } });
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  expect(h.spawnInputs[0]?.role).toMatchObject({ serviceTier: "ultrafast", serviceTierSource: "role-default" });
  const draft = await createPipelineFromRequest({ task: "Tier overrides", repoDir: "/repo", autoStart: false, stages: [stage] as never }, h.ports);
  expect(draft.error).toBeUndefined();
  const optedOut = await patchPipeline(draft.pipeline!.id, { action: "override-stage", stageId: "review", serviceTier: "default" }, h.ports);
  expect(optedOut.error).toBeUndefined();
  expect(optedOut.pipeline?.stages[0]).toMatchObject({ serviceTier: "default", effectiveRole: { serviceTier: "default", serviceTierSource: "explicit" } });
  const inherited = await patchPipeline(draft.pipeline!.id, { action: "override-stage", stageId: "review", serviceTier: null }, h.ports);
  expect(inherited.error).toBeUndefined();
  expect(inherited.pipeline?.stages[0]).toMatchObject({ serviceTier: null, effectiveRole: { serviceTier: "ultrafast", serviceTierSource: "role-default" } });
  expect(pipeline.id).toBeTruthy();
});

test("create refuses an explicit service tier absent from the project's catalog pool", async () => {
  const h = harness();
  const created = await createPipelineFromRequest({ task: "Tier validation", repoDir: "/repo", autoStart: false, stages: [{ id: "review", kind: "run", engine: "codex", model: "gpt-6-astra", effort: "high", serviceTier: "unlisted-tier", prompt: "Review", next: null }] }, h.ports);
  expect(created.pipeline).toBeUndefined();
  expect(created.violations).toContainEqual(expect.objectContaining({ field: "stages[0].serviceTier" }));
  expect(created.error).toContain("offered:");
});

test("review-loop forwards the role-default service tier to its flow and reflects the admitted round", async () => {
  const h = harness();
  const lookup = h.ports.roleLookup;
  h.ports.roleLookup = (id, parameters) => id === "reviewer"
    ? { engine: "codex", model: "gpt-6-astra", effort: "high", serviceTier: "ultrafast", promptScaffold: "Reviewer guidance" }
    : lookup!(id, parameters);
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
    { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([h.finish("/codex/stage-1.jsonl", "pass")], h.ports);
  await tickPipelines([], h.ports);
  expect(h.flowRequests[0]?.roles?.reviewer).toMatchObject({ serviceTier: "ultrafast", serviceTierSource: "role-default" });
  const { pipelineAcknowledgement } = await import("@/lib/mcp/compactAnswers");
  expect(pipelineAcknowledgement(loadPipelines()[0]!).runtimeLine).toContain("/ultrafast (role default, if offered)");
  const flow = [...h.flows.values()][0]!;
  flow.roles = h.flowRequests[0]!.roles!;
  flow.rounds = [{ ...newRound(flow, "button", null), spawnStartedAt: new Date().toISOString(),
    reviewerRole: { engine: "codex", model: "gpt-6-astra", effort: "high", preferredServiceTier: "ultrafast", serviceTierSource: "role-default" } }];
  await tickPipelines([], h.ports);
  const attempt = loadPipelines()[0]!.runs.find(run => run.stageId === "review")!.attempts[0]!;
  expect(attempt.effectiveRole.serviceTier).toBeUndefined();
  expect(attempt.effectiveRole.preferredServiceTier).toBe("ultrafast");
  expect(pipelineAcknowledgement(loadPipelines()[0]!).runtimeLine).toContain("/default (role default ultrafast not offered by an available account)");
});

test.each([undefined, 7])("pipeline review default and explicit higher budget %s survive creation and store reload", async (maxRounds) => {
  const h = harness();
  savePipelines([]);
  const result = await createPipelineFromRequest({ task: "Review budget", repoDir: "/repo", autoStart: false,
    stages: BUDGET_STAGES({ to: "build", ...(maxRounds === undefined ? {} : { maxRounds }) }) as never,
  }, h.ports);
  expect(result.error).toBeUndefined();
  expect(result.pipeline!.stages[1]!.onFail!.maxRounds).toBe(maxRounds ?? 3);
  expect(loadPipelines()[0]!.stages[1]!.onFail!.maxRounds).toBe(maxRounds ?? 3);
  const patched = await patchPipeline(result.pipeline!.id, { action: "set-edge", stageId: "critique", edge: "fail", to: "build", ...(maxRounds === undefined ? {} : { maxRounds }) }, h.ports);
  expect(patched.error).toBeUndefined();
  expect(patched.pipeline!.stages[1]!.onFail!.maxRounds).toBe(maxRounds ?? 3);
});

test("an omitted pipeline review budget runs three reviews and completes after the final fix", async () => {
  const h = movingHeadHarness();
  await create(h.ports, BUDGET_STAGES({ to: "build" }, null) as never);
  const { pipeline } = await driveWithController(h);
  expect(pipeline.state).toBe("completed");
  expect(pipeline.runs.find((run) => run.stageId === "critique")!.attempts).toHaveLength(3);
  expect(pipeline.runs.find((run) => run.stageId === "build")!.attempts).toHaveLength(4);
});


/* Restart recovery retains the on-disk attempt and its partial work. */
test.each([
  { engine: "codex", interruption: "idle" }, { engine: "claude", interruption: "idle" },
  { engine: "codex", interruption: "dead" }, { engine: "claude", interruption: "dead" },
  { engine: "codex", interruption: "stalled" }, { engine: "claude", interruption: "stalled" },
] as const)("restart creates one fresh $engine attempt after $interruption, then parks another interruption", async ({ engine, interruption }) => {
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", engine, model: engine === "claude" ? "fable" : "gpt-5.6-sol", prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const before = loadPipelines()[0]!;
  const attempt = before.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([before]);
  const lastRecordAt = Date.parse(attempt.startedAt!) + 1;
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt });
  let oldConversationMessages = 0;
  const restarted = { ...h.ports,
    restartRecoveryBootId: () => "boot-after-crash",
    restartRecoveryBootStartedAt: () => Date.parse(h.ports.now()) + 1,
    conversationTurnInterrupted: async () => interruption,
    resumeSeveredTurn: async () => { oldConversationMessages += 1; return true; },
  };
  // An idle host is read as interrupted only once its transcript has been silent for the whole bound.
  if (interruption === "idle") h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(attempt.agentPath!)], restarted);
  expect(oldConversationMessages).toBe(0);
  expect(h.calls).toContain(`stop-host:build:${attempt.n}:${attempt.conversationId}`);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  const recoveryBootId = "boot-after-crash:unknown";
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "failed", restartRecovery: { bootId: recoveryBootId, replacementAttempt: 2 } });
  expect(loadPipelines()[0]!.runs[0]!.attempts[1]).toMatchObject({ state: "pending", restartContext: { previousAttempt: 1, transcriptPath: attempt.agentPath }, restartRecovery: { bootId: recoveryBootId, replacedAttempt: 1 } });
  await tickPipelines([], restarted);
  expect(h.spawnInputs).toHaveLength(2);
  expect(h.spawnInputs[1]!.cwd).toBe(loadPipelines()[0]!.worktreeDir);
  expect(h.spawnInputs[1]!.prompt).toContain("Build");
  expect(h.spawnInputs[1]!.prompt).toContain("interrupted by a Delegatus restart");
  expect(h.spawnInputs[1]!.prompt).toContain(attempt.agentPath!);
  await tickPipelines([entry(attempt.agentPath!)], { ...restarted });
  expect(oldConversationMessages).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  const afterReplacement = loadPipelines()[0]!;
  const replacement = afterReplacement.runs[0]!.attempts[1]!;
  replacement.paneId = null;
  savePipelines([afterReplacement]);
  h.durableTurns.set(replacement.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(replacement.startedAt!) + 1 });
  if (interruption === "idle") h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(replacement.agentPath!)], restarted);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });
  expect(loadPipelines()[0]!.stateDetail).toContain("automatic restart attempt");
});

test("a stage a restart cut is retried once in its worktree, told it was cut and what it last said", async () => {
  const h = harness();
  const attempt = await restartCutStage(h);
  const report = "Waiting for the test sweep to finish; the two failures seen so far fail on the base commit too.";
  cutByRestart(h, h.ports, attempt, h.ports.now(), report);

  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);

  const replaced = loadPipelines()[0]!;
  expect(replaced.state).toBe("running");
  expect(replaced.runs[0]!.attempts).toHaveLength(2);
  expect(replaced.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: "interrupted by a Delegatus restart; replaced by a fresh stage attempt" });
  expect(replaced.runs[0]!.attempts[1]).toMatchObject({ state: "pending",
    restartContext: { previousAttempt: 1, transcriptPath: attempt.agentPath, cause: "restart", lastReport: report } });
  expect(replaced.stateDetail).toBe("stage attempt 1 was interrupted by a restart; fresh attempt 2 is starting");
  // The fail edge is untouched: nothing was routed to the recovery stage.
  expect(replaced.runs[1]!.attempts).toHaveLength(0);

  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(2);
  expect(h.spawnInputs[1]!.cwd).toBe(loadPipelines()[0]!.worktreeDir);
  expect(h.spawnInputs[1]!.prompt).toContain("Build");
  expect(h.spawnInputs[1]!.prompt).toContain("stage attempt 1 was interrupted by a Delegatus restart.");
  expect(h.spawnInputs[1]!.prompt).toContain(`> ${report}`);
  expect(h.spawnInputs[1]!.prompt).toContain("keep the uncommitted work");
  expect(h.spawnInputs[1]!.prompt).toContain(attempt.agentPath!);
});

test("a restart replacement cut by a second recorded restart gets one more fresh attempt", async () => {
  const h = harness();
  const attempt = await restartCutStage(h, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }]);
  cutByRestart(h, h.ports, attempt, h.ports.now(), "first cut");
  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const replacement = lane.runs[0]!.attempts[1]!;
  replacement.paneId = null;
  savePipelines([lane]);
  expect(replacement.state).toBe("running");

  cutByRestart(h, h.ports, replacement, h.ports.now(), "second cut");
  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("running");
  expect(parked.runs[0]!.attempts).toHaveLength(3);
  expect(parked.runs[0]!.attempts[1]).toMatchObject({ state: "failed", error: "interrupted by a Delegatus restart; replaced by a fresh stage attempt" });
  expect(parked.runs[0]!.attempts[2]!.restartContext).toMatchObject({ previousAttempt: 2, cause: "restart" });
});

/* The replacement is cut again before it wrote a word, so the provider's
   host-death relaunch would otherwise answer it with a third attempt. */
test.each([
  { case: "no output", turn: "terminal", launchOnly: false },
  { case: "launch only", turn: "busy", launchOnly: true },
] as const)("a restart replacement cut again with $case continues before any other recovery, in a later boot", async ({ turn, launchOnly }) => {
  const h = harness();
  const attempt = await restartCutStage(h, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }]);
  cutByRestart(h, h.ports, attempt, h.ports.now(), "first cut");
  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const replacement = lane.runs[0]!.attempts[1]!;
  replacement.paneId = null;
  savePipelines([lane]);

  cutByRestart(h, h.ports, replacement, h.ports.now(), "ignored");
  h.durableTurns.set(replacement.agentPath!, { turn, message: null, launchOnly, lastRecordAt: Date.parse(replacement.startedAt!) });
  const later: PipelinePorts = { ...h.ports, restartRecoveryBootId: () => "later-boot", conversationAgentActive: async () => false };
  for (let tick = 0; tick < 4; tick += 1) {
    h.advanceWallClock(5 * 60_000);
    await tickPipelines([], later);
  }

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("running");
  expect(parked.runs[0]!.attempts).toHaveLength(3);
  expect(h.spawnInputs).toHaveLength(3);
});

test("a verdict written while the restart-cut host is being stopped settles the attempt and starts no replacement", async () => {
  const h = harness();
  const attempt = await restartCutStage(h, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }]);
  cutByRestart(h, h.ports, attempt, h.ports.now(), "Interim: the sweep is still running.");
  const stop = h.ports.stopStageAgent;
  h.ports.stopStageAgent = async (target) => {
    const at = Date.parse(h.ports.now()) - 1;
    h.durableTurns.set(attempt.agentPath!, { turn: "terminal", message: { text: PASS_TEXT, ts: at }, lastRecordAt: at });
    return stop(target);
  };
  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  const settled = loadPipelines()[0]!;
  expect(settled.runs[0]!.attempts).toHaveLength(1);
  expect(settled.runs[0]!.attempts[0]!.state).toBe("passed");
  expect(h.spawnInputs).toHaveLength(1);
});

test.each([
  { case: "a minute", offset: 60_000 },
  { case: "four minutes", offset: 4 * 60_000 },
] as const)("work in the transcript $case after a restart cut means the restart did not end the attempt", async ({ offset }) => {
  const h = harness();
  const attempt = await restartCutStage(h, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }]);
  const recordedAt = h.ports.now();
  cutByRestart(h, h.ports, attempt, recordedAt, "cut");
  const worked = Date.parse(recordedAt) + offset;
  h.durableTurns.set(attempt.agentPath!, { turn: "terminal", message: { text: "Resumed and kept going.", ts: worked }, lastRecordAt: worked, lastAgentEventAt: worked });
  h.advanceWallClock(25 * 60_000);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: HISTORICAL_VERDICT_MISS });
});

test("records a CLI writes as it exits after a restart cut do not count as work", async () => {
  const h = harness();
  const attempt = await restartCutStage(h, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }]);
  const recordedAt = h.ports.now();
  cutByRestart(h, h.ports, attempt, recordedAt, "Almost done.");
  const cutAt = Date.parse(recordedAt) - 1;
  h.durableTurns.set(attempt.agentPath!, { turn: "terminal", message: { text: "Almost done.", ts: cutAt },
    lastRecordAt: Date.parse(recordedAt) + 90_000, lastAgentEventAt: cutAt });
  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);

  expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.restartContext).toMatchObject({ cause: "restart", lastReport: "Almost done." });
});

/* The provider ended the turn before the restart came: the CLI gave up on a
   refresh race. The provider recovery keeps its wait, class and budget, and
   the restart spends nothing. A turn the restart itself cut still retries. */
test("a provider failure that predates a restart cut keeps its provider recovery and spends no restart attempt", async () => {
  const h = harness();
  const attempt = await restartCutStage(h, [{ id: "build", kind: "run", engine: "claude", model: "fable", prompt: "Build", next: null }]);
  h.advanceWallClock(10 * 60_000);
  const recordedAt = h.ports.now();
  cutByRestart(h, h.ports, attempt, recordedAt, "unused");
  const failedAt = Date.parse(recordedAt) - 30_000;
  h.durableTurns.set(attempt.agentPath!, {
    turn: "terminal", message: { text: "Running the suite.", ts: failedAt - 1_000 },
    lastRecordAt: failedAt, lastAgentEventAt: failedAt - 1_000,
    terminalProviderMessage: { text: "Failed to refresh OAuth token: retry in a minute", ts: failedAt, errorClass: "server_error" },
  });
  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);

  const lane = loadPipelines()[0]!;
  expect(lane.runs[0]!.attempts).toHaveLength(1);
  expect(lane.runs[0]!.attempts[0]!.restartRecovery).toBeUndefined();
  expect(lane.runs[0]!.attempts[0]!.providerWait?.condition).toMatchObject({ kind: "transient", label: "auth refresh race" });
  expect(lane.stateDetail).toContain("auth refresh race");
  expect(h.spawnInputs).toHaveLength(1);
});

test("the interruption a dying CLI writes is the restart's own mark: the cut still retries once", async () => {
  const h = harness();
  const attempt = await restartCutStage(h, [{ id: "build", kind: "run", engine: "claude", model: "fable", prompt: "Build", next: null }]);
  h.advanceWallClock(10 * 60_000);
  const recordedAt = h.ports.now();
  cutByRestart(h, h.ports, attempt, recordedAt, "unused");
  const workedAt = Date.parse(recordedAt) - 30_000;
  h.durableTurns.set(attempt.agentPath!, {
    turn: "terminal", message: null, lastRecordAt: Date.parse(recordedAt) + 1_000, lastAgentEventAt: workedAt,
    terminalProviderMessage: { text: "stage turn interrupted before completion", ts: Date.parse(recordedAt) + 1_000, errorClass: "turn_aborted" },
  });
  h.advanceWallClock(5 * 60_000);
  await tickPipelines([], h.ports);

  const lane = loadPipelines()[0]!;
  expect(lane.runs[0]!.attempts).toHaveLength(2);
  expect(lane.runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "restart" });
  expect(lane.runs[0]!.attempts[0]!.providerWait).toBeUndefined();
});

/* What a real CLI leaves behind: interim prose, then the shutdown marker it
   writes as the restart takes its process. The marker keeps that prose out of
   the verdict; the fresh attempt is still told it. */
test.each(["claude", "codex"] as const)("a %s attempt a native shutdown marker closed tells its one replacement what it last said", async (engine) => {
  const h = harness();
  const attempt = await restartCutStage(h, [{ id: "build", kind: "run", engine, model: engine === "codex" ? "gpt-6-sol" : "fable", prompt: "Build", next: null }]);
  h.advanceWallClock(10 * 60_000);
  const recordedAt = h.ports.now();
  cutByRestart(h, h.ports, attempt, recordedAt, "unused");
  const at = (offset: number) => new Date(Date.parse(recordedAt) + offset).toISOString();
  const prose = "Two of five suites are green; running the remaining three.";
  const records = engine === "codex" ? [
    { timestamp: at(-60_000), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: at(-30_000), type: "event_msg", payload: { type: "agent_message", message: prose } },
    { timestamp: at(1_000), type: "event_msg", payload: { type: "turn_aborted" } },
  ] : [
    { timestamp: at(-60_000), type: "user", message: { role: "user", content: "Build" } },
    { timestamp: at(-30_000), type: "assistant", message: { role: "assistant", content: [{ type: "text", text: prose }] } },
    { timestamp: at(1_000), type: "user", interruptedByShutdown: true, message: { role: "user", content: "[Request interrupted by user]" } },
  ];
  const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-native-cut-")), `${engine}.jsonl`);
  fs.writeFileSync(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const evidence = await durableStageTurnEvidence(engine, transcript);
  expect(evidence).toMatchObject({ turn: "terminal", message: null, terminalProviderMessage: { errorClass: "turn_aborted" } });
  h.durableTurns.set(attempt.agentPath!, evidence!);
  for (let tick = 0; tick < 3; tick += 1) {
    h.advanceWallClock(5 * 60_000);
    await tickPipelines([], h.ports);
  }

  const lane = loadPipelines()[0]!;
  expect(lane.runs[0]!.attempts).toHaveLength(2);
  expect(lane.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: "interrupted by a Delegatus restart; replaced by a fresh stage attempt" });
  expect(lane.runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "restart", lastReport: prose });
  expect(h.spawnInputs[1]!.prompt).toContain(`> ${prose}`);
});

test("a restart cut is retried exactly once across repeated restarts and two Viewer generations", async () => {
  const h = harness();
  const attempt = await restartCutStage(h, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }]);
  cutByRestart(h, h.ports, attempt, h.ports.now(), "cut");
  h.advanceWallClock(5 * 60_000);
  /* Two generations tick the same lane: the incumbent still draining and its
     successor, each with its own boot. Then the service restarts again. */
  const generations: PipelinePorts[] = ["incumbent", "successor", "after-second-restart"].map((boot) => ({ ...h.ports,
    restartRecoveryBootId: () => boot, runtimeHostEpoch: async () => boot === "incumbent" ? 7 : 8 }));
  for (const ports of [...generations, ...generations]) await tickPipelines([], ports);

  const lane = loadPipelines()[0]!;
  expect(lane.runs[0]!.attempts).toHaveLength(2);
  expect(lane.runs[0]!.attempts.filter((candidate) => candidate.restartContext?.cause === "restart")).toHaveLength(1);
  expect(h.spawnInputs).toHaveLength(2);
  expect(lane.state).toBe("running");
});

test.each([
  { case: "no restart cut it", cutAt: null },
  { case: "the recorded cut is older than the attempt", cutAt: "before" },
  { case: "it worked on after the restart", cutAt: "worked-after" },
] as const)("a stage whose host died for another reason is untouched: $case", async ({ cutAt }) => {
  const h = harness();
  const attempt = await restartCutStage(h);
  const now = h.ports.now();
  const ts = Date.parse(now) - 1;
  h.durableTurns.set(attempt.agentPath!, { turn: "terminal", message: { text: "progress", ts },
    lastRecordAt: cutAt === "worked-after" ? Date.parse(now) + 20 * 60_000 : ts });
  const recordedAt = cutAt === "before" ? new Date(Date.parse(attempt.startedAt!) - 1_000).toISOString() : now;
  Object.assign(h.ports, {
    conversationRestartCut: () => cutAt === null ? null : { recordedAt },
    conversationHostUnavailableSince: async () => now,
  });
  h.advanceWallClock(25 * 60_000);
  await tickPipelines([], h.ports);

  const current = loadPipelines()[0]!;
  expect(current.runs[0]!.attempts).toHaveLength(1);
  expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: HISTORICAL_VERDICT_MISS });
  expect(current.cursor).toMatchObject({ stageId: "recover", state: "pending" });
});

test("an open turn a restart cut is named a restart and its replacement continues after a later recorded cut", async () => {
  const h = harness();
  const attempt = await restartCutStage(h, [{ id: "build", kind: "run", engine: "claude", model: "fable", prompt: "Build", next: null }]);
  const recordedAt = h.ports.now();
  /* The dying CLI's bookkeeping moved the newest record past the cut; the
     agent's own last event is before it. */
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: { text: "Committing.", ts: Date.parse(recordedAt) - 1 },
    lastRecordAt: Date.parse(recordedAt) + 27_000, lastAgentEventAt: Date.parse(recordedAt) - 1 });
  /* The booting Viewer predates nothing here: only the recorded cut says a
     restart happened. */
  const boot = (id: string): PipelinePorts => ({ ...h.ports,
    restartRecoveryBootId: () => id,
    restartRecoveryBootStartedAt: () => Date.parse(attempt.startedAt!) - 60_000,
    conversationTurnInterrupted: async () => "dead",
    conversationRestartCut: () => ({ recordedAt }) });
  await tickPipelines([entry(attempt.agentPath!)], boot("first-boot"));
  const replaced = loadPipelines()[0]!;
  expect(replaced.runs[0]!.attempts[0]!.error).toBe("interrupted by a Delegatus restart; replaced by a fresh stage attempt");
  expect(replaced.runs[0]!.attempts[1]!.restartContext).toMatchObject({ cause: "restart", lastReport: "Committing." });

  await tickPipelines([], boot("first-boot"));
  const lane = loadPipelines()[0]!;
  const replacement = lane.runs[0]!.attempts[1]!;
  replacement.paneId = null;
  savePipelines([lane]);
  const replacementCut = h.ports.now();
  h.durableTurns.set(replacement.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(replacementCut) - 1 });
  await tickPipelines([entry(replacement.agentPath!)], { ...boot("second-boot"), conversationRestartCut: () => ({ recordedAt: replacementCut }) });

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("running");
  expect(parked.runs[0]!.attempts).toHaveLength(3);
  expect(parked.runs[0]!.attempts[2]!.restartContext).toMatchObject({ previousAttempt: 2, cause: "restart" });
});

/* The restart came before the first attempt's transcript was discovered: the
   host is gone, no path resolves, and only the recorded cut names the cause. */
test.each([
  { case: "seen at once", waitedForHostDeath: false },
  { case: "seen after a host-death wait began", waitedForHostDeath: true },
] as const)("a first launch cut before its transcript was discovered spends the one restart attempt, $case", async ({ waitedForHostDeath }) => {
  const h = harness();
  const attempt = await restartCutStage(h, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }]);
  const first = loadPipelines()[0]!;
  Object.assign(first.runs[0]!.attempts[0]!, { agentPath: null, sessionId: null });
  savePipelines([first]);
  const pathFor = h.ports.pathForConversation;
  h.ports.pathForConversation = (id) => id === attempt.conversationId ? null : pathFor(id);
  h.setConversationActive(false);
  if (waitedForHostDeath) {
    /* The engine ticked before the booting Viewer recorded the cut. */
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.stateDetail).toContain("stage host died without output");
  }
  const cuts = new Map([[attempt.conversationId!, h.ports.now()]]);
  Object.assign(h.ports, { cuts, conversationRestartCut: (id: string) => cuts.has(id) ? { recordedAt: cuts.get(id)! } : null });
  for (let tick = 0; tick < 3; tick += 1) {
    h.advanceWallClock(60_000);
    await tickPipelines([], h.ports);
  }

  const replaced = loadPipelines()[0]!;
  expect(replaced.runs[0]!.attempts).toHaveLength(2);
  expect(replaced.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: "interrupted by a Delegatus restart; replaced by a fresh stage attempt" });
  expect(replaced.runs[0]!.attempts[1]!.restartContext).toEqual({ previousAttempt: 1, transcriptPath: null, cause: "restart" });
  expect(replaced.runs[0]!.attempts[1]!.input).toBe(replaced.runs[0]!.attempts[0]!.input);
  expect(h.spawnInputs).toHaveLength(2);
  expect(h.spawnInputs[1]!.cwd).toBe(replaced.worktreeDir);
  expect(h.spawnInputs[1]!.prompt).toContain("Build");
  expect(h.spawnInputs[1]!.prompt).toContain("stage attempt 1 was interrupted by a Delegatus restart.");
  expect(h.spawnInputs[1]!.prompt).toContain("it was cut before it wrote a transcript");
  expect(h.spawnInputs[1]!.prompt).not.toContain("died without output");
  expect(h.spawnInputs[1]!.prompt).not.toContain("null");

  /* The replacement is cut by the next restart after some interim prose. */
  const replacement = replaced.runs[0]!.attempts[1]!;
  replacement.paneId = null;
  savePipelines([replaced]);
  cutByRestart(h, h.ports, replacement, h.ports.now(), "Interim: the build is half done.");
  for (const boot of ["second-boot", "third-boot"]) {
    h.advanceWallClock(5 * 60_000);
    await tickPipelines([], { ...h.ports, restartRecoveryBootId: () => boot });
    await tickPipelines([], { ...h.ports, restartRecoveryBootId: () => boot });
  }

  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("running");
  expect(parked.runs[0]!.attempts).toHaveLength(3);
  expect(h.spawnInputs).toHaveLength(3);
});

test("a restart cut recorded after a host-death wait began replaces that relaunch with the one restart attempt", async () => {
  const h = harness();
  const attempt = await restartCutStage(h, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }]);
  h.setConversationActive(false);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, launchOnly: true });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("stage host died without output");

  const recordedAt = h.ports.now();
  h.ports.conversationRestartCut = () => ({ recordedAt });
  for (let tick = 0; tick < 3; tick += 1) {
    h.advanceWallClock(60_000);
    await tickPipelines([], h.ports);
  }

  const lane = loadPipelines()[0]!;
  expect(lane.runs[0]!.attempts).toHaveLength(2);
  expect(lane.runs[0]!.attempts[0]!.error).toBe("interrupted by a Delegatus restart; replaced by a fresh stage attempt");
  expect(lane.runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "restart" });
  expect(h.spawnInputs[1]!.prompt).not.toContain("died without output");
});

test.each(["idle-to-working", "busy-to-terminal"] as const)("restart recovery drops stale evidence for %s before dispatch", async (race) => {
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", engine: "codex", model: "gpt-5.6-sol", prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  const firstRecordAt = Date.parse(attempt.startedAt!) + 1;
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: firstRecordAt });
  let releaseEpoch!: () => void;
  let markEpochRead!: () => void;
  const epochGate = new Promise<void>((resolve) => { releaseEpoch = resolve; });
  const epochRead = new Promise<void>((resolve) => { markEpochRead = resolve; });
  let interruptReads = 0;
  let sends = 0;
  const raced: PipelinePorts = { ...h.ports,
    restartRecoveryBootId: () => "race-boot",
    conversationTurnInterrupted: async () => {
      interruptReads += 1;
      return race === "idle-to-working" && interruptReads > 1 ? null : "idle";
    },
    runtimeHostEpoch: async () => { markEpochRead(); await epochGate; return 7; },
    resumeSeveredTurn: async () => { sends += 1; return true; },
  };
  const ticking = tickPipelines([entry(attempt.agentPath!)], raced);
  await epochRead;
  if (race === "idle-to-working") {
    h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: firstRecordAt + 1 });
  } else {
    h.finish(attempt.agentPath!, "pass", "Work finished");
    const terminal = h.messages.get(attempt.agentPath!)!;
    h.durableTurns.set(attempt.agentPath!, { turn: "terminal", message: terminal, lastRecordAt: terminal.ts });
  }
  releaseEpoch();
  await ticking;

  expect(sends).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restartRecovery).toBeUndefined();
  if (race === "busy-to-terminal") expect(loadPipelines()[0]!.state).toBe("completed");
  else expect(loadPipelines()[0]!.state).toBe("running");
});


test("restart retry-stage accepts only a confirmed stalled running attempt under expectedAttempt", async () => {
  const h = harness();
  const lane = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const stored = loadPipelines()[0]!;
  const attempt = stored.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([stored]);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
  const restarted = { ...h.ports, spawnReceipt: () => ({ state: "completed", conversationId: attempt.conversationId, transcript: attempt.agentPath, paneId: null }) as ReturnType<PipelinePorts["spawnReceipt"]>, conversationTurnInterrupted: async () => "stalled" as const };
  const request = { action: "retry-stage", expectedStageId: stored.cursor!.stageId, expectedAttempt: attempt.n } as const;
  expect((await patchPipeline(lane.id, { ...request, expectedAttempt: attempt.n + 1 }, restarted)).code).toBe("STAGE_CHANGED");
  expect((await patchPipeline(lane.id, request, { ...restarted, conversationTurnInterrupted: async () => null })).error).toBeDefined();
  expect((await patchPipeline(lane.id, { action: "retry-stage" }, restarted)).error).toBeDefined();
  expect((await patchPipeline(lane.id, request, restarted)).error).toBeUndefined();
  expect(h.calls.some((call) => call.startsWith("stop-host:"))).toBe(true);
  expect((await patchPipeline(lane.id, request, restarted)).error).toBeDefined();
  await tickPipelines([], restarted);
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.n).toBe(attempt.n + 1);
});

test.each(["terminal", "progress"] as const)("running retry-stage preserves %s evidence written during host stop", async (race) => {
  const h = harness();
  const lane = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const stored = loadPipelines()[0]!;
  const attempt = stored.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([stored]);
  const initialRecordAt = Date.parse(attempt.startedAt!) + 1;
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: initialRecordAt });
  const stopping: PipelinePorts = { ...h.ports,
    conversationTurnInterrupted: async () => "stalled",
    stopInterruptedStageAgent: async () => {
      if (race === "terminal") {
        h.finish(attempt.agentPath!, "pass", "Finished as stop was confirmed");
        const message = h.messages.get(attempt.agentPath!)!;
        h.durableTurns.set(attempt.agentPath!, { turn: "terminal", message, lastRecordAt: message.ts });
      } else {
        h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: initialRecordAt + 1 });
      }
      return { outcome: "stopped" };
    },
  };

  const result = await patchPipeline(lane.id, {
    action: "retry-stage", expectedStageId: stored.cursor!.stageId, expectedAttempt: attempt.n,
  }, stopping);
  const after = loadPipelines()[0]!;
  expect(after.runs[0]!.attempts).toHaveLength(1);
  expect(after.runs[0]!.attempts[0]!.n).toBe(attempt.n);
  if (race === "terminal") {
    expect(result.error).toBeUndefined();
    expect(after.runs[0]!.attempts[0]!.verdict).toEqual({ status: "pass" });
    expect(["passed", "committing"]).toContain(after.runs[0]!.attempts[0]!.state);
  } else {
    expect(result.status).toBe(409);
    expect(result.error).toContain("made progress while its host was stopping");
    expect(after.state).toBe("running");
    expect(after.runs[0]!.attempts[0]!.state).toBe("running");
  }
  expect(h.spawnInputs).toHaveLength(1);
});


test("restart recovery reads restored idle and dead turns from the runtime snapshot", async () => {
  await withRuntimeSnapshot((requestNumber) => ({ runtime: { hostEpoch: 7 }, sessions: [
    { conversationId: "idle-stage", host: "alive", turn: requestNumber === 0 ? "idle" : "running", attentionIds: [] },
    { conversationId: "dead-stage", host: "dead", turn: "running", attentionIds: [] },
    { conversationId: "permission-stage", host: "alive", turn: "idle", attentionIds: ["permission"] },
  ] }), async () => {
    const ports = defaultPipelinePorts();
    expect(await ports.conversationTurnInterrupted!("idle-stage")).toBe("idle");
    expect(await ports.conversationTurnInterrupted!("dead-stage")).toBe("dead");
    expect(await ports.conversationTurnInterrupted!("permission-stage")).toBeNull();
    expect(await ports.conversationTurnInterrupted!("unknown-stage")).toBeNull();
    // A fresh reader now sees another turn. The old ports retain their idle
    // evidence, which is why restart delivery must carry the queue policy.
    expect(await defaultPipelinePorts().conversationAgentActive("idle-stage")).toBe(true);
    expect(await ports.conversationTurnInterrupted!("idle-stage")).toBe("idle");
  });
});


test("restart recovery preserves working turns and pending deliveries and parks unconfirmed host termination", async () => {
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
  let sends = 0;
  const restarted: PipelinePorts = { ...h.ports,
    spawnReceipt: () => ({ state: "completed", conversationId: attempt.conversationId, transcript: attempt.agentPath, paneId: null }) as ReturnType<PipelinePorts["spawnReceipt"]>,
    restartRecoveryBootId: () => "next-boot",
    conversationTurnInterrupted: async () => "stalled",
    resumeSeveredTurn: async () => { sends += 1; return true; } };
  await tickPipelines([entry(attempt.agentPath!)], { ...restarted, conversationTurnInterrupted: async () => null });
  expect(sends).toBe(0);
  await tickPipelines([entry(attempt.agentPath!)], { ...restarted, conversationDeliveryOutstanding: () => true });
  expect(sends).toBe(0);
  h.setStageHost(attempt.conversationId!, { outcome: "unconfirmed", operationId: null, detail: "termination is not confirmed" });
  await tickPipelines([entry(attempt.agentPath!)], restarted);
  expect(sends).toBe(0);
  expect(loadPipelines()[0]!.stateDetail).toContain("confirm termination");
  // The unresolved host cannot be replaced by manual retry either.
  expect((await patchPipeline(lane.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 }, restarted)).error).toBeDefined();
});


test("restart leaves a recorded stage report authoritative until its verdict is written", async () => {
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  attempt.hostEpoch = 1;
  savePipelines([lane]);
  const report = await engineModule.reportStageCompletion({ verdict: "pass", findings: [], summary: "Work finished" },
    { kind: "agent", role: "builder", conversationId: attempt.conversationId }, h.ports);
  expect(report.error).toBeUndefined();
  const lastRecordAt = Date.parse(h.ports.now()) - 4 * 60_000;
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt });
  let sends = 0;
  const restarted: PipelinePorts = { ...h.ports, restartRecoveryBootId: () => "report-boot",
    runtimeHostEpoch: async () => 2,
    conversationTurnInterrupted: async () => "idle", resumeSeveredTurn: async () => { sends += 1; return true; } };
  await tickPipelines([entry(attempt.agentPath!)], restarted);
  h.advanceWallClock(4 * 60_000);
  await tickPipelines([entry(attempt.agentPath!)], restarted);
  expect(sends).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.state).toBe("running");
  const finalEntry = h.finish(attempt.agentPath!, "pass");
  const message = h.messages.get(attempt.agentPath!)!;
  h.durableTurns.set(attempt.agentPath!, { turn: "terminal", message, lastRecordAt: message.ts });
  await tickPipelines([finalEntry], restarted);
  expect(loadPipelines()[0]!.state).toBe("completed");
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
});


test("terminal stage evidence arriving during the final restart stop settles without a replacement", async () => {
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `restart-stop-registry-${crypto.randomUUID()}.json`));
  const transcriptPath = path.join(process.env.LLV_STATE_DIR!, `restart-stop-${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(transcriptPath, "{}\n");
  const conversation = registry.ensureConversation("codex", transcriptPath, "test-account");
  attempt.conversationId = conversation.id;
  attempt.agentPath = transcriptPath;
  savePipelines([lane]);
  setAgentRegistryForTests(registry);
  const lastRecordAt = Date.parse(attempt.startedAt!) + 1;
  h.durableTurns.set(transcriptPath, { turn: "busy", message: null, lastRecordAt });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  let stopCompleted = false;
  try {
    await withRuntimeSnapshot((requestNumber) => {
      stopCompleted = true;
      fs.appendFileSync(transcriptPath, "terminal record arrived during the host snapshot\n");
      h.finish(transcriptPath, "pass", "Completed during stop");
      const message = h.messages.get(transcriptPath)!;
      h.durableTurns.set(transcriptPath, { turn: "terminal", message, lastRecordAt: message.ts });
      expect(requestNumber).toBe(0);
      return { runtime: { hostEpoch: 7 }, sessions: [
        { conversationId: conversation.id, host: "dead", turn: "running", attentionIds: [] },
      ] };
    }, async () => {
      const production = defaultPipelinePorts();
      const stopping: PipelinePorts = { ...h.ports,
        conversationTurnInterrupted: async () => "idle",
        stopInterruptedStageAgent: production.stopInterruptedStageAgent,
      };
      await tickPipelines([entry(transcriptPath)], stopping);
      await tickPipelines([], stopping);
      expect(stopCompleted).toBe(true);
      expect(loadPipelines()[0]!.state).toBe("completed");
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "passed", verdict: { status: "pass" } });
    });
  } finally {
    setAgentRegistryForTests(null);
  }
});


test("restart retry rejects an incomplete receipt identity before stopping or parking its attempt", async () => {
  const h = harness();
  const lane = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const stored = loadPipelines()[0]!;
  const attempt = stored.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([stored]);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null });
  const callsBefore = h.calls.length;
  const result = await patchPipeline(lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: attempt.n, stageId: "plan" },
    { ...h.ports, conversationTurnInterrupted: async () => "stalled" });
  expect(result.status).toBe(400);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(h.calls.slice(callsBefore).some((call) => call.startsWith("stop-host:"))).toBe(false);
});

test("running restart retry preserves an owed deploy continuation before it enters delivery", async () => {
  const h = harness();
  const lane = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const stored = loadPipelines()[0]!;
  const attempt = stored.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([stored]);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null });
  const callsBefore = h.calls.length;
  const result = await patchPipeline(lane.id, { action: "retry-stage", expectedStageId: stored.cursor!.stageId, expectedAttempt: attempt.n }, {
    ...h.ports, conversationTurnInterrupted: async () => "idle",
    conversationInterruption: () => ({ state: "owed", recordedAt: h.ports.now(), resolvedAt: null }),
  });
  expect(result.status).toBe(409);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(h.calls.slice(callsBefore).some((call) => call.startsWith("stop-host:"))).toBe(false);
});

test.each(["pending", "deploy"] as const)("restart-parked retry preserves its %s delivery obligation before host effects", async (held) => {
  const h = harness();
  const lane = await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const stored = loadPipelines()[0]!;
  const attempt = stored.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([stored]);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  h.setStageHost(attempt.conversationId!, { outcome: "unconfirmed", operationId: null, detail: "termination is not confirmed" });
  const restarted: PipelinePorts = { ...h.ports, conversationTurnInterrupted: async () => "idle", resumeSeveredTurn: async () => false };
  await tickPipelines([entry(attempt.agentPath!)], restarted);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  const callsBefore = h.calls.length;
  const result = await patchPipeline(lane.id, { action: "retry-stage", expectedStageId: stored.cursor!.stageId, expectedAttempt: attempt.n }, {
    ...restarted,
    conversationDeliveryOutstanding: () => held === "pending",
    conversationInterruption: () => held === "deploy" ? { state: "owed", recordedAt: h.ports.now(), resolvedAt: null } : null,
  });
  expect(result.status).toBe(409);
  expect(h.calls.slice(callsBefore).some((call) => call.startsWith("stop-host:"))).toBe(false);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
});


test.each([true, false])("restart recovery does not message the old conversation for a severed turn: %s", async (sameBoot) => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  attempt.hostEpoch = 1;
  const at = h.ports.now();
  const lastRecordAt = Date.parse(attempt.startedAt!) + 1;
  attempt.severedTurn = { epoch: 2, sightedAt: at, silentSince: lastRecordAt, resumedAt: at, clientMessageId: "existing-continuation" };
  savePipelines([lane]);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt });
  let sends = 0;
  const restarted: PipelinePorts = { ...h.ports, runtimeHostEpoch: async () => 2,
    restartRecoveryBootStartedAt: () => Date.parse(at) + (sameBoot ? -1000 : 1000),
    conversationTurnInterrupted: async () => "idle", resumeSeveredTurn: async () => { sends += 1; return true; } };
  await tickPipelines([entry(attempt.agentPath!)], restarted);
  expect(sends).toBe(0);
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(attempt.agentPath!)], restarted);
  expect(loadPipelines()[0]!.runs[0]!.attempts.length).toBe(sameBoot ? 1 : 2);
  expect(sends).toBe(0);
});


test.each([true, false])("restart replaces a delivered deploy-cut stage without messaging its old conversation: %s", async (sameBoot) => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  const deliveredAt = h.ports.now();
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
  let sends = 0;
  const restarted = { ...h.ports, restartRecoveryBootId: () => "deploy-boot",
    restartRecoveryBootStartedAt: () => Date.parse(deliveredAt) + (sameBoot ? -1000 : 1000),
    conversationInterruption: () => ({ state: "delivered" as const, recordedAt: deliveredAt, resolvedAt: deliveredAt }),
    conversationTurnInterrupted: async () => "idle" as const,
    resumeSeveredTurn: async () => { sends += 1; return true; } };
  await tickPipelines([entry(attempt.agentPath!)], restarted);
  expect(sends).toBe(0);
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(attempt.agentPath!)], restarted);
  expect(loadPipelines()[0]!.runs[0]!.attempts.length).toBe(2);
  expect(sends).toBe(0);
});

test("restart leaves a worker adopted after dead evidence running", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  const id = attempt.conversationId!;
  let killedAdopted = false;
  let sent = 0;
  await withRuntimeSnapshot((number) => ({ runtime: { hostEpoch: 7 }, sessions: [
    { conversationId: id, host: number === 0 ? "dead" : "alive", turn: "running", attentionIds: [] },
  ] }), async () => {
    const production = defaultPipelinePorts();
    const resumed = { ...h.ports, conversationTurnInterrupted: production.conversationTurnInterrupted,
      durableTurnEvidence: async () => {
        expect(await defaultPipelinePorts().conversationAgentActive(id)).toBe(true);
        return { turn: "busy" as const, message: null, lastRecordAt: Date.parse(attempt.startedAt!) + 1 };
      },
      stopInterruptedStageAgent: production.stopInterruptedStageAgent,
      stopStageAgent: async () => { killedAdopted = true; return { outcome: "stopped" as const }; },
      resumeSeveredTurn: async () => { sent += 1; return true; },
    };
    await tickPipelines([entry(attempt.agentPath!)], resumed);
  });
  expect(killedAdopted).toBe(false);
  expect(sent).toBe(0);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restartRecovery).toBeUndefined();
});

/* A stage whose agent keeps working after its turn ended.

   The host goes idle when the turn ends, and a Claude CLI then continues by
   itself on a background-command notification, so "host idle, transcript busy"
   is what an agent at work looks like as well as what a cut turn looks like. */
test("an idle host whose transcript is still growing is left alone, and one silent for the whole bound is recovered", async () => {
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", engine: "claude", model: "fable", prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  const idle: PipelinePorts = { ...h.ports,
    restartRecoveryBootId: () => "same-boot",
    restartRecoveryBootStartedAt: () => Date.parse(attempt.startedAt!) - 60_000,
    conversationTurnInterrupted: async () => "idle",
  };
  const stops = () => h.calls.filter((call) => call.startsWith("stop-host:")).length;
  const record = () => h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });

  // The continuation writes a record every few minutes for well over the bound: never interrupted.
  for (let step = 0; step < 8; step += 1) {
    record();
    h.advanceWallClock(3 * 60_000);
    await tickPipelines([entry(attempt.agentPath!)], idle);
  }
  // One long step just inside the bound is still growing (the harness clock also moves on every read).
  record();
  h.advanceWallClock(IDLE_TURN_QUIET_MS - 60_000);
  await tickPipelines([entry(attempt.agentPath!)], idle);
  expect(stops()).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "running" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restartRecovery).toBeUndefined();

  // An undated open transcript proves no silence either.
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(attempt.agentPath!)], idle);
  expect(stops()).toBe(0);

  // A really interrupted turn: the same record is still the newest once the whole bound has passed.
  record();
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(attempt.agentPath!)], idle);
  expect(stops()).toBe(1);
  const attempts = loadPipelines()[0]!.runs[0]!.attempts;
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toMatchObject({ state: "failed", restartRecovery: { replacementAttempt: 2 } });
});

test.each([
  { interruption: "dead", error: "stage host was lost while its turn was open", detail: "lost its host while its turn was open", parked: "lost its host too" },
  { interruption: "idle", error: "stopped by Delegatus after its turn went silent", detail: "was stopped by Delegatus after its turn went silent", parked: "went silent too" },
  { interruption: "stalled", error: "stopped by Delegatus after its turn went silent", detail: "was stopped by Delegatus after its turn went silent", parked: "went silent too" },
] as const)("a replaced attempt names its cause when no restart happened: $interruption", async ({ interruption, error, detail, parked }) => {
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", engine: "claude", model: "fable", prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
  // This process booted before the attempt started and no host generation changed: nothing restarted.
  const sameBoot: PipelinePorts = { ...h.ports,
    restartRecoveryBootId: () => "same-boot",
    restartRecoveryBootStartedAt: () => Date.parse(attempt.startedAt!) - 60_000,
    conversationTurnInterrupted: async () => interruption,
  };
  // A host found dead has nothing to stop; a silent one is alive until this stop ends it.
  if (interruption !== "dead") h.setStageHost(attempt.conversationId!, { outcome: "stopped" });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(attempt.agentPath!)], sameBoot);
  const replaced = loadPipelines()[0]!;
  expect(replaced.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: `${error}; replaced by a fresh stage attempt` });
  expect(replaced.stateDetail).toBe(`stage attempt 1 ${detail}; fresh attempt 2 is starting`);
  expect(replaced.runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: interruption === "dead" ? "host-lost" : "engine-stop" });
  await tickPipelines([], sameBoot);
  expect(h.spawnInputs[1]!.prompt).toContain(`stage attempt 1 ${detail}.`);
  expect(`${replaced.runs[0]!.attempts[0]!.error} ${replaced.stateDetail} ${h.spawnInputs[1]!.prompt}`).not.toContain("restart");

  await tickPipelines([entry(attempt.agentPath!)], sameBoot);
  const again = loadPipelines()[0]!;
  const replacement = again.runs[0]!.attempts[1]!;
  replacement.paneId = null;
  savePipelines([again]);
  h.durableTurns.set(replacement.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(replacement.startedAt!) + 1 });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(replacement.agentPath!)], sameBoot);
  const parkedLane = loadPipelines()[0]!;
  expect(parkedLane.state).toBe("needs_decision");
  expect(parkedLane.stateDetail).toBe(`the automatic replacement attempt ${parked}; retry-stage to start another attempt`);
  expect(parkedLane.stateDetail).not.toContain("boot");
});

test("a replacement recorded before causes were told apart is described without naming a restart", async () => {
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", engine: "claude", model: "fable", prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
  await tickPipelines([entry(attempt.agentPath!)], { ...h.ports, conversationTurnInterrupted: async () => "dead" });
  const replaced = loadPipelines()[0]!;
  // What an older release stored: the context without a cause.
  delete replaced.runs[0]!.attempts[1]!.restartContext!.cause;
  savePipelines([replaced]);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs[1]!.prompt).toContain("stage attempt 1 was interrupted. Continue the same stage input");
});

test("a stage that keeps working after its turn ended keeps its host through the recovery tick and the deferred cursor write", async () => {
  const h = harness();
  const f = await idleStageHostFixture(h);
  /* Time is faked where the chain depends on it: the binding's deferred write
     is captured with its delay instead of being armed, and run by hand once the
     recovery tick is over. */
  const realSetTimeout = globalThis.setTimeout;
  const deferred: Array<{ run: () => void; delayMs: number }> = [];
  try {
    const stop = await f.bind(30_000);
    const bound = structuredClone(f.row());
    // The turn ended: the host is idle and names no turn. The CLI then continues
    // by itself on a background-command notification: the transcript opens a
    // turn and grows, and the host reports cursor-only steps with no turn id.
    const continuedAt = Date.parse(h.ports.now());
    fs.appendFileSync(f.transcriptPath, "background command notification\n");
    h.durableTurns.set(f.transcriptPath, { turn: "busy", message: null, lastRecordAt: continuedAt });
    globalThis.setTimeout = ((run: () => void, delayMs: number) => {
      deferred.push({ run, delayMs });
      return { unref() {} };
    }) as unknown as typeof setTimeout;
    try {
      f.host.emit({ eventCursor: 173 });
      f.host.emit({ eventCursor: 174 });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(deferred.map((timer) => timer.delayMs)).toEqual([30_000]);
    expect(f.row().structuredHost!.eventCursor).toBe(172);

    // The recovery tick, two seconds into the continuation, on the product's own classifier and stop.
    h.advanceWallClock(2_000);
    await Bun.sleep(5);
    await withRuntimeSnapshot(f.snapshot, async () => {
      const production = defaultPipelinePorts({ termination: f.termination });
      expect(await production.conversationTurnInterrupted!(f.attempt.conversationId!)).toBe("idle");
      await tickPipelines([entry(f.transcriptPath)], { ...h.ports,
        restartRecoveryBootId: () => "same-boot",
        restartRecoveryBootStartedAt: () => Date.parse(f.attempt.startedAt!) - 60_000,
        conversationTurnInterrupted: production.conversationTurnInterrupted,
        stopInterruptedStageAgent: production.stopInterruptedStageAgent,
      });
    });
    expect(f.row().structuredTerminationSurvivors ?? []).toEqual([]);
    expect(f.row()).toEqual(bound);
    expect(f.journal()).toEqual([]);
    expect(f.signals).toEqual([]);

    // Thirty seconds after the first cursor-only step the deferred write fires.
    deferred[0]!.run();
    expect(f.host.releaseCalls).toBe(0);
    expect(f.row()).toMatchObject({ status: "idle", claimOwner: f.claimOwner, structuredHost: { eventCursor: 174 } });
    const after = loadPipelines()[0]!;
    expect(after.state).toBe("running");
    expect(after.runs[0]!.attempts).toHaveLength(1);
    expect(after.runs[0]!.attempts[0]).toMatchObject({ state: "running" });
    expect(after.runs[0]!.attempts[0]!.restartRecovery).toBeUndefined();

    // The stage then finishes on the host it kept.
    const finished = h.finish(f.transcriptPath, "pass", "Done after the push");
    const message = h.messages.get(f.transcriptPath)!;
    h.durableTurns.set(f.transcriptPath, { turn: "terminal", message, lastRecordAt: message.ts });
    await tickPipelines([finished], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ verdict: { status: "pass" } });
    stop();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    await f.end();
  }
});

test("an automatic stop withdrawn after it captured the tree leaves the registry row as it was", async () => {
  const h = harness();
  const f = await idleStageHostFixture(h);
  try {
    const before = structuredClone(f.row());
    // The agent writes to its transcript between the capture and the first authority check.
    const capture = f.registry.captureStructuredTerminationSurvivors.bind(f.registry);
    let captured: unknown = null;
    f.registry.captureStructuredTerminationSurvivors = (...args) => {
      const receipt = capture(...args);
      captured = structuredClone(f.row().structuredTerminationSurvivors);
      fs.appendFileSync(f.transcriptPath, "the agent resumed work\n");
      return receipt;
    };
    await withRuntimeSnapshot(f.snapshot, async () => {
      const production = defaultPipelinePorts({ termination: f.termination });
      expect(await production.stopInterruptedStageAgent!(f.target, { allowIdle: true })).toBeNull();
    });
    expect(captured).toHaveLength(1);
    expect(f.signals).toEqual([]);
    expect(f.row()).toEqual(before);
    expect(f.journal().map((line) => `${line.event}:${line.source}`)).toEqual([
      "captured:pipeline-stage-stop build:1", "withdrawn:pipeline-stage-stop build:1",
    ]);
    // The row is free again: the host's own next write lands.
    expect(f.registry.setStructuredHostClaimed(f.key, { ...before.structuredHost!, eventCursor: 173 }, "idle", f.claimOwner, 1))
      .toMatchObject({ structuredHost: { eventCursor: 173 } });
  } finally {
    await f.end();
  }
});

test("a really interrupted idle turn is stopped by the product's own stop and replaced, and says who stopped it", async () => {
  const h = harness();
  const f = await idleStageHostFixture(h);
  try {
    h.durableTurns.set(f.transcriptPath, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
    h.advanceWallClock(IDLE_TURN_QUIET_MS);
    await withRuntimeSnapshot(f.snapshot, async () => {
      const production = defaultPipelinePorts({ termination: f.termination });
      await tickPipelines([entry(f.transcriptPath)], { ...h.ports,
        restartRecoveryBootId: () => "same-boot",
        restartRecoveryBootStartedAt: () => Date.parse(f.attempt.startedAt!) - 60_000,
        conversationTurnInterrupted: production.conversationTurnInterrupted,
        stopInterruptedStageAgent: production.stopInterruptedStageAgent,
      });
    });
    // The stop read through its own capture, went on to signal, and retired the row.
    expect(f.signals).toEqual([`SIGTERM:${f.hostPid}`]);
    expect(f.journal().map((line) => line.event)).toEqual(["captured"]);
    expect(f.row().structuredHost?.process ?? null).toBeNull();
    const attempts = loadPipelines()[0]!.runs[0]!.attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ state: "failed", error: "stopped by Delegatus after its turn went silent; replaced by a fresh stage attempt" });
    expect(attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "engine-stop" });
  } finally {
    await f.end();
  }
});

test("an automatic stop whose first step is the runtime's own release still retires the row and replaces the attempt", async () => {
  const h = harness();
  const f = await idleStageHostFixture(h);
  try {
    await f.bind(30_000);
    h.durableTurns.set(f.transcriptPath, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
    h.advanceWallClock(IDLE_TURN_QUIET_MS);
    const release = runtimeReleaseOf(f);
    await withRuntimeSnapshot(f.snapshot, async () => {
      const production = defaultPipelinePorts({ termination: { ...f.termination, terminateOwnedHost: release.terminateOwnedHost } });
      await tickPipelines([entry(f.transcriptPath)], { ...h.ports,
        restartRecoveryBootId: () => "same-boot",
        restartRecoveryBootStartedAt: () => Date.parse(f.attempt.startedAt!) - 60_000,
        conversationTurnInterrupted: production.conversationTurnInterrupted,
        stopInterruptedStageAgent: production.stopInterruptedStageAgent,
      });
    });
    // The runtime's own retirement was refused by the captured tree, and the host's terminal write moved the row.
    expect(release.retired).toEqual([false]);
    // The stop did not read its own consequences as somebody else's change: the ladder retired the row.
    const row = f.row();
    expect(row.status).toBe("dead");
    expect(row.claimOwner).toBeNull();
    expect(row.structuredHost?.process ?? null).toBeNull();
    expect(row.structuredTerminationSurvivors ?? []).toEqual([]);
    expect(f.journal().map((line) => line.event)).toEqual(["captured"]);
    const lane = loadPipelines()[0]!;
    expect(lane.state).toBe("running");
    expect(lane.runs[0]!.attempts).toHaveLength(2);
    expect(lane.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: "stopped by Delegatus after its turn went silent; replaced by a fresh stage attempt" });
  } finally {
    await f.end();
  }
});

test("a descendant that outlives the runtime's release is still signalled, and the attempt is replaced", async () => {
  const h = harness();
  const f = await idleStageHostFixture(h);
  try {
    await f.bind(30_000);
    h.durableTurns.set(f.transcriptPath, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
    h.advanceWallClock(IDLE_TURN_QUIET_MS);
    /* A descendant that left the host's process group. It is a number only: no
       such process is consulted, and every signal here is recorded, never sent. */
    const CHILD = 4_190_001;
    let rootGone = false;
    let childGone = false;
    const signals: string[] = [];
    const release = runtimeReleaseOf(f, () => { rootGone = true; });
    const termination = { ...f.termination,
      ppidMap: () => new Map<number, number>([[f.hostPid, 1], [CHILD, f.hostPid]]),
      pidAlive: (pid: number) => (pid === CHILD && !childGone) || (pid === f.hostPid && !rootGone),
      processIdentity: (pid: number) => pid === CHILD ? (childGone ? null : "child:start") : f.termination.processIdentity(pid),
      signal: (pid: number, signal: NodeJS.Signals) => { signals.push(`${signal}:${pid}`); if (pid === CHILD) childGone = true; },
      terminateOwnedHost: release.terminateOwnedHost };
    await withRuntimeSnapshot(f.snapshot, async () => {
      const production = defaultPipelinePorts({ termination });
      await tickPipelines([entry(f.transcriptPath)], { ...h.ports,
        restartRecoveryBootId: () => "same-boot",
        restartRecoveryBootStartedAt: () => Date.parse(f.attempt.startedAt!) - 60_000,
        conversationTurnInterrupted: production.conversationTurnInterrupted,
        stopInterruptedStageAgent: production.stopInterruptedStageAgent,
      });
    });
    expect(signals).toEqual([`SIGTERM:${CHILD}`]);
    const row = f.row();
    expect(row.status).toBe("dead");
    expect(row.structuredHost?.process ?? null).toBeNull();
    expect(row.structuredTerminationSurvivors ?? []).toEqual([]);
    const lane = loadPipelines()[0]!;
    expect(lane.state).toBe("running");
    expect(lane.runs[0]!.attempts.map((item) => item.state)).toEqual(["failed", "pending"]);
  } finally {
    await f.end();
  }
});

test("a stop still withdraws when the host resumes before the runtime released anything", async () => {
  const h = harness();
  const f = await idleStageHostFixture(h);
  try {
    const before = structuredClone(f.row());
    let asked = 0;
    await withRuntimeSnapshot(f.snapshot, async () => {
      const production = defaultPipelinePorts({ termination: { ...f.termination,
        // The runtime holds nothing of this host, and the agent writes while it is asked.
        terminateOwnedHost: async () => { asked += 1; fs.appendFileSync(f.transcriptPath, "the agent resumed work\n"); return false; } } });
      expect(await production.stopInterruptedStageAgent!(f.target, { allowIdle: true })).toBeNull();
    });
    expect(asked).toBe(1);
    expect(f.signals).toEqual([]);
    expect(f.row()).toEqual(before);
    expect(f.journal().map((line) => line.event)).toEqual(["captured", "withdrawn"]);
  } finally {
    await f.end();
  }
});

test("an attempt that worked on after a restart and is stopped for silence later is not called a restart", async () => {
  const h = harness();
  const { attempt, ports } = await attemptThatWorkedOnAfterRestart(h);
  h.setStageHost(attempt.conversationId!, { outcome: "stopped" });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(attempt.agentPath!)], ports("idle"));
  const replaced = loadPipelines()[0]!;
  expect(replaced.runs[0]!.attempts[0]!.error).toBe("stopped by Delegatus after its turn went silent; replaced by a fresh stage attempt");
  expect(replaced.stateDetail).toBe("stage attempt 1 was stopped by Delegatus after its turn went silent; fresh attempt 2 is starting");
  expect(replaced.runs[0]!.attempts[1]!.restartContext).toMatchObject({ cause: "engine-stop" });
  await tickPipelines([], h.ports);
  expect(h.spawnInputs[1]!.prompt).toContain("was stopped by Delegatus after its turn went silent");
  expect(h.spawnInputs[1]!.prompt).not.toContain("restart");
});

test("an attempt that worked on after a restart and whose host is found gone later is not called a restart", async () => {
  const h = harness();
  const { attempt, ports } = await attemptThatWorkedOnAfterRestart(h);
  await tickPipelines([entry(attempt.agentPath!)], ports("dead"));
  const replaced = loadPipelines()[0]!;
  expect(replaced.runs[0]!.attempts[0]!.error).toBe("stage host was lost while its turn was open; replaced by a fresh stage attempt");
  expect(replaced.stateDetail).toBe("stage attempt 1 lost its host while its turn was open; fresh attempt 2 is starting");
  expect(replaced.runs[0]!.attempts[1]!.restartContext).toMatchObject({ cause: "host-lost" });
  await tickPipelines([], h.ports);
  expect(h.spawnInputs[1]!.prompt).toContain("lost its host while its turn was open");
  expect(h.spawnInputs[1]!.prompt).not.toContain("restart");
});

test("an attempt whose transcript did not grow after the restart is still called a restart", async () => {
  const h = harness();
  await create(h.ports, SILENT_RUN as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  // The newest record is from before the boot, one minute into the attempt.
  const bootAt = Date.parse(attempt.startedAt!) + 60_000;
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: bootAt - 1 });
  h.advanceWallClock(30 * 60_000);
  await tickPipelines([entry(attempt.agentPath!)], { ...h.ports,
    restartRecoveryBootId: () => "boot-2", restartRecoveryBootStartedAt: () => bootAt, conversationTurnInterrupted: async () => "dead" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.error).toBe("interrupted by a Delegatus restart; replaced by a fresh stage attempt");
  expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.restartContext).toMatchObject({ cause: "restart" });
});

test("retry-stage leaves an idle host whose transcript is still growing, and stops it once the transcript has been silent for the bound", async () => {
  const h = harness();
  const pipeline = await create(h.ports, SILENT_RUN as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  h.setStageHost(attempt.conversationId!, { outcome: "stopped" });
  const idle: PipelinePorts = { ...h.ports,
    restartRecoveryBootId: () => "same-boot",
    restartRecoveryBootStartedAt: () => Date.parse(attempt.startedAt!) - 60_000,
    conversationTurnInterrupted: async () => "idle" };
  const stops = () => h.calls.filter((call) => call.startsWith("stop-host:"));
  // The continuation wrote a record two seconds ago.
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
  h.advanceWallClock(2_000);
  await tickPipelines([entry(attempt.agentPath!)], idle);
  const young = await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 }, idle);
  expect(young).toMatchObject({ status: 409, error: "the running attempt is not confirmed stalled or has a pending delivery" });
  expect(stops()).toEqual([]);
  expect(loadPipelines()[0]).toMatchObject({ state: "running" });
  // The same record, a minute short of the bound and then past it.
  h.advanceWallClock(IDLE_TURN_QUIET_MS - 62_000);
  expect(await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 }, idle)).toMatchObject({ status: 409 });
  expect(stops()).toEqual([]);
  h.advanceWallClock(60_000);
  await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 }, idle);
  expect(stops()).toEqual([`stop-host:build:1:${attempt.conversationId}`]);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: "confirmed stalled attempt was stopped for retry" });
});

test("a recovery that parks names a restart only when the service restarted", async () => {
  const h = harness();
  await create(h.ports, SILENT_RUN as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
  h.setStageHost(attempt.conversationId!, { outcome: "unresolved", error: "1 process outlived the kill", survivors: [] });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  // The same boot the attempt started under: Delegatus's own stop of a silent host stayed unresolved.
  await tickPipelines([entry(attempt.agentPath!)], { ...h.ports,
    restartRecoveryBootId: () => "same-boot",
    restartRecoveryBootStartedAt: () => Date.parse(attempt.startedAt!) - 60_000,
    conversationTurnInterrupted: async () => "idle" });
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toBe("interrupted-turn recovery could not confirm termination of the interrupted stage host");
  expect(parked.runs[0]!.attempts[0]!.error).toBe(parked.stateDetail);
  /* The reservation refusal needs a stage whose run record is missing, which no
     tick reaches for the attempt it is replacing; its words are read here. */
  for (const step of ["termination", "reservation"] as const) {
    expect(interruptedTurnRecoveryParkDetail(step, false)).not.toContain("restart");
    expect(interruptedTurnRecoveryParkDetail(step, true)).toStartWith("restart recovery could not ");
  }
  expect(interruptedTurnRecoveryParkDetail("reservation", false)).toBe("interrupted-turn recovery could not reserve a fresh stage attempt");
});

test("the same unresolved stop after a real restart keeps naming the restart", async () => {
  const h = harness();
  await create(h.ports, SILENT_RUN as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
  h.setStageHost(attempt.conversationId!, { outcome: "unresolved", error: "1 process outlived the kill", survivors: [] });
  await tickPipelines([entry(attempt.agentPath!)], { ...h.ports,
    restartRecoveryBootId: () => "boot-2",
    restartRecoveryBootStartedAt: () => Date.parse(attempt.startedAt!) + 60_000,
    conversationTurnInterrupted: async () => "dead" });
  expect(loadPipelines()[0]!.stateDetail).toBe("restart recovery could not confirm termination of the interrupted stage host");
});

/* A Claude CLI appends undated bookkeeping (last-prompt, cost-state) as it
   exits, and an undated newest record is dated by the file's mtime: every stop
   that ends a live Claude host moves the transcript's newest record under a
   turn that stays open. */
test("a host Delegatus stopped is recorded as stopped by Delegatus although its exit moved the transcript", async () => {
  const h = harness();
  const f = await idleStageHostFixture(h);
  try {
    await f.bind(30_000);
    h.durableTurns.set(f.transcriptPath, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
    h.advanceWallClock(IDLE_TURN_QUIET_MS);
    let exitRecordAt = 0;
    const release = runtimeReleaseOf(f, () => {
      exitRecordAt = Date.parse(h.ports.now());
      h.durableTurns.set(f.transcriptPath, { turn: "busy", message: null, lastRecordAt: exitRecordAt });
    });
    const sameBoot = { restartRecoveryBootId: () => "same-boot", restartRecoveryBootStartedAt: () => Date.parse(f.attempt.startedAt!) - 60_000 };
    await withRuntimeSnapshot(f.snapshot, async () => {
      const production = defaultPipelinePorts({ termination: { ...f.termination, terminateOwnedHost: release.terminateOwnedHost } });
      await tickPipelines([entry(f.transcriptPath)], { ...h.ports, ...sameBoot,
        conversationTurnInterrupted: production.conversationTurnInterrupted,
        stopInterruptedStageAgent: production.stopInterruptedStageAgent,
      });
    });
    expect(exitRecordAt).toBeGreaterThan(0);
    // The session is unhosted from here on, which is what the next tick reads.
    await tickPipelines([entry(f.transcriptPath)], { ...h.ports, ...sameBoot, conversationTurnInterrupted: async () => "dead" });
    const lane = loadPipelines()[0]!;
    expect(lane.runs[0]!.attempts).toHaveLength(2);
    expect(lane.runs[0]!.attempts[0]).toMatchObject({ state: "failed",
      error: "stopped by Delegatus after its turn went silent; replaced by a fresh stage attempt",
      restartRecovery: { stopped: { kind: "idle", restarted: false, lastRecordAt: exitRecordAt }, replacementAttempt: 2 } });
    expect(lane.runs[0]!.attempts[1]!.restartContext).toMatchObject({ previousAttempt: 1, cause: "engine-stop" });
    expect(h.spawnInputs.at(-1)!.prompt).toContain("stage attempt 1 was stopped by Delegatus after its turn went silent.");
    expect(`${lane.runs[0]!.attempts[0]!.error} ${h.spawnInputs.at(-1)!.prompt}`).not.toContain("lost");
  } finally {
    await f.end();
  }
});

test("an idle host cut by a restart is still called a restart after the stop's own exit record", async () => {
  const h = harness();
  const { attempt, stops, stopStageAgent } = await stageWhoseStopMovesTheTranscript(h,
    () => ({ turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) }));
  // The service booted one second into the attempt and the transcript has not grown since.
  const bootAt = Date.parse(attempt.startedAt!) + 1_000;
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: bootAt - 500 });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  const restarted = (interruption: "idle" | "dead"): PipelinePorts => ({ ...h.ports, stopStageAgent,
    restartRecoveryBootId: () => "boot-2", restartRecoveryBootStartedAt: () => bootAt, conversationTurnInterrupted: async () => interruption });
  await tickPipelines([entry(attempt.agentPath!)], restarted("idle"));
  await tickPipelines([entry(attempt.agentPath!)], restarted("dead"));
  expect(stops).toEqual(["build:1"]);
  const lane = loadPipelines()[0]!;
  expect(lane.runs[0]!.attempts).toHaveLength(2);
  expect(lane.runs[0]!.attempts[0]!.error).toBe("interrupted by a Delegatus restart; replaced by a fresh stage attempt");
  expect(lane.runs[0]!.attempts[1]!.restartContext).toMatchObject({ cause: "restart" });
});
