import { expect, test, harness, create, tickPipelines, loadPipelines, savePipelines, patchPipeline, providerRecoveryHarness, LIMITED_ACCOUNT } from "./engine.fixture";
import { selectProjectAccount } from "@/lib/accounts/projectSelection";
import { selectHeadlessAccount } from "@/lib/accounts/headlessSelection";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";

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
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(f.current().runs[0]!.attempts).toHaveLength(2);
});

test("a newly forbidden target during host termination stays stopped until an allowed account appears", async () => {
  const f = await fixture();
  f.observations[0]!.limits!.weekly!.usedPercent = 99;
  f.h.ports.stopStageAgent = async () => { f.allow(["account-a"]); return { outcome: "stopped" }; };
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
