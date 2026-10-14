import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { spawnResponseForReceipt } from "@/lib/agent/spawnResponse";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { claimPass, patchPass, readPass } from "@/lib/memory/curation/store";
import { newRuleId, roleMemoryCollection, roleScope } from "@/lib/memory/roleStore";
import { defaultSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { defaultSeatTickSources } from "@/lib/monitor/seatTickSources";
import { emptySeatTickState } from "@/lib/monitor/types";
import { writeSeatTickState } from "@/lib/monitor/seatTickState";

import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import {
  ADMISSION_RETRY_DEADLINE_MS,
  STALE_STRUCTURED_SPAWN_TIMEOUT_MS,
  recoverPendingStructuredSpawns,
  reconcileStructuredSpawnReplay,
  spawnStructuredConversation,
  terminalizeStaleStructuredSpawns,
} from "./structuredSpawn";

const DEAD_RUNTIME_CLIENT = {
  operationStatus: async () => null,
  snapshot: async () => ({ revision: 0, sessions: [] }),
  effectBatch: async () => [],
} as unknown as RuntimeHostClient;

function registry(): AgentRegistry {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-terminalize-"));
  return new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
}

function staleStructuredReceipt(store: AgentRegistry, attempt: string) {
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    transport: "structured",
    accountId: "work",
    clientAttemptId: attempt,
    requestDigest: "d".repeat(64),
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  return begun.receipt;
}

function stagedStructuredReceipt(store: AgentRegistry, attempt: string) {
  const receipt = staleStructuredReceipt(store, attempt);
  const key = { engine: "codex" as const, sessionId: `session-${attempt}` };
  const artifactPath = path.join(path.dirname(store.filename), `${key.sessionId}.jsonl`);
  store.stageStructuredSpawn(receipt.launchId, {
    key,
    artifactPath,
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:live",
      process: { pid: process.pid, startIdentity: `host-${attempt}` },
      eventCursor: 1,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${attempt}`,
    pendingAction: "spawn",
  });
  return { receipt, key };
}

const AGED = () => Date.now() + STALE_STRUCTURED_SPAWN_TIMEOUT_MS + 60_000;

test.each(["starting", "host-verified"] as const)("an abandoned transport-null %s receipt terminalizes without losing its replay identity", async state => {
  const store = registry();
  const receipt = store.beginSpawn("codex", "/repo", { title: "Legacy abandoned launch" });
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  raw.receipts[receipt.launchId].state = state;
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  const reopened = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  expect(reopened.snapshot().receipts[receipt.launchId]?.transport).toBeNull();
  const result = await terminalizeStaleStructuredSpawns(reopened, DEAD_RUNTIME_CLIENT, { now: AGED });
  expect(result.terminalized).toEqual([receipt.launchId]);
  expect(reopened.snapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", conversationId: receipt.conversationId });
  expect(await terminalizeStaleStructuredSpawns(reopened, DEAD_RUNTIME_CLIENT, { now: AGED }))
    .toEqual({ examined: 0, terminalized: [], recovered: [] });
});

test.each(["operation","effect","session","unavailable","young"] as const)("a transport-null launch preserves %s evidence", async evidence => {
  const store = registry();
  const receipt = store.beginSpawn("codex","/repo",{ title: "Preserved legacy launch" });
  const client = { ...DEAD_RUNTIME_CLIENT,
    operationStatus: async () => {
      if (evidence === "unavailable") throw new RuntimeHostUnavailableError("fixture unavailable");
      return evidence === "operation" ? { receipt: { status: "pending" } } : null;
    },
    effectBatch: async () => evidence === "effect" ? [{ eventSeq: 1,payload: { operationId: receipt.launchId } }] : [],
    snapshot: async () => ({ revision: 0,sessions: evidence === "session" ? [{ conversationId: receipt.conversationId }] : [] }),
  } as unknown as RuntimeHostClient;
  const result = await terminalizeStaleStructuredSpawns(store,client,{ now: evidence === "young" ? Date.now : AGED });
  expect(result.terminalized).toEqual([]);
  expect(store.snapshot().receipts[receipt.launchId]?.state).toBe("starting");
});

test("transport-null cleanup rechecks foreground settlement after its asynchronous evidence reads", async () => {
  const store = registry();
  const receipt = store.beginSpawn("codex","/repo",{ title: "Foreground settlement race" });
  const client = { ...DEAD_RUNTIME_CLIENT,operationStatus: async () => {
    const raw = JSON.parse(fs.readFileSync(store.filename,"utf8"));
    raw.receipts[receipt.launchId].state = "completed";
    fs.writeFileSync(store.filename,JSON.stringify(raw));
    return null;
  } } as unknown as RuntimeHostClient;
  expect((await terminalizeStaleStructuredSpawns(store,client,{ now: AGED })).terminalized).toEqual([]);
  expect(store.snapshot().receipts[receipt.launchId]?.state).toBe("completed");
});

test("orphan starting entries converge after the grace while receipt and claim evidence stay intact", async () => {
  const store = registry();
  for (const name of ["orphan","receipt","claim","operation","young"]) {
    store.upsert({ key: { engine: "codex",sessionId: `orphan-${name}` },artifactPath: `/sessions/orphan-${name}.jsonl`,cwd: "/repo",accountId: null,
      status: "starting",host: null,claimEpoch: 0,claimOwner: name === "claim" ? "fixture-owner" : null,pendingAction: "spawn" });
  }
  const receipt = store.beginSpawn("codex","/repo",{ title: "Correlated starting launch" });
  const raw = JSON.parse(fs.readFileSync(store.filename,"utf8"));
  raw.receipts[receipt.launchId].artifactPath = "/sessions/orphan-receipt.jsonl";
  raw.entries["codex:orphan-operation"].structuredHostOperationId = "fixture-operation";
  raw.entries["codex:orphan-young"].updatedAt = new Date(AGED()).toISOString();
  fs.writeFileSync(store.filename,JSON.stringify(raw));
  await terminalizeStaleStructuredSpawns(store,null,{ now: AGED });
  const snapshot = store.snapshot();
  expect(snapshot.entries["codex:orphan-orphan"]).toMatchObject({ status: "dead",pendingAction: null });
  for (const name of ["receipt","claim","operation","young"]) expect(snapshot.entries[`codex:orphan-${name}`]?.status).toBe("starting");
});

test("a runtime-host transport failure becomes actionable on the structured spawn card", async () => {
  const store = registry();
  const cwd = path.dirname(store.filename);
  const launchProfile = emptyLaunchProfile({ title: "Stale launch fixture", cwd });
  const begun = store.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "work",
    launchProfile,
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  let admissionAttempts = 0;
  let clock = 0;
  const unavailableClient = {
    command: async () => {
      admissionAttempts += 1;
      throw new RuntimeHostUnavailableError("runtime host request timed out");
    },
    transitionOperation: async () => {
      throw new RuntimeHostUnavailableError("runtime host request timed out");
    },
  } as unknown as RuntimeHostClient;

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "runtime-host-card", engine: "codex", launchProfile },
    account: { engine: "codex", accountId: "work", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    ["prompt"]: "run",
    registry: store,
    client: unavailableClient,
  }, {
    startHost: async () => { throw new Error("runtime admission must precede host start"); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  })).rejects.toThrow("runtime host request timed out");

  /* Admission retries until its deadline (#2058), then gives up. */
  expect(admissionAttempts).toBeGreaterThan(3);
  expect(clock).toBeLessThanOrEqual(ADMISSION_RETRY_DEADLINE_MS);
  const failed = store.snapshot().receipts[begun.receipt.launchId];
  if (!failed) throw new Error("failed structured spawn receipt was unavailable");
  const actionableFailure = "structured spawn runtime host is unavailable; start agent-log-viewer through its CLI and check the CLI log for the host startup failure";
  expect(failed).toMatchObject({ state: "failed", error: actionableFailure });
  expect(spawnResponseForReceipt(failed, failed.artifactPath, { structured: true })).toMatchObject({
    state: "failed",
    initialMessage: "failed",
    retrySafe: true,
    error: actionableFailure,
  });
});

test("a stale dead-evidence structured launch converges to durable retry-safe failed exactly once", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "stale_20260719_a1");
  const before = store.snapshot();
  const receiptCount = Object.keys(before.receipts).length;
  const conversationCount = Object.keys(before.conversations).length;

  const first = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });
  expect(first.examined).toBe(1);
  expect(first.terminalized).toEqual([receipt.launchId]);
  expect(first.recovered).toEqual([]);

  const failed = store.snapshot().receipts[receipt.launchId]!;
  expect(failed.state).toBe("failed");
  expect(failed.error).toContain("no session");
  expect(failed.conversationId).toBe(receipt.conversationId);

  /* Idempotence: a second pass is a no-op — terminal receipts are skipped. */
  const second = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });
  expect(second).toEqual({ examined: 0, terminalized: [], recovered: [] });

  /* No-loss: no receipt or conversation row is ever deleted by convergence. */
  const after = store.snapshot();
  expect(Object.keys(after.receipts)).toHaveLength(receiptCount);
  expect(Object.keys(after.conversations)).toHaveLength(conversationCount);
});

test.each(["missing", "corrupt"] as const)("a %s queued payload cannot keep an ownerless receipt alive past the setup bound", async (condition) => {
  const store = registry();
  const retryAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const begun = store.beginSpawnRequest({
    engine: "claude",
    cwd: "/repo",
    transport: "structured",
    accountId: "account-a",
    accountPin: true,
    clientAttemptId: `partial_queue_${condition}_20260824`,
    launchProfile: emptyLaunchProfile({
      cwd: "/repo",
      title: `Pinned account quota is exhausted — queued until ${retryAt}`,
    }),
  });
  if (begun.kind !== "created" || !begun.receipt.admissionOwner) throw new Error("expected queued receipt creation");
  if (condition === "corrupt") {
    store.queuePinnedSpawn(begun.receipt.launchId, {
      version: 1,
      retryAt,
      accountId: "account-a",
      locale: "en",
      spec: {
        engine: "claude",
        command: "claude",
        cwd: "/repo",
        windowName: "queued-pin",
        launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
      },
      ["prompt"]: "continue",
      imageRefs: [],
      parentArtifactPath: null,
      pipelineSourceConversationId: null,
    }, `Pinned account quota is exhausted — queued until ${retryAt}`);
  }
  store.releaseStartingStructuredSpawn(begun.receipt.launchId, begun.receipt.admissionOwner);
  if (condition === "corrupt") {
    const raw = JSON.parse(fs.readFileSync(store.filename, "utf8")) as {
      receipts: Record<string, { queuedPinnedSpawn?: unknown }>;
    };
    raw.receipts[begun.receipt.launchId]!.queuedPinnedSpawn = {
      version: 1,
      retryAt,
      accountId: "account-a",
      locale: "en",
    };
    fs.writeFileSync(store.filename, JSON.stringify(raw));
  }

  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  expect(restarted.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "starting",
    admissionOwner: null,
    queuedPinnedSpawn: null,
  });

  const result = await terminalizeStaleStructuredSpawns(restarted, DEAD_RUNTIME_CLIENT, { now: AGED });

  expect(result).toEqual({ examined: 1, terminalized: [begun.receipt.launchId], recovered: [] });
  expect(restarted.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    queuedPinnedSpawn: null,
  });
});

test.each(["missing", "corrupt"] as const)("a %s tmux queue payload cannot keep an ownerless receipt alive past the setup bound", async (condition) => {
  const store = registry();
  const retryAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const begun = store.beginSpawnRequest({
    engine: "claude",
    cwd: "/repo",
    transport: "tmux",
    accountId: "account-a",
    accountPin: true,
    clientAttemptId: `partial_tmux_queue_${condition}_20260824`,
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected tmux receipt creation");
  if (condition === "corrupt") {
    store.queuePinnedSpawn(begun.receipt.launchId, {
      version: 1,
      retryAt,
      accountId: "account-a",
      locale: "en",
      spec: {
        engine: "claude",
        command: "claude",
        cwd: "/repo",
        windowName: "queued-pin",
        launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
      },
      ["prompt"]: "continue",
      imageRefs: [],
      parentArtifactPath: null,
      pipelineSourceConversationId: null,
    }, `Pinned account quota is exhausted — queued until ${retryAt}`);
    const raw = JSON.parse(fs.readFileSync(store.filename, "utf8")) as {
      receipts: Record<string, { queuedPinnedSpawn?: unknown }>;
    };
    raw.receipts[begun.receipt.launchId]!.queuedPinnedSpawn = {
      version: 1,
      retryAt,
      accountId: "account-a",
      locale: "en",
    };
    fs.writeFileSync(store.filename, JSON.stringify(raw));
  }

  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  expect(restarted.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    transport: "tmux",
    state: "starting",
    admissionOwner: null,
    queuedPinnedSpawn: null,
  });

  const beforeBound = await terminalizeStaleStructuredSpawns(restarted, null, {
    now: () => Date.parse(begun.receipt.createdAt) + STALE_STRUCTURED_SPAWN_TIMEOUT_MS - 1,
  });
  expect(beforeBound).toEqual({ examined: 0, terminalized: [], recovered: [] });

  const result = await terminalizeStaleStructuredSpawns(restarted, null, { now: AGED });
  expect(result).toEqual({ examined: 1, terminalized: [begun.receipt.launchId], recovered: [] });
  expect(restarted.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    admissionOwner: null,
    queuedPinnedSpawn: null,
    error: `tmux spawn interrupted before durable queue publication or pane binding: ${begun.receipt.launchId}`,
  });

  expect(await terminalizeStaleStructuredSpawns(restarted, null, { now: AGED }))
    .toEqual({ examined: 0, terminalized: [], recovered: [] });
});

test("startup recovery still terminalizes a dead non-queued ownerless receipt", async () => {
  const store = registry();
  const begun = store.beginSpawnRequest({
    engine: "claude",
    cwd: "/repo",
    transport: "structured",
    accountId: "account-a",
    accountPin: true,
    clientAttemptId: "non_queued_ownerless_20260824",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
  });
  if (begun.kind !== "created" || !begun.receipt.admissionOwner) throw new Error("expected ownerless receipt setup");
  store.releaseStartingStructuredSpawn(begun.receipt.launchId, begun.receipt.admissionOwner);

  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  await recoverPendingStructuredSpawns(restarted, DEAD_RUNTIME_CLIENT);

  expect(restarted.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    queuedPinnedSpawn: null,
    error: `structured spawn interrupted before runtime admission: ${begun.receipt.launchId}`,
  });
});

test.each(["codex", "claude"] as const)("an overdue %s placeholder still fails when runtime effect history is unavailable", async (engine) => {
  const store = registry();
  const begun = store.beginSpawnRequest({
    engine,
    cwd: "/repo",
    transport: "structured",
    accountId: "work",
    clientAttemptId: `effect_history_outage_${engine}`,
    requestDigest: engine === "codex" ? "c".repeat(64) : "a".repeat(64),
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  const receipt = begun.receipt;
  const artifactPath = path.join(path.dirname(store.filename), `${engine}-effect-outage.jsonl`);
  store.stageStructuredSpawn(receipt.launchId, {
    key: { engine, sessionId: `${engine}-effect-outage` },
    artifactPath,
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    status: "dead",
    host: null,
    structuredHost: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  const client = {
    operationStatus: async () => null,
    snapshot: async () => ({ revision: 0, sessions: [] }),
    effectBatch: async () => { throw new Error("runtime effect history is unavailable"); },
  } as unknown as RuntimeHostClient;

  const beforeDeadline = await reconcileStructuredSpawnReplay(receipt.launchId, store, client, {
    now: () => Date.parse(receipt.createdAt) + STALE_STRUCTURED_SPAWN_TIMEOUT_MS - 1,
  });
  expect(beforeDeadline).toMatchObject({ state: "path-pending", initialMessage: "pending", error: null });

  const result = await terminalizeStaleStructuredSpawns(store, client, { now: AGED });

  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  const failed = store.snapshot().receipts[receipt.launchId]!;
  expect(failed).toMatchObject({
    state: "failed",
    error: expect.stringContaining("runtime effect history remained unavailable"),
  });
  expect(spawnResponseForReceipt(failed, failed.artifactPath, { structured: true })).toMatchObject({
    state: "failed",
    retrySafe: true,
    initialMessage: "failed",
  });
});

test("a live admission owner loses an overdue deferred launch at the bounded timeout", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "live_owner_20260719_a1");

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });
  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
});

test("a terminal runtime operation preserves its reason through generic stale reconciliation", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "terminal_operation_reason");
  const client = {
    effectBatch: async () => [],
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? {
      receipt: {
        operationId,
        idempotencyKey: operationId,
        conversationId: receipt.conversationId,
        kind: "spawn" as const,
        status: "failed" as const,
        reason: "synthetic terminal spawn failure",
        at: receipt.createdAt,
        revision: 2,
      },
      replayed: false,
    } : null,
    snapshot: async () => ({ revision: 0, sessions: [] }),
  } as unknown as RuntimeHostClient;

  const result = await terminalizeStaleStructuredSpawns(store, client, { now: AGED });

  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
    state: "failed",
    error: "synthetic terminal spawn failure",
  });
});

test("a receipt younger than the pass timeout is never touched", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "fresh_20260719_a1");

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT);
  expect(result).toEqual({ examined: 0, terminalized: [], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("starting");
});

test("a staged launch whose host entry stays claimed still fails at the bounded timeout", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "claimed_20260719_a1");
  const staged = store.stageStructuredSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId: "019f7b8a-" + "9f75-7dc0-b231-17f7eadd7fe1" },
    artifactPath: "/sessions/019f7b8a_9f75_7dc0_b231_17f7eadd7fe1.jsonl",
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    status: "unhosted",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:pending",
      process: null,
      eventCursor: 0,
      protocolVersion: null,
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "worker:live",
    pendingAction: "spawn",
  });
  expect(staged.kind).toBe("settled");

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });
  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
});

test("reconciliation never releases a host after concurrent spawn completion", async () => {
  const store = registry();
  const { receipt } = stagedStructuredReceipt(store, "concurrent_completion");
  let released = 0;
  let operationStatus = "queued";
  const client = {
    effectBatch: async () => [],
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? {
      operationId,
      replayed: false,
      receipt: {
        operationId,
        idempotencyKey: receipt.launchId,
        conversationId: receipt.conversationId,
        kind: "spawn" as const,
        status: operationStatus,
        reason: null,
        at: receipt.createdAt,
        revision: 1,
      },
    } : null,
    snapshot: async () => {
      expect(store.finalizeStructuredSpawn(receipt.launchId).kind).toBe("settled");
      return { revision: 1, sessions: [] };
    },
    transitionOperation: async () => {
      operationStatus = "failed";
      throw new Error("a completed launch must not be failed");
    },
  } as unknown as RuntimeHostClient;

  const reconciled = await reconcileStructuredSpawnReplay(receipt.launchId, store, client, {
    now: AGED,
    releaseHost: async () => { released += 1; return true; },
  });

  expect(reconciled).toMatchObject({ state: "completed", initialMessage: "delivered", error: null });
  expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("completed");
  expect(operationStatus).toBe("queued");
  expect(released).toBe(0);
});

test("reconciliation preserves a newer same-key host owner", async () => {
  const store = registry();
  const { receipt, key } = stagedStructuredReceipt(store, "newer_same_key_owner");
  const previous = store.snapshot().entries[`codex:${key.sessionId}`]!;
  const { updatedAt: _updatedAt, ...newerEntry } = previous;
  let released = 0;
  const client = {
    effectBatch: async () => [],
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? {
      operationId,
      replayed: false,
      receipt: {
        operationId,
        idempotencyKey: receipt.launchId,
        conversationId: receipt.conversationId,
        kind: "spawn" as const,
        status: "queued" as const,
        reason: null,
        at: receipt.createdAt,
        revision: 1,
      },
    } : null,
    snapshot: async () => ({ revision: 1, sessions: [] }),
    transitionOperation: async (operationId: string) => {
      store.upsert({
        ...newerEntry,
        structuredHostOperationId: "newer-launch-operation",
        structuredHost: {
          ...newerEntry.structuredHost!,
          process: { pid: process.pid, startIdentity: "newer-host" },
        },
        claimOwner: "structured-host:newer",
      });
      return {
        operationId,
        replayed: false,
        receipt: {
          operationId,
          idempotencyKey: receipt.launchId,
          conversationId: receipt.conversationId,
          kind: "spawn" as const,
          status: "failed" as const,
          reason: "stale launch superseded",
          at: receipt.createdAt,
          revision: 2,
        },
      };
    },
  } as unknown as RuntimeHostClient;

  const reconciled = await reconcileStructuredSpawnReplay(receipt.launchId, store, client, {
    now: AGED,
    releaseHost: async () => { released += 1; return true; },
  });

  expect(reconciled).toMatchObject({ state: "failed", initialMessage: "failed" });
  expect(store.snapshot().entries[`codex:${key.sessionId}`]).toMatchObject({
    status: "idle",
    structuredHostOperationId: "newer-launch-operation",
    claimOwner: "structured-host:newer",
    structuredHost: { process: { startIdentity: "newer-host" } },
  });
  expect(released).toBe(0);
});

test("issue 533: host loss after recoverable timeout reaches retry-safe failure despite the same process staying live", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "recoverable_timeout_host_loss");
  const key = { engine: "codex" as const, sessionId: "session-timeout-host-loss" };
  store.stageStructuredSpawn(receipt.launchId, {
    key,
    artifactPath: "/sessions/timeout-host-loss.jsonl",
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server", endpoint: "stdio:released", process: null,
      eventCursor: 1, protocolVersion: null, writerClaimEpoch: 0,
      activeTurnRef: null, pendingAttention: [], activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  store.releaseStructuredSpawnAdmissionOwner(receipt.launchId, receipt.admissionOwner!);

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });

  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
    state: "failed",
    admissionOwner: null,
    error: expect.stringContaining("no session"),
  });
  expect(spawnResponseForReceipt(store.snapshot().receipts[receipt.launchId]!)).toMatchObject({
    state: "failed",
    retrySafe: true,
  });
});

test("issue 1074: a stale materialized launch is recovered from its late transcript on the reaper tick", async () => {
  const store = registry();
  const receipt = staleStructuredReceipt(store, "materialized_incident_placeholder");
  const sessionId = "materialized-incident-session";
  const artifactPath = path.join(path.dirname(store.filename), `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, JSON.stringify({
    type: "event_msg",
    payload: { type: "user_message", message: "delayed initial message" },
  }) + "\n");
  store.stageStructuredSpawn(receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:incident",
      process: { pid: process.pid, startIdentity: "incident-host" },
      eventCursor: 3,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:incident",
    pendingAction: "spawn",
  });
  store.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: new Date().toISOString(),
  }]);
  expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
    state: "path-pending",
    artifactLifecycle: "materialized",
  });

  const result = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
  });

  expect(result).toEqual({ examined: 1, terminalized: [], recovered: [receipt.launchId] });
  expect(store.snapshot().receipts[receipt.launchId]).toMatchObject({
    state: "completed",
    artifactLifecycle: "materialized",
    completionMode: "route-recovered",
    error: null,
  });
});

