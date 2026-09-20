import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import type { RuntimeHostClient } from "./client";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-message-sqlite-"));

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("exact-key replay after SQLite compaction and reopen never publishes another command", async () => {
  const filename = path.join(sandbox, "compacted-replay.json");
  const artifactPath = "/sessions/compacted-replay.jsonl";
  let registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  try {
    const conversation = registry.ensureConversation("codex", artifactPath, "default");
    const generation = conversation.generations.at(-1)!;
    const original = registry.holdDelivery(conversation.id, "unknown-fate message", "compacted-replay");
    registry.recordDeliveryOutcome(original.id, "failed", "unconfirmed result", "unverified");
    const owner = registry.snapshot().deliveryOperationOwners[original.command.operationId]!;
    registry.compactDeliveryReservations();
    registry.close();
    registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    const before = registry.snapshot().heldDeliveries;
    let commands = 0;
    const client = {
      readSession: async () => ({ conversationId: conversation.id, artifactPath,
        sessionKey: { engine: "codex", sessionId: generation.id },
        hostKind: "codex-app-server", host: "hosted", turn: "idle",
        capabilities: { steer: true, structuredAttention: true } }),
      command: async () => { commands++; throw new Error("unexpected engine command"); },
    } as unknown as RuntimeHostClient;
    const assignment = spyOn(registry, "beginDeliveryAttempt");
    try {
      const result = await enqueueStructuredMessage({
        path: artifactPath, conversationId: conversation.id,
        text: original.text, clientMessageId: original.clientMessageId!,
      }, { enabled: () => true, client: () => client, registry: () => registry, kick: () => {} });
      expect(result).toMatchObject({ ok: false, outcome: "failed", status: 409, error: "unconfirmed result" });
      expect(commands).toBe(0);
      expect(assignment).not.toHaveBeenCalled();
      expect(registry.snapshot().heldDeliveries).toEqual(before);
      expect(registry.snapshot().deliveryOperationOwners[original.command.operationId]).toEqual(owner);
    } finally {
      assignment.mockRestore();
    }
  } finally {
    registry.close();
  }
});

test("synchronization owner lookup reuses the SQLite read-only snapshot", async () => {
  const filename = path.join(sandbox, "agent-registry.json");
  const artifactPath = "/sessions/cache.jsonl";
  let snapshotLoads = 0;
  const registry = new AgentRegistry(filename, undefined, undefined, {
    sqliteMode: "sqlite",
    onSqliteSnapshotLoad: () => { snapshotLoads += 1; },
  });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "default",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-13T00:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const generation = conversation.generations.at(-1)!;
  registry.upsert({
    key: { engine: conversation.engine, sessionId: generation.id },
    artifactPath: generation.path,
    cwd: generation.launchProfile.cwd,
    accountId: generation.accountId,
    launchProfile: generation.launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:deployment-window",
      process: { pid: 101, startIdentity: "runtime-before-restart" },
      eventCursor: 17,
      protocolVersion: "v2",
      writerClaimEpoch: 4,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 4,
    claimOwner: "structured-host:runtime-before-restart",
    pendingAction: null,
  });
  registry.readOnlySnapshot();
  const baseline = snapshotLoads;

  const result = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: conversation.id,
    clientMessageId: "sqlite-deployment-window-message",
    text: "continue through runtime synchronization",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => null,
    registry: () => registry,
    startupFailed: () => false,
  });

  expect(result).toMatchObject({ ok: true, structured: true, outcome: "held" });
  expect(snapshotLoads).toBe(baseline);
});
