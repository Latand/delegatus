import { registryLockHolder, whileRegistryWriterHeld } from "@/lib/agent/registryLockHolderFixture";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, expect, setSystemTime, spyOn, test } from "bun:test";

/* Isolated state only: this suite writes real registry files and a real runtime
   journal, neither of which may be the operator's. Nothing here addresses a
   real conversation — every send is built in a fixture. */
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-send-settlement-"));
const isolatedEnvironment = {
  HOME: path.join(isolated, "home"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  LLV_STATE_DIR: path.join(isolated, "state"),
  TMPDIR: path.join(isolated, "tmp"),
};
/* Restored in afterAll: a bun run that carries several test files shares one
   process, so an isolated TMPDIR this file then deletes would strand every
   later file's mkdtemp. */
const ambientEnvironment = Object.fromEntries(
  Object.keys(isolatedEnvironment).map((name) => [name, process.env[name]]),
);
for (const [name, directory] of Object.entries(isolatedEnvironment)) {
  fs.mkdirSync(directory, { recursive: true });
  process.env[name] = directory;
}

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { StructuredDeliveryQueue } = await import("./structuredDeliveryQueue");
const failureNotices = await import("./sendFailureNotice");
const {
  SEND_LOST_REASON,
  SEND_UNSETTLEABLE_REASON,
  SEND_UNRECORDED_REASON,
  SEND_UNVERIFIED_REASON,
  resolveSendReceipt,
  runtimeReceiptForSend,
  sendIsSettled,
  sendReceiptFor,
  settleDueSends,
  mirrorSettledReceipts,
  mirrorSettledReceiptsAsync,
} = await import("./sendSettlement");
const { handleRuntimeOperationQuery, handleRuntimeRetry } = await import("./http");
const { NextRequest } = await import("next/server");
const { FileClaudeDeliveryLedger } = await import("./claudeStreamBrokerHost");
const { deliveryDedupToken } = await import("./deliveryDedup");
const { encodeCodexStructuredUserText } = await import("./codexStructuredUserText.server");
const { structuredContent } = await import("./structuredContent");
type AgentRegistry = InstanceType<typeof AgentRegistry>;
type RuntimeJournal = InstanceType<typeof RuntimeJournal>;
type RuntimeHostClient = import("./client").RuntimeHostClient;
type StructuredDeliveryQueuePort = import("./structuredDeliveryQueue").StructuredDeliveryQueuePort;
type EngineHost = import("./engineHost").EngineHost;
type HostState = import("./engineHost").HostState;
type QueueEntry = import("./engineHost").QueueEntry;
type DeliveryReceipt = import("./engineHost").DeliveryReceipt;
type ViewerConversationId = `conversation_${string}`;

afterAll(() => {
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
});

const SETTLEMENT_WINDOW_MS = 10 * 60_000;
/** Every fixture send is accepted "now"; the settlement is driven from a clock
    past the window instead of sleeping through it. */
const AFTER_THE_WINDOW = () => Date.now() + SETTLEMENT_WINDOW_MS + 60_000;

function runtimeClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    events: async (after: number) => journal.replay(after),
    waitEvents: async (after: number) => journal.replay(after),
    append: async (event) => journal.append(event),
    operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId: string, options?: { currentRetryLeaf?: boolean }) =>
      (options?.currentRetryLeaf ? journal.currentRetryResult(operationId) : journal.operationResult(operationId)),
    claimDeliveryAction: async (operationId, action) => journal.claimDeliveryAction(operationId, action),
    producerCursor: async (producerKind: string, eventKeyPrefix: string) =>
      journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details, options) => journal.transitionOperation(operationId, status, details, options),
    retryOperation: async (operationId, nextIdempotencyKey) => journal.retryOperation(operationId, nextIdempotencyKey),
  } as RuntimeHostClient;
}

function idleState(sessionKey: string): HostState {
  return {
    status: "idle",
    sessionKey,
    endpoint: "fixture:host",
    pid: 1,
    processStartIdentity: "1",
    eventCursor: 0,
    protocolVersion: "fixture",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  };
}

/** A host that records everything handed to it, so "was never delivered" is an
    assertion about the recipient rather than about a receipt. */
