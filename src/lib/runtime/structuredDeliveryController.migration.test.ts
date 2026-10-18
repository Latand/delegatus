import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { migrationDeliveryFixture } from "@/test-helpers/migrationDelivery";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { advanceConversationMigration } from "@/lib/accounts/migration/coordinator";
import { UnixRuntimeHostClient, type RuntimeHostClient } from "./client";
import { bindStructuredDeliveryQueue, publishStructuredDeliveryHost } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { NativeCodexQueue } from "./nativeCodexQueue";
import { FakeEngineHost } from "./fixtures/fakeEngineHost";
import type { EngineHost } from "./engineHost";
import type { NativeQueueProof } from "./nativeQueueContracts";
import { reconcileAccountMigrationCycle } from "@/lib/accounts/migration/controller";
import { drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import { selectProjectAccount } from "@/lib/accounts/projectSelection";
import { interruptionObligationDirectory, interruptionObligationStore } from "./interruptionObligations";
import { accountManager } from "@/lib/accounts/manager";

const roots: string[] = [];
afterEach(async () => {
  await bindStructuredDeliveryQueue([], { client: null });
  setSystemTime();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const f = migrationDeliveryFixture();
  roots.push(f.root);
  return f;
}

test.each(["conversation", "orchestrator", "review implementer", "reviewer", "recovered source", "newer message"])("a fresh credit crossing stops an active %s and preserves recovery custody", async kind => {
  const f = fixture();
  let active = true, releases = 0, creates = 0, spare = false;
  const health = f.host.health.bind(f.host);
  f.host.health = async () => ({ ...await health(), status: active ? "active" : "dead", activeTurnRef: active ? "turn-a" : null });
  f.host.release = async () => { active = false; releases++; };
  if (["orchestrator", "review implementer", "reviewer"].includes(kind)) f.registry.rememberMembership(f.conversation.id, {
    kind: kind === "orchestrator" ? "orchestrator" : "flow", containerId: "fixture-owner", role: kind === "orchestrator" ? "orchestrator" : kind === "reviewer" ? "reviewer" : "implementer", slot: "review:1",
    stageId: null, stageOrder: null, round: 1, parentConversationId: null });
  const observe = (usedPercent: number) => f.registry.recordQuotaObservation({ engine: "codex", accountId: "account-a",
    authenticated: true, authCheckedAt: new Date().toISOString(), observedAt: new Date().toISOString(), bootId: "fixture",
    provenance: { source: "live", reason: null, staleSince: null }, limits: { session: null,
      weekly: { usedPercent, resetsAt: Math.floor(Date.now() / 1000) + 86400 }, plan: "pro", capturedAt: Date.now() / 1000,
      credits: { hasCredits: true, balance: "10", unlimited: false } } });
  observe(98);
  const successor = path.join(f.root, "successor.jsonl");
  const provider: import("@/lib/accounts/migration/contracts").SuccessorProviderPort = {
    virtualSource: true,
    create: async input => {
      expect(active).toBe(false); creates++;
      expect(input.targetAccountId).toBe("account-b");
      fs.copyFileSync(f.conversation.generations[0]!.path, successor);
      return { operationId: input.operationId, nativeId: "native-b", path: successor, continuityPaths: [successor], historyHash: "fixture",
        host: { kind: "codex-app-server", identity: "native-b", epoch: 1, verifiedAt: new Date().toISOString() } };
    }, verify: async () => {},
  };
  const store = interruptionObligationStore(interruptionObligationDirectory(f.registry.filename));
  const resumedHost = Object.assign(new FakeEngineHost(), { onStateChange: () => () => {} });
  const originalEntry = f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
  let recoveries = 0;
  f.client.command = async command => f.journal.executeOperation(command);
  f.client.readSession = async identity => identity.conversationId === f.conversation.id
    ? f.journal.snapshot().sessions.find(session => session.conversationId === f.conversation.id) ?? null : null;
  const selection = spyOn(accountManager, "resolveProjectSpawn").mockImplementation((engine, request) => {
    const selected = selectProjectAccount({ ...request, engine, accounts: [{ id: "account-a", authPresent: true }, { id: "account-b", authPresent: true }],
      observations: f.registry.quotaObservations("codex"), bindings: [], now: Date.now() });
    return selected.kind === "available" && (spare || selected.accountId === "account-a") ? { kind: "available", account: { engine, accountId: selected.accountId!, kind: "managed",
      home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } } } : { kind: "exhausted", resetsAt: null, allowedAccountIds: ["account-a", "account-b"] };
  });
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }], { registry: f.registry, client: f.client,
      hostlessSettleIntervalMs: 0, watchdogIntervalMs: 0, settlementSweepMs: 0,
      recover: async () => {
        recoveries++;
        f.registry.upsert({ ...originalEntry, status: "idle", claimOwner: "fixture-resume" });
        await publishStructuredDeliveryHost({ key: f.key, host: resumedHost });
        return { target: null, path: originalEntry.artifactPath!, conversationId: f.conversation.id, spawned: true };
      } });
    expect(active).toBe(true);
    if (kind === "orchestrator") {
      const { recordLiveObservation } = await import("@/lib/accounts/liveLimits");
      const previous = f.registry.quotaObservations("codex")[0]!;
      recordLiveObservation({ ...previous, authCheckedAt: Date.now(), observedAt: Date.now(),
        limits: { ...previous.limits!, weekly: { usedPercent: 99, resetsAt: null } } }, "managed", { registry: f.registry });
      await kickStructuredDeliveryQueue();
    } else {
      await reconcileAccountMigrationCycle(f.registry, { tick: async engine => { if (engine === "codex") observe(99); } }, provider, { deliver: async () => "held" });
    }
    expect(active).toBe(false);
    expect(releases).toBe(1);
    expect(creates).toBe(0);
    expect(store.list()).toMatchObject([{ reason: "account-guard", state: kind === "reviewer" ? "discharged" : "owed", turnRef: "turn-a" }]);
    expect(fs.existsSync(f.conversation.generations[0]!.path)).toBe(true);
    if (kind === "recovered source") {
      observe(1);
      await kickStructuredDeliveryQueue();
      expect(recoveries).toBe(1);
      const { createMigrationDeliveryPort } = await import("@/lib/accounts/migration/deliveryPort");
      const { deliverHeldStructuredMessage } = await import("./structuredMessageDelivery");
      const delivery = createMigrationDeliveryPort({ structuredDelivery: request => deliverHeldStructuredMessage(request,
        { enabled: () => true, registry: () => f.registry, client: () => f.client, kick: () => {} }) });
      await reconcileAccountMigrationCycle(f.registry, { tick: async () => {} }, provider, delivery);
      await kickStructuredDeliveryQueue();
      expect(resumedHost.ledger.writes).toHaveLength(1);
      expect(resumedHost.ledger.writes[0]!.id).toBe(store.list()[0]!.id);
      expect(creates).toBe(0);
      return;
    }
    if (kind === "newer message") {
      setSystemTime(Date.now() + 1000);
      f.registry.holdDelivery(f.conversation.id, "newer operator work", "operator-followup", "text", [], null,
        { operationId: "operator-followup", kind: "send", policy: "queue", turnId: null });
    }
    const writes: string[] = [];
    const delivery = { deliver: async (input: { path: string; clientMessageId: string }) => {
      expect(input.path).toBe(successor); writes.push(input.clientMessageId); return "delivered" as const;
    } };
    spare = true;
    await kickStructuredDeliveryQueue();
    if (kind === "reviewer") {
      expect(creates).toBe(0);
      expect(store.list()[0]!.resolution).toContain("flow relaunches");
      expect(f.registry.conversationMemberships(f.conversation.id)).toMatchObject([{ containerId: "fixture-owner", role: "reviewer", round: 1 }]);
      return;
    }
    expect(creates).toBe(0);
    await reconcileAccountMigrationCycle(f.registry, { tick: async () => {} }, provider, delivery);
    expect(creates).toBe(1);
    expect(f.registry.conversation(f.conversation.id)?.generations.at(-1)).toMatchObject({ accountId: "account-b", path: successor });
    await drainHeldDeliveries(f.conversation.id, delivery, f.registry);
    await kickStructuredDeliveryQueue();
    await drainHeldDeliveries(f.conversation.id, delivery, f.registry);
    expect(writes).toEqual([kind === "newer message" ? "operator-followup" : store.list()[0]!.id]);
    expect(creates).toBe(1);
    expect(store.list()[0]!.state).toBe(kind === "newer message" ? "discharged" : "delivered");
  } finally { selection.mockRestore(); await f.cleanup(); }
});

