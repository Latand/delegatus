import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { migrationDeliveryFixture } from "@/test-helpers/migrationDelivery";
import { agentRegistry } from "@/lib/agent/registry";
import { accountManager } from "@/lib/accounts/manager";
import { selectProjectAccount } from "@/lib/accounts/projectSelection";
import { advanceConversationMigration, drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import type { SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { procBackend } from "@/lib/proc";
import { setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { setCodexShellPolicyReaderForTest } from "@/lib/git/codexShellPolicy";
import { outputPathFor, stderrPathFor, stdoutPathFor } from "@/lib/reviewHistory/artifacts";
import { enforceAccountCreditGuard } from "./accountCreditGuard";
import { headlessRuns } from "@/lib/agent/headless";
import { newRound, recordHeadlessLaunch, reserveReviewerSpawn, tickFlows } from "@/lib/flows/engine";
import { headlessReviewStatus, startHeadlessReview, stopHeadlessReviewAndWait } from "@/lib/flows/exec";
import { loadFlow, saveFlows } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";
import { registerPipelineTick } from "@/lib/pipelines/controllerSignal";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { accountGuardObligationStore, interruptionObligationDirectory, interruptionObligationStore } from "./interruptionObligations";

const restorePipelineTick = registerPipelineTick(async () => {});
afterAll(restorePipelineTick);

afterEach(async () => {
  await bindStructuredDeliveryQueue([], { client: null });
});

function observe(registry: ReturnType<typeof agentRegistry>, accountId: string, usedPercent: number) {
  registry.recordQuotaObservation({ engine: "codex", accountId, authenticated: true,
    authCheckedAt: new Date().toISOString(), observedAt: new Date().toISOString(), bootId: "fixture",
    provenance: { source: "live", reason: null, staleSince: null },
    limits: { session: null, weekly: { usedPercent, resetsAt: null }, plan: "pro", capturedAt: Date.now() / 1000,
      credits: { hasCredits: true, balance: "10", unlimited: false } } });
}

for (const state of ["owed", "submitted"] as const) for (const loss of ["exhaustion", "binding removal"] as const) {
  test(`a ${state} continuation survives ${loss} of its committed successor`, async () => {
    const f = migrationDeliveryFixture();
    const cuts = interruptionObligationStore(interruptionObligationDirectory(f.registry.filename));
    const cut = cuts.record({ conversationId: f.conversation.id, engine: "codex", hostKey: `codex:${f.key.sessionId}`,
      path: f.conversation.generations[0]!.path, owner: null, claimEpoch: 1, turnRef: "interrupted-turn",
      boundary: "paid-credit-guard", reason: "account-guard", checkpoint: { lastEventKind: null, lastEventAt: Date.now() }, seat: null }).obligation;
    f.registry.upsert({ ...f.registry.readOnlySnapshot().entries[cut.hostKey]!, status: "dead", structuredHost: null });
    observe(f.registry, "account-a", 99);
    observe(f.registry, "account-b", 1);
    observe(f.registry, "account-c", 1);
    let removed = false;
    const selection = spyOn(accountManager, "resolveProjectSpawn").mockImplementation((engine, request) => {
      const result = selectProjectAccount({ ...request, engine, project: request?.project ?? "fixture",
        accounts: ["account-a", "account-b", "account-c"].map(id => ({ id, authPresent: true })),
        observations: f.registry.quotaObservations("codex"), now: Date.now(),
        bindings: ["account-a", ...removed ? [] : ["account-b"], "account-c"].map(accountId => ({ engine: "codex", accountId,
          project: request?.project ?? "fixture", createdAt: new Date().toISOString() })) });
      return result.kind === "available" ? { kind: "available", account: { engine, accountId: result.accountId!, kind: "managed",
        home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } } } : result;
    });
    const created: string[] = [];
    const provider: SuccessorProviderPort = { virtualSource: true, create: async input => {
      expect(f.registry.readOnlySnapshot().entries[cut.hostKey]?.status).toBe("dead");
      const current = f.registry.conversation(f.conversation.id)!.generations.at(-1)!;
      expect(current.launchProfile.cwd).toBe(f.root);
      const successor = path.join(f.root, `${input.targetAccountId}.jsonl`);
      fs.copyFileSync(current.path, successor);
      created.push(input.targetAccountId);
      return { operationId: input.operationId, nativeId: `native-${input.targetAccountId}`, path: successor,
        continuityPaths: [successor], historyHash: "fixture", host: { kind: "codex-app-server", identity: input.targetAccountId,
          epoch: 1, verifiedAt: new Date().toISOString() } };
    }, verify: async () => {} };
    try {
      f.registry.requestConversationReseat(f.conversation.id, "account-b", undefined, undefined, true);
      await advanceConversationMigration(f.conversation.id, f.registry, provider, { deferBoardRepair: true });
      expect(f.registry.conversation(f.conversation.id)?.migration?.phase).toBe("committed");
      await bindStructuredDeliveryQueue([], { registry: f.registry, client: f.client,
        hostlessSettleIntervalMs: 0, watchdogIntervalMs: 0, settlementSweepMs: 0 });
      if (state === "submitted") {
        await kickStructuredDeliveryQueue();
        expect(cuts.list()[0]!.state).toBe("submitted");
      }
      if (loss === "exhaustion") observe(f.registry, "account-b", 99);
      else removed = true;
      await kickStructuredDeliveryQueue();
      await kickStructuredDeliveryQueue();
      expect(f.registry.conversation(f.conversation.id)?.migration?.targetId).toBe("account-c");
      await advanceConversationMigration(f.conversation.id, f.registry, provider, { deferBoardRepair: true });
      await kickStructuredDeliveryQueue();
      const writes: string[] = [];
      const delivery = { deliver: async (input: { path: string; clientMessageId: string }) => {
        expect(input.path).toBe(path.join(f.root, "account-c.jsonl"));
        writes.push(input.clientMessageId); return "delivered" as const;
      } };
      await drainHeldDeliveries(f.conversation.id, delivery, f.registry);
      await kickStructuredDeliveryQueue();
      await drainHeldDeliveries(f.conversation.id, delivery, f.registry);
      expect(writes).toEqual([cut.id]);
      expect(cuts.list()).toMatchObject([{ id: cut.id, state: "delivered" }]);
      expect(created).toEqual(["account-b", "account-c"]);
      const generations = f.registry.conversation(f.conversation.id)!.generations;
      expect(generations.map(item => item.accountId)).toEqual(["account-a", "account-b", "account-c"]);
      expect(generations.every(item => fs.existsSync(item.path) && item.launchProfile.cwd === f.root)).toBe(true);
    } finally { selection.mockRestore(); await f.cleanup(); }
  });
}

test.each(["owned", "restarted", "paused", "before transcript", "completed", "completed paused"] as const)("the credit guard stops an actual %s detached reviewer before retrying its round once", async mode => {
  const completed = mode.startsWith("completed");
  const paused = mode === "paused" || mode === "completed paused";
  const f = migrationDeliveryFixture();
  const registry = agentRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-credit-review-"));
  const previousMemory = process.env.DELEGATUS_AGENT_MEMORY;
  const previousCpu = process.env.DELEGATUS_AGENT_CPU;
  process.env.DELEGATUS_AGENT_MEMORY = "off";
  process.env.DELEGATUS_AGENT_CPU = "off";
  const restoreFeatures = setCodexFeatureReaderForTest(() => [{ name: "multi_agent", stage: "stable", enabled: false }]);
  const restorePolicy = setCodexShellPolicyReaderForTest(() => ({}));
  const bin = path.join(os.homedir(), ".local", "bin", "codex");
  expect(path.dirname(os.homedir())).toBe(path.dirname(process.env.LLV_STATE_DIR!));
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('codex-cli 0.134.0'); process.exit(0); }\nawait Bun.stdin.text();\nconsole.log(JSON.stringify({type:'thread.started',thread_id:crypto.randomUUID()}));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const git = (args: string[]) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  git(["init", "-b", "main"]);
  fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "*\n");
  git(["-c", "user.name=Fixture", "-c", "user.email=noreply@example.com", "commit", "--allow-empty", "-m", "fixture"]);
  const sha = git(["rev-parse", "HEAD"]);
  const flow = { id: `guard-${mode}`, template: "implement-review-loop", project: "fixture", cwd: root,
    implementerPath: path.join(root, "implementer.jsonl"), roles: { implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "high" } }, baseRef: sha, baseMode: "head", mode: completed ? "manual" : "auto", reviewerMode: "headless",
    roundLimit: 3, state: paused ? "paused" : "reviewing", pausedState: paused ? "reviewing" : null,
    stateDetail: null, rounds: [], createdAt: new Date().toISOString(), closedAt: null } as Flow;
  fs.writeFileSync(flow.implementerPath, "");
  const round = newRound(flow, "button", "keep the review input");
  const entries: FileEntry[] = [{ path: flow.implementerPath, root: "codex-sessions", name: "implementer.jsonl", project: "fixture",
    title: "Fixture", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: Date.now() / 1000,
    size: 0, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null }];
  flow.rounds = [round];
  const reservation = reserveReviewerSpawn(flow, round, flow.roles.reviewer, "account-a", registry);
  round.accountId = "account-a";
  round.spawnStartedAt = new Date().toISOString();
  let restoreSelection = () => {};
  try {
    const launched = await startHeadlessReview(flow.id, round.n, flow.roles.reviewer, root, "review", 30_000, null, null, { command: bin });
    recordHeadlessLaunch(round, launched);
    const transcript = path.join(root, "reviewer-a.jsonl");
    fs.writeFileSync(transcript, "preserved reviewer transcript\n");
    if (mode !== "before transcript") {
      round.reviewerPath = transcript;
      const settled = registry.settleSpawn(reservation.receipt.launchId, { key: { engine: "codex", sessionId: `reviewer-${mode}` },
        artifactPath: transcript, cwd: root, accountId: "account-a", status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
      expect(settled.kind).toBe("settled");
      if (settled.kind === "settled") round.reviewerConversationId = settled.conversation.id;
    }
    if (completed) {
      expect(await stopHeadlessReviewAndWait(flow.id, 1, round)).toBe(true);
      fs.writeFileSync(outputPathFor(flow.id, 1), "VERDICT: APPROVE\nExisting review is complete.\n");
      fs.writeFileSync(stdoutPathFor(flow.id, 1), "completed stdout\n");
      fs.writeFileSync(stderrPathFor(flow.id, 1), "completed stderr\n");
      round.reviewerPid = null;
      round.reviewerIdentity = null;
    }
    saveFlows([flow]);
    if (mode === "restarted") {
      const run = headlessRuns.get(`${flow.id}:1`)!;
      clearTimeout(run.timer);
      headlessRuns.delete(`${flow.id}:1`);
    }
    observe(registry, "account-a", 98);
    observe(registry, "account-b", 1);
    const selection = spyOn(accountManager, "resolveProjectSpawn").mockImplementation((engine, request) => {
      if (completed) return { kind: "exhausted", resetsAt: null, allowedAccountIds: ["account-a", "account-b"] };
      const result = selectProjectAccount({ ...request, engine, accounts: ["account-a", "account-b"].map(id => ({ id, authPresent: true })),
        observations: registry.quotaObservations("codex"), now: Date.now(),
        bindings: [{ engine: "codex", accountId: "account-b", project: "fixture", createdAt: new Date().toISOString() }] });
      return result.kind === "available" ? { kind: "available", account: { engine, accountId: result.accountId!, kind: "managed",
        home: root, transcriptRoot: root, env: { NODE_ENV: "test" } } } : result;
    });
    restoreSelection = () => selection.mockRestore();
    await bindStructuredDeliveryQueue([], { registry, client: f.client, hostlessSettleIntervalMs: 0, watchdogIntervalMs: 0, settlementSweepMs: 0 });
    expect(headlessReviewStatus(flow.id, 1, round, "codex")?.status).toBe(completed ? "done" : "running");
    observe(registry, "account-a", 99);
    await Promise.all([kickStructuredDeliveryQueue(), kickStructuredDeliveryQueue()]);
    expect(launched.pid).toBeNumber();
    expect(procBackend.processIdentity(launched.pid!)).not.toBe(launched.identity);
    const stopped = loadFlow(flow.id)!;
    if (completed) {
      expect(stopped).toMatchObject({ state: paused ? "paused" : "relay_pending",
        rounds: [{ verdict: "APPROVE", reviewerPath: transcript, accountId: "account-a", autoRetryCount: 0 }] });
      if (paused) expect(stopped.pausedState).toBe("relay_pending");
      for (const [filename, content] of [[outputPathFor(flow.id, 1), "VERDICT: APPROVE\nExisting review is complete.\n"],
        [stdoutPathFor(flow.id, 1), "completed stdout\n"], [stderrPathFor(flow.id, 1), "completed stderr\n"]]) {
        expect(fs.readFileSync(filename!, "utf8")).toBe(content!);
      }
      const before = Object.keys(registry.readOnlySnapshot().receipts);
      await tickFlows(entries);
      await kickStructuredDeliveryQueue();
      expect(Object.keys(registry.readOnlySnapshot().receipts)).toEqual(before);
      expect(loadFlow(flow.id)?.rounds[0]?.verdict).toBe("APPROVE");
      return;
    }
    expect(stopped).toMatchObject({ cwd: root, state: mode === "paused" ? "paused" : "spawning",
      rounds: [{ n: 1, readyNote: "keep the review input", reviewerPid: null, accountId: null, autoRetryCount: 0 }] });
    expect(fs.readFileSync(transcript, "utf8")).toBe("preserved reviewer transcript\n");
    const cuts = interruptionObligationStore(interruptionObligationDirectory(registry.filename)).list()
      .filter(item => item.conversationId === round.reviewerConversationId);
    if (mode === "before transcript") {
      expect(cuts).toHaveLength(0);
      expect(registry.readOnlySnapshot().receipts[reservation.receipt.launchId]?.error).toContain("paid-credit guard");
    } else {
      expect(cuts).toMatchObject([{ reason: "account-guard", state: "discharged", resolution: expect.stringContaining("flow relaunches") }]);
      expect(cuts).toHaveLength(1);
    }
    expect(registry.readOnlySnapshot().receipts[reservation.receipt.launchId]?.state).not.toBe("starting");
    if (mode === "paused") return;
    await tickFlows(entries);
    await tickFlows(entries);
    const resumed = loadFlow(flow.id)!;
    expect({ state: resumed.state, detail: resumed.stateDetail }).toEqual({ state: "reviewing", detail: null });
    expect(resumed.rounds).toHaveLength(1);
    expect(resumed.rounds[0]!.accountId).toBe("account-b");
    const replacement = resumed.rounds[0]!;
    expect(replacement.reviewerPid).toBeNumber();
    expect(replacement.launchId).not.toBe(reservation.receipt.launchId);
    expect(await stopHeadlessReviewAndWait(flow.id, 1, round)).toBe(false);
    expect(headlessReviewStatus(flow.id, 1, replacement, "codex")?.status).toBe("running");
    const run = headlessRuns.get(`${flow.id}:1`)!;
    const identity = run.identity;
    run.identity = null;
    try {
      expect(await stopHeadlessReviewAndWait(flow.id, 1, {
        reviewerPid: replacement.reviewerPid, reviewerIdentity: "stale-start-identity",
      })).toBe(false);
    } finally { run.identity = identity; }
    expect(headlessReviewStatus(flow.id, 1, replacement, "codex")?.status).toBe("running");
    await kickStructuredDeliveryQueue();
    await tickFlows(entries);
    expect(loadFlow(flow.id)?.rounds[0]?.reviewerPid).toBe(replacement.reviewerPid);
  } finally {
    const current = loadFlow(flow.id)?.rounds[0];
    if (current) await stopHeadlessReviewAndWait(flow.id, 1, current);
    await stopHeadlessReviewAndWait(flow.id, 1, round);
    saveFlows([]);
    restoreSelection(); restoreFeatures(); restorePolicy();
    if (previousMemory === undefined) delete process.env.DELEGATUS_AGENT_MEMORY; else process.env.DELEGATUS_AGENT_MEMORY = previousMemory;
    if (previousCpu === undefined) delete process.env.DELEGATUS_AGENT_CPU; else process.env.DELEGATUS_AGENT_CPU = previousCpu;
    fs.rmSync(bin, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    await f.cleanup();
  }
});


test.each(["reconciliation", "record", "update"] as const)("guard %s yields while another process owns the obligation journal lock", async operation => {
  const f = migrationDeliveryFixture();
  const cuts = accountGuardObligationStore(interruptionObligationDirectory(f.registry.filename));
  const input = { conversationId: f.conversation.id, engine: "codex" as const, hostKey: `codex:${f.key.sessionId}`,
    path: f.conversation.generations[0]!.path, owner: null, claimEpoch: 1, turnRef: "contended-cut",
    boundary: "paid-credit-guard", reason: "account-guard" as const, checkpoint: { lastEventKind: null, lastEventAt: null }, seat: null };
  const existing = operation === "update" ? await cuts.record(input) : null;
  await cuts.list();
  const pendingFile = `${interruptionObligationDirectory(f.registry.filename)}.pending.jsonl`;
  const child = spawn(process.execPath, ["-e", `
    import { withFileTransaction } from ${JSON.stringify(path.resolve("src/lib/state/fileTransaction.ts"))};
    await withFileTransaction(process.argv[1], "fixture busy", async () => {
      console.log("locked"); await Bun.sleep(700);
    });
  `, pendingFile], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve()); child.once("error", reject);
      child.once("exit", () => reject(new Error("lock holder exited before readiness")));
    });
    let fired = false;
    timer = setTimeout(() => { fired = true; }, 20);
    const started = performance.now();
    if (operation === "record") {
      const created = await cuts.record(input);
      expect(created.created).toBe(true);
      expect((await cuts.record(input)).created).toBe(false);
      const persisted = JSON.parse(fs.readFileSync(path.join(interruptionObligationDirectory(f.registry.filename), `${created.obligation.id}.json`), "utf8"));
      expect(persisted).toMatchObject({ id: created.obligation.id, state: "owed" });
    } else if (operation === "update") {
      await cuts.update(existing!.obligation.id, { state: "submitted", operationId: "same-continuation" });
      expect(await accountGuardObligationStore(interruptionObligationDirectory(f.registry.filename)).list())
        .toMatchObject([{ id: existing!.obligation.id, state: "submitted", operationId: "same-continuation" }]);
    } else await enforceAccountCreditGuard(f.registry, [], async () => true, async () => false, async () => null);
    console.info(`[credit guard] contended ${operation} pass ${(performance.now() - started).toFixed(1)} ms, timer progressed: ${fired}`);
    expect(fired).toBe(true);
    await exited;
    expect(child.exitCode).toBe(0);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await exited;
    await f.cleanup();
  }
});

