import { parseCodexFeatures, setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { AccountContext } from "./accounts/contracts";
import { AgentRegistry, setAgentRegistryForTests, type ConversationObservation } from "./agent/registry";
import { emptyLaunchProfile } from "./accounts/migration/contracts";
import { drainHeldDeliveries } from "./accounts/migration/coordinator";
import { deliverConversationMessage, migrationDeliveryOutcome, resumeConversation, type DeliveryFailure } from "./delivery";
import { withConversationActuation } from "./deliveryActuation";
import { defaultPipelinePorts } from "./pipelines/engine";
import type { RuntimeHostClient } from "./runtime/client";
import { recoverDeadStructuredConversation, StructuredResumeUnpublishedError } from "./runtime/structuredRecovery";
import type { FileEntry } from "./types";

// Command/control tests use a fake interpreter and its explicit inventory.
let restoreFeatureReader: () => void;
beforeEach(() => {
  restoreFeatureReader = setCodexFeatureReaderForTest(() => parseCodexFeatures(
    "multi_agent stable true\nmulti_agent_v2 stable true\nfuture_worker experimental true",
  ));
});
afterEach(() => restoreFeatureReader());

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-test-"));
const failure: DeliveryFailure = { ok: false, outcome: "failed", error: "resume unavailable", status: 503 };

beforeEach(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
});

afterEach(() => setAgentRegistryForTests(null));

afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

test("migration delivery keeps an internally held result recoverable", () => {
  expect(migrationDeliveryOutcome({ ok: true, target: "conversation_held", outcome: "held" })).toBe("held");
  expect(migrationDeliveryOutcome({ ok: true, target: "pane" })).toBe("delivered");
  expect(migrationDeliveryOutcome(failure)).toBe("failed");
  expect(migrationDeliveryOutcome({ ...failure, actuation: "started" as const })).toBe("delivery-uncertain");
});

test("a definitively unpublished resume returns a typed unsent failure to seat recovery", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "unpublished-resume-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  let recoveryOrigin: unknown;
  const outcome = await deliverConversationMessage({ pid: null, path: "", conversationId: conversation.id,
    clientMessageId: "owed-seat-wake", text: "wake", images: [], origin: { kind: "agent", role: "seat-tick" },
  }, { recover: async request => {
    recoveryOrigin = request.origin;
    throw new StructuredResumeUnpublishedError("replacement host did not publish");
  } });
  expect(outcome).toEqual({ ok: false, outcome: "failed", status: 503,
    code: "structured_revival_impossible", error: "replacement host did not publish" });
  expect(recoveryOrigin).toEqual({ kind: "agent", role: "seat-tick" });
  expect(Object.values(registry.readOnlySnapshot().heldDeliveries)).toEqual([]);
});

test("structured resume recovery returns a pane-less target", async () => {
  const sessionId = "019f4e76-66b4-\x37f87-94b2-cfa9bf744444";
  const pathname = path.join(SANDBOX, `${sessionId}.jsonl`);
  fs.writeFileSync(pathname, "");
  const registry = new AgentRegistry(path.join(SANDBOX, "structured-resume-registry.json"));
  let recoveryCalls = 0;

  const outcome = await resumeConversation(pathname, {
    pathAllowed: () => true,
    registry,
    recover: async () => {
      recoveryCalls += 1;
      return {
        target: null,
        path: pathname,
        conversationId: "conversation_structured_resume",
        spawned: true,
      };
    },
    listFiles: async () => [],
  });

  expect(outcome).toMatchObject({
    ok: true,
    target: null,
    outcome: "resumed",
    spawned: true,
    structured: true,
  });
  expect(recoveryCalls).toBe(1);
});

