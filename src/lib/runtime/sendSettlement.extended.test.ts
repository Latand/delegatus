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


test("message_receipt says a message interrupted the running turn, in flight and after it settles", async () => {
  const active = fixture("interrupt-route");
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "interrupt-route-key", text: "change course" });
    const { host, actions } = interruptingHost(active.generationId);
    /* In flight: the interrupt was issued and the message is not handed over
       yet. The route is what the `delivering` transition recorded. */
    let inFlight = null as Awaited<ReturnType<typeof resolveSendReceipt>>;
    const observing: EngineHost = {
      ...host,
      interrupt: async (turnId) => {
        inFlight = await resolveSendReceipt(operationId, { registry: active.registry, client: active.client });
        await host.interrupt(turnId);
      },
    };
    await new StructuredDeliveryQueue(interruptActivePort(active, operationId, "change course"), () => observing).drain();
    expect(actions).toEqual(["interrupt:copilot:1-turn", "send:change course"]);
    expect(inFlight).toMatchObject({
      state: "in-flight",
      delivery: "interrupt-then-turn-started",
      interruptedTurnId: "copilot:1-turn",
    });

    /* Settled, reconciled from the journal onto the delivery record. */
    const settled = await resolveSendReceipt(operationId, { registry: active.registry, client: active.client });
    expect(settled).toMatchObject({
      state: "delivered",
      delivery: "interrupt-then-turn-started",
      interruptedTurnId: "copilot:1-turn",
    });
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]?.state).toBe("delivered");
    /* The record answers alone, and still does after a reload from disk, so
       the route outlives the journal receipt. */
    expect(receiptOf(active, operationId)).toMatchObject({
      state: "delivered",
      evidence: "delivery-record",
      delivery: "interrupt-then-turn-started",
      interruptedTurnId: "copilot:1-turn",
    });
    const reloaded = new AgentRegistry(active.registryPath);
    expect(sendReceiptFor(reloaded.readOnlySnapshot(), operationId)).toMatchObject({
      delivery: "interrupt-then-turn-started",
      interruptedTurnId: "copilot:1-turn",
    });
    expect(runtimeReceiptForSend(settled!)).toMatchObject({ delivery: "interrupt-then-turn-started", interruptedTurnId: "copilot:1-turn" });
  } finally {
    active.close();
  }
});

test("a send that reached the engine without interrupting anything carries no route", async () => {
  const active = fixture("plain-route");
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "plain-route-key" });
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "delivered", { turnId: "turn-plain" });
    const settled = await resolveSendReceipt(operationId, { registry: active.registry, client: active.client });
    expect(settled?.state).toBe("delivered");
    expect(settled).not.toHaveProperty("delivery");
    expect(settled).not.toHaveProperty("interruptedTurnId");
    expect(receiptOf(active, operationId)).not.toHaveProperty("delivery");
  } finally {
    active.close();
  }
});

const { FileClaudeDeliveryLedger } = await import("./claudeStreamBrokerHost");
const { deliveryDedupToken } = await import("./deliveryDedup");
const { encodeCodexStructuredUserText } = await import("./codexStructuredUserText.server");
const { structuredContent } = await import("./structuredContent");

test("status honors its own concurrent operation-bound echo even before the transcript exists", async () => {
  const active = fixture("claude-own-echo-race", { engine: "claude" });
  const ledger = new FileClaudeDeliveryLedger();
  const { operationId, deliveryId } = acceptSend(active, { text: "confirm this exact send" });
  ledger.recordQueued(active.generationId, { id: operationId, text: "confirm this exact send" }, "turn-started");
  active.journal.transitionOperation(operationId, "delivering");
  active.journal.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
  active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
  let wrote = false;
  const load = FileClaudeDeliveryLedger.prototype.load;
  const loadSpy = spyOn(FileClaudeDeliveryLedger.prototype, "load").mockImplementation(function (this: InstanceType<typeof FileClaudeDeliveryLedger>, sessionId) {
    const snapshot = load.call(this, sessionId);
    if (sessionId === active.generationId && !wrote) {
      wrote = true;
      const writer = `
        const { FileClaudeDeliveryLedger } = await import(${JSON.stringify(new URL("./claudeStreamBrokerHost.ts", import.meta.url).href)});
        if (new FileClaudeDeliveryLedger().confirmDelivered(${JSON.stringify(sessionId)}, ${JSON.stringify(operationId)}, "own-user-echo") !== "accepted") {
          throw new Error("fixture echo was refused");
        }
      `;
      const child = spawnSync(process.execPath, ["--eval", writer], {
        cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 10_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
    }
    return snapshot;
  });
  try {
    expect(await resolveSendReceipt(operationId, { registry: new AgentRegistry(active.registryPath), client: active.client }))
      .toMatchObject({ state: "delivered", resend: "not-needed", duplicateRisk: false });
    expect(wrote).toBe(true);
    expect(active.journal.effectBatch(100)).toEqual([]);
  } finally {
    loadSpy.mockRestore();
    active.close();
  }
});

test("a Claude acknowledgement keeps its bound UUID when a later unrelated user repeats its text", async () => {
  const active = fixture("claude-bound-inferred-echo", { engine: "claude" });
  try {
    const text = "repeat the acknowledged instruction";
    const { operationId, deliveryId } = acceptSend(active, { text });
    const ledger = new FileClaudeDeliveryLedger();
    ledger.recordQueued(active.generationId, { id: operationId, text }, "turn-started");
    expect(ledger.confirmDelivered(active.generationId, operationId, "bound-user", "inferred")).toBe("accepted");
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
    active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
    fs.writeFileSync(active.transcriptPath, canonicalClaudeUser("bound-user", text, new Date(Date.now() + 10).toISOString()));
    const { confirmedSend } = await import("./confirmedSend");
    expect(await confirmedSend(active.registry.readOnlySnapshot(), operationId, false)).toBe(true);
    fs.appendFileSync(active.transcriptPath, canonicalClaudeUser("unrelated-user", text, new Date(Date.now() + 20).toISOString()));
    expect(await resolveSendReceipt(operationId, { registry: new AgentRegistry(active.registryPath), client: active.client }))
      .toMatchObject({ state: "delivered", resend: "not-needed", duplicateRisk: false });
    expect(ledger.load(active.generationId).find((state) => state.entry.id === operationId)?.engineMessageId).toBe("bound-user");
    expect(active.journal.effectBatch(100)).toEqual([]);
  } finally { active.close(); }
});

for (const laterEvidence of ["pending-equal-text", "repeated-bound-frame"] as const) {
  test(`an allocated Claude acknowledgement survives ${laterEvidence}`, async () => {
    const active = fixture(`claude-allocated-${laterEvidence}`, { engine: "claude" });
    try {
      const text = "retain this acknowledged instruction";
      const { operationId, deliveryId } = acceptSend(active, { text });
      const ledger = new FileClaudeDeliveryLedger();
      ledger.recordQueued(active.generationId, { id: operationId, text }, "turn-started");
      expect(ledger.confirmDelivered(active.generationId, operationId, "allocated-user", "inferred")).toBe("accepted");
      active.journal.transitionOperation(operationId, "delivering");
      active.journal.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
      active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
      const user = canonicalClaudeUser("allocated-user", text, new Date(Date.now() + 1000).toISOString());
      fs.writeFileSync(active.transcriptPath, user);
      const { confirmedSend } = await import("./confirmedSend");
      expect(await confirmedSend(active.registry.readOnlySnapshot(), operationId, false)).toBe(true);
      if (laterEvidence === "pending-equal-text") {
        // A coarse or skewed engine timestamp can also match a later pending
        // send. A's already allocated UUID remains its own recipient evidence.
        ledger.recordQueued(active.generationId, { id: "later-pending", text }, "queued-next-turn");
      } else {
        fs.appendFileSync(active.transcriptPath, user);
      }
      expect(await resolveSendReceipt(operationId, { registry: new AgentRegistry(active.registryPath), client: active.client }))
        .toMatchObject({ state: "delivered", resend: "not-needed", duplicateRisk: false });
      expect(ledger.load(active.generationId).find((state) => state.entry.id === "later-pending")?.delivered ?? false).toBe(false);
      expect(active.journal.effectBatch(100)).toEqual([]);
    } finally { active.close(); }
  });
}

for (const mode of ["status", "startup", "original-key"] as const) {
  for (const boundary of ["ledger-snapshot", "refreshed-snapshot", "confirmation", "allocation-append"] as const) {
    if (mode === "original-key" && boundary !== "ledger-snapshot" && boundary !== "refreshed-snapshot") continue;
    test(`${mode} keeps an unacknowledged Claude send checking when another process claims its candidate at ${boundary}`, async () => {
      const active = fixture(`claude-claim-race-${mode}-${boundary}`, { engine: "claude" });
      const ledger = new FileClaudeDeliveryLedger();
      const text = "identical concurrent instruction";
      const uuid = "concurrent-canonical-user";
      const a = acceptSend(active, { text, operationId: "op_race_a", clientMessageId: "race-a" });
      const b = acceptSend(active, { text, operationId: "op_race_b", clientMessageId: "race-b" });
      for (const send of [a, b]) {
        active.journal.transitionOperation(send.operationId, "delivering");
        active.journal.transitionOperation(send.operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
        active.registry.recordDeliveryOutcome(send.deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
      }
      ledger.recordQueued(active.generationId, { id: a.operationId, text }, "turn-started");
      let wrote = false;
      const concurrentWriter = () => {
        if (wrote) return;
        wrote = true;
        // A separate Viewer/MCP process persists B's real echo while A holds
        // an older ledger snapshot. No engine input is sent by reconciliation.
        const writer = `
          import fs from "node:fs";
          const { FileClaudeDeliveryLedger } = await import(${JSON.stringify(new URL("./claudeStreamBrokerHost.ts", import.meta.url).href)});
          const ledger = new FileClaudeDeliveryLedger();
          const session = ${JSON.stringify(active.generationId)};
          ledger.recordQueued(session, ${JSON.stringify({ id: b.operationId, text })}, "turn-started");
          if (ledger.confirmDelivered(session, ${JSON.stringify(b.operationId)}, ${JSON.stringify(uuid)}) !== "accepted") {
            throw new Error("concurrent fixture confirmation was refused");
          }
          fs.writeFileSync(${JSON.stringify(active.transcriptPath)}, JSON.stringify({
            type: "user", uuid: ${JSON.stringify(uuid)}, timestamp: new Date(Date.now() + 10).toISOString(),
            message: { role: "user", content: ${JSON.stringify(text)} }
          }) + "\\n");
        `;
        const child = spawnSync(process.execPath, ["--eval", writer], {
          cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 10_000,
        });
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
      };
      if (boundary !== "ledger-snapshot") {
        fs.writeFileSync(active.transcriptPath, canonicalClaudeUser(uuid, text, new Date(Date.now() + 10).toISOString()));
      }
      const load = FileClaudeDeliveryLedger.prototype.load;
      const confirm = FileClaudeDeliveryLedger.prototype.confirmDelivered;
      let confirmingA = false;
      let confirmationReads = 0;
      let snapshotReads = 0;
      let confirmationOutcome: ReturnType<typeof confirm> | undefined;
      const loadSpy = spyOn(FileClaudeDeliveryLedger.prototype, "load").mockImplementation(function (this: InstanceType<typeof FileClaudeDeliveryLedger>, sessionId) {
        const snapshot = load.call(this, sessionId);
        if (sessionId === active.generationId && boundary === "ledger-snapshot") concurrentWriter();
        if (sessionId === active.generationId && boundary === "refreshed-snapshot"
          && ++snapshotReads === 2) concurrentWriter();
        if (sessionId === active.generationId && confirmingA && boundary === "allocation-append"
          && ++confirmationReads === 2) concurrentWriter();
        return snapshot;
      });
      const confirmSpy = spyOn(FileClaudeDeliveryLedger.prototype, "confirmDelivered").mockImplementation(function (this: InstanceType<typeof FileClaudeDeliveryLedger>, ...args) {
        if (args[0] === active.generationId && args[1] === a.operationId && boundary === "confirmation") concurrentWriter();
        confirmingA = args[0] === active.generationId && args[1] === a.operationId;
        try {
          const result = confirm.apply(this, args);
          if (confirmingA) confirmationOutcome = result;
          return result;
        }
        finally { confirmingA = false; }
      });
      try {
        const reopened = new AgentRegistry(active.registryPath);
        if (mode === "startup") {
          const { bindStructuredDeliveryQueue } = await import("./structuredDeliveryController");
          await bindStructuredDeliveryQueue([], { registry: reopened, client: active.client });
        } else if (mode === "original-key") {
          expect(await resolveOriginalSend({ conversationId: active.conversationId, clientMessageId: "race-a" }, {
            registry: reopened, client: active.client,
          })).toMatchObject({ kind: "found", current: { readable: true, value: {
            state: "failed", resend: "verify-first", duplicateRisk: true,
          } } });
        } else {
          expect(await resolveSendReceipt(a.operationId, { registry: reopened, client: active.client }))
            .toMatchObject({ state: "failed", resend: "verify-first", duplicateRisk: true });
        }
        expect(wrote).toBe(true);
        if (boundary === "confirmation" || boundary === "allocation-append") expect(confirmationOutcome).toBe("refused");
        expect(sendReceiptFor(reopened.readOnlySnapshot(), a.operationId))
          .toMatchObject({ state: "failed", resend: "verify-first", duplicateRisk: true });
        expect(await resolveSendReceipt(b.operationId, { registry: reopened, client: active.client }))
          .toMatchObject({ state: "delivered", resend: "not-needed", duplicateRisk: false });
        expect(new FileClaudeDeliveryLedger().load(active.generationId).find((state) => state.entry.id === a.operationId))
          .toMatchObject({ delivered: false });
        expect(new AgentRegistry(active.registryPath).readOnlySnapshot().heldDeliveries[a.deliveryId]?.state).toBe("failed");
        expect(active.journal.effectBatch(100)).toEqual([]);
      } finally {
        confirmSpy.mockRestore();
        loadSpy.mockRestore();
        active.close();
      }
    });
  }
}

for (const evidence of ["echo", "transcript", "startup"] as const) {
  test(`Viewer restart settles an uncertain Claude send from late ${evidence} without replay`, async () => {
    const active = fixture(`late-claude-${evidence}`, { engine: "claude" });
    try {
      const text = "check the release";
      const { operationId, deliveryId } = acceptSend(active, { text });
      const ledger = new FileClaudeDeliveryLedger();
      ledger.recordQueued(active.generationId, { id: operationId, text }, "turn-started");
      active.journal.transitionOperation(operationId, "delivering");
      active.journal.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
      active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
      const uuid = "canonical-user-turn";
      if (evidence === "echo") ledger.confirmDelivered(active.generationId, operationId, uuid);
      fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "user", uuid, timestamp: new Date().toISOString(), message: { role: "user", content: text } }) + "\n");
      const reopened = new AgentRegistry(active.registryPath);
      if (evidence === "startup") {
        const { bindStructuredDeliveryQueue } = await import("./structuredDeliveryController");
        await bindStructuredDeliveryQueue([], { registry: reopened, client: active.client });
        expect(sendReceiptFor(reopened.readOnlySnapshot(), operationId)?.state).toBe("delivered");
        expect(new FileClaudeDeliveryLedger().load(active.generationId).find((state) => state.entry.id === operationId))
          .toMatchObject({ delivered: true, engineMessageId: uuid, confirmation: "inferred" });

        const laterOperationId = "op_after_startup";
        const laterReservation = active.registry.holdDelivery(active.conversationId, text, "after-startup", "text", [], null, {
          operationId: laterOperationId,
          kind: "send",
          policy: "queue",
        });
        if (laterReservation.state !== "assigned") throw new Error("later fixture delivery was not assigned");
        expect(active.registry.beginDeliveryAttempt(laterReservation.id, active.generationId)).not.toBeNull();
        ledger.recordQueued(active.generationId, { id: laterOperationId, text }, "turn-started");
        active.registry.recordDeliveryOutcome(laterReservation.id, "failed", SEND_UNVERIFIED_REASON, "unverified");
        fs.appendFileSync(active.transcriptPath, JSON.stringify({ type: "user", uuid: "canonical-user-turn-B", timestamp: new Date(Date.now() + 10).toISOString(), message: { role: "user", content: text } }) + "\n");
        expect(await resolveSendReceipt(laterOperationId, { registry: reopened, client: null }))
          .toMatchObject({ state: "delivered", resend: "not-needed" });
        await bindStructuredDeliveryQueue([], { registry: reopened, client: null });
      }
      const answer = await resolveSendReceipt(operationId, { registry: reopened, client: active.client });
      expect(answer).toMatchObject({ state: "delivered", resend: "not-needed", duplicateRisk: false });
      expect(sendReceiptFor(reopened.readOnlySnapshot(), operationId)?.state).toBe("delivered");
      expect(active.journal.effectBatch(100)).toEqual([]);
    } finally { active.close(); }
  });
}

test("a Codex canonical user turn settles started delivery even when the Viewer missed its echo", async () => {
  const active = fixture("canonical-codex");
  try {
    const text = "check the release";
    const { operationId } = acceptSend(active, { text });
    active.journal.transitionOperation(operationId, "delivering");
    const wire = await encodeCodexStructuredUserText(text, undefined, null, { kind: "operator" }, deliveryDedupToken(operationId));
    fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: wire } }) + "\n");
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client })).toMatchObject({ state: "delivered", resend: "not-needed" });
  } finally { active.close(); }
});

test("a committed discard wins a late canonical acknowledgement before its registry projection", async () => {
  const active = fixture("discard-canonical-race", { now: () => Date.parse("2026-10-01T00:00:00Z") });
  const { handleRuntimeDiscard } = await import("./http");
  const text = "check the retained delivery";
  const { operationId, deliveryId } = acceptSend(active, { text, operationId: "discard-canonical-operation", clientMessageId: "discard-canonical-key" });
  active.journal.transitionOperation(operationId, "delivering");
  active.journal.transitionOperation(operationId, "uncertain");
  active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
  const wire = await encodeCodexStructuredUserText(text, undefined, null, { kind: "operator" }, deliveryDedupToken(operationId));
  fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: wire } }) + "\n");
  let entered!: () => void;
  const committed = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const acknowledgement = new Promise<void>(resolve => { release = resolve; });
  active.client.claimDeliveryAction = async (...args) => {
    const result = active.journal.claimDeliveryAction(...args);
    entered();
    await acknowledgement;
    return result;
  };
  const discarding = handleRuntimeDiscard(new NextRequest("http://127.0.0.1/api/runtime/operations/discard-canonical-operation", {
    method: "DELETE", headers: { host: "127.0.0.1" },
  }), operationId, { enabled: () => true, client: () => active.client, registry: () => active.registry, kick: () => {} });
  try {
    await committed;
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client }))
      .toMatchObject({ state: "failed", reason: "delivery-discarded", duplicateRisk: true });
    release();
    expect((await discarding).status).toBe(200);
    expect(active.journal.operationResult(operationId)?.receipt).toMatchObject({ status: "failed", reason: "delivery-discarded" });
    expect(sendReceiptFor(active.registry.readOnlySnapshot(), operationId)).toMatchObject({ state: "failed", reason: "delivery-discarded" });
  } finally {
    release();
    await discarding;
    active.close();
  }
});

test("original-key recovery follows the journal winner while canonical evidence is present", async () => {
  const active = fixture("original-key-discard-canonical-race", { now: () => Date.parse("2026-10-01T00:00:00Z") });
  const { handleRuntimeDiscard } = await import("./http");
  const { viewerMcpRecoverableTools } = await import("@/lib/mcp/bindings");
  const binding = { conversationId: active.conversationId, clientMessageId: "discard-canonical-key" };
  const text = "check the retained delivery";
  const { operationId, deliveryId } = acceptSend(active, { text, operationId: "discard-canonical-operation", clientMessageId: binding.clientMessageId });
  active.journal.transitionOperation(operationId, "delivering");
  active.journal.transitionOperation(operationId, "uncertain");
  active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
  const wire = await encodeCodexStructuredUserText(text, undefined, null, { kind: "operator" }, deliveryDedupToken(operationId));
  fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: wire } }) + "\n");

  let entered!: () => void;
  const committed = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const acknowledgement = new Promise<void>(resolve => { release = resolve; });
  active.client.claimDeliveryAction = async (...args) => {
    const result = active.journal.claimDeliveryAction(...args);
    entered();
    await acknowledgement;
    return result;
  };
  const discarding = handleRuntimeDiscard(new NextRequest("http://127.0.0.1/api/runtime/operations/discard-canonical-operation", {
    method: "DELETE", headers: { host: "127.0.0.1" },
  }), operationId, { enabled: () => true, client: () => active.client, registry: () => active.registry, kick: () => {} });
  try {
    await committed;
    const beforeProjection = await resolveOriginalSend(binding, { registry: active.registry, client: active.client });
    expect(beforeProjection).toMatchObject({
      kind: "found",
      current: { readable: true, value: { state: "failed", reason: "delivery-discarded", duplicateRisk: true } },
    });
    let mcpRegistry = active.registry;
    const mcp = viewerMcpRecoverableTools({ sendSettlementPorts: () => ({ registry: mcpRegistry, client: active.client }) } as never);
    const mcpBinding = { toolName: "send_message", downstreamKey: binding.clientMessageId, target: { identity: binding.conversationId } } as never;
    expect(await mcp.send_message!.recover!(mcpBinding, { legacy: false })).toMatchObject({
      outcome: "settled", reason: "delivery-discarded", facts: { state: "failed", resend: "verify-first", duplicateRisk: true },
    });

    release();
    expect((await discarding).status).toBe(200);
    expect(active.journal.operationResult(operationId)?.receipt).toMatchObject({ status: "failed", reason: "delivery-discarded" });
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]).toMatchObject({ state: "failed", error: "delivery-discarded" });

    const reopened = new AgentRegistry(active.registryPath);
    mcpRegistry = reopened;
    const afterRestart = await resolveOriginalSend(binding, { registry: reopened, client: active.client });
    expect(afterRestart).toMatchObject({
      kind: "found",
      current: { readable: true, value: { state: "failed", reason: "delivery-discarded", duplicateRisk: true } },
    });
    expect(await mcp.send_message!.recover!(mcpBinding, { legacy: false })).toMatchObject({
      outcome: "settled", reason: "delivery-discarded", facts: { state: "failed", resend: "verify-first", duplicateRisk: true },
    });
  } finally {
    release();
    await discarding;
    active.close();
  }
});

