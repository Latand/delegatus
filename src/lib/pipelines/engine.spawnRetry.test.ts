import { afterEach, beforeEach, describe, setSystemTime } from "bun:test";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { RegistryReadError, type AgentRegistry as AgentRegistryInstance } from "@/lib/agent/registry";
import { expect, test, crypto, AgentRegistry, fs, path, setAgentRegistryForTests, loadPipelines, savePipelines,
  patchPipeline, tickPipelines, reserveActivationOnly, spyOn, defaultPipelinePorts } from "./engine.fixture";

async function unreservedPark(replacement = true, engine?: "codex" | "claude") {
  const h = await reserveActivationOnly(engine ? [
    { id: "plan", kind: "run", role: { roleId: "architect" }, engine, model: engine === "codex" ? "gpt-6.1-sol" : "fable",
      effort: "high", access: "read-only", prompt: "Plan {{task}}", next: null },
  ] as never : undefined);
  h.ports.now = () => "2026-10-25T07:00:00Z";
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
  const reserve = (call: number, engine = attempt.effectiveRole.engine, cwd = lane.worktreeDir!, role = "architect") => beginLegacySpawnFixture(registry, {
    engine, cwd, transport: "structured", clientAttemptId: key(call),
    memberships: [{ kind: "pipeline", containerId: lane.id, stageId: "plan", slot: `plan:${attempt.n}`,
      round: attempt.n, role, stageOrder: 0, parentConversationId: null }],
  });
  const reserveUnadmitted = (call: number) => (registry as unknown as {
    reserveSpawnRequest(input: Parameters<AgentRegistryInstance["beginSpawnRequest"]>[0]): ReturnType<AgentRegistryInstance["beginSpawnRequest"]>;
  }).reserveSpawnRequest({
    engine: attempt.effectiveRole.engine, cwd: lane.worktreeDir!, transport: "structured", clientAttemptId: key(call),
    role: "architect", launchProfile: { title: "Retry stage fixture" },
    memberships: [{ kind: "pipeline", containerId: lane.id, stageId: "plan", slot: `plan:${attempt.n}`,
      round: attempt.n, role: "architect", stageOrder: 0, parentConversationId: null }],
  });
  return { h, lane, attempt, registry, registryPath, key, reserve,
    reserveUnadmitted,
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

test.each([false, true])("retry-stage accepts safely retired receipts beyond the history cap after restart=%s", async restart => {
  const f = await unreservedPark();
  try {
    for (let call = 2; call < 28; call++) {
      const reserved = f.reserveUnadmitted(call);
      expect(reserved.kind).toBe("created");
      const receipt = reserved.receipt;
      expect(f.registry.retireUnconsumedSpawn(f.key(call), "runtime host failed before dispatch")).toBe(true);
      expect(defaultPipelinePorts().spawnReceipt(receipt.launchId)?.neverBegan).toBe(true);
      expect(f.registry.claimFailedSpawnForRetry(receipt.launchId, `${f.lane.id}:plan:${receipt.launchId}`).kind).toBe("claimed");
      f.attempt.retiredLaunches = [...f.attempt.retiredLaunches ?? [], {
        launchId: receipt.launchId, conversationId: receipt.conversationId,
        error: "runtime host failed before dispatch", retiredAt: f.h.ports.now(),
      }].slice(-25);
    }
    f.attempt.spawnCalls = 28;
    expect(f.attempt.retiredLaunches).toHaveLength(25);
    f.h.ports.spawnReceipt = defaultPipelinePorts().spawnReceipt;
    savePipelines([f.lane]);

    if (restart) {
      f.registry.close();
      const child = Bun.spawn([process.execPath, "-e", `
        const { defaultPipelinePorts, patchPipeline, tickPipelines } = await import("./src/lib/pipelines/engine.ts");
        const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal.ts");
        const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
        const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry.ts");
        const registry = new AgentRegistry(process.env.LLV_TEST_RETRY_REGISTRY);
        setAgentRegistryForTests(registry); registerPipelineTick(async () => {});
        const lane = loadPipelines()[0];
        const spawned = [];
        const ports = { ...defaultPipelinePorts(),
          now: () => "2026-10-25T07:00:00Z", exec: async () => ({ code: 0, stdout: "", stderr: "" }),
          worktreePresent: () => true, drainHold: () => null,
          cpuPressureHold: () => null, structuredDeliveryPublication: () => "ready",
          engineReadiness: () => "connected",
          resolveProjectSpawn: (engine, request) => ({ kind: "available", account: {
            engine, accountId: request.requestedId ?? "retry-test-account", kind: "managed",
            home: process.env.LLV_STATE_DIR, transcriptRoot: process.env.LLV_STATE_DIR, env: { NODE_ENV: "test" },
          } }),
          preflightRepo: repoDir => ({ ok: true, repoDir, gitCommonDir: repoDir + "/.git", worktreeParent: repoDir + "/.." }),
          spawnAgent: async (input, onReserved) => {
            spawned.push(input.clientAttemptId);
            const result = { launchId: "fresh-launch", conversationId: "fresh-conversation", sessionId: "fresh-session",
              ["trans" + "cript"]: "/fresh-stage.jsonl", paneId: null, accountId: null };
            await onReserved(result);
            return result;
          },
        };
        const result = await patchPipeline(lane.id, { action: "retry-stage" }, ports);
        if (!result.error) { await tickPipelines([], ports); await tickPipelines([], ports); }
        const current = loadPipelines()[0].runs.find(run => run.stageId === "plan").attempts.at(-1);
        console.log(JSON.stringify({ status: result.status ?? 200, error: result.error ?? null,
          spawned, state: loadPipelines()[0].state, stateDetail: loadPipelines()[0].stateDetail,
          cursor: loadPipelines()[0].cursor, attempt: { n: current.n, state: current.state, launchId: current.launchId, spawnCalls: current.spawnCalls } }));
        registry.close(); process.exit(0);
      `], { env: { ...process.env, LLV_TEST_RETRY_REGISTRY: f.registryPath }, stdout: "pipe", stderr: "pipe",
        signal: AbortSignal.timeout(20_000) });
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, errors }).toMatchObject({ code: 0 });
      expect(JSON.parse(output.trim())).toMatchObject({ status: 200, error: null,
        spawned: [`pipeline_${f.lane.id}_plan_${f.attempt.n + 1}`],
        attempt: { n: f.attempt.n + 1, state: "running", launchId: "fresh-launch", spawnCalls: 1 } });
    }
    else {
      expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).not.toHaveProperty("error");
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      const current = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
      expect(current).toMatchObject({ n: 3, state: "running", launchId: "launch-1", spawnCalls: 1 });
      expect(f.h.spawnInputs).toHaveLength(1);
    }
  } finally { f.close(); }
});

