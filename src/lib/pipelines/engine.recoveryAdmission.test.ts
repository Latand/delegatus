import { expect, test, spawn, makeStructuredAttempt, pinStageHead, AccountAuthenticationRequiredError, ProjectAccountRefusedError, selectProjectAccount, IDLE_TURN_QUIET_MS, tickPipelines, createPipelineFromRequest, loadPipelines, savePipelines, patchPipeline, entry, harness, create, structuredLatest, runningStructuredStage, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, SILENT_RUN, stageWhoseStopMovesTheTranscript, recoveryReport, providerRecoveryHarness, parkedAccountCases, parkedAccountHarness } from "./engine.fixture";
import type { DurableQuotaObservation, PipelinePorts, StageTurnEvidence } from "./engine.fixture";
import { AgentRegistry, defaultPipelinePorts, path } from "./engine.fixture";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { saveRoleOverrides } from "@/lib/roles/store";
import { setAgentMemoryPortsForTests } from "@/lib/runtime/agentMemory";
import { structuredHostCell } from "@/lib/runtime/structuredSpawn";

test("a stop of ours whose replacement waited for a later tick still names the stop, even across a service restart", async () => {
  const h = harness();
  let exitRecordAt = 0;
  // The exit leaves evidence this tick cannot replace on; the host is gone all the same.
  const { attempt, stops, stopStageAgent } = await stageWhoseStopMovesTheTranscript(h, () => {
    exitRecordAt = Date.parse(h.ports.now());
    return { turn: "busy", message: null, lastRecordAt: exitRecordAt, launchOnly: true };
  });
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(attempt.agentPath!)], { ...h.ports, stopStageAgent,
    restartRecoveryBootId: () => "same-boot",
    restartRecoveryBootStartedAt: () => Date.parse(attempt.startedAt!) - 60_000,
    conversationTurnInterrupted: async () => "idle" });
  const held = loadPipelines()[0]!.runs[0]!.attempts;
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({ state: "running", restartRecovery: { stopped: { kind: "idle", restarted: false, lastRecordAt: exitRecordAt } } });

  // The service restarts before the next tick; nothing was written after the host was gone.
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: exitRecordAt });
  h.advanceWallClock(60_000);
  await tickPipelines([entry(attempt.agentPath!)], { ...h.ports, stopStageAgent,
    restartRecoveryBootId: () => "boot-2",
    restartRecoveryBootStartedAt: () => Date.parse(h.ports.now()) - 1_000,
    conversationTurnInterrupted: async () => "dead" });
  expect(stops).toEqual(["build:1", "build:1"]);
  const lane = loadPipelines()[0]!;
  expect(lane.runs[0]!.attempts[0]!.error).toBe("stopped by Delegatus after its turn went silent; replaced by a fresh stage attempt");
  expect(lane.runs[0]!.attempts[1]!.restartContext).toMatchObject({ cause: "engine-stop" });
});


test("a host that worked on after an earlier stop of ours and is then found dead is a lost host", async () => {
  const h = harness();
  let exitRecordAt = 0;
  const { attempt, stopStageAgent } = await stageWhoseStopMovesTheTranscript(h, () => {
    exitRecordAt = Date.parse(h.ports.now());
    return { turn: "busy", message: null, lastRecordAt: exitRecordAt, launchOnly: true };
  });
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  const sameBoot = (interruption: "idle" | "dead"): PipelinePorts => ({ ...h.ports, stopStageAgent,
    restartRecoveryBootId: () => "same-boot",
    restartRecoveryBootStartedAt: () => Date.parse(attempt.startedAt!) - 60_000,
    conversationTurnInterrupted: async () => interruption });
  await tickPipelines([entry(attempt.agentPath!)], sameBoot("idle"));
  // The conversation was hosted again and wrote more before that host died by itself.
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: exitRecordAt + 5 * 60_000 });
  h.advanceWallClock(6 * 60_000);
  await tickPipelines([entry(attempt.agentPath!)], sameBoot("dead"));
  const lane = loadPipelines()[0]!;
  expect(lane.runs[0]!.attempts[0]!.error).toBe("stage host was lost while its turn was open; replaced by a fresh stage attempt");
  expect(lane.runs[0]!.attempts[1]!.restartContext).toMatchObject({ cause: "host-lost" });
  expect(lane.runs[0]!.attempts[0]!.restartRecovery!.stopped).toBeUndefined();
});