test("original-key recovery keeps canonical delivery when acknowledgement won first", async () => {
  const active = fixture("original-key-ack-canonical-first");
  const { viewerMcpRecoverableTools } = await import("@/lib/mcp/bindings");
  try {
    const text = "check the retained delivery";
    const { operationId, deliveryId } = acceptSend(active, { text, operationId: "ack-canonical-operation", clientMessageId: "ack-canonical-key" });
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "uncertain");
    active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
    active.journal.transitionOperation(operationId, "delivered", {}, { confirmedDelivery: true });
    const wire = await encodeCodexStructuredUserText(text, undefined, null, { kind: "operator" }, deliveryDedupToken(operationId));
    fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: wire } }) + "\n");

    const beforeProjection = await resolveOriginalSend({ conversationId: active.conversationId, clientMessageId: "ack-canonical-key" }, {
      registry: active.registry, client: active.client,
    });
    expect(beforeProjection).toMatchObject({ kind: "found", current: { readable: true, value: { state: "delivered", resend: "not-needed" } } });
    expect(sendReceiptFor(active.registry.readOnlySnapshot(), operationId)).toMatchObject({ state: "failed", reason: SEND_UNVERIFIED_REASON });
    let mcpRegistry = active.registry;
    const mcp = viewerMcpRecoverableTools({ sendSettlementPorts: () => ({ registry: mcpRegistry, client: active.client }) } as never);
    const mcpBinding = { toolName: "send_message", downstreamKey: "ack-canonical-key", target: { identity: active.conversationId } } as never;
    expect(await mcp.send_message!.recover!(mcpBinding, { legacy: false })).toMatchObject({
      outcome: "settled", facts: { state: "delivered", resend: "not-needed", duplicateRisk: false },
    });

    const reopened = new AgentRegistry(active.registryPath);
    mcpRegistry = reopened;
    expect(await resolveOriginalSend({ conversationId: active.conversationId, clientMessageId: "ack-canonical-key" }, {
      registry: reopened, client: active.client,
    })).toMatchObject({ kind: "found", current: { readable: true, value: { state: "delivered", resend: "not-needed" } } });
    expect(await mcp.send_message!.recover!(mcpBinding, { legacy: false })).toMatchObject({
      outcome: "settled", facts: { state: "delivered", resend: "not-needed", duplicateRisk: false },
    });
  } finally { active.close(); }
});

test("original-key recovery cannot report canonical delivery when journal arbitration is unavailable", async () => {
  const active = fixture("original-key-canonical-unavailable");
  const { viewerMcpRecoverableTools } = await import("@/lib/mcp/bindings");
  try {
    const text = "check the retained delivery";
    const { operationId, deliveryId } = acceptSend(active, { text, operationId: "unavailable-canonical-operation", clientMessageId: "unavailable-canonical-key" });
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "uncertain");
    active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
    const wire = await encodeCodexStructuredUserText(text, undefined, null, { kind: "operator" }, deliveryDedupToken(operationId));
    fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: wire } }) + "\n");
    const unavailable = { ...active.client, transitionOperation: async () => { throw new Error("journal arbitration unavailable"); },
      operationStatus: async () => { throw new Error("journal status unavailable"); } } as RuntimeHostClient;

    for (const client of [unavailable, null]) {
      const found = await resolveOriginalSend({ conversationId: active.conversationId, clientMessageId: "unavailable-canonical-key" }, {
        registry: active.registry, client,
      });
      expect(found).toMatchObject({ kind: "found", current: { readable: false } });
      if (found.kind === "found" && found.current.readable) expect(found.current.value.state).not.toBe("delivered");
    }
    const mcp = viewerMcpRecoverableTools({ sendSettlementPorts: () => ({ registry: active.registry, client: unavailable }) } as never);
    expect(await mcp.send_message!.recover!({
      toolName: "send_message", downstreamKey: "unavailable-canonical-key", target: { identity: active.conversationId },
    } as never, { legacy: false })).toMatchObject({
      outcome: "settled", facts: { state: "failed", resend: "verify-first", duplicateRisk: true },
      reason: expect.stringContaining("current runtime answer could not be read"),
    });
    expect(sendReceiptFor(active.registry.readOnlySnapshot(), operationId)).toMatchObject({ state: "failed", reason: SEND_UNVERIFIED_REASON });
  } finally { active.close(); }
});

test("equal text under another key and an assistant answer prove nothing about this send", async () => {
  const active = fixture("wrong-key-codex");
  try {
    const text = "check the release";
    const { operationId } = acceptSend(active, { text });
    active.journal.transitionOperation(operationId, "delivering");
    const wire = await encodeCodexStructuredUserText(text, undefined, null, { kind: "operator" }, deliveryDedupToken("different-operation"));
    fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: wire } }) + "\n" + JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } }) + "\n");
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW })).toMatchObject({ state: "failed", resend: "verify-first" });
  } finally { active.close(); }
});

test("a host accepting during the not-delivered fence cannot be reported safe to resend", async () => {
  const active = fixture("acceptance-fence-race");
  try {
    const { operationId } = acceptSend(active);
    const transition = active.client.transitionOperation;
    active.client.transitionOperation = async (id, status, details, options) => {
      if (status === "failed" && details?.reason === SEND_LOST_REASON) {
        active.journal.transitionOperation(id, "delivering");
        active.journal.transitionOperation(id, "delivered");
      }
      return transition(id, status, details, options);
    };
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW }))
      .toMatchObject({ state: "delivered", resend: "not-needed" });
  } finally { active.close(); }
});

for (const kind of ["old-user", "different-payload", "consumed-user", "tool-result"] as const) {
  test(`Claude ${kind} cannot settle an unrelated uncertain attempt`, async () => {
    const active = fixture(`claude-negative-${kind}`, { engine: "claude" });
    try {
      const text = "check the release";
      const { operationId, deliveryId } = acceptSend(active, { text });
      const ledger = new FileClaudeDeliveryLedger();
      if (kind === "consumed-user") {
        ledger.recordQueued(active.generationId, { id: "earlier-operation", text }, "turn-started");
        ledger.confirmDelivered(active.generationId, "earlier-operation", "user-1");
      }
      ledger.recordQueued(active.generationId, { id: operationId, text: kind === "different-payload" ? "other payload" : text }, "turn-started");
      active.journal.transitionOperation(operationId, "delivering");
      active.journal.transitionOperation(operationId, "uncertain");
      active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
      const content = kind === "tool-result" ? [{ type: "tool_result", content: text }] : text;
      fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "user", uuid: "user-1", timestamp: kind === "old-user" ? "2020-01-01T00:00:00.000Z" : new Date().toISOString(), message: { role: "user", content } }) + "\n");
      expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client })).toMatchObject({ state: "failed", resend: "verify-first" });
    } finally { active.close(); }
  });
}

test("a canonical Claude turn with duplicate pending text stays ambiguous, while its own echo settles B", async () => {
  const active = fixture("claude-same-payload", { engine: "claude" });
  try {
    const text = "identical instruction";
    const a = acceptSend(active, { text, operationId: "op_claude_a", clientMessageId: "claude-a" });
    const b = acceptSend(active, { text, operationId: "op_claude_b", clientMessageId: "claude-b" });
    const ledger = new FileClaudeDeliveryLedger();
    ledger.recordQueued(active.generationId, { id: a.operationId, text }, "turn-started");
    ledger.recordQueued(active.generationId, { id: b.operationId, text }, "turn-started");
    for (const item of [a, b]) {
      active.journal.transitionOperation(item.operationId, "delivering");
      active.journal.transitionOperation(item.operationId, "uncertain");
      active.registry.recordDeliveryOutcome(item.deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
    }
    const uuid = "claude-b-user-turn";
    const canonicalUser = (userId: string) => JSON.stringify({ type: "user", uuid: userId, timestamp: new Date().toISOString(), message: { role: "user", content: text } }) + "\n";
    fs.writeFileSync(active.transcriptPath, canonicalUser(uuid));
    const reopened = new AgentRegistry(active.registryPath);
    expect(await resolveSendReceipt(a.operationId, { registry: reopened, client: null }))
      .toMatchObject({ state: "failed", resend: "verify-first" });
    fs.appendFileSync(active.transcriptPath, canonicalUser("unrelated-identical-user-turn"));
    expect(await resolveSendReceipt(a.operationId, { registry: reopened, client: null }))
      .toMatchObject({ state: "failed", resend: "verify-first" });
    ledger.confirmDelivered(active.generationId, b.operationId, uuid);
    expect(await resolveSendReceipt(b.operationId, { registry: reopened, client: null }))
      .toMatchObject({ state: "delivered", resend: "not-needed" });
  } finally { active.close(); }
});

test("sequential Claude sends consume each canonical UUID exactly once across registry reopen", async () => {
  const active = fixture("claude-sequential-turns", { engine: "claude" });
  try {
    const text = "repeat this instruction";
    const ledger = new FileClaudeDeliveryLedger();
    const a = acceptSend(active, { text, operationId: "op_sequential_a", clientMessageId: "sequential-a" });
    ledger.recordQueued(active.generationId, { id: a.operationId, text }, "turn-started");
    const firstTime = new Date(Date.now() + 10).toISOString();
    fs.writeFileSync(active.transcriptPath, canonicalClaudeUser("sequential-user-a", text, firstTime));
    const first = new AgentRegistry(active.registryPath);
    expect(await resolveSendReceipt(a.operationId, { registry: first, client: null }))
      .toMatchObject({ state: "delivered", resend: "not-needed" });

    await Bun.sleep(2);
    const b = acceptSend(active, { text, operationId: "op_sequential_b", clientMessageId: "sequential-b" });
    ledger.recordQueued(active.generationId, { id: b.operationId, text }, "turn-started");
    const secondTime = new Date(Date.now() + 10).toISOString();
    fs.appendFileSync(active.transcriptPath, canonicalClaudeUser("sequential-user-b", text, secondTime));
    const reopened = new AgentRegistry(active.registryPath);
    expect(await resolveSendReceipt(b.operationId, { registry: reopened, client: null }))
      .toMatchObject({ state: "delivered", resend: "not-needed" });
    const states = ledger.load(active.generationId);
    expect(states.filter((state) => state.delivered).map((state) => state.engineMessageId).sort())
      .toEqual(["sequential-user-a", "sequential-user-b"]);
  } finally { active.close(); }
});

test("a retry records and settles against the currently committed generation", async () => {
  const active = fixture("retry-successor-generation");
  try {
    const original = acceptSend(active, { text: "recover into successor", operationId: "op_retry_original", clientMessageId: "retry-original" });
    active.journal.transitionOperation(original.operationId, "delivering");
    active.journal.transitionOperation(original.operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
    active.registry.recordDeliveryOutcome(original.deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");

    const snapshot = active.registry.readOnlySnapshot();
    const conversation = snapshot.conversations[active.conversationId]!;
    const source = conversation.generations.at(-1)!;
    const successorId = "successor-generation-for-retry";
    const successorPath = path.join(path.dirname(active.transcriptPath), "successor.jsonl");
    const raw = JSON.parse(fs.readFileSync(active.registryPath, "utf8")) as typeof snapshot;
    const storedConversation = raw.conversations[active.conversationId]!;
    storedConversation.generations.at(-1)!.archivedAt = new Date().toISOString();
    storedConversation.generations.push({
      id: successorId, path: successorPath, accountId: source.accountId,
      launchProfile: source.launchProfile, historyHash: null, host: null,
      createdAt: new Date().toISOString(), archivedAt: null,
    });
    fs.writeFileSync(active.registryPath, JSON.stringify(raw));

    const reopened = new AgentRegistry(active.registryPath);
    const retryId = "op_retry_successor";
    expect(reopened.recordDeliveryRetryAttempt(original.operationId, retryId)).toBeTrue();
    expect(reopened.readOnlySnapshot().deliveryOperationOwners[retryId]?.targetGenerationId).toBe(successorId);
    const wire = await encodeCodexStructuredUserText("recover into successor", undefined, null,
      { kind: "operator" }, deliveryDedupToken(retryId));
    fs.writeFileSync(successorPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: wire } }) + "\n");
    expect(await resolveSendReceipt(retryId, { registry: reopened, client: null }))
      .toMatchObject({ operationId: retryId, state: "delivered", resend: "not-needed" });
  } finally { active.close(); }
});

function canonicalClaudeUser(uuid: string, text: string, timestamp: string): string {
  return JSON.stringify({ type: "user", uuid, timestamp, message: { role: "user", content: text } }) + "\n";
}

test("Claude canonical evidence accepts transcoded image bytes and leaves a different image message uncertain", async () => {
  setSystemTime(Date.parse("2026-10-29T10:22:11Z"));
  const active = fixture("claude-transcoded-image", { engine: "claude" });
  try {
    const image = { sha256: "a".repeat(64), mime: "image/png" as const, bytes: 12 };
    const content = structuredContent("describe this image", [image]);
    const unrelated = structuredContent("another image", [image]);
    const accepted = active.registry.holdDelivery(active.conversationId, content.content.text, "image-key", "runtime-images", content.content.images, content.contentDigest,
      { operationId: "op_claude_image", kind: "send", policy: "queue" });
    active.registry.beginDeliveryAttempt(accepted.id, active.generationId);
    const other = active.registry.holdDelivery(active.conversationId, unrelated.content.text, "other-image-key", "runtime-images", unrelated.content.images, unrelated.contentDigest,
      { operationId: "op_claude_other_image", kind: "send", policy: "queue" });
    active.registry.beginDeliveryAttempt(other.id, active.generationId);
    const ledger = new FileClaudeDeliveryLedger();
    ledger.recordQueued(active.generationId, { id: "op_claude_image", ...content }, "turn-started");
    ledger.recordQueued(active.generationId, { id: "op_claude_other_image", ...unrelated }, "turn-started");
    for (const item of [accepted, other]) {
      active.journal.executeOperation({ kind: "send", operationId: item.command.operationId, conversationId: active.conversationId,
        idempotencyKey: item.clientMessageId!, text: item.text, policy: "queue" });
      active.journal.transitionOperation(item.command.operationId, "delivering");
      active.journal.transitionOperation(item.command.operationId, "uncertain");
      active.registry.recordDeliveryOutcome(item.id, "failed", SEND_UNVERIFIED_REASON, "unverified");
    }
    const canonicalImage = structuredContent("describe this image", [{ sha256: "b".repeat(64), mime: "image/jpeg", bytes: 25 }]);
    fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "user", uuid: "transcoded-image-user", timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: canonicalImage.content.text }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.alloc(25, 7).toString("base64") } }] } }) + "\n");
    // The same input can be journaled mid-turn before the ordinary user
    // record, with image bytes transcoded between the two representations.
    const canonicalRecord = fs.readFileSync(active.transcriptPath, "utf8");
    fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "attachment", timestamp: new Date().toISOString(),
      attachment: { type: "queued_command", commandMode: "prompt", source_uuid: "transcoded-image-user",
        "prompt": [{ type: "text", text: canonicalImage.content.text }, { type: "image", source: {
          type: "base64", media_type: "image/png", data: Buffer.alloc(12, 7).toString("base64"),
        } }],
      },
    }) + "\n" + canonicalRecord);
    const reopened = new AgentRegistry(active.registryPath);
    expect(await resolveSendReceipt("op_claude_image", { registry: reopened, client: null }))
      .toMatchObject({ state: "delivered", resend: "not-needed" });
    expect(await resolveSendReceipt("op_claude_other_image", { registry: reopened, client: null }))
      .toMatchObject({ state: "failed", resend: "verify-first" });
  } finally { active.close(); setSystemTime(); }
});

test("an explicit status recovery with late canonical delivery never rearms the operation", async () => {
  const active = fixture("late-confirmation-retry", { engine: "claude" });
  try {
    const text = "check the release";
    const { operationId, deliveryId } = acceptSend(active, { text });
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "uncertain");
    active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
    const ledger = new FileClaudeDeliveryLedger();
    ledger.recordQueued(active.generationId, { id: operationId, text }, "turn-started");
    ledger.confirmDelivered(active.generationId, operationId, "echo-user");
    const response = await handleRuntimeRetry(new NextRequest("http://127.0.0.1/api/runtime/operations/check/retry", {
      method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ action: "retry-uncertain" }),
    }), operationId, { enabled: () => true, client: () => active.client, registry: () => active.registry, kick: async () => {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ receipt: { status: "delivered", resend: "not-needed" } });
    expect(active.journal.effectBatch(100)).toEqual([]);
    // Canonical acknowledgement now arbitrates in the journal before its
    // projection, so both durable records agree without rearming any effect.
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("delivered");
  } finally { active.close(); }
});

test("late canonical delivery remains observable after seat rotation", async () => {
  const active = fixture("late-confirmation-after-rotation", { engine: "claude" });
  try {
    const text = "check the release";
    const { operationId, deliveryId } = acceptSend(active, { text });
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "uncertain");
    active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
    const ledger = new FileClaudeDeliveryLedger();
    ledger.recordQueued(active.generationId, { id: operationId, text }, "turn-started");
    ledger.confirmDelivered(active.generationId, operationId, "echo-user");

    const { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } = await import("@/lib/orchestrator/seats");
    const project = "late-confirmation-seat";
    const successorPath = path.join(path.dirname(active.transcriptPath), "successor.jsonl");
    const successor = active.registry.ensureConversation("claude", successorPath, null);
    const designate = (conversationId: string, transcriptPath: string, clientRequestId: string) => {
      beginOrchestratorSeatIntent({ project, mandate: "coordinate work", clientRequestId, mode: "existing" });
      completeOrchestratorSeatIntent({ project, clientRequestId, conversationId, path: transcriptPath });
    };
    designate(active.conversationId, active.transcriptPath, "late-confirmation-seat-before");
    designate(successor.id, successor.generations.at(-1)!.path, "late-confirmation-seat-after");

    const response = await handleRuntimeRetry(new NextRequest("http://127.0.0.1/api/runtime/operations/check/retry", {
      method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ action: "retry-uncertain" }),
    }), operationId, { enabled: () => true, client: () => active.client, registry: () => active.registry, kick: async () => {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ receipt: { status: "delivered", resend: "not-needed" } });
    expect(active.journal.effectBatch(100)).toEqual([]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("delivered");
    expect(Object.keys(active.registry.readOnlySnapshot().deliveryOperationOwners)).toEqual([operationId]);
  } finally { active.close(); }
});