test.each([false, true])("retry-stage accepts a claimed membership-admitted pre-dispatch failure after restart=%s", async restart => {
  const f = await unreservedPark();
  try {
    const reserved = f.reserve(0);
    expect(reserved.kind).toBe("created");
    const receipt = reserved.receipt;
    const failure = "pipeline structured runtime host is unavailable; start agent-log-viewer through its CLI and check the CLI log for the host startup failure";
    expect(await f.registry.failStructuredSpawnOffLoop(receipt.launchId, failure)).toMatchObject({ claimed: true });
    expect(f.registry.spawnReceipt(receipt.launchId)?.membershipAdmitted).toBe(true);
    expect(defaultPipelinePorts().spawnReceipt(receipt.launchId)?.neverBegan).toBe(true);
    expect(f.registry.claimFailedSpawnForRetry(receipt.launchId, `${f.lane.id}:plan:${receipt.launchId}`).kind).toBe("claimed");
    f.attempt.retiredLaunches = [{ launchId: receipt.launchId, conversationId: receipt.conversationId,
      error: failure, retiredAt: f.h.ports.now() }];
    f.attempt.spawnCalls = 1;
    savePipelines([f.lane]);
    f.h.ports.spawnReceipt = defaultPipelinePorts().spawnReceipt;

    if (restart) {
      f.registry.close();
      const child = Bun.spawn([process.execPath, "-e", `
        const { defaultPipelinePorts, patchPipeline, tickPipelines } = await import("./src/lib/pipelines/engine.ts");
        const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal.ts");
        const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
        const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry.ts");
        const registry = new AgentRegistry(process.env.LLV_TEST_RETRY_REGISTRY);
        setAgentRegistryForTests(registry); registerPipelineTick(async () => {});
        const lane = loadPipelines()[0]; const spawned = [];
        const ports = { ...defaultPipelinePorts(), now: () => "2026-10-25T07:00:00Z",
          exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreePresent: () => true,
          drainHold: () => null, cpuPressureHold: () => null, structuredDeliveryPublication: () => "ready",
          engineReadiness: () => "connected", resolveProjectSpawn: (engine, request) => ({ kind: "available", account: {
            engine, accountId: request.requestedId ?? "retry-test-account", kind: "managed",
            home: process.env.LLV_STATE_DIR, transcriptRoot: process.env.LLV_STATE_DIR, env: { NODE_ENV: "test" },
          } }),
          preflightRepo: repoDir => ({ ok: true, repoDir, gitCommonDir: repoDir + "/.git", worktreeParent: repoDir + "/.." }),
          spawnAgent: async (input, onReserved) => { spawned.push(input.clientAttemptId);
            const result = { launchId: "fresh-launch", conversationId: "fresh-conversation", sessionId: "fresh-session",
              ["trans" + "cript"]: "/fresh-stage.jsonl", paneId: null, accountId: null };
            await onReserved(result); return result; },
        };
        const result = await patchPipeline(lane.id, { action: "retry-stage" }, ports);
        if (!result.error) { await tickPipelines([], ports); await tickPipelines([], ports); }
        const attempt = loadPipelines()[0].runs[0].attempts.at(-1);
        console.log(JSON.stringify({ status: result.status ?? 200, error: result.error ?? null, spawned, attempts: loadPipelines()[0].runs[0].attempts.length,
          attempt: { n: attempt.n, state: attempt.state, launchId: attempt.launchId, spawnCalls: attempt.spawnCalls } }));
        registry.close(); process.exit(0);
      `], { env: { ...process.env, LLV_TEST_RETRY_REGISTRY: f.registryPath }, stdout: "pipe", stderr: "pipe",
        signal: AbortSignal.timeout(20_000) });
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, errors }).toMatchObject({ code: 0 });
      expect(JSON.parse(output.trim())).toMatchObject({ status: 200, error: null,
        spawned: [`pipeline_${f.lane.id}_plan_${f.attempt.n + 1}`],
        attempt: { n: f.attempt.n + 1, state: "running", launchId: "fresh-launch", spawnCalls: 1 } });
    } else {
      expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).not.toHaveProperty("error");
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: f.attempt.n + 1, state: "running", launchId: "launch-1", spawnCalls: 1 });
      expect(f.h.spawnInputs).toHaveLength(1);
    }
  } finally { f.close(); }
});

