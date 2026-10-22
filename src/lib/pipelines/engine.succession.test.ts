import { expect, test, fs, tickPipelines, loadPipelines, savePipelines, patchPipeline, entry, harness, create, forbiddenSleep, runningStructuredStage, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, HOST_UNAVAILABLE, failedReceipt, expectProviderParkAt, providerRecoveryHarness } from "./engine.fixture";
import type { PipelinePorts } from "./engine.fixture";

test.each(["continuation", "capacity"] as const)("a legacy %s quota park whose stated reset passed retries without operator input", async (cause) => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  const legacy = loadPipelines()[0]!;
  const attempt = legacy.runs[0]!.attempts[0]!;
  delete attempt.providerWait!.stageRetry;
  const recovery = attempt.providerRecoveries!.at(-1)!;
  if (cause === "capacity") {
    recovery.summary = "account capacity recovery exhausted";
    attempt.providerWait!.capacityProbes = 3;
    legacy.stateDetail = attempt.error = `stage cut by ${attempt.providerWait!.condition.label}: no account capacity returned; capacity recovery exhausted after 3 due probes`;
  } else legacy.stateDetail = attempt.error = recovery.summary;
  savePipelines([legacy]);
  f.advance(180_000);
  await tickPipelines([], { ...f.h.ports });
  expect(f.h.spawnInputs).toHaveLength(2);
});


test("a native Claude weekly reset remains authoritative over an earlier cached session reset", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit");
  f.advance(Date.parse("2026-10-02T00:16:00Z") - f.now());
  const earlyReset = f.now() + 60 * 60_000;
  f.h.ports.claudeAccountReset = () => earlyReset / 1_000;
  readFixtures(f.h, { "/codex/stage-1.jsonl": stageTranscript("native-weekly-cached-session-reset", [{
    type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your weekly limit · resets Oct 9 at 2:30pm (UTC)" }] },
  }]) });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!.resetsAt).toBe(Date.parse("2026-10-09T14:30:00Z") / 1_000);
  f.advance(earlyReset + 60_000 - f.now());
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(loadPipelines()[0]!.state).toBe("running");
});


test("three delayed auth race continuations exhaust with the provider cause", async () => {
  const f = await providerRecoveryHarness("claude", "server_error", "Failed to refresh OAuth token: retry in a minute");
  for (let n = 0; n < 3; n += 1) {
    f.cut();
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(n);
    f.advance(60_000 * 2 ** n);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(n + 1);
    f.advance(1_000);
  }
  f.cut();
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("auth refresh race after 3 tries");
});


test.each([false, true])("a silent dead read-write host relaunches with WIP and parks on its second death, inherited=%s", async (inherited) => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  let now = Date.parse(h.ports.now());
  h.ports.now = () => new Date(now).toISOString();
  const inheritedMessage = inherited ? { text: "Earlier stage output", ts: now - 60_000 } : null;
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: inheritedMessage, launchOnly: !inherited });
  const launchId = loadPipelines()[0]!.runs[0]!.attempts[0]!.launchId;
  const stoppedLaunches: Array<string | null | undefined> = [];
  h.ports.stopStageAgent = async (target) => {
    stoppedLaunches.push(target.launchId);
    return target.launchId ? { outcome: "not-running" } : { outcome: "failed", error: "missing launch identity" };
  };
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("stage host died without output");
  now += 30_000;
  await tickPipelines([], h.ports);
  expect(stoppedLaunches).toEqual([launchId]);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(2);
  expect(h.spawnInputs[1]!.prompt).toContain("Its changes remain in this worktree");
  expect(h.calls.some((call) => /reset|clean/.test(call))).toBe(false);
  const pipeline = loadPipelines()[0]!;
  pipeline.runs[0]!.attempts[1]!.paneId = null;
  savePipelines([pipeline]);
  h.durableTurns.set("/codex/stage-2.jsonl", { turn: "busy", message: null, launchOnly: true });
  await tickPipelines([], h.ports);
  now += 30_000;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("died without output twice");
  expectProviderParkAt(loadPipelines()[0]!, h.ports.now());
  expect(h.spawnInputs).toHaveLength(2);
});


test("a silent dead pane-hosted stage relaunches with WIP after the bounded wait", async () => {
  const h = harness();
  await runningStructuredStage(h);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.paneId = "%cut-stage";
  savePipelines([lane]);
  h.setPaneAlive(false);
  h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", message: null, launchOnly: true });
  await tickPipelines([{ ...entry("/codex/stage-1.jsonl"), activity: "live" }], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("stage host died without output");
  h.advanceWallClock(30_000);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.spawnInputs).toHaveLength(2);
  expect(h.spawnInputs[1]!.prompt).toContain("keeping uncommitted work");
  expect(h.calls.some((call) => /reset|clean/.test(call))).toBe(false);
});


