import { expect, test, harness, create, tickPipelines, loadPipelines, savePipelines, patchPipeline, providerRecoveryHarness, LIMITED_ACCOUNT, PASS_TEXT, AgentRegistry, path, fs } from "./engine.fixture";
import { selectProjectAccount } from "@/lib/accounts/projectSelection";
import { accountQuotaVerdict, selectHeadlessAccount } from "@/lib/accounts/headlessSelection";
import { ProjectAccountRefusedError } from "@/lib/accounts/manager";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

async function fixture() {
  const h = harness();
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => ({ ...await spawn(input, reserved), paneId: null });
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.accountId = "account-a";
  lane.stages[0]!.account = "account-a";
  attempt.definition!.account = "account-a";
  attempt.effectiveRole.serviceTier = "ultrafast";
  savePipelines([lane]);
  let allowed = ["account-a", "account-b"];
  const accounts = allowed.map(id => ({ id, authPresent: true }));
  const now = Date.parse(h.ports.now());
  const observations: DurableQuotaObservation[] = accounts.map(account => ({ engine: "codex", accountId: account.id,
    authenticated: true, authCheckedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), bootId: "fixture",
    provenance: { source: "live", reason: null, staleSince: null },
    limits: { session: null, weekly: { usedPercent: 50, resetsAt: now / 1000 + 86400 }, plan: "pro", capturedAt: now / 1000,
      credits: { hasCredits: true, balance: "10", unlimited: false } } }));
  h.ports.allowedAccountIds = () => allowed;
  h.ports.accountExhausted = (engine, id, model) => selectHeadlessAccount([{ id, authPresent: true }], observations, id, [], now, model).kind === "exhausted";
  h.ports.accountQuota = (engine, id, model) => accountQuotaVerdict(observations, id, now, model);
  h.ports.resolveProjectSpawn = (engine, request) => {
    const selected = selectProjectAccount({ ...request, engine, accounts, observations, now,
      bindings: allowed.map(accountId => ({ project: lane.project!, engine, accountId, createdAt: new Date(now).toISOString() })) });
    return selected.kind === "available" ? { kind: "available", account: { engine, accountId: selected.accountId!, kind: "managed",
      home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } } : selected;
  };
  const sends: string[] = [];
  h.ports.resumeSeveredTurn = async input => { sends.push(input.clientMessageId); return true; };
  h.durableTurns.set(attempt.agentPath!, { turn: "busy", message: null, lastRecordAt: now });
  return { h, lane, attempt, observations, sends, allow: (ids: string[]) => { allowed = ids; },
    current: () => loadPipelines()[0]! };
}

test.each(["binding", "credit", "exhausted", "abort"])("%s stops the old host and continues a pinned stage on an allowed account", async kind => {
  const f = await fixture();
  const stop = f.h.ports.stopStageAgent;
  f.h.ports.stopStageAgent = async (...args) => {
    expect(f.current().runs[0]!.attempts[0]!.suspension?.requestedAt).toBeDefined();
    return stop(...args);
  };
  if (kind === "binding" || kind === "abort") f.allow(["account-b"]);
  else f.observations[0]!.limits!.weekly!.usedPercent = kind === "credit" ? 99 : 100;
  if (kind === "abort") f.h.durableTurns.set(f.attempt.agentPath!, { turn: "terminal", message: null,
    terminalProviderMessage: { ts: Date.parse(f.h.ports.now()), text: "aborted", errorClass: "turn_aborted" } });
  await tickPipelines([], f.h.ports);
  const next = f.current().runs[0]!.attempts[1]!;
  expect(f.h.calls).toContain("stop-host:build:1:conversation_stage_1");
  expect(next).toMatchObject({ accountId: "account-b", input: f.attempt.input,
    restartContext: { previousAttempt: 1, transcriptPath: f.attempt.agentPath }, effectiveRole: { serviceTier: "ultrafast" } });
  expect(f.current().worktreeDir).toBe(f.lane.worktreeDir);
  expect(f.sends).toEqual([]);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs.at(-1)).toMatchObject({ requestedAccountId: "account-b", requireAccountCapacity: true, cwd: f.lane.worktreeDir });
});