test("dead structured send recovery delivers through the new host", async () => {
  const sessionId = "019f4e76-66b4-\x37f87-94b2-cfa9bf755555";
  const pathname = path.join(SANDBOX, `${sessionId}.jsonl`);
  fs.writeFileSync(pathname, "");
  const registry = new AgentRegistry(path.join(SANDBOX, "structured-send-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", pathname, "retained-account");
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath: pathname,
    cwd: SANDBOX,
    accountId: "retained-account",
    launchProfile: emptyLaunchProfile({ cwd: SANDBOX }),
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 3,
      protocolVersion: "v2",
      writerClaimEpoch: 2,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 2,
    claimOwner: null,
    pendingAction: null,
  });
  let recoveryCalls = 0;
  const enqueued: unknown[] = [];

  const outcome = await deliverConversationMessage({
    pid: null,
    path: pathname,
    conversationId: conversation.id,
    clientMessageId: "dead-send-one",
    text: "deliver after recovery",
    images: [],
  }, {
    recover: async () => {
      recoveryCalls += 1;
      return { target: null, path: pathname, conversationId: conversation.id, spawned: true };
    },
    enqueueStructured: async (request: unknown) => {
      enqueued.push(request);
      return {
        ok: true,
        structured: true,
        target: conversation.id,
        outcome: "queued",
        operationId: "dead-send-operation-one",
        receipt: {
          operationId: "dead-send-operation-one",
          idempotencyKey: "dead-send-one",
          conversationId: conversation.id,
          kind: "send",
          status: "queued",
          at: "2026-07-15T00:00:00.000Z",
          revision: 1,
        },
      };
    },
  } as never);

  expect(recoveryCalls).toBe(1);
  expect(enqueued).toMatchObject([{
    path: pathname,
    conversationId: conversation.id,
    clientMessageId: "dead-send-one",
    text: "deliver after recovery",
  }]);
  expect(outcome).toMatchObject({
    ok: true,
    target: null,
    outcome: "queued",
    structured: true,
    spawned: true,
    receipt: { status: "queued" },
  });
});

