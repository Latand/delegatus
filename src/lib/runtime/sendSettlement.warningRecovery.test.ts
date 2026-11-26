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

for (const kind of ["automatic", "deliberate"] as const)
for (const recovery of ["retained", "before-sweep", "after-sweep"] as const)
test(`legacy real-writer pending warning survives failed-owner retention: ${kind} ${recovery}`, async () => {
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(isolated, `lost-owner-${kind}-${recovery}`);
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  let clock = Date.parse("2026-11-14T09:15:00Z");
  setSystemTime(clock);
  const { active, child } = completionFixture(`lost-owner-${kind}-${recovery}`, { sqlite: true, engine: "claude", now: () => clock });
  try {
    const m = await import("./sendFailureNotice");
    const { spawnNoticeMessageId } = await import("@/lib/spawnNotice/sweep");
    const original = acceptSend(active, { text: "completed report",
      clientMessageId: kind === "automatic" ? spawnNoticeMessageId(child.conversationId, "work-turn") : "deliberate-work-message",
      origin: { kind: "agent", role: "reviewer", conversationId: child.conversationId } });
    // Emulate the pre-exclusion reader's namespace view only while the real
    // writer and sweep create/admit the legacy alarm. No alarm rows are
    // fabricated; the stored owner retains its automatic identity throughout.
    const snapshotForOperation = active.registry.deliverySnapshotForOperation.bind(active.registry);
    const legacyReader = spyOn(active.registry, "deliverySnapshotForOperation").mockImplementation(id => {
      const snapshot = snapshotForOperation(id);
      const owner = snapshot.deliveryOperationOwners[original.operationId];
      if (owner) owner.clientMessageId = "legacy-writer-message";
      return snapshot;
    });
    let warning: ReturnType<typeof acceptSend> | null = null;
    try {
      expect(await resolveSendReceipt(original.operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW }))
        .toMatchObject({ state: "failed", resend: "safe", reason: SEND_LOST_REASON });
      await m.sweepSendFailureNotices({ registry: active.registry, assertActive: () => {},
        receipt: id => resolveSendReceipt(id, { registry: active.registry, client: active.client }),
        recipient: () => ({ kind: "deliver", conversationId: child.conversationId, path: child.transcriptPath }),
        deliver: async request => { warning = acceptSend(child, request); return { ok: true }; } });
    } finally { legacyReader.mockRestore(); }
    expect(warning).not.toBeNull();
    const alarm = m.readSendFailureNotice(original.operationId)!;
    expect(alarm).toMatchObject({ state: "pending", recipientConversationId: child.conversationId, reason: SEND_LOST_REASON });
    expect(alarm.suppressSenderWake).toBeUndefined();
    if (recovery !== "retained") {
      for (let i = 0; i < 205; i++) {
        clock += 1_000; setSystemTime(clock);
        const newer = acceptSend(active, { clientMessageId: `newer-failed-${i}` });
        active.journal.transitionOperation(newer.operationId, "failed", { reason: SEND_LOST_REASON });
        active.registry.recordDeliveryOutcome(newer.deliveryId, "failed", SEND_LOST_REASON, "lost");
      }
      active.registry.compactDeliveryReservations();
    }
    expect(!!snapshotForOperation(original.operationId).deliveryOperationOwners[original.operationId]).toBe(recovery === "retained");
    const childProcess = Bun.spawn([process.execPath, "--eval", `
      const { setSystemTime } = await import("bun:test"); setSystemTime(new Date(${clock}));
      const { AgentRegistry } = await import(${JSON.stringify(new URL("../agent/registry.ts", import.meta.url).pathname)});
      const { RuntimeJournal } = await import(${JSON.stringify(new URL("../../runtime-host/journal.ts", import.meta.url).pathname)});
      const { StructuredDeliveryQueue } = await import(${JSON.stringify(new URL("./structuredDeliveryQueue.ts", import.meta.url).pathname)});
      const { sendIsSettled, sendReceiptFor } = await import(${JSON.stringify(new URL("./sendSettlement.ts", import.meta.url).pathname)});
      const m = await import(${JSON.stringify(new URL("./sendFailureNotice.ts", import.meta.url).pathname)});
      const registry = new AgentRegistry(${JSON.stringify(active.registryPath)}, undefined, undefined,
        { sqliteMode: "sqlite", sqliteFilename: ${JSON.stringify(active.registryPath.replace(/\.json$/, ".sqlite"))} });
      const journal = new RuntimeJournal(${JSON.stringify(path.join(path.dirname(active.registryPath), "runtime.sqlite"))}, { structuredHosts: true });
      let started = 0;
      const sweep = () => m.sweepSendFailureNotices({ registry, assertActive: () => {},
        receipt: async id => sendReceiptFor(registry.deliverySnapshotForOperation(id), id),
        recipient: () => { throw Error("an admitted warning resolved another recipient"); },
        fallback: () => ({ kind: "deliver", conversationId: ${JSON.stringify(active.conversationId)} }),
        deliver: async () => { throw Error("an admitted warning was resent"); } });
      try {
        if (${JSON.stringify(recovery)} !== "before-sweep") await sweep();
        const operationId = ${JSON.stringify(warning!.operationId)};
        const host = { health: async () => (${JSON.stringify(idleState(child.generationId))}),
          send: async () => { started++; return { outcome: "turn-started", turnId: "warning-turn" }; },
          interrupt: async () => {}, answer: async () => {}, release: async () => {} };
        const queue = new StructuredDeliveryQueue({
          effects: async () => journal.effectBatch(100).filter(effect => effect.payload.operationId === operationId),
          status: async id => journal.operationResult(id)?.receipt ?? null,
          settled: id => sendIsSettled(registry.deliverySnapshotForOperation(id), id) || m.sendFailureWarningSuppressed(registry, id),
          transition: async (id, status, details) => journal.transitionOperation(id, status, details),
        }, () => host);
        await queue.drain();
        await sweep(); await sweep();
        console.log(JSON.stringify({ started, alarm: m.readSendFailureNotice(${JSON.stringify(original.operationId)}),
          senderSignals: m.sendFailureSignals(${JSON.stringify(child.conversationId)}),
          launcherSignals: m.sendFailureSignals(${JSON.stringify(active.conversationId)}) }));
      } finally { registry.close(); journal.close(); }
    `], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(childProcess.stdout).text(), new Response(childProcess.stderr).text(), childProcess.exited]);
    expect(exit, stderr).toBe(0);
    const observed = JSON.parse(stdout);
    expect(observed.started).toBe(kind === "deliberate" && recovery === "retained" ? 1 : 0);
    if (recovery !== "retained") {
      expect(observed.alarm).toMatchObject({ state: "failed", suppressSenderWake: true, text: alarm.text });
      expect(observed.alarm.reason).toContain(SEND_LOST_REASON);
      expect(observed.alarm.reason).toContain("delivery record unavailable");
      expect(observed.senderSignals).toHaveLength(1);
      expect(observed.launcherSignals).toHaveLength(1);
    } else if (kind === "automatic") expect(observed.alarm.state).toBe("cancelled");
  } finally {
    active.registry.close(); active.close(); setSystemTime();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  }
});

