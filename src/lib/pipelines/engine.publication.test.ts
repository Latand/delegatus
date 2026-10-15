import { expect, spyOn, test, crypto, spawn, fs, path, AccountAuthenticationRequiredError, ProjectAccountRefusedError, selectProjectAccount, IDLE_TURN_QUIET_MS, defaultPipelinePorts, tickPipelines, AgentRegistry, setAgentRegistryForTests, createPipelineFromRequest, loadPipelines, savePipelines, durableStageTurnEvidence, loadTasks, saveTasks, patchPipeline, entry, harness, create, withRuntimeSnapshot, structuredLatest, PASS_TEXT, runningStructuredStage, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, SILENT_RUN, stageWhoseStopMovesTheTranscript, recoveryReport, providerRecoveryHarness, parkedAccountCases, parkedAccountHarness, BASE_NOTIFICATION_CANCELLATIONS, SAVED_NOTIFICATION_SCENARIOS } from "./engine.fixture";
import type { DurableQuotaObservation, PipelinePorts, StageTurnEvidence } from "./engine.fixture";


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

test.each(parkedAccountCases.flatMap(item => (["binding", "login"] as const).map(event => ({ ...item, event }))))
("a fresh allowed $engine account replaces a $kind target signed out before launch after $event", async ({ engine, kind, event }) => {
  const f = await parkedAccountHarness(engine, kind);
  await tickPipelines([], f.h.ports);
  let replacement = false;
  f.h.ports.engineReadiness = () => {
    if (!replacement && loadPipelines()[0]!.runs[0]!.attempts.length > 1) {
      f.accounts[1]!.authPresent = false;
      return "signed-out";
    }
    return "connected";
  };
  f.advance(1000);
  f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT]);
  for (let tick = 0; tick < 3; tick++) await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  f.advance(1000);
  replacement = true;
  const target = event === "binding" ? "account-c" : SPARE_ACCOUNT;
  if (event === "binding") {
    f.accounts.push({ id: target, authPresent: true });
    f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT, target]);
  } else {
    f.accounts[1]!.authPresent = true;
    f.h.ports.accountRecovered = (_engine, id, _cutAt, _model, condition) => id === SPARE_ACCOUNT && condition === "auth_required";
  }
  for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(target);
  if (event === "binding") expect(f.h.spawnInputs[1]!.unavailableAccountIds).toContain(SPARE_ACCOUNT);
  else expect(f.h.spawnInputs[1]!.unavailableAccountIds).not.toContain(SPARE_ACCOUNT);
  expect(f.sends).toHaveLength(0);
});

test.each((["claude", "codex"] as const).flatMap(engine => (["binding", "capacity", "reset"] as const).map(event => ({ engine, event }))))
("a $engine authentication target's exhausted preflight keeps its quota fence until $event", async ({ engine, event }) => {
  const f = await parkedAccountHarness(engine, "auth_required");
  await tickPipelines([], f.h.ports);
  const spawn = f.h.ports.spawnAgent;
  let refused = false;
  f.h.ports.spawnAgent = async (input, reserved) => {
    if (input.requestedAccountId === SPARE_ACCOUNT && !refused) {
      refused = true;
      f.observations.push({ ...f.observations[0]!, accountId: SPARE_ACCOUNT, authenticated: true });
      throw new ProjectAccountRefusedError({ kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] },
        engine, loadPipelines()[0]!.project);
    }
    return spawn(input, reserved);
  };
  f.advance(1000);
  f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT]);
  for (let tick = 0; tick < 3; tick++) await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  f.advance(1000);
  const quota = f.observations[1]!.limits!;
  f.observations[1]!.limits = null;
  let capacity = false;
  f.h.ports.accountRecovered = (_engine, id, _cutAt, _model, condition) => id === SPARE_ACCOUNT && (condition === "auth_required" || capacity);
  for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  const target = event === "binding" ? "account-c" : SPARE_ACCOUNT;
  if (event === "binding") {
    f.accounts.push({ id: target, authPresent: true });
    f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT, target]);
  } else if (event === "capacity") {
    capacity = true;
    f.observations[1]!.limits = { ...quota, session: { usedPercent: 25, resetsAt: f.resetsAt } };
  } else f.advance(f.resetsAt! * 1000 + 60_000 - f.now());
  for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(event === "reset" ? null : target);
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.accountId).toBe(target);
  if (event === "reset") {
    expect(f.h.spawnInputs[1]!.unavailableAccountIds).toContain(LIMITED_ACCOUNT);
    expect(f.h.spawnInputs[1]!.unavailableAccountIds).not.toContain(SPARE_ACCOUNT);
  }
  expect(f.sends).toHaveLength(0);
});

test.each(["claude", "codex"] as const)("fresh %s authentication cannot clear a recorded usage limit", async engine => {
  const f = await parkedAccountHarness(engine, "auth_required", true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.usageLimitedAccounts = [{ engine, accountId: LIMITED_ACCOUNT,
    limitedAt: f.now() - 1000, resetsAt: f.resetsAt }];
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  f.advance(1000);
  f.accounts[0]!.authPresent = true;
  f.observations[0]!.authenticated = true;
  f.observations[0]!.limits = null;
  f.h.ports.accountRecovered = (_engine, _id, _cutAt, _model, condition) => condition === "auth_required";
  for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(f.sends).toHaveLength(0);
});

test.each(parkedAccountCases.flatMap(item => [false, true].map(pinned => ({ ...item, pinned }))))
("a fresh allowed $engine source resumes its parked $kind stage with pinned=$pinned", async ({ engine, kind, pinned }) => {
  const f = await parkedAccountHarness(engine, kind, pinned);
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `source-recovery-${crypto.randomUUID()}.json`));
  setAgentRegistryForTests(registry);
  const clock = spyOn(Date, "now").mockImplementation(f.now);
  try {
    f.h.ports.accountRecovered = defaultPipelinePorts().accountRecovered;
    await tickPipelines([], f.h.ports);
    const parked = loadPipelines()[0]!;
    expect(parked.state).toBe("needs_decision");
    const receipt = parked.runs[0]!.attempts[0]!.launchId;
    f.advance(1000);
    f.accounts[0]!.authPresent = true;
    const observation = { ...f.observations[0]!, authenticated: true, authCheckedAt: f.h.ports.now(), observedAt: f.h.ports.now(),
      limits: kind === "auth_required" ? null : { ...f.observations[0]!.limits!, session: { usedPercent: 25, resetsAt: f.resetsAt } },
      provenance: { source: kind === "auth_required" ? "unavailable" as const : "live" as const, reason: null, staleSince: null } };
    f.observations[0] = observation;
    registry.recordQuotaObservation(observation);
    for (let tick = 0; tick < 4; tick++) await tickPipelines([], { ...f.h.ports });
    const resumed = loadPipelines()[0]!;
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(LIMITED_ACCOUNT);
    expect(f.h.spawnInputs[1]!.unavailableAccountIds).not.toContain(LIMITED_ACCOUNT);
    expect(resumed.runs[0]!.attempts[0]!.launchId).toBe(receipt);
    expect(resumed.worktreeDir).toBe(parked.worktreeDir);
    expect(f.sends).toHaveLength(0);
  } finally {
    clock.mockRestore();
    setAgentRegistryForTests(null);
  }
});

test.each((["claude", "codex"] as const).flatMap(engine => [null, -60_000].map(resetDelay => ({ engine, resetDelay }))))
("a fresh allowed $engine account resumes after its bounded fallback is exhausted (reset=$resetDelay)", async ({ engine, resetDelay }) => {
  const f = await parkedAccountHarness(engine, "usage_limit", false, resetDelay);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerFallbackRetries = 1;
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("retry exhausted");
  f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT]);
  for (let tick = 0; tick < 4; tick++) await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
  expect(f.sends).toHaveLength(0);
});

test.each(parkedAccountCases.flatMap(item => (["fresh", "prior", "stale", "future", "exhausted", "credits", "signed-out", "transcript", "other-engine", "fresh-auth-only", "prior-auth", "stale-auth"] as const)
  .map(sample => ({ ...item, sample }))))
("parked $engine $kind recovery requires a fresh live $sample observation", ({ engine, kind, sample }) => {
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `account-recovery-${crypto.randomUUID()}.json`));
  setAgentRegistryForTests(registry);
  const now = Date.now();
  const cutAt = now - 2000;
  const sampledAt = sample === "prior" ? cutAt - 1000 : sample === "stale" ? now - 6 * 60_000
    : sample === "future" ? now + 60_000 : now - 1000;
  registry.recordQuotaObservation({ engine: sample === "other-engine" ? engine === "claude" ? "codex" : "claude" : engine,
    accountId: LIMITED_ACCOUNT, authenticated: sample !== "signed-out", observedAt: new Date(sampledAt).toISOString(),
    authCheckedAt: new Date(sample === "prior-auth" ? cutAt - 1000 : sample === "stale-auth" ? now - 6 * 60_000 : sampledAt).toISOString(), bootId: "fixture",
    limits: sample === "fresh-auth-only" ? null : { session: { usedPercent: sample === "exhausted" || sample === "credits" ? 100 : 25, resetsAt: Math.floor(now / 1000) + 86_400 },
      weekly: null, plan: "pro", capturedAt: sampledAt },
    provenance: { source: sample === "transcript" ? "transcript" : sample === "fresh-auth-only" ? "unavailable" : "live", reason: null, staleSince: null },
    resetCredits: sample === "credits" ? { availableCount: 10, expiresAt: null } : null });
  try {
    expect(defaultPipelinePorts().accountRecovered!(engine, LIMITED_ACCOUNT, cutAt, null, kind))
      .toBe(sample === "fresh" || kind === "auth_required" && sample === "fresh-auth-only");
  } finally { setAgentRegistryForTests(null); }
});

test.each(parkedAccountCases.flatMap(item => (["pause", "pause-resume", "reply", "stop", "report", "delivery", "closed", "hidden", "deferred-stop", "revoked-during-stop"] as const)
  .map(control => ({ ...item, control }))))
("fresh account recovery respects $control on a parked $engine $kind stage", async ({ engine, kind, control }) => {
  const f = await parkedAccountHarness(engine, kind);
  await tickPipelines([], f.h.ports);
  const parked = loadPipelines()[0]!;
  f.advance(1000);
  if (control === "pause" || control === "pause-resume") {
    expect((await patchPipeline(parked.id, { action: "pause" }, f.h.ports)).error).toBeUndefined();
    if (control === "pause-resume") expect((await patchPipeline(parked.id, { action: "resume" }, f.h.ports)).error).toBeUndefined();
  } else if (control === "reply") {
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", message: null,
      terminalProviderMessage: { ...f.h.durableTurns.get("/codex/stage-1.jsonl")!.terminalProviderMessage!, ts: f.now() },
      externalPromptAfterCut: true, promptHistoryComplete: true });
  } else if (control === "stop") f.h.ports.conversationOperatorStopped = async () => true;
  else if (control === "closed" || control === "hidden") {
    if (control === "closed") parked.closedAt = f.h.ports.now();
    else parked.hiddenAt = f.h.ports.now();
    savePipelines([parked]);
  } else if (control === "deferred-stop") f.h.ports.stopStageAgent = async () => ({ outcome: "deferred" });
  else if (control === "report") {
    parked.runs[0]!.attempts[0]!.report = recoveryReport(f.h.ports.now());
    savePipelines([parked]);
  } else if (control === "delivery") f.h.ports.conversationDeliveryOutstanding = () => true;
  else f.h.ports.stopStageAgent = async () => { f.allow([LIMITED_ACCOUNT]); return { outcome: "stopped" }; };
  f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT]);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.sends).toHaveLength(0);
});