test("a late canonical acknowledgement corrects the progress record that ended uncertain, kept across reopen, and sends nothing", async () => {
  /* Review of incident 2026-10-06: the receipt read corrected the delivery
     record and left the progress record saying `uncertain` beside it, and
     nothing could correct it afterwards. */
  const { DeliveryProgressStore, deliveryProgressPath, readDeliveryProgress, setDeliveryProgressStoreForTests } = await import("./deliveryProgress");
  const active = fixture("late-ack-progress", { engine: "claude", sqlite: true });
  let progress = new DeliveryProgressStore(deliveryProgressPath());
  setDeliveryProgressStoreForTests(progress);
  try {
    const text = "check the release";
    const { operationId, deliveryId } = acceptSend(active, { text, clientMessageId: "late-ack-key" });
    progress.note(operationId, active.conversationId, { waitReason: "dispatching", originalKey: "late-ack-key", attempted: true });
    const ledger = new FileClaudeDeliveryLedger();
    ledger.recordQueued(active.generationId, { id: operationId, text }, "turn-started");
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
    active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
    progress.settle(operationId, "uncertain", SEND_UNVERIFIED_REASON);
    expect(progress.get(operationId)?.terminal?.state).toBe("uncertain");
    const effectsBefore = active.journal.effectBatch(100);
    const queuedBefore = ledger.load(active.generationId).length;

    /* The recipient's own acknowledgement, bound to this operation, arrives late. */
    const uuid = "late-canonical-user-turn";
    ledger.confirmDelivered(active.generationId, operationId, uuid);
    fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "user", uuid, timestamp: new Date().toISOString(), message: { role: "user", content: text } }) + "\n");
    const response = await handleRuntimeOperationQuery(operationId, {
      client: () => active.client,
      rolledBack: () => false,
      settle: (id, client) => resolveSendReceipt(id, { registry: active.registry, client }),
    });
    const body = await response.json() as { receipt: { status: string }; progress?: { terminal: { state: string } | null } };
    expect(body.receipt.status).toBe("delivered");
    expect(body.progress?.terminal?.state).toBe("delivered");

    /* Nothing was rearmed or sent again. */
    expect(active.journal.effectBatch(100)).toEqual(effectsBefore);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("delivered");
    expect(ledger.load(active.generationId)).toHaveLength(queuedBefore);

    progress.close();
    setDeliveryProgressStoreForTests(null);
    expect(readDeliveryProgress([operationId]).get(operationId)?.terminal?.state).toBe("delivered");
    progress = new DeliveryProgressStore(deliveryProgressPath());
    expect(progress.get(operationId)).toMatchObject({ originalKey: "late-ack-key", terminal: { state: "delivered" } });
    /* An acknowledgement another process read reaches the record through
       the sweep, which reads the delivery record only. */
    const later = acceptSend(active, { text: "second check", clientMessageId: "late-ack-elsewhere" });
    progress.note(later.operationId, active.conversationId, { waitReason: "dispatching", originalKey: "late-ack-elsewhere" });
    progress.settle(later.operationId, "uncertain", SEND_UNVERIFIED_REASON);
    active.registry.recordDeliveryOutcome(later.deliveryId, "delivered");
    mirrorSettledReceipts(active.registry, progress);
    expect(progress.get(later.operationId)?.terminal?.state).toBe("delivered");
    /* A proven ending is never promoted. */
    progress.note("operation-lost", active.conversationId, { waitReason: "queued" });
    progress.settle("operation-lost", "failed", SEND_LOST_REASON);
    progress.settle("operation-lost", "delivered", null);
    expect(progress.get("operation-lost")?.terminal?.state).toBe("failed");
  } finally {
    setDeliveryProgressStoreForTests(null);
    progress.close();
    active.close();
  }
});

test("retained cold uncertain sends still mirror late delivered receipts", async () => {
  const { Database } = await import("bun:sqlite");
  const { DeliveryProgressStore, DELIVERY_PHASE_HISTORY_LIMIT, readDeliveryProgress } = await import("./deliveryProgress");
  const { restoreMissingRecords } = await import("./recordWait");
  let clock = Date.now();
  const active = fixture("cold-late-ack", { now: () => clock, sqlite: true });
  const filename = path.join(path.dirname(active.registryPath), "delivery-progress.sqlite");
  const noTimer = () => 0 as unknown as ReturnType<typeof setTimeout>;
  let progress = new DeliveryProgressStore(filename, () => clock, noTimer);
  try {
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "cold-late-ack-key" });
    progress.note(operationId, active.conversationId, { waitReason: "dispatching", originalKey: "cold-late-ack-key",
      admittedAt: new Date(clock).toISOString(), executorId: "original-executor" });
    progress.timing(operationId, { ingressAt: new Date(clock - 100).toISOString() });
    for (let i = 0; i < DELIVERY_PHASE_HISTORY_LIMIT; i++) {
      clock++;
      progress.note(operationId, active.conversationId, { waitReason: "dispatching", detail: "waiting for acknowledgement", attempted: true });
    }
    progress.timing(operationId, { engineEchoAt: new Date(clock).toISOString() });
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
    active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
    progress.settle(operationId, "uncertain", SEND_UNVERIFIED_REASON);
    const before = structuredClone(progress.get(operationId))!;
    expect(progress.flush()).toBe(true);

    clock += 1_000;
    const db = new Database(filename);
    try {
      const insert = db.query("INSERT INTO delivery_progress VALUES (?, ?, ?, ?, ?, ?)");
      db.transaction(() => {
        for (let i = 0; i < 10_001; i++) {
          const id = `newer-delivered-${i}`;
          const record = { ...before, operationId: id, phaseHistory: [], ingressAt: null, engineEchoAt: null,
            updatedAt: new Date(clock).toISOString(),
            terminal: { state: "delivered", at: new Date(clock).toISOString(), reason: null } };
          insert.run(id, record.conversationId, null, 1, clock, JSON.stringify(record));
        }
      })();
    } finally { db.close(); }
    clock += 10 * 60_000;
    progress.checkpoint(clock);
    expect(progress.flush()).toBe(true);
    progress.close();
    progress = new DeliveryProgressStore(filename, () => clock, noTimer);
    expect(progress.open()).toEqual([]); // Fill the bounded startup cache before reconciliation.

    const effectsBefore = active.journal.effectBatch(100);
    const otherProcess = new AgentRegistry(active.registryPath, undefined, undefined,
      { now: () => clock, sqliteMode: "sqlite", sqliteFilename: path.join(path.dirname(active.registryPath), "agent-registry.sqlite") });
    otherProcess.recordDeliveryOutcome(deliveryId, "delivered");
    expect(receiptOf(active, operationId)?.state).toBe("delivered");
    expect(restoreMissingRecords(active.registry, progress, clock)).toBe(true);
    mirrorSettledReceipts(active.registry, progress, clock);
    expect(progress.flush()).toBe(true);
    const record = readDeliveryProgress([operationId], filename).get(operationId)!;
    expect(record.terminal?.state).toBe("delivered");
    expect(record).toEqual({ ...before, nextWakeAt: null, stalledSince: null,
      lastProgressAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString(),
      terminal: { state: "delivered", at: new Date(clock).toISOString(), reason: null },
      phaseHistory: [...before.phaseHistory!.slice(1), { phase: "delivered", reason: null, at: new Date(clock).toISOString() }],
      phaseHistoryDropped: before.phaseHistoryDropped! + 1 });
    expect(record.phaseHistory).toHaveLength(DELIVERY_PHASE_HISTORY_LIMIT);
    const report = spawnSync(process.execPath, ["scripts/delivery-phase-report.ts",
      "--since", new Date(Date.parse(before.ingressAt!) - 1).toISOString(),
      "--until", new Date(clock + 1).toISOString()], {
      cwd: process.cwd(), env: { ...process.env, LLV_STATE_DIR: path.dirname(filename), LLV_STATE_OWNER: "" },
      encoding: "utf8", timeout: 10_000,
    });
    expect(report.status).toBe(0);
    const echoToConfirmation = (clock - Date.parse(before.engineEchoAt!)).toFixed(1);
    expect(report.stdout).toContain(`total:echo-to-confirmation\t-\t1\t${echoToConfirmation}\t${echoToConfirmation}`);
    expect(active.journal.effectBatch(100)).toEqual(effectsBefore);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("uncertain");
    // A second sweep must neither repeat the terminal phase nor schedule a send.
    mirrorSettledReceipts(active.registry, progress, clock);
    expect(progress.flush()).toBe(true);
    expect(readDeliveryProgress([operationId], filename).get(operationId)).toEqual(record);
    expect(active.journal.effectBatch(100)).toEqual(effectsBefore);
  } finally {
    progress.close();
    active.close();
  }
});

test("a compacted unknown Claude attempt retains its late delivered settlement", async () => {
  let clock = Date.now();
  const active = fixture("compacted-late-claude", { engine: "claude", now: () => clock });
  try {
    const { operationId, deliveryId } = acceptSend(active, { text: "check the release" });
    const ledger = new FileClaudeDeliveryLedger();
    ledger.recordQueued(active.generationId, { id: operationId, text: "check the release" }, "turn-started");
    active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
    clock += 8 * 24 * 60 * 60 * 1000;
    const later = acceptSend(active, { clientMessageId: "later-key", operationId: "later-operation" });
    active.registry.recordDeliveryOutcome(later.deliveryId, "delivered", null, "delivered");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]).toBeUndefined();
    ledger.confirmDelivered(active.generationId, operationId, "late-echo");
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: null }))
      .toMatchObject({ state: "delivered", resend: "not-needed" });
    expect(sendReceiptFor(new AgentRegistry(active.registryPath).readOnlySnapshot(), operationId)?.state).toBe("delivered");
  } finally { active.close(); }
});

test("a compacted Codex attempt settles from its canonical turn after registry reopen", async () => {
  let clock = Date.now();
  const active = fixture("compacted-late-codex", { now: () => clock });
  try {
    const text = "check the archived turn";
    const { operationId, deliveryId } = acceptSend(active, { text, operationId: "op_compacted_codex" });
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
    active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
    const wire = await encodeCodexStructuredUserText(text, undefined, null, { kind: "operator" }, deliveryDedupToken(operationId));
    fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: wire } }) + "\n");
    clock += 8 * 24 * 60 * 60 * 1000;
    const later = acceptSend(active, { clientMessageId: "codex-retention-trigger", operationId: "op_codex_retention_trigger" });
    active.registry.recordDeliveryOutcome(later.deliveryId, "delivered", null, "delivered");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]).toBeUndefined();
    const reopened = new AgentRegistry(active.registryPath);
    expect(reopened.readOnlySnapshot().deliveryOperationOwners[operationId])
      .toMatchObject({ targetGenerationId: active.generationId, evidenceText: text });
    expect(await resolveSendReceipt(operationId, { registry: reopened, client: null }))
      .toMatchObject({ state: "delivered", resend: "not-needed", duplicateRisk: false });
  } finally { active.close(); }
});

test("a compacted Claude attempt settles from its archived generation after succession and reopen", async () => {
  let clock = Date.now();
  const active = fixture("compacted-migrated-claude", { engine: "claude", now: () => clock });
  try {
    const text = "check the archived Claude generation";
    const { operationId, deliveryId } = acceptSend(active, { text, operationId: "op_compacted_migrated_claude" });
    const ledger = new FileClaudeDeliveryLedger();
    ledger.recordQueued(active.generationId, { id: operationId, text }, "turn-started");
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
    active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");

    const requested = active.registry.requestConversationReseat(active.conversationId, "healthy");
    const revision = requested.migration!.revision;
    active.registry.transitionConversationMigration(active.conversationId, revision, ["requested"], { phase: "preparing" });
    const starting = active.registry.transitionConversationMigration(active.conversationId, revision, ["preparing"], { phase: "successor-starting" });
    const successorId = "claude-successor-generation";
    const successorPath = path.join(path.dirname(active.transcriptPath), "claude-successor.jsonl");
    const receipt = {
      operationId: starting.migration!.operationId,
      nativeId: successorId,
      path: successorPath,
      continuityPaths: [successorPath],
      historyHash: "claude-successor-history",
      host: { kind: "claude-stream" as const, identity: successorId, epoch: 1, verifiedAt: new Date().toISOString() },
    };
    active.registry.persistMigrationProviderReceipt(active.conversationId, revision, receipt.operationId, receipt);
    active.registry.commitSuccessor(active.conversationId, {
      id: successorId, path: successorPath, accountId: "healthy", historyHash: receipt.historyHash, host: receipt.host,
    }, revision, receipt.operationId, receipt);

    clock += 8 * 24 * 60 * 60 * 1000;
    const later = active.registry.holdDelivery(active.conversationId, "retention trigger", "claude-retention-trigger");
    active.registry.recordDeliveryOutcome(later.id, "delivered", null, "delivered");
    expect(active.registry.readOnlySnapshot().heldDeliveries[deliveryId]).toBeUndefined();
    const reopened = new AgentRegistry(active.registryPath);
    expect(reopened.readOnlySnapshot().deliveryOperationOwners[operationId])
      .toMatchObject({ targetGenerationId: active.generationId, evidenceText: text });
    ledger.confirmDelivered(active.generationId, operationId, "archived-generation-echo");
    expect(await resolveSendReceipt(operationId, { registry: reopened, client: null }))
      .toMatchObject({ state: "delivered", resend: "not-needed", duplicateRisk: false });
  } finally { active.close(); }
});

test("late recipient evidence preserves an explicit discard", async () => {
  const active = fixture("discarded-late-claude", { engine: "claude" });
  try {
    const { operationId, deliveryId } = acceptSend(active, { text: "check the release" });
    const ledger = new FileClaudeDeliveryLedger();
    ledger.recordQueued(active.generationId, { id: operationId, text: "check the release" }, "turn-started");
    ledger.confirmDelivered(active.generationId, operationId, "late-echo");
    active.registry.recordDeliveryOutcome(deliveryId, "failed", "delivery-discarded", "unverified");
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: null }))
      .toMatchObject({ state: "failed", reason: "delivery-discarded" });
  } finally { active.close(); }
});


for (const reader of ["receipt", "projection", "startup", "original-key", "retry"] as const) test(`seat inbox restart: ${reader} confirms every original member with no resend`, async () => {
  const active = fixture(`inbox-reader-${reader}`, { engine: "claude" });
  try {
    const { fixtureInboxBatch } = await import("./fixtures/inboxBatch");
    const members = ["a", "b", "c"].map(id => ({ id: `inbox-${id}`, text: id === "c" ? "distinct" : "identical" }));
    for (const m of members) { acceptSend(active, { operationId: m.id, clientMessageId: m.id, text: m.text }); active.journal.transitionOperation(m.id, "delivering"); }
    const batch = fixtureInboxBatch(members);
    // A separate process owns the batch write and exits before member settlement.
    const child = spawnSync(process.execPath, ["--eval", `
      const { AgentRegistry } = await import(${JSON.stringify(new URL("../agent/registry.ts", import.meta.url).href)});
      const { FileClaudeDeliveryLedger } = await import(${JSON.stringify(new URL("./claudeStreamBrokerHost.ts", import.meta.url).href)});
      const registry = new AgentRegistry(${JSON.stringify(active.registryPath)});
      const batch = ${JSON.stringify(batch)};
      if (registry.bindDeliveryBatchOffLoop) await registry.bindDeliveryBatchOffLoop(batch.id, batch.parts.map(p => p.operationId), ${JSON.stringify(active.generationId)});
      const ledger = new FileClaudeDeliveryLedger();
      ledger.recordQueued(${JSON.stringify(active.generationId)}, batch, "turn-started");
      ledger.confirmDelivered(${JSON.stringify(active.generationId)}, batch.id, "inbox-canonical-echo");
      process.kill(process.pid, "SIGKILL");
    `], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 10000 });
    expect(child.signal, child.stderr).toBe("SIGKILL");
    const freshReader = spawnSync(process.execPath, ["--eval", `
      const { AgentRegistry } = await import(${JSON.stringify(new URL("../agent/registry.ts", import.meta.url).href)});
      const { confirmedSend } = await import(${JSON.stringify(new URL("./confirmedSend.ts", import.meta.url).href)});
      const registry = new AgentRegistry(${JSON.stringify(active.registryPath)});
      const answers = [];
      for (const id of ${JSON.stringify(members.map(m => m.id))}) answers.push(await confirmedSend(registry.readOnlySnapshot(), id, false));
      process.stdout.write(JSON.stringify(answers));
    `], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 10000 });
    expect(freshReader.status, freshReader.stderr).toBe(0);
    expect(JSON.parse(freshReader.stdout)).toEqual([true, true, true]);
    const reopened = new AgentRegistry(active.registryPath);
    const ledger = new FileClaudeDeliveryLedger();
    const before = JSON.stringify(ledger.load(active.generationId));
    const { confirmedSend } = await import("./confirmedSend");
    for (const m of members) expect(await confirmedSend(reopened.readOnlySnapshot(), m.id)).toBe(true);
    if (reader === "startup") {
      const { bindStructuredDeliveryQueue } = await import("./structuredDeliveryController");
      await bindStructuredDeliveryQueue([], { registry: reopened, client: active.client });
    }
    for (const m of members) {
      if (reader === "projection" || reader === "original-key") {
        const { resolveOriginalSend } = await import("./sendSettlement");
        expect(await resolveOriginalSend({ conversationId: active.conversationId, clientMessageId: m.id }, { registry: reopened, client: active.client }))
          .toMatchObject({ kind: "found", current: { readable: true, value: { state: "delivered", resend: "not-needed", turnId: batch.id } } });
      } else if (reader === "retry") {
        setAgentRegistryForTests(reopened);
        const response = await handleRuntimeRetry(new NextRequest(`http://127.0.0.1/api/runtime/operations/${m.id}`, {
          method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" },
        }), m.id, { enabled: () => true, client: () => active.client,
          recover: async () => { throw new Error("a delivered batch member must not recover a host"); },
          kick: () => { throw new Error("a delivered batch member must not resend"); } });
        expect(await response.json()).toMatchObject({ send: { state: "delivered", resend: "not-needed", turnId: batch.id } });
      } else if (reader === "receipt") {
        setAgentRegistryForTests(reopened);
        const { viewerMcpBindings } = await import("../mcp/bindings");
        expect(await viewerMcpBindings().message_receipt({ operationId: m.id }))
          .toMatchObject({ state: "delivered", resend: "not-needed", turnId: batch.id });
      } else expect(await resolveSendReceipt(m.id, { registry: reopened, client: active.client })).toMatchObject({ state: "delivered", resend: "not-needed", turnId: batch.id });
    }
    expect(JSON.stringify(ledger.load(active.generationId))).toBe(before);
    expect(ledger.load(active.generationId)).toHaveLength(1);
  } finally { active.close(); }
});

for (const corruption of ["missing-binding", "missing-parts", "omitted-member", "part-digest", "batch-id", "no-echo", "codex"] as const) test(`seat inbox evidence refuses ${corruption}`, async () => {
  const active = fixture(`inbox-negative-${corruption}`, { engine: corruption === "codex" ? "codex" : "claude" });
  try {
    const { fixtureInboxBatch } = await import("./fixtures/inboxBatch");
    const registry = active.registry as AgentRegistry & { bindDeliveryBatchOffLoop?: (id: string, members: string[], generation: string) => Promise<boolean | null> };
    expect(registry.bindDeliveryBatchOffLoop).toBeFunction();
    const guard = ["guard-a", "guard-b"].map(id => ({ id, text: "positive control" }));
    for (const m of guard) acceptSend(active, { operationId: m.id, clientMessageId: m.id, text: m.text });
    const positive = fixtureInboxBatch(guard);
    await registry.bindDeliveryBatchOffLoop!(positive.id, guard.map(m => m.id), active.generationId);
    const positiveLedger = new FileClaudeDeliveryLedger();
    positiveLedger.recordQueued(active.generationId, positive, "turn-started");
    positiveLedger.confirmDelivered(active.generationId, positive.id, "positive-inbox-echo");
    const { confirmedSend } = await import("./confirmedSend");
    if (corruption !== "codex") expect(await confirmedSend(registry.readOnlySnapshot(), guard[0]!.id)).toBe(true);
    const members = ["a", "b"].map(id => ({ id: `negative-${id}`, text: "identical" }));
    for (const m of members) acceptSend(active, { operationId: m.id, clientMessageId: m.id, text: m.text });
    const batch = fixtureInboxBatch(members);
    if (corruption !== "missing-binding") await registry.bindDeliveryBatchOffLoop?.(batch.id, members.map(m => m.id), active.generationId);
    const ledger = new FileClaudeDeliveryLedger();
    if (corruption === "missing-parts") delete batch.parts;
    if (corruption === "omitted-member") batch.parts!.shift();
    if (corruption === "part-digest") batch.parts![0]!.contentDigest = "f".repeat(64);
    if (corruption === "batch-id") batch.id = "inbox_invalid";
    ledger.recordQueued(active.generationId, batch, "turn-started");
    if (corruption !== "no-echo") ledger.confirmDelivered(active.generationId, batch.id, "negative-echo");
    const evidence = structuredClone(active.registry.readOnlySnapshot());
    // Exercise the reader as well as the writer's Claude-only admission gate.
    if (corruption === "codex") evidence.deliveryOperationOwners[members[0]!.id]!.batchId = batch.id;
    expect(await confirmedSend(evidence, members[0]!.id)).toBe(false);
    if (corruption === "no-echo") for (const m of members) {
      active.journal.transitionOperation(m.id, "delivering");
      active.journal.transitionOperation(m.id, "uncertain", { reason: SEND_UNVERIFIED_REASON });
      expect(await resolveSendReceipt(m.id, { registry: active.registry, client: active.client })).toMatchObject({ state: "failed", resend: "verify-first" });
    }
  } finally { active.close(); }
});