test("pause stops a running turn; restart keeps it stopped; resume continues on the newly allowed account", async () => {
  const f = await fixture();
  expect((await patchPipeline(f.lane.id, { action: "pause" }, f.h.ports)).error).toBeUndefined();
  expect(f.current().state).toBe("paused");
  expect(f.current().runs[0]!.attempts[0]!.suspension?.stoppedAt).toBeDefined();
  f.allow(["account-b"]);
  await tickPipelines([], { ...f.h.ports });
  expect(f.current().runs[0]!.attempts).toHaveLength(1);
  expect(f.sends).toEqual([]);
  await patchPipeline(f.lane.id, { action: "resume" }, f.h.ports);
  await tickPipelines([], { ...f.h.ports });
  expect(f.current().runs[0]!.attempts[1]!.accountId).toBe("account-b");
});

test("an aborted turn cannot settle an older assistant verdict during account recovery", async () => {
  const f = await fixture();
  f.allow(["account-b"]);
  const now = Date.parse(f.h.ports.now());
  f.h.durableTurns.set(f.attempt.agentPath!, { turn: "terminal", message: { ts: now + 1, text: PASS_TEXT },
    terminalProviderMessage: { ts: now + 2, text: "aborted", errorClass: "turn_aborted" } });
  await tickPipelines([], f.h.ports);
  expect(f.current().runs[0]!.attempts[1]!.accountId).toBe("account-b");
  expect(f.current().runs[0]!.attempts[0]!.verdict).toBeNull();
});

test.each(["binding", "credit"])("retry-stage admits %s evacuation while delivery settles and preserves the checkout", async kind => {
  const f = await fixture();
  if (kind === "binding") f.allow(["account-b"]);
  else f.observations[0]!.limits!.weekly!.usedPercent = 99;
  let outstanding = true;
  f.h.ports.conversationDeliveryOutstanding = () => outstanding;
  const request = { action: "retry-stage" as const, expectedStageId: "build", expectedAttempt: 1 };
  expect((await patchPipeline(f.lane.id, request, f.h.ports)).error).toBeUndefined();
  expect(f.current().runs[0]!.attempts).toHaveLength(1);
  expect(f.current().runs[0]!.attempts[0]!.suspension?.stoppedAt).toBeDefined();
  outstanding = false;
  await tickPipelines([], { ...f.h.ports });
  expect(f.current().runs[0]!.attempts[1]!.accountId).toBe("account-b");
  expect(f.h.calls.some(call => call.includes("reset --hard") || call.includes("clean -"))).toBe(false);
});

test("all accounts exhausted stop work; a newly allowed spare resumes without waiting for the old reset", async () => {
  const f = await fixture();
  f.allow(["account-a"]);
  f.observations[0]!.limits!.weekly!.usedPercent = 99;
  await tickPipelines([], f.h.ports);
  expect(f.current().runs[0]!.attempts).toHaveLength(1);
  expect(f.current().stateDetail).toContain("host stopped");
  f.allow(["account-a", "account-b"]);
  await tickPipelines([], { ...f.h.ports });
  expect(f.current().runs[0]!.attempts[1]!.accountId).toBe("account-b");
});

test("an unconfirmed stop is retried with the same operation key before any replacement", async () => {
  const f = await fixture();
  f.allow(["account-b"]);
  const keys: string[] = [];
  let confirm = false;
  f.h.ports.stopStageAgent = async (_target, options) => {
    keys.push(options!.operationId!);
    return confirm ? { outcome: "stopped" } : { outcome: "unconfirmed", operationId: options!.operationId!, detail: "pending" };
  };
  await tickPipelines([], f.h.ports);
  expect(f.current().runs[0]!.attempts).toHaveLength(1);
  confirm = true;
  await tickPipelines([], { ...f.h.ports });
  expect(keys).toHaveLength(3);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[1]);
  expect(f.current().runs[0]!.attempts).toHaveLength(2);
});