test.each(["codex", "claude"] as const)("%s send creates one structured successor with verified ownership after termination and no duplicate delivery", async (engine) => {
  const sessionId = crypto.randomUUID();
  const pathname = path.join(SANDBOX, `${sessionId}.jsonl`);
  const accountId = `${engine}-successor-account`;
  const profile = emptyLaunchProfile({
    cwd: SANDBOX,
    model: `${engine}-retained-model`,
    effort: "high",
    title: `Continue ${engine} delivery ownership`,
    readOnly: engine === "codex",
    permissionMode: engine === "codex" ? "never" : "default",
    allowSubagents: true,
  });
  const key = { engine, sessionId } as const;
  const registry = new AgentRegistry(path.join(SANDBOX, `${engine}-successor-registry.json`), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  fs.writeFileSync(pathname, "");
  const begun = registry.beginSpawnRequest({
    engine,
    cwd: SANDBOX,
    transport: "structured",
    accountId,
    expectedArtifactPath: pathname,
    launchProfile: profile,
  });
  if (begun.kind !== "created") throw new Error("structured receipt was unavailable");
  const structuredKind = engine === "codex" ? "codex-app-server" : "claude-broker";
  const initialProcess = { pid: process.pid, startIdentity: null };
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key,
    artifactPath: pathname,
    cwd: SANDBOX,
    accountId,
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: structuredKind,
      endpoint: `stdio:${engine}-initial`,
      process: initialProcess,
      eventCursor: 1,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${engine}-initial`,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured receipt did not settle");
  const account: AccountContext = {
    engine,
    accountId,
    kind: "managed",
    home: path.join(SANDBOX, `${engine}-home`),
    transcriptRoot: SANDBOX,
    env: { NODE_ENV: "test" },
  };
  const structuredSends: Array<{ clientMessageId: string | null; text: string }> = [];
  let structuredSpawns = 0;
  const recover = (request: Parameters<typeof recoverDeadStructuredConversation>[0]) => recoverDeadStructuredConversation(request, {
    registry,
    client: {} as RuntimeHostClient,
    transportAvailable: () => true,
    resolveAccount: (resolvedEngine, resolvedAccountId) => {
      expect(resolvedEngine).toBe(engine);
      expect(resolvedAccountId).toBe(accountId);
      return account;
    },
    spawn: async (input) => {
      structuredSpawns += 1;
      expect(input.receipt).toMatchObject({
        conversationId: begun.receipt.conversationId,
        purpose: "resume-successor",
        transport: "structured",
        accountId,
      });
      expect(input.spec).toMatchObject({
        cwd: SANDBOX,
        engine,
        "transcript": pathname,
        launchProfile: profile,
      });
      const successor = registry.stageStructuredSpawn(input.receipt.launchId, {
        key,
        artifactPath: pathname,
        cwd: SANDBOX,
        accountId,
        launchProfile: profile,
        status: "idle",
        host: null,
        structuredHost: {
          kind: structuredKind,
          endpoint: `stdio:${engine}-successor`,
          process: { pid: process.pid, startIdentity: null },
          eventCursor: 2,
          protocolVersion: "v2",
          writerClaimEpoch: 2,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        },
        claimEpoch: 2,
        claimOwner: `structured-host:${engine}-successor`,
        pendingAction: "spawn",
      });
      if (successor.kind !== "settled") throw new Error("structured successor did not stage");
      expect(fs.readFileSync(pathname, "utf8")).toBe("");
      expect(defaultPipelinePorts().spawnReceipt(input.receipt.launchId)).toMatchObject({
        state: "path-pending",
        sessionId: null,
        "transcript": null,
      });
      fs.writeFileSync(pathname, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`);
      const finalized = registry.finalizeStructuredSpawn(input.receipt.launchId);
      if (finalized.kind !== "settled") throw new Error("structured successor did not finalize");
      expect(defaultPipelinePorts().spawnReceipt(input.receipt.launchId)).toMatchObject({
        state: "completed",
        sessionId,
        "transcript": pathname,
      });
      return {
        ok: true,
        target: null,
        path: pathname,
        launchId: input.receipt.launchId,
        conversationId: begun.receipt.conversationId,
        launched: true,
        retrySafe: false,
        initialMessage: "delivered" as const,
        state: "settled",
      };
    },
  });
  const deliveryOverrides = {
    recover,
    enqueueStructured: async (request: { text: string; clientMessageId?: string | null }) => {
      structuredSends.push({ clientMessageId: request.clientMessageId ?? null, text: request.text });
      const idempotencyKey = request.clientMessageId ?? `${engine}-successor-message`;
      const operationId = `${idempotencyKey}-operation`;
      return {
        ok: true,
        structured: true,
        target: begun.receipt.conversationId,
        outcome: "delivered",
        operationId,
        receipt: {
          operationId,
          idempotencyKey,
          conversationId: begun.receipt.conversationId,
          kind: "send",
          status: "delivered",
          at: "2026-07-15T00:00:00.000Z",
          revision: 1,
        },
      } as const;
    },
  };

  const initialDelivery = await deliverConversationMessage({
    pid: null,
    path: pathname,
    conversationId: begun.receipt.conversationId,
    clientMessageId: `${engine}-initial-message`,
    text: "deliver to the initial structured owner",
    images: [],
  }, deliveryOverrides as never);

  expect(initialDelivery).toMatchObject({
    ok: true,
    outcome: "delivered",
    target: begun.receipt.conversationId,
    structured: true,
    spawned: false,
    receipt: { status: "delivered" },
  });
  expect(structuredSends).toEqual([{
    clientMessageId: `${engine}-initial-message`,
    text: "deliver to the initial structured owner",
  }]);
  expect(structuredSpawns).toBe(0);

  expect(registry.terminateStructuredHost(key, { ...initialProcess, startIdentity: "replacement" })).toBe(false);
  expect(registry.readOnlySnapshot().entries[`${engine}:${sessionId}`]).toMatchObject({
    structuredHost: { process: initialProcess },
    claimOwner: `structured-host:${engine}-initial`,
  });
  expect(registry.terminateStructuredHost(key, initialProcess)).toBe(true);
  expect(registry.readOnlySnapshot().entries[`${engine}:${sessionId}`]).toMatchObject({
    status: "dead",
    structuredHost: null,
    claimOwner: null,
  });

  const structuredDelivery = await deliverConversationMessage({
    pid: null,
    path: pathname,
    conversationId: begun.receipt.conversationId,
    clientMessageId: `${engine}-structured-message`,
    text: "deliver to the structured successor",
    images: [],
  }, deliveryOverrides as never);

  expect(structuredDelivery).toMatchObject({
    ok: true,
    outcome: "delivered",
    target: null,
    structured: true,
    spawned: true,
    receipt: { status: "delivered" },
  });
  expect(structuredSends).toEqual([
    {
      clientMessageId: `${engine}-initial-message`,
      text: "deliver to the initial structured owner",
    },
    {
      clientMessageId: `${engine}-structured-message`,
      text: "deliver to the structured successor",
    },
  ]);
  expect(structuredSpawns).toBe(1);
  const snapshot = registry.readOnlySnapshot();
  expect(snapshot.entries[`${engine}:${sessionId}`]).toMatchObject({
    key,
    structuredHost: {
      endpoint: `stdio:${engine}-successor`,
      process: { pid: process.pid, startIdentity: null },
      writerClaimEpoch: 2,
    },
    claimEpoch: 2,
    claimOwner: `structured-host:${engine}-successor`,
  });
  expect(Object.values(snapshot.receipts).filter((receipt) => (
    receipt.conversationId === begun.receipt.conversationId && receipt.purpose === "resume-successor"
  ))).toHaveLength(1);
});

