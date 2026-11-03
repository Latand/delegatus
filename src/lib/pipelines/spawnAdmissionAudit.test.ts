import { afterEach, beforeEach, setSystemTime } from "bun:test";
import { registryLockHolder } from "@/lib/agent/registryLockHolderFixture";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests } from "@/lib/blockingWaits";
import { expect, test, spyOn, crypto, path, AgentRegistry, accountManager, setAgentRegistryForTests,
  defaultPipelinePorts, engineModule, reserveActivationOnly, frozenWallClock, loadPipelines, savePipelines } from "./engine.fixture";
import { failedReceipt, HOST_UNAVAILABLE } from "./engine.fixture";
import { SEND_LOST_REASON } from "@/lib/runtime/sendSettlement";

beforeEach(() => setSystemTime(new Date("2026-10-31T12:00:00Z")));
afterEach(() => setSystemTime());

function identifiers(namespace: number) {
  let sequence = 0;
  return spyOn(crypto, "randomUUID").mockImplementation(() =>
    `${String(namespace).padStart(8, "0")}-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
}

async function restartAdmission(now: string, failAfterMs?: number, failure = HOST_UNAVAILABLE) {
  const child = Bun.spawn([process.execPath, "-e", `
    const { setSystemTime } = await import("bun:test");
    setSystemTime(new Date(process.env.LLV_TEST_ADMISSION_NOW));
    const { defaultPipelinePorts, tickPipelines } = await import("./src/lib/pipelines/engine.ts");
    const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
    const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal.ts");
    registerPipelineTick(async () => {});
    const calls = [];
    let clock = Date.parse(process.env.LLV_TEST_ADMISSION_NOW);
    await tickPipelines([], { ...defaultPipelinePorts(), now: () => new Date(clock).toISOString(),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreePresent: () => true,
      drainHold: () => null, cpuPressureHold: () => null, structuredDeliveryPublication: () => "ready",
      engineReadiness: () => "connected",
      spawnReceipt: launchId => launchId === "restart-launch" && calls.length
        ? { state: "completed", launchId, conversationId: "conversation_restart", transcript: null,
            sessionId: null, paneId: null, error: null } : null,
      spawnAgent: async (input, reserved) => {
        calls.push({ id: input.clientAttemptId, remaining: input.spawnAdmissionDeadline - performance.now() });
        if (process.env.LLV_TEST_FAIL_AFTER !== "") {
          clock += Number(process.env.LLV_TEST_FAIL_AFTER);
          throw new Error(process.env.LLV_TEST_HOST_FAILURE);
        }
        const reservation = { launchId: "restart-launch", conversationId: "conversation_restart", accountId: null };
        await reserved(reservation);
        return { ...reservation, sessionId: null, transcript: null, paneId: null };
      },
    });
    const lane = loadPipelines()[0];
    console.log(JSON.stringify({ calls, state: lane.state, detail: lane.stateDetail,
      attempt: lane.runs[0].attempts[0] }));
    process.exit(0);
  `], { env: { ...process.env, LLV_TEST_ADMISSION_NOW: now, LLV_TEST_FAIL_AFTER: failAfterMs === undefined ? "" : String(failAfterMs),
    LLV_TEST_HOST_FAILURE: failure }, stdout: "pipe", stderr: "pipe",
    signal: AbortSignal.timeout(20_000) });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, errors }).toMatchObject({ code: 0 });
  return JSON.parse(output);
}

function cpuHold(now: string) {
  return { since: Date.parse(now), avg10: 80, deferred: false,
    policy: { holdAt: 30, releaseBelow: 20, releaseAfterMs: 10_000, deferAfterMs: 120_000 } };
}

for (const elapsed of [29_999, 30_000]) test(`a pre-spawn controller wait retains its cutoff after restart at ${elapsed} ms`, async () => {
  const ids = identifiers(elapsed === 30_000 ? 16 : 15);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    const rows = loadPipelines();
    const lane = rows[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    delete attempt.activation;
    attempt.state = "pending";
    attempt.startedAt = null;
    lane.cursor!.state = "pending";
    savePipelines(rows);
    h.ports.structuredDeliveryPublication = () => "rebinding";
    await engineModule.tickPipelines([], h.ports);
    const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.controllerWait!;
    expect(wait.budgetMs).toBe(30_000);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.spawnCalls).toBe(0);
    advance(elapsed);
    const resumed = await restartAdmission(h.ports.now());
    expect(resumed.calls).toHaveLength(elapsed === 30_000 ? 0 : 1);
    expect(resumed.state).toBe(elapsed === 30_000 ? "needs_decision" : "running");
    if (elapsed === 30_000) {
      expect(resumed.attempt.controllerWait).toEqual(wait);
      expect(resumed.attempt.spawnCalls).toBe(0);
      expect(resumed.detail).toContain("over 30s");
      expect(resumed.detail).toContain("structured delivery controller is unavailable");
    }
  } finally { ids.mockRestore(); }
});

test("host work retains its own finite budget across a controller restart", async () => {
  const ids = identifiers(11);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    h.ports.spawnAgent = async () => { advance(300_000); throw new Error(HOST_UNAVAILABLE); };
    await engineModule.drainStageActivations(h.ports);
    advance(1_000);
    const resumed = await restartAdmission(h.ports.now(), 299_000);
    expect(resumed.calls).toHaveLength(1);
    expect(resumed.state).toBe("needs_decision");
    expect(resumed.detail).toContain("spawn admission budget exhausted");
    expect(resumed.detail).toContain(HOST_UNAVAILABLE.replace(/; retry shortly$/, ""));
    expect(resumed.attempt.spawnAdmissionBudget.spent.host).toBe(600_000);
  } finally { ids.mockRestore(); }
});

for (const elapsed of [599_999, 600_000]) test(`a legacy writer retry retains its deadline and holder after restart at ${elapsed} ms`, async () => {
  const ids = identifiers(elapsed === 600_000 ? 18 : 17);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    h.ports.spawnAgent = async () => {
      throw new Error("the delivery record's write lock is held by another writer (spawn admission); holder=legacy fixture writer");
    };
    await engineModule.drainStageActivations(h.ports);
    const rows = loadPipelines();
    const attempt = rows[0]!.runs[0]!.attempts[0]!;
    expect(attempt).toMatchObject({ state: "pending", spawnCalls: 1, controllerWait: { budgetMs: 600_000 } });
    // Replay the writer's persisted output through the pre-counter format.
    delete attempt.spawnAdmissionBudget;
    savePipelines(rows);
    advance(elapsed);
    const resumed = await restartAdmission(h.ports.now());
    expect(resumed.calls).toHaveLength(elapsed === 600_000 ? 0 : 1);
    expect(resumed.state).toBe(elapsed === 600_000 ? "needs_decision" : "running");
    if (elapsed === 600_000) {
      expect(resumed.attempt.spawnCalls).toBe(1);
      expect(resumed.attempt.spawnAdmissionBudget.spent.writer).toBe(600_000);
      expect(resumed.detail).toContain("holder=legacy fixture writer");
    }
  } finally { ids.mockRestore(); }
});

test("a pending writer retry suspends its budget at the early update gate across restart", async () => {
  const ids = identifiers(19);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    h.ports.spawnAgent = async () => {
      throw new Error("the delivery record's write lock is held by another writer (spawn admission); holder=fixture writer");
    };
    await engineModule.drainStageActivations(h.ports);
    advance(1_000);
    h.ports.drainHold = () => ({ id: "hold", target: "a".repeat(40), since: h.ports.now(), until: Number.MAX_SAFE_INTEGER });
    await engineModule.tickPipelines([], h.ports);
    const budget = loadPipelines()[0]!.runs[0]!.attempts[0]!.spawnAdmissionBudget!;
    expect(budget.spent.writer).toBe(1_000);
    expect(budget.waitingSince).toBeUndefined();
    advance(600_000);
    const resumed = await restartAdmission(h.ports.now());
    expect(resumed.state).toBe("running");
    expect(resumed.calls).toHaveLength(1);
    expect(resumed.calls[0].remaining).toBeGreaterThan(598_000);
    expect(resumed.attempt.spawnCalls).toBe(2);
  } finally { ids.mockRestore(); }
});

test("a fenced first-message retry keeps its count-based schedule after a delayed restart", async () => {
  const ids = identifiers(20);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    h.ports.spawnAgent = async (_input, reserved) => {
      await reserved({ launchId: "fenced-launch", conversationId: "conversation_fenced" });
      throw new Error(SEND_LOST_REASON);
    };
    h.ports.spawnReceipt = id => id === "fenced-launch"
      ? { ...failedReceipt(id, "conversation_fenced", SEND_LOST_REASON), staged: true, currentGeneration: true } : null;
    h.ports.fencedFirstMessageRetrySafe = async () => true;
    await engineModule.drainStageActivations(h.ports);
    const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(attempt.fencedMessageRetries).toBe(1);
    expect(attempt.controllerWait!.budgetMs).toBeUndefined();
    expect(attempt.spawnAdmissionBudget).toBeUndefined();
    advance(60_000);
    const resumed = await restartAdmission(h.ports.now());
    expect(resumed.state).toBe("running");
    expect(resumed.calls).toHaveLength(1);
    expect(resumed.attempt.spawnCalls).toBe(2);
    expect(resumed.attempt.fencedMessageRetries).toBe(1);
  } finally { ids.mockRestore(); }
});

test("mixed legacy failures keep their recorded allowance through repeated controller restarts", async () => {
  const ids = identifiers(21);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    h.ports.spawnAgent = async () => { throw new Error(HOST_UNAVAILABLE); };
    await engineModule.drainStageActivations(h.ports);
    const rows = loadPipelines();
    delete rows[0]!.runs[0]!.attempts[0]!.spawnAdmissionBudget;
    savePipelines(rows);
    const failure = "structured delivery controller is unavailable";
    for (const elapsed of [60_000, 120_000]) {
      advance(60_000);
      const resumed = await restartAdmission(h.ports.now(), 0, failure);
      expect(resumed.state).toBe("running");
      expect(resumed.calls).toHaveLength(1);
      expect(resumed.calls[0].remaining).toBeGreaterThan(600_000 - elapsed - 1_000);
      expect(resumed.attempt.controllerWait.budgetMs).toBe(600_000);
    }
    advance(480_000);
    const expired = await restartAdmission(h.ports.now());
    expect(expired.state).toBe("needs_decision");
    expect(expired.calls).toHaveLength(0);
    expect(expired.detail).toContain(failure);
  } finally { ids.mockRestore(); }
});

test("a legacy writer retains its holder when an update gate precedes budget migration", async () => {
  const ids = identifiers(22);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    h.ports.spawnAgent = async () => {
      throw new Error("the delivery record's write lock is held by another writer (spawn admission); holder=legacy fixture writer");
    };
    await engineModule.drainStageActivations(h.ports);
    const rows = loadPipelines();
    delete rows[0]!.runs[0]!.attempts[0]!.spawnAdmissionBudget;
    savePipelines(rows);
    advance(1_000);
    h.ports.drainHold = () => ({ id: "hold", target: "a".repeat(40), since: h.ports.now(), until: Number.MAX_SAFE_INTEGER });
    await engineModule.tickPipelines([], h.ports);
    const budget = loadPipelines()[0]!.runs[0]!.attempts[0]!.spawnAdmissionBudget!;
    expect(budget.spent.writer).toBe(1_000);
    expect(budget.lastWriterFailure).toContain("holder=legacy fixture writer");
    expect(budget.waitingSince).toBeUndefined();
    advance(600_000);
    const resumed = await restartAdmission(h.ports.now(), 0);
    expect(resumed.state).toBe("running");
    expect(resumed.calls).toHaveLength(1);
    expect(resumed.calls[0].remaining).toBeGreaterThan(598_000);
    expect(resumed.attempt.spawnAdmissionBudget.lastWriterFailure).toContain("holder=legacy fixture writer");
    advance(599_000);
    const expired = await restartAdmission(h.ports.now());
    expect(expired.state).toBe("needs_decision");
    expect(expired.calls).toHaveLength(0);
    expect(expired.detail).toContain("holder=legacy fixture writer");
  } finally { ids.mockRestore(); }
});

for (const cause of ["host", "writer"] as const) test(`a legacy controller wait expands for a later ${cause} failure across restarts`, async () => {
  const ids = identifiers(cause === "host" ? 23 : 24);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    h.ports.spawnAgent = async () => { throw new Error("structured delivery controller is unavailable"); };
    await engineModule.drainStageActivations(h.ports);
    const rows = loadPipelines();
    expect(rows[0]!.runs[0]!.attempts[0]!.controllerWait!.budgetMs).toBe(30_000);
    delete rows[0]!.runs[0]!.attempts[0]!.spawnAdmissionBudget;
    savePipelines(rows);
    const failure = cause === "host" ? HOST_UNAVAILABLE
      : "the delivery record's write lock is held by another writer (spawn admission); holder=fixture writer";
    advance(1_000);
    const expanded = await restartAdmission(h.ports.now(), 0, failure);
    expect(expanded.state).toBe("running");
    expect(expanded.attempt.spawnAdmissionBudget.legacyLimitMs).toBe(600_000);
    expect(expanded.attempt.controllerWait.budgetMs).toBe(600_000);
    advance(60_000);
    const continued = await restartAdmission(h.ports.now(), 0, failure);
    expect(continued.state).toBe("running");
    expect(continued.calls).toHaveLength(1);
    expect(continued.calls[0].remaining).toBeGreaterThan(538_000);
    advance(539_000);
    const expired = await restartAdmission(h.ports.now());
    expect(expired.state).toBe("needs_decision");
    expect(expired.calls).toHaveLength(0);
    expect(expired.detail).toContain(failure);
  } finally { ids.mockRestore(); }
});

test("adapter phase checkpoints charge setup separately from a later writer refusal", async () => {
  const ids = identifiers(12);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    h.ports.spawnAgent = async (_input, _reserved, _prepare, phase) => {
      await phase!("host");
      advance(300_000);
      await phase!("writer");
      advance(1_000);
      throw new Error("the delivery record's write lock is held by another writer (spawn admission); holder=fixture writer");
    };
    await engineModule.drainStageActivations(h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.spawnAdmissionBudget).toMatchObject({
      kind: "writer", spent: { host: 300_000, writer: 1_000, controller: 0 },
    });
    advance(1_000);
    const resumed = await restartAdmission(h.ports.now());
    expect(resumed.state).toBe("running");
    expect(resumed.calls).toHaveLength(1);
    expect(resumed.calls[0].remaining).toBeGreaterThan(597_000);
  } finally { ids.mockRestore(); }
});

test.each(["host setup", "writer lock"] as const)("%s then CPU hold survives a controller restart and dispatches the next due round", async cause => {
  const ids = identifiers(cause === "host setup" ? 9 : 10);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    let firstKey = "";
    h.ports.spawnAgent = async (input, reserved) => {
      firstKey = input.clientAttemptId;
      if (cause === "host setup") {
        await reserved({ launchId: "setup-launch", conversationId: "conversation_setup" });
        advance(300_000);
        throw new Error(HOST_UNAVAILABLE);
      }
      throw new Error("the delivery record's write lock is held by another writer (spawn admission); holder=fixture writer");
    };
    h.ports.spawnReceipt = id => id === "setup-launch"
      ? { ...failedReceipt(id, "conversation_setup", HOST_UNAVAILABLE), neverBegan: true } : null;
    await engineModule.drainStageActivations(h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("pending");
    advance(1_000);
    h.ports.cpuPressureHold = () => cpuHold(h.ports.now());
    await engineModule.tickPipelines([], h.ports);
    const budget = loadPipelines()[0]!.runs[0]!.attempts[0]!.spawnAdmissionBudget;
    advance(600_000);
    const resumed = await restartAdmission(h.ports.now());
    expect(resumed.state).toBe("running");
    expect(resumed.calls).toHaveLength(1);
    expect(resumed.calls[0].id).not.toBe(firstKey);
    expect(resumed.calls[0].remaining).toBeGreaterThan(cause === "host setup" ? 298_000 : 598_000);
    expect(resumed.attempt.spawnCalls).toBe(2);
    expect(resumed.attempt.spawnAdmissionBudget).toBeUndefined();
    expect(budget).toMatchObject({ spent: cause === "host setup" ? { host: 301_000, writer: 0 } : { host: 0, writer: 1_000 } });
    expect(budget!.waitingSince).toBeUndefined();
  } finally { ids.mockRestore(); }
});

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

test.each(["released", "exhausted", "attributed"] as const)("a real delivery writer is retried within the admission budget: %s", async outcome => {
  const ids = identifiers(outcome === "released" ? 4 : 5);
  const h = await reserveActivationOnly();
  const advance = frozenWallClock(h);
  // Reproduce the deferred-drain delay before any registry acquisition.
  advance(601_000);
  const filename = path.join(process.env.LLV_STATE_DIR!, `admission-${outcome}.json`);
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteWriterDeadlineMs: 1_000 });
  setAgentRegistryForTests(registry);
  const holder = registryLockHolder(filename.replace(/\.json$/, ".sqlite"), outcome === "attributed" ? "registry.fixture-admission" : "",
    outcome === "attributed" ? Date.now() - 1_250 : undefined);
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
    const holderText = outcome === "attributed" ? `holder=registry.fixture-admission pid=${holder.pid} age=1250ms` : "holder=unattributed SQLite writer";
    expect(loadPipelines()[0]!.stateDetail).toContain(holderText);
    if (outcome === "attributed") {
      advance(1_000);
      h.ports.cpuPressureHold = () => cpuHold(h.ports.now());
      await engineModule.tickPipelines([], h.ports);
      expect(loadPipelines()[0]!.stateDetail).not.toContain(holderText);
      advance(600_000);
      h.ports.cpuPressureHold = () => null;
      await engineModule.tickPipelines([], h.ports);
      expect(loadPipelines()[0]!.state).toBe("running");
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.spawnCalls).toBe(2);
    } else if (outcome === "exhausted") {
      advance(1_000);
      await engineModule.tickPipelines([], h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ spawnCalls: 2, controllerWait: { rounds: 2,
        retryAfter: new Date(Date.parse(h.ports.now()) + 2_000).toISOString() } });
    }
    await holder.release();
    advance(outcome === "released" ? 1_000 : 599_000);
    if (outcome === "attributed") {
      const resumed = await restartAdmission(h.ports.now());
      expect(resumed.calls).toHaveLength(0);
      expect(resumed.detail).toContain(holderText);
    } else await engineModule.tickPipelines([], h.ports);
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
      expect(current.stateDetail).toContain(holderText);
      expect(current.runs[0]!.attempts[0]!.spawnCalls).toBe(2);
    }
  } finally {
    await holder.close();
    resolve.mockRestore(); client.mockRestore(); guard.mockRestore(); dispatch.mockRestore();
    registry.close(); setAgentRegistryForTests(null); ids.mockRestore();
  }
});

test.each([false, true])("a drain suspends an unsubmitted admission without erasing charged writer time: %s", async charged => {
  const ids = identifiers(charged ? 14 : 7);
  try {
    const h = await reserveActivationOnly();
    const advance = frozenWallClock(h);
    const rows = loadPipelines();
    rows[0]!.runs[0]!.attempts[0]!.activation!.admissionStartedAt = h.ports.now();
    rows[0]!.runs[0]!.attempts[0]!.activation!.phase = "reserving";
    rows[0]!.runs[0]!.attempts[0]!.spawnCalls = 1;
    if (charged) {
      const { beginSpawnAdmission, switchSpawnAdmissionPhase } = await import("./spawnAdmissionBudget");
      const attempt = rows[0]!.runs[0]!.attempts[0]!;
      beginSpawnAdmission(attempt, h.ports.now());
      switchSpawnAdmissionPhase(attempt, h.ports.now(), "writer");
      advance(300_000);
    }
    savePipelines(rows);
    h.ports.drainHold = () => ({ id: "hold", target: "a".repeat(40), since: h.ports.now(), until: Number.MAX_SAFE_INTEGER });
    await engineModule.drainStageActivations(h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.activation!.admissionStartedAt).toBeUndefined();
    if (charged) expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.spawnAdmissionBudget).toMatchObject({ spent: { writer: 300_000 } });
    advance(601_000);
    h.ports.drainHold = () => null;
    if (charged) {
      const resumed = await restartAdmission(h.ports.now());
      expect({ state: resumed.state, detail: resumed.detail }).toMatchObject({ state: "running" });
      expect(resumed.calls).toHaveLength(1);
      expect(resumed.calls[0].remaining).toBeGreaterThan(0);
      expect(resumed.calls[0].remaining).toBeLessThanOrEqual(300_000);
    } else {
      await engineModule.drainStageActivations(h.ports);
      expect(h.spawnInputs).toHaveLength(1);
    }
  } finally { ids.mockRestore(); }
});

test.each([
  { spent: 597_000, delay: 3_000, expired: true },
  { spent: 0, delay: 600_000, expired: true },
  { spent: 597_000, delay: 2_999, expired: false },
])("a host checkpoint retains its monotonic cutoff: %j", async ({ spent, delay, expired }) => {
  const ids = identifiers(spent === 0 ? 22 : expired ? 21 : 23);
  const h = await reserveActivationOnly();
  const advance = frozenWallClock(h);
  const rows = loadPipelines();
  rows[0]!.runs[0]!.attempts[0]!.spawnAdmissionBudget = {
    kind: "host", spent: { host: spent, writer: 0, controller: 0 },
  };
  savePipelines(rows);
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `checkpoint-${spent}-${delay}.json`));
  setAgentRegistryForTests(registry);
  let clock = 1_000;
  const monotonic = spyOn(performance, "now").mockImplementation(() => clock);
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockImplementation(engine => ({ kind: "available", account: {
    engine, accountId: "fixture-account", kind: "managed", home: process.env.LLV_STATE_DIR!,
    transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
  } }));
  const clientModule = await import("@/lib/runtime/client");
  const guardModule = await import("@/lib/git/stageAttemptGuard");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const store = await import("./store");
  const mutate = store.withPipelineMutation;
  let delayCheckpoint = false;
  let delayed = false;
  const checkpoint = spyOn(store, "withPipelineMutation").mockImplementation(<T>(...args: Parameters<typeof mutate<T>>) => {
    if (delayCheckpoint) {
      delayCheckpoint = false;
      delayed = true;
      clock += delay;
      advance(delay);
    }
    return mutate<T>(...args);
  });
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockResolvedValue({});
  let dispatches = 0;
  const dispatch = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async input => {
    await input.authorize?.();
    dispatches++;
    return { path: null } as never;
  });
  const defaults = defaultPipelinePorts();
  let hostPhases = 0;
  h.ports.spawnAgent = (input, reserved, prepare, phase) => defaults.spawnAgent(input, reserved, prepare, async kind => {
    if (kind === "host" && ++hostPhases === 3) delayCheckpoint = true;
    return phase!(kind);
  });
  h.ports.spawnReceipt = defaults.spawnReceipt;
  try {
    await engineModule.drainStageActivations(h.ports);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    expect(delayed).toBe(true);
    expect(hostPhases).toBe(3);
    expect(dispatches).toBe(expired ? 0 : 1);
    expect(lane.state).toBe(expired ? "needs_decision" : "running");
    if (expired) {
      expect(lane.stateDetail).toContain("spawn admission budget exhausted");
      expect(registry.spawnReceipt(attempt.launchId!)?.state).toBe("failed");
      expect(attempt.spawnAdmissionBudget!.spent.host).toBe(600_000);
    }
  } finally {
    checkpoint.mockRestore(); monotonic.mockRestore(); resolve.mockRestore();
    client.mockRestore(); guard.mockRestore(); dispatch.mockRestore();
    registry.close(); setAgentRegistryForTests(null); ids.mockRestore();
  }
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
