import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests } from "@/lib/blockingWaits";
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

test("a send admitted while another process holds the registry write lock waits off the event loop, correlated with its operation, and is commanded once", async () => {
  /* Review of incident 2026-10-06: the reservation and the claim of an
     ordinary send still spun for the registry lock on the Viewer's loop, so
     every other conversation and the watchdog waited with it, and the wait
     was recorded with no operation. */
  const filename = path.join(sandbox, "admission-lock.json");
  const sqliteFilename = path.join(sandbox, "admission-lock.sqlite");
  const artifactPath = "/sessions/admission-lock.jsonl";
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename });
  const conversation = registry.ensureConversation("codex", artifactPath, "default");
  const generation = conversation.generations.at(-1)!;
  const commands: string[] = [];
  const client = {
    readSession: async () => ({ conversationId: conversation.id, artifactPath,
      sessionKey: { engine: "codex", sessionId: generation.id },
      hostKind: "codex-app-server", host: "hosted", turn: "idle",
      capabilities: { steer: true, structuredAttention: true } }),
    command: async (command: { operationId: string; idempotencyKey: string }) => {
      commands.push(command.operationId);
      return { operationId: command.operationId, replayed: false,
        receipt: { operationId: command.operationId, idempotencyKey: command.idempotencyKey, status: "queued", reason: null } };
    },
  } as unknown as RuntimeHostClient;
  resetBlockingWaitsForTests(() => {});
  /* Another process, as in the incident: nothing in this one can release it. */
  const child = Bun.spawn([process.execPath, "-e", `
    const { Database } = require("bun:sqlite");
    const db = new Database(${JSON.stringify(sqliteFilename)});
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 500);
  `], { stdout: "pipe", stderr: "inherit" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    let last = performance.now();
    let gapMs = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      gapMs = Math.max(gapMs, now - last);
      last = now;
    }, 5);
    const startedAt = performance.now();
    let result;
    try {
      result = await enqueueStructuredMessage({
        path: artifactPath, conversationId: conversation.id,
        text: "admitted behind another writer", clientMessageId: "admission-lock-key", policy: "queue",
      }, { enabled: () => true, client: () => client, registry: () => registry, kick: () => {}, requestMigrationTick: () => {}, progress: null });
      /* A loop held from the first tick on shows only once a tick runs again. */
      await Bun.sleep(20);
    } finally {
      clearInterval(heartbeat);
    }
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(300);
    expect(gapMs).toBeLessThan(150);
    expect(result).toMatchObject({ ok: true, outcome: "queued" });
    const operationId = (result as { operationId: string }).operationId;
    expect(commands).toEqual([operationId]);
    const reservations = Object.values(registry.snapshot().heldDeliveries).filter((delivery) => delivery.clientMessageId === "admission-lock-key");
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ state: "delivery-uncertain", attempts: 1, command: { operationId } });
    const diagnostics = blockingWaitDiagnostics();
    const waited = diagnostics.longest.filter((sample) => sample.site === "registry-lock-async");
    expect(waited.length).toBeGreaterThan(0);
    for (const sample of waited) {
      expect(sample).toMatchObject({ synchronous: false, operationId });
      expect(["delivery.admit", "delivery.claim"]).toContain(sample.label!);
    }
    expect(Math.max(...waited.map((sample) => sample.durationMs))).toBeGreaterThanOrEqual(300);
    expect(diagnostics.longest.filter((sample) => sample.synchronous && sample.durationMs >= 100)).toEqual([]);
  } finally {
    await child.exited;
    registry.close();
  }
});
