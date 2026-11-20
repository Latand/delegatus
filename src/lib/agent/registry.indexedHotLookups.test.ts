import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { submittedContinuationOutcome } from "@/lib/runtime/interruptionObligations";
import { AgentRegistry, normalizeRegistry } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

const directories: string[] = [];
const registries: AgentRegistry[] = [];
const stores: SqliteAgentRegistryStore[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function coldHistoryFixture(count = 120) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-indexed-hot-lookups-"));
  directories.push(directory);
  const filename = path.join(directory, "agent-registry.json");
  const sqliteFilename = path.join(directory, "agent-registry.sqlite");
  const base = normalizeRegistry({ version: 2, entries: {}, receipts: {} });
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const sessionId = ["00000000", "0000", "4000", "8000", String(index + 1).padStart(12, "0")].join("-");
    const conversationId = `conversation_cold-${suffix}` as const;
    const artifactPath = `/tmp/cold-fixture/session-${suffix}.jsonl`;
    const deliveryId = `delivery-cold-${suffix}`;
    const operationId = `op-cold-${suffix}`;
    const clientMessageId = `msg-cold-${suffix}`;
    base.entries[`codex:${sessionId}`] = {
      key: { engine: "codex", sessionId },
      artifactPath,
      cwd: "/tmp/cold-fixture",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: null,
      structuredHostOperationId: null,
      claimOwner: null,
      claimEpoch: 0,
      pendingAction: null,
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    base.conversations[conversationId] = {
      id: conversationId,
      engine: "codex",
      generations: [{
        id: sessionId,
        path: artifactPath,
        accountId: null,
        launchProfile: emptyLaunchProfile({ cwd: "/tmp/cold-fixture", role: "worker" }),
        historyHash: null,
        host: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        archivedAt: null,
      }],
      continuityPaths: [],
      abandonedContinuityPaths: [],
      providerForkPaths: [],
      projectOwnership: null,
      pinnedAccountId: null,
      migration: null,
      migrationOptOut: null,
      supersededBy: null,
      agentRole: null,
      delegationDepth: null,
      turn: { state: "idle", source: "lifecycle", terminalAt: "2026-09-01T00:01:00.000Z", observedAt: "2026-09-01T00:01:00.000Z" },
      deliveryEvidenceTracked: true,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
    };
    base.heldDeliveries[deliveryId] = {
      id: deliveryId,
      conversationId,
      runtimeConversationId: conversationId,
      clientMessageId,
      generationId: sessionId,
      text: "",
      payloadKind: "text",
      artifactPaths: [],
      runtimeImages: [],
      command: {
        kind: "send",
        operationId,
        policy: "queue",
        turnId: null,
      },
      state: "delivered",
      attempts: 1,
      createdAt: "2026-09-01T00:00:10.000Z",
      assignedAt: "2026-09-01T00:00:11.000Z",
      deliveredAt: "2026-09-01T00:00:12.000Z",
      error: null,
      requestDigest: null,
      contentDigest: null,
      admissionSeq: index + 1,
    };
    base.deliveryOperationOwners[operationId] = {
      conversationId,
      runtimeConversationId: conversationId,
      clientMessageId,
      deliveryId,
      command: {
        kind: "send",
        operationId,
        policy: "queue",
        turnId: null,
      },
      requestDigest: `digest-${suffix}`,
      contentDigest: null,
      targetGenerationId: sessionId,
      evidenceText: "",
      evidenceImageCount: 0,
      createdAt: "2026-09-01T00:00:10.000Z",
      admissionSeq: index + 1,
      retryOfOperationId: null,
      terminalState: "delivered",
      terminalDisposition: "delivered",
      terminalReason: null,
      settledAt: "2026-09-01T00:00:12.000Z",
    };
  }
  const normalized = normalizeRegistry(base);
  const store = new SqliteAgentRegistryStore(sqliteFilename, {
    initialSnapshot: normalized,
    normalize: normalizeRegistry,
  });
  store.archiveInactive(10_000);
  // Install caller indexes so registry_caller_roots is active.
  store.mcpCallerSnapshot(null, [], null);
  store.close();
  return { directory, filename, sqliteFilename, count };
}

