import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AgentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { MIGRATION_INTENT_PROGRESS_TIMEOUT_MS } from "@/lib/accounts/migration/intentLiveness";
import { accountManager } from "@/lib/accounts/manager";
import * as orchestratorSeats from "@/lib/orchestrator/seats";
import { terminalizeStaleUndeliverableHeldDeliveries } from "@/lib/reaperRuntime";
import { enforceAccountCreditGuard } from "./accountCreditGuard";
import { FakeEngineHost } from "./fixtures/fakeEngineHost";
import { interruptionObligationDirectory, interruptionObligationStore } from "./interruptionObligations";

const epoch = Date.parse("2030-01-01T00:00:00.000Z");
const roots: string[] = [];
afterEach(() => { setSystemTime(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function clock(ms: number) { setSystemTime(new Date(epoch + ms)); }
function observe(registry: AgentRegistry, accountId: string, usedPercent: number) {
  registry.recordQuotaObservation({ engine: "codex", accountId, authenticated: true,
    authCheckedAt: new Date().toISOString(), observedAt: new Date().toISOString(), bootId: "fixture",
    provenance: { source: "live", reason: null, staleSince: null },
    limits: { session: null, weekly: { usedPercent, resetsAt: null, observedAt: Date.now() / 1000, source: "live" }, plan: "pro", capturedAt: Date.now() / 1000,
      credits: { hasCredits: true, balance: "10", unlimited: false } } });
}
function fixture(mode: "off" | "sqlite" = "sqlite", seat?: { project: string; seatEpoch: number }
  | ((conversation: RegistryConversation) => { project: string; seatEpoch: number })) {
  clock(0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-reseat-")); roots.push(root);
  const registry = new AgentRegistry(path.join(root, "registry.json"), () => false, undefined, { sqliteMode: mode, sqliteWriterDeadlineMs: 60 });
  const routing = registry.commitMigrationIntent({ engine: "codex", targetId: "account-b", origin: "manual", requestId: "routing",
    expectedRevision: registry.engineRouting("codex").revision, scope: "all" });
  registry.setMigrationIntentState(routing.id, "complete");
  const transcript = path.join(root, "source.jsonl"); fs.writeFileSync(transcript, "");
  registry.reconcileConversations([{ engine: "codex", path: transcript, accountId: "account-a",
    launchProfile: emptyLaunchProfile({ cwd: root }), turn: { state: "busy", source: "lifecycle", terminalAt: null },
    observedAt: new Date().toISOString() }]);
  const conversation = registry.conversationForPath(transcript)!;
  const seatSnapshot = typeof seat === "function" ? seat(conversation) : seat;
  const generation = conversation.generations.at(-1)!;
  const key = { engine: "codex" as const, sessionId: generation.id };
  registry.upsert({ key, artifactPath: transcript, cwd: root, accountId: "account-a", launchProfile: generation.launchProfile,
    status: "dead", host: null, structuredHost: null, claimEpoch: 1, claimOwner: null, pendingAction: null });
  const delivered = registry.holdDelivery(conversation.id, "previous work", "previous-delivered");
  registry.recordDeliveryOutcome(delivered.id, "delivered");
  observe(registry, "account-a", 99); observe(registry, "account-b", 1);
  const store = interruptionObligationStore(interruptionObligationDirectory(registry.filename));
  const cut = store.record({ conversationId: conversation.id, engine: "codex", hostKey: `codex:${generation.id}`,
    path: transcript, owner: null, claimEpoch: 1, turnRef: "interrupted-turn", boundary: "paid-credit-guard",
    reason: "account-guard", checkpoint: { lastEventKind: null, lastEventAt: epoch }, seat: seatSnapshot ?? null }).obligation;
  const poll = () => enforceAccountCreditGuard(registry, [], async () => { throw new Error("unexpected host stop"); },
    async () => false, async () => null);
  return { root, registry, conversation, key, store, cut, poll, mode };
}
function selection(root: string) {
  return spyOn(accountManager, "resolveProjectSpawn").mockImplementation((engine, request) => ({ kind: "available",
    account: { engine, accountId: request?.requestedId ?? "account-b", kind: "managed", home: root, transcriptRoot: root,
      env: { NODE_ENV: "test" } } }));
}
async function stopAndClean(f: ReturnType<typeof fixture>, at = MIGRATION_INTENT_PROGRESS_TIMEOUT_MS) {
  clock(at);
  await terminalizeStaleUndeliverableHeldDeliveries(f.registry, Date.now(), { pidAlive: () => false, processIdentity: () => null });
  await terminalizeStaleUndeliverableHeldDeliveries(f.registry, Date.now(), { pidAlive: () => false, processIdentity: () => null });
  expect(f.registry.conversation(f.conversation.id)?.migration).toBeNull();
}

for (const mode of ["off", "sqlite"] as const) test(`unchanged dead reseat stays owed across two retry intervals and real ${mode} process restarts`, async () => {
  const f = fixture(mode); const select = selection(f.root);
  try {
    await f.poll();
    const first = f.registry.conversation(f.conversation.id)!.migration!;
    expect(first).toMatchObject({ creditGuard: true, phase: "waiting-turn" });
    await stopAndClean(f);
    if (mode === "sqlite") while (f.registry.archiveInactiveRows(1000)) { /* the stopped receipt may be cold after restart */ }
    const before = Object.keys(f.registry.readOnlySnapshot().migrationIntents);
    f.registry.close();
    const source = `
      import { setSystemTime } from "bun:test";
      import { AgentRegistry } from ${JSON.stringify(path.resolve(import.meta.dir, "../agent/registry.ts"))};
      import { enforceAccountCreditGuard } from ${JSON.stringify(path.join(import.meta.dir, "accountCreditGuard.ts"))};
      import { accountManager } from ${JSON.stringify(path.resolve(import.meta.dir, "../accounts/manager.ts"))};
      setSystemTime(new Date(Number(process.argv[3])));
      accountManager.resolveProjectSpawn = (engine, request) => ({kind:"available",account:{engine,accountId:request?.requestedId??"account-b",kind:"managed",home:process.env.HOME,transcriptRoot:process.env.HOME,env:{NODE_ENV:"test"}}});
      const registry = new AgentRegistry(process.argv[1],()=>false,undefined,{sqliteMode:process.argv[2]});
      try { await enforceAccountCreditGuard(registry,[],async()=>{throw Error("unexpected stop")},async()=>false,async()=>null); }
      finally { registry.close(); }
      console.log("guard-clock=" + Date.now());`;
    for (let interval = 2; interval <= 3; interval++) {
      clock(interval * MIGRATION_INTENT_PROGRESS_TIMEOUT_MS);
      const child = Bun.spawn([process.execPath, "-e", source, f.registry.filename, mode, String(Date.now())], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      const output = new Response(child.stdout).text(); const errors = new Response(child.stderr).text();
      expect(await child.exited, await errors).toBe(0);
      expect(await output).toContain(`guard-clock=${epoch + interval * MIGRATION_INTENT_PROGRESS_TIMEOUT_MS}`);
      const read = new AgentRegistry(f.registry.filename, () => false, undefined, { sqliteMode: mode });
      try {
        expect(Object.keys(read.readOnlySnapshot().migrationIntents)).toEqual(before);
        expect(read.conversation(f.conversation.id)?.migration).toBeNull();
        expect(interruptionObligationStore(interruptionObligationDirectory(read.filename)).list()).toMatchObject([{ id: f.cut.id, state: "owed", attempts: 0 }]);
      } finally { read.close(); }
    }
  } finally { select.mockRestore(); f.registry.close(); }
});

for (const evidence of ["quota refresh", "credit change", "new delivery", "live host", "target change", "manual request"] as const) {
  test(`${evidence} ${evidence === "quota refresh" ? "preserves" : "reopens"} stopped dead-generation recovery`, async () => {
    const f = fixture(); const select = selection(f.root);
    try {
      await f.poll(); await stopAndClean(f);
      const before = Object.keys(f.registry.readOnlySnapshot().migrationIntents).length;
      clock(2 * MIGRATION_INTENT_PROGRESS_TIMEOUT_MS);
      if (evidence === "quota refresh") { observe(f.registry, "account-a", 99); observe(f.registry, "account-b", 1); }
      if (evidence === "credit change") observe(f.registry, "account-b", 2);
      if (evidence === "new delivery") f.registry.holdDelivery(f.conversation.id, "new work", "new-delivery");
      if (evidence === "live host") f.registry.upsert({ ...f.registry.hostEntry(f.key)!, status: "idle" });
      if (evidence === "target change") select.mockReturnValue({ kind: "available", account: { engine: "codex", accountId: "account-c", kind: "managed", home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } } });
      if (evidence === "manual request" || evidence === "live host") f.registry.requestConversationReseat(f.conversation.id, "account-b", undefined, undefined,
        evidence === "live host" ? true : undefined, evidence === "live host" ? f.cut.id : undefined);
      else await f.poll();
      expect(Object.keys(f.registry.readOnlySnapshot().migrationIntents)).toHaveLength(before + (evidence === "quota refresh" ? 0 : 1));
      expect(f.store.list()).toMatchObject([{ id: f.cut.id, state: "owed", attempts: 0 }]);
    } finally { select.mockRestore(); f.registry.close(); }
  });
}

test("recovered source credit delivers the preserved obligation after a stopped reseat", async () => {
  const f = fixture(); const select = selection(f.root);
  try {
    await f.poll(); await stopAndClean(f);
    clock(2 * MIGRATION_INTENT_PROGRESS_TIMEOUT_MS);
    observe(f.registry, "account-a", 1);
    let sends = 0;
    await enforceAccountCreditGuard(f.registry, [], async () => true, async () => false, async request => {
      request.recoveryAuthorityGuard!(); sends++;
      expect(request.clientMessageId).toBe(f.cut.id);
      return { ok: true, structured: true, outcome: "delivered", operationId: f.cut.id, target: f.conversation.id,
        receipt: { operationId: f.cut.id, idempotencyKey: f.cut.id, conversationId: f.conversation.id,
          kind: "send", status: "delivered", revision: 1, at: new Date().toISOString() } };
    });
    expect(sends).toBe(1);
    expect(f.store.list()).toMatchObject([{ id: f.cut.id, state: "delivered", attempts: 1 }]);
  } finally { select.mockRestore(); f.registry.close(); }
});

test("a new generation can reseat again while the original cut remains owed", async () => {
  const f = fixture(); const select = selection(f.root);
  try {
    await f.poll(); await stopAndClean(f);
    f.registry.holdDelivery(f.conversation.id, "new work", "new-generation-delivery");
    await f.poll();
    const migration = f.registry.conversation(f.conversation.id)!.migration!;
    f.registry.transitionConversationMigration(f.conversation.id, migration.revision, ["waiting-turn", "requested"], { phase: "preparing" });
    f.registry.transitionConversationMigration(f.conversation.id, migration.revision, ["preparing"], { phase: "successor-starting" });
    const successorPath = path.join(f.root, "successor.jsonl"); fs.writeFileSync(successorPath, "");
    const receipt = { operationId: migration.operationId, nativeId: "successor-generation", path: successorPath,
      continuityPaths: [successorPath], historyHash: "fixture", host: { kind: "codex-app-server" as const,
        identity: "fixture", epoch: 1, verifiedAt: new Date().toISOString() } };
    f.registry.persistMigrationProviderReceipt(f.conversation.id, migration.revision, migration.operationId, receipt);
    f.registry.commitSuccessor(f.conversation.id, { id: receipt.nativeId, path: receipt.path, accountId: "account-b",
      historyHash: receipt.historyHash, host: receipt.host }, migration.revision, migration.operationId, receipt);
    observe(f.registry, "account-b", 99);
    select.mockReturnValue({ kind: "available", account: { engine: "codex", accountId: "account-c", kind: "managed",
      home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } } });
    await f.poll();
    expect(f.registry.conversation(f.conversation.id)?.migration).toMatchObject({ creditGuard: true,
      sourceGenerationId: "successor-generation", targetId: "account-c" });
    expect(f.store.list()).toMatchObject([{ id: f.cut.id, state: "owed", attempts: 0 }]);
  } finally { select.mockRestore(); f.registry.close(); }
});

test("a failed onward guard reseat keeps the original cut owed after reaper cleanup", async () => {
  const f = fixture(); const select = selection(f.root);
  try {
    await f.poll();
    const first = f.registry.conversation(f.conversation.id)!.migration!;
    f.registry.transitionConversationMigration(f.conversation.id, first.revision, ["waiting-turn", "requested"], { phase: "preparing" });
    f.registry.transitionConversationMigration(f.conversation.id, first.revision, ["preparing"], { phase: "successor-starting" });
    const pathB = path.join(f.root, "successor-b.jsonl"); fs.writeFileSync(pathB, "");
    const receiptB = { operationId: first.operationId, nativeId: "successor-b", path: pathB, continuityPaths: [pathB],
      historyHash: "fixture-b", host: { kind: "codex-app-server" as const, identity: "fixture-b", epoch: 1, verifiedAt: new Date().toISOString() } };
    f.registry.persistMigrationProviderReceipt(f.conversation.id, first.revision, first.operationId, receiptB);
    f.registry.commitSuccessor(f.conversation.id, { id: receiptB.nativeId, path: pathB, accountId: "account-b",
      historyHash: receiptB.historyHash, host: receiptB.host }, first.revision, first.operationId, receiptB);

    observe(f.registry, "account-b", 99);
    select.mockReturnValue({ kind: "available", account: { engine: "codex", accountId: "account-c", kind: "managed",
      home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } } });
    await f.poll();
    const onward = f.registry.conversation(f.conversation.id)!.migration!;
    expect(onward).toMatchObject({ creditGuard: true, sourceGenerationId: "successor-b", targetId: "account-c" });
    await stopAndClean(f);
    const before = Object.keys(f.registry.readOnlySnapshot().migrationIntents);
    f.registry.close();
    const reopened = new AgentRegistry(f.registry.filename, () => false, undefined, { sqliteMode: f.mode });
    try {
      await enforceAccountCreditGuard(reopened, [], async () => { throw new Error("unexpected host stop"); },
        async () => false, async () => null);
      expect(reopened.conversation(f.conversation.id)?.migration).toBeNull();
      expect(Object.keys(reopened.readOnlySnapshot().migrationIntents)).toEqual(before);
      expect(interruptionObligationStore(interruptionObligationDirectory(reopened.filename)).list())
        .toMatchObject([{ id: f.cut.id, state: "owed", attempts: 0 }]);
      observe(reopened, "account-b", 1);
      select.mockReturnValue({ kind: "available", account: { engine: "codex", accountId: "account-c", kind: "managed",
        home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } } });
      await enforceAccountCreditGuard(reopened, [], async () => true, async () => false, async () => null);
      let recovery = reopened.conversation(f.conversation.id)!.migration!;
      expect(recovery).toMatchObject({ creditGuard: true, targetId: "account-c" });
      recovery = reopened.transitionConversationMigration(f.conversation.id, recovery.revision,
        ["waiting-turn", "requested"], { phase: "preparing" }).migration!;
      recovery = reopened.transitionConversationMigration(f.conversation.id, recovery.revision,
        ["preparing"], { phase: "successor-starting" }).migration!;
      const pathC = path.join(f.root, "successor-c.jsonl"); fs.writeFileSync(pathC, "");
      const receiptC = { operationId: recovery.operationId, nativeId: "successor-c", path: pathC, continuityPaths: [pathC],
        historyHash: "fixture-c", host: { kind: "codex-app-server" as const, identity: "fixture-c", epoch: 1, verifiedAt: new Date().toISOString() } };
      reopened.persistMigrationProviderReceipt(f.conversation.id, recovery.revision, recovery.operationId, receiptC);
      reopened.commitSuccessor(f.conversation.id, { id: receiptC.nativeId, path: pathC, accountId: "account-c",
        historyHash: receiptC.historyHash, host: receiptC.host }, recovery.revision, recovery.operationId, receiptC);
      observe(reopened, "account-c", 1);
      await enforceAccountCreditGuard(reopened, [], async () => true, async () => false, async () => null);
      const queued = Object.values(reopened.conversationDeliverySnapshot({ conversationId: f.conversation.id }).heldDeliveries)
        .filter(delivery => delivery.clientMessageId === f.cut.id);
      expect(queued).toHaveLength(1);
      reopened.recordDeliveryOutcome(queued[0]!.id, "delivered");
      await enforceAccountCreditGuard(reopened, [], async () => true, async () => false, async () => null);
      expect(interruptionObligationStore(interruptionObligationDirectory(reopened.filename)).list())
        .toMatchObject([{ id: f.cut.id, state: "delivered", attempts: 1 }]);
    } finally { reopened.close(); }
  } finally { select.mockRestore(); }
});

test("restored capacity on the current successor delivers the preserved cut through stopped guard lineage", async () => {
  const f = fixture(); const select = selection(f.root);
  try {
    await f.poll();
    const first = f.registry.conversation(f.conversation.id)!.migration!;
    f.registry.transitionConversationMigration(f.conversation.id, first.revision, ["waiting-turn", "requested"], { phase: "preparing" });
    f.registry.transitionConversationMigration(f.conversation.id, first.revision, ["preparing"], { phase: "successor-starting" });
    const successor = path.join(f.root, "successor-b.jsonl"); fs.writeFileSync(successor, "");
    const receipt = { operationId: first.operationId, nativeId: "successor-b", path: successor, continuityPaths: [successor],
      historyHash: "fixture-b", host: { kind: "codex-app-server" as const, identity: "fixture-b", epoch: 1, verifiedAt: new Date().toISOString() } };
    f.registry.persistMigrationProviderReceipt(f.conversation.id, first.revision, first.operationId, receipt);
    f.registry.commitSuccessor(f.conversation.id, { id: receipt.nativeId, path: successor, accountId: "account-b",
      historyHash: receipt.historyHash, host: receipt.host }, first.revision, first.operationId, receipt);
    observe(f.registry, "account-b", 99);
    select.mockReturnValue({ kind: "available", account: { engine: "codex", accountId: "account-c", kind: "managed",
      home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } } });
    await f.poll();
    expect(f.registry.conversation(f.conversation.id)?.migration).toMatchObject({ creditGuard: true, sourceGenerationId: "successor-b", targetId: "account-c" });
    await stopAndClean(f);
    observe(f.registry, "account-b", 1);
    observe(f.registry, "account-c", 1);
    select.mockImplementation((engine, request) => ({ kind: "available", account: { engine,
      accountId: request?.requestedId ?? "account-b", kind: "managed", home: f.root, transcriptRoot: f.root,
      env: { NODE_ENV: "test" } } }));
    await enforceAccountCreditGuard(f.registry, [], async () => { throw new Error("unexpected host stop"); }, async () => false,
      async () => null);
    const queued = Object.values(f.registry.conversationDeliverySnapshot({ conversationId: f.conversation.id }).heldDeliveries)
      .filter(delivery => delivery.clientMessageId === f.cut.id);
    expect(queued).toHaveLength(1);
    expect(f.store.list()).toMatchObject([{ id: f.cut.id, state: "submitted", attempts: 1 }]);
    f.registry.recordDeliveryOutcome(queued[0]!.id, "delivered");
    await enforceAccountCreditGuard(f.registry, [], async () => { throw new Error("unexpected host stop"); }, async () => false,
      async () => null);
    expect(f.store.list()).toMatchObject([{ id: f.cut.id, state: "delivered", attempts: 1 }]);
  } finally { select.mockRestore(); f.registry.close(); }
});

