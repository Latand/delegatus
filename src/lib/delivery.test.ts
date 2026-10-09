import { parseCodexFeatures, setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { AccountContext } from "./accounts/contracts";
import { AgentRegistry, setAgentRegistryForTests, type ConversationObservation, type RegistryFile, type TmuxHostEvidence } from "./agent/registry";
import { emptyLaunchProfile, type SuccessorProviderPort } from "./accounts/migration/contracts";
import { drainHeldDeliveries, reconcileMigrations } from "./accounts/migration/coordinator";
import { cleanupFailedImageDelivery, deliverConversationMessage, killConversation, migrationDeliveryOutcome, reconfigureConversation, resumeConversation, type DeliveryFailure } from "./delivery";
import { withConversationActuation } from "./deliveryActuation";
import { defaultPipelinePorts } from "./pipelines/engine";
import type { RuntimeHostClient } from "./runtime/client";
import { heldDeliveryOccurrences } from "./runtime/deliveredMessageOccurrences";
import { messageTextDigest } from "./runtime/messageTextDigest";
import { resolveSendReceipt, sendReceiptFor } from "./runtime/sendSettlement";
import { recoverDeadStructuredConversation } from "./runtime/structuredRecovery";
import type { FileEntry } from "./types";
import { TmuxDeliveryUncertainError } from "./tmux";
import { resumeSpecForSession, type ResumeSpecOptions } from "./agent/cli";
import { beginRegistryResume } from "./agent/transcriptHost";
import { resolveAttachCommand } from "./agent/attachCommand";

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

function inboxImage(name: string): string {
  const pathname = path.join(SANDBOX, name);
  fs.writeFileSync(pathname, "image");
  return pathname;
}

beforeEach(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
});

afterEach(() => setAgentRegistryForTests(null));

afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

test("removes a direct-delivery inbox image before returning its host failure", () => {
  const imagePath = inboxImage("direct.png");

  expect(cleanupFailedImageDelivery(failure, [imagePath])).toEqual(failure);
  expect(fs.existsSync(imagePath)).toBe(false);
});

test("removes a relayed-delivery inbox image before returning its host failure", () => {
  const imagePath = inboxImage("relay.png");

  expect(cleanupFailedImageDelivery(failure, [imagePath])).toEqual(failure);
  expect(fs.existsSync(imagePath)).toBe(false);
});

test("retains an inbox image when transcript-host actuation became ambiguous", () => {
  const imagePath = inboxImage("ambiguous-host.png");
  const ambiguous: DeliveryFailure = { ...failure, actuation: "started" };

  expect(cleanupFailedImageDelivery(ambiguous, [imagePath])).toEqual(ambiguous);
  expect(fs.existsSync(imagePath)).toBe(true);
});

test("migration delivery keeps an internally held result recoverable", () => {
  expect(migrationDeliveryOutcome({ ok: true, target: "conversation_held", outcome: "held" })).toBe("held");
  expect(migrationDeliveryOutcome({ ok: true, target: "pane" })).toBe("delivered");
  expect(migrationDeliveryOutcome(failure)).toBe("failed");
  expect(migrationDeliveryOutcome({ ...failure, actuation: "started" as const })).toBe("delivery-uncertain");
});

test("structured resume recovery returns a pane-less target and skips legacy host delivery", async () => {
  const sessionId = "019f4e76-66b4-\x37f87-94b2-cfa9bf744444";
  const pathname = path.join(SANDBOX, `${sessionId}.jsonl`);
  fs.writeFileSync(pathname, "");
  const registry = new AgentRegistry(path.join(SANDBOX, "structured-resume-registry.json"));
  let legacyHostCalls = 0;
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
    deliver: async () => {
      legacyHostCalls += 1;
      return { ok: true, outcome: "resumed", target: "%9" };
    },
  } as never);

  expect(outcome).toMatchObject({
    ok: true,
    target: null,
    outcome: "resumed",
    spawned: true,
    structured: true,
  });
  expect(recoveryCalls).toBe(1);
  expect(legacyHostCalls).toBe(0);
});

test("dead structured send recovery delivers through the new host with zero tmux commands", async () => {
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
  let tmuxCommands = 0;
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
    targetForKnownPid: async () => {
      tmuxCommands += 1;
      return "%1";
    },
    sendText: async () => {
      tmuxCommands += 1;
    },
  } as never);

  expect(recoveryCalls).toBe(1);
  expect(enqueued).toMatchObject([{
    path: pathname,
    conversationId: conversation.id,
    clientMessageId: "dead-send-one",
    text: "deliver after recovery",
  }]);
  expect(tmuxCommands).toBe(0);
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
    transport: () => "structured",
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

test("idle reconfiguration survives a transient host miss and resumes after verified termination", async () => {
  const sessionId = "019f4e76-66b4-\x37f87-94b2-cfa9bf733333";
  const pathname = path.join(SANDBOX, `${sessionId}.jsonl`);
  fs.writeFileSync(pathname, "");
  const registry = new AgentRegistry(path.join(SANDBOX, "reconfigure-registry.json"));
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key, artifactPath: pathname, cwd: SANDBOX, accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: SANDBOX, role: "worker", readOnly: true, permissionMode: "never", allowSubagents: true }), status: "idle",
    host: KILL_HOST, claimEpoch: 1, claimOwner: null, pendingAction: null,
  });
  const entry: FileEntry = {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer", title: "worker",
    engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 0, activity: "idle",
    proc: "running", pid: KILL_HOST.agent.pid, model: "gpt-5.6-sol", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null,
  };
  let resumed = 0;
  let killed = false;
  let resumePolicy: { readOnly?: boolean | null; permissionMode?: string | null; allowSubagents?: boolean; mcpServers?: readonly string[] } = {};

  const outcome = await reconfigureConversation(pathname, { model: "gpt-5.6-terra", effort: "medium", fast: true }, {
    pathAllowed: () => true,
    listFiles: async () => [entry],
    resumeSpecFor: (_root, _path, options) => {
      resumePolicy = options ?? {};
      return { command: "codex resume", cwd: SANDBOX, windowName: "codex-resume", engine: "codex" };
    },
    livePaneHost: async () => null,
    registry,
    paneScreen: async () => "›\n? for shortcuts",
    killHost: async () => { killed = true; return true; },
    deliver: async () => registry.withOperationLock(key, { pid: process.pid, startIdentity: null }, async () => {
      resumed += 1;
      return killed
        ? { ok: true, outcome: "resumed", target: "%8" }
        : { ok: true, outcome: "delivered-to-live", target: KILL_HOST.paneId };
    }),
  });

  expect(outcome).toMatchObject({ ok: true, outcome: "reconfigured", target: "%8" });
  expect(resumed).toBe(1);
  expect(killed).toBe(true);
  /* The rebuilt command carries the durable MCP grant too (#739): dropping it
     relaunched the session on the baseline while the profile still claimed it. */
  expect(resumePolicy).toMatchObject({ readOnly: true, permissionMode: "never", allowSubagents: true, mcpServers: ["viewer"] });
});

test("legacy account reconfiguration queues a conversation reseat without touching the active pane", async () => {
  const sessionId = "019f4e76-66b4-\x37f87-94b2-cfa9bf744440";
  const pathname = path.join(SANDBOX, `${sessionId}.jsonl`);
  fs.writeFileSync(pathname, "");
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-account-reconfigure-registry.json"));
  const conversation = registry.ensureConversation("codex", pathname, "source-account");
  registry.updateConversationLaunchProfile(conversation.id, { model: "gpt-5.6-sol", effort: "high", fast: false });
  registry.upsert({
    key: { engine: "codex", sessionId }, artifactPath: pathname, cwd: SANDBOX, accountId: "source-account",
    launchProfile: emptyLaunchProfile({ cwd: SANDBOX, model: "gpt-5.6-sol", effort: "high" }), status: "live",
    host: KILL_HOST, claimEpoch: 1, claimOwner: null, pendingAction: null,
  });
  const entry: FileEntry = {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer", title: "worker",
    engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 0, activity: "live",
    proc: "running", pid: KILL_HOST.agent.pid, model: "gpt-5.6-sol", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null,
  };
  let resolved = 0;
  let migrationTicks = 0;
  let killed = 0;

  const outcome = await reconfigureConversation(pathname, {
    model: "gpt-5.6-terra", effort: "medium", fast: true, accountId: "target-account",
  }, {
    pathAllowed: () => true,
    listFiles: async () => [entry],
    registry,
    validateAccount: async () => {},
    resolveAccount: (engine, accountId) => {
      expect([engine, accountId]).toEqual(["codex", "target-account"]);
      resolved += 1;
      return {} as AccountContext;
    },
    requestMigrationTick: () => { migrationTicks += 1; },
    killHost: async () => { killed += 1; return true; },
  });

  expect(outcome).toMatchObject({ ok: true, outcome: "pending" });
  expect(resolved).toBe(1);
  expect(migrationTicks).toBe(1);
  expect(killed).toBe(0);
  expect(registry.conversationForPath(pathname)?.migration).toMatchObject({
    phase: "waiting-turn",
    targetId: "target-account",
  });
  expect(registry.launchProfileForPath(pathname)).toMatchObject({
    model: "gpt-5.6-terra",
    effort: "medium",
    fast: true,
  });
});

