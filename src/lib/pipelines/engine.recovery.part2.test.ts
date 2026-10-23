import { expect, spyOn, test, spawn, fs, path, accountManager, engineModule, defaultPipelinePorts, tickPipelines, AgentRegistry, setAgentRegistryForTests, createPipelineFromRequest, loadPipelines, savePipelines, patchPipeline, RUN_STAGES, ORIGIN_MAIN_SHA, harness, durableStageTurnEvidence, create, forbiddenSleep, frozenWallClock, HOST_UNAVAILABLE, failedReceipt, stagedRecoveryHarness, aliveStagedLaunch, stageHostChild, productionHostSeams, activationDrainFixture, expectPipelineLeaseFree, reserveActivationOnly } from "./engine.fixture";
import type { Snapshot, PipelinePorts } from "./engine.fixture";

const RAW_ADMISSION_BUSY = ["database is locked", "database is busy", "SQLITE_BUSY", "SQLITE_LOCKED"] as const;



async function failedMembershipReplay() {
  const h = await reserveActivationOnly();
  const pending = loadPipelines()[0]!;
  const attempt = pending.runs[0]!.attempts[0]!;
  attempt.input = "Reserved stage input";
  pending.cursor!.input = attempt.input;
  attempt.spawnCalls = 1;
  attempt.activation!.prepareInput = false;
  attempt.activation!.input.prompt = "Materialized stage prompt";
  attempt.activation!.phase = "reserving";
  delete attempt.activation!.owner;
  savePipelines([pending]);
  const originalSpawn = h.ports.spawnAgent;
  const receipt = { ...failedReceipt("launch-membership", "conversation_membership", "task membership could not be recorded: state writer is busy during account commit"), neverBegan: true };
  let replayed = false;
  h.ports.spawnAgent = async (input, reserved) => {
    if (replayed) return originalSpawn(input, reserved);
    replayed = true;
    await reserved(receipt);
    return receipt;
  };
  h.ports.spawnReceipt = id => id === receipt.launchId ? receipt : null;
  const claims: string[] = [];
  h.ports.claimSpawnRetry = (_id, claim) => { claims.push(claim); return "claimed"; };
  return { h, receipt, claims, pending, attempt };
}


test("a launch whose recorded host exited without a transcript is replaced after its recovery budget", async () => {
  const host = await stageHostChild();
  await host.end();
  try {
    const f = await aliveStagedLaunch({ hostProcess: host.process, nativeTranscript: true });
    productionHostSeams(f);
    f.h.ports.stopStageAgent = (target, options) => defaultPipelinePorts().stopStageAgent(target, options);
    f.advance(24 * 60 * 60_000);
    await f.wake();
    const pipeline = loadPipelines()[0]!;
    expect(pipeline.runs[0]!.attempts).toHaveLength(2);
    expect(f.attempt().state).toBe("failed");
    expect(f.registry.spawnReceipt(f.attempt().launchId!)?.state).toBe("failed");
  } finally {
    setAgentRegistryForTests(null);
  }
});


test("fresh metadata cannot adopt a native turn older than this attempt", async () => {
  const f = await aliveStagedLaunch();
  f.advance(10 * 60_000);
  await f.wake();
  expect(loadPipelines()[0]!.state).toBe("needs_decision");

  const floor = Date.parse(f.attempt().startedAt!);
  const metadataAt = Date.parse(f.h.ports.now()) + 1_000;
  fs.writeFileSync(f.transcript, [
    { timestamp: new Date(floor - 50_000).toISOString(), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: new Date(floor - 40_000).toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Old turn" }] } },
    { timestamp: new Date(metadataAt).toISOString(), type: "session_meta", payload: { id: "stage" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");

  const evidence = await durableStageTurnEvidence("codex", f.transcript);
  expect(evidence).toMatchObject({
    turn: "busy",
    turnStartedAt: floor - 50_000,
    lastAgentEventAt: floor - 40_000,
    lastRecordAt: metadataAt,
  });

  await f.wake();

  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });
  expect(f.attempt()).toMatchObject({ state: "needs_decision", error: expect.stringContaining("stage spawn recovery stopped:") });
  expect(f.starts()).toBe(1);
});


test("a spawn-recovery park whose own agent then reports is reopened on that attempt and the report is accepted", async () => {
  const f = await aliveStagedLaunch();
  f.advance(10 * 60_000);
  await f.wake();
  const parked = loadPipelines()[0]!;
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: expect.stringContaining("stage spawn recovery stopped:") });
  const conversationId = f.attempt().conversationId!;
  const actor = { kind: "agent" as const, role: "builder", conversationId };

  // Nothing of this attempt in its transcript yet: the park stands.
  expect(await engineModule.reportStageCompletion({ verdict: "pass", summary: "done" }, actor, f.h.ports))
    .toMatchObject({ status: 409, code: "STAGE_REPORT_SETTLED" });

  f.working();
  const accepted = await engineModule.reportStageCompletion({ verdict: "pass", summary: "Fixed both findings" }, actor, f.h.ports);
  expect(accepted.error).toBeUndefined();
  expect(accepted).toMatchObject({ attempt: 1, report: { verdict: { status: "pass" } } });
  const reopened = loadPipelines()[0]!;
  expect(reopened).toMatchObject({ state: "running", stateDetail: null });
  expect(reopened.runs[0]!.attempts).toHaveLength(1);
  expect(f.attempt()).toMatchObject({ n: 1, state: "running", launchId: f.launchId(), agentPath: f.transcript, error: null });
  expect(f.attempt().report?.verdict.status).toBe("pass");
});


test("a spawn-recovery park left by an earlier controller reopens once its agent's turn is in the transcript", async () => {
  const f = await aliveStagedLaunch();
  f.advance(10 * 60_000);
  await f.wake();
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  f.working();
  await f.wake();
  expect(loadPipelines()[0]).toMatchObject({ state: "running", stateDetail: null });
  expect(f.attempt()).toMatchObject({ n: 1, state: "running", agentPath: f.transcript });
  expect(f.messages()).toBe(1);
});


test("completion recovery reads original operations outside the lease and accepts the current attempt", async () => {
  const f = await aliveStagedLaunch();
  f.advance(10 * 60_000);
  await f.wake();
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  f.working();
  const operationStatus = f.client.operationStatus.bind(f.client);
  f.client.operationStatus = async id => {
    expectPipelineLeaseFree();
    return operationStatus(id);
  };

  const result = await engineModule.reportStageCompletion({ verdict: "pass", summary: "Recovered completion" },
    { kind: "agent", role: "builder", conversationId: f.attempt().conversationId! }, f.h.ports);

  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ attempt: 1, report: { verdict: { status: "pass" } } });
  expect(f.attempt()).toMatchObject({ n: 1, state: "running", launchId: f.launchId(), agentPath: f.transcript });
  expect(f.starts()).toBe(1);
});


test("completion recovery refuses native evidence superseded before settlement", async () => {
  const f = await aliveStagedLaunch();
  f.advance(10 * 60_000);
  await f.wake();
  f.working();
  const durable = f.h.ports.durableTurnEvidence;
  let reads = 0;
  f.h.ports.durableTurnEvidence = async (...args) => {
    const evidence = await durable(...args);
    if (++reads === 2) {
      const { withPipelineMutation } = await import("./store");
      await withPipelineMutation(async (pipelines, persist) => {
        pipelines[0]!.runs[0]!.attempts[0]!.launchId = "replacement-launch";
        await persist();
      });
    }
    return evidence;
  };
  const result = await engineModule.reportStageCompletion({ verdict: "pass", summary: "Stale completion" },
    { kind: "agent", role: "builder", conversationId: f.attempt().conversationId! }, f.h.ports);

  expect(result).toMatchObject({ status: 409 });
  expect(result.error).toContain("already settled");
  expect(f.attempt()).toMatchObject({ launchId: "replacement-launch", state: "needs_decision" });
  expect(f.attempt().report).toBeUndefined();
  expect(f.starts()).toBe(1);
});