test("a deploy cut followed by restored Codex settings takes restart recovery before opening a provider wait", async () => {
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const cut = f.now();
  const file = stageTranscript("deploy-settings-cut", [
    { type: "event_msg", timestamp: new Date(cut - 1000).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
    { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "turn_aborted", reason: "interrupted" } },
    { type: "event_msg", timestamp: new Date(cut + 16_000).toISOString(), payload: { type: "thread_settings_applied" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  f.h.ports.conversationRestartCut = () => ({ recordedAt: new Date(cut + 5000).toISOString() });
  f.advance(18_000);
  await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  expect(lane.state).toBe("running");
  expect(lane.runs[0]!.attempts).toHaveLength(2);
  expect(lane.runs[0]!.attempts[0]!.error).toBe("interrupted by a Delegatus restart; replaced by a fresh stage attempt");
  expect(lane.runs[0]!.attempts[0]!.providerWait).toBeUndefined();
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends).toHaveLength(0);
});

test.each([true, false].flatMap(quota => [true, false].flatMap(wait => [0, -10_000].map(skew => ({ quota, wait, skew })))))
("an operator prompt delivered during restart termination fences recovery (quota=$quota, wait=$wait, skew=$skew)", async ({ quota, wait, skew }) => {
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const cut = f.now();
  const file = stageTranscript("restart-termination-operator", [
    { type: "event_msg", timestamp: new Date(cut - 1000).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
    ...(quota ? [providerQuotaRecord("codex", cut),
      { type: "event_msg", timestamp: new Date(cut + 1000).toISOString(), payload: { type: "task_started" } }] : []),
    { type: "event_msg", timestamp: new Date(cut + 2000).toISOString(), payload: { type: "turn_aborted", reason: "interrupted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  f.advance(3000);
  if (wait) {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.condition.kind).toBe("turn_cut");
  }
  const recordedAt = f.h.ports.now();
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  let stops = 0;
  f.h.ports.stopInterruptedStageAgent = async () => {
    stops++;
    fs.appendFileSync(file, JSON.stringify({ type: "response_item", timestamp: new Date(Date.parse(recordedAt) + skew).toISOString(),
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Wait for my review" }] } }) + "\n");
    const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    const latest = await durableStageTurnEvidence("codex", file, undefined, attempt.startedAt, undefined, attempt.providerWait?.turnTs);
    expect(latest?.externalPromptAfterCut).toBe(true);
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  expect(stops).toBe(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  if (wait) expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.sends).toHaveLength(0);
});
test.each([
  ...["running", "needs_decision"].flatMap(state => SAVED_NOTIFICATION_SCENARIOS.flatMap(scenario =>
    (scenario === "automatic" ? ["turn_cut", "usage_limit", "auth_required", "transient", "host_death"] : ["turn_cut"])
      .map(kind => ({ state, scenario, kind, label: "operator-control", savedPark: null as typeof BASE_NOTIFICATION_CANCELLATIONS[number] | null })))),
  ...BASE_NOTIFICATION_CANCELLATIONS.flatMap(savedPark => SAVED_NOTIFICATION_SCENARIOS.map(scenario =>
    ({ state: savedPark.state, scenario, kind: "usage_limit", label: savedPark.error, savedPark }))),
])
("a saved notification cancellation revalidates recovery ($state, $scenario, $kind, $label)", async ({ state, scenario, kind, savedPark }) => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const cut = f.now();
  const file = stageTranscript(`saved-notification-${state}-${scenario}-${kind}`, [
    { type: "event_msg", timestamp: new Date(cut - 1000).toISOString(), payload: { type: "agent_message", message: "Working on the stage" } },
    { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "turn_aborted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  f.advance(1000);
  const recordedAt = f.h.ports.now();
  const message = scenario === "legacy-marker" ? "<!-- llv:structured-user origin=agent sender=reviewer -->\nReviewer finished"
    : encodeCodexStructuredUserText("Reviewer finished", undefined, null, { kind: "agent", role: "reviewer" });
  fs.appendFileSync(file, [
    { type: "event_msg", timestamp: recordedAt, payload: { type: "user_message", message } },
    { type: "event_msg", timestamp: recordedAt, payload: { type: "task_started" } },
    { type: "event_msg", timestamp: recordedAt, payload: { type: "turn_aborted" } },
    ...(scenario === "message" ? [{ type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "user_message", message: "Wait for my review" } }] : []),
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  // Persisted shape written by the old external-prompt path: the signed
  // reviewer notice cancelled the wait and the engine parked its attempt.
  attempt.providerWait!.condition = { ...attempt.providerWait!.condition, kind: kind as import("./providerConditions").ProviderCondition["kind"], label: kind };
  attempt.providerWait!.retryCancelled = savedPark?.retryCancelled ?? true;
  delete attempt.providerWait!.stageRetry;
  pipeline.state = state as "running" | "needs_decision";
  attempt.state = savedPark?.attemptState ?? state as "running" | "needs_decision";
  pipeline.stateDetail = savedPark?.stateDetail ?? "provider recovery cancelled by operator control; waiting for operator decision";
  attempt.error = savedPark?.error ?? pipeline.stateDetail;
  if (["pause", "old-pause"].includes(scenario)) {
    pipeline.pausedAt = scenario === "pause" ? recordedAt : new Date(Date.parse(attempt.startedAt!) - 1000).toISOString();
    pipeline.controlGeneration = "recorded-operator-control";
  }
  if (scenario === "generation") pipeline.controlGeneration = "legacy-operator-control";
  if (scenario === "report") attempt.report = recoveryReport(recordedAt);
  savePipelines([pipeline]);
  const conversationId = attempt.conversationId!;
  const directory = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "saved-notification-"));
  const journal = new RuntimeJournal(path.join(directory, "journal.sqlite"), { structuredHosts: true, now: f.now });
  const sessionKey = { engine: "codex" as const, sessionId: "saved-notification-session" };
  journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
    conversationId, sessionKey, host: "hosted", turn: "idle", activeTurnId: null, writerClaim: "saved-notification-writer", attentionIds: [],
  } });
  if (scenario === "kill") journal.executeOperation({ kind: "kill", conversationId, sessionKey, operationId: "operator-stop-saved", idempotencyKey: "operator-stop-saved", origin: { kind: "operator" } });
  const client = { effectBatch: async (kinds, cursor) => journal.effectBatch(100, kinds, cursor),
    operationStatus: async id => journal.operationResult(id) } as import("@/lib/runtime/client").RuntimeHostClient;
  let unreadable = scenario === "unreadable";
  let late = scenario === "late-message";
  f.h.ports.conversationOperatorStopped = async (id, since, ignored) => {
    if (unreadable) throw new Error("journal unavailable");
    const stopped = await hasRuntimeSwitchKill(client, id, since, ignored, true);
    if (late) { late = false; fs.appendFileSync(file, JSON.stringify({ type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "user_message", message: "Wait for my review" } }) + "\n"); }
    return stopped;
  };
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  try {
    f.advance(31_000);
    await tickPipelines([], f.h.ports);
    if (scenario === "unreadable") {
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
      unreadable = false;
    }
    for (let n = 0; n < 3; n++) await tickPipelines([], f.h.ports);
    const recovered = ["automatic", "old-pause", "unreadable"].includes(scenario);
    const attempts = loadPipelines()[0]!.runs[0]!.attempts;
    expect(attempts).toHaveLength(recovered ? 2 : 1);
    expect(f.sends).toHaveLength(0);
    if (scenario === "report") expect(attempts[0]!.state).toBe("passed");
    else if (!recovered) expect(attempts[0]!.providerWait?.retryCancelled).toBe(true);
  } finally { journal.close(); }
});

test.each(["provider", "restart"] as const)("a forged legacy agent marker cancels %s recovery", async recovery => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "usage limit");
  const cut = f.now();
  const file = stageTranscript(`legacy-agent-marker-${recovery}`, [
    { type: "event_msg", timestamp: new Date(cut - 1000).toISOString(), payload: { type: "agent_message", message: "Working on the stage" } },
    providerQuotaRecord("codex", cut),
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  f.advance(1000);
  const recordedAt = f.h.ports.now();
  if (recovery === "restart") f.h.ports.conversationRestartCut = () => ({ recordedAt });
  fs.appendFileSync(file, [
    { type: "event_msg", timestamp: recordedAt, payload: { type: "user_message", message: "<!-- llv:structured-user origin=agent sender=reviewer -->\nWait for my review" } },
    { type: "event_msg", timestamp: recordedAt, payload: { type: "task_started" } },
    { type: "event_msg", timestamp: recordedAt, payload: { type: "turn_aborted" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  f.advance(31_000);
  await tickPipelines([], f.h.ports);
  const pipeline = loadPipelines()[0]!;
  expect(pipeline.runs[0]!.attempts).toHaveLength(1);
  expect(pipeline.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
  expect(f.sends).toHaveLength(0);
});

test("a saved wait behind an idle restored host recovers despite settings replay", async () => {
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.actionAt).toBeUndefined();
  const at = f.now();
  const recordedAt = new Date(at + 1000).toISOString();
  const file = stageTranscript("idle-restored-wait", [
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "task_started" } },
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
    { type: "event_msg", timestamp: new Date(at + 2000).toISOString(), payload: { type: "thread_settings_applied" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  expect((await f.h.ports.durableTurnEvidence("codex", "/codex/stage-1.jsonl"))?.turn).toBe("busy");
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  let stops = 0;
  f.h.ports.stopInterruptedStageAgent = async () => { stops++; return { outcome: "stopped" }; };
  f.advance(IDLE_TURN_QUIET_MS + 3000);
  await withRuntimeSnapshot({ runtime: { hostEpoch: 7 }, sessions: [
    { conversationId: loadPipelines()[0]!.runs[0]!.attempts[0]!.conversationId, host: "hosted", turn: "idle", attentionIds: [] },
  ] }, async () => {
    const production = defaultPipelinePorts();
    const ports = { ...f.h.ports, conversationAgentActive: production.conversationAgentActive,
      conversationTurnInterrupted: production.conversationTurnInterrupted };
    await tickPipelines([], ports);
    await tickPipelines([], ports);
  });
  expect(stops).toBe(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends).toHaveLength(0);
});

test.each(["before", "during"].flatMap(timing => ["operator", "system", "unreadable", "operator-then-system"].flatMap(origin =>
  (origin === "unreadable" ? [false] : [false, true]).map(compacted => ({ timing, origin, compacted })))))
("restart recovery honors retained stop authority ($timing, $origin, compacted=$compacted)", async ({ timing, origin, compacted }) => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const at = f.now();
  const file = stageTranscript("restart-operator-stop", [
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
    { type: "event_msg", timestamp: new Date(at + 1000).toISOString(), payload: { type: "turn_aborted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  f.advance(3000);
  f.h.ports.conversationRestartCut = () => ({ recordedAt: f.h.ports.now() });
  const conversationId = loadPipelines()[0]!.runs[0]!.attempts[0]!.conversationId!;
  const filename = path.join(process.env.LLV_STATE_DIR!, `restart-stop-${timing}-${origin}-${compacted}.sqlite`);
  let journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
  let unreadable = false;
  const stop = () => {
    for (const killOrigin of origin === "operator-then-system" ? ["operator", "system"] : [origin]) {
      const operationId = `retained-stage-stop-${killOrigin}`;
      journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
        conversationId, sessionKey: { engine: "codex", sessionId: "stage-session" }, host: "hosted", turn: "idle",
        activeTurnId: null, writerClaim: "fixture-writer", attentionIds: [],
      } });
      journal.executeOperation({ kind: "kill", operationId, idempotencyKey: operationId, conversationId,
        sessionKey: { engine: "codex", sessionId: "stage-session" }, origin: { kind: killOrigin === "system" ? "agent" : "operator" },
        ...(killOrigin === "system" ? { onlyIfIdle: { revision: journal.readSession({ conversationId })!.revision, writerClaim: "fixture-writer" } } : {}) });
      journal.transitionOperation(operationId, "delivering");
      journal.transitionOperation(operationId, "delivered");
      if (compacted) {
        journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
          conversationId, sessionKey: { engine: "codex", sessionId: "stage-session" }, host: "dead", turn: "idle", activeTurnId: null,
        } });
        journal.compact(1);
        expect(journal.operationResult(operationId)).toBeNull();
      }
    }
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
    unreadable = origin === "unreadable";
  };
  const client = { effectBatch: async (kinds: string[], cursor: number) => {
    if (unreadable) throw new Error("stop authority temporarily unreadable");
    return journal.effectBatch(100, kinds, cursor);
  }, operationStatus: async (id: string) => journal.operationResult(id) };
  f.h.ports.conversationOperatorStopped = (id, since) => hasRuntimeSwitchKill(client as never, id, since, [], true);
  let stops = 0;
  f.h.ports.stopInterruptedStageAgent = async () => { stops++; if (timing === "during" && stops === 1) stop(); return { outcome: "stopped" }; };
  try {
    if (timing === "before") stop();
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(origin === "system" ? 2 : 1);
    expect(f.h.spawnInputs).toHaveLength(origin === "system" ? 2 : 1);
    expect(f.sends).toHaveLength(0);
    if (origin.startsWith("operator")) expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
    if (origin === "unreadable") {
      expect(loadPipelines()[0]!.stateDetail).toContain("waiting for durable operator-stop evidence");
      unreadable = false;
      await tickPipelines([], f.h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
    }
  } finally { journal.close(); }
});

test.each(["restart", "provider"].flatMap(recovery => [false, true].flatMap(operator =>
  (recovery === "provider" ? ["before", "admission", "pending-admission"] : ["before"]).map(timing => ({ recovery, operator, timing })))))
("composer interrupt fences autonomous stage recovery ($recovery, operator=$operator, $timing)", async ({ recovery, operator, timing }) => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const { dispatchStructuredControl } = await import("@/lib/runtime/structuredControls");
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const at = f.now();
  const key = { engine: "codex" as const, sessionId: crypto.randomUUID() };
  const file = stageTranscript(key.sessionId, [
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "agent_message", message: "Working on the stage" } },
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "turn_aborted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  const directory = fs.mkdtempSync(path.join(process.env.LLV_STATE_DIR!, "composer-stop-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: directory, transport: "structured", accountId: "account-a" });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, { key, artifactPath: file, cwd: directory, accountId: "account-a", status: "live", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "fake:composer-stop", process: captureProcessIdentity(process.pid),
      eventCursor: 1, protocolVersion: "test", writerClaimEpoch: 1, activeTurnRef: "notice-turn", pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: "structured-host:fixture", pendingAction: null });
  expect(settled.kind).toBe("settled");
  const conversationId = begun.receipt.conversationId;
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.conversationId = conversationId;
  savePipelines([lane]);
  f.advance(3000);
  const filename = path.join(directory, "journal.sqlite");
  let journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
  journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
    conversationId, sessionKey: key, host: "hosted", turn: "running", activeTurnId: "notice-turn", attentionIds: [],
  } });
  const client = { command: async command => journal.executeOperation(command),
    effectBatch: async (kinds: string[], cursor: number) => journal.effectBatch(100, kinds, cursor),
    operationStatus: async (id: string) => journal.operationResult(id) } as import("@/lib/runtime/client").RuntimeHostClient;
  f.h.ports.conversationOperatorStopped = (id, since, ignored) => hasRuntimeSwitchKill(client, id, since, ignored, true);
  let stopped = false;
  const interrupt = async () => {
    const result = await dispatchStructuredControl({ conversationId, path: file, action: "interrupt", operationId: "composer-stop",
      ...(operator ? {} : { actor: { kind: "agent" as const, conversationId } }) }, {
      registry, client, kick: () => {}, enabled: () => true, hostProcessAlive: () => true,
    });
    expect(result?.status).toBe(202);
    if (timing === "pending-admission") { stopped = true; return; }
    journal.transitionOperation("composer-stop", "delivering");
    journal.transitionOperation("composer-stop", "interrupted");
    fs.appendFileSync(file, [
      { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "user_message", message:
        encodeCodexStructuredUserText("Reviewer finished", undefined, null, { kind: "agent", role: "reviewer" }) } },
      { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started" } },
      { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "turn_aborted" } },
      { type: "response_item", timestamp: f.h.ports.now(), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Turn aborted" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["generic.turn_aborted"] } } },
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
    journal.append({ scope: { type: "session", id: conversationId }, kind: "delta", payload: { text: "later history" } });
    journal.compact(1);
    expect(journal.operationResult("composer-stop")).toBeNull();
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
    stopped = true;
  };
  f.h.ports.resumeSeveredTurn = async input => {
    if (!stopped) await interrupt();
    if (input.continuationAllowed && !await input.continuationAllowed()) return false;
    f.sends.push(input.clientMessageId);
    return true;
  };
  try {
    if (timing === "before") await interrupt();
    if (recovery === "restart") f.h.ports.conversationRestartCut = () => ({ recordedAt: f.h.ports.now() });
    f.advance(31_000);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    if (recovery === "provider" && !operator && f.sends.length === 0) {
      f.advance(31_000);
      await tickPipelines([], f.h.ports);
    }
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(recovery === "restart" && !operator ? 2 : 1);
    expect(f.sends).toHaveLength(recovery === "provider" && !operator ? 1 : 0);
    if (operator) expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
  } finally { journal.close(); }
});


test.each(["dead", "idle"].flatMap(host => ["turn_aborted", "usage_limit_exceeded"].map(errorClass => ({ host, errorClass }))))
("an unanswered authenticated notice recovers its interrupted host ($host, $errorClass)", async ({ host, errorClass }) => {
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const f = await providerRecoveryHarness("codex", errorClass, "stage turn aborted before completion");
  const at = f.now();
  const records = [
    { type: "event_msg", timestamp: new Date(at - 1000).toISOString(), payload: { type: "agent_message", message: "Working on the stage" } },
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "turn_aborted" } },
  ];
  if (errorClass === "usage_limit_exceeded") records[1] = providerQuotaRecord("codex", at) as typeof records[number];
  const file = stageTranscript("unanswered-agent-notice", records);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toBeDefined();
  f.advance(1000);
  const recordedAt = f.h.ports.now();
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  f.advance(1000);
  fs.appendFileSync(file, [
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "user_message", message:
      encodeCodexStructuredUserText("Reviewer finished", undefined, null, { kind: "agent", role: "reviewer" }) } },
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const evidence = await f.h.ports.durableTurnEvidence("codex", "/codex/stage-1.jsonl");
  expect(evidence).toMatchObject({ turn: "busy", automaticPromptAfterCut: true });
  f.h.ports.conversationTurnInterrupted = async () => host as "dead" | "idle";
  f.h.ports.stopInterruptedStageAgent = async () => ({ outcome: "stopped" });
  if (host === "idle") {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    f.advance(IDLE_TURN_QUIET_MS + 1000);
  }
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends).toHaveLength(0);
});

test.each(["before", "during"].flatMap(timing => ["kill", "pending-kill", "interrupt"].flatMap(control => ["operator", "agent"].map(origin => ({ timing, control, origin })))))
("a parked provider retry honors durable stop custody ($timing, $control, $origin)", async ({ timing, control, origin }) => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
  const conversationId = lane.runs[0]!.attempts[0]!.conversationId!;
  const filename = path.join(process.env.LLV_STATE_DIR!, `parked-stop-${crypto.randomUUID()}.sqlite`);
  let journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
  f.h.ports.conversationOperatorStopped = (id, since) => hasRuntimeSwitchKill({
    effectBatch: async (kinds, cursor) => journal.effectBatch(100, kinds, cursor),
    operationStatus: async id => journal.operationResult(id),
  } as import("@/lib/runtime/client").RuntimeHostClient, id, since, [], true);
  const stop = () => {
    journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
      conversationId, sessionKey: { engine: "codex", sessionId: "parked-stage" }, host: "hosted", turn: "idle", activeTurnId: null, attentionIds: [],
    } });
    journal.executeOperation(control !== "interrupt" ? { kind: "kill", operationId: "parked-stop", idempotencyKey: "parked-stop", conversationId,
      sessionKey: { engine: "codex", sessionId: "parked-stage" }, origin: { kind: origin as "operator" | "agent" } }
      : { kind: "interrupt", operationId: "parked-stop", idempotencyKey: "parked-stop", conversationId, origin: { kind: origin as "operator" | "agent" } });
    if (control === "kill") { journal.transitionOperation("parked-stop", "delivering"); journal.transitionOperation("parked-stop", "delivered"); }
    journal.append({ scope: { type: "session", id: conversationId }, kind: "delta", payload: { text: "later history" } });
    journal.compact(1);
    if (control !== "pending-kill") expect(journal.operationResult("parked-stop")).toBeNull();
    else expect(journal.operationResult("parked-stop")?.receipt.status).toBe("queued");
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
  };
  f.h.ports.stopStageAgent = async () => { if (timing === "during") stop(); return { outcome: "stopped" }; };
  try {
    if (timing === "before") stop();
    f.advance(181_000);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(origin === "operator" ? 1 : 2);
    expect(f.sends).toHaveLength(0);
    if (origin === "operator") expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toMatchObject({ retryCancelled: true });
  } finally { journal.close(); }
});

