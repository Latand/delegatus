import { expect, test, harness, create, tickPipelines, loadPipelines, savePipelines, patchPipeline, PASS_TEXT, fs, path } from "./engine.fixture";
import { selectProjectAccount } from "@/lib/accounts/projectSelection";
import { accountQuotaVerdict } from "@/lib/accounts/headlessSelection";
import { ProjectAccountRefusedError } from "@/lib/accounts/manager";
import { attemptAccountPin } from "./runtimeSwitch";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import type { FlowEngine } from "@/lib/flows/types";

async function suspendedFixture(pinned = true) {
  const h = harness();
  h.ports.roleLookup = () => ({ engine: "codex", model: "gpt-6-astra", effort: "medium", serviceTier: "ultrafast", promptScaffold: "Build" });
  const pools: Record<FlowEngine, string[]> = { codex: ["account-a"], claude: ["account-a", "account-c"] };
  const now = Date.parse("2026-10-28T09:00:00Z");
  h.ports.now = () => new Date(now).toISOString();
  const observations: DurableQuotaObservation[] = (["codex", "claude"] as const).flatMap(engine =>
    (engine === "codex" ? ["account-a", "account-b"] : pools.claude).map(accountId => ({ engine, accountId,
      authenticated: true, authCheckedAt: h.ports.now(), observedAt: h.ports.now(), bootId: "fixture",
      provenance: { source: "live" as const, reason: null, staleSince: null },
      limits: { session: null, weekly: { usedPercent: 20, resetsAt: now / 1_000 + 3 * 86400 }, plan: "pro", capturedAt: now / 1_000 } })));
  const quota = (engine: FlowEngine, id: string, model?: string | null) => accountQuotaVerdict(observations.filter(row => row.engine === engine), id, now, model);
  h.ports.allowedAccountIds = (_project, engine) => pools[engine];
  h.ports.accountQuota = quota;
  h.ports.accountExhausted = (engine, id, model) => quota(engine, id, model).capacity === "exhausted";
  h.ports.resolveProjectSpawn = (engine, request) => {
    const selected = selectProjectAccount({ ...request, engine, now,
      accounts: observations.filter(row => row.engine === engine).map(row => ({ id: row.accountId, authPresent: true })),
      observations: observations.filter(row => row.engine === engine),
      bindings: pools[engine].map(accountId => ({ project: request.project!, engine, accountId, createdAt: h.ports.now() })) });
    return selected.kind === "available" ? { kind: "available", account: { engine, accountId: selected.accountId!, kind: "managed",
      home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } } : selected;
  };
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => {
    const selected = h.ports.resolveProjectSpawn!(input.role.engine, { project: input.project, model: input.role.model,
      requestedId: input.requestedAccountId, unavailableIds: input.unavailableAccountIds, requireCapacity: input.requireAccountCapacity });
    if (selected.kind !== "available") throw new ProjectAccountRefusedError(selected, input.role.engine, input.project);
    // Record the production spawn input before the account adapter resolves its unpinned choice.
    const result = await spawn(input, reserved);
    return { ...result, accountId: selected.account.accountId, paneId: null };
  };
  const lane = await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, account: pinned ? "account-a" : undefined, prompt: "Build", next: null }] as never);
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  const current = () => loadPipelines().find(item => item.id === lane.id)!;
  const attempts = () => current().runs[0]!.attempts;
  const exhaust = (engine: FlowEngine, id: string) => { observations.find(row => row.engine === engine && row.accountId === id)!.limits!.weekly!.usedPercent = 100; };
  const original = attempts()[0]!;
  expect(original).toMatchObject({ state: "running", accountId: "account-a", effectiveRole: { engine: "codex", serviceTier: "ultrafast" } });
  h.durableTurns.set(original.agentPath!, { turn: "busy", message: null, lastRecordAt: now });
  exhaust("codex", "account-a");
  await tickPipelines([], h.ports);
  expect(attempts()).toHaveLength(1);
  expect(attempts()[0]!.suspension?.stoppedAt).toBeDefined();
  const override = (engine: FlowEngine = "claude", account: string | null = null) => patchPipeline(lane.id, {
    action: "override-stage", stageId: "build", engine, model: engine === "claude" ? "opus" : "gpt-6.1-sol",
    effort: "high", account, serviceTier: null,
  }, h.ports);
  const retry = () => patchPipeline(lane.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: attempts().at(-1)!.n }, h.ports);
  return { h, lane, pools, observations, exhaust, current, attempts, override, retry };
}