test("the controller retires a membership-admitted host failure and retry-stage launches once", async () => {
  const h = await reserveActivationOnly();
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  let now = Date.parse(h.ports.now());
  h.ports.now = () => new Date(now).toISOString();
  const registryPath = path.join(process.env.LLV_STATE_DIR!, "controller-retry-registry.json");
  const registry = new AgentRegistry(registryPath);
  setAgentRegistryForTests(registry);
  const durablePorts = defaultPipelinePorts();
  const harnessSpawn = h.ports.spawnAgent;
  const failure = "pipeline structured runtime host is unavailable; start agent-log-viewer through its CLI and check the CLI log for the host startup failure";
  let failedLaunchId: string | null = null;
  h.ports.spawnReceipt = durablePorts.spawnReceipt;
  h.ports.claimSpawnRetry = durablePorts.claimSpawnRetry;
  h.ports.spawnAgent = async (input, onReserved) => {
    const begun = beginLegacySpawnFixture(registry, { engine: input.role.engine, cwd: input.cwd, transport: "structured",
      clientAttemptId: input.clientAttemptId, launchProfile: { title: input.title }, memberships: [input.membership] });
    expect(begun.kind).toBe("created");
    failedLaunchId = begun.receipt.launchId;
    await onReserved({ launchId: begun.receipt.launchId, conversationId: begun.receipt.conversationId,
      accountId: begun.receipt.accountId });
    expect((await registry.failStructuredSpawnOffLoop(begun.receipt.launchId, failure)).claimed).toBe(true);
    throw new Error(failure);
  };
  try {
    await tickPipelines([], h.ports);
    const retired = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(failedLaunchId).toBeTruthy();
    expect(registry.spawnReceipt(failedLaunchId!)?.membershipAdmitted).toBe(true);
    expect(retired).toMatchObject({ launchId: null, conversationId: null, state: "pending" });
    expect(retired.retiredLaunches?.map(row => row.launchId)).toContain(failedLaunchId!);

    now = Date.parse(retired.controllerWait!.startedAt) + 10 * 60_000 + 1;
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });

    expect(await patchPipeline(lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: attempt.n }, h.ports))
      .not.toHaveProperty("error");
    h.ports.spawnAgent = harnessSpawn;
    h.ports.spawnReceipt = () => null;
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    const attempts = loadPipelines()[0]!.runs[0]!.attempts;
    expect(attempts).toHaveLength(attempt.n + 1);
    expect(attempts.at(-1)).toMatchObject({ n: attempt.n + 1, state: "running", launchId: "launch-1", spawnCalls: 1 });
    expect(h.spawnInputs).toHaveLength(1);
  } finally { registry.close(); setAgentRegistryForTests(null); }
});