test("a withdrawn automatic stop leaves no recovery reservation on the attempt, whatever the transcript did meanwhile", async () => {
  const h = harness();
  await create(h.ports, SILENT_RUN as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(attempt.agentPath!)], { ...h.ports,
    restartRecoveryBootId: () => "same-boot",
    restartRecoveryBootStartedAt: () => Date.parse(attempt.startedAt!) - 60_000,
    conversationTurnInterrupted: async () => "idle",
    // The agent resumed while the stop was looking, so the stop withdrew.
    stopInterruptedStageAgent: async () => {
      h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(h.ports.now()) });
      return null;
    } });
  const after = loadPipelines()[0]!.runs[0]!.attempts;
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ state: "running" });
  expect(after[0]!.restartRecovery).toBeUndefined();
});


/* The park text of a second interruption describes the replacement's own
   interruption, and says "too" or "again" only when the attempt it replaced is
   recorded with the same cause. */
test.each([
  { first: "dead", second: "idle", cause: "host-lost", parked: "the automatic replacement attempt went silent; retry-stage to start another attempt" },
  { first: "idle", second: "dead", cause: "engine-stop", parked: "the automatic replacement attempt lost its host; retry-stage to start another attempt" },
] as const)("a replacement interrupted differently from the attempt it replaced claims nothing about that attempt: $first then $second", async ({ first, second, cause, parked }) => {
  const h = harness();
  await create(h.ports, SILENT_RUN as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.paneId = null;
  savePipelines([lane]);
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
  const sameBoot = (interruption: "idle" | "dead"): PipelinePorts => ({ ...h.ports,
    restartRecoveryBootId: () => "same-boot",
    restartRecoveryBootStartedAt: () => Date.parse(attempt.startedAt!) - 60_000,
    conversationTurnInterrupted: async () => interruption });
  if (first !== "dead") h.setStageHost(attempt.conversationId!, { outcome: "stopped" });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(attempt.agentPath!)], sameBoot(first));
  await tickPipelines([], sameBoot(first));
  const replaced = loadPipelines()[0]!;
  const replacement = replaced.runs[0]!.attempts[1]!;
  expect(replacement.restartContext).toMatchObject({ previousAttempt: 1, cause });
  replacement.paneId = null;
  savePipelines([replaced]);
  h.durableTurns.set(replacement.agentPath!, { turn: "busy", message: null, lastRecordAt: Date.parse(replacement.startedAt!) + 1 });
  h.advanceWallClock(IDLE_TURN_QUIET_MS);
  await tickPipelines([entry(replacement.agentPath!)], sameBoot(second));
  const parkedLane = loadPipelines()[0]!;
  expect(parkedLane.state).toBe("needs_decision");
  expect(parkedLane.stateDetail).toBe(parked);
  expect(parkedLane.stateDetail).not.toContain("too");
  expect(parkedLane.stateDetail).not.toContain("again");
  expect(parkedLane.stateDetail).not.toContain("restart");
});


