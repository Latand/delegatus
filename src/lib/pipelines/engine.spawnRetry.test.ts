import { afterEach, beforeEach, describe, setSystemTime } from "bun:test";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { RegistryReadError, type AgentRegistry as AgentRegistryInstance } from "@/lib/agent/registry";
import { spawn } from "node:child_process";
import { supervisedRuntimeHostUnavailableReason } from "@/lib/runtime/flags";
import { Database } from "bun:sqlite";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { fixtureReport, ownFixtureTree, stopFixtureProcess } from "@/lib/testing/fixtureProcess";
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

test.each(["conversationId", "sessionId", "agentPath", "paneId"] as const)
("retry-stage refuses incomplete no-dispatch proof: %s", async field => {
  const f = await unreservedPark();
  try {
    f.attempt[field] = "retained-evidence";
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

describe("durable retry after controller restart", () => {
  let namespace = "00001000";
  let ids: ReturnType<typeof spyOn<typeof crypto, "randomUUID">>;
  beforeEach(() => {
    let sequence = 0;
    ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
      `${namespace}-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
    setSystemTime(new Date("2026-10-25T07:00:00Z"));
  });
  afterEach(() => { ids.mockRestore(); setSystemTime(); });

  test.each([false, true].flatMap(legacy => [false, true].flatMap(suspended =>
    [false, true].map(receipt => ({ legacy, suspended, receipt })))))
  ("retry-stage reads durable admission evidence after a controller restart: %j", async ({ legacy, receipt, suspended }) => {
    namespace = `00001${Number(legacy)}${Number(suspended)}${Number(receipt)}`;
    const f = await unreservedPark();
    let restartedRegistry: InstanceType<typeof AgentRegistry> | undefined;
    let registryClosed = false;
    try {
      if (legacy) {
        delete f.attempt.spawnCalls;
        f.attempt.controllerWait = { startedAt: f.attempt.startedAt!, rounds: 5, retryAfter: f.h.ports.now() };
      }
      if (suspended) {
        f.attempt.suspension = { reason: "account", detail: "account guard", requestedAt: f.h.ports.now() };
      }
      savePipelines([f.lane]);
      const reservedLaunch = receipt ? f.reserve(legacy ? 7 : 1).receipt.launchId : null;
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
        const ports = { ...defaultPipelinePorts(),
          now: () => "2026-10-25T07:00:00Z", exec: async () => ({ code: 0, stdout: "", stderr: "" }),
          worktreePresent: () => true, drainHold: () => null,
          stopStageAgent: async () => ({ outcome: "not-running" }),
        };
        const first = await patchPipeline(lane.id, { action: "retry-stage" }, ports);
        const reconciled = loadPipelines()[0].runs[0].attempts.at(-1);
        const result = ${legacy} ? await patchPipeline(lane.id, { action: "retry-stage" }, ports) : first;
        registry.close();
        console.log(JSON.stringify({ first: { error: first.error, status: first.status }, reconciled,
          error: result.error ?? null, status: result.status ?? 200, cursor: loadPipelines()[0].cursor,
          launchId: loadPipelines()[0].runs[0].attempts.at(-1).launchId }));
        process.exit(0);
      `], { env: { ...process.env, LLV_TEST_RETRY_REGISTRY: f.registryPath }, stdout: "pipe", stderr: "pipe",
        signal: AbortSignal.timeout(20_000) });
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, errors }).toMatchObject({ code: 0 });
      const result = JSON.parse(output.trim());
      if (legacy) {
        expect(result.first).toMatchObject({ status: 409, error: expect.stringContaining("original history reconciled") });
        expect(result.reconciled).toMatchObject({ spawnCalls: receipt ? 8 : 0, launchId: reservedLaunch });
      }
      expect(result.status).toBe(receipt ? 409 : 200);
      if (receipt) {
        expect(result.error).toContain("a reserved receipt");
        expect(result.launchId).toBe(reservedLaunch);
      }
      else {
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
});

describe("legacy unreserved stage retry", () => {
  let namespace = "00000090";
  let ids: ReturnType<typeof spyOn<typeof crypto, "randomUUID">>;
  beforeEach(() => {
    let sequence = 0;
    ids = spyOn(crypto, "randomUUID").mockImplementation(() =>
      `${namespace}-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
    setSystemTime(new Date("2026-10-25T07:00:00Z"));
  });
  afterEach(() => { ids.mockRestore(); setSystemTime(); });

  async function legacyPark(rounds: number, replacement = false, scenario = "empty") {
    namespace = crypto.createHash("sha256").update(`${scenario}:${rounds}:${replacement}`).digest("hex").slice(0, 8);
    const f = await unreservedPark(replacement);
    delete f.attempt.spawnCalls;
    f.attempt.error = "stage spawn was interrupted before durable launch evidence";
    f.lane.stateDetail = f.attempt.error;
    if (rounds) f.attempt.controllerWait = {
      startedAt: f.attempt.startedAt!, rounds, retryAfter: f.h.ports.now(),
    };
    savePipelines([f.lane]);
    f.h.ports.spawnReceipt = defaultPipelinePorts().spawnReceipt;
    return f;
  }

  async function reconcile(f: Awaited<ReturnType<typeof legacyPark>>, spawnCalls: number, launchId: string | null = null) {
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining(`original history reconciled (${spawnCalls} requests); retry-stage`) });
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: f.attempt.n, spawnCalls, launchId });
    expect(f.h.spawnInputs).toHaveLength(0);
  }

  test.each([false, true].flatMap(replacement => [0, 5].map(rounds => ({ replacement, rounds }))))
  ("retries an interrupted launch without receipts: %j", async ({ replacement, rounds }) => {
    const f = await legacyPark(rounds, replacement);
    try {
      await reconcile(f, 0);
      expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).not.toHaveProperty("error");
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1))
        .toMatchObject({ n: f.attempt.n + 1, state: "running", launchId: "launch-1", spawnCalls: 1 });
      expect(f.h.spawnInputs.map(input => input.clientAttemptId)).toEqual([`pipeline_${f.lane.id}_plan_${f.attempt.n + 1}`]);
    } finally { f.close(); }
  });

  test.each([0, 1, 2, 7])("accepts a safely retired receipt at legacy key %s", async call => {
    const f = await legacyPark(call === 7 ? 5 : 0, false, `retired-${call}`);
    try {
      const reserved = f.reserveUnadmitted(call);
      expect(reserved.kind).toBe("created");
      expect(f.registry.retireUnconsumedSpawn(f.key(call), "host failed before dispatch")).toBe(true);
      expect(f.registry.claimFailedSpawnForRetry(reserved.receipt.launchId,
        `${f.lane.id}:plan:${reserved.receipt.launchId}`).kind).toBe("claimed");
      expect(f.h.ports.spawnReceipt(reserved.receipt.launchId)?.neverBegan).toBe(true);
      await reconcile(f, call + 1, reserved.receipt.launchId);
      expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).not.toHaveProperty("error");
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(f.h.spawnInputs).toHaveLength(1);
    } finally { f.close(); }
  });

  test.each([0, 1, 2, 7])("verifies an unclaimed pre-dispatch receipt after binding legacy key %s", async call => {
    const f = await legacyPark(call === 7 ? 5 : 0, false, `unclaimed-${call}`);
    try {
      const reserved = f.reserveUnadmitted(call);
      expect(reserved.kind).toBe("created");
      expect(f.registry.retireUnconsumedSpawn(f.key(call), "host failed before dispatch")).toBe(true);
      await reconcile(f, call + 1, reserved.receipt.launchId);
      expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).not.toHaveProperty("error");
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(f.h.spawnInputs).toHaveLength(1);
    } finally { f.close(); }
  });

  test.each([0, 1, 2, 7].flatMap(call => ["live", "uncertain", "unreadable-projection"].map(state => ({ call, state }))))
  ("refuses an unsafe legacy receipt: %j", async ({ call, state }) => {
    const f = await legacyPark(call === 7 ? 5 : 0, false, `${state}-${call}`);
    try {
      const reserved = state === "unreadable-projection" ? f.reserveUnadmitted(call) : f.reserve(call);
      expect(reserved.kind).toBe("created");
      if (state === "uncertain") {
        expect(f.registry.failSpawn(reserved.receipt.launchId, "first-message outcome is uncertain")).toBe(true);
        expect(f.registry.claimFailedSpawnForRetry(reserved.receipt.launchId,
          `${f.lane.id}:plan:${reserved.receipt.launchId}`).kind).toBe("claimed");
      }
      if (state === "unreadable-projection")
        expect(f.registry.retireUnconsumedSpawn(f.key(call), "host failed before dispatch")).toBe(true);
      if (state === "unreadable-projection") {
        expect(f.registry.claimFailedSpawnForRetry(reserved.receipt.launchId,
          `${f.lane.id}:plan:${reserved.receipt.launchId}`).kind).toBe("claimed");
        f.h.ports.spawnReceipt = () => null;
      }
      await reconcile(f, call + 1, reserved.receipt.launchId);
      expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
        .toMatchObject({ status: 409, error: expect.stringContaining("a reserved receipt is not recorded on the attempt") });
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(f.attempt.n);
      expect(f.h.spawnInputs).toHaveLength(0);
    } finally { f.close(); }
  });

  test("keeps the read failure reason at the last reconciled legacy key", async () => {
    const f = await legacyPark(5, false, "read-failure");
    const reserved = f.reserve(7);
    expect(reserved.kind).toBe("created");
    await reconcile(f, 8, reserved.receipt.launchId);
    const read = f.registry.spawnReceiptForClientAttempt.bind(f.registry);
    const seam = spyOn(f.registry, "spawnReceiptForClientAttempt").mockImplementation(key => {
      if (key === f.key(7)) throw new RegistryReadError("agent registry schema is unsupported");
      return read(key);
    });
    try {
      expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
        .toMatchObject({ status: 409, error: expect.stringContaining("durable spawn receipts could not be read (agent registry schema is unsupported)") });
      expect(f.h.spawnInputs).toHaveLength(0);
    } finally { seam.mockRestore(); f.close(); }
  });

  test("rechecks the legacy inventory after cleanup yields", async () => {
    const f = await legacyPark(5, false, "late-reservation");
    try {
      const reserved = f.reserveUnadmitted(7);
      expect(reserved.kind).toBe("created");
      expect(f.registry.retireUnconsumedSpawn(f.key(7), "host failed before dispatch")).toBe(true);
      expect(f.registry.claimFailedSpawnForRetry(reserved.receipt.launchId,
        `${f.lane.id}:plan:${reserved.receipt.launchId}`).kind).toBe("claimed");
      await reconcile(f, 8, reserved.receipt.launchId);
      f.h.ports.stopStageAgent = async () => {
        expect(f.reserve(6).kind).toBe("created");
        return { outcome: "not-running" };
      };
      expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
        .toMatchObject({ status: 409, error: expect.stringContaining("receipt changed") });
      expect(loadPipelines()[0]!.cursor!.state).toBe("spawning");
      expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1))
        .toMatchObject({ launchId: reserved.receipt.launchId, spawnCalls: 8 });
      expect(f.h.spawnInputs).toHaveLength(0);
    } finally { f.close(); }
  });

  test.each([-1, 1.5])("still refuses an invalid present spawn count: %s", async spawnCalls => {
    const f = await legacyPark(0, false, `invalid-${spawnCalls}`);
    try {
      f.attempt.spawnCalls = spawnCalls;
      savePipelines([f.lane]);
      expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports))
        .toMatchObject({ status: 409, error: expect.stringContaining("the spawn request count is invalid") });
      expect(f.h.spawnInputs).toHaveLength(0);
    } finally { f.close(); }
  });
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

test.each(["prepublication", "first-message", "first-message-fence"] as const)
("receipt lookup failure preserves original %s custody before the reservation callback", async mode => {
  const h = await reserveActivationOnly([
    { id: "plan", kind: "run", role: { roleId: "architect" }, engine: "codex", model: "gpt-6.1-sol",
      effort: "high", access: "read-only", prompt: "Plan {{task}}", next: null },
  ] as never);
  const now = h.ports.now();
  h.ports.now = () => now;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "lookup-failure.json"));
  setAgentRegistryForTests(registry);
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { DELIVERY_UNVERIFIED_BY_EARLIER_EXECUTOR } = await import("@/lib/runtime/structuredDeliveryQueue");
  const { SEND_LOST_REASON } = await import("@/lib/runtime/sendSettlement");
  const journal = new RuntimeJournal(path.join(process.env.LLV_STATE_DIR!, "lookup-runtime.sqlite"),
    { structuredHosts: true, now: () => Date.parse(now) });
  const child = ownFixtureTree(spawn(process.execPath, ["-e", 'console.log(JSON.stringify({ ready: true })); process.stdin.resume()'],
    { stdio: ["pipe", "pipe", "pipe"] }));
  let unavailable = false, calls = 0, launchId = "", conversationId = "";
  const read = registry.spawnReceiptForClientAttempt.bind(registry);
  const seam = spyOn(registry, "spawnReceiptForClientAttempt").mockImplementation(key => {
    if (unavailable) throw new RegistryReadError("agent registry read unavailable");
    return read(key);
  });
  const client = { operationStatus: async (id: string) => journal.operationResult(id),
    snapshot: async () => journal.snapshot(), events: async (after: number) => journal.replay(after),
  } as import("@/lib/runtime/client").RuntimeHostClient;
  const durable = defaultPipelinePorts({ spawnRecoveryClient: () => client,
    termination: { terminateOwnedHost: async () => false } });
  h.ports.spawnReceipt = durable.spawnReceipt;
  h.ports.claimSpawnRetry = durable.claimSpawnRetry;
  h.ports.unpublishedLaunchRetrySafe = durable.unpublishedLaunchRetrySafe;
  const replacement = h.ports.spawnAgent;
  const reason = mode === "prepublication" ? "structured spawn interrupted before identity staging: capability writer refused"
    : DELIVERY_UNVERIFIED_BY_EARLIER_EXECUTOR;
  try {
    await fixtureReport(child, "lookup failure host", []);
    const identity = captureProcessIdentity(child.pid!);
    const key = { engine: "codex" as const, sessionId: ["11111111", "2222", "4333", "8444", "000000000000"].join("-") };
    h.ports.spawnAgent = async input => {
      calls++;
      const { receipt } = beginLegacySpawnFixture(registry, { engine: input.role.engine, cwd: input.cwd, transport: "structured",
        clientAttemptId: input.clientAttemptId, memberships: [input.membership] });
      launchId = receipt.launchId; conversationId = receipt.conversationId;
      expect(registry.stageStructuredSpawn(launchId, {
        key, artifactPath: path.join(process.env.LLV_STATE_DIR!, `rollout-2026-10-25T07-00-00-${key.sessionId}.jsonl`),
        cwd: input.cwd, accountId: "retry-test-account", launchProfile: emptyLaunchProfile(),
        status: "idle", host: null, pendingAction: "spawn", claimEpoch: 1,
        claimOwner: `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`,
        structuredHost: { kind: "codex-app-server", endpoint: "stdio:lookup-failure", process: identity,
          eventCursor: 0, protocolVersion: "v2", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
      }).kind).toBe("settled");
      journal.executeOperation({ kind: "spawn", operationId: launchId, idempotencyKey: launchId,
        conversationId, engine: receipt.engine, cwd: input.cwd, prompt: input.prompt });
      if (mode !== "prepublication") {
        journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
          conversationId, sessionKey: key, hostKind: "codex-app-server", host: "hosted", turn: "idle",
          provenance: "structured", capabilities: { steer: true, structuredAttention: true },
        } });
        journal.executeOperation({ kind: "send", operationId: `spawn_message_${launchId}`,
          idempotencyKey: `spawn_${launchId}`, conversationId, text: input.prompt, policy: "queue" });
        if (mode === "first-message") journal.transitionOperation(`spawn_message_${launchId}`, "uncertain");
      }
      expect((await registry.failStructuredSpawnOffLoop(launchId, reason, { retainRegisteredHost: true })).claimed).toBe(true);
      unavailable = true;
      throw new Error(reason);
    };
    await tickPipelines([], h.ports);
    unavailable = false;
    h.ports.spawnAgent = replacement;
    const lane = loadPipelines()[0]!;
    const held = lane.runs[0]!.attempts[0]!;
    expect(calls).toBe(1);
    expect(held).toMatchObject({ state: "needs_decision", launchId: null, conversationId: null, spawnCalls: 1 });
    // A fresh controller must recover the persisted request key before it
    // can consider any reset, even though the callback never supplied ids.
    const retry = Bun.spawn([process.execPath, "-e", `
      const { AgentRegistry, setAgentRegistryForTests } = await import("./src/lib/agent/registry.ts");
      const { RuntimeJournal } = await import("./src/runtime-host/journal.ts");
      const { patchPipeline, defaultPipelinePorts } = await import("./src/lib/pipelines/engine.ts");
      const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
      const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal.ts");
      const registry = new AgentRegistry(process.env.LLV_TEST_RETRY_REGISTRY);
      const journal = new RuntimeJournal(process.env.LLV_TEST_RETRY_JOURNAL, { structuredHosts: true });
      setAgentRegistryForTests(registry); registerPipelineTick(async () => {});
      const client = { operationStatus: async id => journal.operationResult(id),
        snapshot: async () => journal.snapshot(), events: async after => journal.replay(after) };
      const result = await patchPipeline(loadPipelines()[0].id, { action: "retry-stage" }, {
        ...defaultPipelinePorts({ spawnRecoveryClient: () => client }),
        exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreePresent: () => true, drainHold: () => null,
      });
      console.log(JSON.stringify({ status: result.status ?? 200, error: result.error }));
      registry.close(); journal.close(); process.exit(0);
    `], { env: { ...process.env, LLV_TEST_RETRY_REGISTRY: path.join(process.env.LLV_STATE_DIR!, "lookup-failure.json"),
      LLV_TEST_RETRY_JOURNAL: path.join(process.env.LLV_STATE_DIR!, "lookup-runtime.sqlite") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(20_000) });
    const [exit, stdout, stderr] = await Promise.all([retry.exited, new Response(retry.stdout).text(), new Response(retry.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({ status: 409 });
    expect(held.error).toContain(reason);
    expect(held.error).toContain("agent registry read unavailable");
    expect(held.error).toContain("retry-stage");
    expect(lane.stateDetail).toBe(held.error);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ launchId, conversationId, spawnCalls: 1 });
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(0);
    expect(processIdentityStatus(identity)).toBe("alive");
    expect(registry.structuredRecoveryFacts(key).entries[`codex:${key.sessionId}`]?.structuredHost?.process).toEqual(identity);
    journal.transitionOperation(launchId, "failed", { reason });
    if (mode === "first-message") {
      // An uncertain delivery cannot become a no-send fence. Even confirmed
      // host death leaves the original delivery obligation in custody.
      await stopFixtureProcess(child);
      expect(await patchPipeline(lane.id, { action: "retry-stage" }, h.ports)).toMatchObject({ status: 409 });
      expect(journal.operationResult(`spawn_message_${launchId}`)?.receipt.status).toBe("uncertain");
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ launchId, conversationId,
        error: expect.stringContaining(`spawn_message_${launchId}`) });
      await tickPipelines([], h.ports);
      await tickPipelines([], h.ports);
      expect(h.spawnInputs).toHaveLength(0);
      return;
    }
    if (mode === "first-message-fence") journal.transitionOperation(`spawn_message_${launchId}`, "failed", { reason: SEND_LOST_REASON });
    h.ports.stopStageAgent = async () => ({ outcome: "deferred" });
    expect(await patchPipeline(lane.id, { action: "retry-stage" }, h.ports)).toMatchObject({ status: 409 });
    expect(loadPipelines()[0]!.stateDetail).toContain("termination is unconfirmed");
    expect(h.spawnInputs).toHaveLength(0);
    expect(processIdentityStatus(identity)).toBe("alive");
    h.ports.stopStageAgent = durable.stopStageAgent;
    expect(await patchPipeline(lane.id, { action: "retry-stage" }, h.ports)).not.toHaveProperty("error");
    expect(processIdentityStatus(identity)).toBe("dead");
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: 2, state: "running" });
  } finally { seam.mockRestore(); await stopFixtureProcess(child); journal.close(); registry.close(); setAgentRegistryForTests(null); }
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

async function retainedClaimedPark(mode: "prepublication" | "first-message", count = 1) {
  const f = await unreservedPark(true, "codex");
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { DELIVERY_UNVERIFIED_BY_EARLIER_EXECUTOR } = await import("@/lib/runtime/structuredDeliveryQueue");
  const { SEND_LOST_REASON } = await import("@/lib/runtime/sendSettlement");
  const journal = new RuntimeJournal(path.join(process.env.LLV_STATE_DIR!, "retained-runtime.sqlite"),
    { structuredHosts: true, now: () => Date.parse(f.h.ports.now()) });
  const child = ownFixtureTree(spawn(process.execPath, ["-e", 'console.log(JSON.stringify({ ready: true })); process.stdin.resume()'],
    { stdio: ["pipe", "pipe", "pipe"] }));
  const close = async () => { await stopFixtureProcess(child); journal.close(); f.close(); };
  try {
    await fixtureReport(child, "retained host", []);
    const identity = captureProcessIdentity(child.pid!);
    const receipts = [];
    const reason = mode === "prepublication" ? "structured spawn interrupted before identity staging: capability writer refused"
      : DELIVERY_UNVERIFIED_BY_EARLIER_EXECUTOR;
    for (let call = 0; call < count; call++) {
      const { receipt } = f.reserve(call);
      const key = { engine: "codex" as const, sessionId: ["11111111", "2222", "4333", "8444", String(call).padStart(12, "0")].join("-") };
      expect(f.registry.stageStructuredSpawn(receipt.launchId, {
        key, artifactPath: path.join(process.env.LLV_STATE_DIR!, `rollout-2026-10-25T07-00-00-${key.sessionId}.jsonl`),
        cwd: f.lane.worktreeDir!, accountId: "retry-test-account", launchProfile: emptyLaunchProfile(),
        status: "idle", host: null, pendingAction: "spawn", claimEpoch: 1,
        claimOwner: `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`,
        structuredHost: { kind: "codex-app-server", endpoint: "stdio:retained", process: identity,
          eventCursor: 0, protocolVersion: "v2", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
      }).kind).toBe("settled");
      journal.executeOperation({ kind: "spawn", operationId: receipt.launchId, idempotencyKey: receipt.launchId,
        conversationId: receipt.conversationId, engine: receipt.engine, cwd: f.lane.worktreeDir!, prompt: "Review" });
      if (mode === "first-message") {
        journal.append({ scope: { type: "session", id: receipt.conversationId }, kind: "session-status", payload: {
          conversationId: receipt.conversationId, sessionKey: key, hostKind: "codex-app-server", host: "hosted", turn: "idle",
          provenance: "structured", capabilities: { steer: true, structuredAttention: true },
        } });
        journal.executeOperation({ kind: "send", operationId: `spawn_message_${receipt.launchId}`,
          idempotencyKey: `spawn_${receipt.launchId}`, conversationId: receipt.conversationId, text: "Review", policy: "queue" });
        journal.transitionOperation(`spawn_message_${receipt.launchId}`, "failed", { reason: SEND_LOST_REASON });
      }
      journal.transitionOperation(receipt.launchId, "failed", { reason });
      expect((await f.registry.failStructuredSpawnOffLoop(receipt.launchId, reason, { retainRegisteredHost: true })).claimed).toBe(true);
      expect(f.registry.claimFailedSpawnForRetry(receipt.launchId, `${f.lane.id}:plan:${receipt.launchId}`).kind).toBe("claimed");
      f.attempt.retiredLaunches = [...f.attempt.retiredLaunches ?? [], {
        launchId: receipt.launchId, conversationId: receipt.conversationId, retiredAt: f.h.ports.now(), error: reason,
      }];
      receipts.push(f.registry.spawnReceipt(receipt.launchId)!);
    }
    savePipelines([f.lane]);
    const client = { operationStatus: async (id: string) => journal.operationResult(id),
      snapshot: async () => journal.snapshot(), events: async (after: number) => journal.replay(after),
    } as import("@/lib/runtime/client").RuntimeHostClient;
    const ports = defaultPipelinePorts({ spawnRecoveryClient: () => client });
    f.h.ports.spawnReceipt = ports.spawnReceipt;
    f.h.ports.claimSpawnRetry = ports.claimSpawnRetry;
    f.h.ports.unpublishedLaunchRetrySafe = ports.unpublishedLaunchRetrySafe;
    return { ...f, journal, child, identity, receipts, close };
  } catch (error) { await close(); throw error; }
}

test.each(["prepublication", "first-message"] as const)("review: retained claimed %s receipt waits for confirmed host termination", async mode => {
  const f = await retainedClaimedPark(mode);
  const targets: string[] = [];
  f.h.ports.stopStageAgent = async (target, options) => {
    expect(options).toMatchObject({ automatic: true, recordedIdentity: true });
    expect(options?.eligible?.()).toBe(true);
    targets.push(target.launchId!);
    return { outcome: "deferred" };
  };
  try {
    expect(f.attempt).toMatchObject({ launchId: null, conversationId: null });
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).toMatchObject({ status: 409 });
    expect(targets).toEqual([f.receipts[0]!.launchId]);
    expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: expect.stringContaining("termination is unconfirmed") });
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.error).toContain("retry-stage");
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(0);
    expect(processIdentityStatus(f.identity)).toBe("alive");
    expect(f.registry.structuredRecoveryFacts(f.receipts[0]!.key!).entries[`codex:${f.receipts[0]!.key!.sessionId}`]?.structuredHost?.process).toEqual(f.identity);
    f.h.ports.stopStageAgent = async (target, options) => {
      expect(options?.eligible?.()).toBe(true);
      targets.push(target.launchId!);
      await stopFixtureProcess(f.child);
      return { outcome: "stopped" };
    };
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).not.toHaveProperty("error");
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(processIdentityStatus(f.identity)).toBe("dead");
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: f.attempt.n + 1, state: "running" });
  } finally { await f.close(); }
});

test.each(["deferred", "unresolved", "unconfirmed", "failed", "stopped", "not-running"] as const)
("retry reconciles every original host across multiple operations: %s", async outcome => {
  const f = await retainedClaimedPark("first-message", 2);
  const targets: string[] = [];
  f.h.ports.stopStageAgent = async target => {
    targets.push(target.launchId!);
    if (targets.length === 1) return { outcome: "not-running" };
    if (outcome === "unresolved") return { outcome, error: "recorded host still runs", survivors: [f.identity] };
    if (outcome === "unconfirmed") return { outcome, operationId: "retained-stop", detail: "recorded stop is not confirmed" };
    if (outcome === "failed") return { outcome, error: "recorded host stop refused" };
    if (outcome === "stopped" || outcome === "not-running") await stopFixtureProcess(f.child);
    return { outcome };
  };
  try {
    const held = outcome !== "stopped" && outcome !== "not-running";
    const result = await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports);
    expect(targets).toEqual(f.receipts.map(receipt => receipt.launchId));
    if (held) {
      expect(result).toMatchObject({ status: 409 });
      if (outcome === "unconfirmed") expect(result.error).toContain("recorded stop is not confirmed");
      if (outcome === "failed") expect(result.error).toContain("recorded host stop refused");
      expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: f.attempt.n, state: "needs_decision",
        retiredLaunches: f.attempt.retiredLaunches });
      if (outcome === "unresolved") expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.unresolvedTermination)
        .toMatchObject({ survivors: [f.identity] });
    } else expect(result).not.toHaveProperty("error");
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(held ? 0 : 1);
  } finally { await f.close(); }
});

test.each(["control", "receipt", "counter", "owner", "earlier-owner"] as const)
("retry rechecks %s after a recorded host stop yields", async change => {
  const f = await retainedClaimedPark("first-message", 2);
  f.attempt.spawnCalls = 3;
  savePipelines([f.lane]);
  let stops = 0;
  f.h.ports.stopStageAgent = async (_target, options) => {
    expect(options?.eligible?.()).toBe(true);
    await Promise.resolve();
    if (++stops === 2) {
      if (change === "control") {
        const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
        try {
          db.query("UPDATE state_rows SET value_json=json_set(value_json, '$.controlGeneration', 'new-control') WHERE collection='pipelines' AND row_key=?")
            .run(f.lane.id);
        } finally { db.close(); }
      } else if (change === "receipt") {
        // This key was absent when the proof was taken.
        f.reserve(2);
      } else if (change === "counter") {
        // A peer starts an operation beyond the inventory we just checked.
        f.reserve(3);
        const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
        try {
          db.query("UPDATE state_rows SET value_json=json_set(value_json, ?, 4) WHERE collection='pipelines' AND row_key=?")
            .run(`$.runs[0].attempts[${f.attempt.n - 1}].spawnCalls`, f.lane.id);
        } finally { db.close(); }
      } else {
        const key = f.receipts[change === "earlier-owner" ? 0 : 1]!.key!;
        f.registry.releaseClaim(key, `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`);
        f.registry.claim(key, "new-stage-owner");
      }
      expect(options?.eligible?.()).toBe(false);
    }
    return { outcome: "stopped" };
  };
  try {
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).toMatchObject({ status: 409,
      error: expect.stringContaining("changed during termination") });
    expect(stops).toBe(2);
    expect(f.h.spawnInputs).toHaveLength(0);
    expect(loadPipelines()[0]!.cursor!.state).toBe("spawning");
    if (change === "counter") expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.spawnCalls).toBe(4);
  } finally { await f.close(); }
});

test("automatic recovery of a bound receipt also retains an earlier host awaiting termination", async () => {
  const f = await retainedClaimedPark("prepublication", 2);
  const active = f.receipts[1]!;
  f.attempt.launchId = active.launchId;
  f.attempt.conversationId = active.conversationId;
  f.attempt.error = "stage launch recovery cannot prove no dispatch began: original host termination is unconfirmed";
  f.lane.stateDetail = f.attempt.error;
  savePipelines([f.lane]);
  const targets: string[] = [];
  f.h.ports.stopStageAgent = async target => {
    targets.push(target.launchId!);
    return { outcome: target.launchId === active.launchId ? "not-running" : "deferred" };
  };
  try {
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(targets).toContain(f.receipts[0]!.launchId);
    expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: expect.stringContaining("termination is unconfirmed") });
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: f.attempt.n, launchId: active.launchId });
    expect(f.h.spawnInputs).toHaveLength(0);
    expect(processIdentityStatus(f.identity)).toBe("alive");
  } finally { await f.close(); }
});

test("missing spawn request count is reconciled durably before retry across a controller restart", async () => {
  const f = await unreservedPark();
  try {
    delete f.attempt.spawnCalls;
    savePipelines([f.lane]);
    expect(f.attempt).toMatchObject({ conversationId: null, launchId: null });
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).toMatchObject({ status: 409 });
    const error = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.error;
    expect(error).toContain("spawn request count was unavailable");
    expect(error).toContain("original history reconciled (0 requests); retry-stage");
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.spawnCalls).toBe(0);
    expect(loadPipelines()[0]!.stateDetail).toBe(error);
    const child = Bun.spawn([process.execPath, "-e", `
      const { patchPipeline, defaultPipelinePorts } = await import("./src/lib/pipelines/engine.ts");
      const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal.ts");
      const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
      registerPipelineTick(async () => {});
      const before = loadPipelines()[0];
      const result = await patchPipeline(before.id, { action: "retry-stage" }, {
        ...defaultPipelinePorts(), now: () => "2026-10-25T07:00:00Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreePresent: () => true, drainHold: () => null,
      });
      const after = loadPipelines()[0];
      console.log(JSON.stringify({ status: result.status, error: result.error, detail: after.stateDetail,
        attempt: after.runs[0].attempts.at(-1), cursor: after.cursor }));
      process.exit(0);
    `], { cwd: process.cwd(), env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(20_000) });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const recovered = JSON.parse(stdout);
    expect(recovered.status).toBeUndefined();
    expect(recovered.error).toBeUndefined();
    expect(recovered.attempt).toMatchObject({ n: f.attempt.n, state: "failed", spawnCalls: 0, launchId: null, conversationId: null });
    expect(recovered.cursor.state).toBe("pending");
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: f.attempt.n + 1, state: "running" });
  } finally { f.close(); }
});


test.each(["prepublication", "first-message"] as const)("recorded stop accepts its own survivor capture for retained %s", async mode => {
  const f = await retainedClaimedPark(mode);
  f.h.ports.stopStageAgent = defaultPipelinePorts({ termination: { terminateOwnedHost: async () => false } }).stopStageAgent;
  try {
    const result = await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports);
    expect(result).not.toHaveProperty("error");
    expect(processIdentityStatus(f.identity)).toBe("dead");
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { await f.close(); }
});

async function retainedWithHostlessActive() {
  const f = await retainedClaimedPark("first-message");
  const { receipt } = f.reserve(1);
  const error = "structured spawn interrupted before identity staging: capability writer refused";
  f.journal.executeOperation({ kind: "spawn", operationId: receipt.launchId, idempotencyKey: receipt.launchId,
    conversationId: receipt.conversationId, engine: receipt.engine, cwd: f.lane.worktreeDir!, prompt: "Review" });
  f.journal.transitionOperation(receipt.launchId, "failed", { reason: error });
  await f.registry.failStructuredSpawnOffLoop(receipt.launchId, error);
  Object.assign(f.attempt, { launchId: receipt.launchId, conversationId: receipt.conversationId, error });
  f.lane.stateDetail = error;
  savePipelines([f.lane]);
  return f;
}

test.each(["deferred", "stopped", "owner-change"] as const)("automatic recovery reconciles retained hosts with an ordinary error: %s", async outcome => {
  const f = await retainedWithHostlessActive();
  const targets: string[] = [];
  const productionStop = defaultPipelinePorts({ termination: { terminateOwnedHost: async () => false } }).stopStageAgent;
  f.h.ports.stopStageAgent = async (target, options) => {
    targets.push(target.launchId!);
    if (target.launchId === f.receipts[0]!.launchId) {
      if (outcome === "deferred") return { outcome: "deferred" };
      const result = await productionStop(target, options);
      if (outcome === "owner-change") {
        const key = f.receipts[0]!.key!;
        f.registry.claim(key, "replacement-owner");
      }
      return result;
    }
    return productionStop(target, options);
  };
  try {
    await tickPipelines([], f.h.ports);
    f.h.ports.now = () => "2026-10-25T07:01:00Z";
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(targets).toContain(f.receipts[0]!.launchId);
    expect(f.h.spawnInputs).toHaveLength(outcome === "stopped" ? 1 : 0);
    if (outcome !== "stopped") expect(loadPipelines()[0]!.state).toBe("needs_decision");
    if (outcome === "deferred") expect(processIdentityStatus(f.identity)).toBe("alive");
  } finally { await f.close(); }
});

test.each(["starting", "failed"] as const)("retry-stage reconciles a hidden original receipt with missing count: %s", async state => {
  const f = await unreservedPark();
  try {
    const { receipt } = f.reserve(0);
    delete f.attempt.spawnCalls;
    savePipelines([f.lane]);
    f.h.ports.spawnReceipt = defaultPipelinePorts().spawnReceipt;
    f.h.ports.claimSpawnRetry = defaultPipelinePorts().claimSpawnRetry;
    if (state === "failed") {
      await f.registry.failStructuredSpawnOffLoop(receipt.launchId, supervisedRuntimeHostUnavailableReason("pipeline structured runtime host"));
      f.registry.claimFailedSpawnForRetry(receipt.launchId, `${f.lane.id}:plan:${receipt.launchId}`);
    }
    const result = await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports);
    expect(result.status).toBe(409);
    expect(result.error).toContain("original history reconciled");
    if (state === "starting") {
      const attempt = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
      expect(attempt).toMatchObject({ launchId: receipt.launchId, conversationId: receipt.conversationId, spawnCalls: 1 });
      // The named recovery action is retry-stage after this original operation settles.
      expect(result.error).toContain("retry-stage");
      expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).toMatchObject({ status: 409 });
      expect(f.h.spawnInputs).toHaveLength(0);
      await f.registry.failStructuredSpawnOffLoop(receipt.launchId, supervisedRuntimeHostUnavailableReason("pipeline structured runtime host"));
    }
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).not.toHaveProperty("error");
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(1);
  } finally { f.close(); }
});


test.each(["deferred", "stopped"] as const)("manual retry checks a retained host after ordinary active failure: %s", async outcome => {
  const f = await retainedWithHostlessActive();
  f.attempt.completedAt = f.h.ports.now();
  savePipelines([f.lane]);
  const targets: string[] = [];
  const stop = defaultPipelinePorts({ termination: { terminateOwnedHost: async () => false } }).stopStageAgent;
  f.h.ports.stopStageAgent = async (target, options) => {
    targets.push(target.launchId!);
    if (outcome === "deferred" && target.launchId === f.receipts[0]!.launchId) return { outcome: "deferred" };
    return stop(target, options);
  };
  try {
    const result = await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports);
    if (outcome === "deferred") expect(result.status).toBe(409);
    else expect(result).not.toHaveProperty("error");
    expect(targets).toContain(f.receipts[0]!.launchId);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(outcome === "deferred" ? 0 : 1);
    expect(processIdentityStatus(f.identity)).toBe(outcome === "deferred" ? "alive" : "dead");
  } finally { await f.close(); }
});


test("retry retains original hosts when cleared launch fields have an ordinary error", async () => {
  const f = await retainedClaimedPark("first-message");
  f.attempt.error = "resource admission interrupted";
  f.lane.stateDetail = f.attempt.error;
  savePipelines([f.lane]);
  const targets: string[] = [];
  f.h.ports.stopStageAgent = async target => { targets.push(target.launchId!); return { outcome: "deferred" }; };
  try {
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).toMatchObject({ status: 409 });
    expect(targets).toEqual([f.receipts[0]!.launchId]);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(0);
    expect(processIdentityStatus(f.identity)).toBe("alive");
    f.h.ports.stopStageAgent = defaultPipelinePorts({ termination: { terminateOwnedHost: async () => false } }).stopStageAgent;
    expect(await patchPipeline(f.lane.id, { action: "retry-stage" }, f.h.ports)).not.toHaveProperty("error");
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(processIdentityStatus(f.identity)).toBe("dead");
  } finally { await f.close(); }
});