test.each([false, true])("a suspended stage retries on its configured runtime before the old reset, pause=%s", async pause => {
  const f = await suspendedFixture();
  expect((await patchPipeline(f.lane.id, { action: "override-stage", stageId: "build", engine: "claude", model: "opus", effort: "high",
    account: null, serviceTier: null, applyNow: true, expectedAttempt: 1 }, f.h.ports)).status).toBe(409);
  expect(await f.override()).toMatchObject({ graphEdit: { effect: "pending-next-attempt", appliesFromAttempt: 2 } });
  if (pause) {
    expect((await patchPipeline(f.lane.id, { action: "pause" }, f.h.ports)).error).toBeUndefined();
    expect((await patchPipeline(f.lane.id, { action: "resume" }, f.h.ports)).error).toBeUndefined();
    f.pools.codex.push("account-b");
  }
  expect((await f.retry()).error).toBeUndefined();
  for (let tick = 0; tick < 3; tick++) await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(2);
  const next = f.attempts()[1]!;
  expect(next).toMatchObject({ state: "running", effectiveRole: { engine: "claude", model: "opus", effort: "high" },
    definition: { account: null }, error: null, restartContext: { previousAttempt: 1 } });
  expect(next.effectiveRole.serviceTier).toBeUndefined();
  expect(attemptAccountPin(f.current().stages[0]!, next)).toBeNull();
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]).toMatchObject({ role: { engine: "claude", model: "opus", effort: "high" }, requestedAccountId: null, requireAccountCapacity: true });
  expect(f.h.spawnInputs[1]!.unavailableAccountIds).not.toContain("account-a");
  expect(f.current().worktreeDir).toBe(f.lane.worktreeDir);
  expect(f.h.calls.some(call => /reset --hard|clean -/.test(call))).toBe(false);
});

test("a spare recovery can exhaust again and an explicit retry still leaves its old engine and pin", async () => {
  const f = await suspendedFixture();
  f.pools.codex.push("account-b");
  await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
  expect(f.attempts()[1]).toMatchObject({ effectiveRole: { engine: "codex", serviceTier: "ultrafast" }, accountId: "account-b" });
  f.exhaust("codex", "account-b");
  await tickPipelines([], f.h.ports);
  expect(f.attempts()[1]!.suspension).toBeDefined();
  expect((await f.override()).error).toBeUndefined();
  expect((await f.retry()).error).toBeUndefined();
  await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(3);
  expect(f.attempts()[2]).toMatchObject({ effectiveRole: { engine: "claude", model: "opus", effort: "high" }, definition: { account: null }, error: null });
  expect(attemptAccountPin(f.current().stages[0]!, f.attempts()[2]!)).toBeNull();
  expect(f.h.spawnInputs[2]!.requestedAccountId).toBeNull();
});

test.each(["stop", "delivery", "withdrawal"] as const)("explicit suspended retry waits for %s and retains the current definition", async fence => {
  const f = await suspendedFixture();
  await f.override();
  let held = true;
  const stop = f.h.ports.stopStageAgent;
  f.h.ports.stopStageAgent = async (...args) => fence === "stop" && held
    ? { outcome: "unconfirmed", operationId: args[1]!.operationId!, detail: "pending" } : stop(...args);
  f.h.ports.conversationDeliveryOutstanding = () => fence === "delivery" && held;
  f.h.ports.invalidateProviderContinuation = async () => { if (fence === "withdrawal" && held) throw Error("host unavailable"); };
  expect((await f.retry()).error).toBeUndefined();
  await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
  held = false;
  await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.role.engine).toBe("claude");
});