function recordingHost(sessionKey: string): { host: EngineHost; received: string[] } {
  const received: string[] = [];
  return {
    received,
    host: {
      attach: () => ({ async *[Symbol.asyncIterator]() {} }),
      send: async (entry: QueueEntry): Promise<DeliveryReceipt> => {
        received.push(entry.text ?? "");
        return { outcome: "turn-started", turnId: `turn-${entry.id}` };
      },
      interrupt: async () => {},
      answer: async () => {},
      health: async () => idleState(sessionKey),
      release: async () => {},
    },
  };
}

interface Fixture {
  registry: AgentRegistry;
  registryPath: string;
  journal: RuntimeJournal;
  client: RuntimeHostClient;
  conversationId: ViewerConversationId;
  generationId: string;
  transcriptPath: string;
  close(): void;
}

function fixture(name: string, options: { now?: () => number; engine?: "codex" | "claude"; sqlite?: boolean } = {}): Fixture {
  const directory = fs.mkdtempSync(path.join(isolated, `${name}-`));
  const registry = new AgentRegistry(
    path.join(directory, "agent-registry.json"),
    undefined,
    undefined,
    {
      ...(options.now ? { now: options.now } : {}),
      /* The store the Viewer runs on, where a writer in another process holds
         a real lock. */
      ...(options.sqlite ? { sqliteMode: "sqlite" as const, sqliteFilename: path.join(directory, "agent-registry.sqlite") } : {}),
    },
  );
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const transcriptPath = path.join(directory, `${name}.jsonl`);
  const launchProfile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: options.engine ?? "codex",
    path: transcriptPath,
    accountId: "settlement-fixture-account",
    launchProfile,
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-08-30T10:00:00.000Z",
  }]);
  const conversation = Object.values(registry.snapshot().conversations)[0];
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) throw new Error("fixture conversation is missing");
  registry.upsert({
    key: { engine: options.engine ?? "codex", sessionId: generation.id },
    artifactPath: transcriptPath,
    cwd: directory,
    accountId: "settlement-fixture-account",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: options.engine === "claude" ? "claude-broker" : "codex-app-server",
      endpoint: "fixture:settlement-host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fixture-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  /* The runtime journal only admits a send for a hosted session, so the fixture
     publishes the same host state a live structured host would. */
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: options.engine ?? "codex", sessionId: generation.id },
      hostKind: options.engine === "claude" ? "claude-broker" : "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: transcriptPath,
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  return {
    registry,
    registryPath: path.join(directory, "agent-registry.json"),
    journal,
    client: runtimeClient(journal),
    conversationId: conversation.id,
    generationId: generation.id,
    transcriptPath,
    close: () => journal.close(),
  };
}

/**
 * Admits one send exactly the way the structured send path does: a durable
 * reservation, a claimed attempt, then the runtime-journal operation. What
 * comes back is the operation id an MCP caller would have been handed with
 * `outcome: "queued"`.
 */
function acceptSend(
  active: Fixture,
  options: { text?: string; clientMessageId?: string; operationId?: string; origin?: import("./messageOrigin").MessageOrigin } = {},
): { operationId: string; deliveryId: string } {
  const clientMessageId = options.clientMessageId ?? "fixture-message-key";
  const operationId = options.operationId ?? `op_${clientMessageId}`;
  const text = options.text ?? "hold the cutover until I say go";
  const reservation = active.registry.holdDelivery(
    active.conversationId,
    text,
    clientMessageId,
    "text",
    [],
    null,
    { operationId, kind: "send", policy: "queue", ...(options.origin ? { origin: options.origin } : {}) },
  );
  if (reservation.state !== "assigned") throw new Error(`fixture reservation is ${reservation.state}`);
  const claimed = active.registry.beginDeliveryAttempt(reservation.id, active.generationId);
  if (!claimed) throw new Error("fixture reservation could not claim its attempt");
  const admitted = active.journal.executeOperation({
    kind: "send",
    operationId,
    conversationId: active.conversationId,
    idempotencyKey: clientMessageId,
    text,
    policy: "queue",
  });
  expect(admitted.receipt.status).toBe("queued");
  return { operationId, deliveryId: reservation.id };
}