test("a permanent staged publication refusal parks with its cause", async () => {
  const f = await stagedRecoveryHarness("permanent");
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: "authentication denied" });
  expect(f.messages()).toBe(0);
  expect(f.starts()).toBe(1);
});


test("a restarted controller resumes the persisted wait without another spawn", async () => {
  const f = await stagedRecoveryHarness();
  await tickPipelines([], f.h.ports);
  const original = structuredClone(f.attempt());
  const modulePath = "./engine?staged-controller-restart";
  const restarted = await import(modulePath) as typeof engineModule;
  f.h.ports.spawnAgent = async () => { throw new Error("restart must never spawn"); };
  for (let i = 0; i < 3; i++) { f.advance(61_000); await restarted.tickPipelines([], { ...f.h.ports }); }
  expect(f.attempt()).toMatchObject({ n: original.n, launchId: original.launchId, state: "running", spawnCalls: 1 });
  expect(f.stages).toHaveBeenCalledTimes(1);
  expect(f.messages()).toBe(1);
});


test("concurrent controllers probe outside the lease and reject a cancelled attempt", async () => {
  const f = await stagedRecoveryHarness();
  await tickPipelines([], f.h.ports);
  f.advance(61_000);
  const read = f.client.operationStatus.bind(f.client);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  f.client.operationStatus = async (id) => { entered(); await blocked; return read(id); };
  const first = tickPipelines([], f.h.ports);
  await started;
  const second = tickPipelines([], { ...f.h.ports });
  const { withPipelineMutation } = await import("./store");
  await withPipelineMutation(async (pipelines, persist) => { pipelines[0]!.state = "paused"; await persist(); });
  release();
  await Promise.all([first, second]);
  expect(loadPipelines()[0]!.state).toBe("paused");
  expect(f.stages).toHaveBeenCalledTimes(1);
  expect(f.messages()).toBe(0);
});



test("a controller awaiting the staged host owner uses bounded observer backoff", async () => {
  const f = await stagedRecoveryHarness();
  const scheduled: number[] = [];
  f.h.ports.scheduleTick = (delay) => { scheduled.push(delay); };
  await tickPipelines([], f.h.ports);
  f.h.ports.recoverStagedLaunch = async () => {};
  f.advance(10_000);
  await tickPipelines([], f.h.ports);
  const first = f.attempt().controllerWait!;
  expect(first).toBeDefined();
  expect(scheduled.every((delay) => delay >= 1_000)).toBe(true);
  f.advance(2_000);
  await tickPipelines([], f.h.ports);
  expect(f.attempt().controllerWait!.rounds).toBeGreaterThan(first.rounds);
  expect(f.attempt().controllerWait!.retryMaxMs).toBe(60_000);
  expect(f.starts()).toBe(1);
  expect(f.messages()).toBe(0);
});



test("two recovery controllers complete one staged launch and dispatch one first message", async () => {
  const f = await stagedRecoveryHarness();
  await tickPipelines([], f.h.ports);
  f.advance(61_000);
  await Promise.all([f.recover(f.launchId(), () => true), f.recover(f.launchId(), () => true)]);
  f.advance(61_000);
  await Promise.all([f.recover(f.launchId(), () => true), f.recover(f.launchId(), () => true)]);
  await f.wake();
  expect(f.attempt()).toMatchObject({ n: 1, launchId: f.launchId(), state: "running", spawnCalls: 1 });
  expect(f.stages).toHaveBeenCalledTimes(1);
  expect(f.starts()).toBe(1);
  expect(f.messages()).toBe(1);
});



test("generic startup recovery cannot dispatch a pipeline launch without attempt eligibility", async () => {
  const f = await stagedRecoveryHarness();
  await tickPipelines([], f.h.ports);
  const { recoverStagedStructuredLaunch } = await import("@/lib/runtime/structuredSpawn");
  await recoverStagedStructuredLaunch(f.launchId(), f.registry, f.client, { now: () => Date.now() + 61_000 });
  expect(f.lookups).toEqual([]);
  expect(f.messages()).toBe(0);
  expect(f.starts()).toBe(1);
});



test("a held first-message continuation retries the original staged launch on healthy wakes", async () => {
  const f = await stagedRecoveryHarness("held");
  await tickPipelines([], f.h.ports);
  await f.wake(); // Second publication timeout.
  await f.wake(); // Publication succeeds; delivery is held before dispatch.
  expect(f.messages()).toBe(0);
  const { stagedLaunchRecovery } = await import("@/lib/runtime/structuredSpawn");
  expect(stagedLaunchRecovery(f.registry.readOnlySnapshot().receipts[f.launchId()])?.phase).toBe("unpublished");
  for (let i = 0; i < 3; i++) await f.wake();
  expect(f.registry.readOnlySnapshot().receipts[f.launchId()]?.state).toBe("completed");
  expect(f.attempt()).toMatchObject({ n: 1, launchId: f.launchId(), state: "running", spawnCalls: 1 });
  expect(f.stages).toHaveBeenCalledTimes(1);
  expect(f.starts()).toBe(1);
  expect(f.messages()).toBe(1);
});


test.each([false, true])("restart after receipt completion clears only the recovery wait (unrelated park: %s)", async (unrelatedPark) => {
  const f = await stagedRecoveryHarness();
  await tickPipelines([], f.h.ports);
  f.h.ports.recoverStagedLaunch = async () => {};
  f.advance(10_000);
  await tickPipelines([], f.h.ports);
  expect(f.attempt().controllerWait).toBeDefined();
  // Finish the durable receipt without applying the observation under the
  // pipeline lease: the old controller stops at precisely that boundary.
  for (let i = 0; i < 3; i++) {
    f.advance(61_000);
    await f.recover(f.launchId(), () => true);
  }
  expect(f.registry.readOnlySnapshot().receipts[f.launchId()]?.state).toBe("completed");
  expect(f.attempt().state).toBe("spawning");
  expect(loadPipelines()[0]!.stateDetail).toContain("waiting for the runtime host");
  if (unrelatedPark) {
    const pipelines = loadPipelines();
    pipelines[0]!.state = "needs_decision";
    pipelines[0]!.stateDetail = "manual review required for changed requirements";
    savePipelines(pipelines);
  }
  const modulePath = "./engine?completed-receipt-controller-restart";
  const restarted = await import(modulePath) as typeof engineModule;
  f.h.ports.spawnAgent = async () => { throw new Error("completed receipt must never spawn again"); };
  await restarted.tickPipelines([], { ...f.h.ports });
  expect(f.attempt()).toMatchObject({ n: 1, launchId: f.launchId(), state: unrelatedPark ? "spawning" : "running", spawnCalls: 1 });
  if (unrelatedPark) {
    expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: "manual review required for changed requirements" });
    expect(f.attempt().controllerWait).toBeDefined();
  } else {
    expect(f.attempt().controllerWait).toBeUndefined();
    expect(loadPipelines()[0]!.stateDetail).toBeNull();
  }
  expect(f.stages).toHaveBeenCalledTimes(1);
  expect(f.starts()).toBe(1);
  expect(f.messages()).toBe(1);
});



test.each(["before probe", "during probe"] as const)("staged recovery preserves an unrelated park %s", async (boundary) => {
  const f = await stagedRecoveryHarness();
  await tickPipelines([], f.h.ports);
  const parkForReview = () => {
    const pipelines = loadPipelines();
    pipelines[0]!.state = "needs_decision";
    pipelines[0]!.stateDetail = "manual review required for changed requirements";
    pipelines[0]!.runs[0]!.attempts[0]!.error = "manual review required for changed requirements";
    savePipelines(pipelines);
  };
  if (boundary === "before probe") parkForReview();
  else {
    const pipelines = loadPipelines();
    pipelines[0]!.state = "needs_decision";
    pipelines[0]!.stateDetail = HOST_UNAVAILABLE;
    pipelines[0]!.runs[0]!.attempts[0]!.error = HOST_UNAVAILABLE;
    savePipelines(pipelines);
    const read = f.client.operationStatus.bind(f.client);
    f.client.operationStatus = async (id) => { parkForReview(); return read(id); };
  }
  await f.wake();
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: "manual review required for changed requirements" });
  expect(f.registry.readOnlySnapshot().receipts[f.launchId()]?.state).toBe("path-pending");
  expect(f.stages).toHaveBeenCalledTimes(1);
  expect(f.messages()).toBe(0);
  if (boundary === "before probe") expect(f.lookups).toEqual([]);
});