test.each([1, 2])("a report recorded at suspended retry stop %s wins over its replacement", async reportAt => {
  const f = await suspendedFixture();
  await f.override();
  const stop = f.h.ports.stopStageAgent;
  let stops = 0;
  f.h.ports.stopStageAgent = async (...args) => {
    if (++stops === reportAt) f.h.durableTurns.set(f.attempts()[0]!.agentPath!, { turn: "terminal", message: { text: PASS_TEXT, ts: Date.parse(f.h.ports.now()) + 1 } });
    return stop(...args);
  };
  expect((await f.retry()).error).toBeUndefined();
  expect(f.attempts()).toHaveLength(1);
  expect(f.attempts()[0]!.verdict?.status).toBe("pass");
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("pause cancellation with a provider wait has an effective explicit retry", async () => {
  const f = await suspendedFixture();
  const lane = f.current();
  lane.runs[0]!.attempts[0]!.providerWait = { condition: { kind: "usage_limit", scope: "usage", resetLabel: null, label: "usage limit" },
    text: "exhausted", accountId: "account-a", turnTs: Date.parse(f.h.ports.now()), tries: 0, startedAt: f.h.ports.now(),
    resumeAt: new Date(Date.parse(f.h.ports.now()) + 3 * 86400_000).toISOString(), resetsAt: null };
  savePipelines([lane]);
  await f.override();
  await patchPipeline(f.lane.id, { action: "pause" }, f.h.ports);
  await patchPipeline(f.lane.id, { action: "resume" }, f.h.ports);
  expect((await f.retry()).error).toBeUndefined();
  await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(2);
  expect(f.attempts()[1]).toMatchObject({ state: "running", error: null, effectiveRole: { engine: "claude" } });
  expect(f.attempts()[1]!.providerWait).toBeUndefined();
});

test.each([null, "account-b"])("same-engine explicit retry honors the configured account %s and keeps the old account held", async account => {
  const f = await suspendedFixture();
  f.pools.codex.push("account-b");
  f.h.ports.roleLookup = () => ({ engine: "codex", model: "gpt-6.1-sol", effort: "high", promptScaffold: "Build" });
  expect((await f.override("codex", account)).error).toBeUndefined();
  expect((await f.retry()).error).toBeUndefined();
  // A held quota reading that ages after replacement selection still excludes A at dispatch.
  for (const row of f.observations.filter(row => row.engine === "codex"))
    row.authCheckedAt = row.observedAt = new Date(Date.parse(f.h.ports.now()) - 6 * 60_000).toISOString();
  await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
  const next = f.attempts()[1]!;
  expect(next).toMatchObject({ effectiveRole: { engine: "codex", model: "gpt-6.1-sol", effort: "high" }, definition: { account }, accountId: "account-b" });
  expect(next.effectiveRole.serviceTier).toBeUndefined();
  expect(attemptAccountPin(f.current().stages[0]!, next)).toBe(account);
  expect(f.h.spawnInputs[1]).toMatchObject({ requestedAccountId: account, unavailableAccountIds: ["account-a"] });
});

test("a retry with no target capacity reports its wait and uses the configured target once capacity returns", async () => {
  const f = await suspendedFixture();
  await f.override("claude", "account-c");
  f.exhaust("claude", "account-c");
  expect((await f.retry()).error).toBeUndefined();
  await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(1);
  expect(f.current().stateDetail).toContain("configured claude");
  f.observations.find(row => row.engine === "claude" && row.accountId === "account-c")!.limits!.weekly!.usedPercent = 20;
  await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
  expect(f.attempts()[1]).toMatchObject({ accountId: "account-c", definition: { account: "account-c" } });
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBe("account-c");
});

test("target binding revoked during the last stop holds the retry until it is restored", async () => {
  const f = await suspendedFixture();
  await f.override();
  const stop = f.h.ports.stopStageAgent;
  let stops = 0;
  f.h.ports.stopStageAgent = async (...args) => {
    if (++stops === 2) f.pools.claude.length = 0;
    return stop(...args);
  };
  expect((await f.retry()).error).toBeUndefined();
  expect(f.attempts()).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
  f.pools.claude.push("account-c");
  await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(2);
  expect(f.attempts()[1]!.accountId).toBe("account-c");
});

test.each([false, true])("a fresh controller consumes a pending explicit retry from the persisted stage definition, changed=%s", async changed => {
  const f = await suspendedFixture(changed);
  if (changed) await f.override();
  else f.pools.codex.push("account-b");
  f.h.ports.conversationDeliveryOutstanding = () => true;
  expect((await f.retry()).error).toBeUndefined();
  expect(f.attempts()).toHaveLength(1);
  const snapshot = path.join(process.env.LLV_STATE_DIR!, "retry-accounts.json");
  fs.writeFileSync(snapshot, JSON.stringify({ pools: f.pools, observations: f.observations, now: f.h.ports.now() }));
  const child = Bun.spawn([process.execPath, "-e", `
    const { defaultPipelinePorts, tickPipelines } = await import("./src/lib/pipelines/engine.ts");
    const { registerPipelineTick } = await import("./src/lib/pipelines/controllerSignal.ts");
    const { loadPipelines } = await import("./src/lib/pipelines/store.ts");
    const { selectProjectAccount } = await import("./src/lib/accounts/projectSelection.ts");
    const { accountQuotaVerdict } = await import("./src/lib/accounts/headlessSelection.ts");
    const saved = await Bun.file(process.env.LLV_TEST_RETRY_ACCOUNTS).json();
    const quota = (engine, id, model) => accountQuotaVerdict(saved.observations.filter(row => row.engine === engine), id, Date.parse(saved.now), model);
    registerPipelineTick(async () => {});
    await tickPipelines([], { ...defaultPipelinePorts(), now: () => saved.now,
      exec: async () => ({ code: 0, stdout: "", stderr: "" }), worktreePresent: () => true,
      drainHold: () => null, cpuPressureHold: () => null, structuredDeliveryPublication: () => "ready",
      engineReadiness: () => "connected", conversationDeliveryOutstanding: () => false,
      conversationOperatorStopped: async () => false, invalidateProviderContinuation: async () => {},
      stopStageAgent: async () => ({ outcome: "not-running" }),
      durableTurnEvidence: async () => ({ turn: "busy", message: null, lastRecordAt: Date.parse(saved.now) }),
      accountQuota: quota, accountExhausted: (engine, id, model) => quota(engine, id, model).capacity === "exhausted",
      allowedAccountIds: (_project, engine) => saved.pools[engine],
      resolveProjectSpawn: (engine, request) => {
        const selected = selectProjectAccount({ ...request, engine, now: Date.parse(saved.now),
          accounts: saved.observations.filter(row => row.engine === engine).map(row => ({ id: row.accountId, authPresent: true })),
          observations: saved.observations.filter(row => row.engine === engine),
          bindings: saved.pools[engine].map(accountId => ({ project: request.project, engine, accountId, createdAt: saved.now })) });
        return selected.kind === "available" ? { kind: "available", account: { engine, accountId: selected.accountId,
          kind: "managed", home: process.env.LLV_STATE_DIR, transcriptRoot: process.env.LLV_STATE_DIR, env: { NODE_ENV: "test" } } } : selected;
      },
      spawnAgent: async () => { throw Error("replacement must first be recorded"); },
    });
    console.log(JSON.stringify(loadPipelines()[0].runs[0].attempts.map(attempt => ({ n: attempt.n, engine: attempt.effectiveRole.engine, account: attempt.definition?.account }))));
    process.exit(0);
  `], { env: { ...process.env, LLV_TEST_RETRY_ACCOUNTS: snapshot }, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(30_000) });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout.trim())).toEqual([{ n: 1, engine: "codex", account: changed ? "account-a" : null }, { n: 2, engine: changed ? "claude" : "codex", account: null }]);
  f.h.ports.conversationDeliveryOutstanding = () => false;
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.role.engine).toBe(changed ? "claude" : "codex");
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBeNull();
});