test("legacy account reconfiguration leaves the conversation untouched when auth preflight fails", async () => {
  const sessionId = "019f4e76-66b4-\x37f87-94b2-cfa9bf744441";
  const pathname = path.join(SANDBOX, `${sessionId}.jsonl`);
  fs.writeFileSync(pathname, "");
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-account-reconfigure-auth-registry.json"));
  const conversation = registry.ensureConversation("codex", pathname, "source-account");
  registry.updateConversationLaunchProfile(conversation.id, { model: "gpt-5.6-sol", effort: "high", fast: false });
  registry.upsert({
    key: { engine: "codex", sessionId }, artifactPath: pathname, cwd: SANDBOX, accountId: "source-account",
    launchProfile: emptyLaunchProfile({ cwd: SANDBOX, model: "gpt-5.6-sol", effort: "high" }), status: "idle",
    host: KILL_HOST, claimEpoch: 1, claimOwner: null, pendingAction: null,
  });
  const entry: FileEntry = {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer", title: "worker",
    engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 0, activity: "idle",
    proc: "running", pid: KILL_HOST.agent.pid, model: "gpt-5.6-sol", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null,
  };
  let migrationTicks = 0;
  let killed = 0;

  const outcome = await reconfigureConversation(pathname, {
    model: "gpt-5.6-sol", effort: "high", fast: false, accountId: "signed-out-account",
  }, {
    pathAllowed: () => true,
    listFiles: async () => [entry],
    registry,
    validateAccount: async () => { throw new Error("codex account requires authentication"); },
    resolveAccount: () => ({}) as AccountContext,
    requestMigrationTick: () => { migrationTicks += 1; },
    killHost: async () => { killed += 1; return true; },
  });

  expect(outcome).toMatchObject({ ok: false, error: "codex account requires authentication" });
  expect(migrationTicks).toBe(0);
  expect(killed).toBe(0);
  expect(registry.conversationForPath(pathname)?.migration).toBeNull();
  expect(registry.launchProfileForPath(pathname)).toMatchObject({
    model: "gpt-5.6-sol",
    effort: "high",
    fast: false,
  });
});

const KILL_HOST: TmuxHostEvidence = {
  kind: "tmux",
  endpoint: "/run/user/1000/agent-log-viewer",
  server: { pid: 900, startIdentity: "900:one" },
  paneId: "%7",
  panePid: { pid: 107, startIdentity: "107:one" },
  windowName: "worker",
  agent: { pid: 207, startIdentity: "207:one" },
  argv: ["codex", "resume", "session"],
};

function killSnapshot(pathname: string, host: TmuxHostEvidence | null): RegistryFile {
  const registry = new AgentRegistry(path.join(SANDBOX, "kill-registry.json"));
  registry.upsert({
    key: { engine: "codex", sessionId: "019f4e76-66b4-\x37f87-94b2-cfa9bf711111" },
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", role: "worker" }),
    status: "idle",
    host,
    claimEpoch: 3,
    claimOwner: null,
    pendingAction: null,
  });
  return registry.snapshot();
}

test("conversation kill resolves the registry pane id and reports verified success", async () => {
  const pathname = "/transcripts/worker.jsonl";
  const killed: string[] = [];

  const outcome = await killConversation(pathname, {
    pathAllowed: () => true,
    listFiles: async () => [],
    registrySnapshot: () => killSnapshot(pathname, KILL_HOST),
    killHost: async (host) => { killed.push(host.paneId); return true; },
  });

  expect(outcome).toEqual({ ok: true, target: "%7" });
  expect(killed).toEqual(["%7"]);
});

test("conversation kill fails clearly when the registry has no pane", async () => {
  const pathname = "/transcripts/missing.jsonl";

  const outcome = await killConversation(pathname, {
    pathAllowed: () => true,
    listFiles: async () => [],
    registrySnapshot: () => killSnapshot(pathname, null),
  });

  expect(outcome).toEqual({ ok: false, outcome: "failed", error: "no registered agent pane for this conversation", status: 404 });
});

test("conversation kill rejects success when process-death verification fails", async () => {
  const pathname = "/transcripts/stubborn.jsonl";

  const outcome = await killConversation(pathname, {
    pathAllowed: () => true,
    listFiles: async () => [],
    registrySnapshot: () => killSnapshot(pathname, KILL_HOST),
    killHost: async () => false,
  });

  expect(outcome).toEqual({ ok: false, outcome: "failed", error: "the registered pane changed or its process did not exit", status: 409 });
});

test("conversation kill refuses ownership replaced while waiting for the session lock", async () => {
  const pathname = "/transcripts/racing.jsonl";
  const oldSnapshot = killSnapshot(pathname, KILL_HOST);
  const replacement: TmuxHostEvidence = {
    ...KILL_HOST,
    paneId: "%8",
    panePid: { pid: 108, startIdentity: "108:one" },
    agent: { pid: 208, startIdentity: "208:one" },
  };
  const freshSnapshot = structuredClone(oldSnapshot);
  freshSnapshot.entries["codex:019f4e76-66b4-\x37f87-94b2-cfa9bf711111"]!.host = replacement;
  let snapshots = 0;
  const killed: string[] = [];
  const unhosted: string[] = [];
  const registry = {
    readOnlySnapshot: () => snapshots++ === 0 ? oldSnapshot : freshSnapshot,
    withOperationLock: async (_key: unknown, _owner: unknown, task: () => Promise<unknown>) => task(),
    markUnhosted: (key: { sessionId: string }) => { unhosted.push(key.sessionId); },
  };

  const outcome = await killConversation(pathname, {
    pathAllowed: () => true,
    listFiles: async () => [],
    registrySnapshot: () => oldSnapshot,
    registry: registry as never,
    killHost: async (host) => { killed.push(host.paneId); return true; },
  });

  expect(outcome).toMatchObject({ ok: false, status: 409 });
  expect(killed).toEqual([]);
  expect(unhosted).toHaveLength(0);
});