test("a newly forbidden target during host termination stays stopped until an allowed account appears", async () => {
  const f = await fixture();
  f.observations[0]!.limits!.weekly!.usedPercent = 99;
  let revoke = true;
  f.h.ports.stopStageAgent = async () => { if (revoke) f.allow(["account-a"]); revoke = false; return { outcome: "stopped" }; };
  await tickPipelines([], f.h.ports);
  expect(f.current().runs[0]!.attempts).toHaveLength(1);
  f.allow(["account-b"]);
  await tickPipelines([], f.h.ports);
  expect(f.current().runs[0]!.attempts[1]!.accountId).toBe("account-b");
});

test("guarded retry replay retains the stop key until termination is confirmed", async () => {
  const f = await fixture();
  f.allow(["account-b"]);
  const keys: string[] = [];
  f.h.ports.stopStageAgent = async (_target, options) => {
    keys.push(options!.operationId!); throw Error("runtime unavailable");
  };
  const request = { action: "retry-stage" as const, expectedStageId: "build", expectedAttempt: 1 };
  expect((await patchPipeline(f.lane.id, request, f.h.ports)).error).toBeUndefined();
  expect((await patchPipeline(f.lane.id, request, f.h.ports)).error).toBeUndefined();
  expect(new Set(keys).size).toBe(1);
  expect(f.current().runs[0]!.attempts).toHaveLength(1);
});

test("a reactivated predecessor must stop again before delivery settlement admits its successor", async () => {
  const f = await fixture();
  f.allow(["account-b"]);
  let outstanding = true, active = true, stopAllowed = true;
  const keys: string[] = [];
  f.h.ports.conversationDeliveryOutstanding = () => outstanding;
  f.h.ports.stopStageAgent = async (_target, options) => {
    keys.push(options!.operationId!);
    if (!stopAllowed) return { outcome: "unconfirmed", operationId: options!.operationId!, detail: "still active" };
    active = false; return { outcome: "stopped" };
  };
  await tickPipelines([], f.h.ports);
  expect(active).toBe(false);
  active = true; outstanding = false; stopAllowed = false;
  await tickPipelines([], f.h.ports);
  expect(active).toBe(true);
  expect(f.current().runs[0]!.attempts).toHaveLength(1);
  expect(keys[1]).not.toBe(keys[0]);
  expect(await patchPipeline(f.lane.id, { action: "override-stage", stageId: "build", account: "account-b", applyNow: true }, f.h.ports))
    .toMatchObject({ status: 409, error: expect.stringContaining("suspended") });
  stopAllowed = true;
  await tickPipelines([], f.h.ports);
  expect(active).toBe(false);
  expect(f.current().runs[0]!.attempts[1]!.accountId).toBe("account-b");
});

test("custody is rechecked after transcript reads and suspended attempts refuse late dispatch", async () => {
  const f = await fixture();
  f.allow(["account-b"]);
  let active = true, stops = 0;
  f.h.ports.stopStageAgent = async () => { stops++; active = false; return { outcome: "stopped" }; };
  const read = f.h.ports.durableTurnEvidence;
  f.h.ports.durableTurnEvidence = async (...args) => {
    const evidence = await read(...args);
    active = true;
    return evidence;
  };
  await tickPipelines([], f.h.ports);
  expect(stops).toBeGreaterThanOrEqual(2);
  expect(active).toBe(false);
  expect(f.current().runs[0]!.attempts[1]!.accountId).toBe("account-b");
  const { assertPipelineTurnAllowed } = await import("@/lib/runtime/accountCreditGuard");
  expect(() => assertPipelineTurnAllowed(f.attempt.conversationId!)).toThrow("suspended");
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, "suspended-turn-membership.json"));
  try {
    const transcript = path.join(process.env.LLV_STATE_DIR!, "guard-session.jsonl");
    fs.writeFileSync(transcript, "{}\n");
    registry.reconcileConversations([{ engine: "codex", path: transcript, accountId: "account-a", launchProfile: emptyLaunchProfile(), turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: f.h.ports.now() }]);
    const conversation = registry.conversationForPath(transcript)!;
    const lane = f.current();
    lane.runs[0]!.attempts[0]!.conversationId = conversation.id;
    savePipelines([lane]);
    registry.rememberMembership(conversation.id, { kind: "pipeline", containerId: lane.id, role: "builder", slot: "build:1", stageId: "build", stageOrder: 0, round: 1, parentConversationId: null });
    expect(() => assertPipelineTurnAllowed(conversation.id, registry)).toThrow("suspended");
  } finally { registry.close(); }
});

