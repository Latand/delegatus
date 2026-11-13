import { beforeEach, afterEach } from "bun:test";
import { pathToFileURL } from "node:url";
import type { AgentRegistry as QuotaRegistry } from "@/lib/agent/registry";
import { selectProjectAccount } from "@/lib/accounts/projectSelection";
import { accountQuotaVerdict } from "@/lib/accounts/headlessSelection";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { expect, test, tickPipelines, loadPipelines, savePipelines, LIMITED_ACCOUNT, SPARE_ACCOUNT,
  stageTranscript, readFixtures, providerRecoveryHarness, failedReceipt, AgentRegistry,
  harness, create, frozenWallClock, ProjectAccountRefusedError, setAgentRegistryForTests, fs, path, os } from "./engine.fixture";

const TIMEOUT = "delivery was started and the structured host did not answer; whether it reached the recipient is unverified: Claude delivery confirmation timed out; outcome is uncertain";

let quota: QuotaRegistry;
let quotaRoot: string;
beforeEach(() => {
  quotaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-limit-"));
  quota = new AgentRegistry(path.join(quotaRoot, "registry.json"));
  setAgentRegistryForTests(quota);
});
afterEach(() => {
  setAgentRegistryForTests(null);
  quota.close();
  fs.rmSync(quotaRoot, { recursive: true, force: true });
});

test("a live first-turn timeout is recovered from its native limit artifact", async () => {
  const h = harness();
  const spawn = h.ports.spawnAgent;
  const fixtures: Record<string, string> = {};
  readFixtures(h, fixtures);
  let receipt: ReturnType<typeof h.ports.spawnReceipt> = null;
  h.ports.spawnReceipt = id => receipt?.launchId === id ? receipt : null;
  h.ports.spawnAgent = async (input, reserved) => {
    const result = await spawn(input, reserved);
    if (result.accountId === SPARE_ACCOUNT) return result;
    const file = stageTranscript("claude-live-limit", [{ type: "assistant", timestamp: h.ports.now(),
      isApiErrorMessage: true, error: "rate_limit", message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
        content: [{ type: "text", text: "You've hit your weekly limit · resets 10pm (UTC)" }] } }]);
    fixtures[result.transcript!] = file;
    receipt = { ...failedReceipt(result.launchId, result.conversationId, TIMEOUT), "transcript": result.transcript, accountId: result.accountId };
    h.setConversationActive(false);
    throw new Error(TIMEOUT);
  };
  h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
  h.ports.resolveProjectSpawn = (_engine, request) => ({ kind: "available", account: { engine: "claude",
    accountId: request.unavailableIds?.includes(LIMITED_ACCOUNT) ? SPARE_ACCOUNT : LIMITED_ACCOUNT,
    kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.limitOnly).toBe(true);
  expect(h.spawnInputs).toHaveLength(1);
  await tickPipelines([], h.ports);
  const attempts = loadPipelines()[0]!.runs[0]!.attempts;
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.providerWait?.condition.kind).toBe("usage_limit");
  expect(attempts[1]!.accounting?.repeatReason).toBe("account-limit");
});