test("a parked retry survives temporarily unreadable operator-stop authority", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  const before = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry;
  expect(before).toBeDefined();
  f.h.ports.conversationOperatorStopped = async () => { throw new Error("temporary journal read failure"); };
  f.advance(181_000);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("waiting for durable operator-stop evidence");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toEqual(before);
  expect(f.h.spawnInputs).toHaveLength(1);
  f.h.ports.conversationOperatorStopped = async () => false;
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "codex", accountId: LIMITED_ACCOUNT,
    kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends).toHaveLength(0);
});

test("a delayed automatic host-death kill keeps recovery custody after compaction and restart", async () => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const f = await providerRecoveryHarness("codex", "host_death", "stage host died without output");
  // A confirmed host-death wait uses the relaunch path independently of turn interruption.
  f.h.ports.conversationTurnInterrupted = async () => null;
  const lane = loadPipelines()[0]!;
  const conversationId = lane.runs[0]!.attempts[0]!.conversationId!;
  lane.runs[0]!.attempts[0]!.providerWait = { condition: { kind: "host_death", label: "stage host died without output", scope: null, resetLabel: null },
    accountId: null, text: "stage host died without output", turnTs: f.now(), tries: 0, startedAt: f.h.ports.now(), resumeAt: f.h.ports.now(), resetsAt: null };
  savePipelines([lane]);
  const filename = path.join(process.env.LLV_STATE_DIR!, "delayed-auto-stop.sqlite");
  let journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
  journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
    conversationId, sessionKey: { engine: "codex", sessionId: "delayed-stage" }, host: "hosted", turn: "running", activeTurnId: "old-turn", attentionIds: [],
  } });
  f.h.ports.conversationOperatorStopped = (id, since) => hasRuntimeSwitchKill({
    effectBatch: async (kinds, cursor) => journal.effectBatch(100, kinds, cursor), operationStatus: async id => journal.operationResult(id),
  } as import("@/lib/runtime/client").RuntimeHostClient, id, since, [], true);
  let calls = 0;
  f.h.ports.stopStageAgent = async (_target, options) => {
    expect(options?.automatic).toBe(true);
    if (++calls === 1) {
      journal.executeOperation({ kind: "kill", operationId: "delayed-recovery-kill", idempotencyKey: "delayed-recovery-kill", conversationId,
        sessionKey: { engine: "codex", sessionId: "delayed-stage" }, origin: { kind: "agent", role: "pipeline" } });
      return { outcome: "unconfirmed", operationId: "delayed-recovery-kill", detail: "waiting for host confirmation" };
    }
    return { outcome: "not-running" };
  };
  try {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    journal.transitionOperation("delayed-recovery-kill", "delivering");
    journal.transitionOperation("delayed-recovery-kill", "delivered");
    journal.append({ scope: { type: "session", id: conversationId }, kind: "delta", payload: { text: "later history" } });
    journal.compact(1);
    expect(journal.operationResult("delayed-recovery-kill")).toBeNull();
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true, now: f.now });
    f.advance(31_000);
    await tickPipelines([], { ...f.h.ports, restartRecoveryBootId: () => "next-boot" });
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.sends).toHaveLength(0);
  } finally { journal.close(); }
});