test("conversation kill preserves replacement ownership with matching process fields", async () => {
  const pathname = "/transcripts/owned-before-kill.jsonl";
  const replacementPath = "/transcripts/replacement-owner.jsonl";
  const registry = new AgentRegistry(path.join(SANDBOX, "kill-replacement-registry.json"));
  const key = { engine: "codex" as const, sessionId: "019f4e76-66b4-\x37f87-94b2-cfa9bf722222" };
  registry.upsert({
    key,
    artifactPath: pathname,
    cwd: "/repo",
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", role: "worker" }),
    status: "idle",
    host: KILL_HOST,
    claimEpoch: 3,
    claimOwner: null,
    pendingAction: null,
  });
  const replacement: TmuxHostEvidence = {
    ...KILL_HOST,
    endpoint: "/run/user/1000/replacement-tmux",
    windowName: "replacement-worker",
    argv: ["codex", "exec", "replacement"],
  };

  const outcome = await killConversation(pathname, {
    pathAllowed: () => true,
    listFiles: async () => [],
    registry,
    killHost: async () => {
      const entry = registry.snapshot().entries[`codex:${key.sessionId}`]!;
      registry.upsert({ ...entry, artifactPath: replacementPath, host: replacement, status: "live" });
      return true;
    },
  });

  expect(outcome).toEqual({ ok: true, target: "%7" });
  expect(registry.snapshot().entries[`codex:${key.sessionId}`]).toMatchObject({
    artifactPath: replacementPath,
    status: "live",
    host: replacement,
  });
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

test("large text uses a request-local reservation and still reaches ordinary delivery", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "large-text-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const text = "x".repeat(32_001);
  let delivered = "";
  const outcome = await deliverConversationMessage({
    pid: 1, path: "", conversationId: conversation.id, text, images: [], clientMessageId: "large-text",
  }, {
    targetForKnownPid: async () => "%1",
    sendText: async (_target, payload) => { delivered = payload; },
  });

  expect(outcome.ok).toBe(true);
  expect(delivered).toBe(text);
  expect(registry.holdDelivery(conversation.id, "", "large-text", "ephemeral-text")).toMatchObject({ state: "delivered", text: "" });
});

test("a legacy send is actuated inside its conversation's actuation section, after the work already in it (#1709)", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-section-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const events: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const earlier = withConversationActuation(conversation.id, async () => { events.push("earlier actuation starts"); await released; events.push("earlier actuation ends"); });
  const send = deliverConversationMessage({
    pid: 1, path: "", conversationId: conversation.id, text: "x".repeat(32_001), images: [], clientMessageId: "legacy-in-section",
  }, {
    targetForKnownPid: async () => "%1",
    sendText: async () => { events.push("legacy send actuates"); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toEqual(["earlier actuation starts"]);
  release();
  await earlier;
  expect((await send).ok).toBe(true);
  expect(events).toEqual(["earlier actuation starts", "earlier actuation ends", "legacy send actuates"]);
});

test("a legacy send's recovery runs outside the actuation section; its reservation, claim and actuation wait for it (#1709)", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-narrow-section-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const events: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const holder = withConversationActuation(conversation.id, () => released);
  const send = deliverConversationMessage({
    pid: 1, path: "", conversationId: conversation.id, text: "narrow section", images: [], clientMessageId: "legacy-narrow",
  }, {
    recover: async () => { events.push("recovery checked"); return null; },
    targetForKnownPid: async () => "%1",
    sendText: async () => { events.push("actuated"); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  /* The section is held by someone else: recovery ran, and nothing is reserved until the section is this send's. */
  expect(events).toEqual(["recovery checked"]);
  expect(registry.pendingDeliveries(conversation.id)).toEqual([]);
  release();
  await holder;
  expect((await send).ok).toBe(true);
  expect(events).toEqual(["recovery checked", "actuated"]);
});

test("a queue send to a conversation a legacy pane host owns is typed into that host, never handed to the structured transport", async () => {
  const sessionId = "019f4e76-66b4-\x37f87-94b2-cfa9bf722222";
  const pathname = path.join(SANDBOX, `${sessionId}.jsonl`);
  fs.writeFileSync(pathname, "");
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-queue-policy-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", pathname, "default");
  registry.upsert({
    key: { engine: "codex", sessionId }, artifactPath: pathname, cwd: SANDBOX, accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: SANDBOX, role: "root" }), status: "idle",
    host: KILL_HOST, claimEpoch: 1, claimOwner: null, pendingAction: null,
  });
  const entry: FileEntry = {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer", title: "seat",
    engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 0, activity: "live",
    proc: "running", pid: KILL_HOST.agent.pid, model: "gpt-5.6-sol", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null,
  };
  const typed: string[] = [];
  const outcome = await deliverConversationMessage({
    pid: null, path: pathname, conversationId: conversation.id, text: "seat wake", images: [], clientMessageId: "seat-tick:legacy-pane:1", policy: "queue",
  }, {
    /* The real recovery, which answers null for a legacy owner, so the policy never reaches a structured host. */
    recover: (request) => recoverDeadStructuredConversation(request, { registry, client: {} as RuntimeHostClient, transport: () => "structured" }),
    enqueueStructured: (async () => { throw new Error("a legacy owner must not reach the structured transport"); }) as never,
    pathAllowed: () => true,
    listFiles: async () => [entry],
    resumeSpecFor: () => ({ command: "codex", args: [], cwd: SANDBOX, env: {} }) as never,
    deliver: async ({ payload }) => { typed.push(payload); return { ok: true, outcome: "delivered-to-live" as const, target: "%7" }; },
  });

  expect(outcome).toMatchObject({ ok: true });
  expect(typed).toEqual(["seat wake"]);
  expect(Object.values(registry.readOnlySnapshot().heldDeliveries).map((item) => [item.clientMessageId, item.state]))
    .toEqual([["seat-tick:legacy-pane:1", "delivered"]]);
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

/** The ordinary migration tick, with nothing to switch and nothing it may deliver or write to a board. */
const tickWhileWaiting = (registry: AgentRegistry) => reconcileMigrations(
  { async create() { throw new Error("no switch in this fixture"); }, async verify() { throw new Error("no switch in this fixture"); } } satisfies SuccessorProviderPort,
  { async deliver() { throw new Error("the tick must not deliver this send"); } },
  registry,
  { remapBoardPaths: () => { throw new Error("no board repair in this fixture"); }, transferBoardPathPlacements: () => { throw new Error("no board repair in this fixture"); } },
);

test("a migration tick while a legacy text send waits for its section cannot cancel it: the send delivers its own text and records it delivered (#1709)", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-wait-tick-text-registry.json"));
  setAgentRegistryForTests(registry);
  /* No owner evidence: the tick cancels an unclaimed reservation of this conversation and blanks its text. */
  const conversation = registry.ensureConversation("codex", "", "default");
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const holder = withConversationActuation(conversation.id, () => released);
  const sent: string[] = [];
  const send = deliverConversationMessage({
    pid: 1, path: "", conversationId: conversation.id, text: "the instruction as it was sent", images: [], clientMessageId: "legacy-wait-tick-text",
  }, {
    recover: async () => null,
    targetForKnownPid: async () => "%1",
    sendText: async (_target, payload) => { sent.push(payload); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await tickWhileWaiting(registry);
  release();
  await holder;

  const outcome = await send;
  expect(outcome).toEqual({ ok: true, target: "%1" });
  expect(sent).toEqual(["the instruction as it was sent"]);
  expect(Object.values(registry.readOnlySnapshot().heldDeliveries).map((item) => [item.clientMessageId, item.state, item.attempts]))
    .toEqual([["legacy-wait-tick-text", "delivered", 1]]);
});

test("a migration tick while a legacy image send waits for its section cannot fail it: the send gets past its claim and delivers (#1709)", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-wait-tick-image-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  /* Owner evidence: the tick drains this conversation, and fails an unclaimed request-local reservation it finds. */
  (registry as unknown as { mutate(fn: (file: RegistryFile) => void): void }).mutate((file) => {
    file.conversations[conversation.id]!.generations.at(-1)!.host = { kind: "codex-app-server", identity: "owned-image-host", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" };
  });
  const imagePath = inboxImage("waiting-owned.png");
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const holder = withConversationActuation(conversation.id, () => released);
  const sent: string[] = [];
  const send = deliverConversationMessage({
    pid: 1, path: "", conversationId: conversation.id, text: "", images: [{ base64: "aW1hZ2U=", mime: "image/png" }], clientMessageId: "legacy-wait-tick-image",
  }, {
    recover: async () => null,
    targetForKnownPid: async () => "%1",
    buildImagePayload: () => ({ payload: imagePath, imagePaths: [imagePath] }),
    sendText: async (_target, payload) => { sent.push(payload); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await tickWhileWaiting(registry);
  release();
  await holder;

  const outcome = await send;
  expect(outcome).toEqual({ ok: true, target: "%1", imagePaths: [imagePath] });
  expect(sent).toEqual([imagePath]);
  expect(Object.values(registry.readOnlySnapshot().heldDeliveries).map((item) => [item.clientMessageId, item.state, item.payloadKind]))
    .toEqual([["legacy-wait-tick-image", "delivered", "ephemeral-images"]]);
});

test("a claim refused on a reservation something else already settled answers with that outcome and leaves the reservation as it is (#1709)", async () => {
  for (const settlement of ["cancelled", "delivered"] as const) {
    let settled: unknown = null;
    class SettlingRegistry extends AgentRegistry {
      /* Settled between the admission and the claim, which is what the tick did to a send waiting outside the section. */
      override beginDeliveryAttempt(id: string): null {
        if (settlement === "cancelled") this.terminalizeHeldDelivery(id, "cancelled before the send claimed it");
        else this.recordDeliveryOutcome(id, "delivered", null, "delivered");
        settled = structuredClone(this.readOnlySnapshot().heldDeliveries[id]);
        return null;
      }
    }
    const registry = new SettlingRegistry(path.join(SANDBOX, `legacy-settled-${settlement}-registry.json`));
    setAgentRegistryForTests(registry);
    const conversation = registry.ensureConversation("codex", "", "default");
    let actuated = false;
    const outcome = await deliverConversationMessage({
      pid: 1, path: "", conversationId: conversation.id, text: "settled elsewhere", images: [], clientMessageId: `legacy-settled-${settlement}`,
    }, {
      recover: async () => null,
      targetForKnownPid: async () => "%1",
      sendText: async () => { actuated = true; },
    });

    expect(actuated).toBe(false);
    const rows = Object.values(registry.readOnlySnapshot().heldDeliveries);
    expect(rows.length).toBe(1);
    expect(structuredClone(rows[0])).toEqual(settled as never);
    if (settlement === "cancelled") {
      expect(outcome).toEqual({ ok: false, outcome: "failed", error: "cancelled before the send claimed it", status: 409 });
      expect(rows[0]).toMatchObject({ state: "failed", text: "", attempts: 0 });
    } else {
      expect(outcome).toEqual({ ok: true, target: conversation.id });
      expect(rows[0]).toMatchObject({ state: "delivered" });
    }
  }
});

test("a legacy send admitted after a message still waiting for this generation is held behind it, not actuated (#1709)", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-order-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const waiting = registry.holdDelivery(conversation.id, "admitted first, still waiting", "legacy-waiting");
  expect(waiting.state).toBe("assigned");
  let actuated = false;
  const outcome = await deliverConversationMessage({
    pid: 1, path: "", conversationId: conversation.id, text: "admitted second", images: [], clientMessageId: "legacy-second",
  }, {
    targetForKnownPid: async () => "%1",
    sendText: async () => { actuated = true; },
  });
  expect(outcome).toMatchObject({ ok: true, outcome: "held" });
  expect(actuated).toBe(false);
  expect(registry.pendingDeliveries(conversation.id).map((item) => [item.clientMessageId, item.state, item.attempts]))
    .toEqual([["legacy-waiting", "assigned", 0], ["legacy-second", "assigned", 0]]);
});

test("an over-32k agent-origin delivery keeps the digest of the delivered text, so it still projects as internal on both engines (#1117)", async () => {
  type Overrides = NonNullable<Parameters<typeof deliverConversationMessage>[1]>;
  for (const engine of ["claude", "codex"] as const) {
    const registry = new AgentRegistry(path.join(SANDBOX, `${engine}-large-relay-registry.json`));
    setAgentRegistryForTests(registry);
    const pathname = path.join(SANDBOX, `${engine}-large-relay-fixture.jsonl`);
    fs.writeFileSync(pathname, "");
    const conversation = registry.ensureConversation(engine, pathname, "default");
    /* Over the 32,000-byte envelope bound: the held record blanks this text
       and keeps only a digest, which must be the digest of what was sent. */
    const text = `Findings for the ${engine} worker, in full:\n${"x".repeat(32_000)}`;
    const clientMessageId = `${engine}-large-relay`;
    let delivered = "";

    const outcome = await deliverConversationMessage({
      pid: 1, path: pathname, conversationId: conversation.id, text, images: [], clientMessageId,
      origin: { kind: "agent", role: "orchestrator" },
    }, {
      recover: async () => null,
      pathAllowed: () => true,
      listFiles: async () => [{ root: `${engine}-sessions`, path: pathname, project: "p", mtime: 0, size: 0 } as unknown as FileEntry],
      resumeSpecFor: (() => ({ command: "resume", transcript: pathname, launchProfile: emptyLaunchProfile() })) as unknown as Overrides["resumeSpecFor"],
      deliver: async ({ payload }: { payload: string }) => {
        delivered = payload;
        return { ok: true as const, outcome: "resumed" as const, target: "%7" };
      },
    });

    expect(outcome).toMatchObject({ ok: true });
    /* Engine input is untouched: the full text went to the host. */
    expect(delivered).toBe(text);
    const snapshot = registry.readOnlySnapshot();
    const record = Object.values(snapshot.heldDeliveries).find((item) => item.clientMessageId === clientMessageId);
    expect(record).toMatchObject({
      state: "delivered",
      payloadKind: "ephemeral-text",
      text: "",
      contentDigest: messageTextDigest(text),
      command: { origin: { kind: "agent", role: "orchestrator" } },
    });
    expect(heldDeliveryOccurrences(pathname, snapshot)).toEqual([{
      textDigest: messageTextDigest(text),
      deliveredAt: record!.deliveredAt!,
      origin: "agent",
      senderRole: "orchestrator",
      clientMessageId,
    }]);
  }
});

test("ordinary delivery on the active account skips the lazy-migration registry write", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "active-account-registry.json"));
  setAgentRegistryForTests(registry);
  registry.setEngineRouting("codex", "default");
  const conversation = registry.ensureConversation("codex", "", "default");
  registry.requestConversationMigrationToActiveAccount = (() => {
    throw new Error("active account should skip migration mutation");
  }) as typeof registry.requestConversationMigrationToActiveAccount;

  const outcome = await deliverConversationMessage({
    pid: 1, path: "", conversationId: conversation.id, text: "fast path", images: [], clientMessageId: "fast-path",
  }, {
    targetForKnownPid: async () => "%1",
    sendText: async () => {},
  });

  expect(outcome.ok).toBe(true);
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

test("pre-actuation payload failure discards the reservation for retry", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "pre-actuation-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const outcome = await deliverConversationMessage({
    pid: 1, path: "", conversationId: conversation.id, text: "", images: [{ base64: "aW1hZ2U=", mime: "image/png" }], clientMessageId: "pre-actuation",
  }, {
    targetForKnownPid: async () => "%1",
    buildImagePayload: () => { throw new Error("payload failed"); },
  });

  expect(outcome).toMatchObject({ ok: false, error: "payload failed" });
  expect(Object.values(registry.snapshot().heldDeliveries)).toHaveLength(0);
});

test("ambiguous actuation is absorbing: the same client request is answered, never typed a second time", async () => {
  /* #1131: the legacy path has no delivery journal, so the reservation left by
     an actuation nobody heard back from is the ONLY record that the message may
     already be in the pane. This request used to be re-delivered here — one
     client retry putting the same instruction in front of an agent twice, on
     the channel that carries deployment control. It is answered from the
     uncertainty instead: one host write, an operation id to ask about, and
     `verify-first`. */
  const registry = new AgentRegistry(path.join(SANDBOX, "ambiguous-actuation-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const imagePath = inboxImage("ambiguous.png");
  let sends = 0;
  const message = {
    pid: 1, path: "", conversationId: conversation.id, text: "", images: [{ base64: "aW1hZ2U=", mime: "image/png" }], clientMessageId: "ambiguous-actuation",
  };
  const outcome = await deliverConversationMessage(message, {
    targetForKnownPid: async () => "%1",
    buildImagePayload: () => ({ payload: imagePath, imagePaths: [imagePath] }),
    sendText: async () => { sends += 1; throw new TmuxDeliveryUncertainError(new Error("transport lost")); },
  });

  /* Captured off the FIRST answer, which is all a caller ever holds: reading it
     out of registry state is something no caller can do, and an id it cannot
     see is an id it cannot ask `message_receipt` about. */
  const operationId = (outcome as { operationId?: string }).operationId ?? "";
  expect(outcome).toMatchObject({
    ok: false,
    error: "transport lost",
    actuation: "started",
    resend: "verify-first",
  });
  expect(operationId).not.toBe("");
  /* The bytes stay: a message that may have been delivered keeps the paths it
     named, so the agent can still open what it was handed. */
  expect(fs.existsSync(imagePath)).toBe(true);
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{ state: "delivery-uncertain" }]);
  expect(() => registry.requeueHeldDelivery(registry.pendingDeliveries(conversation.id)[0]!.id)).toThrow("explicit client retry");
  /* And that id answers: no journal ever held this send, so past the deadline
     the receipt ends it unverified rather than leaving the caller at "failed,
     and now what". */
  expect(await resolveSendReceipt(operationId, {
    registry,
    client: null,
    now: () => Date.now() + 11 * 60_000,
  })).toMatchObject({ operationId, state: "failed", duplicateRisk: true, resend: "verify-first" });
  for (let replayed = 0; replayed < 2; replayed += 1) {
    const replay = await deliverConversationMessage(message, {
      targetForKnownPid: async () => "%1",
      buildImagePayload: () => ({ payload: imagePath, imagePaths: [imagePath] }),
      sendText: async () => { sends += 1; },
    });
    expect(replay).toMatchObject({
      ok: false,
      status: 409,
      actuation: "started",
      operationId,
      resend: "verify-first",
    });
    /* Absorbing: the answer does not change however often the client asks, and
       nothing was typed on either replay. */
    expect(sends).toBe(1);
  }
  /* And the send is still queryable rather than discarded — the settled record
     is what a receipt reads to say the fate is unknown, and what keeps every
     later replay of this request absorbing rather than reviving it. */
  expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{ state: "failed" }]);
  expect(sendReceiptFor(registry.readOnlySnapshot(), operationId)).toMatchObject({
    state: "failed",
    resend: "verify-first",
  });
});

test("reserved delivery reports uncertainty when direct tmux send fails after actuation starts", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "reserved-actuation-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const reserved = registry.holdDelivery(conversation.id, "migration payload", "reserved-actuation");

  const outcome = await deliverConversationMessage({
    pid: 1,
    path: "",
    conversationId: conversation.id,
    reservedDeliveryId: reserved.id,
    text: reserved.text,
    images: [],
  }, {
    targetForKnownPid: async () => "%1",
    sendText: async () => { throw new TmuxDeliveryUncertainError(new Error("post-paste transport lost")); },
  });

  expect(outcome).toMatchObject({ ok: false, error: "post-paste transport lost", actuation: "started" });
  expect(migrationDeliveryOutcome(outcome)).toBe("delivery-uncertain");
});

test("reserved delivery reports a definite failure when tmux rejects before paste", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "reserved-pre-paste-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const reserved = registry.holdDelivery(conversation.id, "migration payload", "reserved-pre-paste");

  const outcome = await deliverConversationMessage({
    pid: 1,
    path: "",
    conversationId: conversation.id,
    reservedDeliveryId: reserved.id,
    text: reserved.text,
    images: [],
  }, {
    targetForKnownPid: async () => "%1",
    sendText: async () => { throw new Error("pane rejected before paste"); },
  });

  expect(outcome).toMatchObject({ ok: false, error: "pane rejected before paste" });
  expect(outcome).not.toHaveProperty("actuation");
  expect(migrationDeliveryOutcome(outcome)).toBe("failed");
});

test("successful actuation retains images when settlement persistence fails", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "settlement-failure-registry.json"));
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", "", "default");
  const imagePath = inboxImage("settled-before-write.png");
  const originalRecord = registry.recordDeliveryOutcome.bind(registry);
  registry.recordDeliveryOutcome = (() => { throw new Error("registry unavailable"); }) as typeof registry.recordDeliveryOutcome;
  try {
    const outcome = await deliverConversationMessage({
      pid: 1, path: "", conversationId: conversation.id, text: "", images: [{ base64: "aW1hZ2U=", mime: "image/png" }], clientMessageId: "settlement-failure",
    }, {
      targetForKnownPid: async () => "%1",
      buildImagePayload: () => ({ payload: imagePath, imagePaths: [imagePath] }),
      sendText: async () => {},
    });
    expect(outcome).toMatchObject({ ok: false, error: "registry unavailable", actuation: "started" });
    expect(migrationDeliveryOutcome(outcome)).toBe("delivery-uncertain");
    expect(fs.existsSync(imagePath)).toBe(true);
    expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{ state: "delivery-uncertain" }]);
  } finally {
    registry.recordDeliveryOutcome = originalRecord;
  }
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