test.each(["running", "spawning", "completed", "earlier-transport"] as const)("a Claude limit-only first turn overrides %s delivery uncertainty and retries once", async state => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit", 3600_000);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.state = state === "spawning" ? "spawning" : "running";
  if (state === "earlier-transport") attempt.providerRecoveryBudget = { tries: 1, startedAt: f.h.ports.now(), engine: "claude" };
  savePipelines([lane]);
  const file = stageTranscript("claude-first-limit", [{ type: "assistant", timestamp: f.h.ports.now(),
    isApiErrorMessage: true, error: "rate_limit", message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your weekly limit · resets 10pm (UTC)" }] } }]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  f.h.ports.spawnReceipt = id => ["running", "spawning"].includes(state) && id === attempt.launchId ? { ...failedReceipt(id, attempt.conversationId!, TIMEOUT),
    "transcript": attempt.agentPath, accountId: LIMITED_ACCOUNT } : null;
  f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT];
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: SPARE_ACCOUNT,
    kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
  await tickPipelines([], f.h.ports);
  if (state === "spawning") await tickPipelines([], f.h.ports);
  const after = loadPipelines()[0]!;
  expect(after.runs[0]!.attempts[0]!.error).toMatch(/claude (?:weekly|usage) limit/);
  expect(after.runs[0]!.attempts).toHaveLength(2);
  expect(after.runs[0]!.attempts[1]!.accounting?.repeatReason).toBe("account-limit");
  const reopened = new AgentRegistry(quota.filename);
  const observation = reopened.quotaObservations("claude").find(item => item.accountId === LIMITED_ACCOUNT);
  reopened.close();
  expect(observation?.limits?.weekly?.usedPercent).toBe(100);
  expect(observation?.provenance.source).toBe("transcript");
  await tickPipelines([], { ...f.h.ports });
  expect(f.h.spawnInputs).toHaveLength(2);
  // A second limit with a third account available still spends no second retry.
  f.advance(1000);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file, "/codex/stage-2.jsonl": file });
  const second = stageTranscript("claude-second-limit", [{ type: "assistant", timestamp: f.h.ports.now(),
    isApiErrorMessage: true, error: "rate_limit", message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "You've hit your weekly limit · resets 10pm (UTC)" }] } }]);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file, "/codex/stage-2.jsonl": second });
  f.h.setConversationActive(false);
  f.h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT, "account-c"];
  f.h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: "account-c",
    kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
  await tickPipelines([], { ...f.h.ports });
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect(f.h.spawnInputs).toHaveLength(2);
  // Reload the persisted record and use fresh controller ports for later ticks.
  savePipelines(loadPipelines());
  for (let tick = 0; tick < 5; tick++) {
    f.advance(1000);
    await tickPipelines([], { ...f.h.ports });
  }
  expect(loadPipelines()[0]!.runs[0]!.attempts[1]!.providerWait?.limitOnly).toBe(true);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
  expect(f.h.spawnInputs).toHaveLength(2);
  if (state === "completed") {
    const snapshot = path.join(quotaRoot, "lane.json");
    fs.writeFileSync(snapshot, JSON.stringify(loadPipelines()));
    const probe = path.join(quotaRoot, "restart.test.ts");
    fs.writeFileSync(probe, `
      import { test, expect } from "bun:test";
      import { harness, loadPipelines, savePipelines, tickPipelines, fs, LIMITED_ACCOUNT, SPARE_ACCOUNT }
        from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "engine.fixture.ts")).href)};
      test("a restarted controller retains the single account-limit retry", async () => {
        savePipelines(JSON.parse(fs.readFileSync(process.env.CLAUDE_LIMIT_SNAPSHOT!, "utf8")));
        const h = harness();
        h.ports.now = () => ${JSON.stringify(f.h.ports.now())};
        h.setConversationActive(false);
        h.ports.allowedAccountIds = () => [LIMITED_ACCOUNT, SPARE_ACCOUNT, "account-c"];
        h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "claude", accountId: "account-c",
          kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } });
        const lane = loadPipelines()[0]!;
        const current = lane.runs[0]!.attempts[1]!;
        expect(current.providerWait?.limitOnly).toBe(true);
        h.durableTurns.set(current.agentPath!, { turn: "terminal", message: null, lastAgentOutputAt: null,
          terminalProviderMessage: { text: current.providerWait!.text, ts: current.providerWait!.turnTs,
            errorClass: "rate_limit", usageLimit: { resetsAt: current.providerWait!.resetsAt } } });
        await tickPipelines([], h.ports);
        expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(2);
        expect(h.spawnInputs).toHaveLength(0);
        // Removing the persisted fence proves that the offered spare can launch.
        const withoutFence = loadPipelines()[0]!;
        delete withoutFence.runs[0]!.attempts[1]!.providerWait!.limitOnly;
        savePipelines([withoutFence]);
        await tickPipelines([], h.ports);
        expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(3);
      });
    `);
    const child = Bun.spawn([process.execPath, "test", "--timeout=60000", probe], {
      env: { ...process.env, CLAUDE_LIMIT_SNAPSHOT: snapshot }, stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, output: exit === 0 ? "passed" : stdout + stderr }).toEqual({ exit: 0, output: "passed" });
  }
});

