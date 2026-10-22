import { expect, test, fs, path, AccountAuthenticationRequiredError, tickPipelines, registerPipelineTick, loadPipelines, savePipelines, durableStageTurnEvidence, loadTasks, saveTasks, patchPipeline, ORIGIN_MAIN_SHA, entry, harness, create, PASS_TEXT, runningStructuredStage, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, providerQuotaRecord, BUDGET_STAGES, movingHeadHarness, critiqueRound, buildRound, movingHead, seedLegacyTerminalRecheck, HOST_UNAVAILABLE, failedReceipt, recoveryReport, expectProviderParkAt, providerRecoveryHarness } from "./engine.fixture";
import type { PipelinePorts } from "./engine.fixture";

test("a report wins over a terminal limit without sending a continuation", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit");
  const pipeline = loadPipelines()[0]!;
  const attempt = pipeline.runs[0]!.attempts[0]!;
  attempt.report = recoveryReport(f.h.ports.now());
  savePipelines([pipeline]);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
  expect(f.sends).toHaveLength(0);
});


test("native model capacity cuts retry with bounded backoff before parking", async () => {
  const text = "Selected model is at capacity. Please try a different model.";
  const f = await providerRecoveryHarness("codex", "other", text);
  const scheduled: number[] = [];
  f.h.ports.scheduleTick = ms => { scheduled.push(ms); };
  readFixtures(f.h, { "/codex/stage-1.jsonl": stageTranscript("native-capacity", [{
    type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete", error: { message: text } },
  }]) });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(f.sends).toHaveLength(0);
  // Continue through the fake evidence seam after the first native cut.
  f.h.ports.durableTurnEvidence = async (_engine, pathname) => f.h.durableTurns.get(pathname) ?? null;
  for (let n = 0; n < 3; n += 1) {
    if (n > 0) { f.cut(); f.h.setConversationActive(false); await tickPipelines([], f.h.ports); }
    f.advance(60_000 * 2 ** n - 1);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(n);
    f.advance(1);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(n + 1);
    f.advance(1_000);
  }
  f.cut();
  f.h.setConversationActive(false);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("model at capacity after 3 tries");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
  expect(new Set(f.sends).size).toBe(3);
  expect(scheduled).toContain(60_000);
  expect(scheduled).toContain(120_000);
  expect(scheduled).toContain(240_000);
});


test.each([false, true])("an active unknown limit adopts a newly known future reset before expiry, pinned=%s", async (pinned) => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit", null, pinned);
  await tickPipelines([], f.h.ports);
  const futureReset = Math.floor((f.now() + 7 * 24 * 60 * 60_000) / 1_000);
  if (pinned) f.h.ports.claudeAccountReset = () => futureReset;
  else f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: futureReset, allowedAccountIds: [LIMITED_ACCOUNT] });
  f.advance(6 * 60 * 60_000);
  for (let n = 0; n < 20; n += 1) {
    await tickPipelines([], f.h.ports);
    const waiting = loadPipelines()[0]!;
    expect(waiting.state).toBe("running");
    expect(waiting.runs[0]!.attempts[0]!.providerWait!.resetsAt).toBe(futureReset);
    expect(waiting.stateDetail).toContain(new Date(futureReset * 1_000).toISOString());
    expect(f.sends).toHaveLength(0);
    f.advance(30 * 60_000);
  }
  f.advance(futureReset * 1_000 + 60_000 - f.now());
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
});


test.each([false, true])("a resumed provider-cut host that dies before new output relaunches with WIP, timestamp=%s", async (timestamp) => {
  const f = await providerRecoveryHarness("claude", "server_error", "Failed to refresh OAuth token: retry in a minute");
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  if (timestamp) f.h.ports.conversationHostUnavailableSince = async () => new Date(f.now() - 5 * 60_000).toISOString();
  else f.h.setConversationActive(false);
  await tickPipelines([], f.h.ports);
  f.advance(30_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.prompt).toContain("keeping uncommitted work");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRequest).toBeUndefined();
});


test.each([false, true])("accepted provider continuations fence relaunch until delivery, delivered=%s", async (delivered) => {
  const f = await providerRecoveryHarness("claude", "server_error", "Failed to refresh OAuth token: retry in a minute");
  let settled = false;
  const keys: string[] = [];
  f.h.ports.conversationDeliveryOutstanding = () => !settled;
  f.h.ports.conversationDeliveryCompleted = (_id, key) => { keys.push(key); return settled; };
  f.h.ports.resumeSeveredTurn = async (input) => { f.sends.push(input.clientMessageId); return true; };
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  const key = f.sends[0]!;
  for (let tick = 0; tick < 3; tick += 1) {
    f.advance(60_000);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(f.sends).toEqual([key]);
  }
  if (delivered) {
    settled = true;
    f.advance(60_000);
    await tickPipelines([], f.h.ports);
    f.advance(30_000);
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(keys.every(candidate => candidate === key)).toBe(true);
  } else {
    f.advance(10 * 60_000);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.stateDetail).toContain("accepted continuation delivery is still pending");
    expect(f.h.spawnInputs).toHaveLength(1);
  }
  expect(f.sends).toEqual([key]);
});