test("an OOM death retries once after headroom recovers in the same worktree, then parks", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  let killAt = h.ports.now();
  h.ports.conversationHostUnavailableSince = async () => killAt;
  h.ports.conversationOutOfMemory = async () => ({ at: killAt, limitBytes: 15 * 2 ** 30, limit: "agent", fatal: true, process: null });
  let available = 1 * 2 ** 30;
  h.ports.memoryHeadroom = () => ({ availableBytes: available, requiredBytes: 15 * 2 ** 30 });
  const worktree = loadPipelines()[0]!.worktreeDir;
  const callsBefore = h.calls.filter((call) => call.startsWith("spawn:")).length;
  await tickPipelines([], h.ports);
  let pipeline = loadPipelines()[0]!;
  expect(pipeline.runs[0]!.attempts[0]).toMatchObject({ state: "failed", error: "killed: out of memory (limit 15 GB)", outOfMemory: { limit: "agent" } });
  expect(pipeline.runs[0]!.attempts[1]!.input).toContain("changes are still in this worktree");
  h.advanceWallClock(60_001);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("waiting for memory");
  expect(h.calls.filter((call) => call.startsWith("spawn:"))).toHaveLength(callsBefore);
  available = 20 * 2 ** 30;
  h.advanceWallClock(5 * 60_000);
  h.setConversationActive(true);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  pipeline = loadPipelines()[0]!;
  expect(pipeline.worktreeDir).toEqual(worktree);
  expect(pipeline.runs[0]!.attempts[1]!.state).toBe("running");
  h.setConversationActive(false);
  structuredLatest(0);
  killAt = h.ports.now();
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("automatic retry was killed the same way");
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
});


test("#3054: an OOM retry asks for the headroom of its own scoped launch, and waits until that much is free", async () => {
  const GIB = 2 ** 30;
  const h = harness();
  await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", agentMemoryMaxBytes: 8 * GIB, prompt: "Build {{task}}", next: null },
  ] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  makeStructuredAttempt();
  pinStageHead(h);
  h.setConversationActive(false);
  const at = h.ports.now();
  h.ports.conversationOutOfMemory = async () => ({ at, limitBytes: 8 * GIB, limit: "agent", fatal: true, process: null });
  const launches: Parameters<NonNullable<PipelinePorts["memoryHeadroom"]>>[1][] = [];
  let available = 4 * GIB;
  /* Stands in for the real port: the requirement is the stage's scoped cap. */
  h.ports.memoryHeadroom = (prior, launch) => {
    launches.push(structuredClone(launch));
    return { availableBytes: available, requiredBytes: Math.min(prior, launch?.profile?.agentMemoryMaxBytes ?? 3 * GIB) };
  };
  await tickPipelines([], h.ports);
  const spawnsBefore = h.spawnInputs.length;
  h.advanceWallClock(60_001);
  await tickPipelines([], h.ports);
  let pipeline = loadPipelines()[0]!;
  expect(pipeline.stateDetail).toContain("waiting for memory: 4.0 of 8.0 GB free");
  expect(h.spawnInputs).toHaveLength(spawnsBefore);
  expect(launches.at(-1) as unknown).toEqual({ cwd: pipeline.worktreeDir, project: pipeline.project, role: "builder",
    profile: { agentMemoryMaxBytes: 8 * GIB, access: "read-write", sandbox: "full" } });
  available = 8 * GIB;
  h.advanceWallClock(5 * 60_000);
  h.setConversationActive(true);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  pipeline = loadPipelines()[0]!;
  expect(pipeline.runs[0]!.attempts[1]!.state).toBe("running");
  expect(h.spawnInputs).toHaveLength(spawnsBefore + 1);
  /* The retry launched with the same profile its headroom was measured for. */
  expect(h.spawnInputs.at(-1)!.runtimeProfile).toEqual(launches.at(-1)!.profile as typeof h.spawnInputs[number]["runtimeProfile"]);
  expect(h.spawnInputs.at(-1)!.project).toBe(pipeline.project);
});