test("a persisted guard migration rechecks capacity before creating its successor", async () => {
  const f = fixture();
  f.registry.requestConversationReseat(f.conversation.id, "account-b", undefined, undefined, true);
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const reopened = new AgentRegistry(f.registry.filename, undefined, undefined, { sqliteMode: "sqlite" });
  const selection = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "exhausted", resetsAt: null, allowedAccountIds: ["account-b"] });
  let creates = 0;
  try {
    expect(reopened.conversation(f.conversation.id)?.migration?.creditGuard).toBe(true);
    await advanceConversationMigration(f.conversation.id, reopened, { virtualSource: true,
      create: async () => { creates++; throw Error("inadmissible target must not launch"); }, verify: async () => {} }, { deferBoardRepair: true });
    expect(creates).toBe(0);
    expect(reopened.conversation(f.conversation.id)?.generations).toHaveLength(1);
    expect(reopened.conversation(f.conversation.id)?.migration?.phase).toBe("failed-recoverable");
  } finally { selection.mockRestore(); reopened.close(); await f.cleanup(); }
});

test("a new active turn replaces an older owed cut before its host is stopped", async () => {
  const f = fixture();
  const store = interruptionObligationStore(interruptionObligationDirectory(f.registry.filename));
  store.record({ conversationId: f.conversation.id, engine: "codex", hostKey: `codex:${f.key.sessionId}`,
    path: f.conversation.generations[0]!.path, owner: { pid: 1, startIdentity: "fake:1" }, claimEpoch: 1,
    turnRef: "older-turn", boundary: "paid-credit-guard", reason: "account-guard", checkpoint: { lastEventKind: null, lastEventAt: Date.now() }, seat: null });
  f.registry.recordQuotaObservation({ engine: "codex", accountId: "account-a", authenticated: true, authCheckedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(), bootId: "fixture", provenance: { source: "live", reason: null, staleSince: null },
    limits: { session: null, weekly: { usedPercent: 99, resetsAt: null }, plan: "pro", capturedAt: Date.now() / 1000,
      credits: { hasCredits: true, balance: "10", unlimited: false } } });
  let active = true;
  const health = f.host.health.bind(f.host);
  f.host.health = async () => ({ ...await health(), status: active ? "active" : "dead", activeTurnRef: active ? "current-turn" : null });
  f.host.release = async () => { active = false; };
  const selection = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "exhausted", resetsAt: null, allowedAccountIds: ["account-a"] });
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }], { registry: f.registry, client: f.client,
      hostlessSettleIntervalMs: 0, watchdogIntervalMs: 0, settlementSweepMs: 0 });
    await kickStructuredDeliveryQueue();
    expect(active).toBe(false);
    expect(store.list().find(cut => cut.turnRef === "older-turn")?.state).toBe("discharged");
    expect(store.list().filter(cut => cut.state === "owed")).toMatchObject([{ turnRef: "current-turn" }]);
  } finally { selection.mockRestore(); await f.cleanup(); }
});