test("audit item B: a Codex turn_aborted resumes with WIP and never requests a verdict or spends a fix round", async () => {
  const h = harness();
  await runningStructuredStage(h);
  h.setConversationActive(false);
  let now = Date.parse(h.ports.now());
  h.ports.now = () => new Date(now).toISOString();
  const cutAt = now;
  const artifact = stageTranscript("aborted-stage", [
    { timestamp: new Date(now - 1_000).toISOString(), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: new Date(now).toISOString(), type: "event_msg", payload: { type: "turn_aborted" } },
  ]);
  readFixtures(h, { "/codex/stage-1.jsonl": artifact });
  const sent: Parameters<NonNullable<PipelinePorts["resumeSeveredTurn"]>>[0][] = [];
  h.ports.resumeSeveredTurn = async (input) => { sent.push(input); return true; };
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("aborted stage turn");
  now = cutAt + 30_000;
  await tickPipelines([], h.ports);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toContain("keeping uncommitted work");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRequest).toBeUndefined();
  expect(loadPipelines()[0]!.cursor?.stageId).toBe("plan");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict).toBeNull();
  expect(h.calls.some((call) => /reset|clean/.test(call))).toBe(false);
});


test("unknown resets retain the three-continuation bound across repeated limit turns", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit");
  for (let n = 0; n < 3; n += 1) {
    f.cut();
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("running");
    f.advance(30 * 60_000);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(n + 1);
    f.advance(1_000);
  }
  f.cut();
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("weekly limit");
});


test.each([false, true])("a busy resumed turn retires the old unknown-reset wait, assistant progress=%s", async (assistantProgress) => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit");
  await tickPipelines([], f.h.ports);
  f.advance(30 * 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  f.advance(1_000);
  f.h.durableTurns.set("/codex/stage-1.jsonl", { turn: "busy", lastRecordAt: f.now(),
    message: assistantProgress ? { text: "Working on the current stage", ts: f.now() } : null });
  f.advance(6 * 60 * 60_000);
  await tickPipelines([], f.h.ports);
  const active = loadPipelines()[0]!;
  expect(active.state).toBe("running");
  expect(active.stateDetail).toBeNull();
  expect(active.runs[0]!.attempts[0]!.providerWait).toBeUndefined();
  // A started turn retires its old cut; only agent output clears expenditure.
  expect(active.runs[0]!.attempts[0]!.providerRecoveryBudget?.tries).toBe(assistantProgress ? undefined : 1);
  expect(f.sends).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
});


for (const pinned of [false, true]) {
  test(`authentication required with no permitted switch parks with its condition, pinned=${pinned}`, async () => {
    const f = await providerRecoveryHarness("claude", "authentication_failed", "OAuth session expired and could not be refreshed", null, pinned);
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("needs_decision");
    expect(loadPipelines()[0]!.stateDetail).toContain("authentication required");
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRequest).toBeUndefined();
    expect(f.sends).toHaveLength(0);
  });
}


test("authentication required switches an unpinned Claude stage to an allowed account", async () => {
  const f = await providerRecoveryHarness("claude", "authentication_failed", "expired");
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "claude", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  const switches: string[] = [];
  f.h.ports.requestConversationReseat = async (_id, account) => { switches.push(account); };
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(switches).toEqual([]);
  expect(f.sends).toHaveLength(0);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
  expect(loadPipelines()[0]!.state).toBe("running");
});


test("Codex auth failover launches the selected allowed account and excludes failed credentials", async () => {
  const f = await providerRecoveryHarness("codex", "unauthorized", "expired");
  f.h.ports.resolveProjectSpawn = (_engine, input) => input.unavailableIds?.includes(SPARE_ACCOUNT)
    ? { kind: "unavailable", allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] }
    : { kind: "available", account: { engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } };
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[1]!;
  attempt.accountId = SPARE_ACCOUNT;
  attempt.paneId = null;
  savePipelines([lane]);
  f.h.durableTurns.set("/codex/stage-2.jsonl", { turn: "terminal", message: null,
    terminalProviderMessage: { errorClass: "unauthorized", text: "expired", ts: f.now() + 1_000 } });
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("authentication required");
  expect(f.h.spawnInputs).toHaveLength(2);
});