test("seat inbox registry binding is atomic and a subsequent single dispatch clears an unwritten batch", async () => {
  const active = fixture("inbox-registry-atomic", { engine: "claude" });
  try {
    const { fixtureInboxBatch } = await import("./fixtures/inboxBatch");
    const members = ["bind-one", "bind-two"].map(id => ({ id, text: id }));
    for (const m of members) acceptSend(active, { operationId: m.id, clientMessageId: m.id, text: m.text });
    const batch = fixtureInboxBatch(members);
    expect(active.registry.bindDeliveryBatchOffLoop).toBeFunction();
    expect(await active.registry.bindDeliveryBatchOffLoop(batch.id, [members[0]!.id, "missing-owner"], active.generationId)).toBe(false);
    expect(active.registry.readOnlySnapshot().deliveryOperationOwners[members[0]!.id]!.batchId).toBeUndefined();
    expect(await active.registry.bindDeliveryBatchOffLoop(batch.id, members.map(m => m.id), active.generationId)).toBe(true);
    const reopened = new AgentRegistry(active.registryPath);
    expect(members.map(m => reopened.readOnlySnapshot().deliveryOperationOwners[m.id]!.batchId)).toEqual([batch.id, batch.id]);
    expect(await reopened.bindDeliveryOperationGenerationOffLoop(members[0]!.id, active.generationId)).toBe(true);
    expect(new AgentRegistry(active.registryPath).readOnlySnapshot().deliveryOperationOwners[members[0]!.id]!.batchId).toBeUndefined();
  } finally { active.close(); }
});

for (const refuses of [false, true]) test(`settlement sweep prepares selection and uses keyed receipts (refusal=${refuses})`, async () => {
  const active = fixture(`prepared-sweep-${refuses}`, { sqlite: true, now: () => Date.parse("2026-10-22T00:00:00Z") });
  const read = active.registry.readOnlySnapshot.bind(active.registry);
  const prepare = active.registry.prepareReadOnlySnapshot.bind(active.registry);
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "prepared-sweep", operationId: "operation-prepared-sweep" });
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "delivered");
    const file = await prepare();
    let preparations = 0;
    active.registry.prepareReadOnlySnapshot = async () => { preparations++; if (refuses) throw new Error("selection unavailable"); return file; };
    active.registry.readOnlySnapshot = () => { throw new Error("settlement sweep refreshed the whole registry synchronously"); };
    // Acceptance reads the real clock, so the sweep's frozen clock follows it.
    const sweepAt = AFTER_THE_WINDOW();
    const sweep = settleDueSends({ registry: active.registry, client: active.client, now: () => sweepAt, progress: null });
    if (refuses) {
      await expect(sweep).rejects.toThrow("selection unavailable");
      expect(sendReceiptFor(active.registry.deliverySnapshotForOperation(operationId), operationId)?.state).toBe("in-flight");
    } else {
      expect((await sweep).settled).toEqual([{ operationId, state: "delivered", duplicateRisk: false }]);
      mirrorSettledReceipts(active.registry, { open: () => [{ operationId } as import("./deliveryProgress").DeliveryProgressRecord], uncertain: () => [], settle: () => {} });
    }
    expect(preparations).toBe(1);
  } finally {
    active.registry.readOnlySnapshot = read; active.registry.prepareReadOnlySnapshot = prepare;
    active.registry.close(); active.close();
  }
});

for (const expired of [false, true]) test(`progress mirror rechecks its owner and deadline between slices (expired=${expired})`, async () => {
  const active = fixture(`mirror-slices-${expired}`, { sqlite: true });
  const read = active.registry.readOnlySnapshot.bind(active.registry);
  let turn: ReturnType<typeof setImmediate> | undefined;
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "mirror-slices", operationId: "operation-mirror-slices" });
    active.journal.transitionOperation(operationId, "delivering"); active.journal.transitionOperation(operationId, "delivered");
    await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, progress: null });
    active.registry.readOnlySnapshot = () => { throw new Error("progress mirror rebuilt history"); };
    let owned = true, settled = 0;
    const progress = { open: () => Array.from({ length: 33 }, () => ({ operationId } as import("./deliveryProgress").DeliveryProgressRecord)),
      uncertain: () => [], settle: () => { settled++; if (settled === 1) turn = setImmediate(() => { owned = false; }); } };
    await expect(mirrorSettledReceiptsAsync(active.registry, progress, Date.parse("2026-10-22T00:00:00Z"), () => {
      if (!owned) throw new Error("owner retired");
    }, expired ? 0 : performance.now() + 30_000)).rejects.toThrow(expired ? "deadline exceeded" : "owner retired");
    expect(expired ? settled === 0 : settled > 0 && settled <= 16).toBe(true);
  } finally {
    if (turn) clearImmediate(turn);
    active.registry.readOnlySnapshot = read; active.registry.close(); active.close();
  }
});

test("concurrent asynchronous sweep selections claim a conversation only at dispatch", async () => {
  const active = fixture("parallel-sweep-selection", { sqlite: true, now: () => Date.parse("2026-10-22T00:00:00Z") });
  const prepare = active.registry.prepareReadOnlySnapshot.bind(active.registry);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  let ready!: () => void;
  const selecting = new Promise<void>(resolve => { ready = resolve; });
  const releases: Array<() => void> = [];
  const sweeps: Array<ReturnType<typeof settleDueSends>> = [];
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "parallel-sweep", operationId: "operation-parallel-sweep" });
    const second = acceptSend(active, { clientMessageId: "parallel-sweep-second", operationId: "operation-parallel-sweep-second" });
    for (const id of [operationId, second.operationId]) {
      active.journal.transitionOperation(id, "delivering"); active.journal.transitionOperation(id, "delivered");
    }
    const file = await prepare();
    active.registry.prepareReadOnlySnapshot = async () => new Promise(resolve => {
      releases.push(() => resolve(file)); if (releases.length === 2) ready();
    });
    let statusReads = 0;
    const client = { ...active.client, operationStatus: async (...args: Parameters<RuntimeHostClient["operationStatus"]>) => {
      statusReads++; entered(); await held; return active.client.operationStatus(...args);
    } };
    const running = new Set<string>();
    const sweepAt = AFTER_THE_WINDOW();
    sweeps.push(settleDueSends({ registry: active.registry, client, running, progress: null, now: () => sweepAt }));
    sweeps.push(settleDueSends({ registry: active.registry, client, running, progress: null, now: () => sweepAt }));
    await selecting; for (const resume of releases) resume();
    await reading; await new Promise<void>(resolve => setImmediate(resolve));
    expect(statusReads).toBe(1);
    release();
    expect((await Promise.all(sweeps)).flatMap(result => result.settled)).toEqual([
      { operationId, state: "delivered", duplicateRisk: false },
      { operationId: second.operationId, state: "delivered", duplicateRisk: false },
    ]);
    expect(running.size).toBe(0);
  } finally {
    release(); for (const resume of releases) resume(); await Promise.allSettled(sweeps);
    active.registry.prepareReadOnlySnapshot = prepare; active.registry.close(); active.close();
  }
});

for (const when of ["preparation", "selection"] as const) test(`a settlement selection whose controller retires during ${when} writes no later deadlines or receipts`, async () => {
  const active = fixture("retired-sweep-selection", { sqlite: true, now: () => Date.parse("2026-10-22T00:00:00Z") });
  const prepare = active.registry.prepareReadOnlySnapshot.bind(active.registry);
  let owned = true, deadlines = 0, reads = 0;
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "retired-sweep", operationId: "operation-retired-sweep" });
    acceptSend(active, { clientMessageId: "retired-sweep-second", operationId: "operation-retired-sweep-second" });
    const file = await prepare();
    active.registry.prepareReadOnlySnapshot = async () => { if (when === "preparation") owned = false; return file; };
    const client = { ...active.client, operationStatus: async () => { reads++; return null; } };
    const sweepAt = AFTER_THE_WINDOW();
    await expect(settleDueSends({ registry: active.registry, client, progress: null,
      now: () => sweepAt, onDeadline: () => { deadlines++; queueMicrotask(() => { owned = false; }); },
      assertActive: () => { if (!owned) throw new Error("settlement owner retired"); },
    })).rejects.toThrow("settlement owner retired");
    expect(deadlines).toBe(when === "preparation" ? 0 : 1); expect(reads).toBe(0);
    expect(sendReceiptFor(active.registry.deliverySnapshotForOperation(operationId), operationId)?.state).toBe("in-flight");
  } finally { active.registry.prepareReadOnlySnapshot = prepare; active.registry.close(); active.close(); }
});


for (const engine of ["claude", "codex"] as const) {
  for (const observed of [true, false]) {
    test(`${engine} mid-turn receipt ${observed ? "settles delivered once and retry sends nothing" : "stays undelivered without recipient evidence"}`, async () => {
      const now = Date.parse("2026-10-29T10:22:11Z");
      setSystemTime(now);
      const active = fixture(`mid-turn-${engine}-${observed}`, { engine, now: () => now, sqlite: true });
      const { DeliveryProgressStore } = await import("./deliveryProgress");
      const progress = new DeliveryProgressStore(path.join(path.dirname(active.registryPath), "progress.sqlite"), () => now);
      const ledger = new FileClaudeDeliveryLedger();
      try {
        const text = "accept the complete album";
        const key = `mid-turn-${engine}-${observed}`;
        const { operationId, deliveryId } = acceptSend(active, { text, clientMessageId: key });
        if (engine === "claude") ledger.recordQueued(active.generationId, { id: operationId, ...structuredContent(text, []) }, "queued-next-turn");
        active.journal.transitionOperation(operationId, "delivering");
        active.journal.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
        active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
        progress.note(operationId, active.conversationId, { originalKey: key, waitReason: "dispatching", attempted: true });
        progress.settle(operationId, "uncertain", SEND_UNVERIFIED_REASON);
        // Delivery's 30-second answer was lost; the running turn sees it later.
        const timestamp = new Date(now + 55_000).toISOString();
        if (observed) {
          const record = engine === "claude"
            ? { type: "attachment", uuid: "attachment-envelope", timestamp, attachment: {
                type: "queued_command", commandMode: "prompt", source_uuid: "mid-turn-source",
                "prompt": [{ type: "text", text }],
              } }
            : { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text",
                text: await encodeCodexStructuredUserText(text, undefined, null, { kind: "operator" }, deliveryDedupToken(operationId)),
              }] } };
          fs.writeFileSync(active.transcriptPath, JSON.stringify(record) + "\n");
          // Claude's late stream echo has an inferred UUID, as in the incident;
          // it still needs the recipient transcript to validate that binding.
          if (engine === "claude") expect(ledger.confirmDelivered(active.generationId, operationId, "mid-turn-source", "inferred")).toBe("accepted");
        }
        // Reopen the durable projection, as a new Viewer/MCP process does.
        const reopened = new AgentRegistry(active.registryPath, undefined, undefined, {
          sqliteMode: "sqlite", sqliteFilename: path.join(path.dirname(active.registryPath), "agent-registry.sqlite"), now: () => now,
        });
        try {
          let kicks = 0;
          const retry = () => handleRuntimeRetry(new NextRequest("http://127.0.0.1/api/runtime/operations/check/retry", {
            method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ action: "retry-uncertain" }),
          }), operationId, { enabled: () => true, client: () => active.client, registry: () => reopened, kick: async () => { kicks++; } });
          if (observed) {
            // Retry itself must discover receipt before it can dispatch again.
            const response = await retry();
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ receipt: { status: "delivered", resend: "not-needed" } });
          }
          const receipt = await resolveSendReceipt(operationId, { registry: reopened, client: active.client, progress });
          expect(receipt).toMatchObject({ state: observed ? "delivered" : "failed", resend: observed ? "not-needed" : "verify-first" });
          expect(progress.get(operationId)?.terminal?.state).toBe(observed ? "delivered" : "uncertain");
          expect(active.journal.operationResult(operationId)?.receipt.status).toBe(observed ? "delivered" : "uncertain");
          if (observed) {
            const before = ledger.load(active.generationId);
            const response = await retry();
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ receipt: { status: "delivered", resend: "not-needed" } });
            expect(kicks).toBe(0);
            expect(active.journal.effectBatch(100)).toEqual([]);
            expect(ledger.load(active.generationId)).toEqual(before);
            if (engine === "claude") expect(before).toMatchObject([{ delivered: true, engineMessageId: "mid-turn-source" }]);
          } else {
            // The same endpoint and observer admit an explicitly requested
            // retry when recipient evidence is still absent.
            const response = await retry();
            expect(response.status).toBe(202);
            expect(await response.json()).toMatchObject({ receipt: { status: "queued" } });
            expect(kicks).toBe(1);
            expect(active.journal.effectBatch(100)).toHaveLength(1);
          }
        } finally { reopened.close(); }
      } finally {
        progress.close();
        active.registry.close();
        active.close();
        setSystemTime();
      }
    });
  }
}


for (const shape of ["prompt-string", "prompt-blocks", "duplicate-user", "replayed-attachment", "task-notice", "missing-source", "rendered-only", "before-queue", "wrong-text"] as const) {
  test(`Claude mid-turn transcript evidence: ${shape}`, async () => {
    const now = Date.parse("2026-10-29T10:22:11Z");
    setSystemTime(now);
    const active = fixture(`attachment-${shape}`, { engine: "claude", now: () => now });
    try {
      const { normalizeQueueEntry } = await import("./engineHost");
      const text = "the queued instruction";
      const { operationId, deliveryId } = acceptSend(active, { text, clientMessageId: shape });
      const entry = normalizeQueueEntry({ id: operationId, ...structuredContent(text, []) });
      const ledger = new FileClaudeDeliveryLedger();
      ledger.recordQueued(active.generationId, entry, "queued-next-turn");
      active.journal.transitionOperation(operationId, "delivering");
      active.journal.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
      active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
      const prompt = shape === "wrong-text" ? "another instruction" : entry.content.text;
      fs.writeFileSync(active.transcriptPath, JSON.stringify({
        type: "attachment", uuid: "envelope-is-not-source", timestamp: new Date(now + (shape === "before-queue" ? -1 : 1)).toISOString(),
        attachment: { type: "queued_command", commandMode: shape === "task-notice" ? "task-notification" : "prompt",
          ...(shape === "missing-source" ? {} : { source_uuid: "recipient-input" }),
          ...(shape === "rendered-only" ? {} : { prompt: shape === "prompt-blocks" ? [{ type: "text", text: prompt }] : prompt }),
        }, rendered: [{ content: [{ type: "text", text: entry.content.text }] }],
      }) + "\n");
      if (shape === "duplicate-user") fs.appendFileSync(active.transcriptPath,
        canonicalClaudeUser("recipient-input", text, new Date(now + 2).toISOString()));
      if (shape === "replayed-attachment") fs.appendFileSync(active.transcriptPath, fs.readFileSync(active.transcriptPath, "utf8"));
      const delivered = ["prompt-string", "prompt-blocks", "duplicate-user", "replayed-attachment"].includes(shape);
      expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client }))
        .toMatchObject({ state: delivered ? "delivered" : "failed", resend: delivered ? "not-needed" : "verify-first" });
      expect(ledger.load(active.generationId)[0]?.delivered).toBe(delivered);
      expect(active.journal.effectBatch(100)).toEqual([]);
    } finally { active.registry.close(); active.close(); setSystemTime(); }
  });
}

test("Claude mid-turn production inbox batch settles each member once", async () => {
  const now = Date.parse("2026-10-29T10:22:11Z");
  setSystemTime(now);
  const active = fixture("mid-turn-batch", { engine: "claude", now: () => now });
  try {
    const { composeBatch } = await import("./inboxBatch");
    const members = ["first", "second"].map((id, eventSeq) => ({
      entry: { id: `batch-${id}`, ...structuredContent("same instruction", []), origin: { kind: "agent" as const, role: "orchestrator" } },
      admittedAt: new Date(now).toISOString(), eventSeq, priority: false,
    }));
    const batch = composeBatch(members).entry;
    for (const { entry } of members) {
      acceptSend(active, { text: entry.content.text, operationId: entry.id, clientMessageId: entry.id });
      active.journal.transitionOperation(entry.id, "delivering");
    }
    expect(await active.registry.bindDeliveryBatchOffLoop(batch.id, members.map(m => m.entry.id), active.generationId)).toBe(true);
    for (const { entry } of members) {
      active.journal.transitionOperation(entry.id, "uncertain", { reason: SEND_UNVERIFIED_REASON });
      const owner = active.registry.deliverySnapshotForOperation(entry.id).deliveryOperationOwners[entry.id]!;
      active.registry.recordDeliveryOutcome(owner.deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
    }
    const ledger = new FileClaudeDeliveryLedger();
    ledger.recordQueued(active.generationId, batch, "queued-next-turn");
    fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "attachment", timestamp: new Date(now + 1).toISOString(),
      attachment: { type: "queued_command", commandMode: "prompt", source_uuid: "batch-recipient", prompt: batch.content!.text },
    }) + "\n");
    for (const { entry } of members) {
      expect(await resolveSendReceipt(entry.id, { registry: active.registry, client: active.client }))
        .toMatchObject({ state: "delivered", resend: "not-needed" });
    }
    const allocation = ledger.load(active.generationId);
    for (const { entry } of members) await resolveSendReceipt(entry.id, { registry: active.registry, client: active.client });
    expect(ledger.load(active.generationId)).toEqual(allocation);
    expect(allocation).toMatchObject([{ delivered: true, engineMessageId: "batch-recipient" }]);
    expect(active.journal.effectBatch(100)).toEqual([]);
  } finally { active.registry.close(); active.close(); setSystemTime(); }
});


for (const sqlite of [false, true]) for (const lostReply of [false, true]) test(`a terminal failed send notifies its admitted sender once; notice acknowledgement lost=${lostReply}; sqlite=${sqlite}`, async () => {
  const active = fixture(`failure-notice-${lostReply}-${sqlite}`, { sqlite });
  try {
    const sender = secondConversation(active, `notice-sender-${lostReply}`);
    const { recordSendFailureNotice, pendingSendFailureNotices, readSendFailureNotice, decodeSendFailureNotice,
      sendFailureSignals, sweepSendFailureNotices } = await import("./sendFailureNotice");
    const { operationId } = acceptSend(active, { clientMessageId: `notice-original-${lostReply}-${sqlite}`,
      origin: { kind: "agent", role: "orchestrator", conversationId: sender.conversationId } });
    const failed = await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    expect(failed).toMatchObject({ state: "failed", resend: "safe" });
    recordSendFailureNotice(active.registry, operationId, "failed", SEND_LOST_REASON);
    const notice = pendingSendFailureNotices().find(row => row.operationId === operationId)!;
    expect(notice.senderConversationId).toBe(sender.conversationId);
    expect(decodeSendFailureNotice(notice)).toEqual(notice);
    expect(sendFailureSignals(sender.conversationId).some(signal => signal.id === `send-failed:${operationId}`)).toBe(true);
    expect(sendFailureSignals(active.conversationId).some(signal => signal.id === `send-failed:${operationId}`)).toBe(false);
    const target = recordingHost(sender.generationId);
    let calls = 0;
    const ports = { registry: active.registry, assertActive: () => {},
      receipt: (id: string) => resolveSendReceipt(id, { registry: active.registry, client: active.client }),
      recipient: () => ({ kind: "deliver" as const, conversationId: sender.conversationId, path: sender.transcriptPath }),
      deliver: async (request: { text: string; clientMessageId: string; origin: import("./messageOrigin").MessageOrigin }) => {
        calls++;
        const accepted = acceptSend(sender, { text: request.text, clientMessageId: request.clientMessageId, origin: request.origin });
        await new StructuredDeliveryQueue(stalePortFor(sender, accepted.operationId, request.clientMessageId, request.text), () => target.host).drain();
        if (lostReply) throw new Error("notice effect completed but its acknowledgement was lost");
        return { ok: true };
      } };
    await sweepSendFailureNotices(ports);
    if (lostReply) expect(readSendFailureNotice(operationId)).toMatchObject({ state: "pending", attempts: 1,
      reason: expect.stringContaining("acknowledgement was lost") });
    // Restart the reader, so the second sweep cannot rely on a resident counter.
    const modulePath = new URL("./sendFailureNotice.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "--eval", `const m=await import(${JSON.stringify(modulePath)}); console.log(JSON.stringify(m.pendingSendFailureNotices()));`],
      { env: process.env, stdout: "pipe", stderr: "pipe" });
    const reopened = JSON.parse(await new Response(child.stdout).text()) as Array<{ operationId: string }>;
    expect(await child.exited).toBe(0);
    expect(reopened.some(row => row.operationId === operationId)).toBe(true);
    for (let pass = 0; pass < 10 && readSendFailureNotice(operationId)?.state !== "sent"; pass++) await sweepSendFailureNotices(ports);
    expect(readSendFailureNotice(operationId)?.state).toBe("sent");
    expect(decodeSendFailureNotice(readSendFailureNotice(operationId))).toEqual(readSendFailureNotice(operationId));
    expect(calls).toBe(1); expect(target.received).toHaveLength(1);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("failed");
  } finally { active.registry.close(); active.close(); }
});