test("retry-stage refuses a failed receipt whose retirement is not recorded", async () => {
  const f = await unreservedPark();
  try {
    const reserved = f.reserve(0);
    expect(reserved.kind).toBe("created");
    expect(f.registry.failSpawn(reserved.receipt.launchId, "first-message outcome is uncertain")).toBe(true);
    f.h.ports.spawnReceipt = defaultPipelinePorts().spawnReceipt;
    expect(f.h.ports.spawnReceipt(reserved.receipt.launchId)?.neverBegan).toBe(false);
    expect(f.registry.claimFailedSpawnForRetry(reserved.receipt.launchId,
      `${f.lane.id}:plan:${reserved.receipt.launchId}`).kind).toBe("claimed");
    const result = await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports);
    expect(result).toMatchObject({ status: 409, error: expect.stringContaining("a reserved receipt") });
    expect(f.h.spawnInputs).toHaveLength(0);
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
    if (receipt) {
      expect(result).toMatchObject({ status: 409, error: expect.stringContaining("a reserved receipt") });
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
      expect(f.h.spawnInputs).toHaveLength(0);
    }
    else {
      expect(result.error).toBeUndefined();
      // Cancellation or a later controller may replace the original spawn
      // error. Durable settlement must still prevent account recovery on it.
      const rows = loadPipelines();
      rows[0]!.runs[0]!.attempts[1]!.error = "account recovery retry pending";
      savePipelines(rows);
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
      .toMatchObject({ status: 409, error: expect.stringContaining("evidence changed during reconciliation") });
    expect(loadPipelines()[0]!.cursor!.state).toBe("spawning");
    expect(f.h.spawnInputs).toHaveLength(0);
  } finally { seam.mockRestore(); f.close(); }
});