test("a legacy parked hostless failover returns to pending capacity recovery", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  const lane = loadPipelines()[0]!;
  const retry = lane.runs[0]!.attempts[1]!;
  lane.state = "needs_decision";
  lane.stateDetail = `rate limited until ${new Date(f.resetsAt! * 1_000).toISOString()}, account B`;
  retry.state = "needs_decision";
  retry.error = lane.stateDetail;
  delete retry.providerWait;
  savePipelines([lane]);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "exhausted", resetsAt: f.resetsAt, allowedAccountIds: [LIMITED_ACCOUNT] });
  await tickPipelines([], f.h.ports);
  const waiting = loadPipelines()[0]!;
  expect(waiting.state).toBe("running");
  expect(waiting.cursor?.state).toBe("pending");
  expect(waiting.stateDetail).toContain("waiting for codex usage limit");
  f.advance(180_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: LIMITED_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(LIMITED_ACCOUNT);
  expect(loadPipelines()[0]!.cursor?.state).toBe("running");
});


test("a failover account lookup failure retains its named park and original timestamp", async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: {
    engine: "codex", accountId: SPARE_ACCOUNT, kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  let lookups = 0;
  f.h.ports.resolveProjectSpawn = () => { lookups += 1; throw new Error("project account bindings are unreadable"); };
  await tickPipelines([], f.h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  const at = parked.runs[0]!.attempts[1]!.completedAt!;
  for (let tick = 0; tick < 32; tick += 1) {
    f.advance(30 * 60_000);
    await tickPipelines([], f.h.ports);
  }
  expect(lookups).toBe(1);
  expect(parked.stateDetail).toContain("usage limit: account capacity lookup unavailable");
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.completedAt).toBe(at);
  expectProviderParkAt(loadPipelines()[0]!, at);
  expect(f.h.spawnInputs).toHaveLength(1);
});


test("a failed staged read-write receipt that settled before retry is never stopped", async () => {
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, engine: "codex", access: "read-write", prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports);
  h.ports.spawnAgent = async (_input, reserved) => {
    await reserved({ launchId: "launch-recovered", conversationId: "conversation_recovered" });
    throw new Error(HOST_UNAVAILABLE);
  };
  h.ports.spawnReceipt = () => ({ ...failedReceipt("launch-recovered", "conversation_recovered", HOST_UNAVAILABLE), staged: true });
  let stopped = 0;
  h.ports.stopStageAgent = async () => { stopped += 1; return { outcome: "stopped" }; };
  h.ports.claimSpawnRetry = () => "settled";
  h.ports.sleep = forbiddenSleep;
  await tickPipelines([], h.ports);
  expect(stopped).toBe(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.retiredLaunches).toBeUndefined();
});


test.each(["codex", "claude"] as const)("an open scan keeps a provider continuation fenced by pending delivery (%s)", async (engine) => {
  const f = await providerRecoveryHarness(engine, "stream_disconnected", "stream disconnected");
  await tickPipelines([], f.h.ports);
  f.advance(60_000);
  await tickPipelines([], f.h.ports);
  expect(f.sends).toHaveLength(1);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  f.h.setConversationActive(null);
  const recovered: PipelinePorts = { ...f.h.ports,
    restartRecoveryBootId: () => "pending-provider",
    conversationTurnInterrupted: async () => "idle",
    conversationDeliveryOutstanding: () => true,
    conversationDeliveryCompleted: () => false,
  };
  const open = { ...entry(attempt.agentPath!), activity: "live" as const, activityReason: "jsonl_turn_open" as const };
  for (let tick = 0; tick < 3; tick += 1) {
    await tickPipelines([open], recovered);
    f.advance(60_000);
  }
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.sends).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.actionAt).toBeDefined();
});