test.each(["before dispatch", "during journal transition"])("paid-credit guard refuses a queued Codex turn %s", async phase => {
  const f = fixture();
  const observe = (usedPercent: number) => f.registry.recordQuotaObservation({ engine: "codex", accountId: "account-a",
    authenticated: true, authCheckedAt: new Date().toISOString(), observedAt: new Date().toISOString(), bootId: "fixture",
    provenance: { source: "live", reason: null, staleSince: null }, limits: { session: null,
      weekly: { usedPercent, resetsAt: Math.floor(Date.now() / 1000) + 86400 }, plan: "pro", capturedAt: Date.now() / 1000,
      credits: { hasCredits: true, balance: "10", unlimited: false } } });
  observe(phase === "before dispatch" ? 99 : 98);
  const transition = f.client.transitionOperation.bind(f.client);
  f.client.transitionOperation = async (...args) => {
    if (phase === "during journal transition" && args[0] === "guarded-send" && args[1] === "delivering") observe(99);
    return transition(...args);
  };
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }], { registry: f.registry, client: f.client,
      hostlessSettleIntervalMs: 0, watchdogIntervalMs: 0, settlementSweepMs: 0 });
    f.journal.executeOperation({ kind: "send", operationId: "guarded-send", idempotencyKey: "guarded-send",
      conversationId: f.conversation.id, text: "continue", policy: "queue" });
    await kickStructuredDeliveryQueue();
    expect(f.host.ledger.writes).toHaveLength(0);
    expect(f.journal.operationResult("guarded-send")?.receipt).toMatchObject({ status: "failed", reason: expect.stringContaining("paid-credit guard") });
    observe(1);
    f.journal.executeOperation({ kind: "send", operationId: "after-reset", idempotencyKey: "after-reset",
      conversationId: f.conversation.id, text: "continue", policy: "queue" });
    await kickStructuredDeliveryQueue();
    expect(f.host.ledger.writes).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test("a production drain settles a native entry solely through canonical reconciliation (#1674)", async () => {
  const f = fixture();
  const binding = { threadId: f.key.sessionId, accountId: "account-a" };
  const input = [{ type: "text" as const, text: "queued native message" }];
  let proof: NativeQueueProof | null = null;
  let evidenceReads = 0;
  let actuations = 0;
  const nativeHost = Object.assign(f.host, { nativeQueue: {
    queue: new NativeCodexQueue({ rpc: async () => { actuations++; throw new Error("reconciliation must not actuate Codex"); } }, binding.threadId),
    prepare: async () => input,
    evidence: async () => { evidenceReads++; return proof; },
    sendWithdrawn: async () => { actuations++; throw new Error("reconciliation must not send"); },
  } });
  const health = nativeHost.health.bind(nativeHost);
  nativeHost.health = async () => ({ ...await health(), activeFlags: ["native-queue"] });
  f.client.nativeQueueRead = async id => f.journal.nativeQueueRead(id);
  f.client.nativeQueueTransition = async (id, change) => f.journal.nativeQueueTransition(id, change);
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: nativeHost }], {
      registry: f.registry, client: f.client,
      hostlessSettleIntervalMs: 0, watchdogIntervalMs: 0, settlementSweepMs: 0,
    });
    expect(f.journal.executeOperation({ kind: "native-queue", operationId: "native-convergence", idempotencyKey: "native-convergence",
      conversationId: f.conversation.id, action: "add", binding, text: input[0].text }).receipt.status).toBe("queued");
    f.journal.nativeQueueTransition("native-convergence", { phase: "prepared", input });
    f.journal.nativeQueueTransition("native-convergence", { phase: "acknowledged", nativeSubmissionId: "native-submission" });
    await kickStructuredDeliveryQueue();
    for (let attempt = 0; attempt < 100 && evidenceReads === 0; attempt++) await Bun.sleep(5);
    const entry = f.journal.nativeQueueRead(f.conversation.id)[0]!;
    expect(entry.state).toBe("queued");
    expect(entry.proof).toBeNull();
    expect(evidenceReads).toBeGreaterThan(0);
    proof = { threadId: binding.threadId, clientUserMessageId: entry.clientUserMessageId, revision: entry.revision,
      turnId: "canonical-turn", itemId: "canonical-item", input };
    for (let attempt = 0; attempt < 100 && f.journal.nativeQueueRead(f.conversation.id)[0]?.state !== "delivered"; attempt++) {
      await kickStructuredDeliveryQueue();
      await Bun.sleep(5);
    }
    expect(f.journal.nativeQueueRead(f.conversation.id)[0]).toMatchObject({ state: "delivered", proof });
    expect(f.journal.operationResult("native-convergence")?.receipt.status).toBe("delivered");
    expect(f.host.ledger.writes).toHaveLength(0);
    expect(actuations).toBe(0);
  } finally { await f.cleanup(); }
});