test.each([false, true])("a Claude limit-only first turn with no spare holds without delivery or relaunch until its reset, pinned=%s", async pinned => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit", 3600_000, pinned);
  f.h.durableTurns.get("/codex/stage-1.jsonl")!.lastAgentOutputAt = null;
  await tickPipelines([], f.h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait?.resetsAt).toBe(f.resetsAt);
  expect(loadPipelines()[0]!.stateDetail).toContain("limit");
  expect(quota.quotaObservations("claude").find(item => item.accountId === LIMITED_ACCOUNT)?.limits?.weekly)
    .toMatchObject({ usedPercent: 100, resetsAt: f.resetsAt });
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.sends).toHaveLength(0);
  f.advance(3599_000);
  await tickPipelines([], f.h.ports);
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(f.sends).toHaveLength(0);
});

function useRealClaudeSelection(f: Awaited<ReturnType<typeof providerRecoveryHarness>>, observations: DurableQuotaObservation[]) {
  const allowed = [LIMITED_ACCOUNT, SPARE_ACCOUNT];
  const accounts = allowed.map(id => ({ id, authPresent: true }));
  const bindings = allowed.map(accountId => ({ project: loadPipelines()[0]!.project, engine: "claude" as const,
    accountId, createdAt: f.h.ports.now() }));
  f.h.ports.allowedAccountIds = () => allowed;
  f.h.ports.accountQuota = (_engine, accountId, model) => accountQuotaVerdict(observations, accountId,
    Date.parse(f.h.ports.now()), model);
  f.h.ports.resolveProjectSpawn = (_engine, request) => {
    const selection = selectProjectAccount({ project: loadPipelines()[0]!.project, engine: "claude", accounts,
      observations, bindings, unavailableIds: request.unavailableIds, requestedId: request.requestedId,
      model: request.model, now: Date.parse(f.h.ports.now()) });
    return selection.kind === "available" ? { kind: "available", account: { engine: "claude",
      accountId: selection.accountId!, kind: "managed" as const, home: "/account",
      transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } } : selection;
  };
}