test("a relaunched stage observes its next provider cut before checking continuation delivery", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  const retry = lane.runs[0]!.attempts[1]!;
  retry.paneId = null;
  savePipelines([lane]);
  f.advance(1_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] });
  const queriedKeys: string[] = [];
  // The fresh host has no provider continuation delivery at all yet.
  f.h.ports.conversationDeliveryCompleted = (_id, key) => { queriedKeys.push(key); return false; };
  f.h.durableTurns.set(retry.agentPath!, { turn: "terminal", message: null,
    terminalProviderMessage: { text: "You've hit your usage limit", ts: f.now(), errorClass: "usage_limit_exceeded", usageLimit: { resetsAt: f.resetsAt } } });
  await tickPipelines([], f.h.ports);
  const waiting = loadPipelines()[0]!.runs[0]!.attempts[1]!;
  expect(waiting.providerWait!.turnTs).toBe(f.now());
  expect(waiting.providerWait!.actionAt).toBeUndefined();
  expect(waiting.providerWait!.tries).toBe(1);
  expect(queriedKeys).toEqual([]);
  expect(loadPipelines()[0]!.stateDetail).toContain("usage limit");
  expect(f.h.spawnInputs).toHaveLength(2);
});


test("a newer completed verdict wins over host loss after a provider continuation", async () => {
  const f = await providerRecoveryHarness("claude", "server_error", "Failed to refresh OAuth token: retry in a minute");
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  f.advance(1_000);
  f.h.durableTurns.set("/codex/stage-1.jsonl", {
    turn: "terminal", message: { text: PASS_TEXT, ts: f.now() }, lastRecordAt: f.now(),
  });
  f.h.ports.conversationHostUnavailableSince = async () => new Date(f.now() - 5 * 60_000).toISOString();
  await tickPipelines([], f.h.ports);
  const settled = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(settled.state).toBe("passed");
  expect(settled.providerWait).toBeUndefined();
  expect(settled.verdictRequest).toBeUndefined();
  expect(f.h.spawnInputs).toHaveLength(1);
});


test("a pending provider capacity wait does not spin the pipelines controller", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] });
  let ticks = 0;
  const unregister = registerPipelineTick(async () => { ticks += 1; });
  try {
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticks).toBe(0);
    f.advance(300_000);
    await tickPipelines([], f.h.ports);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticks).toBe(0);
  } finally {
    unregister();
  }
});


test("mixed provider cuts retain recovery expenditure until stage progress", async () => {
  const f = await providerRecoveryHarness("codex", "stream_disconnected", "stream disconnected");
  for (let cut = 0; cut < 12; cut += 1) {
    const errorClass = cut % 2 === 0 ? "stream_disconnected" : "turn_aborted";
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "terminal", message: null,
      terminalProviderMessage: { text: errorClass, errorClass, ts: f.now() } });
    await tickPipelines([], f.h.ports);
    const lane = loadPipelines()[0]!;
    if (lane.state === "needs_decision") break;
    const wait = lane.runs[0]!.attempts[0]!.providerWait!;
    f.advance(Math.max(0, Date.parse(wait.resumeAt) - f.now()));
    await tickPipelines([], f.h.ports);
    f.advance(1_000);
  }
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toMatch(/stage cut by (transient provider error|aborted stage turn).*tries/);
  expect(f.sends.length).toBeLessThanOrEqual(3);
  const spent = f.sends.length;
  f.advance(24 * 60 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(spent);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.h.calls.some((call) => /reset|clean/.test(call))).toBe(false);
});


test("a failed host teardown has a bounded recovery wait without spending a fix round", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  let now = Date.parse(h.ports.now());
  h.ports.now = () => new Date(now).toISOString();
  h.ports.stopStageAgent = async () => ({ outcome: "failed", error: "recorded host ownership cannot be verified" });
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, launchOnly: true });
  await tickPipelines([], h.ports);
  now += 30_000;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  now += 11 * 60_000;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("stage host died without output");
  expect(loadPipelines()[0]!.stateDetail).toContain("ownership cannot be verified");
  expectProviderParkAt(loadPipelines()[0]!, h.ports.now());
  expect(h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.cursor?.stageId).toBe("plan");
});