test("image-only reservations stay request-local and never drain without the client payload", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "image-reservation-registry.json"));
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/image-only.jsonl",
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  const conversation = registry.conversationForPath(observation.path)!;
  const queued = registry.holdDelivery(conversation.id, "", "image-only", "ephemeral-images");
  expect(queued).toMatchObject({ state: "assigned", text: "", payloadKind: "ephemeral-images" });
  let delivered = 0;

  await drainHeldDeliveries(conversation.id, { async deliver() { delivered += 1; return "delivered"; } }, registry);

  expect(delivered).toBe(0);
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([
    { state: "failed", text: "", payloadKind: "ephemeral-images", error: "request-local delivery requires client retry" },
  ]);
});

test("a reservation the migration drain claimed recovers into a structured send that continues the drain's section with its lease (#1709)", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-lease-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const handed: unknown[] = [];
  const outcome = await withConversationActuation(conversation.id, (lease) => deliverConversationMessage({
    pid: null, path: "", conversationId: conversation.id, text: "held for the drain", images: [], clientMessageId: "drain-lease", reservedDeliveryId: "reserved-by-drain",
  }, {
    actuationLease: lease,
    recover: async () => ({ path: "/recovered.jsonl", conversationId: conversation.id, spawned: false }) as never,
    enqueueStructured: (async (_request: unknown, dependencies: { actuationLease?: unknown }) => {
      handed.push(dependencies.actuationLease === lease);
      /* With that lease the structured send's own section runs at once, inside the drain's. */
      return withConversationActuation(conversation.id, async () => ({ ok: true, structured: true, target: conversation.id, outcome: "queued", operationId: "op-drain-lease" }), dependencies.actuationLease as never);
    }) as never,
  }));
  expect(handed).toEqual([true]);
  expect(outcome).toMatchObject({ ok: true });
});

test("delivered reservations retain only a bounded idempotency window", () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "delivery-tombstones-registry.json"));
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/bounded-delivery.jsonl",
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  const conversation = registry.conversationForPath(observation.path)!;
  const generationId = conversation.generations.at(-1)!.id;
  for (let index = 0; index < 105; index += 1) {
    const queued = registry.holdDelivery(conversation.id, `message body ${index}`, `message-${index}`);
    registry.beginDeliveryAttempt(queued.id, generationId);
    registry.recordDeliveryOutcome(queued.id, "delivered");
  }

  const tombstones = Object.values(registry.snapshot().heldDeliveries);
  expect(tombstones).toHaveLength(100);
  expect(tombstones.every((delivery) => delivery.state === "delivered" && delivery.text === "")).toBe(true);
  expect(registry.holdDelivery(conversation.id, "message body 104", "message-104")).toMatchObject({ state: "delivered", text: "" });
  expect(() => registry.holdDelivery(conversation.id, "changed body", "message-104"))
    .toThrow("client message id is already reserved for another request");
});