test("submittedContinuationOutcome, liveRootSession, ensureConversation and delivery lookups avoid cold scans", () => {
  const { filename, sqliteFilename, count } = coldHistoryFixture(120);
  let reads = 0;
  const store = new SqliteAgentRegistryStore(sqliteFilename, {
    initialSnapshot: () => { throw new Error("already imported"); },
    normalize: normalizeRegistry,
    onRowPayloadRead: (_collection, n) => { reads += n; },
  });
  stores.push(store);
  const snapshot = store.readOnlySnapshot().file;

  // 1. submittedContinuationOutcome uses the clientMessageId index rather than scanning cold deliveries.
  reads = 0;
  const delivered = submittedContinuationOutcome(
    { id: "msg-cold-0042", conversationId: "conversation_cold-0042", operationId: "op-cold-0042" },
    snapshot,
    (id) => id,
  );
  expect(delivered).toMatchObject({ state: "delivered", compacted: false });
  expect(reads).toBeLessThanOrEqual(4);

  reads = 0;
  const missing = submittedContinuationOutcome(
    { id: "msg-absent", conversationId: "conversation_cold-0042", operationId: "op-absent" },
    snapshot,
    (id) => id,
  );
  expect(missing).toMatchObject({ state: "delivered", compacted: true });
  expect(reads).toBe(0);

  // 2. liveRootSession uses registry_caller_roots and reads 0 conversations when no root exists.
  reads = 0;
  expect(store.liveRootSession(null)).toBeNull();
  expect(reads).toBe(0);

  reads = 0;
  expect(store.liveRootSession("conversation_cold-0010")).toEqual({
    conversationId: "conversation_cold-0010",
    path: "/tmp/cold-fixture/session-0010.jsonl",
  });
  expect(reads).toBe(1);

  // Adding a root conversation makes liveRootSession find it in 1 conversation read.
  const liveSessionId = ["00000000", "0000", "4000", "8000", "000000009999"].join("-");
  store.mutate((file) => {
    file.conversations.conversation_live = {
      id: "conversation_live",
      engine: "codex",
      generations: [{
        id: liveSessionId,
        path: "/tmp/cold-fixture/live.jsonl",
        accountId: null,
        launchProfile: emptyLaunchProfile({ cwd: "/tmp/cold-fixture", role: "root" }),
        historyHash: null,
        host: null,
        createdAt: "2026-09-02T00:00:00.000Z",
        archivedAt: null,
      }],
      continuityPaths: [],
      abandonedContinuityPaths: [],
      providerForkPaths: [],
      projectOwnership: null,
      pinnedAccountId: null,
      migration: null,
      migrationOptOut: null,
      supersededBy: null,
      agentRole: null,
      delegationDepth: null,
      turn: { state: "idle", source: "lifecycle", terminalAt: "2026-09-02T00:00:00.000Z", observedAt: "2026-09-02T00:00:00.000Z" },
      deliveryEvidenceTracked: true,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    };
  }, false);
  reads = 0;
  expect(store.liveRootSession(null)).toEqual({
    conversationId: "conversation_live",
    path: "/tmp/cold-fixture/live.jsonl",
  });
  expect(reads).toBe(1);

  // 3. AgentRegistry.ensureConversation and delivery operation mutations use path/operationId indexes.
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  registries.push(registry);
  const sqlite = (registry as unknown as { sqliteStore: SqliteAgentRegistryStore }).sqliteStore;
  let writeReads = 0;
  (sqlite as unknown as { onRowPayloadRead?: (collection: string, n: number) => void }).onRowPayloadRead = (_c, n) => { writeReads += n; };

  const existing = registry.ensureConversation("codex", "/tmp/cold-fixture/session-0015.jsonl", null);
  expect(existing.id).toBe("conversation_cold-0015");
  expect(writeReads).toBeLessThan(count / 4);

  writeReads = 0;
  const created = registry.ensureConversation("codex", "/tmp/cold-fixture/brand-new.jsonl", null);
  expect(created.generations[0]?.path).toBe("/tmp/cold-fixture/brand-new.jsonl");
  expect(writeReads).toBeLessThan(count / 4);

  writeReads = 0;
  expect(registry.rearmUncertainDeliveryForOperation("op-absent")).toBeNull();
  expect(writeReads).toBeLessThan(count / 4);
});