test("a tmux resume rebuilds the command with the conversation's stored MCP grant", async () => {
  /* A plain fixture name: the publication gate reads a real session-id shape as
     a resource identifier, and every lookup here is overridden anyway. */
  const pathname = path.join(SANDBOX, "resume-grant-fixture.jsonl");
  fs.writeFileSync(pathname, "");
  const stored = emptyLaunchProfile({ allowSubagents: true, plugins: ["computer-use"] });
  /* Written past the profile helper on purpose: this stands for the grant a
     conversation carries, whatever the bound of the day admits. */
  const profile = { ...stored, mcpServers: ["viewer", "granted-connector"] };
  const options: { mcpServers?: readonly string[] }[] = [];

  const outcome = await resumeConversation(pathname, {
    pathAllowed: () => true,
    registry: {
      conversationForPath: () => null,
      launchProfileForPath: () => profile,
    },
    recover: async () => null,
    listFiles: async () => [{ root: "codex-sessions", path: pathname, project: "p", mtime: 0, size: 0 } as unknown as FileEntry],
    // Liveness is injected so the case never reads this machine's processes.
    liveOwnership: () => null,
    resumeSpecFor: (_root: string, _path: string, given: { mcpServers?: readonly string[] }) => {
      options.push(given);
      return { command: "resume", transcript: pathname, launchProfile: profile };
    },
    deliver: async () => ({ ok: true, outcome: "resumed", target: "%7" }),
  } as never);

  expect(outcome).toMatchObject({ ok: true });
  /* The grant travels with the resume: omitting it relaunched the session on
     the Viewer baseline while the durable profile still claimed it (#739). */
  expect(options).toHaveLength(1);
  expect(options[0]!.mcpServers).toEqual(["viewer", "granted-connector"]);
});

