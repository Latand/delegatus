import { expect, test, reserveActivationOnly, loadPipelines, savePipelines, patchPipeline, tickPipelines, engineModule, AgentRegistry, setAgentRegistryForTests, path, recoveryReport, registerPipelineTick } from "./engine.fixture";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { reportLaneFrom } from "@/lib/orchestrator/boardReportRun";

test("retry recovers a zero-launch pending replacement after pause/resume with a stale activation (#2996)", async () => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  pipeline.runs[0]!.attempts.unshift({ ...structuredClone(attempt), n: 1, activation: undefined,
    state: "failed", completedAt: h.ports.now(), error: "superseded launch failure" });
  attempt.n = 2;
  attempt.state = "pending";
  attempt.startedAt = null;
  pipeline.cursor!.state = "pending";
  savePipelines(records);
  expect((await patchPipeline(pipeline.id, { action: "pause" }, h.ports)).error).toBeUndefined();
  expect((await patchPipeline(pipeline.id, { action: "resume" }, h.ports)).error).toBeUndefined();
  h.ports.structuredDeliveryPublication = () => "unbound";
  const retry = await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: pipeline.cursor!.stageId, expectedAttempt: 2 }, h.ports);
  expect(retry.error).toBeUndefined();
  await tickPipelines([], h.ports);
  const waiting = loadPipelines()[0]!;
  expect(waiting.runs[0]!.attempts[1]).toMatchObject({ launchId: null, conversationId: null, startedAt: null });
  expect(waiting.stateDetail).toContain("delivery controller");
  expect(reportLaneFrom(waiting).failure).toBeNull();
  h.ports.structuredDeliveryPublication = () => "ready";
  for (let i = 0; i < 3; i++) {
    await engineModule.drainStageActivations(h.ports);
    await tickPipelines([], h.ports);
  }
  const recovered = loadPipelines()[0]!;
  expect(recovered.runs[0]!.attempts).toHaveLength(2);
  expect(recovered.runs[0]!.attempts[1]).toMatchObject({ n: 2, state: "running", launchId: "launch-1", spawnCalls: 1 });
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(1);
  expect(reportLaneFrom(recovered).failure).toBeNull();
  // A fresh process has no in-memory activation guard. Durable settlement
  // must still prevent a second launch.
  const child = Bun.spawn([process.execPath, "-e", `
    const { drainStageActivations, defaultPipelinePorts } = await import("./src/lib/pipelines/engine.ts");
    await drainStageActivations({ ...defaultPipelinePorts(), structuredDeliveryPublication: () => "ready",
      spawnAgent: async () => { throw new Error("duplicate launch after restart"); },
    });
  `], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, stderr }).toMatchObject({ code: 0 });
  expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.launchId).toBe("launch-1");
});

test.each(["launchId", "conversationId", "agentPath", "paneId", "startedAt", "report", "verdict"] as const)
("pending retry refuses an attempt with retained %s evidence (#2996)", async field => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  attempt.state = "pending";
  attempt.startedAt = null;
  pipeline.cursor!.state = "pending";
  Object.assign(attempt, { [field]: field === "verdict" ? { status: "fail" }
    : field === "report" ? recoveryReport(h.ports.now())
    : field === "startedAt" ? h.ports.now() : "retained-evidence" });
  savePipelines(records);
  const before = loadPipelines()[0]!.runs[0]!.attempts[0]!.activation;
  const retry = await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);
  expect(retry.status).toBe(409);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation).toEqual(before);
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
});

test.each(["running", "paused"] as const)("pending retry preserves custody and request guards, state=%s (#2996)", async state => {
  const paused = state === "paused";
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  attempt.state = "pending";
  attempt.startedAt = null;
  pipeline.cursor!.state = "pending";
  if (paused) { pipeline.state = "paused"; pipeline.pausedState = "running"; }
  savePipelines(records);
  const before = loadPipelines()[0]!.runs[0]!.attempts[0]!.activation;
  for (const guard of [{ expectedStageId: "other-stage" }, { expectedStageId: "plan", expectedAttempt: 2 }, { stageId: "plan", launchId: "stale-launch" }]) {
    expect((await patchPipeline(pipeline.id, { action: "retry-stage", ...guard }, h.ports)).status).toBe(409);
  }
  for (let i = 0; i < 2; i++) {
    expect((await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 1 }, h.ports)).error).toBeUndefined();
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation).toEqual(before);
  }
  expect(loadPipelines()[0]!.state).toBe(paused ? "paused" : "running");
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
});