test.each(["timeout", "uncertain"] as const)("a staged launch parked for runtime unavailability recovers its original attempt (%s)", async (mode) => {
  const f = await stagedRecoveryHarness(mode);
  await tickPipelines([], f.h.ports);
  const pipelines = loadPipelines();
  pipelines[0]!.state = "needs_decision";
  pipelines[0]!.stateDetail = HOST_UNAVAILABLE;
  pipelines[0]!.runs[0]!.attempts[0]!.state = "needs_decision";
  pipelines[0]!.runs[0]!.attempts[0]!.error = HOST_UNAVAILABLE;
  savePipelines(pipelines);
  for (let i = 0; i < 3; i++) await f.wake();
  expect(loadPipelines()[0]).toMatchObject({ state: "running", stateDetail: null });
  expect(f.attempt()).toMatchObject({ n: 1, launchId: f.launchId(), state: "running", spawnCalls: 1 });
  expect(f.stages).toHaveBeenCalledTimes(1);
  expect(f.messages()).toBe(1);
});


test.each(["pause", "close", "set-edge"] as const)("activation drain honors %s before the dispatch permit", async (action) => {
  const f = await activationDrainFixture();
  try {
    const changed = await patchPipeline(f.id, action === "set-edge"
      ? { action, stageId: "plan", edge: "pass", to: null }
      : { action }, f.h.ports);
    if (action !== "close") expect(changed.error).toBeUndefined();
    f.release();
    await f.ticking;
    const live = loadPipelines()[0]!;
    expect(f.launches()).toBe(0);
    expect(live.runs[0]!.attempts).toHaveLength(1);
    expect(live.runs[0]!.attempts[0]!.activation).toBeUndefined();
    if (action === "pause") expect(live.state).toBe("paused");
    if (action === "close") expect(live.state).toBe("closed");
    if (action === "set-edge") expect(live.stages[0]!.next).toBeNull();
  } finally { f.release(); await f.ticking; delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; }
});


test.each(["pause", "close"] as const)("activation drain preserves %s after the permit and reconciles the original launch", async (action) => {
  const f = await activationDrainFixture(true);
  try {
    const changed = await patchPipeline(f.id, { action }, f.h.ports);
    if (action === "close") {
      expect(changed.error).toBeUndefined();
      expect(changed.close?.status).toBe("pending");
      expect(loadPipelines()[0]!.state).toBe("closed");
    }
    f.release(); await f.ticking;
    const live = loadPipelines()[0]!;
    expect(live.state).toBe(action === "close" ? "closed" : "paused");
    expect(live.runs[0]!.attempts[0]!.launchId).toBe("activation-launch");
    expect(f.launches()).toBe(1);
    expect(live.runs[0]!.attempts[0]!.activation).toBeUndefined();
  } finally { f.release(); await f.ticking; delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; }
});


test("activation drain rollback consumes existing custody and a second controller cannot launch", async () => {
  const f = await activationDrainFixture();
  try {
    delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
    // A separate module has a separate in-flight set, while the durable process claim remains shared.
    const modulePath = "./engine?activation-other-controller";
    const other = await import(modulePath) as typeof engineModule;
    await other.tickPipelines([], f.h.ports);
    expect(f.calls()).toBe(1);
    f.release(); await f.ticking;
    const live = loadPipelines()[0]!;
    expect(live.runs[0]!.attempts[0]).toMatchObject({ state: "running", launchId: "activation-launch", spawnCalls: 1 });
    expect(live.runs[0]!.attempts[0]!.activation).toBeUndefined();
    expect(f.launches()).toBe(1);
  } finally { f.release(); await f.ticking; delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; }
});


test("activation drain keeps account and real structured adapter RPC waits outside the lease", async () => {
  const f = await stagedRecoveryHarness();
  process.env.LLV_PIPELINE_ACTIVATION_DRAIN = "1";
  let releaseAccount!: () => void, accountEntered!: () => void;
  let releaseRpc!: () => void, rpcEntered!: () => void;
  const accountGate = new Promise<void>((resolve) => { releaseAccount = resolve; });
  const accountStarted = new Promise<void>((resolve) => { accountEntered = resolve; });
  const rpcGate = new Promise<void>((resolve) => { releaseRpc = resolve; });
  const rpcStarted = new Promise<void>((resolve) => { rpcEntered = resolve; });
  const spawn = f.h.ports.spawnAgent;
  f.h.ports.spawnAgent = async (input, reserved) => {
    expectPipelineLeaseFree(); accountEntered(); await accountGate;
    expectPipelineLeaseFree(); return spawn(input, reserved);
  };
  const producerCursor = f.client.producerCursor.bind(f.client);
  f.client.producerCursor = async (...args) => {
    expectPipelineLeaseFree(); rpcEntered(); await rpcGate;
    expectPipelineLeaseFree(); return producerCursor(...args);
  };
  const ticking = tickPipelines([], f.h.ports);
  try {
    await accountStarted;
    expect((await createPipelineFromRequest({ task: "During account wait", repoDir: "/repo", autoStart: false, stages: [...RUN_STAGES] }, f.h.ports)).pipeline).toBeDefined();
    releaseAccount(); await rpcStarted;
    expect((await createPipelineFromRequest({ task: "During RPC wait", repoDir: "/repo", autoStart: false, stages: [...RUN_STAGES] }, f.h.ports)).pipeline).toBeDefined();
    releaseRpc(); await ticking;
    expect(f.starts()).toBe(1);
    expect(f.attempt().launchId).toBe(f.launchId());
  } finally { releaseAccount(); releaseRpc(); await ticking; delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; }
});