test("retention during an awaited warning receipt surfaces the alarm without admission", async () => {
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(isolated, "warning-receipt-retention-race");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  let clock = Date.parse("2026-11-14T09:18:00Z");
  setSystemTime(clock);
  const { active, child } = completionFixture("warning-receipt-retention-race", { sqlite: true, now: () => clock });
  try {
    const m = await import("./sendFailureNotice");
    const original = acceptSend(active, { clientMessageId: "deliberate-before-retention",
      origin: { kind: "agent", role: "reviewer", conversationId: child.conversationId } });
    const receipt = await resolveSendReceipt(original.operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
    expect(receipt).toMatchObject({ state: "failed", reason: SEND_LOST_REASON });
    let reads = 0;
    await m.sweepSendFailureNotices({ registry: active.registry, assertActive: () => {},
      receipt: async () => {
        reads++;
        await Promise.resolve();
        for (let i = 0; i < 205; i++) {
          clock += 1_000; setSystemTime(clock);
          const newer = acceptSend(active, { clientMessageId: `race-newer-failed-${i}` });
          active.journal.transitionOperation(newer.operationId, "failed", { reason: SEND_LOST_REASON });
          active.registry.recordDeliveryOutcome(newer.deliveryId, "failed", SEND_LOST_REASON, "lost");
        }
        active.registry.compactDeliveryReservations();
        expect(active.registry.deliverySnapshotForOperation(original.operationId).deliveryOperationOwners[original.operationId]).toBeUndefined();
        return receipt;
      },
      recipient: () => { throw Error("retained snapshot allowed recipient lookup"); },
      deliver: async () => { throw Error("retained snapshot admitted a warning"); } });
    expect(reads).toBe(1);
    expect(m.readSendFailureNotice(original.operationId)).toMatchObject({ state: "failed", suppressSenderWake: true });
    expect(m.sendFailureSignals(child.conversationId)).toHaveLength(1);
  } finally {
    active.registry.close(); active.close(); setSystemTime();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  }
});

test("a truly failed automatic completion notice stays surfaced without waking its child", async () => {
  setSystemTime(new Date("2026-11-14T09:20:00Z"));
  const { active, child } = completionFixture("failed-completion-notice", { sqlite: true });
  try {
    const store = await import("@/lib/spawnNotice/store");
    const { sweepSpawnNotices } = await import("@/lib/spawnNotice/sweep");
    const { readSendFailureNotice } = await import("./sendFailureNotice");
    store.recordSpawnNoticeObligation({ childConversationId: child.conversationId, launcherConversationId: active.conversationId,
      turnId: "failed-work-turn", outcome: "completed", startedAt: null, endedAt: new Date().toISOString() });
    let calls = 0;
    let operationId = "";
    const ports: import("@/lib/spawnNotice/sweep").SpawnNoticeSweepPorts = {
      now: Date.now, pending: () => store.pendingSpawnNotices().filter(row => row.childConversationId === child.conversationId),
      childRecord: store.readSpawnNoticeChild, child: async () => ({ title: "Reviewer", busy: false }),
      recipient: () => ({ kind: "deliver", conversationId: active.conversationId, path: active.transcriptPath }),
      finalMessage: () => ({ text: "Review complete", error: null }),
      origin: () => ({ kind: "agent", role: "reviewer", conversationId: child.conversationId }),
      recordAttempt: store.recordSpawnNoticeAttempt, settle: store.settleSpawnNotices,
      deliver: async request => {
        calls++;
        operationId = acceptSend(active, request).operationId;
        // The transport never dispatches this operation. Existing settlement
        // fences the lost send and the notice sweep surfaces its failure.
        const answer = await resolveSendReceipt(operationId, { registry: active.registry, client: active.client, now: AFTER_THE_WINDOW });
        expect(answer).toMatchObject({ state: "failed", resend: "safe", reason: SEND_LOST_REASON });
        return { ok: false, error: answer!.reason!, uncertain: false };
      },
    };
    await sweepSpawnNotices(ports);
    await sweepSpawnNotices(ports);
    expect(calls).toBe(1);
    expect(store.readSpawnNoticeTurn(child.conversationId, "failed-work-turn")).toMatchObject({ state: "failed", reason: SEND_LOST_REASON });
    expect(await resolveSendReceipt(operationId, { registry: active.registry, client: active.client })).toMatchObject({ state: "failed", reason: SEND_LOST_REASON });
    expect(readSendFailureNotice(operationId)).toBeNull();
  } finally { active.registry.close(); active.close(); setSystemTime(); }
});