test.each(["codex", "claude"] as const)("issue 1074: a stale %s registering host fails at the generic setup bound", async (engine) => {
  const store = registry();
  const begun = store.beginSpawnRequest({
    engine,
    cwd: "/repo",
    transport: "structured",
    accountId: "work",
    clientAttemptId: `registering_${engine}_incident`,
    requestDigest: engine === "codex" ? "c".repeat(64) : "a".repeat(64),
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
  });
  if (begun.kind !== "created") throw new Error("expected structured launch creation");
  const receipt = begun.receipt;
  const key = { engine, sessionId: `${engine}-registering-session` };
  const artifactPath = path.join(path.dirname(store.filename), `${key.sessionId}.jsonl`);
  store.stageStructuredSpawn(receipt.launchId, {
    key,
    artifactPath,
    cwd: "/repo",
    accountId: "work",
    launchProfile: emptyLaunchProfile({ title: "Stale launch fixture", cwd: "/repo" }),
    status: "idle",
    host: null,
    structuredHost: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: "stdio:registering",
      process: { pid: process.pid, startIdentity: `${engine}-incident-host` },
      eventCursor: 1,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${engine}-incident`,
    pendingAction: "spawn",
  });
  let operationStatus = "queued";
  let operationReason: string | null = null;
  let released = 0;
  const terminated: Array<{ pid: number; startIdentity: string | null }> = [];
  const operationResult = () => ({
    operationId: receipt.launchId,
    replayed: false,
    receipt: {
      operationId: receipt.launchId,
      idempotencyKey: receipt.launchId,
      conversationId: receipt.conversationId,
      kind: "spawn" as const,
      status: operationStatus,
      reason: operationReason,
      at: receipt.createdAt,
      revision: operationStatus === "queued" ? 1 : 2,
    },
  });
  const client = {
    effectBatch: async () => [],
    operationStatus: async (operationId: string) => operationId === receipt.launchId ? operationResult() : null,
    transitionOperation: async (_operationId: string, status: string, details?: { reason?: string | null }) => {
      operationStatus = status;
      operationReason = details?.reason ?? null;
      return operationResult();
    },
    snapshot: async () => ({
      sessions: [{
        conversationId: receipt.conversationId,
        sessionKey: key,
        hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
        host: "registering",
        turn: "idle",
        provenance: "structured",
        revision: 1,
        attentionIds: [],
        recentReceipts: [],
        accountId: "work",
        parentConversationId: null,
        cwd: "/repo",
        artifactPath,
        capabilities: { steer: engine === "codex", structuredAttention: true },
        activeTurnId: null,
      }],
    }),
  } as unknown as RuntimeHostClient;

  const result = await terminalizeStaleStructuredSpawns(store, client, {
    now: AGED,
    reconcile: (launchId, registry, runtimeClient, options) => reconcileStructuredSpawnReplay(
      launchId,
      registry,
      runtimeClient,
      {
        ...options,
        releaseHost: async () => {
          released += 1;
          return false;
        },
        terminateHostProcess: async (expected) => {
          terminated.push(expected);
          return true;
        },
      },
    ),
  });

  expect(result).toEqual({ examined: 1, terminalized: [receipt.launchId], recovered: [] });
  expect(released).toBe(1);
  expect(terminated).toEqual([{ pid: process.pid, startIdentity: `${engine}-incident-host` }]);
  expect(operationStatus).toBe("failed");
  expect(operationReason ?? "").toContain("durable setup remained incomplete");
  const failed = store.snapshot().receipts[receipt.launchId]!;
  expect(failed).toMatchObject({ state: "failed", error: operationReason });
  expect(spawnResponseForReceipt(failed, failed.artifactPath, { structured: true })).toMatchObject({
    state: "failed",
    retrySafe: true,
    initialMessage: "failed",
  });
});

test("the actuation cap bounds one cycle and the remainder converges on the next", async () => {
  const store = registry();
  const receipts = [
    staleStructuredReceipt(store, "capped_20260719_a1"),
    staleStructuredReceipt(store, "capped_20260719_a2"),
    staleStructuredReceipt(store, "capped_20260719_a3"),
  ];

  const first = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
    actuationCap: 2,
  });
  expect(first.examined).toBe(2);
  expect(first.terminalized).toHaveLength(2);

  const second = await terminalizeStaleStructuredSpawns(store, DEAD_RUNTIME_CLIENT, {
    now: AGED,
    actuationCap: 2,
  });
  expect(second.examined).toBe(1);
  expect(second.terminalized).toHaveLength(1);
  for (const receipt of receipts) {
    expect(store.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
  }
});

function queuedOwnerFixture(transport: "tmux" | "structured", curator?: { id: string; project: string; receiptProject?: string }) {
  const store = registry();
  const cwd = path.dirname(store.filename);
  const profile = emptyLaunchProfile({ cwd, title: curator ? "Role memory curation" : "Owner queue fixture",
    ...(curator ? { project: curator.project, role: "curator" as never } : {}) });
  const begun = store.beginSpawnRequest({ engine: "claude", cwd, transport, ownStartingActuation: true, accountPin: true, accountId: "account-a",
    ...(curator ? { role: "curator", explicitProject: curator.receiptProject ?? curator.project } : {}),
    clientAttemptId: curator?.id ?? `relay-owner-queued-${transport}`, launchProfile: profile });
  if (begun.kind !== "created" || !begun.receipt.admissionOwner) throw Error("queued owner fixture unavailable");
  const prompt = "Owner queue fixture instruction";
  store.queuePinnedSpawn(begun.receipt.launchId, { version: 1, retryAt: new Date(0).toISOString(), accountId: "account-a", locale: "en",
    spec: { engine: "claude", command: "claude", cwd, windowName: "owner-fixture", launchProfile: profile },
    prompt, imageRefs: [], parentArtifactPath: null, pipelineSourceConversationId: null }, "Owner queue fixture");
  store.releaseSpawnActuation(begun.receipt.launchId, begun.receipt.admissionOwner);
  return { store, cwd, receipt: begun.receipt };
}

function claimedCurator(project: string) {
  const scope = roleScope(project, "builder");
  roleMemoryCollection(true)!.boundedPatch(20, tx => {
    const id = newRuleId(tx);
    tx.put({ kind: "rule", id, scope, rule: "Inspect the scope before changing stored guidance.",
      why: "The rule is a durable curation fixture.", state: "active", hints: [],
      source: { project, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
      createdAt: new Date().toISOString(), changedAt: new Date().toISOString() });
    const prior = tx.get(`s:${scope}`);
    tx.put({ kind: "scope", scope, revision: prior?.kind === "scope" ? prior.revision + 1 : 1,
      history: prior?.kind === "scope" ? prior.history : [], active: [...(prior?.kind === "scope" ? prior.active : []), id] });
  });
  return claimPass({ project, repoDir: "/repo", now: Date.now() })!;
}

function curatorSources(store: AgentRegistry, project: string, state: { seat: "live" | "missing" | "dead"; wake: "recent" | "stale" }) {
  const now = Date.now();
  const seatFile = path.join(path.dirname(store.filename), "curator-seat.jsonl");
  fs.writeFileSync(seatFile, "");
  const seat = store.ensureConversation("codex", seatFile, "account-a");
  const sources = {
    ...defaultSeatTickSources(),
    now: () => now,
    registry: () => store,
    settings: () => defaultSeatTickSettings(project),
    seatFor: () => ({ active: state.seat === "missing" ? null : { conversationId: seat.id, seatEpoch: 1,
      designatedAt: new Date(now - 24 * 60 * 60_000).toISOString(), path: seatFile }, pending: null, history: [] }) as never,
    liveness: async () => state.seat === "dead" ? [{ conversationId: seat.id, host: { state: "dead", pid: null, kind: "structured" }, lifecycle: "gone" }] as never
      : [{ conversationId: seat.id, host: { state: "alive", pid: process.pid, kind: "structured" }, lifecycle: "waiting" }] as never,
  };
  writeSeatTickState(project, { ...emptySeatTickState(), seatEpoch: 1,
    lastWakeAt: new Date(now - (state.wake === "stale" ? 30 * 24 * 60 : 1) * 60_000).toISOString() });
  return sources;
}

function queuedCuratorFixture(transport: "tmux" | "structured", eligibility: { seat: "live" | "missing" | "dead"; wake: "recent" | "stale" }, foreignReceipt = false) {
  const project = `repo-curator-${crypto.randomUUID()}`;
  const pass = claimedCurator(project);
  const { store, cwd, receipt } = queuedOwnerFixture(transport, { id: pass.id, project, ...(foreignReceipt ? { receiptProject: `${project}-foreign` } : {}) });
  patchPass(pass.id, { state: "running", launchedAt: new Date().toISOString(), conversationId: receipt.conversationId, launchId: receipt.launchId });
  return { project, pass, store, cwd, receipt, sources: curatorSources(store, project, eligibility) };
}

for (const transport of ["tmux", "structured"] as const)
for (const writerRefused of [false, true]) test(`queued ${transport} owner cutoff retires its prompt and fences recovery (writer refused: ${writerRefused})`, async () => {
  const { store, cwd, receipt } = queuedOwnerFixture(transport);
  const { settleOwnerFirstPrompt } = await import("@/lib/externalRelay/ownerRun");
  const writer = spyOn(store, "retireQueuedSpawnOffLoop");
  if (writerRefused) writer.mockResolvedValue(false);
  let launches = 0;
  try {
    expect(await settleOwnerFirstPrompt(receipt.clientAttemptId!, receipt.conversationId, store)).toMatchObject({ confirmed: !writerRefused });
    if (writerRefused) expect(store.readOnlySnapshot().receipts[receipt.launchId]!.queuedPinnedSpawn).not.toBeNull();
    else expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
    await terminalizeStaleStructuredSpawns(store, transport === "structured" ? DEAD_RUNTIME_CLIENT : null, {
      resolveSpawnAccount: () => { throw Error("revoked queue must not resolve an account"); },
      spawnTmuxAgent: async () => { launches++; throw Error("revoked owner tmux launch"); },
      spawnStructuredConversation: async () => { launches++; throw Error("revoked owner structured launch"); },
    });
    expect(launches).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
    writer.mockRestore();
    expect(await settleOwnerFirstPrompt(receipt.clientAttemptId!, receipt.conversationId, store)).toEqual({ confirmed: true, pending: false });
  } finally { writer.mockRestore(); store.close(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

for (const transport of ["tmux", "structured"] as const)
for (const ineligible of ["missing", "dead", "stale"] as const) test(`queued ${transport} curator recovery abandons a ${ineligible} seat without starting a process`, async () => {
  const eligibility: { seat: "live" | "missing" | "dead"; wake: "recent" | "stale" } = {
    seat: ineligible === "missing" ? "missing" : ineligible === "dead" ? "dead" : "live",
    wake: ineligible === "stale" ? "stale" : "recent",
  };
  const { store, cwd, receipt, pass, sources } = queuedCuratorFixture(transport, eligibility);
  let launches = 0;
  try {
    await terminalizeStaleStructuredSpawns(store, transport === "structured" ? DEAD_RUNTIME_CLIENT : null, {
      curationSources: sources as never,
      resolveSpawnAccount: () => ({ engine: "claude", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }),
      resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
      spawnTmuxAgent: async () => { launches++; throw Error("ineligible curator reached tmux launch"); },
      spawnStructuredConversation: async () => { launches++; return { state: "running" } as never; },
    });
    expect(launches).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
    expect(readPass(pass.id)).toMatchObject({ state: "failed", failure: expect.stringContaining("abandoned") });
  } finally {
    if (readPass(pass.id)?.state !== "failed" && readPass(pass.id)?.state !== "succeeded") patchPass(pass.id, { state: "failed", failure: "fixture cleanup", endedAt: new Date().toISOString() });
    store.close(); fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const transport of ["tmux", "structured"] as const) test(`queued ${transport} curator recovery rechecks its seat after account admission`, async () => {
  const eligibility: { seat: "live" | "missing" | "dead"; wake: "recent" | "stale" } = { seat: "live", wake: "recent" };
  const { store, cwd, receipt, pass, sources } = queuedCuratorFixture(transport, eligibility);
  let launches = 0;
  try {
    await terminalizeStaleStructuredSpawns(store, transport === "structured" ? DEAD_RUNTIME_CLIENT : null, {
      curationSources: sources as never,
      resolveSpawnAccount: () => ({ engine: "claude", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }),
      resolvePinnedSpawnAdmission: async () => {
        eligibility.seat = "missing";
        return { kind: "admissible", basis: "current", stale: false, retryAt: null };
      },
      spawnTmuxAgent: async () => { launches++; throw Error("seat-change curator reached tmux launch"); },
      spawnStructuredConversation: async () => { launches++; return { state: "running" } as never; },
    });
    expect(launches).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
    expect(readPass(pass.id)).toMatchObject({ state: "failed", failure: expect.stringContaining("abandoned") });
  } finally {
    if (readPass(pass.id)?.state !== "failed" && readPass(pass.id)?.state !== "succeeded") patchPass(pass.id, { state: "failed", failure: "fixture cleanup", endedAt: new Date().toISOString() });
    store.close(); fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const transport of ["tmux", "structured"] as const) test(`queued ${transport} curator recovery actuates when its seat and delivered wake remain eligible`, async () => {
  const { store, cwd, receipt, pass, sources } = queuedCuratorFixture(transport, { seat: "live", wake: "recent" });
  let launches = 0;
  try {
    await terminalizeStaleStructuredSpawns(store, transport === "structured" ? DEAD_RUNTIME_CLIENT : null, {
      curationSources: sources as never,
      resolveSpawnAccount: () => ({ engine: "claude", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }),
      resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
      spawnTmuxAgent: async () => { launches++; return { paneId: "%curator-fixture", display: "curator-fixture" }; },
      spawnStructuredConversation: async () => { launches++; return { state: "running" } as never; },
    });
    expect(launches).toBe(1);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]?.state).not.toBe("failed");
    expect(readPass(pass.id)?.state).toBe("running");
  } finally {
    if (readPass(pass.id)?.state !== "failed" && readPass(pass.id)?.state !== "succeeded") patchPass(pass.id, { state: "failed", failure: "fixture cleanup", endedAt: new Date().toISOString() });
    store.close(); fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const transport of ["tmux", "structured"] as const) test(`queued ${transport} curator recovery refuses a foreign-project receipt`, async () => {
  const { store, cwd, receipt, pass, sources } = queuedCuratorFixture(transport, { seat: "live", wake: "recent" }, true);
  let launches = 0;
  try {
    await terminalizeStaleStructuredSpawns(store, transport === "structured" ? DEAD_RUNTIME_CLIENT : null, {
      curationSources: sources as never,
      resolveSpawnAccount: () => ({ engine: "claude", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }),
      resolvePinnedSpawnAdmission: async () => ({ kind: "admissible", basis: "current", stale: false, retryAt: null }),
      spawnTmuxAgent: async () => { launches++; throw Error("foreign-project curator reached tmux launch"); },
      spawnStructuredConversation: async () => { launches++; return { state: "running" } as never; },
    });
    expect(launches).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
    expect(readPass(pass.id)?.project).toBe(pass.project);
  } finally {
    if (readPass(pass.id)?.state !== "failed" && readPass(pass.id)?.state !== "succeeded") patchPass(pass.id, { state: "failed", failure: "fixture cleanup", endedAt: new Date().toISOString() });
    store.close(); fs.rmSync(cwd, { recursive: true, force: true });
  }
});

for (const transport of ["tmux", "structured"] as const) test(`queued ${transport} owner recovery rechecks authorization after account admission waits`, async () => {
  const { store, cwd, receipt } = queuedOwnerFixture(transport);
  const saved = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(cwd, "relay-state");
  const { reserveRun, updateRelayStore } = await import("@/lib/externalRelay/store");
  const { procBackend } = await import("@/lib/proc");
  updateRelayStore(s => ({ ...s, relays: [{ id: "relay_fixture", paused: false, credential: crypto.randomUUID(),
    targets: [{ id: "target_fixture", enabled: true, ownerTier: true }] } as typeof s.relays[number]] }));
  reserveRun({ requestId: `queued-${transport}`, leaseId: "lease_fixture", relayId: "relay_fixture", targetId: "target_fixture",
    ownerTurn: { clientAttemptId: receipt.clientAttemptId! }, conversationId: receipt.conversationId, ownerPid: process.pid,
    ownerIdentity: procBackend.processIdentity(process.pid), childPid: null, childIdentity: null, runDir: "", startedAt: new Date().toISOString() }, 1);
  let admissions = 0, launches = 0;
  try {
    await terminalizeStaleStructuredSpawns(store, transport === "structured" ? DEAD_RUNTIME_CLIENT : null, {
      resolveSpawnAccount: () => ({ engine: "claude", accountId: "account-a", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } }),
      resolvePinnedSpawnAdmission: async () => { admissions++; await Promise.resolve();
        updateRelayStore(s => ({ ...s, relays: s.relays.map(r => ({ ...r, paused: true })) }));
        return { kind: "admissible", basis: "current", stale: false, retryAt: null }; },
      spawnTmuxAgent: async () => { launches++; throw Error("revoked owner launch"); },
      spawnStructuredConversation: async () => { launches++; throw Error("revoked owner launch"); },
    });
    expect(admissions).toBe(1); expect(launches).toBe(0);
    expect(store.readOnlySnapshot().receipts[receipt.launchId]).toMatchObject({ state: "failed", queuedPinnedSpawn: null });
  } finally { store.close(); fs.rmSync(cwd, { recursive: true, force: true });
    if (saved === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = saved; }
});


test.each((["uncertain", "delivered"] as const).flatMap(phase =>
  (["absent", "user", "live", "claim", "unknown-claim", "pipeline", "pipeline-alias", "no-entry", "user-no-entry", "young"] as const).map(evidence => [phase, evidence] as const),
))("a lost %s first message converges without relaunching (%s)", async (phase, evidence) => {
  const { STAGED_RECOVERY_PREFIX } = await import("./stagedRecovery");
  const { STAGED_RECOVERY_BUDGET_MS } = await import("./structuredSpawn");
  const store = registry();
  const { receipt, key } = stagedStructuredReceipt(store, `lost-${phase}-${evidence}`);
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  const row = raw.receipts[receipt.launchId];
  const start = Date.parse(row.createdAt);
  row.admissionOwner = null;
  row.error = STAGED_RECOVERY_PREFIX + JSON.stringify({ phase, startedAt: start, nextTryAt: start,
    checks: 1, reason: "no rollout found for thread id", stopped: evidence !== "young" });
  const host = raw.entries[`codex:${key.sessionId}`];
  host.claimOwner = null;
  host.status = evidence === "live" ? "idle" : "dead";
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  host.structuredHost.process = evidence === "live" ? captureProcessIdentity(process.pid) : null;
  if (evidence === "claim") host.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
  if (evidence === "unknown-claim") host.claimOwner = "unverified-fixture-claim";
  if (evidence === "user" || evidence === "user-no-entry") fs.writeFileSync(row.artifactPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Start the work" } }) + "\n");
  if (evidence === "pipeline") raw.memberships[receipt.conversationId] = [{ kind: "pipeline", containerId: "fixture-lane", stageId: "build", slot: "run", role: "builder" }];
  if (evidence === "no-entry" || evidence === "user-no-entry") delete raw.entries[`codex:${key.sessionId}`];
  if (evidence === "pipeline-alias") {
    const canonical = "conversation_fixture_pipeline_alias";
    raw.conversationAliases[receipt.conversationId] = canonical;
    raw.conversations[canonical] = { ...raw.conversations[receipt.conversationId], id: canonical };
    raw.memberships[canonical] = [{ kind: "pipeline", containerId: "fixture-lane", stageId: "build", slot: "run", role: "builder" }];
  }
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  const runtimeWrites: string[] = [];
  const client = { ...DEAD_RUNTIME_CLIENT,
    transitionOperation: async (_id: string, state: string) => { runtimeWrites.push(state); },
    command: async () => { throw new Error("lost work must never relaunch or resend"); },
  } as unknown as RuntimeHostClient;
  const result = await terminalizeStaleStructuredSpawns(restarted, client, { now: () => start + (evidence === "young" ? 1 : STAGED_RECOVERY_BUDGET_MS) });
  const settled = restarted.snapshot().receipts[receipt.launchId]!;
  expect([evidence, settled.state]).toEqual([evidence, evidence === "absent" || evidence === "no-entry" ? "failed" : evidence === "user" || evidence === "user-no-entry" ? "completed" : "path-pending"]);
  if (evidence === "absent" || evidence === "no-entry") {
    expect(settled.error).toContain("lost before its first turn");
    expect(settled.error).toContain("no rollout found for thread id");
    expect(result.terminalized).toEqual([receipt.launchId]);
    expect(runtimeWrites).toEqual(["failed"]);
  }
});


test.each(["starting", "unpublished"] as const)("an accepted %s launch lost before its first rollout reports from the stale sweep", async phase => {
  const { STAGED_RECOVERY_PREFIX } = await import("./stagedRecovery");
  const { STAGED_RECOVERY_BUDGET_MS } = await import("./structuredSpawn");
  const { pendingSpawnNotices } = await import("@/lib/spawnNotice/store");
  const { queryLifecycleEvents } = await import("@/lib/lifecycle/journal");
  const store = registry();
  const receipt = phase === "starting" ? staleStructuredReceipt(store, "lost-starting-sweep")
    : stagedStructuredReceipt(store, "lost-unpublished-sweep").receipt;
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  const row = raw.receipts[receipt.launchId];
  row.launcher = { conversationId: "conversation_fixture_launching_seat", notify: true };
  row.admissionOwner = null;
  const start = Date.parse(row.createdAt);
  if (phase === "unpublished") {
    row.error = STAGED_RECOVERY_PREFIX + JSON.stringify({ phase, startedAt: start, nextTryAt: start,
      checks: 1, reason: "runtime host disappeared", stopped: true });
    const host = raw.entries[`codex:${row.key.sessionId}`];
    host.claimOwner = null;
    host.status = "dead";
    host.structuredHost.process = null;
  }
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  const result = await terminalizeStaleStructuredSpawns(restarted, { ...DEAD_RUNTIME_CLIENT,
    transitionOperation: async () => {},
  } as unknown as RuntimeHostClient, { now: () => start + STAGED_RECOVERY_BUDGET_MS });
  expect(result.terminalized).toEqual([receipt.launchId]);
  expect(restarted.snapshot().receipts[receipt.launchId]!.state).toBe("failed");
  expect(pendingSpawnNotices().filter(row => row.childConversationId === receipt.conversationId)).toHaveLength(1);
  expect(queryLifecycleEvents({ conversationId: receipt.conversationId }).events.map(event => event.type)).toEqual(["spawn_failed"]);
});

test.each(["new-owner", "late-transcript"] as const)("a lost staged launch rechecks %s after the runtime read before failing", async race => {
  const { STAGED_RECOVERY_PREFIX } = await import("./stagedRecovery");
  const { STAGED_RECOVERY_BUDGET_MS } = await import("./structuredSpawn");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const store = registry();
  const { receipt, key } = stagedStructuredReceipt(store, `lost-race-${race}`);
  const raw = JSON.parse(fs.readFileSync(store.filename, "utf8"));
  const row = raw.receipts[receipt.launchId];
  const start = Date.parse(row.createdAt);
  row.admissionOwner = null;
  row.error = STAGED_RECOVERY_PREFIX + JSON.stringify({ phase: "uncertain", startedAt: start,
    nextTryAt: start, checks: 1, reason: "host gone", stopped: true });
  const host = raw.entries[`codex:${key.sessionId}`];
  host.claimOwner = null;
  host.structuredHost.process = null;
  host.status = "dead";
  fs.writeFileSync(store.filename, JSON.stringify(raw));
  const restarted = new AgentRegistry(store.filename, undefined, undefined, { sqliteMode: "off" });
  const client = { ...DEAD_RUNTIME_CLIENT, operationStatus: async () => {
    if (race === "late-transcript") fs.writeFileSync(row.artifactPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Start the work" } }) + "\n");
    else {
      const latest = JSON.parse(fs.readFileSync(store.filename, "utf8"));
      latest.entries[`codex:${key.sessionId}`].claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
      fs.writeFileSync(store.filename, JSON.stringify(latest));
    }
    return null;
  }, transitionOperation: async () => { throw new Error("the stale observation cannot fail the runtime"); } } as unknown as RuntimeHostClient;
  const result = await terminalizeStaleStructuredSpawns(restarted, client, { now: () => start + STAGED_RECOVERY_BUDGET_MS });
  expect(result.terminalized).toEqual([]);
  expect(restarted.snapshot().receipts[receipt.launchId]!.state).toBe("path-pending");
  if (race === "late-transcript") {
    await terminalizeStaleStructuredSpawns(restarted, client, { now: () => start + STAGED_RECOVERY_BUDGET_MS });
    expect(restarted.snapshot().receipts[receipt.launchId]!.state).toBe("completed");
  }
});