test("retry-stage refuses when durable spawn receipts cannot be read", async () => {
  const f = await unreservedPark();
  const seam = spyOn(f.registry, "spawnReceiptForClientAttempt").mockImplementation(() => { throw new RegistryReadError("agent registry schema is unsupported"); });
  try {
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining("agent registry schema is unsupported") });
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
    const reservedLaunch = receipt ? f.reserve(1).receipt.launchId : null;
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
      console.log(JSON.stringify({ error: result.error ?? null, status: result.status ?? 200, cursor: loadPipelines()[0].cursor,
        launchId: loadPipelines()[0].runs[0].attempts.at(-1).launchId }));
      process.exit(0);
    `], { env: { ...process.env, LLV_TEST_RETRY_REGISTRY: f.registryPath }, stdout: "pipe", stderr: "pipe",
      signal: AbortSignal.timeout(20_000) });
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, errors }).toMatchObject({ code: 0 });
    const result = JSON.parse(output.trim());
    expect(result.status).toBe(receipt ? 409 : 200);
    if (receipt) {
      expect(result.error).toContain("a reserved receipt");
      expect(result.launchId).toBe(reservedLaunch);
    } else {
      restartedRegistry = new AgentRegistry(f.registryPath);
      setAgentRegistryForTests(restartedRegistry);
      expect(result.cursor.state).toBe("pending");
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: 3, state: "running" });
      expect(f.h.spawnInputs).toHaveLength(1);
    }
  } finally {
    if (!registryClosed) f.registry.close();
    restartedRegistry?.close();
    setAgentRegistryForTests(null);
  }
});

describe("callback retry proof", () => {
  let namespace = 0;
  let ids: ReturnType<typeof spyOn<typeof crypto, "randomUUID">>;
  beforeEach(() => {
    let sequence = 0;
    ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
      `${String(namespace).padStart(8, "0")}-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
    setSystemTime(new Date("2026-10-25T07:00:00Z"));
  });
  afterEach(() => { ids.mockRestore(); setSystemTime(); });

  test.each([false, true])("retry-stage retries a retired callback failure after controller restart=%s", async restart => {
    namespace = restart ? 2 : 1;
    const h = await reserveActivationOnly([
      { id: "plan", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build {{task}}", next: null },
    ] as never);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    let now = Date.parse(h.ports.now());
    h.ports.now = () => new Date(now).toISOString();
    const registryPath = path.join(process.env.LLV_STATE_DIR!, "controller-retry-registry.json");
    const registry = new AgentRegistry(registryPath);
    setAgentRegistryForTests(registry);
    const durablePorts = defaultPipelinePorts();
    const harnessSpawn = h.ports.spawnAgent;
    const failure = "Codex callback listener failed before dispatch: exited with code 23; stderr: callback bind refused";
    let failedLaunchId: string | null = null;
    h.ports.spawnReceipt = durablePorts.spawnReceipt;
    h.ports.claimSpawnRetry = durablePorts.claimSpawnRetry;
    h.ports.spawnAgent = async (input, onReserved) => {
      expect(input.role.engine).toBe("codex");
      const begun = beginLegacySpawnFixture(registry, { engine: input.role.engine, cwd: input.cwd, transport: "structured",
        clientAttemptId: input.clientAttemptId, launchProfile: { title: input.title }, memberships: [input.membership] });
      expect(begun.kind).toBe("created");
      failedLaunchId = begun.receipt.launchId;
      await onReserved({ launchId: begun.receipt.launchId, conversationId: begun.receipt.conversationId,
        accountId: begun.receipt.accountId });
      expect(await registry.failSpawnOffLoop(begun.receipt.launchId, failure)).toBe(true);
      throw new Error(failure);
    };
    try {
      await tickPipelines([], h.ports);
      const retired = loadPipelines()[0]!.runs[0]!.attempts[0]!;
      expect(failedLaunchId).toBeTruthy();
      expect(registry.spawnReceipt(failedLaunchId!)).toMatchObject({ engine: "codex", membershipAdmitted: true });
      expect(retired).toMatchObject({ launchId: null, conversationId: null, state: "pending" });
      expect(retired.retiredLaunches?.map(row => row.launchId)).toContain(failedLaunchId!);

      now = Date.parse(retired.controllerWait!.startedAt) + 10 * 60_000 + 1;
      await tickPipelines([], h.ports);
      expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });

      if (restart) {
        registry.close();
        const child = Bun.spawn([process.execPath, "-e", `
          const { defaultPipelinePorts, patchPipeline, tickPipelines } = await import("./src/lib/pipelines/engine.ts");
          const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal.ts");
          const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
          const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry.ts");
          const registry = new AgentRegistry(process.env.LLV_TEST_RETRY_REGISTRY);
          setAgentRegistryForTests(registry); registerPipelineTick(async () => {});
          const lane = loadPipelines()[0], spawned = [];
          const ports = { ...defaultPipelinePorts(), now: () => "2026-10-25T07:00:00Z",
            exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreePresent: () => true,
            drainHold: () => null, cpuPressureHold: () => null, structuredDeliveryPublication: () => "ready",
            engineReadiness: () => "connected", resolveProjectSpawn: (engine, request) => ({ kind: "available", account: {
              engine, accountId: request.requestedId ?? "retry-test-account", kind: "managed",
              home: process.env.LLV_STATE_DIR, transcriptRoot: process.env.LLV_STATE_DIR, env: { NODE_ENV: "test" },
            } }),
            preflightRepo: repoDir => ({ ok: true, repoDir, gitCommonDir: repoDir + "/.git", worktreeParent: repoDir + "/.." }),
            spawnAgent: async (input, onReserved) => { spawned.push(input.clientAttemptId);
              const result = { launchId: "fresh-launch", conversationId: "fresh-conversation", sessionId: "fresh-session",
                ["trans" + "cript"]: "/fresh-stage.jsonl", paneId: null, accountId: null };
              await onReserved(result); return result; },
          };
          const result = await patchPipeline(lane.id, { action: "retry-stage" }, ports);
          if (!result.error) { await tickPipelines([], ports); await tickPipelines([], ports); }
          const attempt = loadPipelines()[0].runs[0].attempts.at(-1);
          console.log(JSON.stringify({ status: result.status ?? 200, error: result.error ?? null, spawned, attempts: loadPipelines()[0].runs[0].attempts.length,
            attempt: { n: attempt.n, state: attempt.state, launchId: attempt.launchId, spawnCalls: attempt.spawnCalls } }));
          registry.close(); process.exit(0);
        `], { env: { ...process.env, LLV_TEST_RETRY_REGISTRY: registryPath }, stdout: "pipe", stderr: "pipe",
          signal: AbortSignal.timeout(20_000) });
        const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({ code, errors }).toMatchObject({ code: 0 });
        expect(JSON.parse(output.trim())).toMatchObject({ status: 200, error: null, attempts: attempt.n + 1,
          spawned: [`pipeline_${lane.id}_plan_${attempt.n + 1}`],
          attempt: { n: attempt.n + 1, state: "running", launchId: "fresh-launch", spawnCalls: 1 } });
      } else {
        expect(await patchPipeline(lane.id, { action: "retry-stage", expectedStageId: "plan", expectedAttempt: attempt.n }, h.ports))
          .not.toHaveProperty("error");
        h.ports.spawnAgent = harnessSpawn;
        h.ports.spawnReceipt = () => null;
        await tickPipelines([], h.ports);
        await tickPipelines([], h.ports);
        const attempts = loadPipelines()[0]!.runs[0]!.attempts;
        expect(attempts).toHaveLength(attempt.n + 1);
        expect(attempts.at(-1)).toMatchObject({ n: attempt.n + 1, state: "running", launchId: "launch-1", spawnCalls: 1 });
        expect(h.spawnInputs).toHaveLength(1);
        expect(h.spawnInputs[0]!.clientAttemptId).toBe(`pipeline_${lane.id}_plan_${attempt.n + 1}`);
      }
    } finally { registry.close(); setAgentRegistryForTests(null); }
  });

  test.each([
    "Codex callback listener ownership could not be verified (listener still alive)",
    "Codex callback setup cleanup did not settle; Codex callback listener failed before dispatch: timed out after 10000ms",
    "Codex callback listener failed before dispatch without durable proof",
  ])("retry-stage refuses a claimed callback receipt without pre-dispatch proof: %s", async failure => {
    namespace = failure.includes("ownership") ? 3 : failure.includes("cleanup") ? 4 : 5;
    const f = await unreservedPark(true, "codex");
    try {
      const { receipt } = f.reserve(0);
      expect(await f.registry.failSpawnOffLoop(receipt.launchId, failure)).toBe(true);
      expect(f.registry.claimFailedSpawnForRetry(receipt.launchId, `${f.lane.id}:plan:${receipt.launchId}`).kind).toBe("claimed");
      f.h.ports.spawnReceipt = defaultPipelinePorts().spawnReceipt;
      expect(f.h.ports.spawnReceipt(receipt.launchId)?.neverBegan).toBe(false);
      expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
        .toMatchObject({ status: 409, error: expect.stringContaining("a reserved receipt") });
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(f.attempt.n);
      expect(f.h.spawnInputs).toHaveLength(0);
    } finally { f.close(); }
  });
});