test("unchanged guard polls read no settled interruption history", async () => {
  const f = migrationDeliveryFixture();
  const directory = interruptionObligationDirectory(f.registry.filename);
  const store = interruptionObligationStore(directory);
  const settled = store.record({ conversationId: f.conversation.id, engine: "codex", hostKey: "codex:history",
    path: f.conversation.generations[0]!.path, owner: null, claimEpoch: null, turnRef: "history", boundary: "restart",
    reason: "viewer-restart", checkpoint: { lastEventKind: null, lastEventAt: null }, seat: null,
    answeredBy: "already continued" }).obligation;
  const poll = () => enforceAccountCreditGuard(f.registry, [], async () => true, async () => false, async () => null);
  try {
    // Finish the one-time upgrade backfill before measuring steady polls.
    await poll();
    for (let count = 0; count < 2_000; count++) fs.writeFileSync(path.join(directory, `${settled.id}-${count}.json`), JSON.stringify(settled));
    let reads = 0;
    const read = fs.readFileSync;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((filename: unknown, ...args: unknown[]) => {
      if (String(filename).startsWith(directory + path.sep)) reads++;
      return Reflect.apply(read, fs, [filename, ...args]);
    }) as typeof read);
    try {
      const times: number[] = [];
      for (let pass = 0; pass < 3; pass++) {
        const started = performance.now(); await poll(); times.push(performance.now() - started);
      }
      console.info(`[credit guard] 2,001 settled records, reads ${reads}, passes ms ${times.map(ms => ms.toFixed(1)).join(", ")}`);
      expect(reads).toBe(0);
    } finally { spy.mockRestore(); }
  } finally { await f.cleanup(); }
});