test.each([false, true])("post-stop authority lookup fences a delivered prompt (operator=%s)", async operator => {
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const at = f.now();
  const file = stageTranscript("post-authority-prompt", [
    { type: "event_msg", timestamp: new Date(at - 1000).toISOString(), payload: { type: "agent_message", message: "Working on the stage" } },
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "turn_aborted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  f.advance(3000);
  const recordedAt = f.h.ports.now();
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  let stopped = false;
  let appended = false;
  f.h.ports.stopInterruptedStageAgent = async () => { stopped = true; return { outcome: "stopped" }; };
  f.h.ports.conversationOperatorStopped = async () => {
    if (stopped && !appended) {
      appended = true;
      fs.appendFileSync(file, JSON.stringify({ type: "event_msg", timestamp: recordedAt, payload: { type: "user_message", message: operator
        ? "Wait for my review" : encodeCodexStructuredUserText("Reviewer finished", undefined, null, { kind: "agent", role: "reviewer" }) } }) + "\n");
    }
    return false;
  };
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(operator ? 1 : 2);
  expect(f.sends).toHaveLength(0);
  if (operator) expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
});

test.each(["unavailable", "incomplete"].flatMap(evidence => ["busy", "abort"].flatMap(turn => [false, true].flatMap(operator =>
  (operator ? [0, 1000] : [0]).map(skew => ({ evidence, turn, operator, skew }))))))
("restart recovery retains its boundary until post-stop evidence is verified ($evidence, $turn, operator=$operator, skew=$skew)", async ({ evidence, turn, operator, skew }) => {
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const cut = f.now();
  const file = stageTranscript("restart-post-stop-evidence", [
    { type: "event_msg", timestamp: new Date(cut - 1000).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
    ...(turn === "abort" ? [{ type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "turn_aborted" } }] : []),
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  if (turn === "abort") await tickPipelines([], f.h.ports);
  const wait = structuredClone(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait);
  f.advance(3000);
  const recordedAt = f.h.ports.now();
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  const read = f.h.ports.durableTurnEvidence;
  let unverified = false;
  let stops = 0;
  f.h.ports.durableTurnEvidence = async (...args) => {
    const durable = await read(...args);
    return !unverified ? durable : evidence === "unavailable" ? null
      : { ...durable!, promptHistoryComplete: false, externalPromptAfterCut: undefined, prompts: [], promptCount: undefined, lastExternalPromptIndex: undefined };
  };
  f.h.ports.stopInterruptedStageAgent = async () => {
    if (++stops === 1) {
      if (operator) fs.appendFileSync(file, JSON.stringify({ type: "event_msg", timestamp: new Date(Date.parse(recordedAt) + skew).toISOString(),
        payload: { type: "user_message", message: "Wait for my review" } }) + "\n");
      unverified = true;
    }
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  const held = loadPipelines()[0]!.runs[0]!.attempts;
  expect(stops).toBe(1);
  expect(held).toHaveLength(1);
  expect(held[0]!.state).toBe("running");
  expect(held[0]!.providerWait).toEqual(wait);
  expect(held[0]!.restartRecovery?.stopped).toMatchObject({ restarted: true });
  expect(held[0]!.restartRecovery?.promptBoundary).toBe(0);
  expect(f.sends).toHaveLength(0);
  // Recovery retries the read without losing the wait or the confirmed stop.
  unverified = false;
  f.h.ports.restartRecoveryBootId = () => "boot-after-uncertain-evidence";
  f.h.ports.conversationTurnInterrupted = async () => "dead";
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(operator ? 1 : 2);
  expect(f.h.spawnInputs).toHaveLength(operator ? 1 : 2);
  expect(f.sends).toHaveLength(0);
});

test.each((["codex", "claude"] as const).flatMap(engine => (["busy", "abort"] as const).flatMap(turn =>
  [200_000, 9 * 1024 * 1024].flatMap(bytes => [false, true].map(operator => ({ engine, turn, bytes, operator }))))))
("restart recovery verifies long native history without a saved wait ($engine, $turn, bytes=$bytes, operator=$operator)", async ({ engine, turn, bytes, operator }) => {
  const f = await providerRecoveryHarness(engine, "turn_aborted", "stage turn aborted before completion");
  const at = f.now();
  const records: Record<string, unknown>[] = engine === "codex" ? [
    { type: "event_msg", timestamp: new Date(at).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
  ] : [{ type: "assistant", timestamp: new Date(at).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Checking the stage" }] } }];
  records.unshift(engine === "codex"
    ? { type: "event_msg", timestamp: new Date(at - 1000).toISOString(), payload: { type: "user_message", message: "Review the earlier change" } }
    : { type: "user", timestamp: new Date(at - 1000).toISOString(), message: { role: "user", content: "Review the earlier change" } });
  records.push({ type: "queue-operation", timestamp: new Date(at).toISOString(), padding: "x".repeat(bytes) });
  if (turn === "abort") records.push(engine === "codex"
    ? { type: "event_msg", timestamp: new Date(at + 1000).toISOString(), payload: { type: "turn_aborted" } }
    : { type: "user", timestamp: new Date(at + 1000).toISOString(), interruptedByShutdown: true, message: { role: "user", content: "[Request interrupted by user]" } });
  const file = stageTranscript("long-restart-history", records);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  f.advance(3000);
  const recordedAt = f.h.ports.now();
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  let stops = 0;
  f.h.ports.stopInterruptedStageAgent = async () => {
    if (++stops === 1 && operator) fs.appendFileSync(file, JSON.stringify(engine === "codex"
      ? { type: "event_msg", timestamp: recordedAt, payload: { type: "user_message", message: "Wait for my review" } }
      : { type: "user", timestamp: recordedAt, message: { role: "user", content: "Wait for my review" } }) + "\n");
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  expect(stops).toBe(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(operator ? 1 : 2);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(operator ? 1 : 2);
  expect(f.h.spawnInputs).toHaveLength(operator ? 1 : 2);
  expect(f.sends).toHaveLength(0);
  if (operator && turn === "busy") expect(loadPipelines()[0]!.stateDetail).toContain("cancelled after newer stage activity");
});

test.each(["codex", "claude"] as const)("%s work after an old restart keeps provider recovery after a large historical prefix", async engine => {
  const f = await providerRecoveryHarness(engine, "turn_aborted", "stage turn aborted before completion");
  const at = f.now();
  const file = stageTranscript("restart-streamed-progress", [
    { type: "queue-operation", timestamp: new Date(at).toISOString(), padding: "x".repeat(9 * 1024 * 1024) },
    engine === "codex"
      ? { type: "event_msg", timestamp: new Date(at + 2000).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } }
      : { type: "assistant", timestamp: new Date(at + 2000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Checking the stage" }] } },
    engine === "codex"
      ? { type: "event_msg", timestamp: new Date(at + 3000).toISOString(), payload: { type: "turn_aborted" } }
      : { type: "user", timestamp: new Date(at + 3000).toISOString(), interruptedByShutdown: true, message: { role: "user", content: "[Request interrupted by user]" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  f.h.ports.conversationRestartCut = () => ({ recordedAt: new Date(at + 1000).toISOString() });
  let stops = 0;
  f.h.ports.stopInterruptedStageAgent = async () => { stops++; return { outcome: "stopped" }; };
  f.advance(5000);
  await tickPipelines([], f.h.ports);
  expect(stops).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.condition.kind).toBe("turn_cut");
  f.advance(31_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("a reviewer completion notice after a deploy abort keeps provider recovery automatic", async () => {
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  const cut = f.now();
  const file = stageTranscript("deploy-reviewer-notice", [
    { type: "event_msg", timestamp: new Date(cut - 1000).toISOString(), payload: { type: "agent_message", message: "Checking the stage" } },
    { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "turn_aborted", reason: "interrupted" } },
  ]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.condition.kind).toBe("turn_cut");
  f.advance(52_000);
  const text = encodeCodexStructuredUserText("Agent finished: review interrupted", undefined, null, { kind: "agent", role: "reviewer" });
  fs.appendFileSync(file, [
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started" } },
    { type: "response_item", timestamp: f.h.ports.now(), payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  f.h.setConversationActive(true);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).not.toBe(true);
  expect(loadPipelines()[0]!.state).toBe("running");
  // The notice resumed the turn; its eventual stage report still settles it.
  f.advance(1000);
  fs.appendFileSync(file, [
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "agent_message", message: "```json\n{\"status\":\"pass\"}\n```" } },
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
});

test.each(["automatic", "operator-before", "operator-during", "operator-stop", "report", "newer-work"] as const)
("a recorded deploy cut owns a genuinely parked provider retry (%s)", async activity => {
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000, true);
  f.h.ports.conversationOperatorStopped = async () => false;
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  const quotaAt = f.now();
  const file = stageTranscript("parked-deploy-cut", [providerQuotaRecord("codex", quotaAt)]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.runs[0]!.attempts[0]!.state).toBe("needs_decision");
  expect(parked.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
  f.advance(1_000);
  const automatic = encodeCodexStructuredUserText("Review completed", undefined, null, { kind: "agent", role: "reviewer" });
  const append = (type: string, extra: Record<string, unknown> = {}) => fs.appendFileSync(file,
    JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(), payload: { type, ...extra } }) + "\n");
  append("user_message", { message: automatic });
  append("task_started");
  const recordedAt = f.h.ports.now();
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  if (activity === "operator-before") append("user_message", { message: "Wait for my review" });
  if (activity === "newer-work") { f.advance(1_000); append("agent_message", { message: "Continuing the stage" }); }
  append("turn_aborted");
  if (activity === "operator-stop") f.h.ports.conversationOperatorStopped = async () => true;
  if (activity === "report") {
    parked.runs[0]!.attempts[0]!.report = recoveryReport(f.h.ports.now());
    savePipelines([parked]);
  }
  f.h.setConversationActive(false);
  f.h.ports.stopInterruptedStageAgent = async () => {
    if (activity === "operator-during") append("user_message", { message: "Wait for my review" });
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  const after = loadPipelines()[0]!;
  if (activity === "report") expect(after.runs[0]!.attempts[0]!.state).toBe("passed");
  else expect(after.runs[0]!.attempts).toHaveLength(activity === "automatic" ? 2 : 1);
  if (activity === "automatic") {
    expect(after.runs[0]!.attempts[1]!.restartContext?.cause).toBe("restart");
    expect(f.now()).toBeLessThan(f.resetsAt! * 1_000);
  }
  expect(f.sends).toHaveLength(0);
});

test.each(["turn_cut", "auth_required", "quota-fallback", "transient"].flatMap(kind =>
  ["automatic", "work", "operator", "operator-work", "operator-during", "stop", "pause", "report", "unreadable", "late-message"].map(activity => ({ kind, activity }))))
("a recorded deploy cut recovers an unscheduled provider park ($kind, $activity)", async ({ kind, activity }) => {
  const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText.server");
  const code = kind === "auth_required" ? "unauthorized" : kind === "quota-fallback" ? "usage_limit_exceeded" : kind === "transient" ? "other" : "turn_aborted";
  const text = kind === "auth_required" ? "Authentication required" : kind === "quota-fallback" ? "You've hit your usage limit"
    : kind === "transient" ? "Selected model is at capacity. Please try a different model." : "stage turn aborted before completion";
  const f = await providerRecoveryHarness("codex", code, text, null, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  if (kind === "quota-fallback") lane.runs[0]!.attempts[0]!.providerFallbackRetries = 1;
  savePipelines([lane]);
  const file = stageTranscript("unscheduled-park-deploy", [{ type: "event_msg", timestamp: f.h.ports.now(),
    payload: { type: "task_complete", error: { message: text, codex_error_info: code } } }]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
  f.advance(1_000);
  const prompt = activity.startsWith("operator") && activity !== "operator-during" ? "Wait for my review"
    : encodeCodexStructuredUserText("Review completed", undefined, null, { kind: "agent", role: "reviewer" });
  const append = (type: string, extra: Record<string, unknown> = {}) => fs.appendFileSync(file,
    JSON.stringify({ type: "event_msg", timestamp: f.h.ports.now(), payload: { type, ...extra } }) + "\n");
  append("user_message", { message: prompt });
  append("task_started");
  if (activity.endsWith("work")) { f.advance(1_000); append("agent_message", { message: "Working on the stage" }); }
  f.advance(1_000);
  const recordedAt = f.h.ports.now();
  append("turn_aborted");
  if (activity === "report") { parked.runs[0]!.attempts[0]!.report = recoveryReport(recordedAt); savePipelines([parked]); }
  if (activity === "pause") {
    await patchPipeline(parked.id, { action: "pause" }, f.h.ports);
    await patchPipeline(parked.id, { action: "resume" }, f.h.ports);
  }
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  let unreadable = activity === "unreadable";
  let readBoundary = false;
  let late = activity === "late-message";
  const read = f.h.ports.durableTurnEvidence;
  f.h.ports.durableTurnEvidence = async (...args) => { const evidence = await read(...args); readBoundary = true; return evidence; };
  f.h.ports.conversationOperatorStopped = async () => {
    if (unreadable) throw new Error("operator-stop journal unavailable");
    if (late && readBoundary) { late = false; append("user_message", { message: "Wait for my review" }); }
    return activity === "stop";
  };
  f.h.setConversationActive(false);
  f.h.ports.stopInterruptedStageAgent = async () => {
    if (activity === "operator-during") append("user_message", { message: "Wait for my review" });
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  if (unreadable) { expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1); unreadable = false; }
  for (let tick = 0; tick < 3; tick++) await tickPipelines([], f.h.ports);
  const after = loadPipelines()[0]!;
  if (activity === "report") expect(after.runs[0]!.attempts[0]!.state).toBe("passed");
  else expect(after.runs[0]!.attempts).toHaveLength(["automatic", "work", "unreadable"].includes(activity) ? 2 : 1);
  expect(f.sends).toHaveLength(0);
});

test.each(["turn_cut", "host_death", "transient", "usage_limit", "auth_required"] as const)("a recorded restart owns its replacement over a persisted %s wait", async kind => {
  const f = await providerRecoveryHarness("codex", "turn_aborted", "stage turn aborted before completion");
  await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.providerWait!.condition.kind = kind;
  savePipelines([lane]);
  const recordedAt = f.h.ports.now();
  const beforeCut = f.now() - 1;
  f.h.durableTurns.set(attempt.agentPath!, { turn: "terminal", message: null, lastRecordAt: beforeCut,
    lastAgentEventAt: beforeCut, terminalProviderMessage: { text: "stage turn aborted before completion", errorClass: "turn_aborted", ts: beforeCut } });
  f.h.ports.conversationRestartCut = () => ({ recordedAt });
  await tickPipelines([], f.h.ports);
  const recovered = loadPipelines()[0]!;
  expect(recovered.state).toBe("running");
  expect(recovered.runs[0]!.attempts).toHaveLength(2);
  expect(recovered.runs[0]!.attempts[1]!.restartContext).toMatchObject({ cause: "restart", previousAttempt: 1 });
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends).toHaveLength(0);
});

for (const engine of ["claude", "codex"] as const) {
  test.each(["auth", "auth-window", "capacity"] as const)(`${engine} successor %s cut retains the source reset retry`, async cause => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded",
      "You've hit your session limit", 60 * 60_000);
    const unavailable: string[][] = [];
    f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
    f.h.ports.claudeAccountReset = id => id === LIMITED_ACCOUNT ? f.resetsAt : null;
    f.h.ports.resolveProjectSpawn = (_engine, request) => {
      unavailable.push(request.unavailableIds ?? []);
      const target = [SPARE_ACCOUNT, LIMITED_ACCOUNT].find(id => !request.unavailableIds?.includes(id));
      return target ? { kind: "available", account: { engine, accountId: target, kind: "managed",
        home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: null, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] };
    };
    const baseSpawn = f.h.ports.spawnAgent;
    f.h.ports.spawnAgent = async (input, reserved) => ({ ...await baseSpawn(input, reserved), paneId: null });
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
    f.advance(60_000);
    const lane = loadPipelines()[0]!;
    const spare = lane.runs[0]!.attempts.at(-1)!;
    // Exhaust the bounded transient continuations on the target.
    if (cause === "capacity") {
      spare.providerRecoveryBudget!.tries = 3;
      savePipelines([lane]);
    }
    if (cause === "auth-window") {
      // Earlier quota evidence must never make an authentication failure reusable.
      spare.usageLimitedAccounts!.push({ accountId: SPARE_ACCOUNT, engine, resetsAt: Math.floor((f.now() + 10 * 60_000) / 1_000),
        limitedAt: f.now() - 30_000, turnId: "earlier-spare-window" });
      savePipelines([lane]);
    }
    f.h.setConversationActive(false);
    f.h.durableTurns.set(spare.agentPath!, { turn: "terminal", message: null, terminalProviderMessage: {
      ts: f.now(), errorClass: cause !== "capacity" ? engine === "claude" ? "authentication_failed" : "unauthorized"
        : engine === "claude" ? "overloaded" : "other",
      text: cause !== "capacity" ? "OAuth session expired and could not be refreshed" : "Selected model is at capacity. Please try a different model.",
    } });
    await tickPipelines([], f.h.ports);
    const parked = loadPipelines()[0]!;
    expect(parked.state).toBe("needs_decision");
    expect(parked.runs[0]!.attempts.at(-1)!.providerWait).toMatchObject({
      resumeAt: new Date(f.resetsAt! * 1_000 + 60_000).toISOString(), stageRetry: { fallback: false },
    });
    expect(parked.stateDetail).toMatch(/Automatic retry|Автоповтор/);
    while (f.now() < f.resetsAt! * 1_000 + 60_000) {
      f.advance(30_000);
      await tickPipelines([], f.h.ports);
    }
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(3);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.accountId).toBe(LIMITED_ACCOUNT);
    expect(f.h.spawnInputs[2]!.unavailableAccountIds).toContain(SPARE_ACCOUNT);
    expect(unavailable.at(-1)).toContain(SPARE_ACCOUNT);
    expect(f.now()).toBeLessThanOrEqual(f.resetsAt! * 1_000 + 2 * 60_000);
  });
}

test.each([false, true])("provider waiting schedules one wake per horizon, parked=%s", async parked => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 6 * 60 * 60_000, true);
  const scheduled: number[] = [];
  f.h.ports.scheduleTick = delay => { scheduled.push(delay); };
  if (parked) {
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
    savePipelines([lane]);
  }
  await tickPipelines([], f.h.ports);
  for (let tick = 0; tick < 10; tick++) {
    f.advance(30_000);
    await tickPipelines([], f.h.ports);
  }
  expect(scheduled).toEqual([15 * 60_000]);
  f.advance(10 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(scheduled).toEqual([15 * 60_000, 15 * 60_000]);
});

test("parked provider waiting keeps controller cycles within watchdog plus horizon wakes", async () => {
  const { FlowPipelineController } = await import("./controller");
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 6 * 60 * 60_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  const wakeups: number[] = [];
  let scheduled = 0;
  let cycles = 0;
  let passes = 0;
  f.h.ports.scheduleTick = delay => { scheduled++; wakeups.push(f.now() + delay); };
  const controller = new FlowPipelineController({
    now: f.now,
    tickPipelines: async entries => { passes++; return await tickPipelines(entries, f.h.ports); },
    tickFlows: async () => ({ changed: false }),
    publishHeartbeat: heartbeat => { cycles = Math.max(cycles, heartbeat.cycle); },
  });
  await controller.tick("startup");
  const until = f.now() + 5.5 * 60 * 60_000;
  let watchdog = f.now() + 30_000;
  while (f.now() < until) {
    wakeups.sort((a, b) => a - b);
    const next = Math.min(watchdog, wakeups[0] ?? Infinity);
    f.advance(next - f.now());
    if (next === watchdog) {
      watchdog += 30_000;
      await controller.tick("watchdog");
    } else {
      wakeups.shift();
      await controller.tick("signal");
    }
  }
  expect(scheduled).toBeLessThanOrEqual(24);
  expect(cycles).toBeLessThanOrEqual(660 + 30);
  expect(passes).toBeLessThanOrEqual(2 * (660 + 30) + 8);
  expect(f.h.spawnInputs).toHaveLength(1);
  // Restart has no in-memory timers. Its watchdog still retries durably on time.
  wakeups.length = 0;
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT,
    kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
  const restarted = { ...f.h.ports, scheduleTick: () => {} };
  f.advance(f.resetsAt! * 1_000 + 59_000 - f.now());
  await tickPipelines([], restarted);
  expect(f.h.spawnInputs).toHaveLength(1);
  f.advance(30_000);
  await tickPipelines([], restarted);
  await tickPipelines([], restarted);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(LIMITED_ACCOUNT);
  expect(f.now()).toBeLessThanOrEqual(f.resetsAt! * 1_000 + 90_000);
}, 60_000);

test.each([false, true])("a newer native operator turn cancels running reset continuation, tool=%s", async tool => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", null, true);
  f.advance(Date.parse("2026-10-05T18:30:00Z") - f.now());
  const records = [{ type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your session limit · resets 10pm (Europe/Kyiv)" }] } }];
  const transcript = stageTranscript("running-reset-operator-answer", records);
  readFixtures(f.h, { "/codex/stage-1.jsonl": transcript });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.resumeAt).toBe("2026-10-05T19:01:00.000Z");
  fs.appendFileSync(transcript, JSON.stringify({ type: "user", timestamp: "2026-10-05T19:00:20Z",
    message: { role: "user", content: "Continue the stage" } }) + "\n");
  if (tool) fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: "2026-10-05T19:00:25Z",
    message: { role: "assistant", stop_reason: null, content: [{ type: "tool_use", id: "operator-tool", name: "Read", input: {} }] } }) + "\n");
  f.h.setConversationActive(true);
  f.advance(Date.parse("2026-10-05T19:01:05Z") - f.now());
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
  fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", timestamp: f.h.ports.now(),
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: PASS_TEXT }] } }) + "\n");
  f.h.setConversationActive(false);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
});

// A reset crossed after the cut opens one new account window in the chain.
for (const engine of ["claude", "codex"] as const) {
  test.each([
    [15_000, 6 * 24 * 60 * 60_000],
    [2 * 60 * 60_000, 6 * 24 * 60 * 60_000],
    [15_000, -120_000],
  ])(`${engine} reset recovery chooses the source window (cut delay %i ms, spare reset %i ms)`, async (spareCutDelay, spareResetDelay) => {
    const errorClass = engine === "claude" ? "rate_limit" : "usage_limit_exceeded";
    const f = await providerRecoveryHarness(engine, errorClass, "You've hit your session limit", 60 * 60_000);
    const sourceResume = f.resetsAt! * 1_000 + 60_000;
    f.h.ports.claudeAccountReset = id => id === LIMITED_ACCOUNT ? f.resetsAt : null;
    f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
    f.h.ports.resolveProjectSpawn = (_engine, input) => {
      const target = [SPARE_ACCOUNT, LIMITED_ACCOUNT].find(id => !input.unavailableIds?.includes(id));
      return target ? { kind: "available", account: { engine, accountId: target, kind: "managed",
        home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: null, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] };
    };
    const baseSpawn = f.h.ports.spawnAgent;
    f.h.ports.spawnAgent = async (input, reserved) => ({ ...await baseSpawn(input, reserved), paneId: null });
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
    f.advance(spareCutDelay);
    const cutAt = f.now();
    const spare = loadPipelines()[0]!.runs[0]!.attempts[1]!;
    f.h.durableTurns.set(spare.agentPath!, { turn: "terminal", message: null,
      terminalProviderMessage: { text: "You've hit your session limit", errorClass, ts: cutAt,
        usageLimit: { resetsAt: Math.floor((cutAt + spareResetDelay) / 1_000) } } });
    f.h.setConversationActive(false);
    await tickPipelines([], f.h.ports);
    if (cutAt < sourceResume) {
      const waiting = loadPipelines()[0]!;
      expect(waiting.state).toBe("needs_decision");
      expect(waiting.runs[0]!.attempts.at(-1)!.providerWait).toMatchObject({
        resumeAt: new Date(sourceResume).toISOString(), stageRetry: { fallback: false },
      });
    }
    const deadline = Math.max(sourceResume, cutAt) + 2 * 60_000;
    while (f.now() <= deadline && f.h.spawnInputs.length < 3) {
      f.advance(60_000);
      await tickPipelines([], f.h.ports);
    }
    expect(f.h.spawnInputs).toHaveLength(3);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.accountId).toBe(LIMITED_ACCOUNT);
    expect(f.now()).toBeLessThanOrEqual(deadline);
    // A repeated cut naming the same elapsed reset cannot reopen this window.
    f.advance(1_000);
    const recovered = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    f.h.durableTurns.set(recovered.agentPath!, { turn: "terminal", message: null,
      terminalProviderMessage: { text: "You've hit your session limit", errorClass, ts: f.now(),
        usageLimit: { resetsAt: f.resetsAt } } });
    f.h.setConversationActive(false);
    for (let minute = 0; minute < 20; minute++) {
      await tickPipelines([], f.h.ports);
      f.advance(60_000);
    }
    expect(f.h.spawnInputs).toHaveLength(3);
  });

  for (const pinned of [false, true]) {
    test.each(["pane", "host-death"] as const)(`${engine} source reset relaunches %s with pinned=${pinned} without capacity probes`, async path => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded",
        "You've hit your session limit", 120_000, pinned);
      f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT];
      f.h.ports.resolveProjectSpawn = (_engine, input) => {
        const selection = selectProjectAccount({ engine, project: loadPipelines()[0]!.project,
          bindings: [{ project: loadPipelines()[0]!.project, engine, accountId: LIMITED_ACCOUNT, createdAt: f.h.ports.now() }],
          accounts: [{ id: LIMITED_ACCOUNT, authPresent: true }], observations: [], now: f.now(),
          requestedId: input.requestedId, unavailableIds: input.unavailableIds });
        return selection.kind === "available" ? { kind: "available", account: { engine, accountId: selection.accountId!,
          kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } }
          : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] };
      };
      if (path === "pane") {
        const lane = loadPipelines()[0]!;
        lane.runs[0]!.attempts[0]!.paneId = "%1";
        savePipelines([lane]);
        f.h.setPaneAlive(false);
      }
      for (let minute = 0; minute < 8 && f.h.spawnInputs.length < 2; minute++) {
        await tickPipelines([], f.h.ports);
        if (path === "host-death" && f.sends.length) {
          f.h.durableTurns.delete("/codex/stage-1.jsonl");
          f.h.ports.conversationTurnInterrupted = async () => "dead";
          f.h.setConversationActive(false);
        }
        f.advance(60_000);
      }
      expect(f.h.spawnInputs).toHaveLength(2);
      expect(f.now()).toBeLessThanOrEqual(f.resetsAt! * 1_000 + 60_000 + (path === "pane" ? 2 : 4) * 60_000);
      if (pinned) expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(LIMITED_ACCOUNT);
      expect(f.h.spawnInputs[1]!.unavailableAccountIds).not.toContain(LIMITED_ACCOUNT);
      const retry = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
      expect(retry.providerWait?.capacityProbes ?? 0).toBe(0);
      expect(retry.providerFallbackRetries ?? 0).toBe(0);
      if (path === "host-death") expect(f.sends).toHaveLength(1);
    });
  }
}