for (const pool of [false, true]) {
  test.each(["10pm", "11pm"] as const)(`parked harness quota notice persists its named %s reset (pool=${pool})`, async resetClock => {
    const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", null, !pool);
    f.advance(Date.parse("2026-10-05T16:54:09Z") - f.now());
    const originalReset = Date.parse("2026-10-05T19:00:00Z") / 1_000;
    const expectedReset = Date.parse(resetClock === "10pm" ? "2026-10-05T19:00:00Z" : "2026-10-05T20:00:00Z") / 1_000;
    f.h.ports.claudeAccountReset = () => originalReset;
    f.h.ports.allowedAccountIds = () => pool ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT];
    f.h.ports.resolveProjectSpawn = () => f.now() >= expectedReset * 1_000 + 60_000
      ? { kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
      : { kind: "exhausted", resetsAt: expectedReset, allowedAccountIds: pool ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT] };
    const lane = loadPipelines()[0]!;
    const attempt = lane.runs[0]!.attempts[0]!;
    attempt.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now(), ...(pool ? { triedAccounts: [LIMITED_ACCOUNT, SPARE_ACCOUNT] } : {}) };
    if (pool) {
      attempt.accountId = SPARE_ACCOUNT;
      attempt.usageLimitedAccounts = [{ accountId: LIMITED_ACCOUNT, engine: "claude", resetsAt: originalReset, limitedAt: f.now() - 1_000 }];
    }
    savePipelines([lane]);
    const notice = (clock: string) => ({ type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: `You've hit your session limit · resets ${clock} (Europe/Kyiv)` }] } });
    const records: Record<string, unknown>[] = [notice("10pm")];
    const file = stageTranscript("named-harness-reset", records);
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.stageRetry).toBeDefined();
    f.advance(116_000);
    records.push({ type: "user", timestamp: f.h.ports.now(), origin: { kind: "task-notification" }, turnOrigin: "task_notification", promptSource: "system",
      message: { role: "user", content: "<task-notification><task-id>background</task-id><status>completed</status></task-notification>" } });
    f.advance(500);
    records.push(notice(resetClock));
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    await tickPipelines([], f.h.ports);
    const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!;
    expect(wait.turnTs).toBe(f.now());
    // The pool can retry the source's earlier window while the spare still waits.
    const due = pool ? originalReset : expectedReset;
    expect(wait.resumeAt).toBe(new Date(due * 1_000 + 60_000).toISOString());
    expect(wait.stageRetry?.detail).toBe(loadPipelines()[0]!.stateDetail!);
    // Source selection sees its own reset even if the spare named a later one.
    f.h.ports.resolveProjectSpawn = () => f.now() >= due * 1_000 + 60_000
      ? { kind: "available", account: { engine: "claude", accountId: LIMITED_ACCOUNT, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } }
      : { kind: "exhausted", resetsAt: due, allowedAccountIds: pool ? [LIMITED_ACCOUNT, SPARE_ACCOUNT] : [LIMITED_ACCOUNT] };
    while (f.now() < due * 1_000 + 120_000) { f.advance(30_000); await tickPipelines([], f.h.ports); }
    expect(f.h.spawnInputs).toHaveLength(2);
    // Several hundred controller passes cover the full reset window; let them
    // finish before the next fixture replaces their shared isolated store.
  }, 30_000);
}


test.each(["running", "parked"] as const)("%s quota wait retains a human prompt removed by shutdown normalization", async mode => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your session limit", 120_000, true);
  if (mode === "parked") {
    const lane = loadPipelines()[0]!;
    lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 3, startedAt: f.h.ports.now() };
    savePipelines([lane]);
  }
  await tickPipelines([], f.h.ports);
  const cutAt = f.h.ports.now();
  f.advance(1_000);
  readFixtures(f.h, { "/codex/stage-1.jsonl": stageTranscript(`shutdown-human-${mode}`, [
    { type: "assistant", timestamp: cutAt, isApiErrorMessage: true, error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } },
    { type: "user", timestamp: f.h.ports.now(), origin: { kind: "human" }, promptSource: "typed", isMeta: true, message: { role: "user", content: "Wait for my answer" } },
    { type: "user", timestamp: new Date(f.now() + 1).toISOString(), interruptedByShutdown: true, message: { role: "user", content: "[Request interrupted by user]" } },
    { type: "assistant", timestamp: new Date(f.now() + 2).toISOString(), message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } },
  ]) });
  f.advance(180_000);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.sends).toHaveLength(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.retryCancelled).toBe(true);
});



for (const engine of ["claude", "codex"] as const) {
  test.each(["after-cut", "before-cut"] as const)(`${engine} first recovery tick respects pause and resume %s`, async timing => {
    const f = await providerRecoveryHarness(engine, engine === "claude" ? "rate_limit" : "usage_limit_exceeded", "You've hit your session limit", 120_000, true);
    const initial = f.now();
    f.advance(1_000);
    const lane = loadPipelines()[0]!;
    await patchPipeline(lane.id, { action: "pause" }, f.h.ports);
    f.advance(1_000);
    await patchPipeline(lane.id, { action: "resume" }, f.h.ports);
    f.advance(1_000);
    const cut = timing === "after-cut" ? initial : f.now();
    const file = stageTranscript(`first-tick-control-${engine}-${timing}`, engine === "claude" ? [
      { type: "assistant", timestamp: new Date(cut).toISOString(), isApiErrorMessage: true, error: "rate_limit", message: { model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "You've hit your session limit" }] } },
    ] : [
      { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "task_complete", error: { message: "You've hit your usage limit", codex_error_info: "usage_limit_exceeded" } } },
    ]);
    readFixtures(f.h, { "/codex/stage-1.jsonl": file });
    await tickPipelines([], f.h.ports);
    f.advance(31 * 60_000);
    await tickPipelines([], f.h.ports);
    expect(f.sends).toHaveLength(timing === "after-cut" ? 0 : 1);
    if (timing === "after-cut") {
      expect(loadPipelines()[0]!.state).toBe("needs_decision");
      expect(loadPipelines()[0]!.stateDetail).toContain("operator control");
    }
  });
}