test("seat rotation during reseat writer admission leaves no stale-seat migration", async () => {
  const seatProject = `fixture-project-${randomUUID()}`;
  const designate = (requestId: string, conversationId: string) => {
    orchestratorSeats.beginOrchestratorSeatIntent({ project: seatProject, mandate: "fixture", clientRequestId: requestId,
      mode: "existing", now: new Date(epoch).toISOString() });
    return orchestratorSeats.completeOrchestratorSeatIntent({ project: seatProject, clientRequestId: requestId,
      conversationId, path: null, now: new Date(epoch).toISOString() });
  };
  const f = fixture("sqlite", conversation => {
    designate("initial-seat", conversation.id);
    return { project: seatProject, seatEpoch: orchestratorSeats.orchestratorSeatFor(seatProject).active!.seatEpoch };
  });
  const select = selection(f.root);
  expect(orchestratorSeats.orchestratorSeatFor(seatProject).active)
    .toMatchObject({ project: seatProject, conversationId: f.conversation.id });
  expect(orchestratorSeats.orchestratorSeatFor(seatProject).active?.seatEpoch).toBe(f.cut.seat?.seatEpoch);
  expect(f.store.list()).toMatchObject([{ id: f.cut.id, state: "owed" }]);
  let rotateDuringResolution = true;
  let rotated = false;
  select.mockImplementation((engine, request) => {
    if (rotateDuringResolution && !rotated) {
      // Complete a real durable seat rotation during account target resolution,
      // after the guard read its seat epoch and before it can commit the reseat.
      rotated = true;
      designate("rotated-seat", "conversation_successor");
    }
    return { kind: "available", account: { engine, accountId: request?.requestedId ?? "account-b", kind: "managed",
      home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } } };
  });
  try {
    await expect(f.poll()).rejects.toThrow("lost orchestrator seat custody");
    rotateDuringResolution = false;
    expect(rotated).toBe(true);
    const rotatedSeat = orchestratorSeats.orchestratorSeatFor(seatProject).active;
    expect(rotatedSeat).toMatchObject({ project: seatProject, conversationId: "conversation_successor" });
    expect(rotatedSeat!.seatEpoch).toBeGreaterThan(f.cut.seat!.seatEpoch);
    expect(f.registry.conversation(f.conversation.id)?.migration).toBeNull();
    expect(Object.values(f.registry.readOnlySnapshot().migrationIntents).filter(intent =>
      intent.requestIds.some(requestId => requestId.startsWith(`reseat:${f.conversation.id}:`)))).toHaveLength(0);
    expect(Object.values(f.registry.conversationDeliverySnapshot({ conversationId: f.conversation.id }).heldDeliveries)
      .filter(delivery => delivery.clientMessageId === f.cut.id)).toHaveLength(0);
  } finally { select.mockRestore(); f.registry.close(); }
});