test("an unavailable real selector keeps the source reset ahead of persisted retry history after reload", async () => {
  const sourceDelay = 3600_000, fallbackDelay = 7200_000;
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit", sourceDelay);
  f.h.durableTurns.get("/codex/stage-1.jsonl")!.lastAgentOutputAt = null;
  const earliest = Math.floor((f.now() + sourceDelay) / 1000);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.usageLimitedAccounts = [{ accountId: SPARE_ACCOUNT, engine: "claude", limitedAt: f.now(), resetsAt: Math.floor((f.now() + fallbackDelay) / 1000) }];
  savePipelines([lane]);
  const observations: DurableQuotaObservation[] = [
    { engine: "claude", accountId: LIMITED_ACCOUNT, authenticated: true, authCheckedAt: f.h.ports.now(),
      observedAt: f.h.ports.now(), bootId: "fixture", limits: { weekly: { usedPercent: 100, resetsAt: f.resetsAt },
        session: null, plan: "pro", capturedAt: Math.floor(f.now() / 1000) },
      provenance: { source: "live", reason: null, staleSince: null } },
    { engine: "claude", accountId: SPARE_ACCOUNT, authenticated: true, authCheckedAt: f.h.ports.now(),
      observedAt: f.h.ports.now(), bootId: "fixture", limits: { weekly: { usedPercent: 100,
        resetsAt: Math.floor((f.now() + fallbackDelay) / 1000) }, session: null, plan: "pro", capturedAt: Math.floor(f.now() / 1000) },
      provenance: { source: "live", reason: null, staleSince: null } },
  ];
  useRealClaudeSelection(f, observations);
  await tickPipelines([], f.h.ports);
  savePipelines(loadPipelines());
  const after = loadPipelines()[0]!;
  const wait = after.runs[0]!.attempts[0]!.providerWait!;
  expect(after.state).toBe("needs_decision");
  expect(wait.resetsAt).toBe(f.resetsAt);
  expect(wait.resumeAt).toBe(new Date(earliest * 1000 + 60_000).toISOString());
  expect(after.stateDetail).toContain(new Date(earliest * 1000).toISOString());
  expect(selectProjectAccount({ project: after.project, engine: "claude", accounts: [
    { id: LIMITED_ACCOUNT, authPresent: true }, { id: SPARE_ACCOUNT, authPresent: true }], observations,
    bindings: [LIMITED_ACCOUNT, SPARE_ACCOUNT].map(accountId => ({ project: after.project, engine: "claude" as const,
      accountId, createdAt: f.h.ports.now() })), unavailableIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT], now: f.now() }).kind).toBe("unavailable");
  f.advance(sourceDelay - 1);
  await tickPipelines([], { ...f.h.ports });
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("an earlier selector quota observation wins over later attempt history after reload", async () => {
  const sourceDelay = 7200_000, observedDelay = 3600_000;
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit", sourceDelay);
  f.h.durableTurns.get("/codex/stage-1.jsonl")!.lastAgentOutputAt = null;
  const earliest = Math.floor((f.now() + observedDelay) / 1000);
  const lane = loadPipelines()[0]!;
  savePipelines([lane]);
  const observations: DurableQuotaObservation[] = [{ engine: "claude", accountId: SPARE_ACCOUNT,
    authenticated: true, authCheckedAt: f.h.ports.now(), observedAt: f.h.ports.now(), bootId: "fixture",
    limits: { weekly: { usedPercent: 100, resetsAt: earliest }, session: null, plan: "pro", capturedAt: Math.floor(f.now() / 1000) },
    provenance: { source: "live", reason: null, staleSince: null } }];
  useRealClaudeSelection(f, observations);
  await tickPipelines([], f.h.ports);
  savePipelines(loadPipelines());
  const after = loadPipelines()[0]!;
  const wait = after.runs[0]!.attempts[0]!.providerWait!;
  const selection = selectProjectAccount({ project: after.project, engine: "claude", accounts: [
    { id: LIMITED_ACCOUNT, authPresent: true }, { id: SPARE_ACCOUNT, authPresent: true }], observations,
    bindings: [LIMITED_ACCOUNT, SPARE_ACCOUNT].map(accountId => ({ project: after.project, engine: "claude" as const,
      accountId, createdAt: f.h.ports.now() })), unavailableIds: [LIMITED_ACCOUNT], now: f.now() });
  expect(selection).toEqual({ kind: "exhausted", resetsAt: earliest, allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] });
  expect(wait.resumeAt).toBe(new Date(earliest * 1000 + 60_000).toISOString());
  expect(after.stateDetail).toContain(new Date(earliest * 1000).toISOString());
  expect(f.h.spawnInputs).toHaveLength(1);
  f.advance(observedDelay - 1);
  await tickPipelines([], { ...f.h.ports });
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("an unavailable quota writer retains the limit cause and retries the observation before any new launch", async () => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit", 3600_000);
  f.h.durableTurns.get("/codex/stage-1.jsonl")!.lastAgentOutputAt = null;
  const admitted = quota.deliveryWriteOrBusy.bind(quota);
  quota.deliveryWriteOrBusy = async () => { throw new Error("fixture writer unavailable"); };
  await tickPipelines([], f.h.ports);
  let attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.providerWait?.condition.kind).toBe("usage_limit");
  expect(loadPipelines()[0]!.stateDetail).toContain("observation unavailable");
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(quota.quotaObservations("claude")).toEqual([]);
  quota.deliveryWriteOrBusy = admitted;
  f.advance(60_000);
  await tickPipelines([], { ...f.h.ports });
  attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.providerWait?.condition.kind).toBe("usage_limit");
  expect(quota.quotaObservations("claude")[0]?.limits?.weekly?.usedPercent).toBe(100);
  expect(f.h.spawnInputs).toHaveLength(1);
});

