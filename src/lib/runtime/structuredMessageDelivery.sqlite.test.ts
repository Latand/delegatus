import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { drainFile, activeDrain, releaseDrain, writeDrain } from "@/lib/selfUpdate/drain";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "./client";
import { deliverHeldStructuredMessage, enqueueStructuredMessage } from "./structuredMessageDelivery";
import { recoverDeadStructuredConversation } from "./structuredRecovery";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";

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

for (const projection of ["missing", "dead"] as const) {
  for (const cohort of ["fresh-agent", "accepted-agent", "operator"] as const) {
    test(`update drain recovery preserves ${cohort} admission with ${projection} projection`, async () => {
      const directory = fs.mkdtempSync(path.join(sandbox, "drain-recovery-"));
      const sessionId = crypto.randomUUID();
      const artifactPath = path.join(directory, `${sessionId}.jsonl`);
      fs.writeFileSync(artifactPath, "");
      const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
      const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
      const profile = emptyLaunchProfile({ cwd: directory });
      registry.reconcileConversations([{ engine: "codex", path: artifactPath, accountId: "default",
        launchProfile: profile, turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: new Date().toISOString() }]);
      const conversation = registry.conversationForPath(artifactPath)!;
      const key = { engine: "codex" as const, sessionId };
      const host = { kind: "codex-app-server" as const, endpoint: "stdio:drain-recovery", process: null,
        eventCursor: 0, protocolVersion: "v2", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] };
      registry.upsert({ key, artifactPath, cwd: directory, accountId: "default", launchProfile: profile,
        status: "dead", host: null, structuredHost: host, claimEpoch: 1, claimOwner: null, pendingAction: null });
      const publish = (live: boolean) => journal.append({ scope: { type: "session", id: conversation.id }, kind: "session-status",
        payload: { conversationId: conversation.id, sessionKey: key, artifactPath, cwd: directory, accountId: "default",
          hostKind: "codex-app-server", host: live ? "hosted" : "dead", turn: "idle", provenance: "structured",
          activeTurnId: null, capabilities: { steer: true, structuredAttention: true } } });
      if (projection === "dead") publish(false);
      let launches = 0;
      const client = {
        readSession: async (identity) => journal.readSession(identity),
        command: async (command) => journal.executeOperation(command),
        operationStatus: async (operationId) => journal.operationResult(operationId),
      } satisfies Partial<RuntimeHostClient> as RuntimeHostClient;
      const origin = cohort === "operator" ? { kind: "operator" as const } : { kind: "agent" as const, role: "builder" };
      const request = { path: artifactPath, conversationId: conversation.id, text: "continue the accepted work",
        clientMessageId: "drain-recovery-message", origin };
      const accepted = cohort === "accepted-agent"
        ? registry.holdDelivery(conversation.id, request.text, request.clientMessageId, "text", [], null, { origin }) : null;
      const file = drainFile();
      const lease = { id: "recovery-drain", target: "candidate", since: new Date(Date.now() + (accepted ? 1 : -1)).toISOString(),
        until: 0, persistent: true };
      writeDrain(file, lease);
      const dependencies = {
        enabled: () => true, client: () => client, registry: () => registry, kick: () => {}, requestMigrationTick: () => {},
        recover: (request: Parameters<typeof recoverDeadStructuredConversation>[0], deps?: Parameters<typeof recoverDeadStructuredConversation>[1]) =>
          recoverDeadStructuredConversation(request, { ...deps, transport: () => "structured", park: () => null,
            resolveAccount: () => ({ engine: "codex", accountId: "default", kind: "managed", home: directory,
              transcriptRoot: directory, env: { NODE_ENV: "test" } }), requestDeliveryDrain: () => {},
            spawn: async (input) => {
              launches += 1;
              const claimed = registry.claimStructuredHost(key, { pid: process.pid, startIdentity: null }, { allowUnhosted: true });
              if (!claimed?.structuredHost || !claimed.claimOwner) throw new Error("recovery claim unavailable");
              const staged = registry.stageStructuredSpawn(input.receipt.launchId, { key, artifactPath, cwd: directory,
                accountId: "default", launchProfile: profile, status: "idle", host: null,
                structuredHost: { ...claimed.structuredHost, endpoint: host.endpoint, process: { pid: process.pid, startIdentity: null } },
                claimEpoch: claimed.claimEpoch, claimOwner: claimed.claimOwner, pendingAction: "spawn" });
              expect(staged.kind).toBe("settled");
              expect(registry.finalizeStructuredSpawn(input.receipt.launchId).kind).toBe("settled");
              publish(true);
              return { ok: true, target: null, path: artifactPath, conversationId: conversation.id, launchId: input.receipt.launchId,
                launched: true, retrySafe: false, initialMessage: "delivered" as const, state: "settled" as const };
            } }),
      };
      try {
        expect(Object.keys(registry.snapshot().receipts)).toHaveLength(0);
        const held = await enqueueStructuredMessage(request, dependencies);
        expect(activeDrain(file)?.id).toBe(lease.id);
        if (cohort === "fresh-agent") {
          expect(launches).toBe(0);
          expect(held).toMatchObject({ ok: true, outcome: "held" });
          expect(Object.keys(registry.snapshot().receipts)).toHaveLength(0);
          expect(journal.snapshot().recentOperations).toHaveLength(0);
          const duplicate = await enqueueStructuredMessage(request, dependencies);
          expect(duplicate).toMatchObject({ outcome: "held", operationId: held?.operationId });
          expect(launches).toBe(0);
          expect(Object.keys(registry.snapshot().receipts)).toHaveLength(0);
          const reservation = registry.pendingDeliveries(conversation.id)[0]!;
          if (projection === "missing") {
            const delivery = await deliverHeldStructuredMessage({ conversationId: conversation.id, path: artifactPath,
              deliveryId: reservation.command.operationId, clientMessageId: request.clientMessageId,
              text: request.text, command: reservation.command }, dependencies);
            expect(delivery).toMatchObject({ outcome: "held" });
          }
          expect(launches).toBe(0);
          expect(Object.keys(registry.snapshot().receipts)).toHaveLength(0);
        } else {
          expect(held?.ok).toBe(true);
          expect(launches).toBe(1);
          if (accepted) expect(held?.operationId).toBe(accepted.command.operationId);
        }
        releaseDrain(file, lease.id);
        await enqueueStructuredMessage(request, dependencies);
        const replay = await enqueueStructuredMessage(request, dependencies);
        expect(replay?.ok).toBe(true);
        expect(replay?.operationId).toBe(held?.operationId);
        expect(launches).toBe(1);
        expect(Object.values(registry.snapshot().receipts).filter(receipt => receipt.purpose === "resume-successor")).toHaveLength(1);
        const effects = journal.effectBatch(100, ["runtime.send"]);
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({ payload: { operationId: held?.operationId, idempotencyKey: request.clientMessageId, origin } });
      } finally {
        releaseDrain(file, lease.id);
        journal.close();
        registry.close();
      }
    });
  }
}