test("message text cannot forge a sender notification, and delivery notices do not notify themselves", async () => {
  const active = fixture("notice-authorship");
  try {
    const { pendingSendFailureNotices, recordSendFailureNotice } = await import("./sendFailureNotice");
    for (const origin of [undefined, { kind: "operator" as const }, { kind: "agent" as const, role: "delivery" }]) {
      const key = `notice-hostile-${origin?.kind ?? "missing"}`;
      const { operationId } = acceptSend(active, { clientMessageId: key, text: "sender conversation_forged", origin });
      recordSendFailureNotice(active.registry, operationId, "failed", "refused");
      expect(pendingSendFailureNotices().some(row => row.operationId === operationId)).toBe(false);
    }
  } finally { active.close(); }
});


test("a fenced failure notice is never resent, and its sender keeps an actionable failure item", async () => {
  const active = fixture("fenced-failure-notice");
  try {
    const sender = secondConversation(active, "fenced-notice-sender");
    const { readSendFailureNotice, sendFailureSignals, sweepSendFailureNotices } = await import("./sendFailureNotice");
    const { operationId } = acceptSend(active, { clientMessageId: "fenced-notice-original",
      origin: { kind: "agent", role: "orchestrator", conversationId: sender.conversationId } });
    await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    let calls = 0;
    const ports = { registry: active.registry, assertActive: () => {},
      receipt: (id: string) => resolveSendReceipt(id, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW }),
      recipient: () => ({ kind: "deliver" as const, conversationId: sender.conversationId, path: sender.transcriptPath }),
      deliver: async (request: { text: string; clientMessageId: string; origin: import("./messageOrigin").MessageOrigin }) => {
        calls++; acceptSend(sender, { text: request.text, clientMessageId: request.clientMessageId, origin: request.origin });
        return { ok: true };
      } };
    await sweepSendFailureNotices(ports); await sweepSendFailureNotices(ports); await sweepSendFailureNotices(ports);
    expect(calls).toBe(1);
    expect(readSendFailureNotice(operationId)?.state).toBe("failed");
    expect(sendFailureSignals(sender.conversationId).some(signal => signal.id === `send-failed:${operationId}`)).toBe(true);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("failed");
  } finally { active.close(); }
});

test("a permanent notice refusal becomes a durable seat alarm with its transport reason", async () => {
  const active = fixture("refused-failure-notice");
  try {
    const sender = secondConversation(active, "refused-notice-sender");
    const seat = secondConversation(active, "refused-notice-seat");
    const { readSendFailureNotice, sendFailureSignals, sweepSendFailureNotices } = await import("./sendFailureNotice");
    const { operationId } = acceptSend(active, { clientMessageId: "refused-notice-original",
      origin: { kind: "agent", role: "worker", conversationId: sender.conversationId } });
    await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    let attempts = 0;
    const ports = { registry: active.registry, assertActive: () => {},
      receipt: (id: string) => resolveSendReceipt(id, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW }),
      recipient: () => ({ kind: "deliver" as const, conversationId: sender.conversationId, path: sender.transcriptPath }),
      fallback: () => ({ kind: "deliver" as const, conversationId: seat.conversationId }),
      deliver: async () => { attempts++; return { ok: false, status: 403, error: "recipient refused admission" }; },
    };
    await sweepSendFailureNotices(ports);
    await sweepSendFailureNotices(ports);
    expect(attempts).toBe(1);
    expect(readSendFailureNotice(operationId)).toMatchObject({ state: "failed", attempts: 1, reason: expect.stringContaining("403") });
    expect(sendFailureSignals(seat.conversationId)).toContainEqual(expect.objectContaining({ id: `send-failed:${operationId}`, label: expect.stringContaining("recipient refused admission") }));
  } finally { active.close(); }
});

test("a later registry projection failure increments and escalates the persisted notice budget", async () => {
  const active = fixture("notice-late-projection-failure", { sqlite: true });
  try {
    const sender = secondConversation(active, "late-projection-sender");
    const seat = secondConversation(active, "late-projection-seat");
    const { readSendFailureNotice, sendFailureSignals, sweepSendFailureNotices } = await import("./sendFailureNotice");
    const { operationId } = acceptSend(active, { clientMessageId: "late-projection-original",
      origin: { kind: "agent", role: "worker", conversationId: sender.conversationId } });
    const receipt = await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    const original = active.journal.operationResult(operationId);
    const snapshot = active.registry.deliverySnapshotForOperation.bind(active.registry);
    let receiptRead = false, deliveries = 0;
    active.registry.deliverySnapshotForOperation = id => {
      if (receiptRead) throw new Error("late projection unavailable");
      return snapshot(id);
    };
    const ports = { registry: active.registry, assertActive: () => {}, receipt: async () => { receiptRead = true; return receipt; },
      recipient: () => { throw new Error("projection failure must stop before recipient lookup"); },
      fallback: () => ({ kind: "deliver" as const, conversationId: seat.conversationId }),
      deliver: async () => { deliveries++; return { ok: true }; } };
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sweepSendFailureNotices(ports);
      expect(readSendFailureNotice(operationId)).toMatchObject({ state: attempt === 3 ? "failed" : "pending", attempts: attempt,
        reason: expect.stringContaining("registry projection unavailable") });
    }
    expect(deliveries).toBe(0);
    expect(sendFailureSignals(sender.conversationId).map(signal => signal.id)).toContain(`send-failed:${operationId}`);
    expect(active.journal.operationResult(operationId)).toEqual(original);
  } finally { active.registry.close(); active.close(); }
});

