import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { expect, test, AgentRegistry, fs, path, setAgentRegistryForTests, loadPipelines, savePipelines,
  patchPipeline, tickPipelines, reserveActivationOnly, spyOn } from "./engine.fixture";

async function unreservedPark(replacement = true) {
  const h = await reserveActivationOnly();
  const lane = loadPipelines()[0]!;
  const first = lane.runs[0]!.attempts[0]!;
  delete first.activation;
  first.state = "failed";
  first.completedAt = h.ports.now();
  const attempt = replacement ? structuredClone(first) : first;
  if (replacement) {
    attempt.n = 2;
    attempt.restartContext = { previousAttempt: 1, transcriptPath: null };
    lane.runs[0]!.attempts.push(attempt);
  }
  attempt.state = "needs_decision";
  attempt.startedAt = "2026-10-25T06:00:00Z";
  attempt.completedAt = null;
  attempt.spawnCalls = 2;
  attempt.error = "stage spawn failed after 1 retries over 708s: the delivery record's write lock is held by another writer (spawn membership record)";
  lane.state = "needs_decision";
  lane.stateDetail = attempt.error;
  lane.cursor!.state = "spawning";
  savePipelines([lane]);
  const registryPath = path.join(process.env.LLV_STATE_DIR!, "retry-registry.json");
  const registry = new AgentRegistry(registryPath);
  setAgentRegistryForTests(registry);
  const key = (call: number) => {
    const base = `pipeline_${lane.id}_plan_${attempt.n}`;
    return call === 0 ? base : `handshake_retry_${call}_${base}`;
  };
  const reserve = (call: number) => beginLegacySpawnFixture(registry, {
    engine: attempt.effectiveRole.engine, cwd: lane.worktreeDir!, transport: "structured", clientAttemptId: key(call),
    memberships: [{ kind: "pipeline", containerId: lane.id, stageId: "plan", slot: `plan:${attempt.n}`,
      round: attempt.n, role: "architect", stageOrder: 0, parentConversationId: null }],
  });
  return { h, lane, attempt, registry, registryPath, key, reserve,
    close: () => { registry.close(); setAgentRegistryForTests(null); } };
}

test.each([{ replacement: false }, { replacement: true }])("retry-stage starts a fresh attempt after a proven unreserved park: %j", async ({ replacement }) => {
  const f = await unreservedPark(replacement);
  try {
    expect((await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: f.attempt.n }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    const attempts = loadPipelines()[0]!.runs[0]!.attempts;
    expect(attempts).toHaveLength(f.attempt.n + 1);
    expect(attempts.at(-1)).toMatchObject({ n: f.attempt.n + 1, state: "running", launchId: "launch-1", spawnCalls: 1 });
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(f.h.spawnInputs[0]!.clientAttemptId).toBe(`pipeline_${f.lane.id}_plan_${f.attempt.n + 1}`);
  } finally { f.close(); }
});

test.each([false, true].flatMap(replacement => [0, 1].map(call => ({ replacement, call }))))
("retry-stage refuses a receipt hidden before the reservation callback: %j", async ({ replacement, call }) => {
  const f = await unreservedPark(replacement);
  try {
    const reserved = f.reserve(call);
    expect(reserved.kind).toBe("created");
    expect(f.registry.spawnReceiptForClientAttempt(f.key(call))).not.toBeNull();
    const result = await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports);
    expect(result).toMatchObject({ status: 409, error: expect.stringContaining("a reserved receipt is not recorded on the attempt") });
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(f.attempt.n);
    expect(f.h.spawnInputs).toHaveLength(0);
  } finally { f.close(); }
});

test.each(["spawnCalls", "conversationId", "sessionId", "agentPath", "paneId"] as const)
("retry-stage refuses incomplete no-dispatch proof: %s", async field => {
  const f = await unreservedPark();
  try {
    if (field === "spawnCalls") delete f.attempt.spawnCalls;
    else f.attempt[field] = "retained-evidence";
    savePipelines([f.lane]);
    const result = await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports);
    expect(result).toMatchObject({ status: 409, error: expect.stringContaining("cannot prove no dispatch began") });
    expect(f.h.spawnInputs).toHaveLength(0);
  } finally { f.close(); }
});