test("explicit retry retains an unchanged exhausted pin until the operator clears it", async () => {
  const f = await suspendedFixture();
  f.pools.codex.push("account-b");
  expect((await f.retry()).error).toBeUndefined();
  await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(1);
  expect(f.current().stateDetail).toContain("configured codex");
  expect(f.current().stages[0]!.account).toBe("account-a");
  expect((await f.override()).error).toBeUndefined();
  await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.role.engine).toBe("claude");
});

test("pause withdraws a pending explicit retry until a later explicit retry authorizes it", async () => {
  const f = await suspendedFixture();
  await f.override();
  let outstanding = true;
  f.h.ports.conversationDeliveryOutstanding = () => outstanding;
  await f.retry();
  expect(f.attempts()[0]!.suspension?.retryRequestedAt).toBeDefined();
  await patchPipeline(f.lane.id, { action: "pause" }, f.h.ports);
  outstanding = false;
  await tickPipelines([], f.h.ports);
  expect(f.attempts()[0]!.suspension?.retryRequestedAt).toBeUndefined();
  expect(f.attempts()).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
  await patchPipeline(f.lane.id, { action: "resume" }, f.h.ports);
  await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(1);
  await f.retry();
  await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.role.engine).toBe("claude");
});

test("unreadable old quota cannot select the runtime of an explicit retry", async () => {
  const f = await suspendedFixture();
  await f.override();
  const quota = f.h.ports.accountExhausted!;
  f.h.ports.accountExhausted = (engine, ...args) => {
    if (engine === "codex") throw Error("old quota unavailable");
    return quota(engine, ...args);
  };
  expect((await f.retry()).error).toBeUndefined();
  await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.role.engine).toBe("claude");
});

