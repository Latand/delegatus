import { expect, spyOn, test, crypto, spawn, path, ProjectAccountRefusedError, defaultPipelinePorts, tickPipelines, AgentRegistry, setAgentRegistryForTests, loadPipelines, savePipelines, patchPipeline, LIMITED_ACCOUNT, SPARE_ACCOUNT, recoveryReport, parkedAccountCases, parkedAccountHarness } from "./engine.fixture";

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