test("the guard persists one cut before attempting to stop its source host", async () => {
  const f = migrationDeliveryFixture();
  const directory = interruptionObligationDirectory(f.registry.filename);
  observe(f.registry, "account-a", 99);
  const health = f.host.health.bind(f.host);
  f.host.health = async () => ({ ...await health(), status: "active", activeTurnRef: "guarded-turn" });
  const keys: string[] = [];
  const stop = async () => {
    const records = fs.readdirSync(directory).filter(name => name.endsWith(".json"));
    expect(records).toHaveLength(1);
    const cut = JSON.parse(fs.readFileSync(path.join(directory, records[0]!), "utf8"));
    expect(cut).toMatchObject({ reason: "account-guard", state: "owed", turnRef: "guarded-turn" });
    keys.push(cut.id);
    // Refusal must retain the durable cut and prevent any continuation.
    return false;
  };
  try {
    for (let pass = 0; pass < 2; pass++) await expect(enforceAccountCreditGuard(f.registry, [{ key: f.key, host: f.host }], stop,
      async () => { throw new Error("failed termination cannot recover"); }, async () => { throw new Error("failed termination cannot resume"); }))
      .rejects.toThrow("termination remains pending");
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  } finally { await f.cleanup(); }
});


test("guard recovery advances past a page of unreadable receipts to reach healthy work", async () => {
  const f = migrationDeliveryFixture();
  const directory = interruptionObligationDirectory(f.registry.filename);
  const cuts = accountGuardObligationStore(directory);
  try {
    const cut = (await cuts.record({ conversationId: f.conversation.id, engine: "codex", hostKey: `codex:${f.key.sessionId}`,
      path: f.conversation.generations[0]!.path, owner: null, claimEpoch: 1, turnRef: "healthy-cut",
      boundary: "paid-credit-guard", reason: "account-guard", checkpoint: { lastEventKind: null, lastEventAt: null }, seat: null })).obligation;
    for (let count = 0; count < 65; count++) {
      const id = `interruption-continuation-${count.toString(16).padStart(32, "0")}`;
      expect(id < cut.id).toBe(true);
      fs.writeFileSync(path.join(directory, `${id}.json`), "{}");
      fs.writeFileSync(path.join(`${directory}.account-guard-pending`, `${id}.json`), JSON.stringify({ id }));
    }
    let visited = 0;
    for (let pass = 0; pass < 3; pass++) await enforceAccountCreditGuard(f.registry, [], async () => true,
      async () => { visited++; return true; }, async () => { throw new Error("operator stop cannot resume"); });
    expect(visited).toBe(1);
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, `${cut.id}.json`), "utf8"));
    expect(persisted).toMatchObject({ state: "discharged", resolution: "operator stopped the conversation after the guard" });
  } finally { await f.cleanup(); }
});