test("a failed continuation withdrawal still stops usage and holds replacement until withdrawal succeeds", async () => {
  const f = await fixture();
  f.allow(["account-b"]);
  let available = false;
  f.h.ports.invalidateProviderContinuation = async () => { if (!available) throw Error("runtime unavailable"); };
  await tickPipelines([], f.h.ports);
  expect(f.current().runs[0]!.attempts[0]!.suspension?.stoppedAt).toBeDefined();
  expect(f.current().runs[0]!.attempts).toHaveLength(1);
  available = true;
  await tickPipelines([], f.h.ports);
  expect(f.current().runs[0]!.attempts[1]!.accountId).toBe("account-b");
});

test("an absent registry host still requires the recorded pane to stop", async () => {
  const f = await fixture();
  f.allow(["account-b"]);
  const lane = f.current();
  lane.runs[0]!.attempts[0]!.paneId = "%1";
  savePipelines([lane]);
  f.h.ports.stopStageAgent = async () => ({ outcome: "not-running" });
  f.h.ports.stopStagePane = async () => ({ outcome: "unknown", detail: "pane status unavailable" });
  await tickPipelines([], f.h.ports);
  expect(f.current().runs[0]!.attempts).toHaveLength(1);
  f.h.ports.stopStagePane = async () => ({ outcome: "stopped" });
  await tickPipelines([], f.h.ports);
  expect(f.current().runs[0]!.attempts[1]!.accountId).toBe("account-b");
});

test("a later operator stop fences evacuation until an explicit retry", async () => {
  const f = await fixture();
  f.allow(["account-b"]);
  let stopped = true;
  f.h.ports.conversationOperatorStopped = async () => stopped;
  await tickPipelines([], f.h.ports);
  expect(f.current().runs[0]!.attempts).toHaveLength(1);
  expect(f.current().stateDetail).toContain("operator");
  stopped = false;
  await tickPipelines([], f.h.ports);
  expect(f.current().runs[0]!.attempts).toHaveLength(1);
  await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 }, f.h.ports);
  expect(f.current().runs[0]!.attempts[1]!.accountId).toBe("account-b");
});

test("an allowed account below the credit threshold keeps its running turn and refuses a healthy retry", async () => {
  const f = await fixture();
  f.observations[0]!.limits!.weekly!.usedPercent = 98.9;
  await tickPipelines([], f.h.ports);
  expect(f.h.calls.some(call => call.startsWith("stop-host:"))).toBe(false);
  expect((await patchPipeline(f.lane.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 }, f.h.ports)).error).toContain("not confirmed stalled");
});

test("a limit wait several days away moves immediately when its credited account is exhausted", async () => {
  const f = await fixture();
  const lane = f.current();
  const attempt = lane.runs[0]!.attempts[0]!;
  const now = Date.parse(f.h.ports.now());
  attempt.providerWait = { condition: { kind: "usage_limit", label: "usage limit", resetLabel: null, scope: "usage" },
    text: "limit reached", accountId: "account-a", turnTs: now, tries: 0, startedAt: new Date(now).toISOString(),
    resumeAt: new Date(now + 3 * 86400_000).toISOString(), resetsAt: now / 1000 + 3 * 86400 };
  savePipelines([lane]);
  f.observations[0]!.limits!.weekly!.usedPercent = 100;
  await tickPipelines([], f.h.ports);
  expect(f.current().runs[0]!.attempts[1]!.accountId).toBe("account-b");
});

