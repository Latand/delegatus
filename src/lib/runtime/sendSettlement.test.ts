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

for (const automatic of [true, false]) test(`busy launcher uncertainty keeps a finished sender idle: automatic=${automatic}`, async () => {
  let now = Date.parse("2026-11-14T09:00:00Z");
  setSystemTime(now);
  const { active, child } = completionFixture(`completion-feedback-${automatic}`, { sqlite: true, engine: "claude", now: () => now });
  const store = await import("@/lib/spawnNotice/store");
  const { sweepSpawnNotices } = await import("@/lib/spawnNotice/sweep");
  const { recordSpawnTurnEnded } = await import("./serverConsumers");
  const { readSendFailureNotice, sweepSendFailureNotices } = await import("./sendFailureNotice");
  const { lookupOriginalSend } = await import("./sendSettlement");
  const { FileClaudeDeliveryLedger } = await import("./claudeStreamBrokerHost");
  const ledger = new FileClaudeDeliveryLedger();
  const received: string[] = [];
  const started: string[] = [];
  const operations: string[] = [];
  const end = (turnId: string) => recordSpawnTurnEnded({ conversationId: child.conversationId, turnId,
    outcome: "completed", startedAt: new Date(now - 1_000).toISOString(), endedAt: new Date(now).toISOString() }, {
    child: () => ({ conversationId: child.conversationId, launcher: { conversationId: active.conversationId, notify: true }, contained: false }),
    record: store.recordSpawnNoticeObligation,
  });
  const host: EngineHost = { ...recordingHost(active.generationId).host, supportsQueuedSend: true, coalescesQueuedInput: true };
  // Arrival occurs inside the incumbent turn; its acknowledgement is lost.
  host.health = async () => ({ ...idleState(active.generationId), status: "active", activeTurnRef: "incumbent" });
  host.send = async entry => {
    received.push(entry.text!);
    ledger.recordQueued(active.generationId, entry, "queued-next-turn");
    throw Error("Claude delivery confirmation timed out; outcome is uncertain");
  };
  const receipt = (id: string) => resolveSendReceipt(id, { registry: active.registry, client: active.client });
  const deliver = async (request: { text: string; clientMessageId: string; origin: import("./messageOrigin").MessageOrigin }) => {
    const original = lookupOriginalSend(active.registry.deliverySnapshotForMessageKey(active.conversationId, request.clientMessageId),
      { conversationId: active.conversationId, clientMessageId: request.clientMessageId });
    let operationId: string;
    if (original.kind === "found") operationId = original.operationId;
    else {
      operationId = acceptSend(active, request).operationId;
      operations.push(operationId);
      await new StructuredDeliveryQueue(stalePortFor(active, operationId, request.clientMessageId, request.text), () => host).drain();
    }
    const answer = await receipt(operationId);
    return answer?.state === "delivered" ? { ok: true as const, operationId }
      : { ok: false as const, error: answer?.reason ?? "notice awaits its delivery receipt", uncertain: true };
  };
  const ports: import("@/lib/spawnNotice/sweep").SpawnNoticeSweepPorts = {
    now: () => now, pending: () => store.pendingSpawnNotices().filter(row => row.childConversationId === child.conversationId),
    childRecord: store.readSpawnNoticeChild, child: async () => ({ title: "Reviewer", busy: false }),
    recipient: () => ({ kind: "deliver", conversationId: active.conversationId, path: active.transcriptPath }),
    finalMessage: () => ({ text: "Review complete", error: null }),
    origin: () => ({ kind: "agent", role: "reviewer", conversationId: child.conversationId }),
    recordAttempt: store.recordSpawnNoticeAttempt, settle: store.settleSpawnNotices, deliver,
  };
  try {
    await active.registry.prepareRecoveryIndexes();
    if (automatic) end("work-turn");
    else await deliver({ text: "Deliberate message", clientMessageId: "mcp_send_deliberate_uncertainty",
      origin: ports.origin(child.conversationId) });
    for (let pass = 0; pass < 3; pass++) {
      await sweepSpawnNotices(ports);
      await sweepSendFailureNotices({ registry: active.registry, assertActive: () => {}, receipt,
        recipient: sender => sender === child.conversationId
          ? { kind: "deliver", conversationId: child.conversationId, path: child.transcriptPath }
          : { kind: "skip", reason: "outside fixture" },
        deliver: async request => {
          const accepted = acceptSend(child, request);
          const target = recordingHost(child.generationId);
          await new StructuredDeliveryQueue(stalePortFor(child, accepted.operationId, request.clientMessageId, request.text), () => target.host).drain();
          started.push(...target.received);
          // The real end-of-turn consumer closes the feedback edge.
          if (automatic) end(`status-turn-${started.length}`);
          return { ok: true };
        },
      });
      // Receipt evidence arrives after the sender has already been woken.
      // Retire that attempt so the next completed status turn can send its
      // own notice, as happens when the launcher reads the original report.
      if (automatic && started.length) {
        ledger.confirmDelivered(active.generationId, operations.at(-1)!, `ack-${operations.length}`);
        await sweepSpawnNotices(ports);
      }
      now += 31_000;
      setSystemTime(now);
    }
    expect(received).toHaveLength(1);
    expect(started).toHaveLength(automatic ? 0 : 1);
    expect(operations).toHaveLength(1);
    expect(await receipt(operations[0]!)).toMatchObject({ state: "failed", duplicateRisk: true,
      reason: SEND_UNVERIFIED_REASON });
    if (automatic) {
      expect(readSendFailureNotice(operations[0]!)).toBeNull();
      expect(store.readSpawnNoticeChild(child.conversationId)?.attempt?.attempts).toBe(3);
      // A late durable acknowledgement reconciles the original key, without
      // another input write or another child turn.
      ledger.confirmDelivered(active.generationId, operations[0]!, "late-ack");
      await sweepSpawnNotices(ports);
      expect(store.readSpawnNoticeTurn(child.conversationId, "work-turn")).toMatchObject({ state: "sent", operationId: operations[0] });
      expect(received).toHaveLength(1);
      expect(started).toHaveLength(0);
    }
  } finally { active.registry.close(); active.close(); setSystemTime(); }
});

for (const [echo, discard] of [[true, false], [false, false], [true, true]] as const)
test(`executor recovery after a journal listing timeout preserves recipient evidence (echo: ${echo}, discard: ${discard})`, async () => {
  setSystemTime(new Date("2026-11-01T08:50:00Z"));
  const active = fixture(`relay-echo-${echo}-${discard}`);
  const { confirmedSend } = await import("./confirmedSend");
  const { observeDeliveryEcho } = await import("./structuredDeliveryController");
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const progress = new DeliveryProgressStore(null);
  const { host, received } = recordingHost(active.generationId);
  const text = "finish this relay request";
  const { operationId } = acceptSend(active, { text, clientMessageId: `relay-echo-${echo}` });
  // Leave the queue's own delivering fence on disk after an actual host send.
  const port: StructuredDeliveryQueuePort = {
    effects: async (kinds, after) => active.journal.effectBatch(100, kinds, after),
    transition: async (id, status, details, options) => {
      if (status === "delivered") throw Error("confirmation write unavailable");
      await active.client.transitionOperation(id, status, details, options);
    },
    status: async id => (await active.client.operationStatus(id))?.receipt ?? null,
    hostClaim: async () => "first-executor",
    progress,
  };
  try {
    await expect(new StructuredDeliveryQueue(port, () => host).drain()).rejects.toThrow("confirmation write unavailable");
    expect(received).toEqual([text]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("delivering");
    if (echo) {
      const wire = await encodeCodexStructuredUserText(text, undefined, null, { kind: "operator" }, deliveryDedupToken(operationId));
      fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: wire } }) + "\n");
      observeDeliveryEcho(progress, active.conversationId, { operationId, at: new Date().toISOString() });
    }
    let listFailed = false;
    let proofUnreadable = echo && !discard;
    const recoveryPort: StructuredDeliveryQueuePort = { ...port,
      effects: async (kinds, after) => {
        if (!listFailed) { listFailed = true; throw Error("runtime host request timed out"); }
        return active.journal.effectBatch(100, kinds, after);
      },
      hostClaim: async () => "successor-executor",
      confirmedDelivery: async id => {
        if (proofUnreadable) { proofUnreadable = false; throw Error("canonical delivery read temporarily unavailable"); }
        const confirmed = await confirmedSend(active.registry.deliverySnapshotForOperation(id, { recipientEvidence: true }), id);
        if (discard) {
          active.journal.transitionOperation(id, "uncertain");
          active.journal.claimDeliveryAction(id, "discard");
        }
        return confirmed;
      },
      transition: async (id, status, details, options) => { await active.client.transitionOperation(id, status, details, options); },
    };
    await expect(new StructuredDeliveryQueue(recoveryPort, () => host).drain()).rejects.toThrow("runtime host request timed out");
    expect(progress.get(operationId)?.waitReason).toBe("evidence-unreadable");
    await new StructuredDeliveryQueue(recoveryPort, () => host).drain();
    if (echo && !discard) {
      expect(active.journal.operationResult(operationId)?.receipt.status).toBe("delivering");
      expect(progress.get(operationId)).toMatchObject({ terminal: null, engineEchoAt: expect.any(String) });
      await new StructuredDeliveryQueue(recoveryPort, () => host).drain();
    }
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe(discard ? "failed" : echo ? "delivered" : "uncertain");
    expect(progress.get(operationId)?.terminal?.state).toBe(discard ? "failed" : echo ? "delivered" : "uncertain");
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client }))
      .toMatchObject(discard ? { state: "failed", reason: "delivery-discarded" }
        : echo ? { state: "delivered", duplicateRisk: false } : { state: "failed", duplicateRisk: true, reason: SEND_UNVERIFIED_REASON });
    // Recovery and settlement never submit another input.
    expect(received).toEqual([text]);
  } finally { progress.close(); active.close(); setSystemTime(); }
});