// Recovery regressions exercise durable controller ticks without provider calls.
test.each(["claude", "codex"] as const)("limit recovery probes each allowed %s account once despite elapsed resets", async engine => {
  const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", engine === "claude" ? 2 * 60 * 60_000 : -120_000);
  f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
  f.h.ports.resolveProjectSpawn = (_engine, request) => {
    const target = [SPARE_ACCOUNT, LIMITED_ACCOUNT].find(id => !request.unavailableIds?.includes(id));
    return target ? { kind: "available", account: { engine, accountId: target, kind: "managed", home: "/account-b", transcriptRoot: "/account-b/sessions", env: { NODE_ENV: "test" } } }
      : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] };
  };
  const reseats: string[] = [];
  f.h.ports.requestConversationReseat = async (_id, target) => { reseats.push(target); };
  f.h.ports.conversationMigration = () => ({ targetId: SPARE_ACCOUNT, retry: true });
  const baseSpawn = f.h.ports.spawnAgent;
  f.h.ports.spawnAgent = async (input, reserved) => {
    expect(input.unavailableAccountIds ?? []).not.toContain(input.requestedAccountId!);
    return { ...await baseSpawn(input, reserved), paneId: null };
  };
  for (let n = 0; n < (engine === "claude" ? 240 : 40); n++) {
    const a = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    if (a.agentPath && loadPipelines()[0]!.state === "running") f.h.durableTurns.set(a.agentPath, { turn: "terminal", message: null,
      terminalProviderMessage: { text: "You've hit your session limit", errorClass: engine === "claude" ? "rate_limit" : "usage_limit_exceeded", ts: f.now(), usageLimit: { resetsAt: f.resetsAt } } });
    f.h.setConversationActive(false);
    await tickPipelines([], f.h.ports);
    f.advance(engine === "claude" ? 15_000 : 5_000);
  }
  const lane = loadPipelines()[0]!;
  expect(lane.state).toBe("needs_decision");
  expect(lane.runs[0]!.attempts.at(-1)!.providerWait?.stageRetry).toBeDefined();
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
  expect(reseats).toEqual([]);
  expect(f.sends).toHaveLength(0);
}, 60_000);

