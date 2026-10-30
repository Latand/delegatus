import { expect, test, path, selectProjectAccount, tickPipelines, loadPipelines, savePipelines, loadTasks, saveTasks, patchPipeline, LIMITED_ACCOUNT, SPARE_ACCOUNT, recoveryReport, providerRecoveryHarness } from "./engine.fixture";
import type { DurableQuotaObservation } from "./engine.fixture";

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