for (const startup of [false, true]) {
  test.each(["stopped", "not-running", "unknown", "failed"] as const)(`recovery confirms a recorded pane after registry absence, startup=${startup}, pane=%s`, async (outcome) => {
    const f = await providerRecoveryHarness("claude", "server_error", "Failed to refresh OAuth token: retry in a minute");
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.paneId = "%recorded-stage";
    if (startup) {
      attempt.state = "spawning";
      attempt.effectiveRole.access = "read-write";
      lane.stages[0]!.effectiveRole.access = "read-write";
      f.h.ports.spawnReceipt = id => id === attempt.launchId
        ? { ...failedReceipt(id, attempt.conversationId!, HOST_UNAVAILABLE), staged: true, paneId: attempt.paneId, transcript: attempt.agentPath }
        : null;
    }
    savePipelines([lane]);
    f.h.ports.stopStageAgent = async target => {
      f.h.calls.push(`stop-host:${target.stageId}:${target.attempt}`);
      return { outcome: "not-running" };
    };
    f.h.setPaneStop(outcome === "unknown" ? { outcome, detail: "recorded pane identity changed" }
      : outcome === "failed" ? { outcome, error: "pane termination unavailable" } : { outcome });
    if (outcome === "not-running") f.h.setPaneAlive(false);
    await tickPipelines([], f.h.ports);
    f.advance(60_000);
    await tickPipelines([], f.h.ports);
    if (!startup) {
      // A transient provider cut cannot retire a live legacy pane: its
      // identity alone cannot exclude newer operator work.
      expect(f.h.calls).not.toContain("stop-pane:plan:1:%recorded-stage");
      if (outcome === "not-running") {
        await tickPipelines([], f.h.ports);
        expect(f.h.spawnInputs).toHaveLength(2);
        expect(f.h.spawnInputs[1]!.prompt).toContain("keeping uncommitted work");
      } else {
        f.advance(11 * 60_000);
        await tickPipelines([], f.h.ports);
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        expect(loadPipelines()[0]!.stateDetail).toContain("auth refresh race");
        expect(f.h.spawnInputs).toHaveLength(1);
      }
      expect(f.h.killedPanes).toEqual([]);
    } else {
      expect(f.h.calls).toContain("stop-pane:plan:1:%recorded-stage");
      if (outcome === "stopped" || outcome === "not-running") {
        await tickPipelines([], f.h.ports);
        expect(f.h.spawnInputs).toHaveLength(2);
        const paneCheck = f.h.calls.indexOf("stop-pane:plan:1:%recorded-stage");
        const retrySpawn = f.h.calls.findIndex((call, index) => index > paneCheck && call.startsWith("spawn:"));
        expect(retrySpawn).toBeGreaterThan(paneCheck);
        expect(f.h.spawnInputs[1]!.prompt).toContain("keeping uncommitted work");
      } else {
        expect(f.h.spawnInputs).toHaveLength(1);
        f.advance(11 * 60_000);
        await tickPipelines([], f.h.ports);
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        expect(loadPipelines()[0]!.stateDetail).toContain(startup ? "runtime host" : "auth refresh race");
        expect(f.h.spawnInputs).toHaveLength(1);
        expect(f.h.killedPanes).toEqual([]);
      }
    }
    expect(f.h.calls.some(call => /reset|clean/.test(call))).toBe(false);
  });
}


test.each([false, true])("refused provider continuations keep their delivery key and exhaust a bounded transport wait, throws=%s", async (throws) => {
  const f = await providerRecoveryHarness("claude", "server_error", "Failed to refresh OAuth token: retry in a minute");
  const keys: string[] = [];
  f.h.ports.resumeSeveredTurn = async (input) => {
    keys.push(input.clientMessageId);
    if (throws) throw new Error("transport unavailable");
    input.onRefused?.("recipient host is unhosted and has no writer claim");
    return false;
  };
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(keys).toHaveLength(1);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  expect(new Set(keys).size).toBe(1);
  f.advance(11 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("auth refresh race");
  expect(loadPipelines()[0]!.stateDetail).toContain(throws ? "continuation transport failed: Error: transport unavailable" : "recipient host is unhosted and has no writer claim");
  expectProviderParkAt(loadPipelines()[0]!, f.h.ports.now());
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.tries).toBe(0);
});