test.each([null, -120_000])("missing or elapsed reset=%s automatic stage retries stop within a 72-hour cut chain", async resetDelay => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", resetDelay, true);
  const baseSpawn = f.h.ports.spawnAgent;
  f.h.ports.spawnAgent = async (input, reserved) => ({ ...await baseSpawn(input, reserved), paneId: null });
  const until = f.now() + 72 * 60 * 60_000;
  for (let minute = 0; minute < 72 * 60; minute++) {
    const a = loadPipelines()[0]!.runs[0]!.attempts.at(-1)!;
    if (a.agentPath && loadPipelines()[0]!.state === "running") f.h.durableTurns.set(a.agentPath, { turn: "terminal", message: null,
      terminalProviderMessage: { text: "You've hit your session limit", errorClass: "rate_limit", ts: f.now(), usageLimit: { resetsAt: f.resetsAt } } });
    f.h.setConversationActive(false);
    await tickPipelines([], { ...f.h.ports });
    f.advance(60_000);
    const lane = loadPipelines()[0]!;
    if (lane.state === "needs_decision" && !lane.runs[0]!.attempts.at(-1)!.providerWait?.stageRetry) break;
  }
  f.advance(until - f.now());
  await tickPipelines([], { ...f.h.ports });
  await tickPipelines([], { ...f.h.ports });
  const lane = loadPipelines()[0]!;
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.sends.length).toBeLessThanOrEqual(6);
  expect(lane.state).toBe("needs_decision");
  expect(lane.runs[0]!.attempts.at(-1)!.providerWait?.stageRetry).toBeUndefined();
  expect(lane.stateDetail).toContain(resetDelay === null ? "unknown-reset retry exhausted" : "elapsed-reset retry exhausted");
}, 60_000);

test.each(["pause-resume", "report"] as const)("cancelled quota retry withdraws its card promise after %s", async action => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  lane.taskIds = ["cancelled-retry-task"];
  saveTasks([{ id: "cancelled-retry-task", project: lane.project, text: "Recover stage", status: "assigned", placement: "unplaced", assignments: [], createdAt: lane.createdAt, updatedAt: lane.createdAt }]);
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  if (action === "pause-resume") {
    await patchPipeline(lane.id, { action: "pause" }, f.h.ports);
    await patchPipeline(lane.id, { action: "resume" }, f.h.ports);
  } else {
    const reported = loadPipelines()[0]!;
    reported.runs[0]!.attempts[0]!.report = recoveryReport(f.h.ports.now());
    savePipelines([reported]);
  }
  f.advance(24 * 60 * 60_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.providerWait?.stageRetry).toBeUndefined();
  expect(loadTasks()[0]!.note?.text).not.toMatch(/Automatic retry|Автоповтор|automatically/);
  expect(attempt.error).not.toMatch(/Automatic retry|Автоповтор|automatically/);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test.each(["deferred", "unresolved"] as const)("parked quota retry bounds its %s host stop", async outcome => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  let stops = 0;
  f.h.ports.stopStageAgent = async () => { stops++; return outcome === "deferred" ? { outcome: "deferred" }
    : { outcome: "unresolved", error: "host ownership unknown", survivors: [] }; };
  f.advance(180_000);
  const until = f.now() + 24 * 60 * 60_000;
  for (let tick = 0; tick < 2880; tick++) {
    await tickPipelines([], f.h.ports);
    f.advance(30_000);
    if (!loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry) break;
  }
  f.advance(until - f.now());
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(stops).toBeLessThanOrEqual(21);
  expect(attempt.providerWait?.stageRetry).toBeUndefined();
  expect(attempt.error).toContain("host");
  expect(attempt.error).not.toMatch(/Automatic retry|Автоповтор|automatically/);
  expect(f.h.spawnInputs).toHaveLength(1);
}, 60_000);

test.each(["claude", "codex"] as const)("an exhausted %s cut tries a stale allowed spare before parking", async (engine) => {
  const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded",
    "You've hit your session limit", 120_000);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  const stale: DurableQuotaObservation = {
    engine, accountId: SPARE_ACCOUNT, authenticated: true,
    authCheckedAt: new Date(f.now() - 6 * 60_000).toISOString(),
    observedAt: new Date(f.now() - 6 * 60_000).toISOString(), bootId: "stale-spare",
    limits: { session: { usedPercent: 5, resetsAt: null }, weekly: null, plan: "max", capturedAt: f.now() / 1_000 },
    provenance: { source: "live", reason: null, staleSince: null },
  };
  f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
  f.h.ports.resolveProjectSpawn = (_engine, request) => {
    const selected = selectProjectAccount({ ...request, engine, now: f.now(),
      accounts: [LIMITED_ACCOUNT, SPARE_ACCOUNT, "outside-pool"].map(id => ({ id, authPresent: true })),
      bindings: [LIMITED_ACCOUNT, SPARE_ACCOUNT].map(accountId => ({ engine, accountId, project: lane.project, createdAt: f.h.ports.now() })),
      observations: [stale],
    });
    return selected.kind === "available"
      ? { kind: "available", account: { engine, kind: "managed", accountId: selected.accountId!, label: "account B", home: "/account-b", transcriptRoot: "/account-b/sessions", env: { NODE_ENV: "test" } } }
      : selected;
  };
  const reseats: string[] = [];
  f.h.ports.requestConversationReseat = async (_id, target) => { reseats.push(target); };
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  await tickPipelines([], f.h.ports);
  expect(reseats).toEqual([]);
  expect(f.sends).toHaveLength(0);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
});