test("an image-only migration race stays recoverable without an orphan reservation", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "image-race-registry.json"));
  setAgentRegistryForTests(registry);
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/image-race.jsonl",
    accountId: "managed",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  registry.commitMigrationIntent({
    engine: "codex", targetId: "default", origin: "manual", requestId: "image-race",
    expectedRevision: registry.engineRouting("codex").revision, scope: "all",
  });
  const outcome = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "",
    images: [{ base64: "aW1hZ2U=", mime: "image/png" }],
    clientMessageId: "image-race-message",
  });

  expect(outcome).toMatchObject({ ok: false, status: 409 });
  expect(Object.values(registry.snapshot().heldDeliveries)).toHaveLength(0);
  expect(fs.readdirSync(SANDBOX).some((name) => name.endsWith(".png"))).toBe(false);
});

test("switching engine routing leaves deferred transcript ownership unchanged", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "registry.json"));
  setAgentRegistryForTests(registry);
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/deferred-history.jsonl",
    accountId: "managed",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  const conversation = registry.conversationForPath(observation.path)!;
  registry.setEngineRouting("codex", "default");

  const outcome = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "Continue this conversation",
    images: [],
    clientMessageId: "lazy-message",
  });

  expect(outcome).not.toMatchObject({ ok: true, outcome: "held" });
  expect(registry.conversationForPath(observation.path)?.migration).toBeNull();
  expect(registry.conversationForPath(observation.path)?.generations.at(-1)?.accountId).toBe("managed");
  expect(registry.pendingDeliveries(conversation.id)).toHaveLength(0);
});

test("routing changes leave busy and unknown turns on their current generation", async () => {
  for (const turnState of ["busy", "unknown"] as const) {
    const registry = new AgentRegistry(path.join(SANDBOX, `${turnState}-registry.json`));
    setAgentRegistryForTests(registry);
    const observation: ConversationObservation = {
      engine: "codex",
      path: `/${turnState}-history.jsonl`,
      accountId: "managed",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
      turn: { state: turnState, source: "lifecycle", terminalAt: null },
      observedAt: "2026-07-11T10:00:00.000Z",
    };
    registry.reconcileConversations([observation]);
    registry.setEngineRouting("codex", "default");

    const outcome = await deliverConversationMessage({
      pid: null,
      path: observation.path,
      text: "Continue the active turn",
      images: [],
      clientMessageId: `during-${turnState}-turn`,
    });

    expect(outcome).not.toMatchObject({ ok: true, outcome: "held" });
    expect(registry.conversationForPath(observation.path)?.migration).toBeNull();
    expect(registry.conversationForPath(observation.path)?.generations.at(-1)?.accountId).toBe("managed");
    expect(registry.pendingDeliveries(registry.conversationForPath(observation.path)!.id)).toHaveLength(0);
  }
});

test("a stopped migration survives restart and unrelated inventory revisions", async () => {
  const filename = path.join(SANDBOX, "registry.json");
  const registry = new AgentRegistry(filename);
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/stopped-history.jsonl",
    accountId: "managed",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([
    observation,
    { ...observation, path: "/active-turn.jsonl", turn: { state: "busy", source: "lifecycle", terminalAt: null } },
  ]);
  const intent = registry.commitMigrationIntent({
    engine: "codex",
    targetId: "default",
    origin: "manual",
    requestId: "stopped-switch",
    expectedRevision: registry.engineRouting("codex").revision,
    scope: "active",
  });
  expect(registry.conversationForPath(observation.path)?.migration).toBeNull();
  registry.setMigrationIntentState(intent.id, "stopped", intent.revision);
  const stoppedRevision = registry.engineRouting("codex").revision;
  const unrelated = { ...observation, path: "/unrelated-turn.jsonl" };
  registry.reconcileConversations([unrelated]);
  registry.reconcileConversations([{
    ...unrelated,
    turn: { state: "busy", source: "lifecycle", terminalAt: null },
    observedAt: "2026-07-11T10:01:00.000Z",
  }]);
  const unrelatedKey = { engine: "codex" as const, sessionId: "019f4e76-66b4-\x37f87-94b2-cfa9bf711111" };
  registry.upsert({
    key: unrelatedKey,
    artifactPath: unrelated.path,
    cwd: "/repo",
    accountId: "managed",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.markUnhosted(unrelatedKey);
  expect(registry.engineRouting("codex").revision).toBeGreaterThan(stoppedRevision);

  const restarted = new AgentRegistry(filename);
  setAgentRegistryForTests(restarted);
  const outcome = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "Stay on the source account",
    images: [],
    clientMessageId: "after-stop",
  });

  expect(outcome).not.toMatchObject({ ok: true, outcome: "held" });
  expect(restarted.conversationForPath(observation.path)).toMatchObject({
    migration: null,
    migrationOptOut: { targetId: "default" },
  });
  expect(restarted.pendingDeliveries(restarted.conversationForPath(observation.path)!.id)).toHaveLength(0);
  expect(Object.values(restarted.snapshot().migrationIntents)).toHaveLength(1);

  restarted.commitMigrationIntent({
    engine: "codex",
    targetId: "default",
    origin: "manual",
    requestId: "later-explicit-switch",
    expectedRevision: restarted.engineRouting("codex").revision,
    scope: "active",
  });
  const reenrolled = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "Use the newly selected account",
    images: [],
    clientMessageId: "after-new-switch",
  });
  expect(reenrolled).not.toMatchObject({ ok: true, outcome: "held" });
  expect(restarted.conversationForPath(observation.path)?.migration).toBeNull();
});

