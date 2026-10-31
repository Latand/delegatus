import { expect, test, loadPipelines, savePipelines, providerRecoveryHarness, defaultPipelinePorts,
  LIMITED_ACCOUNT, SPARE_ACCOUNT, selectProjectAccount, tickPipelines, finishReported, recoveryReport } from "./engine.fixture";
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

for (const random of [0, 0.5, 1]) test(`capacity backoff caps old persisted counters with jitter sample ${random}`, async () => {
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

for (const relaunch of [false, true]) for (const sourceAllowed of [true, false]) test(`capacity ignores an excluded stale migration target with source allowed=${sourceAllowed}, relaunch=${relaunch}`, async () => {
  const f = await capacityStage(false);
  if (relaunch) f.h.ports.resumeSeveredTurn = undefined;
  f.h.ports.allowedAccountIds = () => sourceAllowed ? [LIMITED_ACCOUNT] : [SPARE_ACCOUNT];
  f.h.ports.conversationMigration = () => ({ targetId: "excluded-target", retry: true });
  await f.recover();
  f.advance(54_000);
  await f.recover();
  expect(f.sends).toHaveLength(sourceAllowed && !relaunch ? 1 : 0);
  expect(f.selections).toHaveLength(0);
  const attempts = loadPipelines()[0]!.runs[0]!.attempts;
  expect(attempts).toHaveLength(sourceAllowed && relaunch ? 2 : 1);
  const attempt = attempts.at(-1)!;
  expect(attempt.accountId).toBe(LIMITED_ACCOUNT);
  expect(attempt.providerWait!.tries).toBe(sourceAllowed ? 1 : 0);
});

for (const admission of ["allowed", "revoked", "substituted", "unreadable", "pinned"] as const) test(`capacity relaunch after quota retains its source at pending admission (${admission})`, async () => {
  const f = await providerRecoveryHarness("codex", "usage_limit_exceeded", "You've hit your usage limit", 120_000);
  const lane = loadPipelines()[0]!;
  f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
  const requests: Array<string | null | undefined> = [];
  let pendingAdmission = false;
  f.h.ports.resolveProjectSpawn = (engine, request) => {
    requests.push(request.requestedId);
    if (pendingAdmission && admission === "unreadable") throw new Error("account selection unavailable");
    const selected = selectProjectAccount({ ...request, engine, now: f.now(),
      accounts: [LIMITED_ACCOUNT, SPARE_ACCOUNT].map(id => ({ id, authPresent: true })),
      bindings: (pendingAdmission && admission === "revoked" ? [LIMITED_ACCOUNT] : [LIMITED_ACCOUNT, SPARE_ACCOUNT])
        .map(accountId => ({ engine, accountId, project: lane.project, createdAt: f.h.ports.now() })),
      observations: [],
    });
    return selected.kind === "available" ? { kind: "available", account: { engine, kind: "managed",
      accountId: pendingAdmission && admission === "substituted" ? LIMITED_ACCOUNT : selected.accountId!,
      home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } } : selected;
  };
  await tickPipelines([], f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe(SPARE_ACCOUNT);
  f.advance(240_000);
  const cutLane = loadPipelines()[0]!, cut = cutLane.runs[0]!.attempts[1]!;
  if (admission === "pinned") {
    cutLane.stages[0]!.account = SPARE_ACCOUNT;
    cut.definition!.account = SPARE_ACCOUNT;
  }
  cut.effectiveRole.serviceTier = "priority";
  const role = structuredClone(cut.effectiveRole);
  savePipelines([cutLane]);
  f.h.ports.resumeSeveredTurn = undefined;
  f.h.setConversationActive(false);
  f.h.durableTurns.set(cut.agentPath!, { turn: "terminal", message: null,
    terminalProviderMessage: { text: capacityText, errorClass: "server_overloaded", ts: f.now() } });
  await tickPipelines([], f.h.ports);
  f.advance(120_000);
  await tickPipelines([], f.h.ports);
  const pending = loadPipelines()[0]!.runs[0]!.attempts[2]!;
  expect(pending.usageLimitedAccounts).toEqual(cut.usageLimitedAccounts);
  expect(pending.runtimeAccountPin ?? null).toBe(admission === "pinned" ? SPARE_ACCOUNT : null);
  pendingAdmission = true;
  if (admission === "revoked") f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT];
  await tickPipelines([], f.h.ports);
  expect(requests.at(-1)).toBe(SPARE_ACCOUNT);
  const held = ["revoked", "substituted", "unreadable"].includes(admission);
  expect(f.h.spawnInputs).toHaveLength(held ? 2 : 3);
  if (held) {
    const budget = structuredClone(pending.providerRecoveryBudget);
    const wait = structuredClone(pending.providerWait!);
    // Stay denied past the quota probe and elapsed-time limits. Each tick
    // reloads the saved pending attempt without spending another retry.
    for (const elapsed of [0, 0, 6 * 60 * 60_000]) {
      const current = loadPipelines()[0]!.runs[0]!.attempts[2]!;
      f.advance(Date.parse(current.providerWait!.resumeAt) - f.now() + elapsed);
      await tickPipelines([], f.h.ports);
      const saved = loadPipelines()[0]!;
      expect(saved.state).toBe("running");
      expect(saved.cursor!.state).toBe("pending");
      expect(saved.runs[0]!.attempts[2]!).toMatchObject({ state: "pending", accountId: SPARE_ACCOUNT,
        providerRecoveryBudget: budget, effectiveRole: role,
        providerWait: { accountId: SPARE_ACCOUNT, tries: wait.tries, condition: wait.condition } });
      expect(saved.runs[0]!.attempts[2]!.providerWait!.stageRetry).toBeUndefined();
      expect(saved.runs[0]!.attempts[2]!.providerWait!.retryCancelled).toBeUndefined();
      expect(f.h.spawnInputs).toHaveLength(2);
    }
    if (admission === "revoked") {
      const retryAt = loadPipelines()[0]!.runs[0]!.attempts[2]!.providerWait!.resumeAt;
      const source = `import {defaultPipelinePorts,tickPipelines} from "./src/lib/pipelines/engine.ts";
        import {loadPipelines} from "./src/lib/pipelines/store.ts";
        import {selectProjectAccount} from "./src/lib/accounts/projectSelection.ts";
        import {registerPipelineTick} from "./src/lib/pipelines/controllerSignal.ts";
        registerPipelineTick(async()=>{});
        let reads=0;
        const ports={...defaultPipelinePorts(),now:()=>${JSON.stringify(retryAt)},
          drainHold:()=>null,structuredDeliveryPublication:()=>"ready",
          cpuAdmissionReconcile:undefined,cpuPressureHold:undefined,cpuAdmissionSuspend:undefined,
          scheduleTick:()=>{},allowedAccountIds:()=>[${JSON.stringify(LIMITED_ACCOUNT)}],
          resolveProjectSpawn:(engine,request)=>{reads++;return selectProjectAccount({...request,engine,
            now:Date.parse(${JSON.stringify(retryAt)}),accounts:[{id:${JSON.stringify(SPARE_ACCOUNT)},authPresent:true}],
            bindings:[{engine,accountId:${JSON.stringify(LIMITED_ACCOUNT)},project:request.project,
              createdAt:${JSON.stringify(retryAt)}}],observations:[]});},
          spawnAgent:async()=>{throw new Error("denied source cannot spawn");}};
        await tickPipelines([],ports);
        const lane=loadPipelines()[0];
        console.log(JSON.stringify({reads,state:lane.state,attempt:lane.runs[0].attempts[2]}));`;
      const child = Bun.spawn({ cmd: [process.execPath, "-e", source], env: process.env, stdout: "pipe", stderr: "pipe" });
      try {
        const [output, errors, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect({ code, errors }).toMatchObject({ code: 0 });
        const observed = JSON.parse(output);
        expect(observed.reads).toBe(1);
        expect(observed.state).toBe("running");
        expect(observed.attempt).toMatchObject({ state: "pending", providerRecoveryBudget: budget,
          providerWait: { accountId: SPARE_ACCOUNT, tries: wait.tries } });
        expect(observed.attempt.providerWait.stageRetry).toBeUndefined();
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    }
    pendingAdmission = false;
    f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
    f.advance(Date.parse(loadPipelines()[0]!.runs[0]!.attempts[2]!.providerWait!.resumeAt) - f.now());
    await tickPipelines([], f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("running");
    expect(f.h.spawnInputs).toHaveLength(3);
    expect(loadPipelines()[0]!.runs[0]!.attempts[2]!.providerRecoveryBudget).toEqual(budget);
  }
  if (f.h.spawnInputs.length === 3) expect(f.h.spawnInputs[2]!).toMatchObject({ requestedAccountId: SPARE_ACCOUNT, role });
  expect(loadPipelines()[0]!.worktreeDir).toBe(lane.worktreeDir);
});

for (const tries of [0, 3]) test(`an older capacity timer retains its ${tries} spent retries without account selection`, async () => {
  const f = await capacityStage(false);
  await f.recover();
  const lane = loadPipelines()[0]!, attempt = lane.runs[0]!.attempts[0]!;
  // Replay the timer older versions added to a real saved capacity cut.
  const detail = "stage cut by model at capacity";
  attempt.providerWait!.tries = tries;
  attempt.providerRecoveryBudget!.tries = tries;
  attempt.providerWait!.stageRetry = { controlGeneration: lane.controlGeneration ?? null, detail, fallback: false };
  attempt.state = "needs_decision";
  attempt.completedAt = f.h.ports.now();
  attempt.error = detail;
  lane.state = "needs_decision";
  lane.stateDetail = detail;
  savePipelines([lane]);
  await tickPipelines([], f.h.ports);
  const restored = loadPipelines()[0]!;
  expect(restored.state).toBe(tries === 3 ? "needs_decision" : "running");
  expect(restored.runs[0]!.attempts[0]!.providerWait!.stageRetry).toBeUndefined();
  expect(restored.runs[0]!.attempts[0]!.providerWait!.tries).toBe(tries);
  f.advance(54_000);
  await f.recover();
  expect(f.sends).toHaveLength(tries === 3 ? 0 : 1);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.selections).toHaveLength(0);
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
  expect(successor.effectiveRole).toEqual(f.lane.runs[0]!.attempts[0]!.effectiveRole);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs.at(-1)!.requestedAccountId).toBe(LIMITED_ACCOUNT);
  expect(f.h.spawnInputs.at(-1)!.role.serviceTier).toBe("priority");
  expect(f.selections).toHaveLength(0);
});