test.each(["none", "failed", "delivered", "pending"] as const)("an exhausted provider limit retries the stage after its native reset across a Viewer restart (delivery=%s)", async delivery => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", null, true);
  f.advance(Date.parse("2026-10-05T18:30:00Z") - f.now());
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  const file = stageTranscript("exhausted-native-reset", [{
    type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your session limit · resets 10pm (Europe/Kyiv)" }] },
  }]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("Автоповтор");
  // Fresh port object and a reloaded durable store have no process-local timer.
  const restarted: PipelinePorts = { ...f.h.ports,
    resolveProjectSpawn: (_engine, input) =>
      input.requestedId === LIMITED_ACCOUNT && !input.unavailableIds?.includes(LIMITED_ACCOUNT)
        ? { kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT, kind: "managed",
          home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] },
  };
  f.advance(Date.parse("2026-10-05T19:00:59Z") - f.now());
  await tickPipelines([], restarted);
  expect(f.h.spawnInputs).toHaveLength(1);
  let outstanding = delivery !== "none";
  restarted.conversationDeliveryOutstanding = () => outstanding;
  f.advance(1_000);
  await tickPipelines([], restarted);
  if (outstanding) {
    for (let tick = 0; tick < 4; tick++) {
      f.advance(30_000);
      await tickPipelines([], restarted);
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    }
    if (delivery === "delivered") {
      fs.appendFileSync(file, JSON.stringify({ type: "user", timestamp: f.h.ports.now(),
        message: { content: "Wait for my review" } }) + "\n");
    }
    if (delivery === "pending") f.advance(11 * 60_000);
    else outstanding = false;
    f.advance(30_000);
    await tickPipelines([], restarted);
    if (delivery === "delivered" || delivery === "pending") {
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
      return;
    }
  }
  await tickPipelines([], restarted);
  const retried = loadPipelines()[0]!;
  expect(retried.runs[0]!.attempts).toHaveLength(2);
  expect(retried.runs[0]!.attempts[1]!.providerRecoveryBudget).toMatchObject({ tries: 0, triedAccounts: [LIMITED_ACCOUNT] });
  expect(retried.runs[0]!.attempts[1]!.input).toBe(lane.runs[0]!.attempts[0]!.input);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(LIMITED_ACCOUNT);
  expect(f.sends).toHaveLength(0);
  expect(f.h.calls.some(call => /reset --hard|clean -/.test(call))).toBe(false);
});

test.each(["close", "pause", "pause-resume", "reply", "report", "retry-stage", "skip-stage"] as const)("operator %s cancels a parked quota retry", async (action) => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
  if (action === "reply") {
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() + 1 });
    f.h.setConversationActive(true);
  } else if (action === "report") {
    const reported = loadPipelines()[0]!;
    reported.runs[0]!.attempts[0]!.report = recoveryReport(f.h.ports.now());
    savePipelines([reported]);
  } else {
    if (action === "retry-stage") {
      f.h.ports.spawnReceiptState = () => "completed";
      f.h.ports.spawnReceipt = id => ({ state: "completed", launchId: id, conversationId: "conversation_stage_1" }) as NonNullable<ReturnType<PipelinePorts["spawnReceipt"]>>;
    }
    const result = await patchPipeline(lane.id, { action: action === "pause-resume" ? "pause" : action }, f.h.ports);
    expect(result.error).toBeUndefined();
    if (action === "pause-resume") expect((await patchPipeline(lane.id, { action: "resume" }, f.h.ports)).error).toBeUndefined();
    await tickPipelines([], f.h.ports);
  }
  const before = f.h.spawnInputs.length;
  f.advance(180_000);
  await tickPipelines([], { ...f.h.ports });
  await tickPipelines([], { ...f.h.ports });
  expect(f.h.spawnInputs).toHaveLength(before);
  expect(f.sends).toHaveLength(0);
});

test("a parked unknown-reset limit books a bounded fresh retry after thirty minutes", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", null, true);
  await tickPipelines([], f.h.ports);
  f.advance(6 * 60 * 60_000);
  await tickPipelines([], f.h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  const at = Date.parse(parked.runs[0]!.attempts[0]!.providerWait!.resumeAt);
  expect(at - f.now()).toBe(30 * 60_000);
  f.advance(30 * 60_000 - 1);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  f.advance(1);
  await tickPipelines([], { ...f.h.ports });
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.providerRecoveryBudget).toBeUndefined();
});

test("a reply arriving while the quota retry confirms host termination cancels the retry", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  f.advance(180_000);
  f.h.ports.stopStageAgent = async () => {
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() + 1 });
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test.each(["provider-notice", "empty-completion"] as const)("an operator reply ending on a newer native %s cancels the old quota retry", async (ending) => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  f.advance(1_000);
  readFixtures(f.h, { "/codex/stage-1.jsonl": stageTranscript("operator-reply-native-quota", [
    providerQuotaRecord("codex", loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.turnTs),
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "user_message", message: "Continue with the answer" } },
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_started", turn_id: "answered-turn" } },
    { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete", turn_id: "answered-turn",
      ...(ending === "provider-notice" ? { error: { message: "You've hit your usage limit", codex_error_info: "usage_limit_exceeded" } } : {}) } },
  ]) });
  f.advance(180_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
});

import { os, engineModule, finishReported, realExec, pipelineIdentity } from "./engine.fixture";
import { realProvisionExec } from "./git";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import type { CreatePipelineRequest, Pipeline } from "./types";

const stages = [
  { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "review" },
  { id: "review", kind: "run", role: { roleId: "reviewer" }, prompt: "Review", next: null },
] as const;

