import { expect, test, loadPipelines, savePipelines, providerRecoveryHarness, defaultPipelinePorts,
  LIMITED_ACCOUNT, SPARE_ACCOUNT, tickPipelines, finishReported, recoveryReport } from "./engine.fixture";
import { recoverPipelineProviderTurn } from "./engine";

const capacityText = "Selected model is at capacity. Please try again later.";

async function capacityStage(pinned: boolean, random = 0.5) {
  const f = await providerRecoveryHarness("codex", "server_overloaded", capacityText, null, pinned);
  // Build production recovery ports, replacing randomness and external I/O.
  const built = defaultPipelinePorts({ providerRecoveryRandom: () => random });
  f.h.ports.providerRecoveryRandom = built.providerRecoveryRandom;
  const lane = loadPipelines()[0]!, attempt = lane.runs[0]!.attempts[0]!;
  attempt.accountId = LIMITED_ACCOUNT;
  attempt.effectiveRole.serviceTier = "priority";
  savePipelines([lane]);
  const selections: unknown[] = [];
  f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
  f.h.ports.resolveProjectSpawn = (_engine, request) => {
    selections.push(request);
    throw new Error("capacity must not select another account");
  };
  const sends: Array<Parameters<NonNullable<typeof f.h.ports.resumeSeveredTurn>>[0]> = [];
  f.h.ports.resumeSeveredTurn = async input => {
    if (!await input.continuationAllowed!()) return false;
    sends.push(input);
    f.h.setConversationActive(true);
    return true;
  };
  const wakes: number[] = [];
  f.h.ports.scheduleTick = delay => { wakes.push(delay); };
  const recover = () => recoverPipelineProviderTurn(lane.id, f.h.ports);
  return { ...f, lane, recover, selections, sends, wakes };
}

for (const pinned of [false, true]) {
  test(`capacity twice then success continues the same account with exponential jitter (pinned=${pinned})`, async () => {
    const f = await capacityStage(pinned);
    const original = structuredClone(f.lane.runs[0]!.attempts[0]!);
    for (const [index, delay] of [54_000, 108_000].entries()) {
      await f.recover();
      let lane = loadPipelines()[0]!;
      expect(lane.state).toBe("running");
      expect(lane.runs[0]!.attempts).toHaveLength(1);
      expect(lane.runs[0]!.attempts[0]!.providerWait!.resumeAt).toBe(new Date(f.now() + delay).toISOString());
      expect(f.wakes).toContain(delay);
      f.advance(delay - 1);
      await f.recover();
      expect(f.sends).toHaveLength(index);
      f.advance(1);
      await f.recover();
      expect(f.sends).toHaveLength(index + 1);
      lane = loadPipelines()[0]!;
      expect(lane.runs[0]!.attempts[0]!).toMatchObject({ accountId: LIMITED_ACCOUNT,
        launchId: original.launchId, conversationId: original.conversationId, effectiveRole: original.effectiveRole });
      expect(lane.worktreeDir).toBe(f.lane.worktreeDir);
      f.advance(1_000);
      f.h.setConversationActive(false);
      f.cut();
    }
    const finished = finishReported(f.h, original.agentPath!, "pass", "Stage completed");
    f.h.messages.get(original.agentPath!)!.ts = f.now();
    const completed = loadPipelines()[0]!;
    completed.runs[0]!.attempts[0]!.report = recoveryReport(f.h.ports.now());
    savePipelines([completed]);
    await tickPipelines([finished], f.h.ports);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.state).toBe("passed");
    expect(f.selections).toHaveLength(0);
    expect(f.h.spawnInputs).toHaveLength(1);
    expect(new Set(f.sends.map(input => input.clientMessageId)).size).toBe(2);
    expect(f.sends[1]!.text).toBe(f.sends[0]!.text);
  });

  test(`continued capacity parks only after three same-account retries (pinned=${pinned})`, async () => {
    const f = await capacityStage(pinned);
    for (const delay of [54_000, 108_000, 216_000]) {
      await f.recover();
      expect(loadPipelines()[0]!.state).toBe("running");
      const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!;
      expect(wait.resumeAt).toBe(new Date(f.now() + delay).toISOString());
      f.advance(delay);
      await f.recover();
      f.h.setConversationActive(false);
      f.advance(1_000);
      f.cut();
    }
    await f.recover();
    const parked = loadPipelines()[0]!;
    expect(parked.state).toBe("needs_decision");
    expect(parked.stateDetail).toContain("model at capacity after 3 tries");
    expect(parked.runs[0]!.attempts).toHaveLength(1);
    expect(parked.runs[0]!.attempts[0]!.accountId).toBe(LIMITED_ACCOUNT);
    await f.recover();
    expect(f.sends).toHaveLength(3);
    expect(f.selections).toHaveLength(0);
    expect(f.h.spawnInputs).toHaveLength(1);
  });
}

test.each([0, 0.5, 1])("capacity backoff caps old persisted counters with jitter sample %s", async random => {
  const f = await capacityStage(false, random);
  const lane = loadPipelines()[0]!;
  lane.runs[0]!.attempts[0]!.providerRecoveryBudget = { tries: 40, startedAt: f.h.ports.now() };
  savePipelines([lane]);
  await f.recover();
  const saved = loadPipelines()[0]!;
  expect(Date.parse(saved.runs[0]!.attempts[0]!.providerWait!.resumeAt) - f.now()).toBe(900_000 * (0.8 + 0.2 * random));
  expect(saved.state).toBe("needs_decision");
  expect(f.sends).toHaveLength(0);
  expect(f.selections).toHaveLength(0);
});

test("a saved migration retry cannot move a capacity cut to another account", async () => {
  const f = await capacityStage(false);
  f.h.ports.conversationMigration = () => ({ targetId: SPARE_ACCOUNT, retry: true });
  await f.recover();
  f.advance(54_000);
  await f.recover();
  expect(f.sends).toHaveLength(1);
  expect(f.selections).toHaveLength(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.accountId).toBe(LIMITED_ACCOUNT);
});

test("capacity relaunch targets the original account, model and tier at real spawn admission", async () => {
  const f = await capacityStage(false);
  f.h.ports.resumeSeveredTurn = undefined;
  await f.recover();
  f.advance(54_000);
  await f.recover();
  const successor = loadPipelines()[0]!.runs[0]!.attempts[1]!;
  expect(successor.accountId).toBe(LIMITED_ACCOUNT);
  expect(successor.runtimeAccountPin ?? null).toBeNull();
  expect(successor.providerWait!.switchedAccountId).toBe(LIMITED_ACCOUNT);
  expect(successor.effectiveRole).toEqual(f.lane.runs[0]!.attempts[0]!.effectiveRole);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs.at(-1)!.requestedAccountId).toBe(LIMITED_ACCOUNT);
  expect(f.h.spawnInputs.at(-1)!.role.serviceTier).toBe("priority");
  expect(f.selections).toHaveLength(0);
});