test("card-level Keep survives unrelated inventory revisions", async () => {
  const filename = path.join(SANDBOX, "registry.json");
  const registry = new AgentRegistry(filename);
  const observation: ConversationObservation = {
    engine: "codex",
    path: "/kept-history.jsonl",
    accountId: "managed",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-11T10:00:00.000Z",
  };
  registry.reconcileConversations([observation]);
  registry.commitMigrationIntent({
    engine: "codex",
    targetId: "default",
    origin: "manual",
    requestId: "keep-switch",
    expectedRevision: registry.engineRouting("codex").revision,
    scope: "all",
  });
  const conversation = registry.conversationForPath(observation.path)!;
  registry.rollbackConversationMigration(conversation.id, conversation.migration!.revision);
  registry.reconcileConversations([{ ...observation, path: "/unrelated-after-keep.jsonl" }]);
  registry.reconcileConversations([{
    ...observation,
    path: "/unrelated-after-keep.jsonl",
    turn: { state: "busy", source: "lifecycle", terminalAt: null },
    observedAt: "2026-07-11T10:01:00.000Z",
  }]);

  const restarted = new AgentRegistry(filename);
  setAgentRegistryForTests(restarted);
  const outcome = await deliverConversationMessage({
    pid: null,
    path: observation.path,
    text: "Keep using the source account",
    images: [],
    clientMessageId: "after-keep",
  });

  expect(outcome).not.toMatchObject({ ok: true, outcome: "held" });
  expect(restarted.conversationForPath(observation.path)?.migration?.phase).toBe("rolled-back");
  expect(restarted.pendingDeliveries(conversation.id)).toHaveLength(0);
});

test("a send or resume aimed at a superseded round answers 409 with the live chain end (#383)", async () => {
  const sessionId = "019f4e76-66b4-\x37f87-94b2-cfa9bf766666";
  const pathname = path.join(SANDBOX, `${sessionId}.jsonl`);
  fs.writeFileSync(pathname, "");
  const registry = new AgentRegistry(path.join(SANDBOX, "superseded-registry.json"));
  setAgentRegistryForTests(registry);
  const predecessor = registry.ensureConversation("codex", pathname, "a");
  const middle = registry.ensureConversation("codex", path.join(SANDBOX, "middle.jsonl"), "a");
  const tail = registry.ensureConversation("codex", path.join(SANDBOX, "tail.jsonl"), "a");
  registry.recordSupersedence(predecessor.id, middle.id, "recovery-spawn");
  registry.recordSupersedence(middle.id, tail.id, "recovery-spawn");
  let recoveryCalls = 0;
  const recover = async () => {
    recoveryCalls += 1;
    return null;
  };

  const sent = await deliverConversationMessage({
    pid: null,
    path: pathname,
    conversationId: predecessor.id,
    text: "message for a retired round",
    images: [],
  }, { recover });
  expect(sent).toMatchObject({
    ok: false,
    status: 409,
    error: "superseded",
    successorConversationId: tail.id,
  });

  const resumed = await resumeConversation(pathname, {
    pathAllowed: () => true,
    registry,
    recover,
    listFiles: async () => [],
  } as never);
  expect(resumed).toMatchObject({
    ok: false,
    status: 409,
    error: "superseded",
    successorConversationId: tail.id,
  });
  /* The guard fires BEFORE any implicit recovery — a retired round is never
     silently forked by a message. */
  expect(recoveryCalls).toBe(0);
});