for (const status of ["delivered", "failed"] as const) test(`journal ${status} settlement rereads only its operation after I/O`, async () => {
  const now = Date.parse("2026-10-22T00:00:00Z");
  const active = fixture(`keyed-journal-${status}`, { sqlite: true, now: () => now });
  const original = active.registry.readOnlySnapshot.bind(active.registry);
  try {
    const { operationId } = acceptSend(active, { clientMessageId: `keyed-journal-${status}`, operationId: `operation-keyed-${status}` });
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, status, status === "failed" ? { reason: "executor refused" } : {});
    const client = { ...active.client, operationStatus: async (...args: Parameters<RuntimeHostClient["operationStatus"]>) => {
      const result = await active.client.operationStatus(...args);
      active.registry.readOnlySnapshot = () => { throw new Error("settlement rebuilt registry history after journal I/O"); };
      return result;
    } };
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client, now: () => now, progress: null }))
      .toMatchObject({ operationId, state: status, evidence: "delivery-journal" });
    expect(sendReceiptFor(active.registry.deliverySnapshotForOperation(operationId), operationId)?.state).toBe(status);
  } finally {
    active.registry.readOnlySnapshot = original;
    active.registry.close();
    active.close();
  }
});

test("an accepted send that the journal delivered reconciles rather than being reported lost", async () => {
  const active = fixture("delivered");
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "delivered-key" });
    /* The executor did its job; only the projection onto the reservation was
       missed, which must never be mistaken for a loss. */
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "delivered", { turnId: "turn-1" });
    expect(receiptOf(active, operationId)?.state).toBe("in-flight");

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(answered?.state).toBe("delivered");
    expect(answered?.resend).toBe("not-needed");
    expect(answered?.duplicateRisk).toBe(false);
    expect(answered?.evidence).toBe("delivery-journal");
    /* Reconciled onto the record, so every later reader agrees without asking
       the journal again. */
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("delivered");
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("delivered");
    expect(receipt?.resend).toBe("not-needed");
    expect(receipt?.evidence).toBe("delivery-record");
  } finally {
    active.close();
  }
});

test("a dropped send settles as failed, and the fence stops the queue from delivering it afterwards", async () => {
  const active = fixture("dropped");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "dropped-key",
      text: "resume the cutover",
    });
    /* Nothing else happens to it: this is the incident's shape — accepted,
       answered `queued`, and then silence. */
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("queued");
    /* Inside the window it is still in flight: a send that is merely young is
       not a send that was lost. */
    expect((await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
    }))?.state).toBe("in-flight");

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(answered?.state).toBe("failed");
    expect(answered?.evidence).toBe("delivery-journal");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("failed");
    expect(receipt?.reason).toBe(SEND_LOST_REASON);
    expect(receipt?.duplicateRisk).toBe(false);
    expect(receipt?.resend).toBe("safe");

    /* The fence, proved against the real queue rather than asserted: the effect
       is gone from the outbox, and an executor that had already batched it is
       refused at the `delivering` transition — before `host.send` is reached. */
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);
    const { host, received } = recordingHost(active.generationId);
    const stalePort = stalePortFor(active, operationId, "dropped-key", "resume the cutover");
    await new StructuredDeliveryQueue(stalePort, () => host).drain().catch(() => undefined);
    expect(received).toEqual([]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("failed");
  } finally {
    active.close();
  }
});

test("with no reader asking, the background deadline ends a dropped send and the queue never delivers it", async () => {
  /* Incident 2026-10-06: settlement ran only when somebody read the receipt.
     Here nobody does: the sweep the delivery controller runs on a timer is the
     only caller, as it is with the browser closed. */
  const active = fixture("background");
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "background-key", text: "resume the cutover" });
    const deadlines: Array<{ operationId: string; deadlineAt: string | null; policy: string | null }> = [];
    const young = await settleDueSends({
      registry: active.registry,
      client: active.client,
      onDeadline: (id, _conversation, deadline) => deadlines.push({ operationId: id, deadlineAt: deadline?.deadlineAt ?? null, policy: deadline?.policy ?? null }),
    });
    /* Inside the window it is only recorded, with the deadline that will end it. */
    expect(young.settled).toEqual([]);
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]!.operationId).toBe(operationId);
    expect(deadlines[0]!.policy).toBe("settlement-window");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).not.toBe("failed");

    const swept = await settleDueSends({ registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    expect(swept.settled).toEqual([{ operationId, state: "failed", duplicateRisk: false }]);
    const receipt = receiptOf(active, operationId);
    expect(receipt?.reason).toBe(SEND_LOST_REASON);
    expect(receipt?.resend).toBe("safe");
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("failed");

    const { host, received } = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(stalePortFor(active, operationId, "background-key", "resume the cutover"), () => host)
      .drain().catch(() => undefined);
    expect(received).toEqual([]);
    /* A second sweep finds nothing left to end. */
    expect((await settleDueSends({ registry: active.registry, client: active.client, now: AFTER_THE_WINDOW })).settled).toEqual([]);
  } finally {
    active.close();
  }
});

/** A second hosted conversation in the same registry and journal. */
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

test("background settlement waits out another process's long write off the event loop, correlated with its operation, and commits once", async () => {
  const active = fixture("foreign-writer", { sqlite: true });
  const holder = registryLockHolder(active.registryPath.replace(/\.json$/, ".sqlite"));
  const { blockingWaitDiagnostics, resetBlockingWaitsForTests } = await import("@/lib/blockingWaits");
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "foreign-writer-key" });
    resetBlockingWaitsForTests(() => {});
    await holder.hold();
    const { value: swept } = await whileRegistryWriterHeld(holder, () => settleDueSends({
      registry: active.registry, client: active.client, now: AFTER_THE_WINDOW,
    }));

    expect(swept.settled).toEqual([{ operationId, state: "failed", duplicateRisk: false }]);
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
    const diagnostics = blockingWaitDiagnostics();
    expect(diagnostics.sites["registry-lock"]).toBeUndefined();
    const wait = diagnostics.longest.find((sample) => sample.site === "registry-lock-async");
    expect(wait).toMatchObject({ synchronous: false, label: "delivery.settle", operationId });
    expect(wait!.durationMs).toBeGreaterThan(0);
    /* The send was fenced in the journal before the wait began, so the queue
       delivers nothing however long the record's write took. */
    const { host, received } = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(stalePortFor(active, operationId, "foreign-writer-key", "hold the cutover until I say go"), () => host)
      .drain().catch(() => undefined);
    expect(received).toEqual([]);
  } finally {
    resetBlockingWaitsForTests();
    await holder.close();
    active.close();
  }
});