test.each(["codex", "claude"] as const)("memory kill owns one fresh %s attempt when restart and provider recovery overlap", async (engine) => {
  for (const providerFirst of [false, true]) {
    const h = harness();
    await runningStructuredStage(h);
    h.setConversationActive(false);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.hostEpoch = 1;
    attempt.effectiveRole.engine = engine;
    attempt.effectiveRole.model = engine === "claude" ? "fable" : "gpt-5.6-sol";
    lane.stages[0]!.effectiveRole = { ...attempt.effectiveRole };
    savePipelines([lane]);
    h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null,
      lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
    if (providerFirst) {
      await tickPipelines([], h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.condition.kind).toBe("host_death");
    }
    const at = h.ports.now();
    const restarted: PipelinePorts = { ...h.ports,
      conversationOutOfMemory: async (id) => id === attempt.conversationId
        ? { at, limitBytes: 15 * 2 ** 30, limit: "agent", fatal: true, process: null } : null,
      memoryHeadroom: () => ({ availableBytes: 20 * 2 ** 30, requiredBytes: 15 * 2 ** 30 }),
      restartRecoveryBootId: () => "memory-loss-boot",
      runtimeHostEpoch: async () => 2,
      conversationTurnInterrupted: async (id) => id === attempt.conversationId ? "dead" : null,
    };
    await tickPipelines([entry(attempt.agentPath!)], restarted);
    const recovered = loadPipelines()[0]!;
    expect(recovered.runs[0]!.attempts).toHaveLength(2);
    expect(recovered.runs[0]!.attempts[0]).toMatchObject({ state: "failed", outOfMemory: { at, limit: "agent" } });
    expect(recovered.runs[0]!.attempts[0]!.restartRecovery).toBeUndefined();
    expect(recovered.runs[0]!.attempts[0]!.providerRecoveries?.some(item => item.action === "relaunch") ?? false).toBe(false);
    expect(recovered.runs[0]!.attempts[1]!.memoryWait).toBeDefined();
    await tickPipelines([], restarted);
    expect(h.spawnInputs).toHaveLength(1);
    h.advanceWallClock(60_001);
    h.setConversationActive(true);
    await tickPipelines([], restarted);
    await tickPipelines([], restarted);
    expect(h.spawnInputs).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    expect(h.calls.filter(call => call.startsWith("stop-host:"))).toHaveLength(1);
    expect(loadPipelines()[0]!.worktreeDir).toBe(lane.worktreeDir);
  }
});


// Both recovery controllers can observe the same open turn after a restart.
test.each(["codex", "claude"] as const)("restart and provider recovery reserve one fresh %s attempt for the same host loss", async (engine) => {
  for (const providerFirst of [false, true]) {
    const h = harness();
    await runningStructuredStage(h);
    h.setConversationActive(false);
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.hostEpoch = 1;
    attempt.effectiveRole.engine = engine;
    attempt.effectiveRole.model = engine === "claude" ? "fable" : "gpt-5.6-sol";
    lane.stages[0]!.effectiveRole = { ...attempt.effectiveRole };
    savePipelines([lane]);
    h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null,
      lastRecordAt: Date.parse(attempt.startedAt!) + 1 });
    h.advanceWallClock(3 * 60_000);
    if (providerFirst) {
      await tickPipelines([], h.ports);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.condition.kind).toBe("host_death");
    }
    const restarted: PipelinePorts = { ...h.ports,
      restartRecoveryBootId: () => "shared-loss-boot",
      runtimeHostEpoch: async () => 2,
      conversationTurnInterrupted: async () => "dead",
    };
    await tickPipelines([], restarted);
    if (providerFirst) {
      // A reserved provider retry retains its existing backoff and ownership.
      expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.restartRecovery).toBeUndefined();
      expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.severedTurn).toBeUndefined();
      h.advanceWallClock(30_000);
      await tickPipelines([], restarted);
    }
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    const old = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(Boolean(old.restartRecovery?.replacementAttempt)).toBe(!providerFirst);
    expect(old.providerRecoveries?.some(item => item.action === "relaunch") ?? false).toBe(providerFirst);
    await tickPipelines([], restarted);
    await tickPipelines([], restarted);
    expect(h.spawnInputs).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
    expect(h.calls.filter(call => call.startsWith("stop-host:"))).toHaveLength(1);
  }
});