test.each([
  { held: false, failed: false, collide: false }, { held: true, failed: false, collide: false },
  { held: false, failed: true, collide: false }, { held: true, failed: true, collide: false },
  { held: false, failed: true, collide: true },
])("activation drain recovers the original registry launch after a process exits before binding: %j", async ({ held, failed, collide }) => {
  const h = await reserveActivationOnly();
  const registryPath = path.join(process.env.LLV_STATE_DIR!, `activation-crash-registry-${held}-${failed}-${collide}.json`);
  const marker = path.join(process.env.LLV_STATE_DIR!, `activation-crash-launch-${held}-${failed}-${collide}`);
  const child = Bun.spawn([process.execPath, "-e", `
    import fs from "node:fs";
    const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry.ts");
    const { accountManager } = await import("./src/lib/accounts/manager.ts");
    const { drainStageActivations, defaultPipelinePorts } = await import("./src/lib/pipelines/engine.ts");
    const registry = new AgentRegistry(process.env.LLV_TEST_REGISTRY);
    setAgentRegistryForTests(registry);
    accountManager.resolveProjectSpawn = (engine) => ({ kind: "available", account: {
      engine, accountId: "test", kind: "managed", home: process.env.HOME,
      transcriptRoot: process.env.HOME, env: { NODE_ENV: "test" },
    }});
    if (process.env.LLV_TEST_FAILURE === "1") {
      const { productionLaunchMembershipPorts } = await import("./src/lib/tasks/launchMembership.ts");
      productionLaunchMembershipPorts.commit = () => { throw new Error("state writer is busy during account commit"); };
      const begin = registry.beginSpawnRequestAsync.bind(registry);
      registry.beginSpawnRequestAsync = async (...args) => {
        try { return await begin(...args); }
        catch {
          const receipt = registry.spawnReceiptForClientAttempt(args[0].clientAttemptId);
          fs.writeFileSync(process.env.LLV_TEST_MARKER, receipt.launchId);
          process.exit(0);
        }
      };
    }
    const ports = defaultPipelinePorts();
    const spawn = ports.spawnAgent;
    await drainStageActivations({ ...ports, structuredDeliveryPublication: () => "ready",
      spawnAgent: (input) => spawn(input, async (reservation) => {
        fs.writeFileSync(process.env.LLV_TEST_MARKER, reservation.launchId);
        process.exit(0);
      }),
    });
    process.exit(2);
  `], { cwd: process.cwd(), env: { ...process.env, LLV_TEST_REGISTRY: registryPath, LLV_TEST_MARKER: marker, LLV_TEST_FAILURE: failed ? "1" : "0" }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  const launch = fs.readFileSync(marker, "utf8");
  const before = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(before.launchId).toBeNull();
  expect(before.activation).toMatchObject({ phase: "reserving", owner: { pid: child.pid } });
  const sqlite = failed && !held && !collide;
  const registry = new AgentRegistry(registryPath, undefined, undefined, { sqliteMode: sqlite ? "sqlite" : "off" });
  let peer: import("bun:sqlite").Database | null = null;
  let locked = false, progress = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  setAgentRegistryForTests(registry);
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation((engine) => ({ kind: "available", account: {
    engine, accountId: "test", kind: "managed", home: process.env.HOME!, transcriptRoot: process.env.HOME!, env: { NODE_ENV: "test" },
  }}));
  try {
    const drain = await import("@/lib/selfUpdate/drain");
    if (held) drain.writeDrain(drain.drainFile(), { id: "submitted-recovery", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    const ports = defaultPipelinePorts();
    if (collide) registry.claimFailedSpawnForRetry(launch, "manual-retry");
    if (sqlite) {
      const { Database } = await import("bun:sqlite");
      peer = new Database(registryPath.replace(/\.json$/, ".sqlite"));
      peer.exec("BEGIN IMMEDIATE"); locked = true;
      timer = setInterval(() => {
        if (++progress === 3) { peer!.exec("ROLLBACK"); locked = false; }
      }, 5);
    }
    await engineModule.drainStageActivations({ ...h.ports, drainHold: ports.drainHold, spawnAgent: ports.spawnAgent, spawnReceipt: ports.spawnReceipt, claimSpawnRetry: ports.claimSpawnRetry });
    if (sqlite) expect(progress).toBeGreaterThan(0);
    const recovered = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(recovered).toMatchObject({ n: 1, launchId: failed && !collide ? null : launch, spawnCalls: 1, state: collide ? "needs_decision" : failed ? "pending" : "spawning" });
    if (failed) {
      expect(registry.spawnReceipt(launch)?.retryClaim?.claimId).toBe(collide ? "manual-retry" : `${loadPipelines()[0]!.id}:plan:${launch}`);
      expect(registry.spawnReceipt(launch)?.membershipAdmitted).toBe(false);
    }
    expect(recovered.activation).toBeUndefined();
    expect(Object.values(registry.readOnlySnapshot().receipts)).toHaveLength(1);
  } finally {
    const drain = await import("@/lib/selfUpdate/drain");
    drain.releaseDrain(drain.drainFile(), "submitted-recovery");
    clearInterval(timer); if (locked) peer!.exec("ROLLBACK"); peer?.close(); registry.close();
    resolve.mockRestore(); setAgentRegistryForTests(null);
  }
});


test.each(["before-recovery", "account-lock"] as const)("recovering an unsubmitted reserving activation stays held at %s", async (seam) => {
  const h = await reserveActivationOnly();
  const drain = await import("@/lib/selfUpdate/drain");
  const mutation = await import("@/lib/accounts/accountMutation");
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const registryPath = path.join(process.env.LLV_STATE_DIR!, `unsubmitted-${seam}.json`);
  // Exit the actual executor after its reserving checkpoint, before any receipt.
  const child = Bun.spawn([process.execPath, "-e", `
    const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry.ts");
    const { accountManager } = await import("./src/lib/accounts/manager.ts");
    const { drainStageActivations, defaultPipelinePorts } = await import("./src/lib/pipelines/engine.ts");
    const registry = new AgentRegistry(process.env.LLV_TEST_REGISTRY);
    setAgentRegistryForTests(registry);
    accountManager.resolveProjectSpawn = (engine) => ({ kind: "available", account: {
      engine, accountId: "account-a", kind: "managed", home: process.env.LLV_STATE_DIR,
      transcriptRoot: process.env.LLV_STATE_DIR, env: { NODE_ENV: "test" },
    }});
    registry.beginSpawnRequestAsync = async () => { process.exit(0); };
    await drainStageActivations({ ...defaultPipelinePorts(), structuredDeliveryPublication: () => "ready" });
    process.exit(2);
  `], { cwd: process.cwd(), env: { ...process.env, LLV_TEST_REGISTRY: registryPath }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  const before = structuredClone(loadPipelines()[0]!.runs[0]!.attempts[0]!);
  expect(before).toMatchObject({ launchId: null, spawnCalls: 1, activation: { phase: "reserving", owner: { pid: child.pid } } });
  const registry = new AgentRegistry(registryPath);
  setAgentRegistryForTests(registry);
  expect(registry.spawnReceiptForClientAttempt(before.activation!.clientAttemptId)).toBeNull();
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(engine => ({ kind: "available", account: {
    engine, accountId: "account-a", kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
  }}));
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const dispatches: string[] = [];
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async input => {
    dispatches.push(input.receipt.launchId);
    return { path: null } as never;
  });
  // The activation harness provisions a synthetic worktree. Supply its Git
  // directory and HEAD at the native boundary; keep guard writes, admission
  // and recovery real and confined to this test's state directory.
  const gitDirectory = path.join(process.env.LLV_STATE_DIR!, `unsubmitted-${seam}.git`);
  fs.mkdirSync(gitDirectory);
  const provision = await import("@/lib/workflows/provision");
  const execute = provision.realExec;
  const gitPreparation = spyOn(provision, "realExec").mockImplementation((command, args, cwd, ...rest) => {
    if (command === "git" && cwd === before.activation!.input.cwd) {
      if (args.join(" ") === "rev-parse --absolute-git-dir") return { code: 0, stdout: gitDirectory, stderr: "" };
      if (args.join(" ") === "rev-parse HEAD") return { code: 0, stdout: ORIGIN_MAIN_SHA, stderr: "" };
    }
    return execute(command, args, cwd, ...rest);
  });
  const hold = () => drain.writeDrain(drain.drainFile(), { id: "unsubmitted-recovery", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
  let resume!: () => void;
  let locking: Promise<void> | undefined;
  let recovering: Promise<void> | undefined;
  let lock: ReturnType<typeof spyOn<typeof mutation, "withAccountMutationLockAsync">> | undefined;
  try {
    const ports = defaultPipelinePorts();
    const recoveryPorts = { ...h.ports, drainHold: ports.drainHold, spawnAgent: ports.spawnAgent, spawnReceipt: ports.spawnReceipt };
    if (seam === "before-recovery") hold();
    else {
      let entered!: () => void, queued!: () => void;
      const acquired = new Promise<void>(r => { entered = r; });
      const gate = new Promise<void>(r => { resume = r; });
      const waiting = new Promise<void>(r => { queued = r; });
      const nativeLock = mutation.withAccountMutationLockAsync;
      locking = nativeLock(async () => { entered(); await gate; });
      await acquired;
      lock = spyOn(mutation, "withAccountMutationLockAsync").mockImplementation((...args) => { queued(); return nativeLock(...args); });
      recovering = engineModule.drainStageActivations(recoveryPorts);
      await waiting;
      hold(); resume(); await locking;
    }
    await (recovering ?? engineModule.drainStageActivations(recoveryPorts));
    await engineModule.drainStageActivations(recoveryPorts);
    expect(dispatches).toHaveLength(0);
    expect(gitPreparation).not.toHaveBeenCalled();
    expect(fs.readdirSync(gitDirectory)).toEqual([]);
    expect(Object.values(registry.readOnlySnapshot().receipts)).toHaveLength(0);
    const held = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(held).toMatchObject({ n: before.n, launchId: null, spawnCalls: 1, activation: {
      id: before.activation!.id, clientAttemptId: before.activation!.clientAttemptId, phase: "reserved", replay: true,
    } });
    expect(held.activation!.owner).toBeUndefined();
    const { probeQuiet } = await import("@/lib/selfUpdate/quiet");
    expect((await probeQuiet({ busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot,
      { runtimeSnapshot: async () => ({ sessions: [] }), pipelines: loadPipelines, presence: () => [] }, Date.now(), true)).quiet).toBe(true);
    drain.releaseDrain(drain.drainFile(), "unsubmitted-recovery");
    await engineModule.drainStageActivations(recoveryPorts);
    await engineModule.drainStageActivations(recoveryPorts);
    expect(dispatches).toHaveLength(1);
    const launched = spawn.mock.calls[0]![0];
    expect(launched.account.env.LLV_STAGE_GIT_WORKTREE).toBe(before.activation!.input.cwd);
    expect(JSON.parse(fs.readFileSync(path.join(launched.account.env.LLV_STAGE_GIT_RECEIPT!, "start.json"), "utf8"))).toMatchObject({
      launchId: launched.receipt.launchId, head: ORIGIN_MAIN_SHA, worktree: before.activation!.input.cwd,
    });
    const ownerFile = path.join(gitDirectory, "delegatus-stage-owner");
    expect(fs.readFileSync(ownerFile, "utf8")).toBe(launched.account.env.LLV_STAGE_GIT_RECEIPT!);
    expect(fs.readFileSync(path.join(launched.account.env.LLV_STAGE_GIT_RECEIPT!, "owner"), "utf8")).toBe(ownerFile);
    const receipts = Object.values(registry.readOnlySnapshot().receipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.clientAttemptId).toBe(before.activation!.clientAttemptId);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.spawnCalls).toBe(1);
  } finally {
    resume?.(); await locking; await recovering;
    lock?.mockRestore(); resolve.mockRestore(); client.mockRestore(); spawn.mockRestore(); gitPreparation.mockRestore();
    drain.releaseDrain(drain.drainFile(), "unsubmitted-recovery"); setAgentRegistryForTests(null);
  }
});


test.each(["absent", "transcript", "live-host", "different-path", "verdict"] as const)("stale working: closed reserved launch sweep respects %s evidence", async (evidence) => {
  const host = await stageHostChild();
  if (evidence !== "live-host") await host.end();
  try {
    const f = await stagedRecoveryHarness("timeout", { hostProcess: host.process, nativeTranscript: true });
    productionHostSeams(f);
    await tickPipelines([], f.h.ports);
    const receipt = f.registry.readOnlySnapshot().receipts[f.launchId()]!;
    if (evidence !== "live-host") {
      const writer = f.registry.readOnlySnapshot().entries[`codex:${receipt.key!.sessionId}`]!;
      f.registry.setStructuredHostClaimed(receipt.key!, { ...writer.structuredHost!, process: null }, "dead", writer.claimOwner!, writer.claimEpoch, true);
    }
    const pipelines = loadPipelines();
    const pipeline = pipelines[0]!;
    pipeline.state = "closed";
    pipeline.cursor = null;
    pipeline.closedAt = f.h.ports.now();
    const attempt = pipeline.runs[0]!.attempts[0]!;
    attempt.state = "needs_decision";
    attempt.completedAt = f.h.ports.now();
    attempt.agentPath = evidence === "different-path" ? "/repo/different.jsonl" : receipt.artifactPath;
    attempt.sessionId = receipt.key!.sessionId;
    if (evidence === "verdict") attempt.verdict = { status: "pass", findings: [] };
    savePipelines(pipelines);
    if (evidence === "transcript") fs.writeFileSync(receipt.artifactPath!, "{}\n");
    f.h.ports.transcriptPresent = (pathname) => fs.existsSync(pathname);
    f.advance(58 * 60 * 60_000);
    const spawning = spyOn(f.h.ports, "spawnAgent");
    const recovering = spyOn(f.h.ports, "recoverStagedLaunch");
    let resumes = 0;
    f.h.ports.resumeSeveredTurn = async () => { resumes++; return false; };
    await tickPipelines([], f.h.ports);
    expect(f.registry.readOnlySnapshot().receipts[f.launchId()]?.state).toBe(evidence === "absent" ? "failed" : "path-pending");
    if (evidence === "absent") {
      const snapshot = f.registry.readOnlySnapshot();
      expect(snapshot.receipts[f.launchId()]!.error).toBe("stage launch never started: pipeline closed");
      expect(snapshot.entries[`codex:${receipt.key!.sessionId}`]!.pendingAction).toBeNull();
      expect(f.attempt().state).toBe("failed");
      const { projectLaunchConversations } = await import("@/lib/agent/spawnProjection");
      expect(projectLaunchConversations([], snapshot, Date.parse(f.h.ports.now())).cards).toEqual([]);
    }
    const settled = JSON.stringify(loadPipelines());
    await tickPipelines([], f.h.ports);
    expect(JSON.stringify(loadPipelines())).toBe(settled);
    expect(spawning).not.toHaveBeenCalled();
    expect(recovering).not.toHaveBeenCalled();
    expect(resumes).toBe(0);
    expect(f.starts()).toBe(1);
    expect(f.messages()).toBe(0);
  } finally { setAgentRegistryForTests(null); await host.end(); }
});


test("a replayed membership failure retries the same attempt without losing input or checkout", async () => {
  const f = await failedMembershipReplay();
  await engineModule.drainStageActivations(f.h.ports);
  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  expect(attempt).toMatchObject({ n: 1, state: "pending", spawnCalls: 1, launchId: null });
  expect(pipeline.state).toBe("running");
  expect(pipeline.worktreeDir).toBe(f.pending.worktreeDir);
  expect(attempt.input).toBe(f.attempt.input);
  expect(f.claims).toEqual([`${pipeline.id}:plan:${f.receipt.launchId}`]);
  expect(attempt.retiredLaunches).toMatchObject([{ launchId: f.receipt.launchId, error: f.receipt.error }]);
  f.h.ports.now = () => new Date(Date.parse(attempt.controllerWait!.retryAfter) + 1).toISOString();
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "running", spawnCalls: 2 });
  expect(f.h.spawnInputs).toHaveLength(1);
});


test.each(["native", "filename-generation", "operation-conflict", "generation-conflict", "generation-switch", "registry-switch", "completion-switch", "stale-turn", "absent"] as const)("an incomplete replay without an envelope reconciles original evidence: %s", async mode => {
  const f = await stagedRecoveryHarness("uncertain", { nativeTranscript: mode !== "filename-generation" });
  await tickPipelines([], f.h.ports);
  const launch = f.launchId();
  f.registry.preserveSpawnArtifactOwnership(launch, "");
  const receipt = f.registry.readOnlySnapshot().receipts[launch]!;
  const pathname = receipt.artifactPath!;
  const pipelines = loadPipelines();
  const attempt = pipelines[0]!.runs[0]!.attempts[0]!;
  pipelines[0]!.state = "needs_decision";
  pipelines[0]!.stateDetail = "stage spawn is unresolved; inspect the original receipt before retrying";
  attempt.state = "needs_decision";
  attempt.error = pipelines[0]!.stateDetail;
  savePipelines(pipelines);
  let generationMatches = mode !== "generation-conflict";
  let registrySwitched = false;
  f.h.ports.sourcePathAllowed = p => p === pathname;
  f.h.ports.durableTurnEvidence = async () => {
    if (mode === "generation-switch") generationMatches = false;
    if (mode === "registry-switch" && !registrySwitched) {
      registrySwitched = true;
      const before = f.registry.snapshot();
      const next = structuredClone(before);
      const conversation = next.conversations[receipt.conversationId]!;
      const previous = conversation.generations.at(-1)!;
      previous.archivedAt = f.h.ports.now();
      conversation.generations.push({ ...previous, id: "replacement-generation", path: `${pathname}.replacement.jsonl`, archivedAt: null });
      f.registry.restoreSnapshot(before, next);
    }
    return mode === "absent" ? null : { turn: "busy", message: null,
      lastRecordAt: mode === "stale-turn" ? Date.parse(attempt.startedAt!) - 1 : Date.parse(f.h.ports.now()) };
  };
  const lookup = f.client.operationStatus.bind(f.client);
  f.client.operationStatus = async id => {
    const result = await lookup(id);
    if (id !== `spawn_message_${launch}` || mode === "native" || mode === "filename-generation") return result;
    if (mode === "completion-switch") { generationMatches = false; return result; }
    if (mode === "operation-conflict") return result && { ...result, receipt: { ...result.receipt, conversationId: "conversation_wrong" } };
    return null;
  };
  setAgentRegistryForTests(f.registry);
  try {
    const ports = defaultPipelinePorts({ spawnRecoveryClient: () => f.client });
    f.h.ports.recoverStagedLaunch = ports.recoverStagedLaunch;
    f.h.ports.spawnReceipt = id => {
      const row = ports.spawnReceipt(id);
      return row && { ...row, currentGeneration: generationMatches && row.currentGeneration };
    };
    await f.wake();
    expect(new Set(f.lookups)).toEqual(new Set([launch, `spawn_message_${launch}`]));
    if (mode === "native" || mode === "filename-generation") {
      expect(loadPipelines()[0]!.state).toBe("running");
      expect(f.attempt()).toMatchObject({ n: 1, state: "running", launchId: launch, agentPath: pathname, spawnCalls: 1 });
    } else if (mode.includes("conflict") || mode.endsWith("switch")) {
      expect(loadPipelines()[0]!.state).toBe("needs_decision");
      expect(loadPipelines()[0]!.stateDetail).toContain(mode === "operation-conflict" ? "runtime operation identity conflicts" : "current registry generation");
    } else {
      expect(f.attempt().state).toBe("spawning");
      f.advance(601_000);
      await f.wake();
      expect(loadPipelines()[0]!.state).toBe("needs_decision");
      expect(loadPipelines()[0]!.stateDetail).toContain("original launch");
    }
    expect(f.attempt().launchId).toBe(launch);
    expect(f.attempt().retiredLaunches).toBeUndefined();
    expect(f.starts()).toBe(1);
    expect(f.messages()).toBe(1);
  } finally { setAgentRegistryForTests(null); }
});


test.each([true, false])("activation replay verifies original operation attribution (uncertain envelope: %s)", async hasEnvelope => {
  for (const outcome of ["matching", "conflict", "revoked-during-message-lookup", "rejected"] as const) {
    const f = await stagedRecoveryHarness("uncertain", { nativeTranscript: true });
    await tickPipelines([], f.h.ports);
    const launchId = f.launchId();
    if (!hasEnvelope) f.registry.preserveSpawnArtifactOwnership(launchId, "");
    const receipt = f.registry.readOnlySnapshot().receipts[launchId]!;
    const pathname = receipt.artifactPath!;
    const pipeline = loadPipelines()[0]!;
    const attempt = pipeline.runs[0]!.attempts[0]!;
    const now = Date.parse(f.h.ports.now());
    fs.writeFileSync(pathname, [
      { timestamp: new Date(now - 2_000).toISOString(), type: "session_meta", payload: { id: receipt.key!.sessionId } },
      { timestamp: new Date(now - 1_000).toISOString(), type: "event_msg", payload: { type: "task_started" } },
      { timestamp: new Date(now).toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Original launch is working" }] } },
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
    f.h.ports.sourcePathAllowed = candidate => candidate === pathname;
    f.h.ports.durableTurnEvidence = durableStageTurnEvidence;
    const status = f.client.operationStatus.bind(f.client);
    f.client.operationStatus = async id => {
      const result = await status(id);
      if (outcome === "revoked-during-message-lookup" && id === `spawn_message_${launchId}`) {
        const { withPipelineMutation } = await import("./store");
        await withPipelineMutation(async (pipelines, persist) => {
          const live = pipelines.find(candidate => candidate.id === pipeline.id)!;
          live.runs[0]!.attempts[0]!.launchId = "replacement-launch";
          await persist([live]);
        });
      }
      if (outcome === "conflict" && id === `spawn_message_${launchId}` && result)
        return { ...result, receipt: { ...result.receipt, conversationId: "conversation_wrong" } };
      if (outcome === "rejected" && id === `spawn_message_${launchId}` && result)
        return { ...result, receipt: { ...result.receipt, status: "rejected" } };
      return result;
    };
    attempt.state = "spawning";
    const stages = pipeline.stages;
    const activationFence = JSON.stringify([pipeline.state, pipeline.cursor?.stageId, stages,
      pipeline.graphEdits, pipeline.pausedAt, pipeline.resumedAt, pipeline.closedAt,
      ...(pipeline.controlGeneration === undefined ? [] : [pipeline.controlGeneration])]);
    const clientAttemptId = receipt.clientAttemptId ?? `activation-replay-${hasEnvelope}-${outcome}`;
    attempt.activation = {
      id: `replayed-activation-${hasEnvelope}-${outcome}`,
      phase: "reserving",
      input: { role: pipeline.stages[0]!.effectiveRole, prompt: "Build", cwd: pipeline.worktreeDir,
        project: pipeline.project, clientAttemptId, title: pipeline.task, runtimeProfile: {}, membership: {} } as never,
      clientAttemptId,
      startedAt: attempt.startedAt!,
      fence: activationFence,
      replay: true,
    };
    savePipelines([pipeline]);
    const beforeLookups = f.lookups.length;
    await engineModule.drainStageActivations(f.h.ports);
    const current = loadPipelines()[0]!;
    if (outcome === "matching") {
      expect(current).toMatchObject({ state: "running", runs: [{ attempts: [{ n: 1, state: "running", launchId, conversationId: receipt.conversationId }] }] });
      expect(f.starts()).toBe(1);
      expect(f.messages()).toBe(1);
    } else if (outcome === "conflict") {
      expect(current.state).toBe("needs_decision");
      expect(current.stateDetail).toContain("runtime operation identity conflicts with the staged launch");
      expect(current.runs[0]!.attempts[0]!.state).not.toBe("running");
      expect(f.starts()).toBe(1);
      expect(f.messages()).toBe(1);
    } else if (outcome === "revoked-during-message-lookup") {
      expect(current.runs[0]!.attempts[0]!.launchId).toBe("replacement-launch");
      expect(current.runs[0]!.attempts[0]!.state).not.toBe("running");
      expect(f.starts()).toBe(1);
      expect(f.messages()).toBe(1);
    } else {
      expect(current).toMatchObject({ state: "needs_decision", stateDetail: expect.stringContaining("original first-message operation was rejected") });
      expect(current.runs[0]!.attempts[0]).toMatchObject({ n: 1, launchId, state: "needs_decision", spawnCalls: 1 });
      expect(current.runs[0]!.attempts[0]!.activation).toBeUndefined();
      expect(f.starts()).toBe(1);
      expect(f.messages()).toBe(1);
    }
    expect(f.lookups.slice(beforeLookups)).toEqual([launchId, `spawn_message_${launchId}`]);
    if (outcome !== "revoked-during-message-lookup") expect(current.runs[0]!.attempts[0]!.launchId).toBe(launchId);
    setAgentRegistryForTests(null);
  }
});



test("two activation controllers claim one pre-host retry and reserve one successor", async () => {
  const f = await failedMembershipReplay();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const gate = new Promise<void>(r => { release = r; });
  const claim = f.h.ports.claimSpawnRetry;
  f.h.ports.claimSpawnRetry = async (...args) => { enter(); await gate; return claim(...args); };
  const first = engineModule.drainStageActivations(f.h.ports);
  try {
    await Promise.race([entered, first.then(() => { throw new Error("pre-host retry claim was never reached"); })]);
    const peer = Bun.spawn([process.execPath, "-e", `
      const { defaultPipelinePorts, drainStageActivations } = await import("./src/lib/pipelines/engine.ts");
      await drainStageActivations({ ...defaultPipelinePorts(), spawnAgent: async () => { throw new Error("unexpected peer dispatch"); } });
      process.exit(0);
    `], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [code, errors] = await Promise.all([peer.exited, new Response(peer.stderr).text()]);
    expect({ code, errors }).toMatchObject({ code: 0 });
    await engineModule.drainStageActivations({ ...f.h.ports });
    expect(f.claims).toHaveLength(0);
    release(); await first;
    const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(f.claims).toHaveLength(1);
    f.h.ports.now = () => new Date(Date.parse(attempt.controllerWait!.retryAfter) + 1).toISOString();
    await Promise.all([tickPipelines([], f.h.ports), tickPipelines([], { ...f.h.ports })]);
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  } finally { release(); await first; }
});


test.each(["completion", "manual-claim", "proof-withdrawn"] as const)("a pre-host retry rechecks the receipt after async claim: %s", async mode => {
  const f = await failedMembershipReplay();
  f.h.ports.claimSpawnRetry = async () => {
    if (mode === "manual-claim") return "conflict";
    if (mode === "completion") {
      Object.assign(f.receipt, { state: "completed", neverBegan: false, transcript: "/codex/stage-1.jsonl", sessionId: "session-original" });
      return "settled";
    }
    f.receipt.neverBegan = false;
    return "claimed";
  };
  await engineModule.drainStageActivations(f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.retiredLaunches).toBeUndefined();
  if (mode === "completion") {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "running", launchId: f.receipt.launchId });
  } else expect(loadPipelines()[0]!.stateDetail).toContain(f.receipt.error!);
});


test("a legacy unresolved membership failure is retried without manual action", async () => {
  const f = await failedMembershipReplay();
  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  delete attempt.activation;
  Object.assign(attempt, { state: "needs_decision", launchId: f.receipt.launchId, conversationId: f.receipt.conversationId,
    error: "stage spawn is unresolved; inspect the original receipt before retrying" });
  pipeline.state = "needs_decision";
  pipeline.stateDetail = attempt.error;
  savePipelines([pipeline]);
  const now = f.h.ports.now();
  f.h.ports.now = () => now;
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "running", cursor: { state: "pending" } });
  expect(f.claims).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(0);
  expect(loadPipelines()[0]!.stateDetail).toContain("stage spawn deferred: task membership could not be recorded");
});


test("a pre-host retry budget survives an actual controller restart", async () => {
  const f = await failedMembershipReplay();
  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  delete attempt.activation;
  Object.assign(attempt, { state: "needs_decision", launchId: f.receipt.launchId, conversationId: f.receipt.conversationId,
    error: "stage spawn is unresolved; inspect the original receipt before retrying",
    controllerWait: { startedAt: f.h.ports.now(), retryAfter: f.h.ports.now(), rounds: 3, budgetMs: 600_000, retryMaxMs: 60_000 } });
  pipeline.state = "needs_decision"; pipeline.stateDetail = attempt.error;
  savePipelines([pipeline]);
  const clock = Date.parse(attempt.controllerWait!.startedAt) + 601_000;
  const child = Bun.spawn([process.execPath, "-e", `
    const { defaultPipelinePorts, tickPipelines } = await import("./src/lib/pipelines/engine.ts");
    const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
    const receipt = JSON.parse(process.env.LLV_TEST_RECEIPT);
    let spawns = 0;
    await tickPipelines([], { ...defaultPipelinePorts(),
      now: () => new Date(Number(process.env.LLV_TEST_CLOCK)).toISOString(),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      worktreePresent: () => true, sourcePathAllowed: () => false,
      spawnReceipt: () => receipt, claimSpawnRetry: async () => "claimed",
      scheduleTick: () => {}, spawnAgent: async () => { spawns++; throw new Error("unexpected spawn"); },
    });
    const attempt = loadPipelines()[0].runs[0].attempts[0];
    process.stdout.write(JSON.stringify({ spawns, state: attempt.state, error: attempt.error, wait: attempt.controllerWait, spawnCalls: attempt.spawnCalls }));
  `], { cwd: process.cwd(), env: { ...process.env, LLV_TEST_RECEIPT: JSON.stringify(f.receipt), LLV_TEST_CLOCK: String(clock) }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, errors }).toMatchObject({ code: 0 });
  const result = JSON.parse(output);
  expect(result).toMatchObject({ spawns: 0, state: "needs_decision", spawnCalls: 1, wait: { startedAt: attempt.controllerWait!.startedAt, rounds: 3 } });
  expect(result.error).toContain("failed after 3 retries");
  expect(result.error).toContain("task membership could not be recorded");
});



test.each([false, true])("envelope recovery yields to a peer writer and rechecks eligibility (revoked: %s)", async revoked => {
  const { Database } = await import("bun:sqlite");
  const f = await stagedRecoveryHarness("uncertain", { nativeTranscript: true });
  await tickPipelines([], f.h.ports);
  f.registry.preserveSpawnArtifactOwnership(f.launchId(), "");
  const registry = new AgentRegistry(f.registry.filename, undefined, undefined, { sqliteMode: "sqlite" });
  const peer = new Database(registry.filename.replace(/\.json$/, ".sqlite"));
  let locked = false, allowed = true, progress = 0;
  setAgentRegistryForTests(registry);
  const timer = setInterval(() => {
    if (!locked) return;
    progress++;
    if (progress === 3) { allowed = !revoked; peer.exec("ROLLBACK"); locked = false; }
  }, 5);
  try {
    peer.exec("BEGIN IMMEDIATE"); locked = true;
    await defaultPipelinePorts({ spawnRecoveryClient: () => f.client }).recoverStagedLaunch!(f.launchId(), () => allowed);
    expect(progress).toBeGreaterThan(0);
    if (revoked) {
      expect(registry.spawnReceipt(f.launchId())?.error).toBe("");
      expect(f.lookups).toHaveLength(0);
    } else expect(registry.spawnReceipt(f.launchId())?.error).toStartWith("structured launch recovery: ");
    expect(f.starts()).toBe(1);
    expect(f.messages()).toBe(1);
  } finally { clearInterval(timer); if (locked) peer.exec("ROLLBACK"); peer.close(); registry.close(); setAgentRegistryForTests(null); }
});



test.each(["released", "exhausted"] as const)("a contended retry claim keeps the original launch under bounded backoff: %s", async outcome => {
  const { RegistryWriterBusyError } = await import("@/lib/agent/registry");
  const f = await failedMembershipReplay();
  let busy = true;
  f.h.ports.claimSpawnRetry = async () => {
    if (busy) throw new RegistryWriterBusyError("pipeline.spawn-retry");
    return "claimed" as const;
  };
  const now = f.h.ports.now();
  f.h.ports.now = () => now;
  await engineModule.drainStageActivations(f.h.ports);
  const waiting = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(waiting).toMatchObject({ state: "spawning", launchId: f.receipt.launchId, spawnCalls: 1, controllerWait: { rounds: 1 } });
  expect(waiting.retiredLaunches).toBeUndefined();
  if (outcome === "released") {
    busy = false;
    f.h.ports.now = () => new Date(Date.parse(waiting.controllerWait!.retryAfter) + 1).toISOString();
  } else f.h.ports.now = () => new Date(Date.parse(waiting.controllerWait!.startedAt) + 601_000).toISOString();
  await tickPipelines([], f.h.ports);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.state).toBe(outcome === "released" ? "pending" : "needs_decision");
  expect(f.h.spawnInputs).toHaveLength(0);
  expect(attempt.spawnCalls).toBe(1);
  if (outcome === "released") expect(attempt.retiredLaunches).toHaveLength(1);
  else expect(attempt.error).toContain("failed after 1 retries");
});

test.each(RAW_ADMISSION_BUSY.flatMap(message => (["released", "exhausted"] as const).map(outcome => ({ message, outcome }))))("raw SQLite admission contention before a receipt uses bounded retry: %j", async ({ message, outcome }) => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  let calls = 0;
  const admissionInputs: Parameters<PipelinePorts["spawnAgent"]>[0][] = [];
  h.ports.spawnAgent = async (input, reserved) => {
    calls++; admissionInputs.push(input);
    if (calls === 1 || outcome === "exhausted") throw new Error(message);
    return baseSpawn(input, reserved);
  };
  Object.assign(h.ports, { sleep: forbiddenSleep, claimSpawnRetry: () => { throw new Error("a missing receipt has no retry claim"); } });
  await tickPipelines([], h.ports);
  const waiting = loadPipelines()[0]!;
  const attempt = waiting.runs[0]!.attempts[0]!;
  expect(waiting).toMatchObject({ state: "running", cursor: { state: "pending" } });
  expect(waiting.stateDetail).toContain(`stage spawn deferred: ${message}; retry at `);
  expect(attempt).toMatchObject({ n: 1, state: "pending", launchId: null, conversationId: null, spawnCalls: 1,
    controllerWait: { rounds: 1, budgetMs: 600_000, retryMaxMs: 60_000 } });
  expect(h.spawnInputs).toHaveLength(0);
  await tickPipelines([], h.ports);
  expect(calls).toBe(1);
  if (outcome === "released") {
    advance(Date.parse(attempt.controllerWait!.retryAfter) - Date.parse(h.ports.now()) + 1);
    await tickPipelines([], h.ports);
    const running = loadPipelines()[0]!;
    expect(running).toMatchObject({ state: "running", worktreeDir: waiting.worktreeDir });
    expect(running.runs[0]!.attempts).toHaveLength(1);
    expect(running.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "running", launchId: "launch-1", spawnCalls: 2 });
    expect(h.spawnInputs).toHaveLength(1);
    expect(h.spawnInputs[0]).toMatchObject({ cwd: admissionInputs[0]!.cwd, prompt: admissionInputs[0]!.prompt });
  } else {
    const child = Bun.spawn([process.execPath, "-e", `
      const { defaultPipelinePorts, tickPipelines } = await import("./src/lib/pipelines/engine.ts");
      const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
      let calls = 0;
      await tickPipelines([], { ...defaultPipelinePorts(),
        now: () => new Date(Number(process.env.LLV_TEST_CLOCK)).toISOString(),
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        worktreePresent: () => true, sourcePathAllowed: () => false, engineReadiness: () => "connected",
        cpuPressureHold: () => null, cpuAdmissionReconcile: () => {}, drainHold: () => null,
        structuredDeliveryPublication: () => "ready", scheduleTick: () => {},
        spawnAgent: async () => { calls++; throw new Error(process.env.LLV_TEST_BUSY); },
        spawnReceipt: () => null,
        claimSpawnRetry: () => { throw new Error("unexpected receipt claim"); },
      });
      const pipeline = loadPipelines()[0];
      process.stdout.write(JSON.stringify({ calls, pipeline }));
      process.exit(0);
    `], { cwd: process.cwd(), env: { ...process.env, LLV_TEST_CLOCK: String(Date.parse(attempt.controllerWait!.startedAt) + 601_000), LLV_TEST_BUSY: message }, stdout: "pipe", stderr: "pipe" });
    const childDeadline = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 10_000);
    try {
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, errors }).toMatchObject({ code: 0 });
      const result = JSON.parse(output);
      expect({ calls: result.calls, detail: result.pipeline.stateDetail }).toMatchObject({ calls: 1 });
      expect(result.pipeline).toMatchObject({ state: "needs_decision", worktreeDir: waiting.worktreeDir });
      expect(result.pipeline.runs[0].attempts).toHaveLength(1);
      expect(result.pipeline.runs[0].attempts[0]).toMatchObject({ n: 1, launchId: null, conversationId: null, spawnCalls: 2,
        controllerWait: { startedAt: attempt.controllerWait!.startedAt, rounds: 1, budgetMs: 600_000 } });
      expect(result.pipeline.stateDetail).toContain(`stage spawn failed after 1 retries over 601s: ${message}`);
    } finally { clearTimeout(childDeadline); if (child.exitCode === null) child.kill(); await child.exited; }
  }
}, 20_000);