test("a settlement whose write lock stays held past its deadline writes nothing, keeps the journal fence, and is completed by the next sweep", async () => {
  const active = fixture("foreign-writer-deadline", { sqlite: true });
  const holder = registryLockHolder(active.registryPath.replace(/\.json$/, ".sqlite"));
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "writer-deadline-key" });
    await holder.hold();
    const { value: swept } = await whileRegistryWriterHeld(holder, () => settleDueSends({
      registry: active.registry, client: active.client, now: AFTER_THE_WINDOW,
    }), { release: false });
    /* Nothing was written, so nothing is reported ended. */
    expect(swept.settled).toEqual([]);
    expect(receiptOf(active, operationId)?.state).toBe("in-flight");
    /* The journal already refuses the send: the fence came first. */
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("failed");
    const { host, received } = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(stalePortFor(active, operationId, "writer-deadline-key", "hold the cutover until I say go"), () => host)
      .drain().catch(() => undefined);
    expect(received).toEqual([]);
    await holder.release();
    const again = await settleDueSends({ registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    expect(again.settled).toEqual([{ operationId, state: "failed", duplicateRisk: false }]);
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
    expect(receiptOf(active, operationId)?.reason).toBe(SEND_LOST_REASON);
  } finally {
    await holder.close();
    active.close();
  }
}, 20_000);

test("a conversation whose journal read never answers holds nobody: the other settles at once, the hung one ends unverified in bounded time, and its late answer changes nothing", async () => {
  const first = fixture("hung-reader");
  try {
    const second = secondConversation(first, "hung-reader-second");
    const hung = acceptSend(first, { clientMessageId: "hung-key", text: "resume the cutover" });
    const free = acceptSend(second, { clientMessageId: "free-key" });
    const release: Array<() => void> = [];
    let hungReads = 0;
    let markHungEntered!: () => void;
    const hungEntered = new Promise<void>(resolve => { markHungEntered = resolve; });
    const client = {
      ...first.client,
      operationStatus: async (operationId: string, options?: { currentRetryLeaf?: boolean }) => {
        if (operationId === hung.operationId) {
          hungReads += 1;
          await new Promise<void>((resolve) => { release.push(resolve); markHungEntered(); });
        } else if (operationId === free.operationId) {
          await hungEntered;
        }
        return first.client.operationStatus(operationId, options);
      },
    } as RuntimeHostClient;
    const running = new Set<string>();
    const settled: string[] = [];
    let freeSettled!: () => void;
    const freeDone = new Promise<void>(resolve => { freeSettled = resolve; });
    const startedAt = performance.now();
    const ports = {
      registry: first.registry,
      client,
      now: AFTER_THE_WINDOW,
      readMs: 400,
      running,
      onSettled: ({ operationId }: { operationId: string }) => { settled.push(operationId); if (operationId === free.operationId) freeSettled(); },
    };
    const sweep = settleDueSends(ports);
    await freeDone;
    /* The free conversation is done while the hung one's read is still open. */
    expect(settled).toEqual([free.operationId]);
    expect(receiptOf(second, free.operationId)?.state).toBe("failed");
    expect(receiptOf(first, hung.operationId)?.state).toBe("in-flight");
    expect(running.has(first.conversationId)).toBe(true);
    /* The next sweep starts on time, and leaves the conversation still being
       settled alone: its operation is read once. */
    const next = await settleDueSends(ports);
    expect(next.settled).toEqual([]);
    expect(hungReads).toBe(1);

    const swept = await sweep;
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    /* Nothing answered, so nothing is proved: it ends unverified and a resend
       stays behind verification. */
    expect(swept.settled).toContainEqual({ operationId: hung.operationId, state: "failed", duplicateRisk: true });
    expect(receiptOf(first, hung.operationId)?.reason).toBe(SEND_UNSETTLEABLE_REASON);
    expect(running.size).toBe(0);

    /* The late answer arrives: the queue, wired as in production, still reads
       the durable record before it actuates and hands nothing over. */
    for (const done of release) done();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { host, received } = recordingHost(first.generationId);
    await new StructuredDeliveryQueue(stalePortFor(first, hung.operationId, "hung-key", "resume the cutover"), () => host)
      .drain().catch(() => undefined);
    expect(received).toEqual([]);
    expect(receiptOf(first, hung.operationId)?.reason).toBe(SEND_UNSETTLEABLE_REASON);
  } finally {
    first.close();
  }
});

test("the background deadline ends a send an executor took as unverified and keeps a resend behind verification", async () => {
  const active = fixture("background-uncertain");
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "background-uncertain-key" });
    active.journal.transitionOperation(operationId, "delivering", { turnId: "turn-9" });
    const swept = await settleDueSends({ registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    expect(swept.settled).toEqual([{ operationId, state: "failed", duplicateRisk: true }]);
    const receipt = receiptOf(active, operationId);
    expect(receipt?.duplicateRisk).toBe(true);
    expect(receipt?.resend).toBe("verify-first");
  } finally {
    active.close();
  }
});

test("the same queue pass delivers a send the settlement has not fenced", async () => {
  /* The control for the fence above: with the operation left open, this exact
     port, queue and host do deliver, so the empty recipient in that test is the
     fence's doing and not the harness's. */
  const active = fixture("unfenced");
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "unfenced-key", text: "resume the cutover" });
    const { host, received } = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(stalePortFor(active, operationId, "unfenced-key", "resume the cutover"), () => host).drain();
    expect(received).toEqual(["resume the cutover"]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("delivered");
  } finally {
    active.close();
  }
});

test("a send whose first attempt is uncertain settles as failed and refuses to call a resend safe", async () => {
  const active = fixture("uncertain");
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "uncertain-key" });
    /* The executor took it and never came back. Nothing can prove the recipient
       did not receive it, so nothing here may pretend otherwise. */
    active.journal.transitionOperation(operationId, "delivering", { turnId: "turn-7" });

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(answered?.state).toBe("failed");
    expect(answered?.duplicateRisk).toBe(true);
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("failed");
    expect(receipt?.reason).toBe(SEND_UNVERIFIED_REASON);
    expect(receipt?.duplicateRisk).toBe(true);
    expect(receipt?.resend).toBe("verify-first");
    /* Terminal either way: an unverified send is still fenced against being
       executed a second time by the queue. */
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);
  } finally {
    active.close();
  }
});

test("a send queued behind the recipient's own turn waits, and stops being exempt at the ceiling", async () => {
  const active = fixture("in-turn");
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "in-turn-key" });
    active.registry.setStructuredHost({ engine: "codex", sessionId: active.generationId }, {
      kind: "codex-app-server",
      endpoint: "fixture:settlement-host",
      process: null,
      eventCursor: 1,
      protocolVersion: "fixture-v1",
      writerClaimEpoch: 0,
      activeTurnRef: "turn-in-progress",
      pendingAttention: [],
      activeFlags: [],
    });

    const inTurn = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(inTurn?.state).toBe("in-flight");
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("queued");
    expect(receiptOf(active, operationId)?.state).toBe("in-flight");

    /* A host wedged mid-turn must not make `queued` permanent again. */
    const pastCeiling = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: () => Date.now() + 61 * 60_000,
    });
    expect(pastCeiling?.state).toBe("failed");
    expect(pastCeiling?.reason).toBe(SEND_LOST_REASON);
    expect(receiptOf(active, operationId)?.state).toBe("failed");
  } finally {
    active.close();
  }
});

test("a retried send is judged by its current attempt, not by the ancestor it replaced", async () => {
  const active = fixture("retried");
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "retried-key" });
    /* The first attempt died with the host; a fresh attempt was admitted under a
       new idempotency key and delivered. The reservation still names the
       ancestor, so reading the ancestor would report a delivered message as a
       loss — and would then try to fence an operation already terminal. */
    active.journal.transitionOperation(operationId, "failed", { reason: "dead-host" });
    const retry = active.journal.retryOperation(operationId, "retried-key-second");
    expect(retry.operationId).not.toBe(operationId);
    active.journal.transitionOperation(retry.operationId, "delivering");
    active.journal.transitionOperation(retry.operationId, "delivered", { turnId: "turn-9" });

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(answered?.state).toBe("delivered");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("delivered");
    expect(receiptOf(active, operationId)?.state).toBe("delivered");
  } finally {
    active.close();
  }
});