test("an unlaunched guarded replacement rebinds itself to the current runtime without adding a launchless edge", async () => {
  const f = await suspendedFixture();
  f.pools.codex.push("account-b");
  await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(2);
  f.exhaust("codex", "account-b");
  await tickPipelines([], f.h.ports); await tickPipelines([], f.h.ports);
  expect(f.attempts()[1]).toMatchObject({ launchId: null, suspension: { reason: "account" } });
  await f.override();
  expect((await f.retry()).error).toBeUndefined();
  await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(2);
  expect(f.attempts()[1]).toMatchObject({ state: "running", effectiveRole: { engine: "claude", model: "opus" }, definition: { account: null } });
  expect(f.h.spawnInputs).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.requestedAccountId).toBeNull();
});

test.each([false, true])("operator stops fence explicit recovery only after its authorization, later=%s", async later => {
  const f = await suspendedFixture();
  await f.override();
  const now = Date.parse(f.h.ports.now());
  const stoppedAt = now + (later ? 3_000 : 1_000);
  f.h.ports.now = () => new Date(now + 2_000).toISOString();
  f.h.ports.conversationOperatorStopped = async (_id, since) => stoppedAt > Date.parse(since);
  expect((await f.retry()).error).toBeUndefined();
  if (later) {
    expect(f.attempts()).toHaveLength(1);
    expect(f.attempts()[0]!.suspension?.operatorStoppedAt).toBeDefined();
    f.h.ports.now = () => new Date(now + 4_000).toISOString();
    expect((await f.retry()).error).toBeUndefined();
  }
  await tickPipelines([], f.h.ports);
  expect(f.attempts()).toHaveLength(2);
  expect(f.h.spawnInputs[1]!.role.engine).toBe("claude");
});