test("a stopped guard cut waits for an independent engine drain and resumes after that drain stops", async () => {
  const f = fixture(); const select = selection(f.root);
  try {
    await f.poll();
    const first = f.registry.conversation(f.conversation.id)!.migration!;
    f.registry.transitionConversationMigration(f.conversation.id, first.revision, ["waiting-turn", "requested"], { phase: "preparing" });
    f.registry.transitionConversationMigration(f.conversation.id, first.revision, ["preparing"], { phase: "successor-starting" });
    const pathB = path.join(f.root, "successor-b.jsonl"); fs.writeFileSync(pathB, "");
    const receiptB = { operationId: first.operationId, nativeId: "successor-b", path: pathB, continuityPaths: [pathB],
      historyHash: "fixture-b", host: { kind: "codex-app-server" as const, identity: "fixture-b", epoch: 1, verifiedAt: new Date().toISOString() } };
    f.registry.persistMigrationProviderReceipt(f.conversation.id, first.revision, first.operationId, receiptB);
    f.registry.commitSuccessor(f.conversation.id, { id: receiptB.nativeId, path: pathB, accountId: "account-b",
      historyHash: receiptB.historyHash, host: receiptB.host }, first.revision, first.operationId, receiptB);

    observe(f.registry, "account-b", 99);
    select.mockReturnValue({ kind: "available", account: { engine: "codex", accountId: "account-c", kind: "managed",
      home: f.root, transcriptRoot: f.root, env: { NODE_ENV: "test" } } });
    await f.poll();
    expect(f.registry.conversation(f.conversation.id)?.migration).toMatchObject({ creditGuard: true,
      sourceGenerationId: "successor-b", targetId: "account-c" });
    await stopAndClean(f);

    const route = f.registry.engineRouting("codex");
    const drain = f.registry.commitMigrationIntent({ engine: "codex", targetId: "account-d", origin: "manual",
      requestId: "independent-engine-drain", expectedRevision: route.revision, scope: "all" });
    expect(f.registry.conversation(f.conversation.id)?.migration).toMatchObject({ intentId: drain.id, targetId: "account-d" });
    observe(f.registry, "account-b", 1);
    select.mockImplementation((engine, request) => ({ kind: "available", account: { engine,
      accountId: request?.requestedId ?? "account-b", kind: "managed", home: f.root, transcriptRoot: f.root,
      env: { NODE_ENV: "test" } } }));
    await f.poll();
    expect(Object.values(f.registry.conversationDeliverySnapshot({ conversationId: f.conversation.id }).heldDeliveries)
      .filter(delivery => delivery.clientMessageId === f.cut.id)).toHaveLength(0);
    expect(f.store.list()).toMatchObject([{ id: f.cut.id, state: "owed", attempts: 0 }]);

    expect((await f.registry.stopMigrationIntent(drain.id)).acquired).toBe(true);
    expect(f.registry.migrationIntent(drain.id)?.state).toBe("stopped");
    expect(f.registry.conversation(f.conversation.id)?.migration).toMatchObject({ intentId: drain.id, phase: "rolled-back" });
    await f.poll();
    const queued = Object.values(f.registry.conversationDeliverySnapshot({ conversationId: f.conversation.id }).heldDeliveries)
      .filter(delivery => delivery.clientMessageId === f.cut.id);
    expect(queued).toHaveLength(1);
    expect(f.store.list()).toMatchObject([{ id: f.cut.id, state: "submitted", attempts: 1 }]);
  } finally { select.mockRestore(); f.registry.close(); }
});