test("an exhausted Claude admission holds the stage before reservation with its reset", async () => {
  const h = harness();
  const reset = Math.floor(Date.parse(h.ports.now()) / 1000) + 3600;
  h.ports.spawnAgent = async () => { throw new ProjectAccountRefusedError({ kind: "exhausted", resetsAt: reset,
    allowedAccountIds: [LIMITED_ACCOUNT, SPARE_ACCOUNT] }, "claude", "project-fixture"); };
  await create(h.ports);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  expect(lane.state).toBe("needs_decision");
  expect(attempt.launchId).toBeNull();
  expect(lane.stateDetail).toContain("no allowed claude account has capacity");
  expect(lane.stateDetail).toContain(new Date(reset * 1000).toISOString());
  expect(h.spawnInputs).toHaveLength(0);
});

test.each(["quoted", "busy", "worked", "newer-prompt", "receipt-raced", "generation-raced"] as const)("uncertain delivery keeps its receipt when limit evidence is %s", async kind => {
  const f = await providerRecoveryHarness("claude", "rate_limit", "You've hit your weekly limit", 3600_000);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  attempt.state = "spawning";
  savePipelines([lane]);
  const records: Record<string, unknown>[] = [{ type: "assistant", timestamp: f.h.ports.now(), isApiErrorMessage: kind !== "quoted", error: kind === "busy" ? "overloaded_error" : "rate_limit",
    message: { role: "assistant", model: kind === "quoted" ? "claude" : "<synthetic>", stop_reason: kind === "busy" ? null : "stop_sequence",
      content: [{ type: "text", text: "You've hit your weekly limit · resets 10pm (UTC)" }] } }];
  if (kind === "worked") records.unshift({ type: "assistant", timestamp: f.h.ports.now(), message: { role: "assistant", model: "claude",
    stop_reason: null, content: [{ type: "tool_use", id: "fixture-read", name: "Read", input: {} }] } });
  if (kind === "newer-prompt") records.push({ type: "user", timestamp: f.h.ports.now(), message: { role: "user", content: "Continue" } });
  const file = stageTranscript("claude-limit-negative", records);
  readFixtures(f.h, { "/codex/stage-1.jsonl": file });
  const read = f.h.ports.durableTurnEvidence;
  let raced = false;
  f.h.ports.durableTurnEvidence = async (...args) => { const result = await read(...args); raced = kind === "receipt-raced" || kind === "generation-raced"; return result; };
  f.h.ports.spawnReceipt = id => ({ ...failedReceipt(id, attempt.conversationId!, TIMEOUT),
    state: kind === "receipt-raced" && raced ? "completed" : "failed", currentGeneration: !(kind === "generation-raced" && raced),
    "transcript": attempt.agentPath, accountId: LIMITED_ACCOUNT });
  await tickPipelines([], f.h.ports);
  const after = loadPipelines()[0]!;
  expect(after.runs[0]!.attempts).toHaveLength(1);
  expect(after.runs[0]!.attempts[0]!.providerWait).toBeUndefined();
  expect(f.h.spawnInputs).toHaveLength(1);
  expect(quota.quotaObservations("claude")).toEqual([]);
});