test.skipIf(process.platform === "win32")("#3054: a roleless stage's OOM retry waits for the Builder cap its launch gets, through the real planner and headroom port", async () => {
  const GIB = 2 ** 30;
  const memoryEnv = { DELEGATUS_AGENT_MEMORY: "watchdog", DELEGATUS_AGENT_MEMORY_MAX: "3G", DELEGATUS_AGENT_MEMORY_RESERVE: "4G" } as const;
  const previousEnv = Object.fromEntries(Object.keys(memoryEnv).map((key) => [key, process.env[key]]));
  const memory = { totalBytes: 16 * GIB, availableBytes: 8 * GIB, probe: () => null, runner: () => "" };
  Object.assign(process.env, memoryEnv);
  saveRoleOverrides({ builder: { config: { agentMemoryMaxBytes: 8 * GIB } } });
  setAgentMemoryPortsForTests(memory);
  try {
    const h = harness();
    await create(h.ports, [
      { id: "build", kind: "run", engine: "codex", access: "read-write", prompt: "Build {{task}}", next: null },
    ] as never);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    makeStructuredAttempt();
    pinStageHead(h);
    let pipeline = loadPipelines()[0]!;
    expect(pipeline.runs[0]!.attempts[0]!.effectiveRole.roleId ?? null).toBeNull();
    /* The launch cap, as a stage launch builds it: no receipt role, a pipeline membership. */
    const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "roleless-memory-registry.json"), undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({ engine: "codex", cwd: pipeline.worktreeDir!, transport: "structured", role: null,
      launchProfile: emptyLaunchProfile({ cwd: pipeline.worktreeDir!, title: "Measure the roleless stage launch cap" }),
      memberships: [{ kind: "pipeline", containerId: pipeline.id, role: "agent", slot: "build:2", stageId: "build", stageOrder: 0, round: 2, parentConversationId: null }] });
    if (begun.kind !== "created") throw new Error("expected a fresh receipt");
    const launchCap = structuredHostCell(registry, "codex", begun.receipt.launchId, begun.receipt.conversationId, begun.receipt)!.plan.cap!.limitBytes;
    expect(launchCap).toBe(8 * GIB);
    h.setConversationActive(false);
    const at = h.ports.now();
    h.ports.conversationOutOfMemory = async () => ({ at, limitBytes: 8 * GIB, limit: "agent", fatal: true, process: null });
    h.ports.memoryHeadroom = defaultPipelinePorts().memoryHeadroom;
    await tickPipelines([], h.ports);
    const spawnsBefore = h.spawnInputs.length;
    h.advanceWallClock(60_001);
    await tickPipelines([], h.ports);
    pipeline = loadPipelines()[0]!;
    /* 8 GiB available less the 4 GiB reserve leaves 4 GiB, short of the 8 GiB launch cap. */
    expect(pipeline.stateDetail).toContain("waiting for memory: 4.0 of 8.0 GB free");
    expect(h.spawnInputs).toHaveLength(spawnsBefore);
    memory.availableBytes = 12 * GIB;
    h.advanceWallClock(5 * 60_000);
    h.setConversationActive(true);
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    pipeline = loadPipelines()[0]!;
    expect(pipeline.runs[0]!.attempts[1]!.state).toBe("running");
    expect(h.spawnInputs).toHaveLength(spawnsBefore + 1);
  } finally {
    setAgentMemoryPortsForTests(null);
    saveRoleOverrides({});
    for (const [key, value] of Object.entries(previousEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("an OOM recovery wait that never gets headroom parks after its bounded budget", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  const at = h.ports.now();
  h.ports.conversationOutOfMemory = async () => ({ at, limitBytes: 15 * 2 ** 30, limit: "agent", fatal: true, process: null });
  h.ports.memoryHeadroom = () => ({ availableBytes: 0, requiredBytes: 15 * 2 ** 30 });
  await tickPipelines([], h.ports);
  h.advanceWallClock(30 * 60_000 + 1);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("memory did not recover within 30 minutes");
});

test("a read-only OOM uses memory retry, and positive verdict evidence still wins", async () => {
  const h = harness();
  await create(h.ports, [{ id: "review", kind: "run", role: { roleId: "reviewer" }, engine: "codex", access: "read-only", prompt: "Review {{task}}", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  structuredLatest(0);
  h.setConversationActive(false);
  const at = h.ports.now();
  h.ports.conversationOutOfMemory = async () => ({ at, limitBytes: 15 * 2 ** 30, limit: "agent", fatal: true, process: null });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.error).toBe("killed: out of memory (limit 15 GB)");
  expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.memoryWait).toBeDefined();
  const verdict = harness();
  await runningStructuredStage(verdict);
  verdict.setConversationActive(false);
  verdict.ports.conversationOutOfMemory = h.ports.conversationOutOfMemory;
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  verdict.durableTurns.set(attempt.agentPath!, { turn: "terminal", message: { text: '```json\n{"status":"pass","findings":[]}\n```', ts: Date.parse(verdict.ports.now()) + 1 } } as StageTurnEvidence);
  await tickPipelines([], verdict.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.outOfMemory).toBeUndefined();
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
});



test("an auto scope admission failure retries with a fresh launch before delivery", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const baseSpawn = h.ports.spawnAgent;
  let spawnCalls = 0;
  const clientAttemptIds: string[] = [];
  Object.assign(h.ports, { sleep: async () => {} });
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    clientAttemptIds.push(input.clientAttemptId);
    if (spawnCalls < 3) throw new Error("agent memory scope launch failed before exec; retry shortly");
    return baseSpawn(input, onReserved);
  };

  await tickPipelines([], h.ports);

  expect(spawnCalls).toBe(3);
  expect(new Set(clientAttemptIds).size).toBe(3);
  const current = loadPipelines()[0]!;
  expect(current).toMatchObject({
    state: "running",
    stateDetail: null,
    cursor: { stageId: "plan", state: "running" },
  });
  expect(current.runs[0]!.attempts[0]!.state).toBe("running");
});


// Recovery regressions use the existing injected controller ports.
test.each([false, true])("Codex unavailable prompt metadata lets both lanes settle (reverse=%s)", async reverse => {
  const h = harness();
  const stages: import("./types").PipelineStageInput[] = [{ id: "check", kind: "run", engine: "codex", role: { roleId: "reviewer" }, access: "read-only", prompt: "Check", next: null }];
  await create(h.ports, stages as never);
  const second = await createPipelineFromRequest({ task: "Check another lane", spec: "AC1", repoDir: "/other-repo", stages,
    src: "/codex/creator.jsonl", publication: "internal" }, h.ports);
  expect(second.error).toBeUndefined();
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(2);
  const at = Date.parse(h.ports.now()) + 100_000;
  const files = [false, true].map(unavailable => stageTranscript(`unavailable-marker-lane-${unavailable}`, [
    ...(unavailable ? [{ type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "user_message",
      message: `<!-- llv:structured-user ctx=a.${"A".repeat(43)}.${"B".repeat(16)} -->\nWait for my review` } }] : []),
    { type: "event_msg", timestamp: new Date(at + 1000).toISOString(), payload: { type: "agent_message", message: 'Done\n```json\n{"status":"pass"}\n```' } },
    { type: "event_msg", timestamp: new Date(at + 2000).toISOString(), payload: { type: "task_complete" } },
  ]));
  readFixtures(h, { "/codex/stage-1.jsonl": files[0]!, "/codex/stage-2.jsonl": files[1]! });
  h.setConversationActive(false);
  h.setPaneAlive(false);
  if (reverse) savePipelines(loadPipelines().reverse());
  for (let tick = 0; tick < 4; tick++) await tickPipelines([], h.ports);
  expect(loadPipelines()).toHaveLength(2);
  for (const lane of loadPipelines()) {
    expect(lane.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
    expect(lane.state).toBe("completed");
  }
});


test("Codex unavailable prompt metadata cancels a parked quota retry", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.stateDetail).toMatch(/Automatic retry|Автоповтор/);
  const cut = f.now();
  f.advance(1000);
  const file = stageTranscript("unavailable-marker-parked", [providerQuotaRecord("codex", cut),
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "user_message",
      message: `<!-- llv:structured-user ctx=a.${"A".repeat(43)}.${"B".repeat(16)} -->\nWait for my review` } },
    providerQuotaRecord("codex", f.now() + 500),
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  f.advance(31 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
});


for (const parked of [false, true]) {
  test(`recorded report wins with an unreadable transcript, parked=${parked}`, async () => {
    const h = harness();
    await runningStructuredStage(h);
    h.setConversationActive(false);
    const pipeline = loadPipelines()[0]!;
    const attempt = pipeline.runs[0]!.attempts[0]!;
    attempt.report = recoveryReport(h.ports.now());
    if (parked) {
      pipeline.state = "needs_decision";
      pipeline.stateDetail = "stage spawn recovery stopped: transcript publication pending";
      attempt.state = "needs_decision";
      attempt.error = pipeline.stateDetail;
    }
    savePipelines([pipeline]);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
    expect(loadPipelines()[0]!.cursor?.stageId).toBe("build");
  });
}


for (const engine of ["claude", "codex"] as const) {
  test(`${engine} provider cut waits and continues once with a stable key`, async () => {
    const h = harness();
    await runningStructuredStage(h);
    h.setConversationActive(false);
    let now = Date.parse(h.ports.now());
    h.ports.now = () => new Date(now).toISOString();
    const pipeline = loadPipelines()[0]!;
    pipeline.stages[0]!.effectiveRole.engine = engine;
    pipeline.stages[0]!.effectiveRole.model = engine === "claude" ? "fable" : "gpt-5.6-sol";
    pipeline.runs[0]!.attempts[0]!.effectiveRole.engine = engine;
    pipeline.runs[0]!.attempts[0]!.effectiveRole.model = engine === "claude" ? "fable" : "gpt-5.6-sol";
    savePipelines([pipeline]);
    const sends: string[] = [];
    h.ports.resumeSeveredTurn = async (input) => { sends.push(input.clientMessageId); h.setConversationActive(true); return true; };
    h.durableTurns.set("/codex/stage-1.jsonl", {
      turn: "terminal", message: { text: "provider failure", ts: now },
      terminalProviderMessage: { text: "Failed to refresh OAuth token: retry in a minute", ts: now, errorClass: "server_error" },
    });
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.state).toBe("running");
    expect(loadPipelines()[0]!.stateDetail).toContain("auth refresh race");
    expect(sends).toHaveLength(0);
    now += 60_000;
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    expect(new Set(sends).size).toBe(1);
    expect(sends).toHaveLength(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRequest).toBeUndefined();
  });
}