test("a blocked historical terminal reviewer retries its unspent activation", async () => {
  const h = movingHeadHarness(() => ORIGIN_MAIN_SHA);
  movingHead.ports = h.ports;
  await create(h.ports, BUDGET_STAGES({ to: "build", maxRounds: 1 }, null) as never);
  await tickPipelines([], h.ports);
  await buildRound(h, "initial build");
  await critiqueRound(h, "fail", "initial finding");
  await buildRound(h, "last budget fix");
  seedLegacyTerminalRecheck();
  await tickPipelines([], h.ports);
  const review = loadPipelines()[0]!.runs.find(run => run.stageId === "critique")!.attempts.at(-1)!;
  expect(review.activatedBy?.budgetRecheck).toBe(true);
  h.messages.set(review.agentPath!, { text: 'Review unavailable\n\n```json\n{"status":"fail","blocked":true,"blockedReason":"Review environment unavailable","findings":["P1 review blocked"]}\n```', ts: Date.now() + 100_000_000 });
  await tickPipelines([entry(review.agentPath!)], h.ports);
  const blocked = loadPipelines()[0]!;
  expect(blocked.reviewPending).toBeUndefined();
  const { pipelineActionOptions } = await import("@/components/kanban/stagesModel");
  const { pipelineAnswers } = await import("@/components/pipelines/pipelineBlockModel");
  expect(pipelineActionOptions(blocked).find((option) => option.action === "retry-stage")?.refusal).toBeNull();
  expect(pipelineActionOptions(blocked).find((option) => option.action === "skip-stage")?.refusal).not.toBeNull();
  expect(pipelineAnswers(blocked, (stage) => stage.id)?.choices.map((choice) => choice.action)).toEqual(["retry-stage"]);
  expect((await patchPipeline(blocked.id, { action: "skip-stage" }, h.ports)).status).toBe(409);
  expect((await patchPipeline(blocked.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
  await critiqueRound(h, "pass", "environment restored; independent review passes");
  const completed = loadPipelines()[0]!;
  expect(completed.state).toBe("completed");
  expect(completed.runs.find(run => run.stageId === "critique")!.attempts.at(-1)!.activatedBy).toEqual(review.activatedBy);
});



test.each(["before-stop", "after-stop"] as const)("quota retry requires readable unchanged cut evidence %s", async boundary => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  let stopped = false;
  const original = f.h.ports.durableTurnEvidence;
  f.h.ports.durableTurnEvidence = (...args) => boundary === "before-stop" || stopped ? Promise.resolve(null) : original(...args);
  f.h.ports.stopStageAgent = async () => { stopped = true; return { outcome: "not-running" }; };
  f.advance(180_000);
  for (let round = 0; round < 22; round++) {
    await tickPipelines([], f.h.ports);
    f.advance(30_000);
  }
  const parked = loadPipelines()[0]!;
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(parked.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
  expect(parked.stateDetail).toContain("evidence");
});



test("a reply withdraws the quota retry card promise before a far-future reset", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 2 * 60 * 60_000, true);
  const lane = loadPipelines()[0]!;
  lane.taskIds = ["answered-retry-task"];
  saveTasks([{ id: "answered-retry-task", project: lane.project, text: "Recover stage", status: "assigned", placement: "unplaced", assignments: [], createdAt: lane.createdAt, updatedAt: lane.createdAt }]);
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  f.advance(1_000);
  f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() });
  await tickPipelines([], f.h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeUndefined();
  expect(parked.runs[0]!.attempts[0]!.error).not.toMatch(/Automatic retry|Автоповтор/);
  expect(loadTasks()[0]!.note?.text).not.toMatch(/Automatic retry|Автоповтор/);
  expect(f.h.spawnInputs).toHaveLength(1);
});


test("a reply during fresh target termination cancels failover before replacement", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed", home: "/account-b", transcriptRoot: "/account-b/sessions", env: { NODE_ENV: "test" } } });
  const options: unknown[] = [];
  f.h.ports.stopStageAgent = async (_target, option) => {
    options.push(option);
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() + 1 });
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(options).toEqual([{ onlyIfIdle: true, providerRecovery: { pipelineId: loadPipelines()[0]!.id, stageId: loadPipelines()[0]!.cursor!.stageId, attempt: 1, turnTs: f.now(), controlGeneration: loadPipelines()[0]!.controlGeneration ?? null } }]);
  expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
});



for (const engine of ["claude", "codex"] as const) {
  for (const paneAlive of [false, null]) {
    test(`${engine} idle-only provider failover observes pane liveness=${paneAlive} without killing it`, async () => {
      const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded",
        "You've hit your session limit", 120_000);
      const lane = loadPipelines()[0]!;
      lane.runs[0]!.attempts[0]!.paneId = "%recorded-stage";
      savePipelines([lane]);
      f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine, accountId: SPARE_ACCOUNT,
        kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
      const providerCutAt = f.now();
      let idleStopProbe = false;
      f.h.ports.stopStageAgent = async (_target, options) => {
        expect(options).toEqual({ onlyIfIdle: true, providerRecovery: { pipelineId: lane.id, stageId: lane.cursor!.stageId, attempt: 1, turnTs: providerCutAt, controlGeneration: lane.controlGeneration ?? null } });
        idleStopProbe = true;
        return { outcome: "not-running" };
      };
      f.h.ports.paneAgentAlive = async () => {
        if (!idleStopProbe) return true;
        idleStopProbe = false;
        if (paneAlive === null) throw new Error("pane snapshot unavailable");
        return paneAlive;
      };
      let paneStops = 0;
      f.h.ports.stopStagePane = async () => { paneStops++; return { outcome: "stopped" }; };
      await tickPipelines([], f.h.ports);
      if (paneAlive === false) {
        await tickPipelines([], f.h.ports);
        expect(f.h.spawnInputs).toHaveLength(2);
      } else {
        expect(f.h.spawnInputs).toHaveLength(1);
        expect(loadPipelines()[0]!.stateDetail).toContain("pane liveness could not be verified");
        f.advance(11 * 60_000);
        await tickPipelines([], f.h.ports);
        expect(loadPipelines()[0]!.state).toBe("needs_decision");
        expect(f.h.spawnInputs).toHaveLength(1);
      }
      expect(paneStops).toBe(0);
    });
  }
  test(`${engine} provider failover preserves an answered pane after registry absence`, async () => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded",
      "You've hit your session limit", 120_000);
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.paneId = "%recorded-stage";
    savePipelines([lane]);
    f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine, accountId: SPARE_ACCOUNT,
      kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
    const providerCutAt = f.now();
    f.h.ports.stopStageAgent = async (_target, options) => {
      expect(options).toEqual({ onlyIfIdle: true, providerRecovery: { pipelineId: lane.id, stageId: lane.cursor!.stageId, attempt: 1, turnTs: providerCutAt, controlGeneration: lane.controlGeneration ?? null } });
      // A reply starts while the host lookup finds no registry resident.
      f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() + 1 });
      return { outcome: "not-running" };
    };
    let paneStops = 0;
    f.h.ports.stopStagePane = async () => { paneStops++; return { outcome: "stopped" }; };
    await tickPipelines([], f.h.ports);
    expect(paneStops).toBe(0);
    expect(f.h.spawnInputs).toHaveLength(1);
    f.advance(1_000);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
    expect(f.sends).toHaveLength(0);
    expect(paneStops).toBe(0);
    expect(f.h.spawnInputs).toHaveLength(1);
  });
}


