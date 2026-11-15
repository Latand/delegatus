import { expect, test, tickPipelines, loadPipelines, savePipelines, patchPipeline, entry, harness, create, forbiddenSleep, LIMITED_ACCOUNT, SPARE_ACCOUNT, stageTranscript, readFixtures, HOST_UNAVAILABLE, failedReceipt, expectProviderParkAt, providerRecoveryHarness } from "./engine.fixture";
import type { PipelinePorts } from "./engine.fixture";

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