test("a transcript another live session owns is refused at registry admission", async () => {
  const sessionId = ["33333333", "3333", "4333", "8333", "333333333333"].join("-");
  const pathname = path.join(SANDBOX, `${sessionId}.jsonl`);
  fs.writeFileSync(pathname, "{}");
  const registry = new AgentRegistry(path.join(SANDBOX, "resume-admission.json"), undefined, undefined, { sqliteMode: "sqlite" });
  let probes = 0;
  try {
    const result = await resumeConversation(pathname, {
      registry, pathAllowed: () => true,
      listFiles: async () => [{ engine: "codex", path: pathname, cwd: "/repo" } as FileEntry],
      recover: async () => null,
      liveOwnership: () => { probes += 1; return "session"; },
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(probes).toBeGreaterThan(0);
    expect(registry.conversationForPath(pathname)).toBeNull();
  } finally { registry.close(); }
});


/* No structured host holds the conversation and recovery raises none: the send
   is refused before anything is reserved, and no terminal transport is tried. */
test("a send to a conversation with no host is refused before anything is reserved", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "no-host-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", path.join(SANDBOX, "no-host.jsonl"), "default");
  let recoveries = 0;

  const outcome = await deliverConversationMessage({
    pid: null, path: "", conversationId: conversation.id, clientMessageId: "no-host-send", text: "continue", images: [],
  }, { recover: async () => { recoveries += 1; return null; } });

  expect(outcome).toEqual({
    ok: false, outcome: "failed", status: 409, admission: "refused",
    code: "no_delivery_host", error: "this conversation has no host to deliver to",
  });
  expect(recoveries).toBe(1);
  expect(Object.values(registry.readOnlySnapshot().heldDeliveries)).toEqual([]);
});

test("a send that names only a pid is refused the same way once its transcript's conversation has no host", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "no-host-pid-registry.json"));
  setAgentRegistryForTests(registry);
  const pathname = path.join(SANDBOX, "rollout-019f4e76-66b4-\x37f87-94b2-cfa9bf745555.jsonl");
  const entry = { path: pathname, engine: "codex", pid: 4242, proc: "running" } as FileEntry;

  const outcome = await deliverConversationMessage({ pid: 4242, path: "", text: "continue", images: [] }, {
    listFiles: async () => [entry],
    recover: async () => null,
  });

  expect(outcome).toMatchObject({ ok: false, status: 409, admission: "refused", code: "no_delivery_host" });
  expect(registry.conversationForPath(pathname)).not.toBeNull();
  expect(Object.values(registry.readOnlySnapshot().heldDeliveries)).toEqual([]);
  expect(await deliverConversationMessage({ pid: 9999, path: "", text: "continue", images: [] }, {
    listFiles: async () => [entry], recover: async () => null,
  })).toMatchObject({ ok: false, status: 403, error: "process is unknown to the viewer" });
});

test("a reservation the drain claimed for a conversation with no host fails and ends its progress record", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "no-host-drain-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", path.join(SANDBOX, "no-host-drain.jsonl"), "default");
  const held = registry.holdDelivery(conversation.id, "continue", "drained-send");
  const settled: unknown[] = [];

  const outcome = await deliverConversationMessage({
    pid: null, path: "", conversationId: conversation.id, clientMessageId: "drained-send", text: "continue", images: [],
    reservedDeliveryId: held.id,
  }, {
    recover: async () => null,
    progress: { settle: (...args: unknown[]) => { settled.push(args); } } as never,
  });

  expect(outcome).toEqual({ ok: false, outcome: "failed", status: 409, error: "this conversation has no host to deliver to" });
  expect(migrationDeliveryOutcome(outcome)).toBe("failed");
  expect(settled).toEqual([[held.command.operationId, "failed", "this conversation has no host to deliver to"]]);
});