/** An executor that had already batched this effect before anything settled it
    — the exact race a fence has to survive. */
function stalePortFor(
  active: Fixture,
  operationId: string,
  clientMessageId: string,
  text: string,
): StructuredDeliveryQueuePort {
  return {
    effects: async () => [{
      id: `effect:${operationId}`,
      kind: "runtime.send",
      eventSeq: 1,
      payload: {
        kind: "send",
        operationId,
        conversationId: active.conversationId,
        text,
        idempotencyKey: clientMessageId,
        policy: "queue",
      },
    }],
    transition: async (id, status, details) => {
      await active.client.transitionOperation(id, status, details);
    },
    /* Wired exactly as the controller wires them, so the two pre-actuation
       checks these tests depend on are the production ones and not stubs. */
    status: async (id) => (await active.client.operationStatus(id))?.receipt ?? null,
    settled: (id) => sendIsSettled(active.registry.readOnlySnapshot(), id)
      || failureNotices.sendFailureWarningSuppressed?.(active.registry, id) === true,
  };
}

function receiptOf(active: Fixture, operationId: string) {
  return sendReceiptFor(active.registry.readOnlySnapshot(), operationId);
}

/** Stable native and conversation identities, scoped to synchronous fixture
 * creation so asynchronous delivery work keeps the ordinary runtime. */