test("queued recovery retains admission when the update hold lands during its transition", async () => {
  const directory = fs.mkdtempSync(path.join(sandbox, "queued-drain-"));
  const artifactPath = path.join(directory, `${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const conversation = registry.ensureConversation("codex", artifactPath, "default");
  const origin = { kind: "agent" as const, role: "builder" };
  const delivery = registry.holdDelivery(conversation.id, "fresh queued input", "queued-drain-message", "text", [], null, { origin });
  const operationId = delivery.command.operationId;
  journal.append({ scope: { type: "session", id: conversation.id }, kind: "session-status", payload: {
    conversationId: conversation.id, sessionKey: { engine: "codex", sessionId: conversation.generations.at(-1)!.id },
    hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured", artifactPath,
    capabilities: { steer: true, structuredAttention: true }, activeTurnId: null,
  } });
  journal.executeOperation({ kind: "send", operationId, conversationId: conversation.id, text: delivery.text,
    idempotencyKey: delivery.clientMessageId!, policy: "interrupt-active", origin });
  expect(journal.operationResult(operationId)?.receipt.status).toBe("queued");
  expect(journal.effectBatch(100, ["runtime.send"])).toHaveLength(1);
  const lease = { id: "queued-recovery-drain", target: "candidate", since: delivery.createdAt, until: 0, persistent: true };
  const file = drainFile();
  let launches = 0;
  let checked: Parameters<typeof recoverDeadStructuredConversation>[0] | undefined;
  const client = {
    snapshot: async () => journal.snapshot(),
    append: async (event) => journal.append(event),
    effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
    operationStatus: async (id) => journal.operationResult(id),
    transitionOperation: async (id, status, details, options) => {
      // The queue already passed its hold read. Close admission before its
      // awaited transition returns to the real controller recovery callback.
      writeDrain(file, lease);
      return journal.transitionOperation(id, status, details, options);
    },
  } satisfies Partial<RuntimeHostClient> as RuntimeHostClient;
  const recoveryDependencies: import("./structuredRecovery").StructuredRecoveryDependencies = {
    registry, client, transport: () => "structured", park: () => null, requestDeliveryDrain: () => {},
    resolveAccount: () => ({ engine: "codex", accountId: "default", kind: "managed", home: directory,
      transcriptRoot: directory, env: { NODE_ENV: "test" } }),
    spawn: async input => {
      launches += 1;
      return { ok: true, target: null, path: artifactPath, conversationId: conversation.id, launchId: input.receipt.launchId,
        launched: true, retrySafe: false, initialMessage: "delivered", state: "settled" };
    },
  };
  try {
    await bindStructuredDeliveryQueue([], { registry, client, recover: async request => {
      checked = request;
      return recoverDeadStructuredConversation(request, recoveryDependencies);
    } });
    await kickStructuredDeliveryQueue();
    expect(activeDrain(file)?.id).toBe(lease.id);
    expect(launches).toBe(0);
    expect(Object.keys(registry.snapshot().receipts)).toHaveLength(0);
    expect(checked).toMatchObject({ delivery: { operationId, origin, admittedAt: journal.operationResult(operationId)!.receipt.admittedAt } });
    expect(journal.operationResult(operationId)?.receipt.status).toBe("queued");
    await bindStructuredDeliveryQueue([], { client: null });
    releaseDrain(file, lease.id);
    expect(await recoverDeadStructuredConversation(checked!, recoveryDependencies)).toMatchObject({ spawned: true });
    expect(launches).toBe(1);
    expect(Object.keys(registry.snapshot().receipts)).toHaveLength(1);
    expect(journal.operationResult(operationId)?.receipt).toMatchObject({ operationId, idempotencyKey: delivery.clientMessageId });
  } finally {
    await bindStructuredDeliveryQueue([], { client: null });
    releaseDrain(file, lease.id);
    journal.close();
    registry.close();
  }
});