test("an explicit reseat joining an in-flight guard operation preserves its automatic retry receipt", async () => {
  const f = fixture(); const select = selection(f.root);
  try {
    await f.poll();
    expect(f.registry.conversation(f.conversation.id)?.migration).toMatchObject({ targetId: "account-b", creditGuard: true });
    const joined = f.registry.requestConversationReseat(f.conversation.id, "account-c");
    expect(joined.migration).toMatchObject({ targetId: "account-b", creditGuard: true });
    expect(joined.creditGuardReseat).toBeDefined();
    const before = Object.keys(f.registry.readOnlySnapshot().migrationIntents);
    await stopAndClean(f);
    for (const interval of [2, 3]) {
      clock(interval * MIGRATION_INTENT_PROGRESS_TIMEOUT_MS);
      await f.poll();
      expect(Object.keys(f.registry.readOnlySnapshot().migrationIntents)).toEqual(before);
      expect(f.store.list()).toMatchObject([{ id: f.cut.id, state: "owed", attempts: 0 }]);
    }
  } finally { select.mockRestore(); f.registry.close(); }
});

test("new work on a revived host rearms recovery even when the stop returns the same generation to dead", async () => {
  const f = fixture(); const select = selection(f.root);
  try {
    await f.poll(); await stopAndClean(f);
    clock(2 * MIGRATION_INTENT_PROGRESS_TIMEOUT_MS);
    const host = new FakeEngineHost();
    const health = await host.health();
    host.health = async () => ({ ...health, status: "active", activeTurnRef: "new-live-turn" });
    f.registry.upsert({ ...f.registry.hostEntry(f.key)!, status: "live", structuredHost: {
      kind: "codex-app-server", endpoint: "fake:revived", process: null, eventCursor: 1, protocolVersion: "fake",
      writerClaimEpoch: 1, activeTurnRef: "new-live-turn", pendingAttention: [], activeFlags: [] } });
    let stops = 0;
    await enforceAccountCreditGuard(f.registry, [{ key: f.key, host }], async (key, stoppedHost) => {
      expect(key).toEqual(f.key); expect(stoppedHost).toBe(host); stops++;
      f.registry.upsert({ ...f.registry.hostEntry(f.key)!, status: "dead", structuredHost: null });
      return true;
    }, async () => false, async () => null);
    expect(stops).toBe(1);
    expect(f.registry.conversation(f.conversation.id)?.migration).toMatchObject({ creditGuard: true, targetId: "account-b" });
    expect(f.store.list().filter(row => row.state === "owed")).toMatchObject([{ turnRef: "new-live-turn" }]);
  } finally { select.mockRestore(); f.registry.close(); }
});