async function repository() {
  savePipelines([]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-publication-"));
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const git = async (cwd: string, ...args: string[]) => {
    const result = await realExec("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", ...args], cwd);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  const base = await git(repo, "rev-parse", "HEAD");
  const h = harness(); let pushes = 0;
  h.ports.exec = (...args) => {
    if (args[0] === "git" && args[1][0] === "push") pushes++;
    return realExec(...args);
  };
  h.ports.provisionExec = realProvisionExec;
  h.setConversationActive(false); h.setPaneAlive(false);
  let laneId: string | undefined;
  const create = async (extra: Partial<CreatePipelineRequest> = {}) => {
    const result = await createPipelineFromRequest({ task: "Local publication", repoDir: repo, baseRef: base,
      stages: structuredClone(stages) as unknown as CreatePipelineRequest["stages"], ...extra }, h.ports);
    if (result.pipeline) laneId ??= result.pipeline.id;
    return result;
  };
  const current = () => loadPipelines().find(pipeline => pipeline.id === laneId)!;
  const tick = async (count = 3) => { for (let n = 0; n < count; n++) await tickPipelines([], h.ports); };
  const start = async (extra: Partial<CreatePipelineRequest> = {}) => {
    const result = await create(extra);
    if (!result.pipeline) throw new Error(result.error);
    await tick(2);
    return current();
  };
  const pass = async (n: number) => {
    expect((await engineModule.reportStageCompletion({ verdict: "pass" },
      { kind: "agent", role: n === 1 ? "builder" : "reviewer", conversationId: `conversation_stage_${n}` }, h.ports)).error).toBeUndefined();
    await tickPipelines([finishReported(h, `/codex/stage-${n}.jsonl`, "pass", "Checked")], h.ports);
    await tick();
  };
  const addRemote = async (name = "origin") => {
    const remote = path.join(root, `${name}.git`);
    await git(repo, "init", "-q", "--bare", "-b", "main", remote);
    await git(repo, "remote", "add", name, remote);
    return remote;
  };
  return { root, repo, base, git, h, create, current, tick, start, pass, addRemote, pushes: () => pushes,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

for (const publication of [undefined, "internal"] as const) test(`remote-less ${publication ?? "default"} lane commits and reviews its local accepted head`, async () => {
  const f = await repository();
  try {
    const lane = await f.start({ publication });
    fs.writeFileSync(path.join(lane.worktreeDir, "result.txt"), "builder work\n");
    await f.pass(1);
    const accepted = f.current().lastPassedCommit;
    expect(accepted).not.toBe(f.base);
    expect(await f.git(lane.worktreeDir, "show", `${accepted}:result.txt`)).toBe("builder work");
    expect(f.current().cursor).toMatchObject({ stageId: "review", state: "running" });
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.h.spawnInputs[1]!.cwd).toBe(lane.worktreeDir);
    expect(await f.git(lane.worktreeDir, "rev-parse", "HEAD")).toBe(accepted);
    expect(f.pushes()).toBe(0);
    await f.pass(2);
    expect(f.current()).toMatchObject({ state: "completed", lastPassedCommit: accepted });
    expect(f.current().runs[1]!.attempts[0]!.state).toBe("passed");
  } finally { f.cleanup(); }
});

test("a previously stuck default lane advances from its settled unavailable publication", async () => {
  const f = await repository();
  try {
    const lane = await f.start();
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.state = "passed"; attempt.verdict = { status: "pass", findings: [] }; attempt.completedAt = f.h.ports.now();
    lane.cursor!.state = "committing";
    lane.stateDetail = "passed but unpublished: the delivery remote is unavailable; configure it to publish this accepted head";
    lane.delivery!.operation = { id: "old-publication", epoch: lane.delivery!.epoch, sha: f.base, state: "settled", at: f.h.ports.now(),
      result: { ok: true, remote: "unavailable", sha: f.base }, passedStage: true } as NonNullable<Pipeline["delivery"]>["operation"];
    savePipelines([lane]); await f.tick(2);
    expect(f.current().cursor).toMatchObject({ stageId: "review", state: "running" });
    expect(f.current().stateDetail).toBeNull(); expect(f.pushes()).toBe(0);
  } finally { f.cleanup(); }
});

test("creation refuses an explicit remote policy without a remote and distinguishes unreadable remotes", async () => {
  const f = await repository();
  try {
    const refused = await f.create({ publication: "remote-branch" });
    expect(refused).toMatchObject({ status: 400, violations: [{ field: "publication", message: expect.stringContaining("needs a delivery remote") }] });
    expect(await f.create({ publication: "remote-branch", delivery: { branch: "refs/heads/lane", remote: "origin" } }))
      .toMatchObject({ status: 400, violations: [{ field: "publication" }] });
    expect(loadPipelines()).toHaveLength(0);
    const exec = f.h.ports.exec;
    f.h.ports.exec = (command, args, ...rest) => command === "git" && args[0] === "remote"
      ? { code: 128, stdout: "", stderr: "repository read failed" } : exec(command, args, ...rest);
    expect(await f.create()).toMatchObject({ status: 409, error: expect.stringContaining("could not read") });
    expect(loadPipelines()).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("a remote-less unpinned base provisions from local main", async () => {
  const f = await repository();
  try {
    await f.start({ baseRef: undefined });
    expect(f.current()).toMatchObject({ state: "running", baseRef: f.base, lastPassedCommit: f.base });
  } finally { f.cleanup(); }
});

test("set-delivery-remote adopts a configured remote, clears old publication and publishes the next accepted head", async () => {
  const f = await repository();
  try {
    const lane = await f.start();
    lane.publishedCommit = f.base;
    lane.delivery!.operation = { id: "old", epoch: 1, sha: f.base, state: "settled", at: "now", result: { ok: true, remote: "unavailable", sha: f.base } } as NonNullable<Pipeline["delivery"]>["operation"];
    savePipelines([lane]);
    const remote = await f.addRemote();
    expect((await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote" }, f.h.ports,
      { kind: "agent", conversationId: "conversation_controller", role: "orchestrator" })).error).toBeUndefined();
    expect(f.current().delivery!.target).toMatchObject({ remote, repository: projectIdentityFromRemote(remote, f.repo)!.project });
    expect(f.current().delivery!.epoch).toBe(2);
    expect(f.current().delivery!.operation).toBeUndefined(); expect(f.current().publishedCommit).toBeNull();
    expect(f.current().delivery!.journal.at(-1)!.conversationId).toBe("conversation_controller");
    fs.writeFileSync(path.join(lane.worktreeDir, "result.txt"), "published work\n"); await f.pass(1);
    expect(await f.git(remote, "rev-parse", `refs/heads/${lane.branch}`)).toBe(f.current().lastPassedCommit);
    expect(f.current().cursor?.stageId).toBe("review");
  } finally { f.cleanup(); }
});

test("publish refuses a local-only target with a working recovery hint", async () => {
  const f = await repository();
  try {
    const lane = await f.start();
    expect(await engineModule.patchPipeline(lane.id, { action: "publish" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining("set-delivery-remote") });
    expect(f.current().delivery!.operation).toBeUndefined();
  } finally { f.cleanup(); }
});

test("an older explicit remote lane parks honestly, admits retry and recovers after adopting origin", async () => {
  const f = await repository();
  try {
    const lane = await f.start(); lane.publication = "remote-branch"; savePipelines([lane]);
    fs.writeFileSync(path.join(lane.worktreeDir, "result.txt"), "accepted work\n"); await f.pass(1);
    expect(f.current()).toMatchObject({ state: "needs_decision", cursor: { stageId: "build", state: "committing" },
      stateDetail: expect.stringContaining("set-delivery-remote") });
    expect((await engineModule.patchPipeline(lane.id, { action: "retry-stage" }, f.h.ports)).error).toBeUndefined();
    await f.tick(); expect(f.current().state).toBe("needs_decision");
    const remote = await f.addRemote();
    expect((await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote" }, f.h.ports)).error).toBeUndefined();
    expect(f.current().state).toBe("running"); await f.tick();
    expect(f.current().cursor).toMatchObject({ stageId: "review", state: "running" });
    expect(await f.git(remote, "rev-parse", `refs/heads/${lane.branch}`)).toBe(f.current().lastPassedCommit);
  } finally { f.cleanup(); }
});

for (const refusal of ["unknown", "running", "owned", "redirect", "closed", "hidden", "review-flow"] as const) test(`remote adoption refuses ${refusal} without changing the delivery claim`, async () => {
  const f = await repository();
  try {
    const lane = await f.start(); const remote = await f.addRemote();
    let owners: Pipeline[] = [];
    if (refusal === "running") lane.delivery!.operation = { id: "in-flight", epoch: 1, sha: f.base, state: "running", at: "now" } as NonNullable<Pipeline["delivery"]>["operation"];
    if (refusal === "redirect") lane.delivery!.target.remote = remote;
    if (refusal === "closed") { lane.state = "closed"; lane.closedAt = f.h.ports.now(); lane.cursor = null; }
    if (refusal === "hidden") lane.hiddenAt = f.h.ports.now();
    if (refusal === "owned") {
      const owner = structuredClone(lane); owner.id = "other-owner"; Object.assign(owner, pipelineIdentity(owner.id, owner.task, owner.repoDir));
      owner.delivery!.target = { ...lane.delivery!.target, repository: projectIdentityFromRemote(remote, f.repo)!.project, remote };
      owner.delivery!.ownerId = owner.id; owners = [owner];
    }
    if (refusal === "review-flow") {
      lane.stages[1]!.kind = "review-loop";
      const attempt = structuredClone(lane.runs[0]!.attempts[0]!);
      attempt.effectiveRole = lane.stages[1]!.effectiveRole; attempt.flowId = "live-review";
      lane.runs[1]!.attempts = [attempt]; lane.cursor!.stageId = "review";
    }
    savePipelines([lane, ...owners]); const before = structuredClone(f.current().delivery);
    expect(await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote", remote: refusal === "unknown" ? "missing" : "origin" }, f.h.ports)).toMatchObject({ status: 409 });
    expect(f.current().delivery).toEqual(before);
  } finally { f.cleanup(); }
});

test("a default lane with origin publishes before review and a refused push cannot spawn review", async () => {
  const f = await repository();
  try {
    const remote = await f.addRemote(); const lane = await f.start();
    const hook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    fs.writeFileSync(path.join(lane.worktreeDir, "result.txt"), "remote work\n"); await f.pass(1);
    expect(f.h.spawnInputs).toHaveLength(1); expect(f.current().cursor?.stageId).toBe("build");
    fs.rmSync(hook);
    expect((await engineModule.patchPipeline(lane.id, { action: "publish" }, f.h.ports)).error).toBeUndefined(); await f.tick();
    expect(f.current().cursor?.stageId).toBe("review");
    expect(await f.git(remote, "rev-parse", `refs/heads/${lane.branch}`)).toBe(f.current().lastPassedCommit);
  } finally { f.cleanup(); }
});

test("a local reviewer cannot accept a different committed head", async () => {
  const f = await repository();
  try {
    const lane = await f.start(); await f.pass(1);
    const accepted = f.current().lastPassedCommit;
    await f.git(lane.worktreeDir, "commit", "-q", "--allow-empty", "-m", "reviewer commit");
    await f.pass(2);
    expect(f.current().state).toBe("needs_decision");
    expect(f.current().lastPassedCommit).toBe(accepted);
    expect(f.current().runs[1]!.attempts[0]!.error).toContain("read-only");
    expect(f.pushes()).toBe(0);
  } finally { f.cleanup(); }
});

test("adoption uses a named relative push remote and advances beyond its released owner epoch", async () => {
  const f = await repository();
  try {
    const lane = await f.start(); const remote = await f.addRemote("delivery");
    await f.git(f.repo, "remote", "set-url", "--push", "delivery", "../delivery.git");
    const history = structuredClone(lane); history.id = "past-owner";
    Object.assign(history, pipelineIdentity(history.id, history.task, history.repoDir));
    history.state = "completed"; history.cursor = null;
    history.delivery!.target = { ...history.delivery!.target, remote, repository: projectIdentityFromRemote(remote, f.repo)!.project };
    history.delivery!.active = false; history.delivery!.publish = "disabled";
    history.delivery!.ownerId = history.id; history.delivery!.epoch = 7;
    savePipelines([lane, history]);
    expect((await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote", remote: "delivery" }, f.h.ports)).error).toBeUndefined();
    expect(f.current().delivery!.epoch).toBe(8);
    expect(f.current().delivery!.target.remote).toBe(remote);
    const before = structuredClone(f.current().delivery);
    expect(await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote", remote: "delivery" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining("never redirected") });
    expect(f.current().delivery).toEqual(before);
  } finally { f.cleanup(); }
});

test("adoption rechecks ownership after its remote read and leaves an in-flight publisher untouched", async () => {
  const f = await repository();
  try {
    const lane = await f.start(); await f.addRemote();
    const exec = f.h.ports.exec;
    let calls = 0;
    f.h.ports.exec = async (...args) => {
      const result = await exec(...args);
      if (args[0] === "git" && args[1][0] === "remote" && calls++ === 0) {
        const current = f.current();
        current.delivery!.operation = { id: "raced-publication", epoch: current.delivery!.epoch, sha: f.base, state: "running" };
        savePipelines([current]);
      }
      return result;
    };
    expect(await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote" }, f.h.ports))
      .toMatchObject({ status: 409, error: expect.stringContaining("in flight") });
    expect(f.current().delivery!.operation!.id).toBe("raced-publication");
    expect(f.current().delivery!.target.remote).toBe(""); expect(f.current().delivery!.epoch).toBe(1);
  } finally { f.cleanup(); }
});

test("a local comparison takeover keeps its new owner local until a remote is adopted", async () => {
  const f = await repository();
  try {
    const owner = (await f.create({ autoStart: false })).pipeline!;
    const comparison = (await f.create({ autoStart: false, delivery: { branch: owner.delivery!.target.branch, comparison: true } })).pipeline!;
    const { takeoverPipelineDelivery, findPipelineRecord } = await import("./store");
    expect((await takeoverPipelineDelivery(comparison.id, owner.id, owner.delivery!.epoch, "selected comparison", null)).error).toBeUndefined();
    const current = findPipelineRecord(comparison.id)!;
    const { pipelinePublishesRemoteBranch } = await import("./publication");
    expect(current.publication).toBeUndefined(); expect(pipelinePublishesRemoteBranch(current)).toBe(false);
  } finally { f.cleanup(); }
});

test("legacy review delivery keeps the origin fetch repository fence with a separate push URL", async () => {
  const f = await repository();
  try {
    await f.addRemote(); const pushRemote = await f.addRemote("push-target");
    await f.git(f.repo, "remote", "set-url", "--push", "origin", pushRemote);
    const result = await f.create({ autoStart: false, publication: "internal", stages: [
      { id: "plan", kind: "run", role: { roleId: "architect" }, prompt: "Plan", next: "review" },
      { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review", next: null },
    ] });
    expect(result).toMatchObject({ status: 400, error: expect.stringContaining("origin repository") });
    expect(loadPipelines()).toHaveLength(0);
  } finally { f.cleanup(); }
});

const legacyReviewStages = [
  { id: "plan", kind: "run", role: { roleId: "architect" }, prompt: "Plan", next: "review" },
  { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "Review", next: null },
] as const;

test.each([
  { label: "origin push URL", remote: undefined, splitOrigin: true },
  { label: "named remote", remote: "delivery", splitOrigin: false },
] as const)("remote adoption refuses a legacy review target outside origin fetch repository via $label", async ({ remote, splitOrigin }) => {
  const f = await repository();
  try {
    const lane = await f.start({ publication: "internal", stages: structuredClone(legacyReviewStages) as unknown as CreatePipelineRequest["stages"] });
    await f.addRemote();
    const other = await f.addRemote("other");
    if (splitOrigin) await f.git(f.repo, "remote", "set-url", "--push", "origin", other);
    else await f.git(f.repo, "remote", "add", "delivery", other);
    const before = structuredClone(f.current().delivery);

    expect(await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote", ...(remote ? { remote } : {}) }, f.h.ports))
      .toMatchObject({ status: 400, error: expect.stringContaining("origin repository") });
    expect(f.current().delivery).toEqual(before);
    expect(f.current().delivery!.epoch).toBe(1);
  } finally { f.cleanup(); }
});

test("legacy review adoption from origin publishes the accepted head and launches review", async () => {
  const f = await repository();
  try {
    const lane = await f.start({ publication: "internal", stages: structuredClone(legacyReviewStages) as unknown as CreatePipelineRequest["stages"] });
    lane.publication = "remote-branch";
    savePipelines([lane]);
    const origin = await f.addRemote();
    expect((await engineModule.patchPipeline(lane.id, { action: "set-delivery-remote" }, f.h.ports)).error).toBeUndefined();
    await f.pass(1);
    expect(f.current()).toMatchObject({ cursor: { stageId: "review", state: "reviewing" } });
    expect(f.h.flowRequests).toHaveLength(1);
    expect(f.h.flowRequests[0]).toMatchObject({ targetSha: f.current().lastPassedCommit, headRef: lane.branch, requireRemoteHead: true });
    expect(await f.git(origin, "rev-parse", `refs/heads/${lane.branch}`)).toBe(f.current().lastPassedCommit);
  } finally { f.cleanup(); }
});