test.each([0, 1])("retry-stage durably binds an uncertain original receipt from call %s", async call => {
  const f = await unreservedPark();
  try {
    const { receipt } = f.reserve(call);
    expect(await f.registry.failSpawnOffLoop(receipt.launchId, "first-message outcome is uncertain")).toBe(true);
    f.attempt.retiredLaunches = [{ launchId: receipt.launchId, conversationId: receipt.conversationId,
      error: "first-message outcome is uncertain", retiredAt: f.h.ports.now() }];
    savePipelines([f.lane]);
    f.h.ports.spawnReceipt = defaultPipelinePorts().spawnReceipt;
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining(`spawn_message_${receipt.launchId}`) });
    const held = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    expect(held).toMatchObject({ launchId: receipt.launchId, conversationId: receipt.conversationId,
      spawnCalls: 2, retiredLaunches: f.attempt.retiredLaunches });
    expect(f.registry.spawnReceiptForClientAttempt(f.key(call))?.launchId).toBe(receipt.launchId);
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining(`spawn_message_${receipt.launchId}`) });
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.launchId).toBe(receipt.launchId);
    expect(f.h.spawnInputs).toHaveLength(0);
  } finally { f.close(); }
});

test.each([false, true])("an admission interruption binds the receipt before the callback (uncertain=%s)", async uncertain => {
  const h = await reserveActivationOnly();
  const now = h.ports.now();
  h.ports.now = () => now;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "interrupted-reservation.json"));
  setAgentRegistryForTests(registry);
  const ports = defaultPipelinePorts();
  h.ports.spawnReceipt = ports.spawnReceipt;
  h.ports.claimSpawnRetry = ports.claimSpawnRetry;
  let launchId = "", conversationId = "", calls = 0;
  const { DELIVERY_UNVERIFIED_BY_EARLIER_EXECUTOR } = await import("@/lib/runtime/structuredDeliveryQueue");
  const reason = uncertain ? DELIVERY_UNVERIFIED_BY_EARLIER_EXECUTOR
    : "pipeline structured runtime host is unavailable; start agent-log-viewer through its CLI and check the CLI log for the host startup failure";
  h.ports.spawnAgent = async input => {
    calls++;
    const begun = beginLegacySpawnFixture(registry, { engine: input.role.engine, cwd: input.cwd, transport: "structured",
      clientAttemptId: input.clientAttemptId, memberships: [input.membership] });
    expect(begun.kind).toBe("created");
    launchId = begun.receipt.launchId; conversationId = begun.receipt.conversationId;
    expect(await registry.failSpawnOffLoop(launchId, reason)).toBe(true);
    throw new Error(reason);
  };
  try {
    await tickPipelines([], h.ports);
    const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(calls).toBe(1);
    if (uncertain) {
      expect(attempt).toMatchObject({ launchId, conversationId, state: "needs_decision" });
      expect(attempt.retiredLaunches).toBeUndefined();
    } else {
      expect(attempt).toMatchObject({ launchId: null, conversationId: null, state: "pending",
        retiredLaunches: [{ launchId, conversationId }] });
    }
    expect(registry.spawnReceiptForClientAttempt(`pipeline_${loadPipelines()[0]!.id}_plan_1`)?.launchId).toBe(launchId);
  } finally { registry.close(); setAgentRegistryForTests(null); }
});


