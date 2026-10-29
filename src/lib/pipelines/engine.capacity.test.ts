import { expect, test, fs, path, loadPipelines, savePipelines, providerRecoveryHarness, selectProjectAccount, LIMITED_ACCOUNT, SPARE_ACCOUNT, tickPipelines } from "./engine.fixture";
import { recoverPipelineProviderTurn } from "./engine";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";

const capacityText = "Selected model is at capacity. Please try again later.";

async function capacityPool(pinned = false) {
  const f = await providerRecoveryHarness("codex", "server_overloaded", capacityText, null, pinned);
  const lane = loadPipelines()[0]!, attempt = lane.runs[0]!.attempts[0]!;
  attempt.accountId = LIMITED_ACCOUNT;
  attempt.effectiveRole.serviceTier = "priority";
  lane.stages[0]!.effectiveRole.serviceTier = "priority";
  savePipelines([lane]);
  let allowed = [LIMITED_ACCOUNT, SPARE_ACCOUNT];
  const observations: DurableQuotaObservation[] = [];
  const selections: Array<string[] | undefined> = [];
  const wakes: number[] = [];
  f.h.ports.scheduleTick = delay => { wakes.push(delay); };
  f.h.ports.allowedAccountIds = () => allowed;
  f.h.ports.resolveProjectSpawn = (engine, request) => {
    selections.push(request.unavailableIds);
    const selected = selectProjectAccount({ project: lane.project, engine, model: request.model,
      accounts: [LIMITED_ACCOUNT, SPARE_ACCOUNT, "excluded-seat"].map(id => ({ id, authPresent: true })),
      bindings: allowed.map(accountId => ({ project: lane.project, engine: "codex", accountId, createdAt: f.h.ports.now() })),
      observations, unavailableIds: request.unavailableIds, requestedId: request.requestedId,
      requireCapacity: request.requireCapacity, now: f.now() });
    return selected.kind === "available" ? { kind: "available", account: { engine, accountId: selected.accountId!,
      kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } } : selected;
  };
  return { ...f, id: lane.id, lane, selections, observations, wakes, allow: (ids: string[]) => { allowed = ids; } };
}

for (const selected of [false, true]) {
  test(`capacity automatically relaunches on an allowed account, retaining checkout, receipts, model and tier (selected profile=${selected})`, async () => {
    const f = await capacityPool();
    if (selected) {
      // A selected runtime may differ from the stage's original defaults.
      f.lane.stages[0]!.effectiveRole.model = "gpt-6.0";
      f.lane.stages[0]!.effectiveRole.serviceTier = "standard";
      f.lane.stages[0]!.account = LIMITED_ACCOUNT;
      f.lane.runs[0]!.attempts[0]!.runtimeAccountPin = null;
      savePipelines([f.lane]);
    }
    const original = structuredClone(f.lane.runs[0]!.attempts[0]!);
    await recoverPipelineProviderTurn(f.id, f.h.ports);
    let lane = loadPipelines()[0]!;
    expect(lane.state).toBe("running");
    expect(lane.stateDetail).toContain("another allowed account");
    expect(lane.worktreeDir).toBe(f.lane.worktreeDir);
    expect(lane.runs[0]!.attempts).toHaveLength(2);
    expect(lane.runs[0]!.attempts[0]!.launchId).toBe(original.launchId);
    expect(lane.runs[0]!.attempts[0]!.conversationId).toBe(original.conversationId);
    expect(lane.runs[0]!.attempts[1]!.accountId).toBe(SPARE_ACCOUNT);
    expect(lane.runs[0]!.attempts[1]!.effectiveRole).toEqual(original.effectiveRole);
    await tickPipelines([], f.h.ports);
    lane = loadPipelines()[0]!;
    expect(f.h.spawnInputs.at(-1)!.requestedAccountId).toBe(SPARE_ACCOUNT);
    expect(f.h.spawnInputs.at(-1)!.requireAccountCapacity).toBe(true);
    expect(f.h.spawnInputs.at(-1)!.role.model).toBe(original.effectiveRole.model);
    expect(f.h.spawnInputs.at(-1)!.role.serviceTier).toBe("priority");
    expect(lane.state).toBe("running");
    expect(f.sends).toHaveLength(0);
  });
}

test("an explicit capacity pin keeps retrying beyond three cuts with capped backoff", async () => {
  const f = await capacityPool(true);
  for (let n = 0; n < 6; n++) {
    f.h.setConversationActive(false);
    f.cut();
    await recoverPipelineProviderTurn(f.id, f.h.ports);
    const lane = loadPipelines()[0]!, wait = lane.runs[0]!.attempts[0]!.providerWait!;
    expect(lane.state).toBe("running");
    expect(lane.runs[0]!.attempts).toHaveLength(1);
    expect(wait.resumeAt).toBe(new Date(f.now() + Math.min(15 * 60_000, 60_000 * 2 ** n)).toISOString());
    expect(f.wakes).toContain(Date.parse(wait.resumeAt) - f.now());
    f.advance(Date.parse(wait.resumeAt) - f.now());
    await recoverPipelineProviderTurn(f.id, f.h.ports);
    expect(f.sends).toHaveLength(n + 1);
    f.advance(1_000);
  }
  expect(f.selections).toHaveLength(0);
});