for (const engine of ["claude", "codex"] as const) {
  test.each(["tier", "prompt", "host"] as const)(`${engine} unreserved target %s failure preserves the source reset`, async cause => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000);
    f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
    f.h.ports.resolveProjectSpawn = (_engine, request) => {
      const target = [LIMITED_ACCOUNT, SPARE_ACCOUNT].find(id => !request.unavailableIds?.includes(id));
      return target ? { kind: "available", account: { engine, accountId: target, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] };
    };
    const baseSpawn = f.h.ports.spawnAgent;
    f.h.ports.spawnAgent = async (input, reserved) => {
      if (input.requestedAccountId !== SPARE_ACCOUNT) return baseSpawn(input, reserved);
      if (cause === "tier") throw new (await import("@/lib/accounts/codexServiceTiers")).CodexServiceTierUnavailableError("required tier unavailable");
      throw new Error(cause === "prompt" ? "stage prompt could not be prepared" : "host startup failed");
    };
    await tickPipelines([], f.h.ports);
    await tickPipelines([], f.h.ports);
    const lane = loadPipelines()[0]!;
    const wait = lane.runs[0]!.attempts.at(-1)!.providerWait!;
    expect(lane.stateDetail).toContain("target preflight failed:");
    expect(wait.failedAccounts?.includes(SPARE_ACCOUNT) ?? false).toBe(cause === "tier");
    expect(wait.stageRetry).toBeDefined();
    expect(wait.resumeAt).toBe(new Date(f.resetsAt! * 1_000 + 60_000).toISOString());
    for (let tick = 0; tick < 8; tick++) { f.advance(30_000); await tickPipelines([], f.h.ports); }
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.accountId).toBe(LIMITED_ACCOUNT);
  });
}


test.each([false, true])("fresh quota target preflight failure retains reset retry only before reservation=%s", async reserved => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed", home: "/account-b", transcriptRoot: "/account-b/sessions", env: { NODE_ENV: "test" } } });
  const baseSpawn = f.h.ports.spawnAgent;
  f.h.ports.spawnAgent = async (input, onReserved) => {
    if (reserved) await baseSpawn(input, onReserved);
    throw new (await import("@/lib/accounts/manager")).AccountAuthenticationRequiredError("claude", SPARE_ACCOUNT);
  };
  for (let n = 0; n < 3; n++) await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts.at(-1)!;
  expect(lane.state).toBe("needs_decision");
  if (reserved) {
    expect(attempt.providerWait?.stageRetry).toBeUndefined();
  } else {
    expect(attempt.providerWait?.stageRetry).toBeDefined();
    expect(attempt.providerWait?.failedAccounts).toContain(SPARE_ACCOUNT);
    expect(attempt.providerWait?.resumeAt).toBe(new Date(f.resetsAt! * 1_000 + 60_000).toISOString());
  }
  expect(f.sends).toHaveLength(0);
});