for (const change of ["delivery", "probe clock"] as const) test(`guard reevaluates ${change} after asynchronous writer admission`, async () => {
  const f = fixture(); const select = selection(f.root);
  try {
    await f.poll(); await stopAndClean(f);
    const before = f.registry.conversation(f.conversation.id)!;
    const write = f.registry.deliveryWriteOrBusy.bind(f.registry);
    const admission = spyOn(f.registry, "deliveryWriteOrBusy").mockImplementation(async (correlation, callback) => {
      await Promise.resolve();
      if (correlation.label === "account-credit-guard.reseat") {
        clock(2 * MIGRATION_INTENT_PROGRESS_TIMEOUT_MS);
        if (change === "delivery") f.registry.holdDelivery(f.conversation.id, "new work", "admission-delivery");
        else observe(f.registry, "account-a", 99);
      }
      return write(correlation, callback);
    });
    try {
      await f.poll();
      const after = f.registry.conversation(f.conversation.id)!;
      if (change === "delivery") expect(after.migration).toMatchObject({ creditGuard: true, targetId: "account-b" });
      else expect(after).toEqual(before);
      expect(f.store.list()).toMatchObject([{ id: f.cut.id, state: "owed", attempts: 0 }]);
    } finally { admission.mockRestore(); }
  } finally { select.mockRestore(); f.registry.close(); }
});