for (const phase of ["before dispatch", "during delivering journal write"] as const)
test(`production journal queue refuses a revoked owner's first prompt without a cancellation registry write (${phase})`, async () => {
  const f = fixture();
  const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.root, clientAttemptId: "relay-owner-revoked-journal", transport: "structured" });
  if (begun.kind !== "created") throw Error("owner receipt fixture unavailable");
  const operationId = `spawn_message_${begun.receipt.launchId}`;
  const conversationId = begun.receipt.conversationId;
  const key = { engine: "codex" as const, sessionId: crypto.randomUUID() };
  const profile = emptyLaunchProfile({ cwd: f.root, title: "Owner cutoff fixture" });
  const staged = f.registry.stageStructuredSpawn(begun.receipt.launchId, {
    key, artifactPath: path.join(f.root, `${key.sessionId}.jsonl`), cwd: f.root, accountId: "account-a", launchProfile: profile,
    status: "idle", host: null, structuredHost: { kind: "codex-app-server", endpoint: "fake:owner", process: null,
      eventCursor: 0, protocolVersion: "fake", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: "fixture", pendingAction: "spawn", structuredHostOperationId: begun.receipt.launchId,
  });
  if (staged.kind !== "settled") throw Error("owner host fixture unavailable");
  const delivery = f.registry.holdDelivery(conversationId, "Revoked owner instruction", `spawn_${begun.receipt.launchId}`, "text", [], null, { operationId });
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "relay-state");
  const { reserveRun, updateRelayStore } = await import("@/lib/externalRelay/store");
  const { procBackend } = await import("@/lib/proc");
  const transition = f.client.transitionOperation.bind(f.client);
  const writer = spyOn(f.client, "transitionOperation").mockImplementation(async (...args) => {
    const result = await transition(...args);
    if (phase === "during delivering journal write" && args[1] === "delivering") {
      updateRelayStore(s => ({ ...s, relays: s.relays.map(relay => ({ ...relay,
        targets: relay.targets.map(target => ({ ...target, ownerTier: false })) })) }));
    }
    return result;
  });
  if (phase === "during delivering journal write") {
    updateRelayStore(s => ({ ...s, relays: [{ id: "relay_fixture", paused: false,
      credential: crypto.randomUUID(), targets: [{ id: "target_fixture", enabled: true, ownerTier: true }] } as typeof s.relays[number]] }));
    reserveRun({ requestId: "revoked-journal", leaseId: "lease_fixture", relayId: "relay_fixture", targetId: "target_fixture",
      conversationId, ownerTurn: { clientAttemptId: begun.receipt.clientAttemptId! }, ownerPid: process.pid,
      ownerIdentity: procBackend.processIdentity(process.pid), childPid: null, childIdentity: null, runDir: "", startedAt: new Date().toISOString() }, 1);
  }
  const send = spyOn(f.host, "send");
  fs.writeFileSync(staged.entry.artifactPath, "{}\n");
  f.registry.completeSpawn(begun.receipt.launchId, { ...staged.entry, pendingAction: null });
  try {
    await bindStructuredDeliveryQueue([{ key, host: f.host }], { registry: f.registry, client: f.client });
    const admitted = f.journal.executeOperation({ kind: "send", operationId, idempotencyKey: operationId, conversationId, text: delivery.text, policy: "queue" });
    expect(admitted.receipt.status).toBe("queued");
    await kickStructuredDeliveryQueue();
    expect(send).not.toHaveBeenCalled();
    if (phase === "during delivering journal write") expect(writer.mock.calls.some(call => call[1] === "delivering")).toBe(true);
    expect(f.journal.operationResult(operationId)?.receipt.status).toBe(phase === "before dispatch" ? "uncertain" : "failed");
  } finally {
    writer.mockRestore(); send.mockRestore(); await f.cleanup();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
  }
});

test("production journal dispatch refuses a queued owner continuation after its authority is revoked", async () => {
  const f = fixture();
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(f.root, "owner-continuation-state");
  const { reserveRun, updateRelayStore, dropRun } = await import("@/lib/externalRelay/store");
  const { procBackend } = await import("@/lib/proc");
  const requestId = "queued-continuation-revocation";
  const operationId = `relay-owner-${requestId}`;
  updateRelayStore(store => ({ ...store, relays: [{ id: "relay_fixture", paused: false,
    credential: crypto.randomUUID(), targets: [{ id: "target_fixture", enabled: true, ownerTier: true }] } as typeof store.relays[number]] }));
  reserveRun({ requestId, leaseId: "lease_fixture", relayId: "relay_fixture", targetId: "target_fixture",
    conversationId: f.conversation.id, ownerTurn: { clientAttemptId: operationId, continuation: { operationId } },
    ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid), childPid: null, childIdentity: null,
    runDir: "", startedAt: new Date().toISOString() }, 1);
  f.registry.holdDelivery(f.conversation.id, "continued owner request", operationId, "text", [], null,
    { operationId, kind: "send", policy: "queue", turnId: null });
  const send = spyOn(f.host, "send");
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }], { registry: f.registry, client: f.client });
    const admitted = f.journal.executeOperation({ kind: "send", operationId, idempotencyKey: operationId,
      conversationId: f.conversation.id, text: "continued owner request", policy: "queue" });
    expect(admitted.receipt.status).toBe("queued");
    updateRelayStore(store => ({ ...store, relays: store.relays.map(relay => ({ ...relay,
      targets: relay.targets.map(target => ({ ...target, ownerTier: false })) })) }));
    await kickStructuredDeliveryQueue();
    expect(send).not.toHaveBeenCalled();
    expect(f.journal.operationResult(operationId)?.receipt.status).not.toBe("delivered");
  } finally {
    send.mockRestore(); dropRun(requestId); await f.cleanup();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
  }
});

