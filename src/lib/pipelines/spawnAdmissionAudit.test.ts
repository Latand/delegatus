import { afterEach, beforeEach, setSystemTime } from "bun:test";
import { registryLockHolder } from "@/lib/agent/registryLockHolderFixture";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests } from "@/lib/blockingWaits";
import { expect, test, spyOn, crypto, path, AgentRegistry, accountManager, setAgentRegistryForTests,
  defaultPipelinePorts, engineModule, reserveActivationOnly, frozenWallClock, loadPipelines, savePipelines } from "./engine.fixture";

beforeEach(() => setSystemTime(new Date("2026-10-31T12:00:00Z")));
afterEach(() => setSystemTime());

function identifiers(namespace: number) {
  let sequence = 0;
  return spyOn(crypto, "randomUUID").mockImplementation(() =>
    `${String(namespace).padStart(8, "0")}-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
}

test.each([0, 601_000])("deferred activation age %d leaves a fresh admission budget", async age => {
  const ids = identifiers(age ? 2 : 1);
  let monotonic: ReturnType<typeof spyOn<typeof performance, "now">> | undefined;
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    advance(age);
    monotonic = spyOn(performance, "now").mockReturnValue(1_000);
    const spawn = h.ports.spawnAgent;
    let remaining = 0;
    let checkpoint: string | undefined;
    h.ports.spawnAgent = async (input, reserved) => {
      remaining = input.spawnAdmissionDeadline! - performance.now();
      checkpoint = loadPipelines()[0]!.runs[0]!.attempts[0]!.activation!.admissionStartedAt;
      return spawn(input, reserved);
    };
    await engineModule.drainStageActivations(h.ports);
    expect(h.spawnInputs).toHaveLength(1);
    expect(remaining).toBe(600_000);
    expect(checkpoint).toBe(h.ports.now());
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("running");
  } finally { monotonic?.mockRestore(); ids.mockRestore(); }
});

test("slow input preparation leaves the admission budget intact", async () => {
  const ids = identifiers(3);
  const stageInput = await import("./stageInput");
  const compose = stageInput.composeStageInput;
  let preparation: ReturnType<typeof spyOn<typeof stageInput, "composeStageInput">> | undefined;
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    let prepared = false;
    preparation = spyOn(stageInput, "composeStageInput").mockImplementation(async (...args) => {
      const prompt = await compose(...args);
      prepared = true;
      advance(601_000);
      return prompt;
    });
    await engineModule.drainStageActivations(h.ports);
    expect(prepared).toBe(true);
    expect(h.spawnInputs).toHaveLength(1);
  } finally { preparation?.mockRestore(); ids.mockRestore(); }
});

test.each(["released", "exhausted"] as const)("a real delivery writer is retried within the admission budget: %s", async outcome => {
  const ids = identifiers(outcome === "released" ? 4 : 5);
  const h = await reserveActivationOnly();
  const advance = frozenWallClock(h);
  // Reproduce the deferred-drain delay before any registry acquisition.
  advance(601_000);
  const filename = path.join(process.env.LLV_STATE_DIR!, `admission-${outcome}.json`);
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteWriterDeadlineMs: 1_000 });
  setAgentRegistryForTests(registry);
  const holder = registryLockHolder(filename.replace(/\.json$/, ".sqlite"));
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(engine => ({ kind: "available", account: {
    engine, accountId: "fixture-account", kind: "managed", home: process.env.LLV_STATE_DIR!,
    transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
  } }));
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const guardModule = await import("@/lib/git/stageAttemptGuard");
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockResolvedValue({});
  let dispatches = 0;
  const dispatch = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async () => {
    dispatches++;
    return { path: null } as never;
  });
  const defaults = defaultPipelinePorts();
  h.ports.spawnAgent = defaults.spawnAgent;
  h.ports.spawnReceipt = defaults.spawnReceipt;
  resetBlockingWaitsForTests(() => {});
  try {
    await holder.hold();
    await engineModule.drainStageActivations(h.ports);
    const waiting = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(waiting).toMatchObject({ state: "pending", spawnCalls: 1,
      controllerWait: { startedAt: h.ports.now(), rounds: 1, budgetMs: 600_000,
        retryAfter: new Date(Date.parse(h.ports.now()) + 1_000).toISOString() } });
    expect(blockingWaitDiagnostics().sites["registry-lock-async"]).toBeDefined();
    expect(dispatches).toBe(0);
    expect(loadPipelines()[0]!.stateDetail).toContain("holder=unattributed SQLite writer");
    if (outcome === "exhausted") {
      advance(1_000);
      await engineModule.tickPipelines([], h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ spawnCalls: 2, controllerWait: { rounds: 2,
        retryAfter: new Date(Date.parse(h.ports.now()) + 2_000).toISOString() } });
    }
    await holder.release();
    advance(outcome === "released" ? 1_000 : 599_000);
    await engineModule.tickPipelines([], h.ports);
    const current = loadPipelines()[0]!;
    if (outcome === "released") {
      expect(dispatches).toBe(1);
      expect(current.runs[0]!.attempts[0]).toMatchObject({ state: "running", spawnCalls: 2 });
    } else {
      expect(dispatches).toBe(0);
      expect(current.state).toBe("needs_decision");
      expect(current.stateDetail).toContain("spawn admission budget exhausted");
      expect(current.stateDetail).toContain("1 retries over 600s");
      expect(current.stateDetail).toContain("last observed failure:");
      expect(current.stateDetail).toContain("holder=unattributed SQLite writer");
      expect(current.runs[0]!.attempts[0]!.spawnCalls).toBe(2);
    }
  } finally {
    await holder.close();
    resolve.mockRestore(); client.mockRestore(); guard.mockRestore(); dispatch.mockRestore();
    registry.close(); setAgentRegistryForTests(null); ids.mockRestore();
  }
});

test("a drain holding an unsubmitted admission leaves a fresh budget on release", async () => {
  const ids = identifiers(7);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    const rows = loadPipelines();
    rows[0]!.runs[0]!.attempts[0]!.activation!.admissionStartedAt = h.ports.now();
    rows[0]!.runs[0]!.attempts[0]!.activation!.phase = "reserving";
    rows[0]!.runs[0]!.attempts[0]!.spawnCalls = 1;
    savePipelines(rows);
    h.ports.drainHold = () => ({ id: "hold", target: "a".repeat(40), since: h.ports.now(), until: Number.MAX_SAFE_INTEGER });
    await engineModule.drainStageActivations(h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation!.admissionStartedAt).toBeUndefined();
    advance(601_000);
    h.ports.drainHold = () => null;
    await engineModule.drainStageActivations(h.ports);
    expect(h.spawnInputs).toHaveLength(1);
  } finally { ids.mockRestore(); }
});

test("admission expiry after reservation fails its receipt and permits guarded retry of the original launch", async () => {
  const ids = identifiers(8);
  const h = await reserveActivationOnly();
  const advance = frozenWallClock(h);
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "expired-reservation.json"));
  setAgentRegistryForTests(registry);
  let clock = 1_000;
  const monotonic = spyOn(performance, "now").mockImplementation(() => clock);
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(engine => ({ kind: "available", account: {
    engine, accountId: "fixture-account", kind: "managed", home: process.env.LLV_STATE_DIR!,
    transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
  } }));
  const clientModule = await import("@/lib/runtime/client");
  const guardModule = await import("@/lib/git/stageAttemptGuard");
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockImplementation(async () => {
    clock += 600_000;
    advance(600_000);
    return {};
  });
  const defaults = defaultPipelinePorts();
  const harnessSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = defaults.spawnAgent;
  h.ports.spawnReceipt = defaults.spawnReceipt;
  h.ports.spawnReceiptState = defaults.spawnReceiptState;
  h.ports.claimSpawnRetry = defaults.claimSpawnRetry;
  try {
    await engineModule.drainStageActivations(h.ports);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    expect(lane.state).toBe("needs_decision");
    expect(attempt.launchId).toBeTruthy();
    expect(lane.stateDetail).toContain("spawn admission budget exhausted");
    expect(registry.spawnReceipt(attempt.launchId!)?.state).toBe("failed");
    expect(defaults.spawnReceipt(attempt.launchId!)?.state).toBe("failed");
    const { patchPipeline, tickPipelines } = await import("./engine.fixture");
    const retried = await patchPipeline(lane.id, { action: "retry-stage", stageId: "plan", launchId: attempt.launchId! }, h.ports);
    expect(retried.error).toBeUndefined();
    h.ports.spawnAgent = harnessSpawn;
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    expect(h.spawnInputs).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)).toMatchObject({ n: 2, state: "running" });
    expect(registry.spawnReceipt(attempt.launchId!)?.state).toBe("failed");
  } finally {
    monotonic.mockRestore(); resolve.mockRestore(); client.mockRestore(); guard.mockRestore();
    registry.close(); setAgentRegistryForTests(null); ids.mockRestore();
  }
});

test("a fresh controller process retains an already started admission budget without inventing a busy writer", async () => {
  const ids = identifiers(6);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    const rows = loadPipelines();
    rows[0]!.runs[0]!.attempts[0]!.activation!.admissionStartedAt = h.ports.now();
    savePipelines(rows);
    advance(600_000);
    const child = Bun.spawn([process.execPath, "-e", `
      const { defaultPipelinePorts, drainStageActivations } = await import("./src/lib/pipelines/engine.ts");
      const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
      const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal.ts");
      registerPipelineTick(async () => {});
      let spawns = 0;
      await drainStageActivations({ ...defaultPipelinePorts(), now: () => process.env.LLV_TEST_ADMISSION_NOW,
        exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreePresent: () => true,
        drainHold: () => null, cpuPressureHold: () => null, structuredDeliveryPublication: () => "ready",
        spawnAgent: async () => { spawns++; throw new Error("unexpected spawn"); },
      });
      const lane = loadPipelines()[0];
      console.log(JSON.stringify({ spawns, state: lane.state, detail: lane.stateDetail }));
      process.exit(0);
    `], { env: { ...process.env, LLV_TEST_ADMISSION_NOW: h.ports.now() }, stdout: "pipe", stderr: "pipe",
      signal: AbortSignal.timeout(20_000) });
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, errors }).toMatchObject({ code: 0 });
    expect(JSON.parse(output)).toMatchObject({ spawns: 0, state: "needs_decision" });
    expect(h.spawnInputs).toHaveLength(0);
    const current = loadPipelines()[0]!;
    expect(current.state).toBe("needs_decision");
    expect(current.stateDetail).toContain("0 retries over 600s: spawn admission budget exhausted");
    expect(current.stateDetail).not.toContain("lock");
  } finally { ids.mockRestore(); }
});