test("a runtime host that cannot be reached still ends the send, and never calls it lost", async () => {
  /* The outage case, which is the one a background sweep could never answer:
     nothing is healthy, so nothing can ask the journal what became of the send.
     `queued` may not be the last word through an outage of any length, so the
     deadline ends it anyway — as UNVERIFIED, because not being able to look is
     a reason to know less and never a proof that nothing executed. */
  const active = fixture("unreachable");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "unreachable-key",
      text: "resume the cutover",
    });
    const unreachable = {
      ...active.client,
      operationStatus: async () => { throw new Error("runtime host request timed out"); },
    } as RuntimeHostClient;

    /* Inside the window nothing is claimed: a send that is merely young during
       a blip is still in flight. */
    expect((await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: unreachable,
    }))?.state).toBe("in-flight");
    expect((await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: null,
    }))?.state).toBe("in-flight");

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: null,
      now: AFTER_THE_WINDOW,
    });
    expect(answered?.state).toBe("failed");
    expect(answered?.reason).toBe(SEND_UNSETTLEABLE_REASON);
    expect(answered?.duplicateRisk).toBe(true);
    expect(answered?.resend).toBe("verify-first");

    /* Once, however often it is asked and whichever way the runtime is
       unreachable: the record is terminal, so every later answer replays it
       rather than writing a second settlement. */
    const settledAt = answered?.settledAt;
    for (const client of [null, unreachable, active.client]) {
      const again = await resolveSendReceipt(operationId, {
        registry: active.registry,
        client,
        now: AFTER_THE_WINDOW,
      });
      expect(again?.state).toBe("failed");
      expect(again?.reason).toBe(SEND_UNSETTLEABLE_REASON);
      expect(again?.settledAt).toBe(settledAt!);
    }
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
  } finally {
    active.close();
  }
});

test("a journal that answers reads and refuses the fence still ends the send, and the record fences it", async () => {
  /* The half-outage: the runtime host is reachable enough to say the send is
     still open, and will not accept the write that would fence it — a socket
     that died between the two calls, or a database gone read-only. Leaving the
     send in flight here would make `queued` permanent exactly as a full outage
     would, so it ends the same way, on the durable record alone. */
  const active = fixture("fence-refused");
  const { host, received } = recordingHost(active.generationId);
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "fence-refused-key",
      text: "resume the cutover",
    });
    const refusesTheFence = {
      ...active.client,
      transitionOperation: async () => { throw new Error("runtime journal is read-only"); },
    } as RuntimeHostClient;

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: refusesTheFence,
      now: AFTER_THE_WINDOW,
    });
    expect(answered?.state).toBe("failed");
    expect(answered?.reason).toBe(SEND_UNSETTLEABLE_REASON);
    expect(answered?.duplicateRisk).toBe(true);
    expect(answered?.resend).toBe("verify-first");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");

    /* And the answer stays true: the operation is still open in the journal, so
       an executor reaching it later would deliver a message the sender was told
       had not arrived. The settled record is what stops it. */
    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "fence-refused-key", "resume the cutover"),
      () => host,
    ).drain();
    expect(received).toEqual([]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
    expect(receiptOf(active, operationId)?.resend).toBe("verify-first");
  } finally {
    active.close();
  }
});

test("an operation id nothing ever admitted is answered with nothing, not an invented in-flight state", () => {
  const active = fixture("unknown");
  try {
    expect(receiptOf(active, "op_never_admitted")).toBeNull();
  } finally {
    active.close();
  }
});

test("the caller's own replay of a settled loss is answered with the settlement, never with a second delivery", async () => {
  /* The fence proved against the OTHER way the same instruction could arrive
     twice: not a stale executor, but the sender deciding to send it again. The
     settled operation still owns its idempotency key, so an identical send is
     answered with the settled receipt and admits no new effect — which is why
     `resend: "safe"` means a NEW request id rather than a repeat of this one. */
  const active = fixture("replayed");
  try {
    const { operationId } = acceptSend(active, {
      clientMessageId: "replayed-key",
      text: "resume the cutover",
    });
    await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(receiptOf(active, operationId)?.resend).toBe("safe");

    const replay = active.journal.executeOperation({
      kind: "send",
      operationId,
      conversationId: active.conversationId,
      idempotencyKey: "replayed-key",
      text: "resume the cutover",
      policy: "queue",
    });

    expect(replay).toMatchObject({ operationId, replayed: true });
    expect(replay.receipt.status).toBe("failed");
    expect(replay.receipt.reason).toBe(SEND_LOST_REASON);
    /* Nothing new to execute, and the queue that would execute it delivers
       nothing when it is asked. */
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);
    const { host, received } = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "replayed-key", "resume the cutover"),
      () => host,
    ).drain().catch(() => undefined);
    expect(received).toEqual([]);
  } finally {
    active.close();
  }
});

/* ── The regressions this successor lane exists for ──────────────────────── */

/** A host that takes the instruction and then dies without answering — the
    crash the lane's own fixture showed happening BEFORE the queue moved the
    send back to `queued` and called it safe to send again. */
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

test("a send the host took before it died stays uncertain, and no fresh request delivers it twice", async () => {
  /* The whole point of this lane. The queue used to move this exact case back
     to `queued`, which settlement read as "never executed" and reported as
     `resend: "safe"` — on a channel that carries deployment control. */
  const active = fixture("crashed");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "crashed-key",
      text: "hold the cutover until I say go",
    });
    const crashed = crashingHost(active.generationId);

    /* The real crash path, over the real journal: no stub stands in for the
       transition, the outbox, or the host that dies mid-send. */
    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "crashed-key", "hold the cutover until I say go"),
      () => crashed.host,
    ).drain();

    expect(crashed.received).toEqual(["hold the cutover until I say go"]);
    /* Absorbing and uncertain: never `queued`, which would say it was never
       executed, and never `failed`, which the receipt reads as fenced. */
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
    });
    expect(answered?.state).toBe("failed");
    expect(answered?.duplicateRisk).toBe(true);
    expect(answered?.resend).toBe("verify-first");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("failed");
    expect(receipt?.duplicateRisk).toBe(true);
    expect(receipt?.resend).toBe("verify-first");

    /* A fresh request cannot produce a second delivery: the settled operation
       still owns the idempotency key, so admission replays the uncertain
       receipt and admits no effect, and a queue handed the stale effect
       delivers nothing. */
    const replay = active.journal.executeOperation({
      kind: "send",
      operationId,
      conversationId: active.conversationId,
      idempotencyKey: "crashed-key",
      text: "hold the cutover until I say go",
      policy: "queue",
    });
    expect(replay.receipt.status).toBe("uncertain");
    const survivor = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "crashed-key", "hold the cutover until I say go"),
      () => survivor.host,
    ).drain().catch(() => undefined);
    expect(survivor.received).toEqual([]);
  } finally {
    active.close();
  }
});

/** A host that takes the instruction, fails to answer for it, and STAYS
    STANDING — the failure a live host cannot distinguish from a refusal. */
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