for (const mode of ["running", "pinned-park", "pool-park"] as const) {
  test.each(["operator", "task-notification", "scheduled"] as const)(`${mode} quota cut distinguishes a newer %s turn`, async origin => {
    const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, mode !== "pool-park");
    const lane = loadPipelines()[0]!;
    if (mode !== "running") lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now(),
      ...(mode === "pool-park" ? { triedAccounts: [LIMITED_ACCOUNT, SPARE_ACCOUNT] } : {}) };
    if (mode === "pool-park") f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
    savePipelines([lane]);
    f.h.ports.resolveProjectSpawn = () => f.now() >= f.resetsAt! * 1_000 + 60_000
      ? { kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
      : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: mode === "pool-park" ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT] };
    const notice = (ts: string) => ({ type: "assistant", timestamp: ts, isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } });
    const records: Record<string, unknown>[] = [notice(f.h.ports.now())];
    const file = stageTranscript("newer-quota-turn", records);
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    await tickPipelines([], f.h.ports);
    f.advance(1_000);
    records.push({ type: "queue-operation", operation: "enqueue", timestamp: f.h.ports.now() });
    records.push({ type: "user", timestamp: f.h.ports.now(),
      ...(origin === "operator" ? { turnOrigin: "sdk", promptSource: "sdk" }
        : origin === "scheduled" ? { isMeta: true, turnOrigin: "scheduled", promptSource: "system" }
        : { origin: { kind: origin }, turnOrigin: "task_notification", promptSource: "system" }),
      message: { role: "user", content: origin === "operator" ? "Please continue" : `<${origin}>background work ended</${origin}>` } });
    // Tick in the gap between native prompt publication and its limit notice.
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    await tickPipelines([], f.h.ports);
    if (origin !== "operator") expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toBeDefined();
    f.advance(500);
    records.push(notice(f.h.ports.now()));
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    await tickPipelines([], f.h.ports);
    if (mode !== "running" && origin !== "operator") expect(loadPipelines()[0]!.stateDetail).toMatch(/Automatic retry|Автоповтор/);
    for (let tick = 0; tick < 8; tick++) { f.advance(30_000); await tickPipelines([], f.h.ports); }
    expect(f.sends.length).toBe(mode === "running" && origin !== "operator" ? 1 : 0);
    expect(f.h.spawnInputs.length).toBe(mode !== "running" && origin !== "operator" ? 2 : 1);
    if (origin === "operator") {
      expect(loadPipelines()[0]!.state).toBe("needs_decision");
      expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
    }
  });
}



test("quota continuation waits for a decision when prompt history exceeds the read bound", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  await tickPipelines([], f.h.ports);
  const cutAt = f.now();
  f.advance(1_000);
  // The saved cut opens the chain the 9 MiB record and the reply fall inside.
  const file = stageTranscript("quota-history-bound", [
    providerQuotaRecord("claude", cutAt),
    { type: "user", timestamp: f.h.ports.now(), promptSource: "sdk", message: { content: "Wait for my answer" } },
    { type: "queue-operation", timestamp: f.h.ports.now(), padding: "x".repeat(9 * 1024 * 1024) },
    { type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit", message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } },
  ]);
  const evidence = await durableStageTurnEvidence("claude", file, undefined, undefined, undefined, cutAt);
  expect(evidence?.promptHistoryComplete).toBe(false);
  f.h.durableTurns.set("/codex/stage-1.jsonl", evidence!);
  await tickPipelines([], f.h.ports);
  f.advance(11 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("prompt history is incomplete");
});



for (const engine of ["claude", "codex"] as const) {
  test.each(["pipeline", "startup-recovery"] as const)(`${engine} parked retry retains a delivered %s continuation`, async role => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
    const cutAt = f.now();
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
    savePipelines([lane]);
    await tickPipelines([], f.h.ports);
    f.advance(1_000);
    const promptAt = f.h.ports.now();
    const origin = { kind: "agent" as const, role };
    const text = "Continue the interrupted turn from the transcript.";
    let records: Record<string, unknown>[];
    if (engine === "claude") records = [{ type: "user", uuid: "automatic-prompt", timestamp: promptAt, promptSource: "sdk", message: { content: text } }];
    else {
      const { persistStructuredUserMetadata } = await import("@/lib/selection/structuredUserMetadata");
      const { structuredContentDigest } = await import("@/lib/runtime/structuredContent");
      const { encodeCodexStructuredUserText } = await import("@/lib/runtime/codexStructuredUserText");
      const ref = await persistStructuredUserMetadata({ version: 1, contentDigest: structuredContentDigest({ text, images: [] }), selectedContext: null, origin });
      records = [{ type: "event_msg", timestamp: promptAt, payload: { type: "user_message", message: encodeCodexStructuredUserText(text, ref) } },
        { type: "event_msg", timestamp: promptAt, payload: { type: "task_started" } }];
    }
    f.advance(500);
    records.push(engine === "claude" ? { type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
      message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } }
      : { type: "event_msg", timestamp: f.h.ports.now(), payload: { type: "task_complete", error: { message: "You've hit your session limit", codex_error_info: "usage_limit_exceeded" } } });
    records.unshift(providerQuotaRecord(engine, cutAt));
    const file = stageTranscript(`parked-controller-${engine}-${role}`, records);
    if (engine === "claude") {
      const { FileClaudeDeliveryLedger } = await import("@/lib/runtime/claudeStreamBrokerHost");
      const ledger = new FileClaudeDeliveryLedger();
      const session = path.basename(file, ".jsonl");
      ledger.recordQueued(session, { id: "parked-automatic-prompt", text, origin }, "turn-started");
      ledger.confirmDelivered(session, "parked-automatic-prompt", "automatic-prompt");
    }
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine, accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
    for (let tick = 0; tick < 8; tick++) { f.advance(30_000); await tickPipelines([], f.h.ports); }
    expect(f.h.spawnInputs).toHaveLength(2);
    expect(f.sends).toHaveLength(0);
  });
}