test.each((["claude", "codex"] as const).flatMap(engine => (["capacity", "authentication", "signed-out"] as const)
  .flatMap(kind => (["automatic", "pause-resume", "closed", ...(kind === "capacity" ? ["stale-capacity" as const] : [])] as const)
    .map(control => ({ engine, kind, control })))))
("a fresh allowed $engine account resumes unlaunched $kind admission with control=$control", async ({ engine, kind, control }) => {
  const h = harness();
  await create(h.ports, [{ id: "plan", kind: "run", engine, model: engine === "claude" ? "fable" : "gpt-5.6-sol",
    role: { roleId: "builder" }, prompt: "Build {{task}}", next: null }] as never);
  await tickPipelines([], h.ports);
  let available = false;
  const project = loadPipelines()[0]!.project;
  h.ports.allowedAccountIds = () => available ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT];
  h.ports.resolveProjectSpawn = () => available
    ? { kind: "available", account: { engine, accountId: control === "stale-capacity" ? LIMITED_ACCOUNT : SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!,
      transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } }
    : { kind: "exhausted", resetsAt: Math.floor(Date.parse(h.ports.now()) / 1000) + 86_400, allowedAccountIds: [LIMITED_ACCOUNT] };
  h.ports.engineReadiness = () => kind === "signed-out" && !available ? "signed-out" : "connected";
  h.ports.accountRecovered = () => available && control !== "stale-capacity";
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => {
    if (!available) {
      if (kind === "authentication") throw new AccountAuthenticationRequiredError(engine, LIMITED_ACCOUNT);
      throw new ProjectAccountRefusedError({ kind: "exhausted", resetsAt: Math.floor(Date.parse(h.ports.now()) / 1000) + 86_400,
        allowedAccountIds: [LIMITED_ACCOUNT] }, engine, project);
    }
    return spawn(input, reserved);
  };
  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(h.spawnInputs).toHaveLength(0);
  expect(parked.runs[0]!.attempts[0]!.launchId).toBeNull();
  h.advanceWallClock(1000);
  if (control === "pause-resume") {
    await patchPipeline(parked.id, { action: "pause" }, h.ports);
    await patchPipeline(parked.id, { action: "resume" }, h.ports);
  } else if (control === "closed") {
    parked.closedAt = h.ports.now();
    savePipelines([parked]);
  }
  available = true;
  for (let tick = 0; tick < 4; tick++) await tickPipelines([], { ...h.ports });
  const resumed = loadPipelines()[0]!;
  expect(h.spawnInputs).toHaveLength(control === "automatic" ? 1 : 0);
  expect(resumed.runs[0]!.attempts).toHaveLength(1);
  expect(resumed.worktreeDir).toBe(parked.worktreeDir);
});