test("a stale reservation with an admitted receipt keeps the original launch in custody (#2996)", async () => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "pending-registry.json"));
  setAgentRegistryForTests(registry);
  try {
    const admitted = beginLegacySpawnFixture(registry, { engine: attempt.effectiveRole.engine,
      cwd: pipeline.worktreeDir!, clientAttemptId: attempt.activation!.clientAttemptId, transport: "structured",
      memberships: [attempt.activation!.input.membership] });
    if (admitted.kind !== "created") throw new Error("fixture receipt admission failed");
    attempt.activation!.phase = "reserving";
    attempt.spawnCalls = 1;
    attempt.state = "pending";
    attempt.startedAt = null;
    pipeline.cursor!.state = "pending";
    savePipelines(records);
    await patchPipeline(pipeline.id, { action: "pause" }, h.ports);
    await patchPipeline(pipeline.id, { action: "resume" }, h.ports);
    expect((await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
    await engineModule.drainStageActivations(h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
      launchId: admitted.receipt.launchId, conversationId: admitted.receipt.conversationId,
      state: "spawning", spawnCalls: 1,
    });
    expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
    expect(reportLaneFrom(loadPipelines()[0]!).wait).toContain("original launch receipt");
  } finally { registry.close(); setAgentRegistryForTests(null); }
});

test.each(["unbound", "rebinding"] as const)("a pending attempt without an activation waits for the %s controller and launches once (#2996)", async publication => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  delete attempt.activation;
  attempt.state = "pending";
  attempt.startedAt = null;
  pipeline.cursor!.state = "pending";
  savePipelines(records);
  h.ports.structuredDeliveryPublication = () => publication;
  expect((await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain(`delivery controller (${publication})`);
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
  h.ports.structuredDeliveryPublication = () => "ready";
  if (publication === "rebinding") {
    const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait!;
    h.advanceWallClock(Date.parse(wait.retryAfter) - Date.parse(h.ports.now()));
  }
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
});

test("a recovered pending attempt refuses a launch after its recorded controller deadline (#2996)", async () => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  delete attempt.activation;
  attempt.state = "pending";
  attempt.startedAt = null;
  pipeline.cursor!.state = "pending";
  savePipelines(records);
  h.ports.structuredDeliveryPublication = () => "rebinding";
  await tickPipelines([], h.ports);
  const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait!;
  h.advanceWallClock(Date.parse(wait.startedAt) + wait.budgetMs! - Date.parse(h.ports.now()));
  h.ports.structuredDeliveryPublication = () => "ready";
  await tickPipelines([], h.ports);
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait).toEqual(wait);
});

test("pending retry preserves a booked controller backoff and names its deadline (#2996)", async () => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  delete attempt.activation;
  attempt.state = "pending";
  attempt.startedAt = null;
  attempt.controllerWait = { startedAt: h.ports.now(), retryAfter: new Date(Date.parse(h.ports.now()) + 60_000).toISOString(), rounds: 1 };
  pipeline.cursor!.state = "pending";
  savePipelines(records);
  const before = structuredClone(attempt.controllerWait);
  expect((await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait).toEqual(before);
  expect(loadPipelines()[0]!.stateDetail).toContain(before.retryAfter);
  expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
});