test("a live host that cannot answer for a send it took is unverified, never safe to send again", async () => {
  /* The other half of the same finding. A host that dies is not the only way a
     send's fate goes unknown: the call that would have confirmed it can fail
     with the host still standing, and out here that is indistinguishable from a
     refusal. This used to settle `failed`, which the receipt reads as fenced
     and answers `resend: "safe"` — and a resend is issued under a NEW request
     id, so nothing on the host side would dedupe it against this attempt. */
  const active = fixture("unanswered");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "unanswered-key",
      text: "restart the deployment",
    });
    const unanswered = unansweringHost(active.generationId);

    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "unanswered-key", "restart the deployment"),
      () => unanswered.host,
    ).drain();

    expect(unanswered.received).toEqual(["restart the deployment"]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
    });
    expect(answered?.state).toBe("failed");
    expect(answered?.duplicateRisk).toBe(true);
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
    const receipt = receiptOf(active, operationId);
    expect(receipt?.reason).toBe(SEND_UNVERIFIED_REASON);
    expect(receipt?.duplicateRisk).toBe(true);
    expect(receipt?.resend).toBe("verify-first");

    /* And the same fence: a fresh request under the key replays the settled
       answer, and a queue handed the stale effect delivers nothing. */
    const replay = active.journal.executeOperation({
      kind: "send",
      operationId,
      conversationId: active.conversationId,
      idempotencyKey: "unanswered-key",
      text: "restart the deployment",
      policy: "queue",
    });
    expect(replay.receipt.status).toBe("uncertain");
    const survivor = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "unanswered-key", "restart the deployment"),
      () => survivor.host,
    ).drain().catch(() => undefined);
    expect(survivor.received).toEqual([]);
  } finally {
    active.close();
  }
});

test("permanent runtime loss then recovery ends in one terminal receipt and no late delivery", async () => {
  /* The whole of finding 3, end to end. The runtime host is gone for good as
     far as anyone asking can tell, so the settlement ends the send from the
     durable record alone — and that record is then the fence: the first drain
     after recovery reads it and refuses to deliver, rather than putting the
     instruction in front of the recipient long after the sender was told it had
     not arrived. Nothing here needs a sweep, a timer or a healthy process. */
  const active = fixture("recovered");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "recovered-key",
      text: "resume the cutover",
    });

    const duringOutage = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: null,
      now: AFTER_THE_WINDOW,
    });
    expect(duringOutage?.state).toBe("failed");
    expect(duringOutage?.resend).toBe("verify-first");
    expect(receiptOf(active, operationId)?.state).toBe("failed");
    /* Nothing was written to the journal — there was nothing to write to — so
       the effect is still sitting in the outbox, waiting for an executor. */
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("queued");
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toMatchObject([{ kind: "runtime.send" }]);

    /* Recovery: the runtime is back and the queue drains the effect it left
       behind. The recipient receives NOTHING. */
    const afterRecovery = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(
      stalePortFor(active, operationId, "recovered-key", "resume the cutover"),
      () => afterRecovery.host,
    ).drain();
    expect(afterRecovery.received).toEqual([]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);

    /* And the answer the caller already holds is still the answer, with the
       runtime back and able to speak for itself. */
    const settled = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(settled?.state).toBe("failed");
    expect(settled?.duplicateRisk).toBe(true);
    expect(settled?.resend).toBe("verify-first");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("failed");
  } finally {
    active.close();
  }
});

test("a retry's own operation id is answerable, settles at its own deadline, and is not delivered late", async () => {
  /* The finding: a retry is admitted as a FRESH operation with a new id, and
     that id is what the caller is handed — while everything durable stayed
     keyed to the presentation operation the attempt replaced. So the id in the
     caller's hand named nothing: a query during a runtime outage found no
     record, no deadline could ever end it, and the queue's own fence had
     nothing to read either. A caller could hold an operation id that nothing in
     the system would ever settle.

     Four things have to hold at once, and the third and fourth pull against
     each other: the attempt is answerable, it is deliberately still eligible
     for ONE fresh execution, its deadline ends it, and after that ending a
     recovery may not deliver it. */
  const active = fixture("retry-attempt");
  try {
    const { operationId } = acceptSend(active, {
      clientMessageId: "retry-attempt-key",
      text: "roll the release forward",
    });
    /* The first attempt reached an executor and failed there, which is what
       makes a retry offerable at all. */
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "failed", { reason: "dead-host" });
    active.registry.recordDeliveryOutcomeForOperation(active.conversationId, operationId, "failed", "dead-host");
    expect(receiptOf(active, operationId)?.state).toBe("failed");

    let kicks = 0;
    /* The route's OWN dependency wiring records the attempt — this fixture
       registry stands in for the process registry so the default path is the
       one under test, not a stub of it. */
    setAgentRegistryForTests(active.registry);
    const response = await handleRuntimeRetry(
      new NextRequest(`http://127.0.0.1/api/runtime/operations/${operationId}`, {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
      }),
      operationId,
      {
        enabled: () => true,
        client: () => active.client,
        recover: async () => ({
          target: null,
          path: active.transcriptPath,
          conversationId: active.conversationId,
          spawned: false,
        }),
        kick: () => { kicks += 1; },
      },
    );
    expect(response.status).toBe(202);
    const admitted = await response.json() as { operationId: string };
    const retryOperationId = admitted.operationId;
    expect(retryOperationId).not.toBe(operationId);
    expect(kicks).toBe(1);

    /* ONE: the id the caller was handed is answerable, and it answers about the
       attempt it names rather than about the dead one it replaced. */
    const accepted = receiptOf(active, retryOperationId);
    expect(accepted?.state).toBe("in-flight");
    expect(accepted?.conversationId).toBe(active.conversationId);

    /* TWO: the attempt is still eligible for its one fresh execution — the
       durable fence the queue reads before it actuates anything does not hold
       it. */
    expect(sendIsSettled(active.registry.readOnlySnapshot(), retryOperationId)).toBeFalse();

    /* THREE: the runtime is lost, and the id is answered from the durable
       record instead of a 503 — then ENDED by its own deadline, which is
       measured from when this attempt was admitted rather than from the send it
       replaced. */
    const duringLoss = await handleRuntimeOperationQuery(retryOperationId, {
      client: () => null,
      rolledBack: () => false,
      settle: (asked, asClient) => resolveSendReceipt(asked, { registry: active.registry, client: asClient }),
    });
    expect(duringLoss.status).toBe(200);
    expect(await duringLoss.json()).toMatchObject({
      operationId: retryOperationId,
      receipt: { status: "queued" },
      send: { state: "in-flight" },
    });

    const settled = await resolveSendReceipt(retryOperationId, {
      registry: active.registry,
      client: null,
      now: AFTER_THE_WINDOW,
    });
    expect(settled?.state).toBe("failed");
    expect(settled?.reason).toBe(SEND_UNSETTLEABLE_REASON);
    expect(settled?.duplicateRisk).toBeTrue();
    expect(settled?.resend).toBe("verify-first");
    expect(settled?.evidence).toBe("delivery-record");

    /* FOUR: recovery. The retry effect is still in the outbox and an executor
       picks it up with the runtime healthy again — and finds the record that
       ended it. The recipient receives nothing, because the caller has already
       been told this attempt did not arrive. */
    expect(sendIsSettled(active.registry.readOnlySnapshot(), retryOperationId)).toBeTrue();
    const afterRecovery = recordingHost(active.generationId);
    await new StructuredDeliveryQueue(
      stalePortFor(active, retryOperationId, "retry-attempt-key", "roll the release forward"),
      () => afterRecovery.host,
    ).drain();
    expect(afterRecovery.received).toEqual([]);
    expect(active.journal.operationResult(retryOperationId)?.receipt.status).toBe("uncertain");
    expect(await active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);

    /* And the answer stays the answer once the runtime can speak again — and
       across the restart of the process that wrote it, because a settlement
       nothing has to be running to honour is the whole point of keeping it on
       the durable record. */
    const afterwards = await resolveSendReceipt(retryOperationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });
    expect(afterwards?.state).toBe("failed");
    expect(afterwards?.resend).toBe("verify-first");
    const reloaded = sendReceiptFor(new AgentRegistry(active.registryPath).readOnlySnapshot(), retryOperationId);
    expect(reloaded?.state).toBe("failed");
    expect(reloaded?.resend).toBe("verify-first");
  } finally {
    setAgentRegistryForTests(null);
    active.close();
  }
});

/* docs/design/delivery-progress-and-drain.md, P14 and A2: the id a terminal
   retry mints may already name another request's row. */