test("two native limit-only refusals cannot start a third account after a transient artifact read failure", async () => {
  const h = harness();
  const advance = frozenWallClock(h);
  const accounts = [LIMITED_ACCOUNT, SPARE_ACCOUNT].map(id => ({ id, authPresent: true }));
  const fixtures: Record<string, string> = {};
  readFixtures(h, fixtures);
  const receipts = new Map<string, NonNullable<ReturnType<typeof h.ports.spawnReceipt>>>();
  h.ports.spawnReceipt = id => receipts.get(id) ?? null;
  h.ports.allowedAccountIds = () => accounts.map(a => a.id);
  h.ports.resolveProjectSpawn = (_engine, request) => {
    const selected = selectProjectAccount({ project: null, engine: "claude", accounts,
      observations: quota.quotaObservations("claude"), bindings: [], preferredId: LIMITED_ACCOUNT,
      requestedId: request.requestedId, unavailableIds: request.unavailableIds, model: request.model, now: Date.parse(h.ports.now()) });
    return selected.kind === "available" ? { kind: "available", account: { engine: "claude", accountId: selected.accountId!, kind: "managed", home: "/account", transcriptRoot: "/account/sessions", env: { NODE_ENV: "test" } } } : selected;
  };
  const spawn = h.ports.spawnAgent;
  h.ports.spawnAgent = async (input, reserved) => {
    const result = await spawn(input, reserved);
    if (result.accountId === "account-c") return { ...result, paneId: null };
    advance(1000);
    fixtures[result.transcript!] = stageTranscript("native-limit-" + result.launchId, [{ type: "assistant", timestamp: h.ports.now(),
      isApiErrorMessage: true, error: "rate_limit", message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
        content: [{ type: "text", text: "You've hit your weekly limit · resets 10pm (UTC)" }] } }]);
    receipts.set(result.launchId, { ...failedReceipt(result.launchId, result.conversationId, TIMEOUT), transcript: result.transcript, accountId: result.accountId });
    h.setConversationActive(false);
    throw new Error(TIMEOUT);
  };
  await create(h.ports);
  for (let tick = 0; tick < 8; tick++) {
    await tickPipelines([], h.ports);
    const a = loadPipelines()[0]!.runs[0]!.attempts;
    if (a.length === 2 && a[1]!.providerWait?.limitOnly && a[1]!.providerWait!.turnTs > 0) break;
  }
  let attempts = loadPipelines()[0]!.runs[0]!.attempts;
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.providerWait?.condition.kind).toBe("usage_limit");
  expect(attempts[1]!.providerWait?.limitOnly).toBe(true);
  expect(attempts[1]!.usageLimitedAccounts?.map(a => a.accountId).sort()).toEqual([LIMITED_ACCOUNT, SPARE_ACCOUNT].sort());
  expect(quota.quotaObservations("claude").some(item => item.accountId === SPARE_ACCOUNT)).toBe(false);
  savePipelines(loadPipelines());
  accounts.push({ id: "account-c", authPresent: true });
  quota.recordQuotaObservation({ engine: "claude", accountId: "account-c", authenticated: true,
    observedAt: h.ports.now(), authCheckedAt: h.ports.now(), bootId: "fixture", provenance: { source: "live", reason: null, staleSince: null },
    limits: { session: null, weekly: { usedPercent: 31, resetsAt: Math.floor(Date.parse(h.ports.now()) / 1000) + 7200 }, plan: "pro", capturedAt: Math.floor(Date.parse(h.ports.now()) / 1000) } });
  const read = h.ports.durableTurnEvidence;
  let reads = 0;
  h.ports.durableTurnEvidence = async (...args) => ++reads === 1 ? null : read(...args);
  await tickPipelines([], { ...h.ports });
  await tickPipelines([], { ...h.ports });
  attempts = loadPipelines()[0]!.runs[0]!.attempts;
  expect(attempts).toHaveLength(2);
  expect(h.spawnInputs).toHaveLength(2);
  expect(reads).toBeGreaterThan(1);
  const reopened = new AgentRegistry(quota.filename);
  try {
    const observation = reopened.quotaObservations("claude").find(item => item.accountId === SPARE_ACCOUNT);
    expect(observation?.limits?.weekly).toMatchObject({ usedPercent: 100,
      resetsAt: attempts[1]!.providerWait!.resetsAt });
    expect(observation?.provenance.source).toBe("transcript");
  } finally {
    reopened.close();
  }
});
