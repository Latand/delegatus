import { expect, test, fs, path, selectProjectAccount, tickPipelines, loadPipelines, savePipelines, loadTasks, saveTasks, patchPipeline, PASS_TEXT, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, recoveryReport, providerRecoveryHarness } from "./engine.fixture";
import type { DurableQuotaObservation, PipelinePorts } from "./engine.fixture";

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
  }, 15_000);
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
}, 90_000);

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