for (const terminalPath of ["negative acknowledgement", "transport exception", "unavailable recipient"] as const) {
test(`${terminalPath === "unavailable recipient" ? "an unavailable recipient" : `a ${terminalPath}`} survives seat lookup failure and restart without another delivery`, async () => {
  const active = fixture(`notice-seat-restart-${terminalPath.replaceAll(" ", "-")}`, { sqlite: true });
  try {
    const sender = secondConversation(active, "refusal-restart-sender");
    const seat = secondConversation(active, "refusal-restart-seat");
    const { readSendFailureNotice, sendFailureSignals, sweepSendFailureNotices } = await import("./sendFailureNotice");
    const { operationId } = acceptSend(active, { clientMessageId: `seat-restart-original-${terminalPath.replaceAll(" ", "-")}`,
      origin: { kind: "agent", role: "worker", conversationId: sender.conversationId } });
    const receipt = await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    const original = active.journal.operationResult(operationId);
    const noticeKey = readSendFailureNotice(operationId)!.clientMessageId;
    let deliveries = 0;
    const failureReason = terminalPath === "unavailable recipient" ? "Notice recipient unavailable: recipient gone"
      : terminalPath === "transport exception" ? "connection failed before admission" : "permanent refusal";
    const ports = { registry: active.registry, assertActive: () => {}, receipt: async () => receipt,
      recipient: () => terminalPath === "unavailable recipient" ? { kind: "skip" as const, reason: "recipient gone" }
        : { kind: "deliver" as const, conversationId: sender.conversationId, path: sender.transcriptPath },
      fallback: () => { throw new Error("seat discovery temporarily unavailable"); },
      deliver: async (request: { clientMessageId: string }) => {
        if (request.clientMessageId === noticeKey) deliveries++;
        if (terminalPath === "transport exception") throw new Error(failureReason);
        return { ok: false, status: 403, error: failureReason };
      } };
    const firstPasses = terminalPath === "transport exception" ? 3 : 1;
    const expectedAttempts = terminalPath === "unavailable recipient" ? 0 : firstPasses;
    for (let pass = 0; pass < firstPasses; pass++) await sweepSendFailureNotices(ports);
    expect(readSendFailureNotice(operationId)).toMatchObject({ state: "failed", attempts: expectedAttempts,
      fallbackConversationId: null, reason: expect.stringContaining(failureReason) });
    expect(readSendFailureNotice(operationId)?.reason).toContain("project seat lookup unavailable");

    const modulePath = new URL("./sendFailureNotice.ts", import.meta.url).pathname;
    const registryPath = new URL("../agent/registry.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "--eval", `
      const { AgentRegistry } = await import(${JSON.stringify(registryPath)});
      const m = await import(${JSON.stringify(modulePath)});
      const registry = new AgentRegistry(${JSON.stringify(active.registryPath)}, undefined, undefined,
        { sqliteMode: "sqlite", sqliteFilename: ${JSON.stringify(active.registryPath.replace(/\.json$/, ".sqlite"))} });
      try {
        await m.sweepSendFailureNotices({ registry, assertActive: () => {},
          fallback: () => ({ kind: "deliver", conversationId: ${JSON.stringify(seat.conversationId)} }),
          recipient: () => { throw new Error("terminal notice retried recipient lookup"); },
          deliver: async () => { throw new Error("terminal notice was dispatched again"); } });
        console.log(JSON.stringify(m.readSendFailureNotice(${JSON.stringify(operationId)})));
      } finally { registry.close(); }
    `], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ state: "failed", attempts: expectedAttempts, fallbackConversationId: seat.conversationId,
      reason: expect.stringContaining(failureReason) });
    expect(deliveries).toBe(terminalPath === "unavailable recipient" ? 0 : firstPasses);
    expect(sendFailureSignals(seat.conversationId).map(signal => signal.id)).toContain(`send-failed:${operationId}`);
    expect(active.journal.operationResult(operationId)).toEqual(original);
  } finally { active.registry.close(); active.close(); }
});
}

test("an unavailable sender routes its terminal notice alarm to the live project seat", async () => {
  const active = fixture("missing-failure-notice-sender");
  try {
    const sender = secondConversation(active, "missing-notice-sender");
    const seat = secondConversation(active, "missing-notice-seat");
    const { readSendFailureNotice, sendFailureSignals, sweepSendFailureNotices } = await import("./sendFailureNotice");
    const { operationId } = acceptSend(active, { clientMessageId: "missing-notice-original",
      origin: { kind: "agent", role: "worker", conversationId: sender.conversationId } });
    await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    const ports = { registry: active.registry, assertActive: () => {},
      receipt: (id: string) => resolveSendReceipt(id, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW }),
      recipient: () => ({ kind: "skip" as const, reason: "launcher-gone" }),
      fallback: () => ({ kind: "deliver" as const, conversationId: seat.conversationId }),
      deliver: async () => ({ ok: true }),
    };
    await sweepSendFailureNotices(ports);
    expect(readSendFailureNotice(operationId)).toMatchObject({ state: "failed", fallbackConversationId: seat.conversationId });
    expect(sendFailureSignals(seat.conversationId).some(signal => signal.id === `send-failed:${operationId}`)).toBe(true);
  } finally { active.close(); }
});

test("transient negative notice acknowledgements stop after three attempts and leave a seat alarm", async () => {
  const active = fixture("transient-failure-notice");
  try {
    const sender = secondConversation(active, "transient-notice-sender");
    const seat = secondConversation(active, "transient-notice-seat");
    const { readSendFailureNotice, sendFailureSignals, sweepSendFailureNotices } = await import("./sendFailureNotice");
    const { operationId } = acceptSend(active, { clientMessageId: "transient-notice-original",
      origin: { kind: "agent", role: "worker", conversationId: sender.conversationId } });
    await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    let attempts = 0;
    const ports = { registry: active.registry, assertActive: () => {},
      receipt: (id: string) => resolveSendReceipt(id, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW }),
      recipient: () => ({ kind: "deliver" as const, conversationId: sender.conversationId, path: sender.transcriptPath }),
      fallback: () => ({ kind: "deliver" as const, conversationId: seat.conversationId }),
      deliver: async () => { attempts++; return { ok: false, status: 503, error: "temporary transport outage" }; },
    };
    await sweepSendFailureNotices(ports);
    await sweepSendFailureNotices(ports);
    await sweepSendFailureNotices(ports);
    await sweepSendFailureNotices(ports);
    expect(attempts).toBe(3);
    expect(readSendFailureNotice(operationId)).toMatchObject({ state: "failed", attempts: 3 });
    expect(sendFailureSignals(seat.conversationId).some(signal => signal.id === `send-failed:${operationId}`)).toBe(true);
  } finally { active.close(); }
});

test("notice dispatch and seat harvesting advance through 33 retained alarms across a process restart", async () => {
  const active = fixture("failure-notice-pages", { sqlite: true });
  try {
    const sender = secondConversation(active, "failure-notice-page-sender");
    const seat = secondConversation(active, "failure-notice-page-seat");
    const { recordSendFailureNotice, readSendFailureNotice, sendFailureSignals, sweepSendFailureNotices } = await import("./sendFailureNotice");
    const operations: string[] = [];
    for (let index = 0; index < 33; index++) {
      const key = `notice-page-${String(index).padStart(2, "0")}`;
      const { operationId } = acceptSend(active, { clientMessageId: key,
        origin: { kind: "agent", role: "worker", conversationId: sender.conversationId } });
      operations.push(operationId);
      await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
      recordSendFailureNotice(active.registry, operationId, "failed", SEND_LOST_REASON);
    }
    const ports = { registry: active.registry, assertActive: () => {},
      receipt: (id: string) => resolveSendReceipt(id, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW }),
      recipient: () => ({ kind: "skip" as const, reason: "sender-unavailable" }),
      fallback: () => ({ kind: "deliver" as const, conversationId: seat.conversationId }),
      deliver: async () => { throw new Error("missing sender must not dispatch"); },
    };
    for (let pass = 0; pass < 10 && !operations.every(id => readSendFailureNotice(id)?.state === "failed"); pass++) {
      await sweepSendFailureNotices(ports);
    }
    expect(operations.every(id => readSendFailureNotice(id)?.state === "failed")).toBe(true);

    const first = sendFailureSignals(seat.conversationId);
    expect(first).toHaveLength(32);
    const modulePath = new URL("./sendFailureNotice.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "--eval",
      `const m=await import(${JSON.stringify(modulePath)}); console.log(JSON.stringify(m.sendFailureSignals(${JSON.stringify(seat.conversationId)})));`],
    { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [childStdout, childStderr, childExit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(childExit, childStderr).toBe(0);
    const afterRestart = JSON.parse(childStdout) as Array<{ id: string }>;
    expect(afterRestart).toHaveLength(1);
    expect(new Set([...first.map(signal => signal.id), ...afterRestart.map(signal => signal.id)])).toEqual(
      new Set(operations.map(id => `send-failed:${id}`)));
  } finally { active.registry.close(); active.close(); }
});

test.each(["throw", "timeout"] as const)("a notice transport %s persists bounded attempts and raises a seat alarm", async failure => {
  const active = fixture(`failure-notice-${failure}`);
  try {
    const sender = secondConversation(active, `failure-notice-${failure}-sender`);
    const seat = secondConversation(active, `failure-notice-${failure}-seat`);
    const { recordSendFailureNotice, readSendFailureNotice, sendFailureSignals, sweepSendFailureNotices } = await import("./sendFailureNotice");
    const { operationId } = acceptSend(active, { clientMessageId: `failure-notice-${failure}-original`,
      origin: { kind: "agent", role: "worker", conversationId: sender.conversationId } });
    await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    recordSendFailureNotice(active.registry, operationId, "failed", SEND_LOST_REASON);
    let calls = 0;
    const ports = { registry: active.registry, assertActive: () => {}, readMs: 1,
      receipt: (id: string) => resolveSendReceipt(id, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW }),
      recipient: () => ({ kind: "deliver" as const, conversationId: sender.conversationId, path: sender.transcriptPath }),
      fallback: () => ({ kind: "deliver" as const, conversationId: seat.conversationId }),
      deliver: async () => {
        calls++;
        if (failure === "throw") throw new Error("connection refused before admission");
        return new Promise<{ ok: boolean }>(() => {});
      },
    };
    for (let pass = 0; pass < 10 && readSendFailureNotice(operationId)?.state !== "failed"; pass++) {
      await sweepSendFailureNotices(ports);
    }
    expect(calls).toBe(3);
    expect(readSendFailureNotice(operationId)).toMatchObject({ state: "failed", attempts: 3,
      fallbackConversationId: seat.conversationId, reason: expect.stringContaining(failure === "throw" ? "connection refused" : "no answer within 1 ms") });
    expect(sendFailureSignals(seat.conversationId)).toEqual([expect.objectContaining({ id: `send-failed:${operationId}` })]);
  } finally { active.close(); }
});

test("terminal notice history does not consume the bounded dispatch page", async () => {
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(isolated, "terminal-notice-history-state");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  const active = fixture("failure-notice-terminal-history", { sqlite: true });
  try {
    const sender = secondConversation(active, "failure-notice-history-sender");
    const { cancelSendFailureNotice, pendingSendFailureNotices, readSendFailureNotice, recordSendFailureNotice, sweepSendFailureNotices } = await import("./sendFailureNotice");
    for (let index = 0; index < 64; index++) {
      const { operationId } = acceptSend(active, { clientMessageId: `terminal-notice-${String(index).padStart(2, "0")}`,
        origin: { kind: "agent", role: "worker", conversationId: sender.conversationId } });
      recordSendFailureNotice(active.registry, operationId, "failed", SEND_LOST_REASON);
      cancelSendFailureNotice(operationId);
    }
    const { operationId } = acceptSend(active, { clientMessageId: "pending-after-terminal-history",
      origin: { kind: "agent", role: "worker", conversationId: sender.conversationId } });
    await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    recordSendFailureNotice(active.registry, operationId, "failed", SEND_LOST_REASON);
    expect(pendingSendFailureNotices().map(row => row.operationId)).toEqual([operationId]);
    let deliveries = 0;
    let receipts = 0;
    let sweeps = 0;
    const ports = { registry: active.registry, assertActive: () => {},
      receipt: (id: string) => { receipts++; return resolveSendReceipt(id, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW }); },
      recipient: () => ({ kind: "deliver" as const, conversationId: sender.conversationId, path: sender.transcriptPath }),
      deliver: async () => { deliveries++; return { ok: true }; },
    };
    while (sweeps < 3 && deliveries === 0) { sweeps++; await sweepSendFailureNotices(ports); }
    expect({ deliveries, receipts, sweeps, notice: readSendFailureNotice(operationId) }).toMatchObject({ deliveries: 1, receipts: 1 });
    expect(sweeps).toBeLessThanOrEqual(2);
  } finally {
    active.registry.close(); active.close();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  }
});

for (const receiptPoint of ["original", "notice"] as const) for (const failure of ["throw", "timeout"] as const) {
  test(`a ${receiptPoint} notice receipt ${failure} is bounded, persisted, and escalated`, async () => {
    const active = fixture(`failure-notice-receipt-${receiptPoint}-${failure}`);
    try {
      const sender = secondConversation(active, `failure-notice-receipt-${receiptPoint}-${failure}-sender`);
      const seat = secondConversation(active, `failure-notice-receipt-${receiptPoint}-${failure}-seat`);
      const { recordSendFailureNotice, readSendFailureNotice, sendFailureSignals, sweepSendFailureNotices } = await import("./sendFailureNotice");
      const { operationId } = acceptSend(active, { clientMessageId: `receipt-failure-${receiptPoint}-${failure}`,
        origin: { kind: "agent", role: "worker", conversationId: sender.conversationId } });
      await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
      recordSendFailureNotice(active.registry, operationId, "failed", SEND_LOST_REASON);
      let noticeOperationId: string | null = null;
      let failures = 0;
      let deliveries = 0;
      const ports = { registry: active.registry, assertActive: () => {}, readMs: 1,
        receipt: async (id: string) => {
          const isTarget = receiptPoint === "original" ? id === operationId : noticeOperationId !== null && id === noticeOperationId;
          if (isTarget && failures < 3) {
            failures++;
            if (failure === "throw") throw new Error(`receipt ${receiptPoint} unavailable`);
            return new Promise<never>(() => {});
          }
          return resolveSendReceipt(id, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
        },
        recipient: () => ({ kind: "deliver" as const, conversationId: sender.conversationId, path: sender.transcriptPath }),
        fallback: () => ({ kind: "deliver" as const, conversationId: seat.conversationId }),
        deliver: async (request: { text: string; clientMessageId: string; origin: import("./messageOrigin").MessageOrigin }) => {
          deliveries++;
          const accepted = acceptSend(sender, { text: request.text, clientMessageId: request.clientMessageId, origin: request.origin });
          noticeOperationId = accepted.operationId;
          return { ok: true };
        },
      };
      let restartChecked = false;
      for (let pass = 0; pass < 8 && failures < 3; pass++) {
        await sweepSendFailureNotices(ports);
        if (failures > 0 && !restartChecked) {
          const modulePath = new URL("./sendFailureNotice.ts", import.meta.url).pathname;
          const child = Bun.spawn([process.execPath, "--eval",
            `const m=await import(${JSON.stringify(modulePath)}); console.log(JSON.stringify(m.readSendFailureNotice(${JSON.stringify(operationId)})));`],
          { env: process.env, stdout: "pipe", stderr: "pipe" });
          const [childStdout, childStderr, childExit] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
          ]);
          expect(childExit, childStderr).toBe(0);
          expect(JSON.parse(childStdout)).toMatchObject({ state: "pending", attempts: 1 });
          restartChecked = true;
        }
      }
      expect(restartChecked).toBe(true);
      expect(failures).toBe(3);
      expect(readSendFailureNotice(operationId)).toMatchObject({ state: "failed", attempts: 3,
        fallbackConversationId: seat.conversationId,
        reason: expect.stringContaining(failure === "throw" ? `receipt ${receiptPoint} unavailable` : "no answer within 1 ms") });
      expect(deliveries).toBe(receiptPoint === "notice" ? 1 : 0);
      expect(sendFailureSignals(seat.conversationId)).toEqual([expect.objectContaining({ id: `send-failed:${operationId}` })]);
    } finally { active.close(); }
  });
}

test("a retired notice controller cannot deliver after an awaited receipt", async () => {
  const active = fixture("retired-failure-notice");
  try {
    const sender = secondConversation(active, "retired-notice-sender");
    const { sweepSendFailureNotices, readSendFailureNotice } = await import("./sendFailureNotice");
    const { operationId } = acceptSend(active, { clientMessageId: "retired-notice-original",
      origin: { kind: "agent", conversationId: sender.conversationId } });
    const failed = await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    let alive = true, writes = 0, receipts = 0;
    const sweepUntilReceipt = async () => {
      for (let pass = 0; pass < 3; pass++) await sweepSendFailureNotices({ registry: active.registry,
        assertActive: () => { if (!alive) throw new Error("notice controller retired"); },
        receipt: async () => { receipts++; alive = false; return failed; },
        recipient: () => ({ kind: "deliver", conversationId: sender.conversationId, path: sender.transcriptPath }),
        deliver: async () => { writes++; return { ok: true }; },
      });
    };
    await expect(sweepUntilReceipt()).rejects.toThrow("notice controller retired");
    expect(receipts).toBe(1);
    expect(writes).toBe(0); expect(readSendFailureNotice(operationId)?.state).toBe("pending");
  } finally { active.close(); }
});


test("a late canonical echo retires a failed sender notice without resending either operation", async () => {
  const active = fixture("notice-late-echo", { engine: "claude" });
  try {
    const sender = secondConversation(active, "late-echo-sender");
    const { readSendFailureNotice, sendFailureSignals, sweepSendFailureNotices, decodeSendFailureNotice } = await import("./sendFailureNotice");
    const { operationId } = acceptSend(active, { text: "late echo instruction", clientMessageId: "notice-late-echo-key",
      origin: { kind: "agent", conversationId: sender.conversationId } });
    const ledger = new FileClaudeDeliveryLedger();
    ledger.recordQueued(active.generationId, { id: operationId, text: "late echo instruction" }, "turn-started");
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client }))
      .toMatchObject({ state: "failed", duplicateRisk: true });
    let writes = 0;
    const ports = { registry: active.registry, assertActive: () => {},
      receipt: (id: string) => resolveSendReceipt(id, { registry: active.registry, client: active.client }),
      recipient: () => ({ kind: "skip" as const, reason: "launcher-gone" }),
      deliver: async () => { writes++; return { ok: true }; } };
    for (let pass = 0; pass < 10 && readSendFailureNotice(operationId)?.state !== "failed"; pass++) await sweepSendFailureNotices(ports);
    expect(readSendFailureNotice(operationId)?.state).toBe("failed");
    ledger.confirmDelivered(active.generationId, operationId, "canonical-late-echo", "operation-bound");
    active.registry.recordDeliveryOutcomeForOperation(active.conversationId, operationId, "delivered", null, "delivered");
    for (let pass = 0; pass < 10 && readSendFailureNotice(operationId)?.state !== "cancelled"; pass++) await sweepSendFailureNotices(ports);
    const row = readSendFailureNotice(operationId)!;
    expect(row.state).toBe("cancelled"); expect(decodeSendFailureNotice(row)).toEqual(row);
    expect(sendFailureSignals(sender.conversationId).some(signal => signal.id === `send-failed:${operationId}`)).toBe(false);
    expect(writes).toBe(0);
  } finally { active.close(); }
});


test("a temporary notice-store failure preserves the terminal receipt and recovers the same obligation", async () => {
  const active = fixture("notice-store-recovery");
  const previousState = process.env.LLV_STATE_DIR;
  try {
    const sender = secondConversation(active, "notice-store-sender");
    const { readSendFailureNotice } = await import("./sendFailureNotice");
    const { operationId, deliveryId } = acceptSend(active, { clientMessageId: "notice-store-original",
      origin: { kind: "agent", conversationId: sender.conversationId } });
    active.journal.transitionOperation(operationId, "failed", { reason: SEND_LOST_REASON });
    active.registry.recordDeliveryOutcome(deliveryId, "failed", SEND_LOST_REASON, "lost");
    const broken = path.join(path.dirname(active.registryPath), "notice-store-unavailable");
    fs.mkdirSync(path.join(broken, "state.sqlite"), { recursive: true });
    process.env.LLV_STATE_DIR = broken;
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client }))
      .toMatchObject({ state: "failed", reason: SEND_LOST_REASON, resend: "safe" });
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client }))
      .toMatchObject({ state: "failed", resend: "safe" });
    expect(readSendFailureNotice(operationId)).toMatchObject({ operationId, state: "pending", senderConversationId: sender.conversationId });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
    active.close();
  }
});


test("notice key recovery uses the SQLite message index without hydrating conversation history", async () => {
  const active = fixture("notice-keyed-sqlite", { sqlite: true });
  const original = active.registry.readOnlySnapshot;
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "indexed-notice-key" });
    acceptSend(active, { clientMessageId: "unrelated-notice-key" });
    await active.registry.prepareRecoveryIndexes();
    active.registry.readOnlySnapshot = () => { throw new Error("notice recovery hydrated registry history"); };
    const selected = active.registry.deliverySnapshotForMessageKey(active.conversationId, "indexed-notice-key");
    expect(Object.keys(selected.deliveryOperationOwners)).toEqual([operationId]);
    expect(Object.values(selected.heldDeliveries).map(row => row.clientMessageId)).toEqual(["indexed-notice-key"]);
    expect(lookupOriginalSend(selected, { conversationId: active.conversationId, clientMessageId: "indexed-notice-key" }))
      .toMatchObject({ kind: "found", operationId });
    expect(lookupOriginalSend(selected, { conversationId: "conversation_unrelated", clientMessageId: "indexed-notice-key" }))
      .toMatchObject({ kind: "absent" });
  } finally { active.registry.readOnlySnapshot = original; active.close(); }
});

test("a notice controller retired during recovery index preparation sends nothing", async () => {
  const active = fixture("notice-index-owner-retired", { sqlite: true });
  let restorePreparation = () => {};
  try {
    const sender = secondConversation(active, "index-retired-sender");
    const { sweepSendFailureNotices, readSendFailureNotice } = await import("./sendFailureNotice");
    const { operationId } = acceptSend(active, { clientMessageId: "index-retired-original",
      origin: { kind: "agent", conversationId: sender.conversationId } });
    const receipt = await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    let activeOwner = true, writes = 0;
    const prepare = active.registry.prepareRecoveryIndexes.bind(active.registry);
    const preparation = spyOn(active.registry, "prepareRecoveryIndexes").mockImplementation(async signal => {
      await prepare(signal);
      activeOwner = false;
    });
    restorePreparation = () => preparation.mockRestore();
    await expect(sweepSendFailureNotices({ registry: active.registry,
      assertActive: () => { if (!activeOwner) throw new Error("notice index owner retired"); },
      receipt: async () => receipt,
      recipient: () => ({ kind: "deliver", conversationId: sender.conversationId, path: sender.transcriptPath }),
      deliver: async () => { writes++; return { ok: true }; },
    })).rejects.toThrow("notice index owner retired");
    expect(writes).toBe(0);
    expect(readSendFailureNotice(operationId)?.state).toBe("pending");
  } finally { restorePreparation(); active.registry.close(); active.close(); }
});

for (const failure of ["throw", "timeout"] as const) for (const recover of [false, true]) {
  test(`notice index preparation ${failure} preserves attempts across process restarts (recover=${recover})`, async () => {
    const priorState = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(isolated, "preparation-ledger-"));
    setSystemTime(new Date("2026-11-01T12:00:00Z"));
    const active = fixture(`notice-preparation-${failure}-${recover}`, { sqlite: true });
    const prepare = active.registry.prepareRecoveryIndexes.bind(active.registry);
    try {
      const sender = secondConversation(active, "preparation-sender");
      const seat = secondConversation(active, "preparation-seat");
      const { sweepSendFailureNotices, readSendFailureNotice, decodeSendFailureNotice, sendFailureSignals } = await import("./sendFailureNotice");
      const { operationId } = acceptSend(active, { clientMessageId: `preparation-original-${failure}-${recover}`,
        origin: { kind: "agent", role: "worker", conversationId: sender.conversationId } });
      await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
      const original = active.journal.operationResult(operationId);
      const snapshot = active.registry.deliverySnapshotForOperation(operationId);
      const modulePath = new URL("./sendFailureNotice.ts", import.meta.url).pathname;
      const registryPath = new URL("../agent/registry.ts", import.meta.url).pathname;
      // Each failure runs in a new process against the same two durable stores.
      // Any receipt read or dispatch before preparation succeeds is a defect.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const child = Bun.spawn([process.execPath, "--eval", `
          const { AgentRegistry } = await import(${JSON.stringify(registryPath)});
          const m = await import(${JSON.stringify(modulePath)});
          const registry = new AgentRegistry(${JSON.stringify(active.registryPath)}, undefined, undefined,
            { sqliteMode: "sqlite", sqliteFilename: ${JSON.stringify(active.registryPath.replace(/\.json$/, ".sqlite"))} });
          try {
            registry.prepareRecoveryIndexes = async () => {
              if (${JSON.stringify(failure)} === "throw") throw new Error("preparation unavailable");
              await new Promise(() => {});
            };
            registry.deliverySnapshotForOperation = () => { throw new Error("projection unavailable"); };
            await m.sweepSendFailureNotices({ registry, assertActive: () => {}, readMs: 5,
              receipt: async () => { throw new Error("preparation failure reached receipt"); },
              recipient: () => { throw new Error("preparation failure reached recipient"); },
              deliver: async () => { throw new Error("preparation failure dispatched"); },
              fallback: () => ({ kind: "deliver", conversationId: ${JSON.stringify(seat.conversationId)} }) });
            console.log(JSON.stringify(m.readSendFailureNotice(${JSON.stringify(operationId)})));
          } finally { registry.close(); }
        `], { env: process.env, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(exit, stderr).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({ state: "pending", attempts: attempt,
          reason: expect.stringContaining("index preparation unavailable") });
      }
      expect(readSendFailureNotice(operationId)).toMatchObject({ state: "pending", attempts: 2 });
      let deliveries = 0;
      let seatLookupFailures = 0;
      const target = recordingHost(sender.generationId);
      if (!recover) active.registry.prepareRecoveryIndexes = async () => {
        if (failure === "throw") throw new Error("preparation unavailable");
        await new Promise<void>(() => {});
      };
      const ports = { registry: active.registry, assertActive: () => {}, readMs: recover ? 10_000 : 5,
        receipt: (id: string) => resolveSendReceipt(id, { registry: active.registry, client: active.client }),
        recipient: () => ({ kind: "deliver" as const, conversationId: sender.conversationId, path: sender.transcriptPath }),
        fallback: () => {
          if (!recover && seatLookupFailures++ === 0) throw new Error("seat lookup unavailable");
          return { kind: "deliver" as const, conversationId: seat.conversationId };
        },
        deliver: async (request: { text: string; clientMessageId: string; origin: import("./messageOrigin").MessageOrigin }) => {
          deliveries++;
          const accepted = acceptSend(sender, request);
          await new StructuredDeliveryQueue(stalePortFor(sender, accepted.operationId, request.clientMessageId, request.text), () => target.host).drain();
          return { ok: true };
        },
      };
      const snapshotRead = active.registry.deliverySnapshotForOperation.bind(active.registry);
      if (!recover) active.registry.deliverySnapshotForOperation = () => { throw new Error("projection unavailable"); };
      await sweepSendFailureNotices(ports);
      if (!recover) {
        expect(readSendFailureNotice(operationId)).toMatchObject({ state: "failed", attempts: 3,
          fallbackConversationId: null, reason: expect.stringContaining("project seat lookup unavailable: seat lookup unavailable") });
        expect(sendFailureSignals(sender.conversationId).map(signal => signal.id)).toContain(`send-failed:${operationId}`);
      }
      await sweepSendFailureNotices(ports);
      active.registry.deliverySnapshotForOperation = snapshotRead;
      const notice = readSendFailureNotice(operationId);
      expect(notice).toMatchObject(recover ? { state: "sent", attempts: 2 } : {
        state: "failed", attempts: 3, fallbackConversationId: seat.conversationId,
        reason: expect.stringContaining("project seat lookup unavailable: seat lookup unavailable"),
      });
      expect(decodeSendFailureNotice(readSendFailureNotice(operationId))).toEqual(readSendFailureNotice(operationId));
      expect(deliveries).toBe(recover ? 1 : 0);
      expect(target.received).toHaveLength(recover ? 1 : 0);
      if (!recover) expect(sendFailureSignals(seat.conversationId).map(signal => signal.id)).toContain(`send-failed:${operationId}`);
      if (!recover) expect(sendFailureSignals(sender.conversationId).map(signal => signal.id)).toContain(`send-failed:${operationId}`);
      expect(active.journal.operationResult(operationId)).toEqual(original);
      expect(active.registry.deliverySnapshotForOperation(operationId)).toEqual(snapshot);
    } finally {
      active.registry.prepareRecoveryIndexes = prepare; active.registry.close(); active.close(); setSystemTime();
      process.env.LLV_STATE_DIR = priorState;
    }
  });
}

test.each(["throw", "timeout"] as const)("retirement during a preparation %s leaves attempts untouched", async failure => {
  const priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(isolated, "preparation-retirement-ledger-"));
  const active = fixture(`notice-preparation-retired-${failure}`, { sqlite: true });
  const prepare = active.registry.prepareRecoveryIndexes.bind(active.registry);
  try {
    const sender = secondConversation(active, "preparation-retired-sender");
    const { sweepSendFailureNotices, readSendFailureNotice } = await import("./sendFailureNotice");
    const { operationId } = acceptSend(active, { clientMessageId: `preparation-retired-${failure}`,
      origin: { kind: "agent", conversationId: sender.conversationId } });
    await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    const before = readSendFailureNotice(operationId);
    let owned = true;
    active.registry.prepareRecoveryIndexes = async () => {
      owned = false;
      if (failure === "throw") throw new Error("preparation unavailable");
      await new Promise<void>(() => {});
    };
    await expect(sweepSendFailureNotices({ registry: active.registry, readMs: 5,
      assertActive: () => { if (!owned) throw new Error("preparation owner retired"); },
      receipt: async () => { throw new Error("retired receipt"); },
      recipient: () => { throw new Error("retired recipient"); },
      deliver: async () => { throw new Error("retired dispatch"); },
    })).rejects.toThrow("preparation owner retired");
    expect(readSendFailureNotice(operationId)).toEqual(before);
  } finally {
    active.registry.prepareRecoveryIndexes = prepare; active.registry.close(); active.close();
    process.env.LLV_STATE_DIR = priorState;
  }
});

/* 2026-11-09: a Claude send ran out of its 30-second confirmation budget, and
   the journal, refusing the absorbing `uncertain`, took `failed` with the
   "started, unverified" reason instead. Claude had absorbed the message into
   its running turn: the echo arrived a minute after the write, and the
   transcript recorded the input as a `queued_command` attachment naming the
   echoed id. These cases replay that record. */
const LATE_TIMEOUT_REASON = "delivery was started and the structured host did not answer; whether it reached the recipient is unverified: Claude delivery confirmation timed out; outcome is uncertain";

function queuedCommandRecords(uuid: string, text: string, at: string): string {
  return [
    { type: "queue-operation", operation: "remove", timestamp: at, sessionId: "fixture-session", reason: "absorbed_mid_turn", commandUuid: uuid },
    { type: "attachment", uuid: `${uuid}-attachment`, timestamp: at, entrypoint: "sdk-cli", sessionId: "fixture-session",
      attachment: { type: "queued_command", commandMode: "prompt", prompt: [{ type: "text", text }], source_uuid: uuid } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n";
}

test("a journal `failed` written for a send it could not answer for keeps its duplicate risk", async () => {
  const { journalVerdict } = await import("./sendSettlement");
  for (const status of ["failed", "rejected"] as const)
  for (const reason of [LATE_TIMEOUT_REASON, SEND_UNVERIFIED_REASON, SEND_UNRECORDED_REASON, SEND_UNSETTLEABLE_REASON])
    expect(journalVerdict(status, reason)).toEqual({ state: "failed", disposition: "unverified",
      reason: reason === LATE_TIMEOUT_REASON ? SEND_UNVERIFIED_REASON : reason });
  /* Every other `failed` still proves the send never reached the engine. */
  expect(journalVerdict("failed", "fixture host refused the send")).toEqual({ state: "failed", disposition: "lost", reason: SEND_LOST_REASON,
    primaryFailure: { status: "failed", reason: "fixture host refused the send" } });
});

test("a send whose projection was owed when the journal failed it unverified is never called safe to resend", async () => {
  const active = fixture("owed-unverified-failure", { engine: "claude" });
  try {
    const { operationId } = acceptSend(active, { text: "keep the release held" });
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "failed", { reason: LATE_TIMEOUT_REASON });
    /* The registry has not heard yet: a busy writer left the projection owed. */
    expect(sendReceiptFor(active.registry.readOnlySnapshot(), operationId)?.state).toBe("in-flight");
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, progress: null }))
      .toMatchObject({ state: "failed", resend: "verify-first", duplicateRisk: true });
  } finally { active.close(); }
});

for (const projection of ["recorded", "owed"] as const) {
  test(`a late queued_command echo settles the original operation the journal failed unverified (${projection}), with no second write`, async () => {
    const active = fixture(`late-queued-command-${projection}`, { engine: "claude" });
    try {
      const text = "pause the deploy and report";
      const { operationId, deliveryId } = acceptSend(active, { text });
      const ledger = new FileClaudeDeliveryLedger();
      ledger.recordQueued(active.generationId, { id: operationId, text }, "turn-started");
      active.journal.transitionOperation(operationId, "delivering");
      active.journal.transitionOperation(operationId, "failed", { reason: LATE_TIMEOUT_REASON });
      /* The controller projects the journal's answer as it writes it; under a
         busy registry writer that projection can still be owed. */
      if (projection === "recorded") active.registry.recordDeliveryOutcome(deliveryId, "failed", LATE_TIMEOUT_REASON);
      expect(sendReceiptFor(active.registry.readOnlySnapshot(), operationId))
        .toMatchObject(projection === "recorded" ? { state: "failed", duplicateRisk: true } : { state: "in-flight" });
      /* The host's live echo, after the operation ended, and Claude's record of it. */
      const uuid = "ecbe8eba-fixture-echo";
      expect(ledger.confirmDelivered(active.generationId, operationId, uuid, "inferred")).toBe("accepted");
      fs.writeFileSync(active.transcriptPath, queuedCommandRecords(uuid, text, new Date(Date.now() + 1_000).toISOString()));
      const { settleEchoedSend } = await import("./sendSettlement");
      const sleeps: number[] = [];
      const settled = await settleEchoedSend(operationId, { registry: active.registry, client: active.client, progress: null,
        delaysMs: [0, 1_000, 5_000], sleep: async ms => { sleeps.push(ms); } });
      /* A recorded ending settles on the first look; an owed one waits one delay
         before the journal is asked, as an echo of a send in progress does. */
      expect(sleeps).toEqual(projection === "recorded" ? [] : [1_000]);
      expect(settled).toMatchObject({ state: "delivered", resend: "not-needed", duplicateRisk: false });
      expect(sendReceiptFor(active.registry.readOnlySnapshot(), operationId)?.state).toBe("delivered");
      expect(active.journal.operationResult(operationId)?.receipt.status).toBe("delivered");
      /* Nothing went to the engine again: the ledger holds the one write and
         the journal holds no effect that could make another. */
      expect(new FileClaudeDeliveryLedger().load(active.generationId).filter(state => state.entry.id === operationId))
        .toMatchObject([{ delivered: true, engineMessageId: uuid }]);
      expect(active.journal.effectBatch(100)).toEqual([]);
    } finally { active.close(); }
  });
}

test("an echo settles nothing it has no evidence for, and leaves a proven loss and a delivered send alone", async () => {
  const { settleEchoedSend } = await import("./sendSettlement");
  const active = fixture("echo-without-evidence", { engine: "claude" });
  try {
    const text = "the transcript never shows this";
    const { operationId, deliveryId } = acceptSend(active, { text, clientMessageId: "no-evidence" });
    new FileClaudeDeliveryLedger().recordQueued(active.generationId, { id: operationId, text }, "turn-started");
    active.journal.transitionOperation(operationId, "delivering");
    active.journal.transitionOperation(operationId, "failed", { reason: LATE_TIMEOUT_REASON });
    active.registry.recordDeliveryOutcome(deliveryId, "failed", LATE_TIMEOUT_REASON);
    const sleeps: number[] = [];
    expect(await settleEchoedSend(operationId, { registry: active.registry, client: active.client, progress: null,
      delaysMs: [0, 1_000, 5_000], sleep: async ms => { sleeps.push(ms); } }))
      .toMatchObject({ state: "failed", duplicateRisk: true });
    expect(sleeps).toEqual([1_000, 5_000]);
    expect(active.journal.operationResult(operationId)?.receipt.status).toBe("failed");

    const lost = acceptSend(active, { text: "never left the queue", clientMessageId: "proven-loss" });
    active.journal.transitionOperation(lost.operationId, "failed", { reason: "fixture host refused the send" });
    active.registry.recordDeliveryOutcome(lost.deliveryId, "failed", SEND_LOST_REASON, "lost");
    const lostSleeps: number[] = [];
    expect(await settleEchoedSend(lost.operationId, { registry: active.registry, client: active.client, progress: null,
      delaysMs: [0, 1_000], sleep: async ms => { lostSleeps.push(ms); } })).toMatchObject({ state: "failed", resend: "safe" });
    expect(lostSleeps).toEqual([]);
  } finally { active.close(); }
});

/* An echo settlement whose owner retires while its record write waits for
   another process's registry writer writes nothing once the lock is granted,
   and one retired after its write sends no acknowledgement. */
for (const retiredAt of ["writer-wait", "after-commit"] as const) {
  test(`a late-echo settlement whose owner retires ${retiredAt === "writer-wait" ? "while its write waits for the registry writer commits nothing" : "after its write sends no acknowledgement"}`, async () => {
    const { settleEchoedSend } = await import("./sendSettlement");
    const active = fixture(`retired-echo-${retiredAt}`, { engine: "claude", sqlite: true });
    const holder = registryLockHolder(active.registryPath.replace(/\.json$/, ".sqlite"));
    let owned = true;
    let entered!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const original = active.registry.deliveryWrite.bind(active.registry);
    const write = spyOn(active.registry, "deliveryWrite").mockImplementation((async (...args: Parameters<typeof original>) => {
      entered();
      const written = await original(...args);
      if (retiredAt === "after-commit") owned = false;
      return written;
    }) as never);
    const acknowledged: string[] = [];
    const client = { ...active.client, acknowledgeTerminalProjection: async (ids: readonly string[]) => { acknowledged.push(...ids); return ids.length; } } as RuntimeHostClient;
    let task: Promise<unknown> | undefined;
    let held = false;
    try {
      const text = "fixture late evidence";
      const { operationId, deliveryId } = acceptSend(active, { text });
      const ledger = new FileClaudeDeliveryLedger();
      ledger.recordQueued(active.generationId, { id: operationId, text }, "turn-started");
      active.journal.transitionOperation(operationId, "delivering");
      active.journal.transitionOperation(operationId, "failed", { reason: LATE_TIMEOUT_REASON });
      active.registry.recordDeliveryOutcome(deliveryId, "failed", LATE_TIMEOUT_REASON);
      ledger.confirmDelivered(active.generationId, operationId, "fixture-late-echo", "inferred");
      fs.writeFileSync(active.transcriptPath, queuedCommandRecords("fixture-late-echo", text, new Date(Date.now() + 1_000).toISOString()));
      if (retiredAt === "writer-wait") { await holder.hold(); held = true; }
      task = settleEchoedSend(operationId, { registry: active.registry, client, progress: null, delaysMs: [0],
        assertActive: () => { if (!owned) throw new Error("echo settlement owner retired"); } }).then(value => value, error => error);
      await writing;
      if (retiredAt === "writer-wait") {
        owned = false;
        await holder.release();
        held = false;
      }
      const outcome = await task;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("echo settlement owner retired");
      expect(acknowledged).toEqual([]);
      expect(sendReceiptFor(active.registry.deliverySnapshotForOperation(operationId), operationId)?.state)
        .toBe(retiredAt === "writer-wait" ? "failed" : "delivered");
    } finally {
      if (held) await holder.release();
      if (task) await task;
      write.mockRestore();
      await holder.close();
      active.close();
    }
  }, 20_000);
}


test("native combined result settles original receipts with the shared turn after ledger and registry reopen", async () => {
  const sessionId = ["00000000", "0000", "4000", "8000", "000000000020"].join("-");
  const active = fixture(sessionId, { engine: "claude", sqlite: true });
  try {
    expect(active.generationId).toBe(sessionId);
    const members = ["decision", "follow-up-one", "follow-up-two"].map((label, index) => ({
      ...acceptSend(active, { text: `fixture ${label}`, clientMessageId: `client-${label}`, operationId: `native-${label}` }),
      text: `fixture ${label}`, inputUuid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    const ledger = new FileClaudeDeliveryLedger();
    for (const [index, member] of members.entries()) {
      await ledger.recordNativeIntent(sessionId, { id: member.operationId, text: member.text }, index ? "queued-next-turn" : "turn-started", {
        version: 1, sessionId, writerId: ["00000000", "0000", "4000", "8000", "000000000021"].join("-"), process: { pid: 4100, startIdentity: "4100:fixture" },
        inputUuid: member.inputUuid, intent: "may-have-written",
      });
      active.journal.transitionOperation(member.operationId, "delivering");
      active.journal.transitionOperation(member.operationId, "uncertain", { reason: SEND_UNVERIFIED_REASON });
      active.registry.recordDeliveryOutcome(member.deliveryId, "failed", SEND_UNVERIFIED_REASON, "unverified");
    }
    expect(await ledger.confirmNativeResult(sessionId, {
      version: 1, sessionId, writerId: ["00000000", "0000", "4000", "8000", "000000000021"].join("-"), process: { pid: 4100, startIdentity: "4100:fixture" },
      inputUuids: members.map(member => member.inputUuid), resultUuid: ["00000000", "0000", "4000", "8000", "000000000030"].join("-"),
      turnId: members[0]!.operationId, status: "completed",
    })).toBe("accepted");
    const { readConfirmedSendEvidence, confirmedSend } = await import("./confirmedSend");
    const unavailable = spyOn(FileClaudeDeliveryLedger.prototype, "loadDurable").mockRejectedValueOnce(new Error("fixture durable proof unavailable"));
    try { expect(await readConfirmedSendEvidence(active.registry.readOnlySnapshot(), members[0]!.operationId)).toBeNull(); }
    finally { unavailable.mockRestore(); }
    const registry = new AgentRegistry(active.registryPath, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: path.join(path.dirname(active.registryPath), "agent-registry.sqlite") });
    for (const member of members) {
      const evidence = await readConfirmedSendEvidence(registry.deliverySnapshotForOperation(member.operationId, { recipientEvidence: true }), member.operationId);
      expect(evidence).toMatchObject({ source: "claude-native-result", turnId: members[0]!.operationId, inputUuid: member.inputUuid });
      expect(await confirmedSend(registry.readOnlySnapshot(), member.operationId, false)).toBe(true);
      expect(await resolveSendReceipt(member.operationId, { registry, client: active.client })).toMatchObject({ state: "delivered", duplicateRisk: false });
      expect(active.journal.operationResult(member.operationId)?.receipt).toMatchObject({ operationId: member.operationId, status: "delivered", turnId: members[0]!.operationId });
    }
    const effects = active.journal.effectBatch(100);
    for (const member of members) await resolveSendReceipt(member.operationId, { registry, client: active.client });
    expect(active.journal.effectBatch(100)).toEqual(effects);
    // An exact native proof cannot bypass explicit discard or a different payload.
    for (const mutation of ["discard", "digest", "generation"]) {
      const file = structuredClone(registry.readOnlySnapshot());
      const owner = file.deliveryOperationOwners[members[0]!.operationId]!;
      if (mutation === "discard") owner.terminalReason = "delivery-discarded";
      if (mutation === "digest") owner.contentDigest = "0".repeat(64);
      if (mutation === "generation") owner.targetGenerationId = "other-generation";
      expect(await readConfirmedSendEvidence(file, members[0]!.operationId)).toBeNull();
    }
    const legacy = acceptSend(active, { text: members[2]!.text, clientMessageId: "legacy-collision", operationId: "legacy-collision" });
    ledger.recordQueued(sessionId, { id: legacy.operationId, text: members[2]!.text }, "turn-started");
    fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "user", sessionId, uuid: members[2]!.inputUuid,
      timestamp: new Date().toISOString(), message: { role: "user", content: members[2]!.text } }) + "\n");
    expect(ledger.confirmDelivered(sessionId, legacy.operationId, members[2]!.inputUuid, "inferred")).toBe("refused");
    expect(await readConfirmedSendEvidence(registry.readOnlySnapshot(), legacy.operationId)).toBeNull();
    expect(active.journal.operationResult(legacy.operationId)?.receipt.status).toBe("queued");
    // Malformed combined identity cannot escape through legacy text inference.
    fs.writeFileSync(active.transcriptPath, JSON.stringify({ type: "user", sessionId,
      uuid: ["00000000", "0000", "4000", "8000", "000000000099"].join("-"), mergedSendUuids: ["invalid-input"],
      timestamp: new Date().toISOString(), message: { role: "user", content: members[2]!.text } }) + "\n");
    expect(await readConfirmedSendEvidence(registry.readOnlySnapshot(), legacy.operationId)).toBeNull();
    expect(new FileClaudeDeliveryLedger().load(sessionId).find(state => state.entry.id === legacy.operationId)?.delivered).toBe(false);
  } finally { active.close(); }
});

test("confirmed native input observes admission before the consumed ledger fsync returns", async () => {
  const { readConfirmedSendEvidence } = await import("./confirmedSend");
  const sessionId = ["00000000", "0000", "4000", "8000", "000000000040"].join("-");
  const active = fixture(sessionId, { engine: "claude", sqlite: true });
  const { operationId } = acceptSend(active, { text: "fixture late incumbent", operationId: "native-close-boundary" });
  const ledger = new FileClaudeDeliveryLedger();
  const inputUuid = ["00000000", "0000", "4000", "8000", "000000000041"].join("-");
  const native = { version: 1 as const, sessionId, writerId: ["00000000", "0000", "4000", "8000", "000000000042"].join("-"),
    process: { pid: 4100, startIdentity: "4100:fixture" }, inputUuid, intent: "may-have-written" as const };
  let releaseClose!: () => void;
  const heldClose = new Promise<void>(resolve => { releaseClose = resolve; });
  let closeEntered!: () => void;
  const closing = new Promise<void>(resolve => { closeEntered = resolve; });
  let restoreClose: (() => void) | undefined;
  let admission = false;
  try {
    await ledger.recordNativeIntent(sessionId, { id: operationId, text: "fixture late incumbent" }, "turn-started", native);
    const originalOpen = fs.promises.open.bind(fs.promises);
    const close = spyOn(fs.promises, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (String(filePath).endsWith(`${encodeURIComponent(sessionId)}.jsonl`) && flags === "a+") {
        const closeHandle = handle.close.bind(handle);
        handle.close = async () => { closeEntered(); await heldClose; return closeHandle(); };
      }
      return handle;
    });
    restoreClose = () => close.mockRestore();
    const consuming = ledger.recordNativeConsumed(sessionId, { ...native, canonicalUuid: inputUuid,
      entryId: operationId, contentDigest: ledger.load(sessionId)[0]!.entry.contentDigest, turnId: operationId }, () => { admission = true; });
    await closing;
    expect(admission).toBe(true);
    expect(await readConfirmedSendEvidence(active.registry.deliverySnapshotForOperation(operationId, { recipientEvidence: true }), operationId))
      .toMatchObject({ source: "claude-native-input", turnId: operationId, inputUuid });
    releaseClose();
    await consuming;
    expect(await readConfirmedSendEvidence(active.registry.deliverySnapshotForOperation(operationId, { recipientEvidence: true }), operationId))
      .toMatchObject({ source: "claude-native-input", turnId: operationId, inputUuid });
  } finally {
    releaseClose();
    restoreClose?.();
    active.close();
  }
});

for (const status of ["failed", "rejected"] as const) test(`lost ${status} retains its primary refusal through durable projection and replay`, async () => {
  const active = fixture(`primary-${status}`, { sqlite: true });
  const primary = `idle-continuation-refused: ${"fixture detail ".repeat(24)}`;
  const clientMessageId = `primary-${status}`;
  const text = "Fixture instruction";
  const { operationId, deliveryId } = acceptSend(active, { clientMessageId, text });
  try {
    active.journal.transitionOperation(operationId, status, { reason: primary });
    const first = await resolveSendReceipt(operationId, { registry: active.registry, client: active.client });
    expect(first).toMatchObject({ state: "failed", resend: "safe", duplicateRisk: false,
      reason: SEND_LOST_REASON, primaryFailure: { status, reason: primary } });
    const stored = active.registry.deliverySnapshotForOperation(operationId);
    expect(stored.heldDeliveries[deliveryId]?.error).toBe(first!.reason);
    expect(stored.deliveryOperationOwners[operationId]?.terminalReason).toBe(first!.reason);
    expect(stored.heldDeliveries[deliveryId]?.primaryFailure).toEqual({ status, reason: primary });
    expect(stored.deliveryOperationOwners[operationId]?.primaryFailure).toEqual({ status, reason: primary });
    const reopened = new AgentRegistry(active.registryPath, undefined, undefined, { sqliteMode: "sqlite",
      sqliteFilename: path.join(path.dirname(active.registryPath), "agent-registry.sqlite") });
    try {
      const replay = await resolveSendReceipt(operationId, { registry: reopened, client: null });
      expect(replay).toMatchObject({ reason: first!.reason, state: "failed", resend: "safe", primaryFailure: { status, reason: primary } });
      const { runtimeReceiptForSend } = await import("./sendSettlement");
      expect(runtimeReceiptForSend(replay!)).toMatchObject({ reason: SEND_LOST_REASON, primaryFailure: { status, reason: primary } });
    } finally { reopened.close(); }
    const host = recordingHost(active.generationId);
    const queue = new StructuredDeliveryQueue(stalePortFor(active, operationId, clientMessageId, text), () => host.host);
    await queue.drain().catch(() => undefined);
    expect(host.received).toEqual([]);
  } finally { active.close(); active.registry.close(); }
});


for (const mode of ["off", "sqlite"] as const)
for (const writer of ["reservation", "operation", "retry", "direct"] as const)
test(`primary refusal survives the ${writer} writer and ${mode} reader`, async () => {
  const active = fixture(`primary-${writer}-${mode}`, { sqlite: true });
  if (mode === "off") {
    const filename = path.join(path.dirname(active.registryPath), "json-registry.json");
    fs.writeFileSync(filename, JSON.stringify(active.registry.snapshot()));
    active.registry.close();
    active.registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    active.registryPath = filename;
  }
  const primaryFailure = { status: "rejected" as const, reason: "fixture original refusal ".repeat(25) };
  let operationId = "";
  try {
    const admitted = acceptSend(active, { clientMessageId: `primary-${writer}-${mode}`, text: "Fixture instruction" });
    operationId = admitted.operationId;
    if (writer === "reservation") active.registry.recordDeliveryOutcome(admitted.deliveryId, "failed", SEND_LOST_REASON, "lost", null, primaryFailure);
    if (writer === "operation") {
      active.registry.recordDeliveryOutcome(admitted.deliveryId, "delivery-uncertain");
      active.registry.recordDeliveryOutcomeForOperation(active.conversationId, operationId, "failed", SEND_LOST_REASON, "lost", null, primaryFailure);
    }
    if (writer === "retry") {
      active.registry.recordDeliveryOutcome(admitted.deliveryId, "failed", SEND_LOST_REASON, "lost");
      expect(active.registry.recordDeliveryRetryAttempt(operationId, `fixture-primary-retry-${mode}`)).toBe(true);
      operationId = `fixture-primary-retry-${mode}`;
      active.registry.settleDeliveryRetryAttempt(operationId, "failed", SEND_LOST_REASON, "lost", null, primaryFailure);
    }
    if (writer === "direct") {
      const owner = active.registry.recordDirectAdmission({ handOff: { conversationId: active.conversationId, clientMessageId: `fixture-primary-direct-${mode}`,
        command: { operationId: `fixture-primary-direct-${mode}`, kind: "send", policy: "queue" }, text: "Fixture instruction", contentDigest: null,
        evidenceText: "Fixture instruction", evidenceImageCount: 0 } })!;
      operationId = owner.command.operationId;
      active.registry.settleDirectAdmission(operationId, "failed", SEND_LOST_REASON, "lost", null, primaryFailure);
    }
    const expected = { state: "failed", reason: SEND_LOST_REASON, resend: "safe", primaryFailure };
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: null, progress: null })).toMatchObject(expected);
    const reopened = new AgentRegistry(active.registryPath, undefined, undefined, { sqliteMode: mode,
      ...(mode === "sqlite" ? { sqliteFilename: path.join(path.dirname(active.registryPath), "agent-registry.sqlite") } : {}) });
    try {
      const replay = await resolveSendReceipt(operationId, { registry: reopened, client: null, progress: null });
      expect(replay).toMatchObject(expected);
      const { runtimeReceiptForSend } = await import("./sendSettlement");
      expect(runtimeReceiptForSend(replay!)).toMatchObject({ reason: SEND_LOST_REASON, primaryFailure });
    } finally { reopened.close(); }
  } finally { active.close(); active.registry.close(); }
});


test("a five-week switching-account hold closes without a receipt reader and stays fenced after restart", async () => {
  const accepted = Date.parse("2026-10-13T12:00:00Z");
  setSystemTime(accepted);
  const { active } = completionFixture("old-switch-hold", { now: () => accepted, sqlite: true });
  try {
    active.registry.commitMigrationIntent({ engine: "codex", targetId: "target", origin: "manual",
      requestId: "old-switch", expectedRevision: active.registry.engineRouting("codex").revision });
    const held = active.registry.holdDelivery(active.conversationId, "retained instruction", "old-switch-message");
    setSystemTime();
    expect(held.state).toBe("held");
    const { settlementDeadlineForRow } = await import("./sendSettlement");
    expect(settlementDeadlineForRow(active.registry, { delivery: held })?.deadlineAt).toBe(new Date(accepted + SETTLEMENT_WINDOW_MS).toISOString());
    const now = () => Date.parse("2026-11-17T12:00:00Z");
    const result = await settleDueSends({ registry: active.registry, client: null, now });
    expect(result.settled).toEqual([{ operationId: held.command.operationId, state: "failed", duplicateRisk: false }]);
    active.registry.close();
    const reopened = new AgentRegistry(active.registryPath, undefined, undefined, { sqliteMode: "sqlite" });
    try {
      expect(sendReceiptFor(reopened.deliverySnapshotForOperation(held.command.operationId), held.command.operationId))
        .toMatchObject({ state: "failed", resend: "safe" });
      expect(reopened.beginDeliveryAttempt(held.id, active.generationId)).toBeNull();
    } finally { reopened.close(); }
  } finally { active.close(); }
});

test("proven target death fences a queued send before its ordinary deadline", async () => {
  const { active } = completionFixture("dead-target-pending");
  try {
    const { operationId } = acceptSend(active);
    const entry = active.registry.readOnlySnapshot().entries[`codex:${active.generationId}`]!;
    active.registry.upsert({ ...entry, status: "dead", structuredHost: null });
    const answer = await resolveSendReceipt(operationId, { registry: active.registry, client: active.client });
    expect(answer).toMatchObject({ state: "failed", resend: "safe" });
    expect(active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);
  } finally { active.close(); }
});

test("a queued instruction to a suspended attempt retains its sender warning through sender recovery", async () => {
  // Notice dispatch and prune cursors belong to their store. Give this replay
  // its own store so earlier cases cannot advance past the warning under test.
  const priorState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(isolated, "suspended-sender-notices-"));
  const accepted = Date.parse("2026-11-17T12:00:00Z");
  setSystemTime(accepted);
  const { active, child: sender } = completionFixture("suspended-attempt-notice", { sqlite: true });
  try {
    const { operationId } = acceptSend(active, { clientMessageId: "suspended-attempt-message",
      origin: { kind: "agent", role: "worker", conversationId: sender.conversationId } });
    active.journal.transitionOperation(operationId, "failed", { reason: "pipeline attempt is suspended; its controller owns recovery" });
    await resolveSendReceipt(operationId, { registry: active.registry, client: active.client });
    let available = false;
    const { readSendFailureNotice, sweepSendFailureNotices, sendFailureSignals } = failureNotices;
    await sweepSendFailureNotices({ registry: active.registry, assertActive: () => {},
      receipt: id => resolveSendReceipt(id, { registry: active.registry, client: active.client }),
      recipient: () => available ? { kind: "deliver", conversationId: sender.conversationId, path: sender.transcriptPath }
        : { kind: "skip", reason: "sender is suspended" }, deliver: async () => { throw Error("sender is offline"); } });
    expect(readSendFailureNotice(operationId)?.state).toBe("failed");
    // Sender recovery can outlast ordinary terminal-delivery retention.
    setSystemTime(accepted + 35 * 24 * 60 * 60_000);
    try {
      await sweepSendFailureNotices({ registry: active.registry, assertActive: () => {},
        receipt: id => resolveSendReceipt(id, { registry: active.registry, client: active.client }),
        recipient: () => ({ kind: "skip", reason: "sender remains suspended" }),
        deliver: async () => { throw Error("no delivery while sender is offline"); } });
      expect(readSendFailureNotice(operationId)?.state).toBe("failed");
    } finally { setSystemTime(accepted); }
    available = true;
    const code = `const m = await import(${JSON.stringify(new URL("./sendFailureNotice.ts", import.meta.url).pathname)});
console.log(JSON.stringify(m.sendFailureSignals(${JSON.stringify(sender.conversationId)})));`;
    const restarted = spawnSync(process.execPath, ["-e", code], { env: process.env, encoding: "utf8" });
    expect(restarted.status).toBe(0);
    expect(JSON.parse(restarted.stdout)).toContainEqual(expect.objectContaining({ id: `send-failed:${operationId}` }));
    expect(sendFailureSignals(sender.conversationId)).toContainEqual(expect.objectContaining({ id: `send-failed:${operationId}` }));
  } finally {
    active.close(); setSystemTime();
    if (priorState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = priorState;
  }
});


test("fresh native work protects a held send after the in-turn ceiling while its Viewer writer is gone", async () => {
  const accepted = Date.parse("2026-11-17T08:00:00Z");
  setSystemTime(accepted);
  const { active } = completionFixture("working-held-native", { engine: "claude" });
  const { DeliveryProgressStore } = await import("./deliveryProgress");
  const progress = new DeliveryProgressStore(null, () => accepted + 2 * 60 * 60_000);
  try {
    const { captureProcessIdentity } = await import("@/lib/processIdentity");
    const key = `claude:${active.generationId}`;
    const entry = active.registry.readOnlySnapshot().entries[key]!;
    active.registry.upsert({ ...entry, status: "live", claimOwner: `structured-host:${JSON.stringify({ pid: 2_000_000_000, startIdentity: "gone-writer" })}`,
      structuredHost: { ...entry.structuredHost!, process: captureProcessIdentity(process.pid), activeTurnRef: "working-turn" } });
    active.registry.commitMigrationIntent({ engine: "claude", targetId: "target", origin: "manual", requestId: "working-held-switch",
      expectedRevision: active.registry.engineRouting("claude").revision });
    const held = active.registry.holdDelivery(active.conversationId, "new requirement", "working-held-native-message");
    const now = accepted + 2 * 60 * 60_000;
    setSystemTime(now);
    fs.writeFileSync(active.transcriptPath, [
      { type: "user", timestamp: new Date(now - 1000).toISOString(), message: { role: "user", content: "work" } },
      { type: "assistant", timestamp: new Date(now).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "work", name: "Bash", input: {} }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    progress.note(held.command.operationId, active.conversationId, { waitReason: "switch-after-turn", admittedAt: held.createdAt });
    const swept = await settleDueSends({ registry: active.registry, client: null, progress, now: () => now });
    expect(swept.settled).toEqual([]);
    expect(sendReceiptFor(active.registry.deliverySnapshotForOperation(held.command.operationId), held.command.operationId)?.state).toBe("in-flight");
    expect(progress.get(held.command.operationId)).toMatchObject({ deadlineAt: new Date(now + SETTLEMENT_WINDOW_MS).toISOString(), deadlinePolicy: "turn-boundary" });
  } finally { setSystemTime(); progress.close(); active.close(); }
});


test("the reservation attempt limit is enforced by the writer after a process restart", async () => {
  const { active } = completionFixture("reservation-attempt-bound", { sqlite: true });
  try {
    const row = active.registry.holdDelivery(active.conversationId, "bounded retries", "bounded-reservation");
    for (let attempt = 1; attempt <= 12; attempt++) {
      expect(active.registry.beginDeliveryAttempt(row.id, active.generationId)?.attempts).toBe(attempt);
      active.registry.requeueUnactuatedDelivery(row.id, "pre-dispatch refusal");
    }
    const code = `
      const { AgentRegistry } = await import(${JSON.stringify(new URL("../agent/registry.ts", import.meta.url).pathname)});
      const registry = new AgentRegistry(${JSON.stringify(active.registryPath)}, undefined, undefined, { sqliteMode: "sqlite" });
      console.log(JSON.stringify(registry.beginDeliveryAttempt(${JSON.stringify(row.id)}, ${JSON.stringify(active.generationId)})));
      registry.close();
    `;
    const child = spawnSync(process.execPath, ["-e", code], { env: process.env, encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toBeNull();
    expect(sendReceiptFor(active.registry.deliverySnapshotForOperation(row.command.operationId), row.command.operationId))
      .toMatchObject({ state: "failed", resend: "verify-first", reason: expect.stringContaining("attempt limit") });
  } finally { active.close(); }
});


test("an actual recorded host exit fences pending receipts without changing its registry status", async () => {
  const { active } = completionFixture("recorded-host-exit");
  const child = Bun.spawn([process.execPath, "-e", 'console.log("ready"); await Bun.stdin.text();'],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
  let closed = false;
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    const { captureProcessIdentity } = await import("@/lib/processIdentity");
    const key = `codex:${active.generationId}`;
    const entry = active.registry.readOnlySnapshot().entries[key]!;
    active.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!, process: captureProcessIdentity(child.pid) } });
    const { operationId } = acceptSend(active, { clientMessageId: "recorded-host-exit-message" });
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client }))
      .toMatchObject({ state: "in-flight" });
    closed = true; child.stdin.end(); await child.exited;
    expect(active.registry.readOnlySnapshot().entries[key]?.status).toBe("idle");
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client }))
      .toMatchObject({ state: "failed", resend: "safe" });
    expect(active.journal.effectBatch(100, ["runtime.send"])).toEqual([]);
  } finally {
    if (!closed) child.stdin.end();
    await child.exited;
    active.close();
  }
});

for (const engine of ["codex", "claude"] as const) {
  for (const target of ["working", "working-claimed", "working-before-cutoff", "idle", "dead", "killed"] as const) {
    test(`${engine} ${target} target starting during settlement admission is observed again before expiry`, async () => {
      const accepted = Date.parse("2026-11-17T08:00:00Z");
      setSystemTime(accepted);
      const { active } = completionFixture(`admission-race-${engine}-${target}`, { engine, sqlite: true });
      const { captureProcessIdentity } = await import("@/lib/processIdentity");
      const key = `${engine}:${active.generationId}`;
      const entry = active.registry.readOnlySnapshot().entries[key]!;
      active.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!, process: captureProcessIdentity(process.pid) } });
      if (target !== "working-claimed") active.registry.commitMigrationIntent({ engine, targetId: "target", origin: "manual", requestId: `admission-race-${engine}-${target}`,
        expectedRevision: active.registry.engineRouting(engine).revision });
      const held = active.registry.holdDelivery(active.conversationId, "new requirement", `admission-race-send-${engine}-${target}`);
      const now = accepted + 2 * 60 * 60_000;
      setSystemTime(now);
      const original = active.registry.deliveryWrite.bind(active.registry);
      let admissions = 0;
      const admission = spyOn(active.registry, "deliveryWrite").mockImplementation((async (...args: Parameters<typeof original>) => {
        if (args[0].label === "delivery.settle-pristine" && ++admissions === 1) {
          const current = active.registry.readOnlySnapshot().entries[key]!;
          active.registry.upsert({ ...current, status: target === "dead" ? "dead" : target === "idle" ? "idle" : "live",
            structuredHost: target === "dead" ? null : { ...current.structuredHost!, activeTurnRef: target === "idle" ? null : "working-turn" } });
          if (target === "working-claimed") expect(active.registry.beginDeliveryAttempt(held.id, active.generationId)).not.toBeNull();
          if (target !== "idle") {
            const rows = engine === "codex" ? [
              { type: "event_msg", timestamp: new Date(now - 1000).toISOString(), payload: { type: "task_started", turn_id: "working-turn" } },
              { type: "response_item", timestamp: new Date(now).toISOString(), payload: { type: "function_call", call_id: "work", name: "exec_command", arguments: "{}" } },
            ] : [
              { type: "user", timestamp: new Date(now - 1000).toISOString(), message: { role: "user", content: "work" } },
              { type: "assistant", timestamp: new Date(now).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "work", name: "Bash", input: {} }] } },
            ];
            fs.writeFileSync(active.transcriptPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
            const { readTranscriptCutEvidence } = await import("./liveness");
            expect(await readTranscriptCutEvidence(engine, active.transcriptPath)).toMatchObject({ verified: true, turn: "busy" });
          }
        }
        return original(...args);
      }) as typeof original);
      try {
        const answer = await resolveSendReceipt(held.command.operationId, { registry: active.registry, client: null, now: () => now,
          ...(target === "killed" ? { absoluteDeadline: now } : target === "working-before-cutoff" ? { absoluteDeadline: now + 60_000 } : {}) });
        expect(admissions).toBeGreaterThan(0);
        expect(answer).toMatchObject(target.startsWith("working") ? { state: "in-flight" } : { state: "failed", resend: "safe" });
      } finally { admission.mockRestore(); setSystemTime(); active.close(); }
    });
  }
}


for (const engine of ["codex", "claude"] as const) {
  test.each(["append", "replace", "create", "idle", "killed", "dead", "changing"] as const)(
    `${engine} transcript-only work during writer admission is observed before expiry (%s)`, async mutation => {
      const accepted = Date.parse("2026-11-17T08:00:00Z");
      setSystemTime(accepted);
      const now = accepted + 2 * 60 * 60_000;
      const { active } = completionFixture(`native-admission-${engine}-${mutation}`, { engine, sqlite: true });
      const { captureProcessIdentity } = await import("@/lib/processIdentity");
      const { DeliveryProgressStore } = await import("./deliveryProgress");
      const progress = new DeliveryProgressStore(null, () => now);
      const key = `${engine}:${active.generationId}`;
      const entry = active.registry.readOnlySnapshot().entries[key]!;
      active.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!, process: captureProcessIdentity(process.pid) } });
      active.registry.commitMigrationIntent({ engine, targetId: "target", origin: "manual", requestId: `native-admission-${engine}-${mutation}`,
        expectedRevision: active.registry.engineRouting(engine).revision });
      const held = active.registry.holdDelivery(active.conversationId, "new requirement", `native-admission-send-${engine}-${mutation}`);
      setSystemTime(now);
      progress.note(held.command.operationId, active.conversationId, { waitReason: "switch-after-turn", admittedAt: held.createdAt });
      const idle = JSON.stringify(engine === "codex"
        ? { type: "event_msg", timestamp: new Date(accepted).toISOString(), payload: { type: "task_complete" } }
        : { type: "assistant", timestamp: new Date(accepted).toISOString(),
          message: { model: "claude", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\n";
      if (mutation !== "create") fs.writeFileSync(active.transcriptPath, idle);
      const original = active.registry.deliveryWrite.bind(active.registry);
      let admissions = 0;
      const admission = spyOn(active.registry, "deliveryWrite").mockImplementation((async (...args: Parameters<typeof original>) => {
        if (args[0].label === "delivery.settle-pristine" && (++admissions === 1 || mutation === "changing")) {
          const rows = engine === "codex" ? [
            { type: "event_msg", timestamp: new Date(now - 1000).toISOString(), payload: { type: "task_started", turn_id: "working-turn" } },
            { type: "response_item", timestamp: new Date(now).toISOString(), payload: { type: "function_call", call_id: "work", name: "exec_command", arguments: "{}" } },
          ] : [
            { type: "user", timestamp: new Date(now - 1000).toISOString(), message: { role: "user", content: "work" } },
            { type: "assistant", timestamp: new Date(now).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "work", name: "Bash", input: {} }] } },
          ];
          const content = mutation === "idle" || mutation === "changing" ? idle : rows.map(row => JSON.stringify(row)).join("\n") + "\n";
          if (mutation === "replace") {
            fs.writeFileSync(`${active.transcriptPath}.next`, content);
            fs.renameSync(`${active.transcriptPath}.next`, active.transcriptPath);
          } else fs.appendFileSync(active.transcriptPath, content);
          const { readTranscriptCutEvidence } = await import("./liveness");
          expect(await readTranscriptCutEvidence(engine, active.transcriptPath)).toMatchObject({ verified: true,
            turn: mutation === "idle" || mutation === "changing" ? "terminal" : "busy" });
          // Native work does not require a registry publication by the old Viewer.
          expect(active.registry.readOnlySnapshot().entries[key]).toEqual(entryBeforeNative);
        }
        return original(...args);
      }) as typeof original);
      const entryWithProcess = active.registry.readOnlySnapshot().entries[key];
      if (mutation === "dead") active.registry.upsert({ ...entryWithProcess!, status: "dead", structuredHost: null });
      const entryBeforeNative = active.registry.readOnlySnapshot().entries[key];
      try {
        const answer = await resolveSendReceipt(held.command.operationId, { registry: active.registry, client: null, now: () => now, progress,
          ...(mutation === "killed" ? { absoluteDeadline: now } : {}) });
        const retained = ["append", "replace", "create", "changing"].includes(mutation);
        expect(answer).toMatchObject(retained ? { state: "in-flight" } : { state: "failed", resend: "safe" });
        expect(admissions).toBe(mutation === "changing" || mutation === "idle" ? 2 : 1);
        if (retained && mutation !== "changing") expect(progress.get(held.command.operationId))
          .toMatchObject({ deadlineAt: new Date(now + SETTLEMENT_WINDOW_MS).toISOString(), deadlinePolicy: "turn-boundary" });
      } finally { admission.mockRestore(); setSystemTime(); progress.close(); active.close(); }
    },
  );
}

for (const owner of ["claimed", "retry"] as const)
for (const engine of ["codex", "claude"] as const) {
  test.each(["append", "replace", "create", "idle", "killed", "dead", "changing"] as const)(
    `${engine} ${owner} transcript-only work during writer admission is observed before expiry (%s)`, async mutation => {
      const accepted = Date.parse("2026-11-17T08:00:00Z");
      setSystemTime(accepted);
      const now = accepted + 2 * 60 * 60_000;
      const { active } = completionFixture(`native-admission-${owner}-${engine}-${mutation}`, { engine, sqlite: true });
      const { captureProcessIdentity } = await import("@/lib/processIdentity");
      const { DeliveryProgressStore } = await import("./deliveryProgress");
      const progressPath = path.join(path.dirname(active.registryPath), "native-progress.sqlite");
      const progress = new DeliveryProgressStore(progressPath, () => now);
      const key = `${engine}:${active.generationId}`;
      const entry = active.registry.readOnlySnapshot().entries[key]!;
      active.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!, process: captureProcessIdentity(process.pid) } });
      const held = active.registry.holdDelivery(active.conversationId, "new requirement", `native-admission-send-${owner}-${engine}-${mutation}`);
      expect(active.registry.beginDeliveryAttempt(held.id, active.generationId)).not.toBeNull();
      let operationId = held.command.operationId;
      if (owner === "retry") {
        active.registry.recordDeliveryOutcome(held.id, "failed", SEND_LOST_REASON, "lost");
        const retryId = `native-admission-retry-${engine}-${mutation}`;
        expect(active.registry.recordDeliveryRetryAttempt(operationId, retryId)).toBe(true);
        operationId = retryId;
      }
      setSystemTime(now);
      progress.note(operationId, active.conversationId, { waitReason: "switch-after-turn", admittedAt: held.createdAt });
      const idle = JSON.stringify(engine === "codex"
        ? { type: "event_msg", timestamp: new Date(accepted).toISOString(), payload: { type: "task_complete" } }
        : { type: "assistant", timestamp: new Date(accepted).toISOString(),
          message: { model: "claude", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }) + "\n";
      if (mutation !== "create") fs.writeFileSync(active.transcriptPath, idle);
      const original = active.registry.deliveryWrite.bind(active.registry);
      let admissions = 0;
      const admission = spyOn(active.registry, "deliveryWrite").mockImplementation((async (...args: Parameters<typeof original>) => {
        if (args[0].label === (owner === "retry" ? "delivery.settle-retry" : "delivery.settle") && (++admissions === 1 || mutation === "changing")) {
          const rows = engine === "codex" ? [
            { type: "event_msg", timestamp: new Date(now - 1000).toISOString(), payload: { type: "task_started", turn_id: "working-turn" } },
            { type: "response_item", timestamp: new Date(now).toISOString(), payload: { type: "function_call", call_id: "work", name: "exec_command", arguments: "{}" } },
          ] : [
            { type: "user", timestamp: new Date(now - 1000).toISOString(), message: { role: "user", content: "work" } },
            { type: "assistant", timestamp: new Date(now).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "work", name: "Bash", input: {} }] } },
          ];
          const content = mutation === "idle" || mutation === "changing" ? idle : rows.map(row => JSON.stringify(row)).join("\n") + "\n";
          if (mutation === "replace") {
            fs.writeFileSync(`${active.transcriptPath}.next`, content);
            fs.renameSync(`${active.transcriptPath}.next`, active.transcriptPath);
          } else fs.appendFileSync(active.transcriptPath, content);
          const { readTranscriptCutEvidence } = await import("./liveness");
          expect(await readTranscriptCutEvidence(engine, active.transcriptPath)).toMatchObject({ verified: true,
            turn: mutation === "idle" || mutation === "changing" ? "terminal" : "busy" });
          // Native work does not require a registry publication by the old Viewer.
          expect(active.registry.readOnlySnapshot().entries[key]).toEqual(entryBeforeNative);
        }
        return original(...args);
      }) as typeof original);
      const entryWithProcess = active.registry.readOnlySnapshot().entries[key];
      if (mutation === "dead") active.registry.upsert({ ...entryWithProcess!, status: "dead", structuredHost: null });
      const entryBeforeNative = active.registry.readOnlySnapshot().entries[key];
      try {
        const answer = await resolveSendReceipt(operationId, { registry: active.registry, client: null, now: () => now, progress,
          ...(mutation === "killed" ? { absoluteDeadline: now } : {}) });
        const retained = ["append", "replace", "create", "changing"].includes(mutation);
        expect(answer).toMatchObject(retained ? { state: "in-flight" } : { state: "failed", resend: "verify-first" });
        expect(active.registry.readOnlySnapshot().heldDeliveries[held.id]?.state).toBe(owner === "retry" ? "failed" : retained ? "delivery-uncertain" : "failed");
        expect(admissions).toBe(mutation === "changing" || mutation === "idle" ? 2 : 1);
        if (retained && mutation !== "changing") expect(progress.get(operationId))
          .toMatchObject({ deadlineAt: new Date(now + SETTLEMENT_WINDOW_MS).toISOString(), deadlinePolicy: "turn-boundary" });
        if (mutation === "append") {
          progress.close();
          const code = `
            const { AgentRegistry } = await import(${JSON.stringify(new URL("../agent/registry.ts", import.meta.url).pathname)});
            const { DeliveryProgressStore } = await import(${JSON.stringify(new URL("./deliveryProgress.ts", import.meta.url).pathname)});
            const { resolveSendReceipt } = await import(${JSON.stringify(new URL("./sendSettlement.ts", import.meta.url).pathname)});
            const registry = new AgentRegistry(${JSON.stringify(active.registryPath)}, undefined, undefined, { sqliteMode: "sqlite" });
            const progress = new DeliveryProgressStore(${JSON.stringify(progressPath)}, () => ${now});
            const answer = await resolveSendReceipt(${JSON.stringify(operationId)}, { registry, client: null, now: () => ${now}, progress });
            console.log(JSON.stringify({ answer, progress: progress.get(${JSON.stringify(operationId)}) }));
            progress.close(); registry.close();`;
          const restarted = spawnSync(process.execPath, ["-e", code], { env: process.env, encoding: "utf8" });
          expect(restarted.status).toBe(0);
          expect(JSON.parse(restarted.stdout)).toMatchObject({ answer: { state: "in-flight" },
            progress: { deadlineAt: new Date(now + SETTLEMENT_WINDOW_MS).toISOString(), deadlinePolicy: "turn-boundary" } });
        }
      } finally { admission.mockRestore(); setSystemTime(); progress.close(); active.close(); }
    },
  );
}