test.each((["claude", "codex"] as const).flatMap(engine => (["capacity", "authentication"] as const).map(kind => ({ engine, kind }))))
("unlaunched $engine $kind recovery fences a stale refused source through spawn", async ({ engine, kind }) => {
  const h = harness();
  await create(h.ports, [{ id: "plan", kind: "run", engine, model: engine === "claude" ? "fable" : "gpt-5.6-sol",
    role: { roleId: "builder" }, prompt: "Build {{task}}", next: null }] as never);
  await tickPipelines([], h.ports);
  const project = loadPipelines()[0]!.project;
  const accounts = [{ id: LIMITED_ACCOUNT, authPresent: true }, { id: SPARE_ACCOUNT, authPresent: true }];
  const observations: DurableQuotaObservation[] = [{ engine, accountId: LIMITED_ACCOUNT, authenticated: kind === "capacity",
    observedAt: h.ports.now(), authCheckedAt: h.ports.now(), bootId: "fixture",
    limits: { session: { usedPercent: 100, resetsAt: Math.floor(Date.parse(h.ports.now()) / 1000) + 86_400 }, weekly: null,
      plan: "pro", capturedAt: Date.parse(h.ports.now()) }, provenance: { source: "live", reason: null, staleSince: null } }];
  let available = false;
  h.ports.allowedAccountIds = () => available ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT];
  h.ports.accountRecovered = () => false;
  h.ports.resolveProjectSpawn = (_engine, input) => {
    const selected = selectProjectAccount({ engine, project, accounts, observations, preferredId: LIMITED_ACCOUNT,
      bindings: h.ports.allowedAccountIds!(project, engine)!.map(accountId => ({ engine, project, accountId, createdAt: h.ports.now() })),
      requestedId: input.requestedId, unavailableIds: input.unavailableIds, model: input.model, now: Date.parse(h.ports.now()) });
    return selected.kind === "available" ? { kind: "available", account: { engine, accountId: selected.accountId!, kind: "managed",
      home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } } : selected;
  };
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => {
    if (!available) {
      if (kind === "authentication") throw new AccountAuthenticationRequiredError(engine, LIMITED_ACCOUNT);
      throw new ProjectAccountRefusedError({ kind: "exhausted", resetsAt: null, allowedAccountIds: [LIMITED_ACCOUNT] }, engine, project);
    }
    expect(input.requestedAccountId).toBe(SPARE_ACCOUNT);
    expect(input.unavailableAccountIds).toContain(LIMITED_ACCOUNT);
    const selected = h.ports.resolveProjectSpawn!(engine, { project, model: input.role.model,
      requestedId: input.requestedAccountId, unavailableIds: input.unavailableAccountIds });
    if (selected.kind !== "available") throw new ProjectAccountRefusedError(selected, engine, project);
    return spawn({ ...input, requestedAccountId: selected.account.accountId }, reserved);
  };
  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(h.spawnInputs).toHaveLength(0);
  h.advanceWallClock(10 * 60_000);
  available = true;
  for (let tick = 0; tick < 4; tick++) await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(1);
  expect(h.spawnInputs[0]!.requestedAccountId).toBe(SPARE_ACCOUNT);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accountId).toBe(SPARE_ACCOUNT);
  expect(loadPipelines()[0]!.worktreeDir).toBe(parked.worktreeDir);
});