test("a terminal retry whose attempt id another request's hand-off owns is refused before any wait or command, and a retry of its own send stays idempotent", async () => {
  const active = fixture("retry-collision");
  const { terminalRetryOperationId } = await import("./contracts");
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  try {
    const failSend = (key: string, text: string) => {
      const { operationId } = acceptSend(active, { clientMessageId: key, text });
      active.journal.transitionOperation(operationId, "delivering");
      active.journal.transitionOperation(operationId, "failed", { reason: "dead-host" });
      active.registry.recordDeliveryOutcomeForOperation(active.conversationId, operationId, "failed", "dead-host");
      return operationId;
    };
    const a = failSend("retry-collision-a", "message A");
    const taken = terminalRetryOperationId(a);
    /* Another request's Queue-for-Codex hand-off supplied that id first. */
    const handOff = active.registry.recordDirectAdmission({ handOff: { conversationId: active.conversationId, clientMessageId: "retry-collision-b",
      command: { operationId: taken, kind: "send", policy: "queue" }, text: "message B", contentDigest: null,
      evidenceText: "message B", evidenceImageCount: 0 } })!;
    expect(handOff.command.operationId).toBe(taken);
    const progress = new DeliveryProgressStore(null);
    progress.note(taken, active.conversationId, { waitReason: "awaiting-turn", originalKey: "retry-collision-b" });
    const rowBefore = structuredClone(active.registry.snapshot().deliveryOperationOwners[taken]);
    const recordBefore = structuredClone(progress.get(taken));
    let retries = 0;
    const client = {
      ...active.client,
      retryOperation: async (operationId: string, key: string) => { retries += 1; return active.client.retryOperation(operationId, key); },
    } as RuntimeHostClient;
    const retry = (operationId: string) => handleRuntimeRetry(
      new NextRequest(`http://127.0.0.1/api/runtime/operations/${operationId}`, { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" } }),
      operationId,
      {
        enabled: () => true,
        client: () => client,
        recover: async () => ({ target: null, path: active.transcriptPath, conversationId: active.conversationId, spawned: false }),
        kick: () => {},
        progress,
      },
    );
    setAgentRegistryForTests(active.registry);
    const refused = await retry(a);
    expect(refused.status).toBe(409);
    expect(retries).toBe(0);
    expect(active.registry.snapshot().deliveryOperationOwners[taken]).toEqual(rowBefore);
    expect(progress.get(taken)).toEqual(recordBefore);

    /* A retry of a send whose attempt id is free is admitted once, and its
       replay converges on the same attempt and row. */
    const c = failSend("retry-collision-c", "message C");
    const first = await retry(c);
    expect(first.status).toBe(202);
    const attempt = (await first.json() as { operationId: string }).operationId;
    expect(attempt).toBe(terminalRetryOperationId(c));
    const replay = await retry(c);
    expect(replay.status).toBe(202);
    expect((await replay.json() as { operationId: string }).operationId).toBe(attempt);
    expect(retries).toBe(1);
    expect(active.registry.snapshot().deliveryOperationOwners[attempt]).toMatchObject({ retryOfOperationId: c, terminalState: null });
  } finally {
    setAgentRegistryForTests(null);
    active.close();
  }
});

test("a migration-cancelled held send admits the one-tap retry its receipt offers", async () => {
  const active = fixture("migration-cancelled-retry");
  try {
    const migration = active.registry.requestConversationReseat(active.conversationId, "successor-account").migration!;
    const operationId = "operation-migration-cancelled-retry";
    const idempotencyKey = "migration-cancelled-retry-key";
    const text = "deliver after choosing another account";
    const held = active.registry.holdDelivery(
      active.conversationId,
      text,
      idempotencyKey,
      "text",
      [],
      null,
      { operationId, kind: "send", policy: "queue" },
    );
    expect(held).toMatchObject({ state: "held", attempts: 0 });
    active.journal.executeOperation({
      kind: "send",
      operationId,
      conversationId: active.conversationId,
      idempotencyKey,
      text,
      policy: "queue",
    });

    active.registry.setMigrationIntentState(migration.intentId, "stopped");
    expect(receiptOf(active, operationId)).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("migration was stopped"),
      resend: "safe",
    });
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("queued");

    let kicks = 0;
    setAgentRegistryForTests(active.registry);
    const response = await handleRuntimeRetry(
      new NextRequest(`http://127.0.0.1/api/runtime/operations/${operationId}`, {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
      }),
      operationId,
      {
        enabled: () => true,
        client: () => active.client,
        recover: async () => ({
          target: null,
          path: active.transcriptPath,
          conversationId: active.conversationId,
          spawned: false,
        }),
        kick: () => { kicks += 1; },
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ receipt: { status: "queued" } });
    expect(kicks).toBe(1);
  } finally {
    setAgentRegistryForTests(null);
    active.close();
  }
});

test("an unverified delivery record needs an explicit same-identity retry before rearming the queued journal", async () => {
  const active = fixture("unverified-migration-retry");
  try {
    const { operationId, deliveryId } = acceptSend(active, {
      clientMessageId: "unverified-migration-retry-key",
      text: "do not duplicate this instruction",
    });
    active.registry.recordDeliveryOutcome(
      deliveryId,
      "failed",
      "a prior delivery attempt may have arrived",
      "unverified",
    );
    const unverified = receiptOf(active, operationId);
    expect(unverified).toMatchObject({ state: "failed", resend: "verify-first" });
    expect(runtimeReceiptForSend(unverified!)).toMatchObject({ status: "failed", resend: "verify-first" });

    const response = await handleRuntimeRetry(
      new NextRequest(`http://127.0.0.1/api/runtime/operations/${operationId}`, {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
      }),
      operationId,
      {
        enabled: () => true,
        client: () => active.client,
        registry: () => active.registry,
        kick: () => { throw new Error("unverified retry must not kick delivery"); },
      },
    );

    expect(response.status).toBe(409);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("queued");

    let kicks = 0;
    const explicit = await handleRuntimeRetry(
      new NextRequest(`http://127.0.0.1/api/runtime/operations/${operationId}`, {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        body: JSON.stringify({ action: "retry-uncertain" }),
      }),
      operationId,
      {
        enabled: () => true,
        client: () => active.client,
        registry: () => active.registry,
        kick: () => { kicks += 1; },
      },
    );
    expect(explicit.status).toBe(202);
    expect(await explicit.json()).toMatchObject({ operationId, receipt: { operationId, status: "queued" } });
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]).toMatchObject({
      state: "delivery-uncertain",
      attempts: 2,
      command: { operationId },
    });
    expect(kicks).toBe(1);
  } finally {
    active.close();
  }
});

test("a legacy send with no journal record settles unverified rather than provably lost", async () => {
  /* The legacy delivery path writes to a transcript host and creates no runtime
     operation at all, so the journal can never say what became of it. A missing
     record used to be read as proof the send never executed — the same unsafe
     classification, on the path with the least evidence of all. */
  const active = fixture("legacy");
  try {
    const reservation = active.registry.holdDelivery(
      active.conversationId,
      "restart the deployment",
      "legacy-key",
      "text",
      [],
      null,
      {},
    );
    const claimed = active.registry.beginDeliveryAttempt(reservation.id, active.generationId);
    expect(claimed?.state).toBe("delivery-uncertain");
    const operationId = reservation.command.operationId;
    expect(active.journal.operationResult(operationId)).toBeNull();

    const answered = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
      now: AFTER_THE_WINDOW,
    });

    expect(answered?.state).toBe("failed");
    expect(answered?.duplicateRisk).toBe(true);
    expect(active.registry.readOnlySnapshot().heldDeliveries[reservation.id]?.state).toBe("failed");
    const receipt = receiptOf(active, operationId);
    expect(receipt?.state).toBe("failed");
    expect(receipt?.reason).toBe(SEND_UNRECORDED_REASON);
    expect(receipt?.duplicateRisk).toBe(true);
    expect(receipt?.resend).toBe("verify-first");
  } finally {
    active.close();
  }
});

test("a delivered journal operation answers as delivered before the deadline", async () => {
  /* The receipt is a question about now. The projection can lag the journal by
     a whole drain, and answering `in-flight` from it while the journal holds a
     delivered operation is the send-time guess this issue set out to replace —
     and this answer does not wait for any deadline to say so. */
  const active = fixture("current");
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "current-key" });
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "delivered", { turnId: "turn-current" });
    expect(receiptOf(active, operationId)?.state).toBe("in-flight");

    const receipt = await resolveSendReceipt(operationId, {
      registry: active.registry,
      client: active.client,
    });

    expect(receipt?.state).toBe("delivered");
    expect(receipt?.resend).toBe("not-needed");
    expect(receipt?.evidence).toBe("delivery-journal");
    /* Reconciled on the spot, so the record and the answer agree afterwards. */
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("delivered");
    expect(receiptOf(active, operationId)?.state).toBe("delivered");
  } finally {
    active.close();
  }
});