test("refused writer admission preserves the last receipt and retries fresh evidence after release", async () => {
  const f = fixture(); const select = selection(f.root);
  const peer = new Database(path.join(f.root, "registry.sqlite")); let held = false;
  try {
    await f.poll(); await stopAndClean(f);
    f.registry.holdDelivery(f.conversation.id, "new work", "writer-refusal-delivery");
    const before = f.registry.conversation(f.conversation.id);
    const deliveries = f.registry.conversationDeliverySnapshot({ conversationId: f.conversation.id });
    peer.exec("BEGIN IMMEDIATE"); held = true;
    await expect(f.poll()).rejects.toThrow();
    expect(f.registry.conversation(f.conversation.id)).toEqual(before);
    expect(f.registry.conversationDeliverySnapshot({ conversationId: f.conversation.id })).toEqual(deliveries);
    expect(f.store.list()).toMatchObject([{ id: f.cut.id, state: "owed", attempts: 0 }]);
    peer.exec("ROLLBACK"); held = false;
    await f.poll();
    expect(f.registry.conversation(f.conversation.id)?.migration).toMatchObject({ creditGuard: true, targetId: "account-b" });
  } finally { if (held) peer.exec("ROLLBACK"); peer.close(); select.mockRestore(); f.registry.close(); }
});