test("background owner first-prompt journal failures scrub logs outside the original spawn scope", async () => {
  const f = fixture();
  const previousState = process.env.LLV_STATE_DIR, previousToken = process.env.LLV_TOKEN;
  process.env.LLV_STATE_DIR = path.join(f.root, "relay-state");
  const { reserveRun, updateRelayStore } = await import("@/lib/externalRelay/store");
  const { procBackend } = await import("@/lib/proc");
  const { rotateOperatorSpawnCapability } = await import("@/lib/agent/operatorCapability");
  const relayCredential = crypto.randomUUID(), installCredential = crypto.randomUUID();
  process.env.LLV_TOKEN = installCredential;
  const spawnCredential = rotateOperatorSpawnCapability();
  const keyMaterial = "-----BEGIN PRIVATE KEY-----\nfixture-private-material\n-----END PRIVATE KEY-----";
  const leak = `${relayCredential} ${installCredential} ${spawnCredential} ${f.root} ${keyMaterial}`;
  const failure = Object.assign(new Error(leak), { details: { credential: relayCredential, transcript: f.root }, cause: new Error(leak) });
  failure.stack = `Error: ${leak}\n at ${f.root}/transcript.jsonl:12:1`;
  const emitted: unknown[][] = [];
  const logger = spyOn(console, "error").mockImplementation((...args) => { emitted.push(args); });
  let writer: ReturnType<typeof spyOn> | null = null;
  const send = spyOn(f.host, "send");
  try {
    // Recover a durable owner receipt in startup context, with no spawn async scope.
    const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.root, clientAttemptId: "relay-owner-background-diagnostic", transport: "structured" });
    if (begun.kind !== "created") throw Error("owner receipt fixture unavailable");
    const conversationId = begun.receipt.conversationId, operationId = `spawn_message_${begun.receipt.launchId}`;
    const key = { engine: "codex" as const, sessionId: crypto.randomUUID() };
    const staged = f.registry.stageStructuredSpawn(begun.receipt.launchId, {
      key, artifactPath: path.join(f.root, `${key.sessionId}.jsonl`), cwd: f.root, accountId: "account-a", launchProfile: emptyLaunchProfile({ cwd: f.root }),
      status: "idle", host: null, structuredHost: { kind: "codex-app-server", endpoint: "fake:owner", process: null,
        eventCursor: 0, protocolVersion: "fake", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
      claimEpoch: 1, claimOwner: "fixture", pendingAction: "spawn", structuredHostOperationId: begun.receipt.launchId,
    });
    if (staged.kind !== "settled") throw Error("owner host fixture unavailable");
    fs.writeFileSync(staged.entry.artifactPath, "{}\n");
    f.registry.completeSpawn(begun.receipt.launchId, { ...staged.entry, pendingAction: null });
    await bindStructuredDeliveryQueue([{ key, host: f.host }], { registry: f.registry, client: f.client });
    updateRelayStore(store => ({ ...store, relays: [{ id: "relay_fixture", paused: false,
      credential: relayCredential, targets: [{ id: "target_fixture", enabled: true, ownerTier: true }] } as typeof store.relays[number]] }));
    reserveRun({ requestId: "background-diagnostic", leaseId: "lease_fixture", relayId: "relay_fixture", targetId: "target_fixture",
      conversationId, ownerTurn: { clientAttemptId: begun.receipt.clientAttemptId! }, ownerPid: process.pid,
      ownerIdentity: procBackend.processIdentity(process.pid), childPid: null, childIdentity: null, runDir: "", startedAt: new Date().toISOString() }, 1);
    const delivery = f.registry.holdDelivery(conversationId, "Owner instruction", `spawn_${begun.receipt.launchId}`, "text", [], null, { operationId });
    const transition = f.client.transitionOperation.bind(f.client);
    writer = spyOn(f.client, "transitionOperation").mockImplementation(async (...args) => {
      if (args[1] === "delivering") throw failure;
      return transition(...args);
    });
    expect(f.journal.executeOperation({ kind: "send", operationId, idempotencyKey: operationId, conversationId, text: delivery.text, policy: "queue" }).receipt.status).toBe("queued");
    const { ownerRelaySpawnAuthorized } = await import("@/lib/externalRelay/ownerAuthority");
    expect(ownerRelaySpawnAuthorized(begun.receipt.clientAttemptId)).toBe(true);
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult(operationId)?.receipt).toMatchObject({ status: "queued" });
    expect(writer).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const logs = JSON.stringify(emitted, (_key, value) => value instanceof Error
      ? Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, (value as unknown as Record<string, unknown>)[key]])) : value);
    expect(logs).toContain("conversation drain failed");
    expect(logs).toContain("queue drain failed");
    expect(logs).toContain(conversationId);
    for (const secret of [relayCredential, installCredential, spawnCredential, f.root, "fixture-private-material", "BEGIN PRIVATE KEY"])
      expect(logs).not.toContain(secret);
  } finally {
    writer?.mockRestore(); send.mockRestore(); await f.cleanup(); logger.mockRestore();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    if (previousToken === undefined) delete process.env.LLV_TOKEN; else process.env.LLV_TOKEN = previousToken;
  }
});

test("production controller applies a pick after usage_limit_exceeded without another message or turn end", async () => {
  const f = fixture();
  let creates = 0;
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }], { registry: f.registry, client: f.client,
      reconfigure: {
        validateAccount: async () => {}, resolveAccount: () => ({}) as never, releaseHost: async () => true,
        migrate: (id, _target, registry, ownsOperation, reconfigureOperationId) => advanceConversationMigration(id, registry, {
          create: async input => { creates++; return { operationId: input.operationId, nativeId: "successor", path: path.join(f.root, "successor.jsonl"),
            continuityPaths: [], historyHash: "fixture", host: { kind: "codex-app-server", identity: "fixture-successor", epoch: 1, verifiedAt: new Date().toISOString() } }; },
          verify: async () => {},
        }, { ownsOperation, reconfigureOperationId }),
      },
    });
    f.journal.executeOperation({ kind: "reconfigure", operationId: "switch", idempotencyKey: "switch",
      conversationId: f.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-b" });
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("switch")?.receipt.status).toBe("applied");
    expect(f.registry.conversation(f.conversation.id)?.migration?.phase).toBe("committed");
    expect(f.registry.conversation(f.conversation.id)?.generations.at(-1)?.accountId).toBe("account-b");
    expect(creates).toBe(1);
  } finally { await bindStructuredDeliveryQueue([], { client: null }); f.journal.close(); f.registry.close(); }
});