test.each(["claude", "codex"] as const)("%s pause and resume withdraws a running provider reset obligation", async engine => {
  const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
  await tickPipelines([], f.h.ports);
  const id = loadPipelines()[0]!.id;
  expect((await patchPipeline(id, { action: "pause" }, f.h.ports)).error).toBeUndefined();
  expect((await patchPipeline(id, { action: "resume" }, f.h.ports)).error).toBeUndefined();
  f.advance(180_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
});


test("capacity relaunch preserves idle-only retirement and rechecks operator input after termination", async () => {
  const f = await providerRecoveryHarness("codex", "other", "Selected model is at capacity. Please try a different model.");
  f.h.ports.resumeSeveredTurn = undefined;
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  let stopOptions: unknown;
  f.h.ports.stopStageAgent = async (_target, options) => {
    stopOptions = options;
    f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, lastRecordAt: f.now() + 1,
      prompts: [{ ts: f.now() + 1, origin: "external" }] });
    return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  expect(stopOptions).toEqual({ onlyIfIdle: true, providerRecovery: { pipelineId: loadPipelines()[0]!.id, stageId: loadPipelines()[0]!.cursor!.stageId, attempt: 1, turnTs: f.now() - 60_000, controlGeneration: loadPipelines()[0]!.controlGeneration ?? null } });
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
});


for (const mode of ["running", "pinned-park", "pool-park"] as const) {
  for (const wrapper of ["task-notification", "scheduled-trigger", "task", "bare-task"] as const) {
    test.each(["native-human", "ledger-human", "harness"] as const)(`Claude ${mode} ${wrapper} %s authorship controls quota recovery`, async author => {
      const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, mode !== "pool-park");
      const lane = loadPipelines()[0]!;
      if (mode !== "running") lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now(),
        ...(mode === "pool-park" ? { triedAccounts: [LIMITED_ACCOUNT, SPARE_ACCOUNT] } : {}) };
      if (mode === "pool-park") f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
      savePipelines([lane]);
      f.h.ports.resolveProjectSpawn = () => f.now() >= f.resetsAt! * 1_000 + 60_000
        ? { kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
        : { kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: mode === "pool-park" ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT] };
      await tickPipelines([], f.h.ports);
      const initial = f.now();
      f.advance(1_000);
      const tag = wrapper === "task" || wrapper === "bare-task" ? "task-notification" : wrapper;
      const text = `<${tag}>Please wait for my review before continuing.</${tag}>`;
      const notice = (at: number) => ({ type: "assistant", timestamp: new Date(at).toISOString(), isApiErrorMessage: true, error: "rate_limit",
        message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } });
      const file = stageTranscript(`claude-native-wrapper-${mode}-${wrapper}-${author}`, [notice(initial),
        { type: "user", uuid: "wrapper-user", isMeta: false, timestamp: f.h.ports.now(), message: { content: text },
          ...(author === "native-human" ? {} : { origin: wrapper === "bare-task" ? "task" : { kind: wrapper }, promptSource: "system" }) }, notice(f.now() + 500)]);
      if (author === "ledger-human") {
        const { FileClaudeDeliveryLedger } = await import("@/lib/runtime/claudeStreamBrokerHost");
        const ledger = new FileClaudeDeliveryLedger();
        const session = path.basename(file, ".jsonl");
        ledger.recordQueued(session, { id: "wrapper-human-delivery", text, origin: { kind: "operator" } }, "turn-started");
        ledger.confirmDelivered(session, "wrapper-human-delivery", "wrapper-user");
      }
      readFixtures(f.h, { "/codex/stage-1.jsonl": file });
      await tickPipelines([], f.h.ports);
      if (mode !== "running" && author === "harness") expect(loadPipelines()[0]!.stateDetail).toMatch(/Automatic retry|Автоповтор/);
      f.advance(180_000);
      await tickPipelines([], f.h.ports);
      await tickPipelines([], f.h.ports);
      expect(f.sends).toHaveLength(mode === "running" && author === "harness" ? 1 : 0);
      expect(f.h.spawnInputs).toHaveLength(mode !== "running" && author === "harness" ? 2 : 1);
      if (author !== "harness") expect(loadPipelines()[0]!.stateDetail).toContain("newer stage activity");
    });
  }
}