test.each(["binding", "credit"])("aborted continuation rechecks %s immediately before sending", async kind => {
  const f = await providerRecoveryHarness("codex", "turn_aborted", "turn aborted", null, true);
  let blocked = false;
  f.h.ports.allowedAccountIds = () => kind === "binding" && blocked ? ["account-b"] : [LIMITED_ACCOUNT, "account-b"];
  f.h.ports.accountExhausted = () => kind === "credit" && blocked;
  let admissions = 0;
  f.h.ports.resumeSeveredTurn = async input => {
    admissions++;
    blocked = true;
    expect(await input.continuationAllowed!()).toBe(false);
    return false;
  };
  await tickPipelines([], f.h.ports);
  f.advance(120_000);
  await tickPipelines([], f.h.ports);
  expect(admissions).toBe(1);
  expect(f.sends).toEqual([]);
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.suspension).toBeDefined();
});

/* Issue #3158: one account at its weekly limit, a poller that re-confirms the
   100% reading every fourth tick and lets it age in between, and a launch that
   requires capacity refusing while that reading is fresh, as the real
   requireCapacity admission does. Each tick is two minutes of controller time
   on the harness clock, which every quota read below shares. */
async function guardedAccountClock(accountIds: string[] = ["account-a"]) {
  const f = await fixture();
  f.allow(accountIds);
  let now = Date.parse(f.h.ports.now());
  const resetsAt = Math.floor(now / 1_000) + 4 * 3_600;
  const accounts = accountIds.map(id => ({ id, authPresent: true }));
  const read = (accountId: string, usedPercent: number, reset = resetsAt) => {
    const observation = f.observations.find(item => item.accountId === accountId)!;
    observation.observedAt = observation.authCheckedAt = new Date(now).toISOString();
    observation.limits = { ...observation.limits!, credits: undefined, weekly: { usedPercent, resetsAt: reset } };
  };
  for (const id of accountIds) read(id, id === "account-a" ? 100 : 20);
  f.h.ports.accountExhausted = (engine, id, model) => selectHeadlessAccount([{ id, authPresent: true }], f.observations, id, [], now, model).kind === "exhausted";
  f.h.ports.accountQuota = (engine, id, model) => accountQuotaVerdict(f.observations, id, now, model);
  f.h.ports.resolveProjectSpawn = (engine, request) => {
    const selected = selectProjectAccount({ ...request, engine, accounts, observations: f.observations, now,
      bindings: accountIds.map(accountId => ({ project: f.lane.project!, engine, accountId, createdAt: new Date(now).toISOString() })) });
    return selected.kind === "available" ? { kind: "available", account: { engine, accountId: selected.accountId!, kind: "managed",
      home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } } : selected;
  };
  const spawn = f.h.ports.spawnAgent;
  f.h.ports.spawnAgent = async (input, reserved) => {
    if (input.requireAccountCapacity && f.h.ports.accountExhausted!("codex", input.requestedAccountId!, null))
      throw new ProjectAccountRefusedError({ kind: "exhausted", resetsAt, allowedAccountIds: accountIds }, "codex", f.lane.project!);
    return spawn(input, reserved);
  };
  const advance = (ms: number) => { f.h.advanceWallClock(ms); now = Date.parse(f.h.ports.now()); };
  const attempts = () => f.current().runs[0]!.attempts;
  return { ...f, read, advance, attempts, resetsAt, now: () => now };
}