test.each(parkedAccountCases.flatMap(item => (["binding", "login", "capacity"] as const).map(event => ({ ...item, event }))))
("a fresh allowed $engine account resumes a parked $kind stage after $event", async ({ engine, kind, event }) => {
  const f = await parkedAccountHarness(engine, kind);
  if (event !== "binding") f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT]);
  if (event === "login") f.accounts[1]!.authPresent = false;
  if (event === "capacity") f.observations.push({ ...f.observations[0]!, accountId: SPARE_ACCOUNT, authenticated: true });
  await tickPipelines([], f.h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  const receipt = parked.runs[0]!.attempts[0]!.launchId;
  if (event === "binding") f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT]);
  if (event === "login") f.accounts[1]!.authPresent = true;
  if (event === "capacity") f.observations[1]!.limits!.session!.usedPercent = 25;
  // A fresh port object models a Viewer restart, with no in-memory event.
  await tickPipelines([], { ...f.h.ports });
  expect(f.h.spawnInputs).toHaveLength(2);
  for (let tick = 0; tick < 3; tick++) await tickPipelines([], f.h.ports);
  const resumed = loadPipelines()[0]!;
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
  expect(resumed.runs[0]!.attempts).toHaveLength(2);
  expect(resumed.runs[0]!.attempts[0]!.launchId).toBe(receipt);
  expect(resumed.worktreeDir).toBe(parked.worktreeDir);
  expect(resumed.runs[0]!.attempts[1]!.input).toBe(parked.runs[0]!.attempts[0]!.input);
  expect(f.sends).toHaveLength(0);
  expect(f.h.calls.some(call => /reset --hard|clean -/.test(call))).toBe(false);
});