test("an accepted hold answers by its own operation id, and answers terminally either way", async () => {
  /* #1131: a delivery parked behind an account migration is an ACCEPTED send —
     `/api/runtime/send` and `send_message` both hand its reservation's
     operation id back — so it has to be queryable like every other acceptance,
     and the query has to reach a terminal answer whichever way the coordinator
     that owns it settles it. Nothing here has a journal record: the whole
     answer comes from the durable delivery record. */
  const active = fixture("held");
  try {
    const delivered = acceptSend(active, { clientMessageId: "held-delivered-key", operationId: "op_held_delivered" });
    const failed = acceptSend(active, { clientMessageId: "held-failed-key", operationId: "op_held_failed" });
    const emptyJournal = { ...active.client, operationStatus: async () => null } as RuntimeHostClient;
    expect((await resolveSendReceipt(delivered.operationId, {
      registry: active.registry,
      client: emptyJournal,
    }))?.state).toBe("in-flight");

    active.registry.recordDeliveryOutcome(delivered.deliveryId, "delivered", null, "delivered");
    active.registry.recordDeliveryOutcome(failed.deliveryId, "failed", "the migration could not deliver it");

    const arrived = await resolveSendReceipt(delivered.operationId, {
      registry: active.registry,
      client: emptyJournal,
    });
    expect(arrived?.state).toBe("delivered");
    expect(arrived?.resend).toBe("not-needed");
    const lost = await resolveSendReceipt(failed.operationId, {
      registry: active.registry,
      client: emptyJournal,
    });
    expect(lost?.state).toBe("failed");
    /* Settled by a path that proved nothing about execution, so it says so. */
    expect(lost?.duplicateRisk).toBe(true);
    expect(lost?.resend).toBe("verify-first");
  } finally {
    active.close();
  }
});

test("compaction retires the reservation and keeps what it proved about the send", async () => {
  /* The reservation carries the reason; the owner row is what outlives it. When
     only `terminalState` survived, both answers collapsed into one — an
     unverified failure came back `resend: "safe"`, and a fenced one lost the
     evidence that earned it. Both directions are pinned here, because a record
     that cannot tell them apart is the duplicate hazard either way. */
  let clock = Date.now();
  const active = fixture("compacted", { now: () => clock });
  try {
    const unverified = acceptSend(active, { clientMessageId: "compacted-uncertain-key", operationId: "op_compacted_uncertain" });
    active.journal.transitionOperation(unverified.operationId, "delivering", { turnId: "turn-compacted" });
    const fenced = acceptSend(active, { clientMessageId: "compacted-dropped-key", operationId: "op_compacted_dropped" });
    for (const operationId of [unverified.operationId, fenced.operationId]) {
      await resolveSendReceipt(operationId, {
        registry: active.registry,
        client: active.client,
        now: AFTER_THE_WINDOW,
      });
    }
    expect(receiptOf(active, unverified.operationId)?.resend).toBe("verify-first");
    expect(receiptOf(active, fenced.operationId)?.resend).toBe("safe");

    /* Forced: terminal reservations are retired a week after they settle, and
       any later settlement on the conversation runs that compaction. */
    clock += 8 * 24 * 60 * 60 * 1000;
    const later = acceptSend(active, { clientMessageId: "compacting-key", operationId: "op_compacting_key" });
    active.registry.recordDeliveryOutcome(later.deliveryId, "delivered", null, "delivered");
    const remaining = active.registry.readOnlySnapshot().heldDeliveries;
    expect(remaining[unverified.deliveryId]).toBeUndefined();
    expect(remaining[fenced.deliveryId]).toBeUndefined();

    const afterCompaction = receiptOf(active, unverified.operationId);
    expect(afterCompaction?.state).toBe("failed");
    expect(afterCompaction?.duplicateRisk).toBe(true);
    expect(afterCompaction?.resend).toBe("verify-first");
    expect(afterCompaction?.reason).toBe(SEND_UNVERIFIED_REASON);
    expect(afterCompaction?.settledAt).not.toBeNull();
    /* And the send that was genuinely fenced still says so, so the durable
       disposition is doing work in both directions rather than answering
       "verify first" to everything. */
    const fencedAfterCompaction = receiptOf(active, fenced.operationId);
    expect(fencedAfterCompaction?.reason).toBe(SEND_LOST_REASON);
    expect(fencedAfterCompaction?.duplicateRisk).toBe(false);
    expect(fencedAfterCompaction?.resend).toBe("safe");
  } finally {
    active.close();
  }
});

/* ── ORIGINAL-KEY LOOKUP (#1490) ─────────────────────────────────────────── */

const { lookupOriginalSend, resolveOriginalSend } = await import("./sendSettlement");

test("the original-key lookup finds one send by bound recipient and key, and reads its current answer", async () => {
  const active = fixture("original-key");
  try {
    const binding = { conversationId: active.conversationId, clientMessageId: "original-key-1" };
    expect(lookupOriginalSend(active.registry.readOnlySnapshot(), binding)).toEqual({ kind: "absent" });

    const accepted = acceptSend(active, { clientMessageId: "original-key-1", operationId: "op_original_1" });
    const found = lookupOriginalSend(active.registry.readOnlySnapshot(), binding);
    expect(found).toMatchObject({ kind: "found", operationId: accepted.operationId, deliveryId: accepted.deliveryId, reservationState: "delivery-uncertain" });
    expect(found.kind === "found" && found.receipt.state).toBe("in-flight");

    /* The same key under a DIFFERENT recipient is a different send. */
    expect(lookupOriginalSend(active.registry.readOnlySnapshot(), { ...binding, conversationId: "conversation_elsewhere" })).toEqual({ kind: "absent" });

    /* The current answer is the settlement read `message_receipt` performs. */
    active.journal.transitionOperation(accepted.operationId, "delivered", { turnId: "turn-original" });
    const resolved = await resolveOriginalSend(binding, { registry: active.registry, client: active.client });
    expect(resolved).toMatchObject({ kind: "found", operationId: accepted.operationId, current: { readable: true, value: { state: "delivered", resend: "not-needed" } } });
  } finally {
    active.close();
  }
});