test.each([...RAW_ADMISSION_BUSY])("raw SQLite contention after reservation retains the unresolved receipt: %s", async message => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  frozenWallClock(h);
  let calls = 0;
  h.ports.spawnAgent = async (_input, reserved) => {
    calls++;
    await reserved({ launchId: "launch-locked-reserved", conversationId: "conversation_locked_reserved" });
    throw new Error(message);
  };
  h.ports.spawnReceipt = () => ({ ...failedReceipt("launch-locked-reserved", "conversation_locked_reserved", message), state: "starting" });
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(calls).toBe(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "needs_decision", launchId: "launch-locked-reserved", conversationId: "conversation_locked_reserved" });
  expect(h.spawnInputs).toHaveLength(0);
});


test.each(["SQLITE_CORRUPT: database disk image is malformed", "disk I/O error"])("permanent storage admission failures retain their cause: %s", async message => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  frozenWallClock(h);
  let calls = 0;
  h.ports.spawnAgent = async () => { calls++; throw new Error(message); };
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(calls).toBe(1);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: message });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait).toBeUndefined();
});



test.each(["registry", "account-commit", "lease", "deferred", "wrapped-deferred", "busy-code", "locked-code"])("typed storage admission contention without a receipt uses the same wait: %s", async kind => {
  const { RegistryWriterBusyError } = await import("@/lib/agent/registry");
  const { AccountCommitBusyError } = await import("@/lib/accounts/accountMutationContext");
  const { FileTransactionBusyError } = await import("@/lib/state/fileTransaction");
  const { StateLockDeferredError } = await import("@/lib/state/lockWait");
  const failure = kind === "registry" ? new RegistryWriterBusyError("pipeline.parent")
    : kind === "account-commit" ? new AccountCommitBusyError("state writer is busy during account commit")
    : kind === "lease" ? new FileTransactionBusyError("state admission timed out at pipeline.fixture")
    : kind === "deferred" ? new StateLockDeferredError("pipeline.fixture")
    : kind === "wrapped-deferred" ? new Error("storage admission is being updated", { cause: new StateLockDeferredError("pipeline.fixture") })
    : Object.assign(new Error("SQLite admission is temporarily unavailable"), { code: kind === "busy-code" ? "SQLITE_BUSY" : "SQLITE_LOCKED" });
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  let calls = 0;
  h.ports.spawnAgent = async (input, reserved) => {
    if (++calls === 1) throw failure;
    return baseSpawn(input, reserved);
  };
  Object.assign(h.ports, { sleep: forbiddenSleep });
  await tickPipelines([], h.ports);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt).toMatchObject({ n: 1, state: "pending", launchId: null, conversationId: null,
    controllerWait: { rounds: 1, budgetMs: 600_000, retryMaxMs: 60_000 } });
  expect(loadPipelines()[0]!.stateDetail).toContain(`stage spawn deferred: ${failure.message}; retry at `);
  advance(Date.parse(attempt.controllerWait!.retryAfter) - Date.parse(h.ports.now()) + 1);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "running", launchId: "launch-1", spawnCalls: 2 });
});