test("80 guarded ticks hold one stopped attempt until the reset, then one replacement settles", async () => {
  const f = await guardedAccountClock();
  const launches = f.h.spawnInputs.length;
  let most = 0;
  for (let tick = 0; tick < 80; tick++) {
    await tickPipelines([], f.h.ports);
    most = Math.max(most, f.attempts().length);
    if (tick % 4 === 3) f.read("account-a", 100);
    f.advance(120_000);
  }
  expect(most).toBe(1);
  expect(f.h.spawnInputs).toHaveLength(launches);
  expect(f.attempts()[0]).toMatchObject({ state: "running",
    suspension: { reason: "account", hold: { accountId: "account-a", resetsAt: f.resetsAt } } });
  expect(f.current().stateDetail).toContain(`waiting for account account-a to reset at ${new Date(f.resetsAt * 1_000).toISOString()}`);

  f.advance(f.resetsAt * 1_000 - f.now() + 60_000);
  for (let tick = 0; tick < 3; tick++) { await tickPipelines([], f.h.ports); f.advance(120_000); }
  const [first, replacement] = f.attempts();
  expect(f.attempts()).toHaveLength(2);
  expect(first).toMatchObject({ state: "failed", launchId: f.attempt.launchId, error: "the stage account reached its usage or paid-credit guard" });
  expect(replacement).toMatchObject({ accountId: "account-a", launchId: expect.any(String),
    restartContext: { previousAttempt: 1, transcriptPath: first!.agentPath } });
  expect(f.h.spawnInputs).toHaveLength(launches + 1);

  // Push settlement of this chain is proved against real receipts in
  // stageAttemptPush.test.ts; these harness launches write none.
  const lane = f.current();
  lane.delivery = { ...lane.delivery!, active: false, publish: "disabled" };
  savePipelines([lane]);
  const finished = f.h.finish(replacement!.agentPath!, "pass");
  f.h.durableTurns.set(replacement!.agentPath!, { turn: "terminal", message: f.h.messages.get(replacement!.agentPath!)! });
  await tickPipelines([finished], f.h.ports);
  expect(f.attempts()).toHaveLength(2);
  expect(f.attempts()[1]).toMatchObject({ state: "passed", verdict: { status: "pass" } });
});

test("a newer reading with headroom ends the hold before the reset, once", async () => {
  const f = await guardedAccountClock();
  for (let tick = 0; tick < 6; tick++) { await tickPipelines([], f.h.ports); f.advance(120_000); }
  expect(f.attempts()).toHaveLength(1);
  f.read("account-a", 40);
  await tickPipelines([], f.h.ports);
  for (let tick = 0; tick < 10; tick++) { f.advance(120_000); await tickPipelines([], f.h.ports); }
  expect(f.attempts()).toHaveLength(2);
  expect(f.attempts()[1]).toMatchObject({ accountId: "account-a", state: "running", launchId: expect.any(String) });
});

test("another allowed account with capacity takes the held stage once while the held reading ages", async () => {
  const f = await guardedAccountClock(["account-a", "account-b"]);
  for (let tick = 0; tick < 80; tick++) {
    await tickPipelines([], f.h.ports);
    if (tick % 4 === 3) { f.read("account-a", 100); f.read("account-b", 20); }
    f.advance(120_000);
  }
  expect(f.attempts()).toHaveLength(2);
  expect(f.attempts()[1]).toMatchObject({ accountId: "account-b", state: "running", restartContext: { previousAttempt: 1 } });
});

test("a replacement refused at launch by a fresh exhausted reading launches again itself after the next reset", async () => {
  const f = await guardedAccountClock();
  await tickPipelines([], f.h.ports);
  f.advance(f.resetsAt * 1_000 - f.now() + 60_000);
  await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(2);
  const nextReset = f.resetsAt + 6 * 3_600;
  f.read("account-a", 100, nextReset);
  for (let tick = 0; tick < 40; tick++) { await tickPipelines([], f.h.ports); f.advance(120_000); }
  expect(f.attempts()).toHaveLength(2);
  expect(f.attempts()[1]).toMatchObject({ launchId: null, suspension: { hold: { accountId: "account-a", resetsAt: nextReset } } });
  expect(f.current().stateDetail).toContain(`to reset at ${new Date(nextReset * 1_000).toISOString()}`);

  f.advance(nextReset * 1_000 - f.now() + 60_000);
  for (let tick = 0; tick < 3; tick++) { await tickPipelines([], f.h.ports); f.advance(120_000); }
  expect(f.attempts()).toHaveLength(2);
  expect(f.attempts()[1]).toMatchObject({ state: "running", launchId: expect.any(String), error: null,
    restartContext: { previousAttempt: 1, transcriptPath: f.attempt.agentPath } });
  expect(f.attempts()[1]!.suspension).toBeUndefined();
});