test("the original-key lookup survives reservation compaction through the owner row", async () => {
  let clock = Date.now();
  const active = fixture("original-key-compacted", { now: () => clock });
  try {
    const binding = { conversationId: active.conversationId, clientMessageId: "compacted-original-key" };
    const accepted = acceptSend(active, { clientMessageId: binding.clientMessageId, operationId: "op_compacted_original" });
    await resolveSendReceipt(accepted.operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    clock += 8 * 24 * 60 * 60 * 1000;
    const later = acceptSend(active, { clientMessageId: "compacting-original-key", operationId: "op_compacting_original" });
    active.registry.recordDeliveryOutcome(later.deliveryId, "delivered", null, "delivered");
    expect(active.registry.readOnlySnapshot().heldDeliveries[accepted.deliveryId]).toBeUndefined();

    const found = lookupOriginalSend(active.registry.readOnlySnapshot(), binding);
    expect(found).toMatchObject({ kind: "found", operationId: accepted.operationId, deliveryId: null, reservationState: null });
    expect(found.kind === "found" && found.receipt).toMatchObject({ state: "failed", reason: SEND_LOST_REASON, resend: "safe" });
  } finally {
    active.close();
  }
});

test("the original-key lookup answers ambiguity and unreadable state as such, never as absence or a match", async () => {
  const active = fixture("original-key-ambiguous");
  try {
    /* A second recipient in the same registry holding the same key. */
    const otherPath = path.join(path.dirname(active.transcriptPath), "other-recipient.jsonl");
    active.registry.reconcileConversations([{
      engine: "codex",
      path: otherPath,
      accountId: "settlement-fixture-account",
      launchProfile: emptyLaunchProfile({ cwd: path.dirname(otherPath) }),
      turn: { state: "idle", source: "assistant", terminalAt: null },
      observedAt: "2026-08-30T10:00:00.000Z",
    }]);
    const other = Object.values(active.registry.snapshot().conversations).find((conversation) => conversation.id !== active.conversationId)!;
    acceptSend(active, { clientMessageId: "shared-key", operationId: "op_shared_a" });
    active.registry.holdDelivery(other.id, "hello", "shared-key", "text", [], null, { operationId: "op_shared_b", kind: "send", policy: "queue" });

    /* Bound to a recipient, the key is unambiguous. Bound to a path the
       registry cannot resolve, NOTHING matches — whether one or two operations
       carry the key — and none is disclosed; a path the registry does resolve
       is the recipient it names. */
    expect(lookupOriginalSend(active.registry.readOnlySnapshot(), { conversationId: active.conversationId, clientMessageId: "shared-key" }))
      .toMatchObject({ kind: "found", operationId: "op_shared_a" });
    expect(lookupOriginalSend(active.registry.readOnlySnapshot(), { conversationId: "/nowhere/recipient.jsonl", clientMessageId: "shared-key" }))
      .toEqual({ kind: "unresolved" });
    expect(lookupOriginalSend(active.registry.readOnlySnapshot(), { conversationId: "/nowhere/recipient.jsonl", clientMessageId: "original-key-1" }))
      .toEqual({ kind: "unresolved" });
    expect(lookupOriginalSend(active.registry.readOnlySnapshot(), { conversationId: otherPath, clientMessageId: "shared-key" }))
      .toMatchObject({ kind: "found", operationId: "op_shared_b" });
    expect(await resolveOriginalSend({ conversationId: "/nowhere/recipient.jsonl", clientMessageId: "shared-key" }, { registry: active.registry, client: null }))
      .toEqual({ kind: "unresolved" });
    /* Two operations under one key for ONE recipient is ambiguity, and
       discloses neither. */
    const file = active.registry.readOnlySnapshot();
    const ownerA = file.deliveryOperationOwners.op_shared_a!;
    const twice = { ...file, deliveryOperationOwners: { ...file.deliveryOperationOwners, op_shared_twin: { ...ownerA, deliveryId: "delivery_twin" } } };
    expect(lookupOriginalSend(twice, { conversationId: active.conversationId, clientMessageId: "shared-key" }))
      .toEqual({ kind: "ambiguous", operationIds: ["op_shared_a", "op_shared_twin"] });

    const broken = { readOnlySnapshot: () => { throw new Error("registry file is unreadable"); } } as unknown as AgentRegistry;
    expect(await resolveOriginalSend({ conversationId: active.conversationId, clientMessageId: "shared-key" }, { registry: broken, client: null }))
      .toEqual({ kind: "unreadable", reason: "registry file is unreadable" });

    /* A found send whose current answer cannot be read keeps its identity
       and the durable projection, and says the current read failed. */
    const failingClient = {
      ...active.client,
      operationStatus: async () => { throw new Error("journal socket is gone"); },
    } as RuntimeHostClient;
    const kept = await resolveOriginalSend({ conversationId: active.conversationId, clientMessageId: "shared-key" }, { registry: active.registry, client: failingClient });
    expect(kept).toMatchObject({ kind: "found", operationId: "op_shared_a", receipt: { state: "in-flight", evidence: "delivery-record" }, current: { readable: false, reason: expect.stringContaining("journal socket is gone") } });
    /* Without a journal at all the durable record is the whole answer. */
    expect(await resolveOriginalSend({ conversationId: active.conversationId, clientMessageId: "shared-key" }, { registry: active.registry, client: null }))
      .toMatchObject({ kind: "found", operationId: "op_shared_a", current: { readable: true, value: { state: "in-flight", evidence: "delivery-record" } } });
  } finally {
    active.close();
  }
});

test("the original-key lookup is read-only: past the deadline, without a journal, and with a terminal journal row, the durable record is left exactly as it was", async () => {
  const active = fixture("original-key-read-only");
  try {
    const binding = { conversationId: active.conversationId, clientMessageId: "read-only-key" };
    const accepted = acceptSend(active, { clientMessageId: binding.clientMessageId, operationId: "op_read_only" });
    const before = JSON.stringify(active.registry.readOnlySnapshot());
    const journalBefore = JSON.stringify(await active.client.operationStatus(accepted.operationId, { currentRetryLeaf: true }));

    /* Past the settlement window, with and without a journal, and with a
       journal that cannot be read: the reservation is still assigned and the
       operation still queued afterwards. Where `message_receipt` would END
       the send here, the lookup only reports it. */
    for (const ports of [
      { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW },
      { registry: active.registry, client: null, now: AFTER_THE_WINDOW },
      { registry: active.registry, client: { ...active.client, operationStatus: async () => { throw new Error("journal socket is gone"); } } as RuntimeHostClient, now: AFTER_THE_WINDOW },
    ]) {
      const observed = await resolveOriginalSend(binding, ports);
      expect(observed).toMatchObject({ kind: "found", operationId: accepted.operationId, reservationState: "delivery-uncertain" });
      if (observed.kind !== "found") throw new Error("lookup lost the send");
      if (observed.current.readable) expect(observed.current.value.state).toBe("in-flight");
      expect(JSON.stringify(active.registry.readOnlySnapshot())).toBe(before);
      expect(JSON.stringify(await active.client.operationStatus(accepted.operationId, { currentRetryLeaf: true }))).toBe(journalBefore);
    }
    expect(await resolveSendReceipt(accepted.operationId, { registry: active.registry, client: active.client })).toMatchObject({ state: "in-flight" });

    /* A terminal journal row is REPORTED as the current answer and not
       written onto the reservation: the durable record still says in flight
       until the settlement read `message_receipt` performs ends it. */
    active.journal.transitionOperation(accepted.operationId, "delivered", { turnId: "turn-read-only" });
    const delivered = await resolveOriginalSend(binding, { registry: active.registry, client: active.client });
    expect(delivered).toMatchObject({ kind: "found", current: { readable: true, value: { state: "delivered", resend: "not-needed", evidence: "delivery-journal" } } });
    expect(sendReceiptFor(active.registry.readOnlySnapshot(), accepted.operationId)).toMatchObject({ state: "in-flight" });
    expect(active.registry.readOnlySnapshot().heldDeliveries[accepted.deliveryId]?.state).toBe("delivery-uncertain");
  } finally {
    active.close();
  }
});

test("original-key payload checks survive delivery text removal and reservation compaction", async () => {
  const active = fixture("original-key-payload");
  try {
    const accepted = acceptSend(active, { clientMessageId: "payload-key", operationId: "op_payload" });
    const file = active.registry.readOnlySnapshot();
    const text = file.heldDeliveries[accepted.deliveryId]!.text;
    const binding = { conversationId: active.conversationId, clientMessageId: "payload-key", text };
    expect(lookupOriginalSend(file, binding)).toMatchObject({ kind: "found" });
    const contradictory = structuredClone(file);
    contradictory.deliveryOperationOwners[accepted.operationId]!.conversationId = "conversation_elsewhere";
    expect(lookupOriginalSend(contradictory, binding)).toEqual({ kind: "contradictory" });
    expect(lookupOriginalSend(file, { ...binding, text: "another payload" })).toEqual({ kind: "contradictory" });
    active.registry.recordDeliveryOutcome(accepted.deliveryId, "delivered", null, "delivered");
    const delivered = active.registry.readOnlySnapshot();
    expect(delivered.heldDeliveries[accepted.deliveryId]!.text).toBe("");
    expect(lookupOriginalSend(delivered, binding)).toMatchObject({ kind: "found" });
    const compacted = structuredClone(delivered);
    delete compacted.heldDeliveries[accepted.deliveryId];
    expect(lookupOriginalSend(compacted, binding)).toMatchObject({ kind: "found" });
    expect(lookupOriginalSend(compacted, { ...binding, text: "another payload" })).toEqual({ kind: "contradictory" });
  } finally { active.close(); }
});

/* ── INTERRUPT-AND-RESEND ROUTE (docs/design/copilot-engine.md 3.4) ─────── */

/** A Copilot-shaped host: no steer, an interrupt fallback, one running turn. */
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