test("a resume that cannot build a command names the failing condition (issue #935)", async () => {
  const pathname = path.join(SANDBOX, "unresumable-fixture.jsonl");
  fs.writeFileSync(pathname, "");
  const entry = { root: "claude-projects", path: pathname, project: "p", mtime: 0, size: 0, engine: "claude" } as unknown as FileEntry;

  const outcome = await resumeConversation(pathname, {
    pathAllowed: () => true,
    registry: {
      conversationForPath: () => ({ id: "conversation_named", supersededBy: null }),
      launchProfileForPath: () => null,
      transcriptAccountId: () => "account-b",
    },
    recover: async () => null,
    listFiles: async () => [entry],
    resumeSpecFor: () => null,
    resumeEligibility: () => ({ ok: false, reason: "the conversation transcript cannot be read from disk" }),
    deliver: async () => ({ ok: true, outcome: "resumed", target: "%7" }),
  } as never);

  /* The generic "this conversation cannot be resumed" hid an account-ownership
     failure, a missing session id, and an unreadable file behind one string. */
  expect(outcome).toMatchObject({
    ok: false,
    status: 409,
    error: "the conversation transcript cannot be read from disk",
  });
});

async function resumeSpecAccountFor(recorded: string | null, fixture: string): Promise<string | null | undefined> {
  const pathname = path.join(SANDBOX, fixture);
  fs.writeFileSync(pathname, "");
  const entry = { root: "claude-projects", path: pathname, project: "p", mtime: 0, size: 0, engine: "claude" } as unknown as FileEntry;
  const options: { accountId?: string | null }[] = [];

  const outcome = await resumeConversation(pathname, {
    pathAllowed: () => true,
    registry: {
      conversationForPath: () => ({ id: "conversation_recorded", supersededBy: null }),
      launchProfileForPath: () => null,
      transcriptAccountId: () => recorded,
    },
    recover: async () => null,
    listFiles: async () => [entry],
    resumeSpecFor: (_root: string, _path: string, given: { accountId?: string | null }) => {
      options.push(given);
      return { command: "resume", launchProfile: null };
    },
    deliver: async () => ({ ok: true, outcome: "resumed", target: "%7" }),
  } as never);

  expect(outcome).toMatchObject({ ok: true });
  expect(options).toHaveLength(1);
  return options[0]!.accountId;
}

test("a resume passes the conversation's recorded account to the resume spec (issue #935)", async () => {
  /* Under the shared transcript store the path names no owner, so the recorded
     account is the only thing that picks the home the resume runs under. The
     legacy account is the one id every machine has, so this asserts the
     pass-through without naming anybody's account. */
  expect(await resumeSpecAccountFor("default", "recorded-account-fixture.jsonl")).toBe("default");
});

test("a resume whose recorded account this machine no longer has asks the rule instead (#1279)", async () => {
  /* Provenance that resolves to nothing is not continuity: `resumeSpecFor`
     would fall through to the shared-store fallback and answer from the
     engine's ACTIVE account, with neither the project's pool nor any quota
     read. So the automatic rule decides — and this project is unbound, so it
     offers no account and the builder's own fallback stands, unchanged. */
  expect(await resumeSpecAccountFor("account-that-was-retired", "retired-account-fixture.jsonl")).toBeNull();
});