test.each(["engine", "worktree", "role"] as const)("reconciliation refuses a foreign %s identity", async field => {
  const f = await unreservedPark();
  try {
    const engine = f.attempt.effectiveRole.engine;
    f.reserve(0, field === "engine" ? engine === "codex" ? "claude" : "codex" : engine,
      field === "worktree" ? `${f.lane.worktreeDir}-foreign` : f.lane.worktreeDir!,
      field === "role" ? "reviewer" : "architect");
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining("identity conflicts") });
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.launchId).toBeNull();
    expect(f.h.spawnInputs).toHaveLength(0);
  } finally { f.close(); }
});

test("oversized request history keeps custody without scanning or dispatch", async () => {
  const f = await unreservedPark();
  const read = spyOn(f.registry, "spawnReceiptForClientAttempt");
  try {
    f.attempt.spawnCalls = 129;
    savePipelines([f.lane]);
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining("exceeds 128 records") });
    expect(read).not.toHaveBeenCalled();
    expect(f.h.spawnInputs).toHaveLength(0);
  } finally { read.mockRestore(); f.close(); }
});


test.each(["pre-host", "fenced-first-message"].flatMap(mode => [false, true].map(held => ({ mode, held }))))
("a reconciled launch requires its original journal fence and confirmed host stop: %j", async ({ mode, held }) => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const f = await unreservedPark(true, "codex");
  const journal = new RuntimeJournal(path.join(process.env.LLV_STATE_DIR!, "reconciled-runtime.sqlite"), { structuredHosts: true, now: () => Date.parse(f.h.ports.now()) });
  const { receipt } = f.reserve(0);
  const { DELIVERY_UNVERIFIED_BY_EARLIER_EXECUTOR } = await import("@/lib/runtime/structuredDeliveryQueue");
  const { SEND_LOST_REASON } = await import("@/lib/runtime/sendSettlement");
  const reason = mode === "pre-host" ? "structured spawn interrupted before identity staging: capability writer refused"
    : DELIVERY_UNVERIFIED_BY_EARLIER_EXECUTOR;
  const client = {
    operationStatus: async (id: string) => journal.operationResult(id),
    snapshot: async () => journal.snapshot(), events: async (after: number) => journal.replay(after),
  } as import("@/lib/runtime/client").RuntimeHostClient;
  try {
    journal.executeOperation({ kind: "spawn", operationId: receipt.launchId, idempotencyKey: receipt.launchId,
      conversationId: receipt.conversationId, engine: receipt.engine, cwd: f.lane.worktreeDir!, prompt: "Review" });
    if (mode === "fenced-first-message") {
      journal.append({ scope: { type: "session", id: receipt.conversationId }, kind: "session-status", payload: {
        conversationId: receipt.conversationId, sessionKey: { engine: receipt.engine, sessionId: "fenced-stage" },
        hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured",
        capabilities: { steer: true, structuredAttention: true },
      } });
      journal.executeOperation({ kind: "send", operationId: `spawn_message_${receipt.launchId}`,
        idempotencyKey: `spawn_${receipt.launchId}`, conversationId: receipt.conversationId, text: "Review", policy: "queue" });
      journal.transitionOperation(`spawn_message_${receipt.launchId}`, "failed", { reason: SEND_LOST_REASON });
    }
    journal.transitionOperation(receipt.launchId, "failed", { reason });
    expect((await f.registry.failStructuredSpawnOffLoop(receipt.launchId, reason)).claimed).toBe(true);
    const ports = defaultPipelinePorts({ spawnRecoveryClient: () => client });
    f.h.ports.spawnReceipt = ports.spawnReceipt;
    f.h.ports.claimSpawnRetry = ports.claimSpawnRetry;
    f.h.ports.unpublishedLaunchRetrySafe = ports.unpublishedLaunchRetrySafe;
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).toMatchObject({ status: 409 });
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.launchId).toBe(receipt.launchId);
    const stop = f.h.ports.stopStageAgent;
    let stops = 0;
    f.h.ports.stopStageAgent = async (...args) => { stops++; return held ? { outcome: "deferred" } : stop(...args); };
    const retry = await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports);
    expect(stops).toBe(1);
    if (held) {
      expect(retry).toMatchObject({ status: 409 });
      expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.launchId).toBe(receipt.launchId);
      expect(f.h.spawnInputs).toHaveLength(0);
      return;
    }
    expect(retry).not.toHaveProperty("error");
    expect(loadPipelines()[0]!.cursor).toMatchObject({ stageId: "plan", state: "pending" });
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: f.attempt.n, state: "failed",
      launchId: receipt.launchId, conversationId: receipt.conversationId });
    expect(f.registry.spawnReceipt(receipt.launchId)?.retryClaim?.claimId).toBe(`${f.lane.id}:plan:${receipt.launchId}`);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: f.attempt.n + 1, state: "running", launchId: "launch-1" });
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { journal.close(); f.close(); }
});