test("an exhausted allowed pool waits and retries selection without using an excluded account", async () => {
  const f = await capacityPool();
  for (const accountId of [LIMITED_ACCOUNT, SPARE_ACCOUNT]) f.observations.push({ engine: "codex", accountId,
    authenticated: true, authCheckedAt: f.h.ports.now(), observedAt: f.h.ports.now(), bootId: "fixture",
    limits: { session: { usedPercent: 100, resetsAt: Math.floor(f.now() / 1000) + 3600 }, weekly: null, plan: "pro", capturedAt: f.now() },
    provenance: { source: "live", reason: null, staleSince: null } });
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.stateDetail).toContain("no allowed account");
  expect(f.wakes).toContain(60_000);
  f.advance(60_000);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(f.sends).toHaveLength(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!;
  expect(Date.parse(wait.resumeAt)).toBeGreaterThan(f.now());
  expect(loadPipelines()[0]!.stateDetail).toContain(wait.resumeAt);
  f.observations.splice(1, 1);
  f.advance(Date.parse(wait.resumeAt) - f.now());
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts.at(-1)!.accountId).toBe(SPARE_ACCOUNT);
});

test("capacity recovery never selects an account excluded by project policy", async () => {
  const f = await capacityPool();
  f.allow([LIMITED_ACCOUNT]);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  f.advance(60_000);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(f.sends).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.state).toBe("running");
});

test("a stale selection outside the allowed pool cannot dispatch capacity recovery", async () => {
  const f = await capacityPool();
  const resolve = f.h.ports.resolveProjectSpawn!;
  f.h.ports.resolveProjectSpawn = (engine, request) => {
    const answer = resolve(engine, request);
    return answer.kind === "available" ? { ...answer, account: { ...answer.account, accountId: "excluded-seat" } } : answer;
  };
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  f.advance(60_000);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.stateDetail).toContain("no allowed account");
  expect(f.sends).toHaveLength(0);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("a capacity pin excluded by a later rule waits automatically for its own authorization", async () => {
  const f = await capacityPool(true);
  f.allow([SPARE_ACCOUNT]);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  f.advance(60_000);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.stateDetail).toContain("no allowed account");
  expect(f.sends).toHaveLength(0);
  expect(f.selections).toHaveLength(0);
  const wait = loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait!;
  f.allow([LIMITED_ACCOUNT, SPARE_ACCOUNT]);
  f.advance(Date.parse(wait.resumeAt) - f.now());
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(f.sends).toHaveLength(1);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("a pinned capacity continuation keeps retrying after a prolonged transport refusal", async () => {
  const f = await capacityPool(true);
  const send = f.h.ports.resumeSeveredTurn!;
  let available = false;
  f.h.ports.resumeSeveredTurn = input => available ? send(input) : Promise.resolve(false);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  for (let n = 0; n < 13; n++) {
    f.advance(60_000);
    await recoverPipelineProviderTurn(f.id, f.h.ports);
    expect(loadPipelines()[0]!.state).toBe("running");
    expect(f.sends).toHaveLength(0);
  }
  available = true;
  f.advance(60_000);
  await recoverPipelineProviderTurn(f.id, f.h.ports);
  expect(f.sends).toHaveLength(1);
  expect(f.selections).toHaveLength(0);
});

test("capacity selection preserves a required tier and waits when only the source offers it", async () => {
  const { createManagedCodexAccount, listCodexAccounts } = await import("@/lib/accounts/codex");
  const { CODEX_ACCOUNTS_SOURCE } = await import("@/lib/accounts/accountsStore");
  const { persistedAccountSource, seedAccountSource, clearAccountFixture } = await import("@/lib/accounts/accountsStoreFixture");
  expect(listCodexAccounts().some(account => [LIMITED_ACCOUNT, SPARE_ACCOUNT].includes(account.id))).toBe(false);
  const prior = structuredClone(persistedAccountSource(CODEX_ACCOUNTS_SOURCE));
  const homes: string[] = [];
  try {
    const source = createManagedCodexAccount("source seat", { id: LIMITED_ACCOUNT });
    homes.push(source.home);
    const spare = createManagedCodexAccount("spare seat", { id: SPARE_ACCOUNT });
    homes.push(spare.home);
    const catalog = (tier: string) => JSON.stringify({ models: [{ slug: "gpt-6.1-sol", service_tiers: [{ id: tier }] }] });
    fs.writeFileSync(path.join(source.home, "models_cache.json"), catalog("priority"));
    for (const offered of [true, false]) {
      fs.writeFileSync(path.join(spare.home, "models_cache.json"), catalog(offered ? "priority" : "standard"));
      const f = await capacityPool();
      const lane = loadPipelines()[0]!;
      lane.stages[0]!.effectiveRole.model = "gpt-6.1-sol";
      lane.runs[0]!.attempts[0]!.effectiveRole.model = "gpt-6.1-sol";
      savePipelines([lane]);
      await recoverPipelineProviderTurn(f.id, f.h.ports);
      const saved = loadPipelines()[0]!;
      expect(saved.state).toBe("running");
      expect(saved.runs[0]!.attempts).toHaveLength(offered ? 2 : 1);
      expect(saved.runs[0]!.attempts.at(-1)!.effectiveRole).toMatchObject({ model: "gpt-6.1-sol", serviceTier: "priority" });
      if (offered) expect(saved.runs[0]!.attempts.at(-1)!.accountId).toBe(SPARE_ACCOUNT);
      else {
        expect(saved.stateDetail).toContain("waiting for model at capacity");
        expect(f.sends).toHaveLength(0);
        expect(f.wakes).toContain(60_000);
      }
    }
  } finally {
    try {
      if (prior === undefined) clearAccountFixture(CODEX_ACCOUNTS_SOURCE);
      else seedAccountSource(CODEX_ACCOUNTS_SOURCE, prior);
    } finally {
      for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
    }
  }
});