test.each(parkedAccountCases)("a pinned $engine $kind park requires fresh proof on its own account", async ({ engine, kind }) => {
  const f = await parkedAccountHarness(engine, kind, true);
  await tickPipelines([], f.h.ports);
  f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT]);
  f.accounts[0]!.authPresent = true;
  f.observations[0]!.authenticated = true;
  f.observations[0]!.limits!.session!.usedPercent = 25;
  let recovered = false;
  f.h.ports.accountRecovered = (_engine, id) => recovered && id === LIMITED_ACCOUNT;
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  recovered = true;
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(LIMITED_ACCOUNT);
  expect(f.h.spawnInputs[1]!.unavailableAccountIds).not.toContain(LIMITED_ACCOUNT);
});


test.each(["claude", "codex"] as const)("a fresh allowed %s account replaces an authentication target refused before reservation", async engine => {
  const f = await parkedAccountHarness(engine, "auth_required");
  await tickPipelines([], f.h.ports);
  const spawn = f.h.ports.spawnAgent;
  f.h.ports.spawnAgent = async (input, reserved) => {
    if (input.requestedAccountId === SPARE_ACCOUNT) throw new AccountAuthenticationRequiredError(engine, SPARE_ACCOUNT);
    return spawn(input, reserved);
  };
  f.advance(1000);
  f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT]);
  for (let tick = 0; tick < 3; tick++) await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.stateDetail).toContain("target preflight failed");
  f.accounts.push({ id: "account-c", authPresent: true });
  f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT, "account-c"]);
  for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe("account-c");
  expect(f.h.spawnInputs[1]!.unavailableAccountIds).toContain(SPARE_ACCOUNT);
  expect(f.sends).toHaveLength(0);
});