test.each([false, true].flatMap(suspended => [false, true].map(receipt => ({ suspended, receipt }))))
("account recovery cannot bypass the launch receipt fence: %j", async ({ suspended, receipt }) => {
  const f = await unreservedPark();
  try {
    f.attempt.accountId = "blocked";
    if (suspended) f.attempt.suspension = { reason: "account", detail: "account guard", requestedAt: f.h.ports.now() };
    savePipelines([f.lane]);
    f.h.ports.accountExhausted = (_engine, accountId) => accountId === "blocked";
    if (receipt) f.reserve(1);
    const result = await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports);
    if (receipt) expect(result).toMatchObject({ status: 409, error: expect.stringContaining("a reserved receipt") });
    else {
      expect(result.error).toBeUndefined();
      expect(loadPipelines()[0]!.runs[0]!.attempts[1]).toMatchObject({ state: "failed", completedAt: expect.any(String) });
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: 3, state: "running" });
      expect(f.h.spawnInputs).toHaveLength(1);
    }
    expect(f.h.calls.filter(call => call.startsWith("stop-host:plan:2:"))).toHaveLength(0);
  } finally { f.close(); }
});

test("retry-stage rechecks reservation absence after cleanup yields", async () => {
  const f = await unreservedPark();
  const read = f.registry.spawnReceiptForClientAttempt.bind(f.registry);
  let observations = 0;
  const seam = spyOn(f.registry, "spawnReceiptForClientAttempt").mockImplementation(key => {
    const receipt = read(key);
    // A writer commits after the initial proof's last read. The final guard
    // must observe it before resetting the cursor for a fresh attempt.
    if (++observations === 2) f.reserve(1);
    return receipt;
  });
  try {
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining("a reserved receipt") });
    expect(loadPipelines()[0]!.cursor!.state).toBe("spawning");
    expect(f.h.spawnInputs).toHaveLength(0);
  } finally { seam.mockRestore(); f.close(); }
});

test("retry-stage refuses when durable spawn receipts cannot be read", async () => {
  const f = await unreservedPark();
  const seam = spyOn(f.registry, "spawnReceiptForClientAttempt").mockImplementation(() => { throw new Error("receipt reader unavailable"); });
  try {
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining("durable spawn receipts could not be read") });
    expect(f.h.spawnInputs).toHaveLength(0);
  } finally { seam.mockRestore(); f.close(); }
});

test.each([false, true].flatMap(suspended => [false, true].map(receipt => ({ suspended, receipt }))))
("retry-stage reads durable admission evidence after a controller restart: %j", async ({ receipt, suspended }) => {
  const f = await unreservedPark();
  let restartedRegistry: InstanceType<typeof AgentRegistry> | undefined;
  let registryClosed = false;
  try {
    if (suspended) {
      f.attempt.suspension = { reason: "account", detail: "account guard", requestedAt: f.h.ports.now() };
      savePipelines([f.lane]);
    }
    if (receipt) f.reserve(1);
    f.registry.close();
    registryClosed = true;
    const child = Bun.spawn([process.execPath, "-e", `
      const { defaultPipelinePorts, patchPipeline } = await import("./src/lib/pipelines/engine.ts");
      const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal.ts");
      const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
      const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry.ts");
      const registry = new AgentRegistry(process.env.LLV_TEST_RETRY_REGISTRY);
      setAgentRegistryForTests(registry);
      registerPipelineTick(async () => {});
      const lane = loadPipelines()[0];
      const result = await patchPipeline(lane.id, { action: "retry-stage" }, { ...defaultPipelinePorts(),
        now: () => "2026-10-25T07:00:00Z", exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        worktreePresent: () => true, drainHold: () => null,
        stopStageAgent: async () => ({ outcome: "not-running" }),
      });
      registry.close();
      console.log(JSON.stringify({ error: result.error ?? null, status: result.status ?? 200, cursor: loadPipelines()[0].cursor }));
      process.exit(0);
    `], { env: { ...process.env, LLV_TEST_RETRY_REGISTRY: f.registryPath }, stdout: "pipe", stderr: "pipe",
      signal: AbortSignal.timeout(20_000) });
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, errors }).toMatchObject({ code: 0 });
    const result = JSON.parse(output.trim());
    expect(result.status).toBe(receipt ? 409 : 200);
    if (receipt) expect(result.error).toContain("a reserved receipt");
    else {
      restartedRegistry = new AgentRegistry(f.registryPath);
      setAgentRegistryForTests(restartedRegistry);
      expect(result.cursor.state).toBe("pending");
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(f.h.spawnInputs).toHaveLength(1);
    }
  } finally {
    if (!registryClosed) f.registry.close();
    restartedRegistry?.close();
    setAgentRegistryForTests(null);
  }
});