test.each(["unadmitted", "admitted"] as const)("retry reconciles a stale %s activation on a failed predecessor before launching its replacement (#2996)", async admission => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const predecessor = pipeline.runs[0]!.attempts[0]!;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "predecessor-registry.json"));
  setAgentRegistryForTests(registry);
  try {
    const reserved = admission === "admitted" ? beginLegacySpawnFixture(registry, {
      engine: predecessor.effectiveRole.engine, cwd: pipeline.worktreeDir!,
      clientAttemptId: predecessor.activation!.clientAttemptId, transport: "structured",
      memberships: [predecessor.activation!.input.membership],
    }) : null;
    if (reserved && reserved.kind !== "created") throw new Error("fixture receipt admission failed");
    const receipt = reserved?.kind === "created" ? reserved.receipt : null;
    let receiptState: "starting" | "failed" = "starting";
    if (receipt) {
      predecessor.activation!.phase = "reserving";
      predecessor.spawnCalls = 1;
      h.ports.spawnReceipt = id => id === receipt.launchId ? ({ launchId: receipt.launchId, conversationId: receipt.conversationId,
        state: receiptState, sessionId: null, transcript: null, paneId: null }) : null;
    }
    predecessor.state = "failed";
    predecessor.completedAt = h.ports.now();
    predecessor.error = "pipeline paused";
    const replacement = { ...structuredClone(predecessor), n: 2, state: "pending" as const,
      startedAt: null, completedAt: null, error: null, activation: undefined, spawnCalls: undefined };
    predecessor.roleMemoryWait = { revision: "settled-memory", observations: 0, retryAfter: "2099-01-01T00:00:00.000Z" };
    pipeline.runs[0]!.attempts.push(replacement);
    pipeline.cursor!.state = "pending";
    savePipelines(records);
    await patchPipeline(pipeline.id, { action: "pause" }, h.ports);
    await patchPipeline(pipeline.id, { action: "resume" }, h.ports);
    h.ports.structuredDeliveryPublication = () => "unbound";
    expect((await patchPipeline(pipeline.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: 2 }, h.ports)).error).toBeUndefined();
    await tickPipelines([], h.ports);
    expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
    h.ports.structuredDeliveryPublication = () => "ready";
    await engineModule.drainStageActivations(h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: "pipeline paused" });
    if (receipt) {
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation?.phase).toBe("dispatching");
      await new Promise(resolve => setImmediate(resolve));
      let wakes = 0;
      const unregister = registerPipelineTick(async () => { wakes++; });
      try {
        await tickPipelines([], h.ports);
        await new Promise(resolve => setImmediate(resolve));
        expect(wakes).toBe(0);
      } finally { unregister(); registerPipelineTick(async () => {}); }
      expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
      expect(loadPipelines()[0]!.cursor!.state).toBe("pending");
      const child = Bun.spawn([process.execPath, "-e", `
        const { drainStageActivations, defaultPipelinePorts } = await import("./src/lib/pipelines/engine.ts");
        await drainStageActivations({ ...defaultPipelinePorts(), structuredDeliveryPublication: () => "ready",
          spawnReceipt: () => (${JSON.stringify({ launchId: receipt.launchId, conversationId: receipt.conversationId,
            state: "starting", sessionId: null, transcript: null, paneId: null })}),
          spawnAgent: async () => { throw new Error("duplicate launch during receipt recovery"); },
        });
      `], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ code, stderr }).toMatchObject({ code: 0 });
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation?.phase).toBe("dispatching");
      receiptState = "failed";
      await engineModule.drainStageActivations(h.ports);
    }
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[1]).toMatchObject({ state: "running", launchId: "launch-1" });
    expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(1);
    expect(reportLaneFrom(loadPipelines()[0]!).failure).toBeNull();
  } finally { registry.close(); setAgentRegistryForTests(null); }
});

test.each(["membership", "engine", "worktree", "transport"] as const)
("stale activation recovery refuses a receipt with mismatched %s (#2996)", async mismatch => {
  const h = await reserveActivationOnly();
  const records = loadPipelines();
  const pipeline = records[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "foreign-receipt-registry.json"));
  setAgentRegistryForTests(registry);
  try {
    const reserved = beginLegacySpawnFixture(registry, {
      engine: mismatch === "engine" ? (attempt.effectiveRole.engine === "codex" ? "claude" : "codex") : attempt.effectiveRole.engine,
      cwd: mismatch === "worktree" ? `${pipeline.worktreeDir}-foreign` : pipeline.worktreeDir!,
      clientAttemptId: attempt.activation!.clientAttemptId, transport: mismatch === "transport" ? "tmux" : "structured",
      ...(mismatch !== "membership" ? { memberships: [attempt.activation!.input.membership] } : {}),
    });
    if (reserved.kind !== "created") throw new Error("fixture receipt admission failed");
    attempt.activation!.phase = "reserving";
    attempt.state = "pending";
    attempt.startedAt = null;
    pipeline.cursor!.state = "pending";
    savePipelines(records);
    await patchPipeline(pipeline.id, { action: "pause" }, h.ports);
    await patchPipeline(pipeline.id, { action: "resume" }, h.ports);
    await engineModule.drainStageActivations(h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.launchId).toBeNull();
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation).toBeDefined();
    expect(loadPipelines()[0]!.stateDetail).toContain("stage membership");
    expect(registry.spawnReceipt(reserved.receipt.launchId)?.state).toBe("starting");
    expect(h.calls.filter(call => call.startsWith("spawn:"))).toHaveLength(0);
  } finally { registry.close(); setAgentRegistryForTests(null); }
});