test("message-triggered relaunches carry the stored MCP grant on both the direct and root-relay paths", async () => {
  /* Real session ids: this path goes through the process-wide registry, which
     keys entries by session key rather than by the override object. */
  const branchId = "019f4e76-66b4-\x37f87-94b2-cfa9bf746661";
  const rootId = "019f4e76-66b4-\x37f87-94b2-cfa9bf746662";
  const branchPath = path.join(SANDBOX, `${branchId}.jsonl`);
  const rootPath = path.join(SANDBOX, `${rootId}.jsonl`);
  fs.writeFileSync(branchPath, "");
  fs.writeFileSync(rootPath, "");
  const registry = new AgentRegistry(path.join(SANDBOX, "message-grant-registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  for (const [sessionId, pathname] of [[branchId, branchPath], [rootId, rootPath]] as const) {
    registry.upsert({
      key: { engine: "codex", sessionId }, artifactPath: pathname, cwd: SANDBOX, accountId: "account",
      launchProfile: emptyLaunchProfile({ cwd: SANDBOX, mcpServers: ["viewer"] }), status: "dead",
      host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
    /* The durable profile a relaunch reads hangs off the conversation, so the
       session needs one — an entry row alone is not what it looks up. */
    const conversation = registry.ensureConversation("codex", pathname, "account");
    registry.updateConversationLaunchProfile(conversation.id, { model: "gpt-5.6-sol", effort: "high", fast: false });
  }
  const fileEntry = (pathname: string, parent: string | null): FileEntry => ({
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer",
    title: "grant", engine: "codex", kind: "session", fmt: "codex", parent, mtime: 1, size: 0,
    activity: "idle", proc: null, pid: null, model: "gpt-5.6-sol", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null,
  });
  const seen: { path: string; mcpServers?: readonly string[] }[] = [];
  const overrides = (resumable: (pathname: string) => boolean) => ({
    pathAllowed: () => true,
    listFiles: async () => [fileEntry(branchPath, rootPath), fileEntry(rootPath, null)],
    livePaneHost: async () => null,
    resumeSpecFor: (_root: string, pathname: string, given: { mcpServers?: readonly string[] }) => {
      seen.push({ path: pathname, mcpServers: given.mcpServers });
      return resumable(pathname)
        ? { command: "codex resume", cwd: SANDBOX, windowName: "codex-resume", engine: "codex" }
        : null;
    },
    deliver: async () => ({ ok: true, outcome: "resumed", target: "%4" }),
  });

  /* The dead session reopens as its own window: its own grant travels with it,
     rather than the command falling back to the baseline (#739). */
  const direct = await deliverConversationMessage({ path: branchPath, text: "reopen", images: [] } as never, overrides(() => true) as never);
  expect(direct).toMatchObject({ ok: true });
  expect(seen).toEqual([{ path: branchPath, mcpServers: ["viewer"] }]);

  /* A branch that cannot be resumed relays through its root, whose own grant
     must reach the root's command on the same terms. */
  seen.length = 0;
  const relayed = await deliverConversationMessage(
    { path: branchPath, text: "relay", images: [] } as never,
    overrides((pathname) => pathname === rootPath) as never,
  );
  expect(relayed).toMatchObject({ ok: true });
  expect(seen).toEqual([
    { path: branchPath, mcpServers: ["viewer"] },
    { path: rootPath, mcpServers: ["viewer"] },
  ]);
});

test("conversation stop refuses a pane claimed by another registry session", async () => {
  const pathname = "/transcripts/ambiguous.jsonl";
  const snapshot = killSnapshot(pathname, KILL_HOST);
  const existing = Object.values(snapshot.entries)[0]!;
  snapshot.entries["codex:other"] = { ...existing, key: { engine: "codex", sessionId: "other" }, artifactPath: "/transcripts/other.jsonl" };
  let effects = 0;
  const result = await killConversation(pathname, {
    pathAllowed: () => true, listFiles: async () => [], registrySnapshot: () => snapshot,
    killHost: async () => { effects++; return true; },
  });
  expect(result.ok).toBe(false);
  expect(effects).toBe(0);
});

test("a viewer-spawned child with its own registered pane can stop independently", async () => {
  const pathname = "/transcripts/independent-child.jsonl";
  const killed: string[] = [];
  const result = await killConversation(pathname, {
    pathAllowed: () => true,
    listFiles: async () => [{ path: pathname, parent: "/transcripts/parent.jsonl" } as never],
    registrySnapshot: () => killSnapshot(pathname, KILL_HOST),
    killHost: async (host) => { killed.push(host.paneId); return true; },
  });
  expect(result).toMatchObject({ ok: true, target: KILL_HOST.paneId });
  expect(killed).toEqual([KILL_HOST.paneId]);
});

function tmuxTierFixture(live = false) {
  const sessionId = crypto.randomUUID();
  const pathname = path.join(SANDBOX, `${sessionId}.jsonl`);
  fs.writeFileSync(pathname, "");
  const registry = new AgentRegistry(path.join(SANDBOX, "tier-registry.json"));
  setAgentRegistryForTests(registry);
  const key = { engine: "codex" as const, sessionId };
  registry.upsert({
    key, artifactPath: pathname, cwd: SANDBOX, accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: SANDBOX, title: "Tier continuity fixture" }),
    status: live ? "idle" : "dead", host: live ? KILL_HOST : null,
    claimEpoch: 1, claimOwner: null, pendingAction: null,
  });
  const conversation = registry.ensureConversation("codex", pathname, null);
  registry.updateConversationLaunchProfile(conversation.id, {
    model: "gpt-6-astra", effort: "high", fast: true, serviceTier: "ultrafast",
  });
  const entry: FileEntry = {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "fixture",
    title: "Tier continuity fixture", engine: "codex", kind: "session", fmt: "codex", parent: null,
    mtime: 1, size: 0, activity: "idle", proc: live ? "running" : null,
    pid: live ? KILL_HOST.agent.pid : null, model: "gpt-6-astra", effort: "high", fast: true,
    pendingQuestion: null, waitingInput: null,
  };
  const stub = path.join(SANDBOX, "codex-mcp-stub");
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '[{"name":"viewer"}]'\n`);
  fs.chmodSync(stub, 0o755);
  const resumeSpecFor = (_root: string, _path: string, options: ResumeSpecOptions = {}) => {
    const previous = process.env.LLV_CODEX_BINARY;
    process.env.LLV_CODEX_BINARY = stub;
    try {
      return resumeSpecForSession("codex", sessionId, SANDBOX, path.join(SANDBOX, "codex-home"), options);
    } finally {
      if (previous === undefined) delete process.env.LLV_CODEX_BINARY;
      else process.env.LLV_CODEX_BINARY = previous;
    }
  };
  return { registry, key, entry, conversation, resumeSpecFor };
}

test("tmux Resume carries the stored ultrafast tier into the command", async () => {
  const { registry, entry, resumeSpecFor } = tmuxTierFixture();
  let command = "";
  const outcome = await resumeConversation(entry.path, {
    registry, pathAllowed: () => true, listFiles: async () => [entry],
    recover: async () => null, liveOwnership: () => null, resumeSpecFor,
    deliver: async ({ spec }) => {
      command = spec!.command;
      return { ok: true, outcome: "resumed", target: "%7" };
    },
  });
  expect(outcome).toMatchObject({ ok: true, outcome: "resumed" });
  expect(command).toContain("-c 'service_tier=ultrafast'");
  expect(command).not.toContain("service_tier=priority");
});

for (const resumeFast of [undefined, true, false]) {
  test(`tmux message reopen resolves ultrafast with resumeFast=${resumeFast}`, async () => {
    const { entry, resumeSpecFor } = tmuxTierFixture();
    let command = "";
    const outcome = await deliverConversationMessage({
      pid: null, path: entry.path, text: "Continue", images: [], resumeFast,
    }, {
      pathAllowed: () => true, listFiles: async () => [entry], recover: async () => null, resumeSpecFor,
      deliver: async ({ spec }) => {
        command = spec!.command;
        return { ok: true, outcome: "resumed", target: "%7" };
      },
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(command).toContain(`-c 'service_tier=${resumeFast === false ? "standard" : "ultrafast"}'`);
    expect(command).not.toContain("service_tier=priority");
    if (resumeFast === false) expect(command).not.toContain("service_tier=ultrafast");
  });
}

for (const fast of [true, false]) {
  test(`tmux reconfigure ${fast ? "effort only keeps ultrafast" : "to Standard clears the durable tier and attach"}`, async () => {
    const { registry, key, entry, conversation, resumeSpecFor } = tmuxTierFixture(true);
    let command = "";
    const outcome = await reconfigureConversation(entry.path, { model: "gpt-6-astra", effort: "medium", fast }, {
      registry, pathAllowed: () => true, listFiles: async () => [entry], resumeSpecFor,
      livePaneHost: async () => null, paneScreen: async () => "›\n? for shortcuts",
      killHost: async () => true,
      deliver: async ({ spec }) => {
        command = spec!.command;
        const prepared = beginRegistryResume(entry, spec!, registry);
        if (!prepared) throw new Error("expected registry resume");
        expect(registry.settleSpawn(prepared.receipt.launchId, {
          key, artifactPath: entry.path, cwd: SANDBOX, accountId: null,
          launchProfile: prepared.receipt.launchProfile, status: "idle", host: null,
          claimEpoch: 1, claimOwner: null, pendingAction: null,
        }).kind).toBe("settled");
        return { ok: true, outcome: "resumed", target: "%7" };
      },
    });
    expect(outcome).toMatchObject({ ok: true, outcome: "reconfigured" });
    expect(command).toContain(`-c 'service_tier=${fast ? "ultrafast" : "standard"}'`);
    const durableProfile = registry.conversation(conversation.id)!.generations.at(-1)!.launchProfile;
    expect(durableProfile).toMatchObject({ effort: "medium", fast });
    expect(durableProfile.serviceTier ?? null).toBe(fast ? "ultrafast" : null);
    // Re-read the durable profile and drive the real path-attach composer.
    const attached = resolveAttachCommand(entry.path, {
      files: [entry], resumeSpecFor, accountIdForPath: () => "fixture",
      accountLabelFor: () => "Fixture", launchProfileForPath: pathname => registry.launchProfileForPath(pathname),
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) throw new Error(attached.error);
    if (fast) expect(attached.value.command).toContain("service_tier=ultrafast");
    else expect(attached.value.command).not.toContain("service_tier=ultrafast");
  });
}

test("tmux branch relay carries the root's ultrafast tier into its reopen command", async () => {
  const { entry, resumeSpecFor } = tmuxTierFixture();
  const branch = { ...entry, path: path.join(SANDBOX, "branch.jsonl"), parent: entry.path };
  let command = "";
  const outcome = await deliverConversationMessage({
    pid: null, path: branch.path, text: "Continue branch", images: [], resumeFast: false,
  }, {
    pathAllowed: () => true, listFiles: async () => [branch, entry], recover: async () => null,
    resumeSpecFor: (root, pathname, options) => pathname === entry.path ? resumeSpecFor(root, pathname, options) : null,
    deliver: async ({ spec, payload }) => {
      command = spec!.command;
      expect(payload).toContain("Continue branch");
      return { ok: true, outcome: "resumed", target: "%7" };
    },
  });
  expect(outcome).toMatchObject({ ok: true });
  expect(command).toContain("-c 'service_tier=ultrafast'");
});

/* docs/design/delivery-progress-and-drain.md, P17 (A1 legacy steps, A9, C2). */
function legacyEntry(pathname: string, pid: number | null): FileEntry {
  return {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "viewer",
    title: "legacy", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 0,
    activity: "idle", proc: pid === null ? null : "running", pid, model: "gpt-5.6-sol", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null,
  } as FileEntry;
}

test("a legacy send whose request names only a pid reserves on its transcript's conversation, types once, and a replay of its key is answered from the reservation", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-pid-only-registry.json"));
  setAgentRegistryForTests(registry);
  const transcript = path.join(SANDBOX, "pid-only.jsonl");
  const { DeliveryProgressStore } = await import("./runtime/deliveryProgress");
  const progress = new DeliveryProgressStore(null);
  const typed: string[] = [];
  const send = () => deliverConversationMessage({
    pid: 4242, path: "", text: "type me once", images: [], clientMessageId: "pid-only-key",
  }, {
    listFiles: async () => [legacyEntry(transcript, 4242)],
    targetForKnownPid: async () => "%42",
    sendText: async (_target: string, payload: string) => { typed.push(payload); },
    progress,
  } as never);
  expect(await send()).toMatchObject({ ok: true });
  expect(await send()).toMatchObject({ ok: true });
  expect(typed).toEqual(["type me once"]);
  const conversation = registry.conversationForPath(transcript);
  expect(conversation).not.toBeNull();
  const [reservation] = Object.values(registry.snapshot().heldDeliveries).filter((delivery) => delivery.clientMessageId === "pid-only-key");
  expect(reservation).toMatchObject({ state: "delivered", conversationId: conversation!.id });
  expect(progress.get(reservation!.command.operationId)).toMatchObject({ originalKey: "pid-only-key", terminal: { state: "delivered" } });
});

test("a live Copilot pid remains messageable: its send reserves on the transcript's conversation, types once, and a replay of its key is answered from the reservation", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-copilot-pid-registry.json"));
  setAgentRegistryForTests(registry);
  const transcript = path.join(SANDBOX, "copilot-session.jsonl");
  const { DeliveryProgressStore } = await import("./runtime/deliveryProgress");
  const progress = new DeliveryProgressStore(null);
  const typed: string[] = [];
  const copilot = { ...legacyEntry(transcript, 4242), root: "copilot-sessions", engine: "copilot", fmt: "copilot" } as FileEntry;
  const send = () => deliverConversationMessage({
    pid: 4242, path: "", text: "copilot, once", images: [], clientMessageId: "copilot-key",
  }, {
    listFiles: async () => [copilot],
    targetForKnownPid: async () => "%4",
    recover: async () => null,
    sendText: async (_target: string, payload: string) => { typed.push(payload); },
    progress,
  } as never);
  expect(await send()).toMatchObject({ ok: true });
  expect(await send()).toMatchObject({ ok: true });
  expect(typed).toEqual(["copilot, once"]);
  const conversation = registry.conversationForPath(transcript);
  expect(conversation).toMatchObject({ engine: "copilot" });
  const reservations = Object.values(registry.snapshot().heldDeliveries).filter((delivery) => delivery.clientMessageId === "copilot-key");
  expect(reservations).toHaveLength(1);
  expect(reservations[0]).toMatchObject({ state: "delivered", conversationId: conversation!.id });
  expect(progress.get(reservations[0]!.command.operationId)).toMatchObject({ originalKey: "copilot-key", terminal: { state: "delivered" } });

  /* A pid whose transcript is no agent's is still refused before actuation. */
  const shell = await deliverConversationMessage({ pid: 5151, path: "", text: "nobody", images: [], clientMessageId: "shell-key" }, {
    listFiles: async () => [{ ...legacyEntry(path.join(SANDBOX, "shell.log"), 5151), engine: "shell", fmt: "plain" } as FileEntry],
    targetForKnownPid: async () => "%5",
    sendText: async (_target: string, payload: string) => { typed.push(payload); },
  } as never);
  expect(shell).toMatchObject({ ok: false, status: 404 });
  expect(typed).toEqual(["copilot, once"]);
});

test("a legacy send to an unregistered transcript path reserves the same way, and an unknown pid is refused before anything is reserved or typed", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-unregistered-registry.json"));
  setAgentRegistryForTests(registry);
  const transcript = path.join(SANDBOX, "unregistered.jsonl");
  let typed = 0;
  const overrides = {
    listFiles: async () => [legacyEntry(transcript, null)],
    pathAllowed: () => true,
    resumeSpecFor: () => ({ command: "codex resume", cwd: SANDBOX, windowName: "codex-resume", engine: "codex" }),
    deliver: async () => { typed += 1; return { ok: true, outcome: "resumed", target: "%5" }; },
  };
  const byPath = () => deliverConversationMessage({ pid: null, path: transcript, text: "by path", images: [], clientMessageId: "path-key" }, overrides as never);
  expect(await byPath()).toMatchObject({ ok: true });
  expect(await byPath()).toMatchObject({ ok: true });
  expect(typed).toBe(1);
  expect(registry.conversationForPath(transcript)).not.toBeNull();

  const unknown = await deliverConversationMessage({ pid: 9999, path: "", text: "nobody", images: [], clientMessageId: "unknown-pid" }, {
    listFiles: async () => [],
    targetForKnownPid: async () => "unknown",
    sendText: async () => { typed += 1; },
  } as never);
  expect(unknown).toMatchObject({ ok: false, status: 403, error: "process is unknown to the viewer" });
  expect(typed).toBe(1);
  expect(Object.values(registry.snapshot().heldDeliveries).filter((delivery) => delivery.clientMessageId === "unknown-pid")).toEqual([]);
});

test("a legacy send naming a conversation id the registry does not hold reserves on its pid's transcript and types once per key, and with nothing addressed it is refused untyped", async () => {
  const registry = new AgentRegistry(path.join(SANDBOX, "legacy-missing-id-registry.json"));
  setAgentRegistryForTests(registry);
  const transcript = path.join(SANDBOX, "missing-id.jsonl");
  const { DeliveryProgressStore } = await import("./runtime/deliveryProgress");
  const progress = new DeliveryProgressStore(null);
  const typed: string[] = [];
  const overrides = {
    listFiles: async () => [legacyEntry(transcript, 4242)],
    targetForKnownPid: async () => "%42",
    sendText: async (_target: string, payload: string) => { typed.push(payload); },
    progress,
  };
  const send = () => deliverConversationMessage({
    pid: 4242, path: "", conversationId: "conversation_missing", text: "once", images: [], clientMessageId: "same-key",
  }, overrides as never);
  expect(await send()).toMatchObject({ ok: true });
  expect(await send()).toMatchObject({ ok: true });
  expect(typed).toEqual(["once"]);
  const [reservation] = Object.values(registry.snapshot().heldDeliveries).filter((delivery) => delivery.clientMessageId === "same-key");
  expect(reservation).toMatchObject({ state: "delivered", conversationId: registry.conversationForPath(transcript)!.id });
  expect(progress.get(reservation!.command.operationId)).toMatchObject({ originalKey: "same-key", terminal: { state: "delivered" } });

  const nothing = await deliverConversationMessage({
    pid: null, path: "", conversationId: "conversation_missing", text: "nowhere", images: [], clientMessageId: "nowhere-key",
  }, overrides as never);
  expect(nothing).toMatchObject({ ok: false, status: 404, error: "conversation is unknown to the viewer" });
  expect(typed).toEqual(["once"]);
  expect(Object.values(registry.snapshot().heldDeliveries).filter((delivery) => delivery.clientMessageId === "nowhere-key")).toEqual([]);
});

test("a legacy send is recorded from its reservation, dispatching while the pane actuation hangs, and its hold, claim and settle wait off the loop", async () => {
  const { sqliteRegistryFixture, registryLockHolder, holdBeforeEachWrite, longestLoopGap } = await import("./agent/registryLockHolderFixture");
  const { blockingWaitDiagnostics, resetBlockingWaitsForTests } = await import("./blockingWaits");
  const made = sqliteRegistryFixture("llv-legacy-offloop");
  const holder = registryLockHolder(made.sqliteFilename);
  const registry = made.registry;
  setAgentRegistryForTests(registry);
  try {
    const conversation = registry.ensureConversation("codex", "", "default");
    const { DeliveryProgressStore } = await import("./runtime/deliveryProgress");
    const progress = new DeliveryProgressStore(null);
    let release!: () => void;
    let during: ReturnType<typeof progress.get> = null;
    resetBlockingWaitsForTests(() => {});
    const hook = holdBeforeEachWrite(registry, holder, 120, /lib\/delivery\.ts/);
    const sending = longestLoopGap(() => deliverConversationMessage({
      pid: 1, path: "", conversationId: conversation.id, text: "hang in the pane", images: [], clientMessageId: "legacy-record",
    }, {
      recover: async () => null,
      targetForKnownPid: async () => "%1",
      sendText: async () => {
        const [reserved] = registry.pendingDeliveries(conversation.id);
        during = { ...progress.get(reserved!.command.operationId)! };
        await new Promise<void>((resolve) => { release = resolve; });
      },
      progress,
    } as never));
    for (let attempt = 0; attempt < 400 && !release; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(during).toMatchObject({ waitReason: "dispatching", originalKey: "legacy-record", nextWakeAt: null });
    release();
    const { value: outcome, gapMs } = await sending;
    hook.restore();
    expect(outcome).toMatchObject({ ok: true });
    expect(hook.unwrapped).toEqual([]);
    expect(gapMs).toBeLessThan(50);
    const operationId = Object.values(registry.snapshot().deliveryOperationOwners).find((owner) => owner.clientMessageId === "legacy-record")!.command.operationId;
    for (const label of ["delivery.admit", "delivery.claim", "delivery.settle"]) {
      expect(blockingWaitDiagnostics().longest.some((sample) => sample.label === label && sample.operationId === operationId)).toBe(true);
    }
    expect(progress.get(operationId)).toMatchObject({ terminal: { state: "delivered" } });
  } finally {
    await holder.close();
    registry.close();
    made.cleanup();
  }
});

/* docs/design/delivery-progress-and-drain.md, P17 and A1: a request-local
   reservation a switch overtook between the preflight fence and the hold is
   recorded from the moment it exists. Its own discard waits for the writer
   named on that record; done, the record ends with the answer; refused, the
   reservation stays and the record shows the switch it waits behind. */
describe.each([
  ["oversized text", { text: "x".repeat(33_000), images: 0 }],
  ["images", { text: "", images: 1 }],
] as const)("a migration-raced request-local reservation (%s)", (_label, payload) => {
  async function raced(name: string, holdMs: number, deadlineMs?: number) {
    const { DeliveryProgressStore } = await import("./runtime/deliveryProgress");
    const { Database } = await import("bun:sqlite");
    const sqlitePath = path.join(SANDBOX, `${name}.sqlite`);
    const registry = new AgentRegistry(path.join(SANDBOX, `${name}.json`), undefined, undefined, {
      sqliteMode: "sqlite", sqliteFilename: sqlitePath, ...(deadlineMs !== undefined ? { sqliteWriterDeadlineMs: deadlineMs } : {}),
    });
    setAgentRegistryForTests(registry);
    const conversation = registry.ensureConversation("codex", "", "default");
    const progress = new DeliveryProgressStore(null);
    let holder: InstanceType<typeof Database> | null = null;
    let operationId: string | null = null;
    const hold = registry.holdDeliveryOffLoop.bind(registry);
    registry.holdDeliveryOffLoop = (async (...args: Parameters<typeof registry.holdDeliveryOffLoop>) => {
      registry.setConversationMigration(conversation.id, {
        intentId: `${name}-intent`, phase: "requested", targetId: "default", revision: 1, error: null, updatedAt: new Date().toISOString(),
      });
      const held = await hold(...args);
      operationId = held?.command.operationId ?? null;
      holder = new Database(sqlitePath);
      holder.exec("PRAGMA busy_timeout = 5000");
      holder.exec("BEGIN IMMEDIATE");
      return held;
    }) as typeof registry.holdDeliveryOffLoop;
    const seen: unknown[] = [];
    const sending = deliverConversationMessage({
      pid: 1, path: "", conversationId: conversation.id, text: payload.text,
      images: payload.images ? [{ base64: "aW1hZ2U=", mime: "image/png" }] : [], clientMessageId: `${name}-key`,
    }, { progress, targetForKnownPid: async () => "%1", sendText: async () => { throw new Error("nothing may be typed"); } });
    for (let attempt = 0; attempt < 200 && !holder; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    seen.push(structuredClone(progress.get(operationId!)));
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    (holder as InstanceType<typeof Database> | null)?.exec("ROLLBACK");
    const outcome = await sending;
    (holder as InstanceType<typeof Database> | null)?.close();
    return { registry, progress, operationId: operationId!, outcome, during: seen[0] };
  }

  test("names its discard while the writer is held, and ends its record with the 409 once the discard is written", async () => {
    const { registry, progress, operationId, outcome, during } = await raced(`discarded-${payload.images}`, 400);
    expect(during).toMatchObject({ waitReason: "checking", detail: "discarding the request-local payload", terminal: null });
    expect(outcome).toMatchObject({ ok: false, status: 409, error: "request-local delivery waits for migration completion" });
    expect(progress.get(operationId)!.terminal).toMatchObject({ state: "failed" });
    expect(Object.values(registry.readOnlySnapshot().heldDeliveries)).toEqual([]);
    registry.close();
  });

  test("keeps the reservation and its open record when the discard's writer wait is refused", async () => {
    const { registry, progress, operationId, outcome, during } = await raced(`refused-${payload.images}`, 300, 150);
    expect(during).toMatchObject({ waitReason: "checking", detail: "discarding the request-local payload", terminal: null });
    expect(outcome).toMatchObject({ ok: false, status: 409 });
    expect(progress.get(operationId)).toMatchObject({ waitReason: "switching-accounts", terminal: null });
    expect(Object.values(registry.readOnlySnapshot().heldDeliveries)).toMatchObject([{ state: "held", command: { operationId } }]);
    registry.close();
  });
});