function completionFixture(name: string, options: Parameters<typeof fixture>[1] = {}) {
  let sequence = 0;
  const ids = spyOn(crypto, "randomUUID").mockImplementation(() => {
    const hex = crypto.createHash("sha256").update(`${name}:${++sequence}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  });
  try {
    const active = fixture(name, options);
    return { active, child: secondConversation(active, `${name}-child`) };
  } finally { ids.mockRestore(); }
}


function secondConversation(active: Fixture, name: string): Fixture {
  const transcriptPath = path.join(path.dirname(active.transcriptPath), `${name}.jsonl`);
  const launchProfile = emptyLaunchProfile({ cwd: path.dirname(active.transcriptPath) });
  active.registry.reconcileConversations([{
    engine: "codex",
    path: transcriptPath,
    accountId: "settlement-fixture-account",
    launchProfile,
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-08-30T10:00:00.000Z",
  }]);
  const conversation = Object.values(active.registry.snapshot().conversations)
    .find((candidate) => candidate.generations.at(-1)?.path === transcriptPath);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) throw new Error("fixture conversation is missing");
  active.registry.upsert({
    key: { engine: "codex", sessionId: generation.id },
    artifactPath: transcriptPath,
    cwd: path.dirname(transcriptPath),
    accountId: "settlement-fixture-account",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fixture:settlement-host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fixture-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  active.journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId: generation.id },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: transcriptPath,
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  return { ...active, conversationId: conversation.id, generationId: generation.id, transcriptPath };
}

function crashingHost(sessionKey: string): { host: EngineHost; received: string[] } {
  const received: string[] = [];
  let dead = false;
  return {
    received,
    host: {
      attach: () => ({ async *[Symbol.asyncIterator]() {} }),
      send: async (entry: QueueEntry): Promise<DeliveryReceipt> => {
        received.push(entry.text ?? "");
        dead = true;
        throw new Error("engine child exited");
      },
      interrupt: async () => {},
      answer: async () => {},
      health: async () => ({ ...idleState(sessionKey), status: dead ? "dead" : "idle" }),
      release: async () => {},
    },
  };
}

function unansweringHost(sessionKey: string): { host: EngineHost; received: string[] } {
  const received: string[] = [];
  return {
    received,
    host: {
      attach: () => ({ async *[Symbol.asyncIterator]() {} }),
      send: async (entry: QueueEntry): Promise<DeliveryReceipt> => {
        received.push(entry.text ?? "");
        throw new Error("engine answer never arrived");
      },
      interrupt: async () => {},
      answer: async () => {},
      health: async () => idleState(sessionKey),
      release: async () => {},
    },
  };
}

const { lookupOriginalSend, resolveOriginalSend } = await import("./sendSettlement");
function interruptingHost(sessionKey: string): { host: EngineHost; actions: string[] } {
  const actions: string[] = [];
  let running: string | null = "copilot:1-turn";
  return {
    actions,
    host: {
      supportsSteer: false,
      steerFallback: "interrupt",
      attach: () => ({ async *[Symbol.asyncIterator]() {} }),
      send: async (entry: QueueEntry): Promise<DeliveryReceipt> => {
        if (running) return { outcome: "rejected", reason: "stale-turn" };
        actions.push(`send:${entry.text ?? ""}`);
        running = "copilot:2-turn";
        return { outcome: "turn-started", turnId: "copilot:2-turn" };
      },
      interrupt: async (turnId: string) => {
        actions.push(`interrupt:${turnId}`);
        if (running === turnId) running = null;
      },
      answer: async () => {},
      health: async () => running
        ? { ...idleState(sessionKey), status: "active", activeTurnRef: running }
        : idleState(sessionKey),
      release: async () => {},
    },
  };
}

function interruptActivePort(active: Fixture, operationId: string, text: string): StructuredDeliveryQueuePort {
  return {
    effects: async () => [{
      id: `effect:${operationId}`,
      kind: "runtime.send",
      eventSeq: 1,
      payload: { kind: "send", operationId, conversationId: active.conversationId, text, policy: "interrupt-active" },
    }],
    transition: async (id, status, details) => { await active.client.transitionOperation(id, status, details); },
    status: async (id) => (await active.client.operationStatus(id))?.receipt ?? null,
    settled: (id) => sendIsSettled(active.registry.readOnlySnapshot(), id),
  };
}

for (const state of ["pending", "failed", "cancelled"] as const)
for (const recovery of ["unadmitted", "before-sweep", "after-sweep", "past-retention", "read-failure", "delivered", "owner-compaction", "recipient-adoption", "different-recipient"] as const)
test(`persisted automatic ${state} sender alarm is retired after process restart: ${recovery}`, async () => {
  const previousState = process.env.LLV_STATE_DIR;
  const alarmState = path.join(isolated, `alarm-state-${state}-${recovery}`);
  fs.mkdirSync(alarmState, { recursive: true });
  process.env.LLV_STATE_DIR = alarmState;
  let clock = Date.parse("2026-11-14T09:10:00Z");
  setSystemTime(clock);
  const { active, child } = completionFixture(`legacy-completion-alarm-${state}-${recovery}`, { sqlite: true, engine: "claude", now: () => clock });
  try {
    const { recordSendFailureNotice, readSendFailureNotice, decodeSendFailureNotice } = await import("./sendFailureNotice");
    const { spawnNoticeMessageId } = await import("@/lib/spawnNotice/sweep");
    const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
    const origin = { kind: "agent" as const, role: "reviewer", conversationId: child.conversationId };
    const deliberate = acceptSend(active, { clientMessageId: `mcp_send_legacy_${state}_${recovery}`, origin });
    recordSendFailureNotice(active.registry, deliberate.operationId, "uncertain", "confirmation unavailable");
    const automatic = acceptSend(active, { text: "completion report", clientMessageId: spawnNoticeMessageId(child.conversationId, `legacy-turn-${state}`), origin });
    const recorded = readSendFailureNotice(deliberate.operationId)!;
    const legacy = { ...recorded, operationId: automatic.operationId,
      text: recorded.text.replaceAll(deliberate.operationId, automatic.operationId),
      clientMessageId: `send_failure_${crypto.createHash("sha256").update(automatic.operationId).digest("hex")}`, state,
      recipientConversationId: recovery === "unadmitted" ? null : child.conversationId };
    expect(decodeSendFailureNotice(legacy)).toEqual(legacy);
    const store = new SqliteStateCollection<import("./sendFailureNotice").SendFailureNotice>(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), {
      collection: "send_failure_notices", schemaVersion: 1, busyMessage: "fixture notices busy",
      key: (row: import("./sendFailureNotice").SendFailureNotice) => row.operationId,
      decode: decodeSendFailureNotice, clone: structuredClone,
      controllerActive: row => row.state === "pending" || row.state === "failed",
    });
    // A real prior-version persisted alarm; the current writer must also be
    // safe, but writer suppression alone cannot repair this outstanding row.
    store.boundedPatch(2, tx => tx.put(legacy));
    const warning = recovery === "unadmitted" ? null : acceptSend(child, {
      text: legacy.text, clientMessageId: legacy.clientMessageId, origin: { kind: "agent", role: "delivery" },
    });
    if (warning && recovery === "delivered") {
      active.journal.transitionOperation(warning.operationId, "delivered", { turnId: "prior-warning-turn" });
    }
    if (recovery === "owner-compaction") {
      // A late canonical arrival cancels the alarm before the upgraded sweep
      // classifies it. Normal retention then evicts its original owner.
      const { FileClaudeDeliveryLedger } = await import("./claudeStreamBrokerHost");
      const ledger = new FileClaudeDeliveryLedger();
      const uncertain = recordingHost(active.generationId).host;
      uncertain.send = async entry => {
        ledger.recordQueued(active.generationId, entry, "queued-next-turn");
        throw Error("confirmation timed out; outcome is uncertain");
      };
      const owner = active.registry.deliverySnapshotForOperation(automatic.operationId).deliveryOperationOwners[automatic.operationId]!;
      await new StructuredDeliveryQueue(stalePortFor(active, automatic.operationId, owner.clientMessageId!, "completion report"), () => uncertain).drain();
      ledger.confirmDelivered(active.generationId, automatic.operationId, "late-arrival");
      expect(await resolveSendReceipt(automatic.operationId, { registry: active.registry, client: active.client }))
        .toMatchObject({ state: "delivered" });
      for (let i = 0; i < 205; i++) {
        clock += 1_000; setSystemTime(clock);
        const newer = acceptSend(active, { clientMessageId: `newer-delivered-${i}` });
        active.journal.transitionOperation(newer.operationId, "delivered", { turnId: `newer-turn-${i}` });
        active.registry.recordDeliveryOutcome(newer.deliveryId, "delivered");
      }
      active.registry.compactDeliveryReservations();
      expect(active.registry.deliverySnapshotForOperation(automatic.operationId).deliveryOperationOwners[automatic.operationId]).toBeUndefined();
      expect(readSendFailureNotice(automatic.operationId)).toMatchObject({ state: "cancelled" });
      expect(readSendFailureNotice(automatic.operationId)?.suppressSenderWake).toBeUndefined();
    }
    if (recovery === "recipient-adoption") {
      const canonical = secondConversation(active, "canonical-child");
      const migration = active.registry.beginSpawnRequest({ engine: "codex", cwd: path.dirname(child.transcriptPath),
        conversationId: canonical.conversationId, purpose: "migration-successor",
        launchProfile: { title: "Recovered reviewer" }, expectedArtifactPath: child.transcriptPath });
      if (migration.kind !== "created") throw Error("fixture migration admission failed");
      expect(active.registry.settleSpawn(migration.receipt.launchId, {
        key: { engine: "codex", sessionId: child.generationId }, artifactPath: child.transcriptPath,
        cwd: path.dirname(child.transcriptPath), accountId: "settlement-fixture-account", status: "live", host: null,
        claimEpoch: 0, claimOwner: null, pendingAction: null,
      })).toMatchObject({ kind: "settled", conversation: { id: canonical.conversationId } });
      expect(active.registry.deliverySnapshotForOperation(warning!.operationId).deliveryOperationOwners[warning!.operationId]?.conversationId)
        .toBe(canonical.conversationId);
      expect(readSendFailureNotice(automatic.operationId)?.recipientConversationId).toBe(child.conversationId);
    }
    if (recovery === "different-recipient") {
      // Even an explicit suppression flag grants nothing to a different target.
      store.boundedPatch(2, tx => tx.put({ ...legacy, recipientConversationId: active.conversationId, suppressSenderWake: true }));
    }
    store.close();
    const modulePath = new URL("./sendFailureNotice.ts", import.meta.url).pathname;
    const registryPath = new URL("../agent/registry.ts", import.meta.url).pathname;
    const childProcess = Bun.spawn([process.execPath, "--eval", `
      const { AgentRegistry } = await import(${JSON.stringify(registryPath)});
      const m = await import(${JSON.stringify(modulePath)});
      const { StructuredDeliveryQueue } = await import(${JSON.stringify(new URL("./structuredDeliveryQueue.ts", import.meta.url).pathname)});
      const { sendIsSettled } = await import(${JSON.stringify(new URL("./sendSettlement.ts", import.meta.url).pathname)});
      const { RuntimeJournal } = await import(${JSON.stringify(new URL("../../runtime-host/journal.ts", import.meta.url).pathname)});
      const registry = new AgentRegistry(${JSON.stringify(active.registryPath)}, undefined, undefined,
        { sqliteMode: "sqlite", sqliteFilename: ${JSON.stringify(active.registryPath.replace(/\.json$/, ".sqlite"))} });
      const journal = new RuntimeJournal(${JSON.stringify(path.join(path.dirname(active.registryPath), "runtime.sqlite"))}, { structuredHosts: true });
      const warning = ${JSON.stringify(warning)};
      let started = 0;
      const sweep = () => m.sweepSendFailureNotices({ registry, assertActive: () => {},
        receipt: async () => null,
        recipient: () => { throw Error("automatic sender alarm resolved a recipient"); },
        deliver: async () => { throw Error("automatic sender alarm woke its sender"); } });
      try {
        const { setSystemTime } = await import("bun:test"); setSystemTime(new Date(${clock}));
        if (${JSON.stringify(recovery)} !== "before-sweep") await sweep();
        if (${JSON.stringify(recovery)} === "past-retention") {
          const { setSystemTime } = await import("bun:test");
          setSystemTime(new Date("2026-12-14T09:10:00Z"));
          await sweep();
        }
        if (warning) {
          const host = { health: async () => (${JSON.stringify(idleState(child.generationId))}),
            send: async () => { started++; return { outcome: "turn-started", turnId: "warning-turn" }; },
            interrupt: async () => {}, answer: async () => {}, release: async () => {} };
          const queue = new StructuredDeliveryQueue({
            effects: async () => journal.effectBatch(100).filter(effect => effect.payload.operationId === warning.operationId),
            status: async id => journal.operationResult(id)?.receipt ?? null,
            settled: id => sendIsSettled(registry.deliverySnapshotForOperation(id), id)
              || m.sendFailureWarningSuppressed?.(registry, id) === true,
            transition: async (id, status, details) => journal.transitionOperation(id, status, details),
          }, () => host);
          if (${JSON.stringify(recovery)} === "read-failure") {
            const { spyOn } = await import("bun:test");
            const { SqliteStateCollection } = await import(${JSON.stringify(new URL("../state/sqliteStateStore.ts", import.meta.url).pathname)});
            const unreadable = spyOn(SqliteStateCollection.prototype, "sendFailureKeyForMessage")
              .mockImplementationOnce(() => { throw Error("warning identity unavailable"); });
            try {
              await queue.drain();
              if (started || journal.operationResult(warning.operationId)?.receipt.status !== "queued")
                throw Error("an unreadable warning fence allowed dispatch or settlement");
            } finally { unreadable.mockRestore(); }
          }
          await queue.drain();
        }
        for (let pass = 0; pass < 4; pass++) await sweep();
        console.log(JSON.stringify({ alarm: m.readSendFailureNotice(${JSON.stringify(automatic.operationId)}), started,
          warningStatus: warning ? journal.operationResult(warning.operationId)?.receipt.status : null }));
      } finally { registry.close(); journal.close(); }
    `], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(childProcess.stdout).text(), new Response(childProcess.stderr).text(), childProcess.exited]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ alarm: { state: "cancelled", reason: legacy.reason, text: legacy.text },
      started: recovery === "different-recipient" ? 1 : 0,
      warningStatus: recovery === "delivered" || recovery === "different-recipient" ? "delivered" : warning ? "uncertain" : null });
    if (recovery !== "owner-compaction") {
      expect(active.registry.deliverySnapshotForOperation(automatic.operationId).deliveryOperationOwners[automatic.operationId]?.clientMessageId)
        .toBe(spawnNoticeMessageId(child.conversationId, `legacy-turn-${state}`));
    }
  } finally {
    active.registry.close(); active.close(); setSystemTime();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  }
});