test("production native-queue reconciliation bounds retries despite sixty seconds of admission wakes", async () => {
  const f = fixture();
  const nativeHost = Object.assign(f.host, { nativeQueue: {} as NonNullable<EngineHost["nativeQueue"]> });
  let reads = 0;
  f.client.nativeQueueRead = async () => { reads++; throw new Error("runtime host request timed out"); };
  f.client.nativeQueueTransition = async () => { throw new Error("unexpected transition"); };
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: nativeHost }], { registry: f.registry, client: f.client });
    let snapshots = 0;
    const snapshot = f.registry.readOnlySnapshot.bind(f.registry);
    f.registry.readOnlySnapshot = () => { snapshots++; return snapshot(); };
    const start = Date.now();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      setSystemTime(start + elapsed);
      await kickStructuredDeliveryQueue();
    }
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThanOrEqual(7);
    expect(snapshots).toBeLessThanOrEqual(40);
  } finally { await bindStructuredDeliveryQueue([], { client: null }); f.journal.close(); f.registry.close(); }
});

async function silentRuntime(root: string) {
  const sockets = new Set<net.Socket>();
  let requests = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => requests++);
  });
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\llv-silent-${crypto.randomUUID()}` : path.join(root, "host.sock");
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return { client: new UnixRuntimeHostClient(socketPath, 10, 10, 10), requests: () => requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function addTarget(f: ReturnType<typeof fixture>, name: string) {
  const entry = f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
  const pathname = path.join(f.root, `${name}.jsonl`);
  fs.writeFileSync(pathname, "");
  f.registry.reconcileConversations([{ engine: "codex", path: pathname, accountId: "account-a",
    launchProfile: entry.launchProfile!, turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: new Date().toISOString() }]);
  const conversation = f.registry.conversationForPath(pathname)!;
  const key = { engine: "codex" as const, sessionId: conversation.generations.at(-1)!.id };
  f.registry.upsert({ ...entry, key, artifactPath: pathname });
  const host = Object.assign(new FakeEngineHost(), { onStateChange: () => () => {} });
  return { key, host, conversation };
}

test.each(["native-read", "receipt-read"] as const)("production controller bounds total native execution and reconciliation reads with parked and successful targets (%s)", async fault => {
  const f = fixture();
  const silent = await silentRuntime(f.root);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const parked = addTarget(f, "parked");
  const healthy = addTarget(f, "healthy");
  const native = new NativeCodexQueue({ rpc: async () => { throw new Error("must not actuate an unreadable queue"); } }, f.key.sessionId);
  const nativeHost = Object.assign(f.host, { nativeQueue: { queue: native,
    prepare: async () => [], evidence: async () => null, sendWithdrawn: async () => { throw new Error("unexpected send"); },
  } });
  let interrupts = 0;
  nativeHost.interrupt = async () => { interrupts++; };
  const health = nativeHost.health.bind(nativeHost);
  nativeHost.health = async () => ({ ...await health(), status: "active", activeTurnRef: "native-turn", activeFlags: ["native-queue"] });
  f.client.nativeQueueRead = id => silent.client.nativeQueueRead!(id);
  f.client.nativeQueueTransition = async (id, change) => f.journal.nativeQueueTransition(id, change);
  if (fault === "receipt-read") {
    const operationStatus = f.client.operationStatus.bind(f.client);
    f.client.operationStatus = (id, options) => id === "native-send"
      ? silent.client.operationStatus(id, options) : operationStatus(id, options);
  }
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: nativeHost }, parked, healthy], { registry: f.registry, client: f.client });
    f.journal.executeOperation({ kind: "native-queue", operationId: "native-send", idempotencyKey: "native-send",
      conversationId: f.conversation.id, action: "add", text: "preserve original payload", binding: { threadId: f.key.sessionId, accountId: "account-a" } });
    f.journal.executeOperation({ kind: "reconfigure", operationId: "parked-pick", idempotencyKey: "parked-pick",
      conversationId: parked.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-b" });
    const original = f.journal.nativeQueueRead(f.conversation.id)[0]!;
    const start = Date.now();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      setSystemTime(start + elapsed);
      if (elapsed % 10_000 === 0) f.journal.executeOperation({ kind: "send", operationId: `healthy-${elapsed}`, idempotencyKey: `healthy-${elapsed}`,
        conversationId: healthy.conversation.id, text: "continue", policy: "queue" });
      if (elapsed === 50_000) f.journal.executeOperation({ kind: "interrupt", operationId: "native-interrupt", idempotencyKey: "native-interrupt",
        conversationId: f.conversation.id });
      await kickStructuredDeliveryQueue();
    }
    expect(interrupts).toBe(1);
    expect(f.journal.operationResult("native-interrupt")?.receipt.status).toBe("interrupted");
    expect(healthy.host.ledger.writes).toHaveLength(6);
    expect(f.journal.operationResult("parked-pick")?.receipt.status).toBe("queued");
    expect(f.journal.operationResult("native-send")?.receipt.status).toBe("queued");
    expect(f.journal.nativeQueueRead(f.conversation.id)[0]).toEqual(original);
    expect(silent.requests()).toBeGreaterThan(1);
    expect(silent.requests()).toBeLessThanOrEqual(14);
  } finally { await f.cleanup(); await silent.close(); errors.mockRestore(); }
}, 20_000);

test("production controller bounds effect reads when the runtime socket never answers", async () => {
  const f = fixture();
  const silent = await silentRuntime(f.root);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: f.client });
    f.client.effectBatch = (kinds, after) => silent.client.effectBatch(kinds, after);
    const start = Date.now();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      setSystemTime(start + elapsed);
      await kickStructuredDeliveryQueue();
    }
    expect(silent.requests()).toBeGreaterThan(1);
    expect(silent.requests()).toBeLessThanOrEqual(7);
  } finally { await f.cleanup(); await silent.close(); errors.mockRestore(); }
}, 20_000);

test.each(["queued", "applying"] as const)("production switch bounds unanswered applying transitions with a parked peer (durable: %s)", async durable => {
  const f = fixture();
  const parked = addTarget(f, "parked");
  const healthy = addTarget(f, "healthy");
  const silent = await silentRuntime(f.root);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  let validations = 0;
  let controlTurn: string | null = null;
  let interrupts = 0;
  const health = f.host.health.bind(f.host);
  f.host.health = async () => ({ ...await health(), ...(controlTurn ? { status: "active" as const, activeTurnRef: controlTurn } : {}) });
  f.host.interrupt = async () => { interrupts++; controlTurn = null; };
  const transition = f.client.transitionOperation.bind(f.client);
  f.client.transitionOperation = async (id, status, details, options) => {
    if (id === "switch" && status === "applying") {
      if (durable === "applying") await transition(id, status, details, options);
      return silent.client.transitionOperation(id, status, details, options);
    }
    return transition(id, status, details, options);
  };
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }, parked, healthy], { registry: f.registry, client: f.client,
      reconfigure: { validateAccount: async () => { validations++; throw new Error("replacement account requires authentication"); } },
    });
    f.journal.executeOperation({ kind: "reconfigure", operationId: "switch", idempotencyKey: "switch",
      conversationId: f.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-b" });
    f.journal.executeOperation({ kind: "reconfigure", operationId: "parked-pick", idempotencyKey: "parked-pick",
      conversationId: parked.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-b" });
    const delivery = f.registry.holdDelivery(f.conversation.id, "preserve original payload", "held-send", "text", [], null,
      { operationId: "held-send", kind: "send", policy: "queue", turnId: null });
    f.journal.executeOperation({ kind: "send", operationId: "held-send", idempotencyKey: "held-send",
      conversationId: f.conversation.id, text: "preserve original payload", policy: "queue" });
    const original = f.registry.readOnlySnapshot().heldDeliveries[delivery.id];
    const start = Date.now();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      setSystemTime(start + elapsed);
      if (elapsed % 10_000 === 0) f.journal.executeOperation({ kind: "send", operationId: `healthy-${elapsed}`, idempotencyKey: `healthy-${elapsed}`,
        conversationId: healthy.conversation.id, text: "continue", policy: "queue" });
      if (elapsed === 50_000) {
        controlTurn = "control-turn";
        f.journal.append({ scope: { type: "session", id: f.conversation.id }, kind: "session-status",
          payload: { conversationId: f.conversation.id, host: "hosted", turn: "running", activeTurnId: controlTurn } });
        f.journal.executeOperation({ kind: "interrupt", operationId: "switch-interrupt", idempotencyKey: "switch-interrupt",
          conversationId: f.conversation.id });
      }
      await kickStructuredDeliveryQueue();
    }
    expect(f.journal.operationResult("switch-interrupt")?.receipt.status).toBe("interrupted");
    expect(interrupts).toBe(1);
    expect(healthy.host.ledger.writes).toHaveLength(6);
    expect(f.journal.operationResult("switch")?.receipt.status).toBe(durable);
    expect(f.journal.operationResult("parked-pick")?.receipt.status).toBe("queued");
    expect(f.journal.operationResult("held-send")?.receipt.status).toBe("queued");
    expect(f.registry.readOnlySnapshot().heldDeliveries[delivery.id]).toEqual(original);
    expect(f.host.ledger.writes).toHaveLength(0);
    expect(validations).toBe(0);
    expect(silent.requests()).toBeGreaterThan(1);
    expect(silent.requests()).toBeLessThanOrEqual(7);
    // A fresh choice must not inherit the unanswered operation's deadline.
    f.journal.executeOperation({ kind: "reconfigure", operationId: "replacement", idempotencyKey: "replacement",
      conversationId: f.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-c" });
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("switch")?.receipt.reason).toBe("superseded");
    expect(f.journal.operationResult("replacement")?.receipt.reason).toBe("replacement account requires authentication");
    expect(validations).toBe(1);
  } finally { await f.cleanup(); await silent.close(); errors.mockRestore(); }
}, 20_000);

test.each(["queued", "applied", "failed", "cancelled", "superseded"] as const)("production switch bounds unanswered %s settlement with a parked peer", async fault => {
  const f = fixture();
  const parked = addTarget(f, "parked");
  const healthy = addTarget(f, "healthy");
  const silent = await silentRuntime(f.root);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  let creates = 0;
  let controlTurn: string | null = null;
  let interrupts = 0;
  const health = f.host.health.bind(f.host);
  f.host.health = async () => ({ ...await health(), ...(controlTurn ? { status: "active" as const, activeTurnRef: controlTurn } : {}) });
  f.host.interrupt = async () => { interrupts++; controlTurn = null; };
  const transition = f.client.transitionOperation.bind(f.client);
  const faultStatus = fault === "cancelled" || fault === "superseded" ? "failed" : fault;
  f.client.transitionOperation = (id, status, details, options) => id === "switch" && status === faultStatus
    ? silent.client.transitionOperation(id, status, details, options) : transition(id, status, details, options);
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }, parked, healthy], { registry: f.registry, client: f.client,
      reconfigure: {
        validateAccount: async () => { if (fault === "failed") throw new Error("target account requires authentication"); },
        resolveAccount: () => ({}) as never, releaseHost: async () => true,
        migrate: (id, _target, registry, ownsOperation, reconfigureOperationId) => fault === "queued"
          ? Promise.resolve(registry.conversation(id)!)
          : advanceConversationMigration(id, registry, {
            create: async input => { creates++; return { operationId: input.operationId, nativeId: "successor", path: path.join(f.root, "successor.jsonl"),
              continuityPaths: [], historyHash: "fixture", host: { kind: "codex-app-server", identity: "fixture-successor", epoch: 1, verifiedAt: new Date().toISOString() } }; },
            verify: async () => {},
          }, { ownsOperation, reconfigureOperationId }),
      },
    });
    f.journal.executeOperation({ kind: "reconfigure", operationId: "switch", idempotencyKey: "switch",
      conversationId: f.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-b" });
    f.journal.executeOperation({ kind: "reconfigure", operationId: "parked-pick", idempotencyKey: "parked-pick",
      conversationId: parked.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-b" });
    if (fault === "cancelled") f.registry.withdrawConversationReconfigure(f.conversation.id, "switch");
    if (fault === "queued" || fault === "applied" || fault === "failed") f.journal.transitionOperation("switch", "applying");
    if (fault === "superseded") f.journal.executeOperation({ kind: "reconfigure", operationId: "replacement", idempotencyKey: "replacement",
      conversationId: f.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-c" });
    const start = Date.now();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      setSystemTime(start + elapsed);
      if (elapsed % 10_000 === 0) f.journal.executeOperation({ kind: "send", operationId: `healthy-${elapsed}`, idempotencyKey: `healthy-${elapsed}`,
        conversationId: healthy.conversation.id, text: "continue", policy: "queue" });
      // Repeated controls cannot bypass the switch's deadline, even during
      // cancellation or cleanup of the previous choice.
      if (fault !== "applied" && elapsed % 10_000 === 0) {
        controlTurn = `control-${elapsed}`;
        f.journal.append({ scope: { type: "session", id: f.conversation.id }, kind: "session-status",
          payload: { conversationId: f.conversation.id, host: "hosted", turn: "running", activeTurnId: controlTurn } });
        f.journal.executeOperation({ kind: "interrupt", operationId: `interrupt-${elapsed}`, idempotencyKey: `interrupt-${elapsed}`,
          conversationId: f.conversation.id });
      }
      await kickStructuredDeliveryQueue();
    }
    expect(healthy.host.ledger.writes).toHaveLength(6);
    expect(interrupts).toBe(fault === "applied" ? 0 : 6);
    if (fault !== "applied") for (let elapsed = 0; elapsed < 60_000; elapsed += 10_000) {
      expect(f.journal.operationResult(`interrupt-${elapsed}`)?.receipt).toMatchObject({ status: "interrupted" });
    }
    expect(f.journal.operationResult("parked-pick")?.receipt.status).toBe("queued");
    expect(f.journal.operationResult("switch")?.receipt.status).toBe(fault === "cancelled" || fault === "superseded" ? "queued" : "applying");
    /* A failed switch writes its hold before its failure reaches the journal
       (docs/design/delivery-progress-and-drain.md, C3), so the hold already
       stands while that transition is unanswered. */
    if (fault === "failed") expect(f.registry.switchHold(f.conversation.id)?.reason).toBe("target account requires authentication");
    else expect(f.registry.switchHold(f.conversation.id)).toBeNull();
    expect(creates).toBe(fault === "applied" ? 1 : 0);
    expect(silent.requests()).toBeGreaterThan(1);
    expect(silent.requests()).toBeLessThanOrEqual(7);
    // Restore the transport and let the same receipt reconcile to its outcome.
    f.client.transitionOperation = transition;
    setSystemTime(start + 90_000);
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("switch")?.receipt.status).toBe(fault === "queued" ? "queued" : fault === "applied" ? "applied" : "failed");
    expect(creates).toBe(fault === "applied" || fault === "superseded" ? 1 : 0);
    if (fault === "failed") expect(f.registry.switchHold(f.conversation.id)?.reason).toBe("target account requires authentication");
  } finally { await f.cleanup(); await silent.close(); errors.mockRestore(); }
}, 20_000);

test("production applying switch bounds unreadable host checks while other sends and a replacement pick progress", async () => {
  const f = fixture();
  const other = addTarget(f, "other");
  const silent = await silentRuntime(f.root);
  let unavailable = false;
  const health = f.host.health.bind(f.host);
  f.host.health = async () => { if (unavailable) await silent.client.snapshot(); return health(); };
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }, other], { registry: f.registry, client: f.client,
      reconfigure: { validateAccount: async () => { throw new Error("replacement account requires authentication"); } },
    });
    unavailable = true;
    f.journal.executeOperation({ kind: "reconfigure", operationId: "applying", idempotencyKey: "applying",
      conversationId: f.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-b" });
    f.journal.transitionOperation("applying", "applying");
    f.registry.claimConversationReconfigure(f.conversation.id, { operationId: "applying", revision: 1,
      profile: { model: "gpt-5.6-sol", effort: "high", fast: false }, accountId: "account-b" });
    f.journal.executeOperation({ kind: "send", operationId: "other-send", idempotencyKey: "other-send",
      conversationId: other.conversation.id, text: "continue", policy: "queue" });
    const start = Date.now();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
      setSystemTime(start + elapsed);
      await kickStructuredDeliveryQueue();
    }
    expect(other.host.ledger.writes).toHaveLength(1);
    expect(f.journal.operationResult("applying")?.receipt.status).toBe("applying");
    expect(silent.requests()).toBeGreaterThan(1);
    expect(silent.requests()).toBeLessThanOrEqual(6);
    unavailable = false;
    f.journal.executeOperation({ kind: "reconfigure", operationId: "replacement", idempotencyKey: "replacement",
      conversationId: f.conversation.id, model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "account-c" });
    await kickStructuredDeliveryQueue();
    expect(f.journal.operationResult("applying")?.receipt.reason).toBe("superseded");
    expect(f.journal.operationResult("replacement")?.receipt.status).toBe("failed");
  } finally { await f.cleanup(); await silent.close(); }
}, 20_000);
