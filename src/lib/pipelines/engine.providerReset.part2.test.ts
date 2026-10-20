import { expect, test, tickPipelines, loadPipelines, savePipelines, LIMITED_ACCOUNT, SPARE_ACCOUNT, providerRecoveryHarness } from "./engine.fixture";

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
}, 240_000);


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
