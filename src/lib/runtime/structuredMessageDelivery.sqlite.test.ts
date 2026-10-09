import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile, type SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { linkedPeer } from "@/lib/links/linked";
import { updateRemoteProjects } from "@/lib/links/boardLinks";
import { atomicWrite, setShared, writePeers, type Link } from "@/lib/links/state";
import { projectIdentityFromRemote } from "@/lib/projects/identity";
import { recordProjectRemote } from "@/lib/projects/aliases";
import { DeliveryAdmissionRefusedError } from "@/lib/deliveryAdmission";
import { blockingWaitDiagnostics, resetBlockingWaitsForTests } from "@/lib/blockingWaits";
import type { RuntimeHostClient } from "./client";
import { advanceConversationMigration, drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import { longestLoopGap, registryLockHolder, sqliteRegistryFixture } from "@/lib/agent/registryLockHolderFixture";
import { DeliveryProgressStore } from "./deliveryProgress";
import { runtimeImageCapability } from "./runtimeImageStore";
import { deliverHeldStructuredMessage, enqueueStructuredMessage } from "./structuredMessageDelivery";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-message-sqlite-"));

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

for (const syncing of [false, true]) {
  for (const reseating of [false, true]) {
    for (const refusal of ["project_not_linked", "link_revoked"] as const) {
      test(`linked admission refuses ${reseating ? "a new account reseat" : "a reservation"} after the registry writer wait (${syncing ? "synchronizing" : "live"}, ${refusal})`, async () => {
        const fixture = sqliteRegistryFixture("llv-link-admission-wait");
        const { registry, sqliteFilename } = fixture;
        const artifactPath = "/sessions/link-admission.jsonl";
        const conversation = registry.ensureConversation("codex", artifactPath, "default");
        const generation = conversation.generations.at(-1)!;
        registry.upsert({
          key: { engine: "codex", sessionId: generation.id }, artifactPath,
          cwd: generation.launchProfile.cwd, accountId: generation.accountId, status: "idle", host: null,
          structuredHost: { kind: "codex-app-server", endpoint: "stdio:link-fixture",
            process: { pid: 101, startIdentity: "link-fixture" }, eventCursor: 1, protocolVersion: "v2",
            writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
          claimEpoch: 1, claimOwner: "structured-host:link-fixture", pendingAction: null,
        });
        if (reseating) registry.setEngineRouting("codex", "seat-active");
        const before = registry.snapshot();
        expect(conversation.migration).toBeNull();
        const holder = registryLockHolder(sqliteFilename);
        let authorized = true;
        let commands = 0;
        let guardReads = 0;
        let successorCreates = 0;
        let migrationTicks = 0;
        const provider: SuccessorProviderPort = {
          virtualSource: true,
          async create(input) {
            successorCreates++;
            return {
              operationId: input.operationId, nativeId: "link-successor",
              path: "/sessions/link-successor.jsonl", continuityPaths: [], historyHash: "fixture-history",
              host: { kind: "codex-app-server", identity: "link-successor", epoch: 1,
                verifiedAt: "2026-10-09T00:00:00.000Z" },
            };
          },
          async verify() {},
        };
        const client = {
          readSession: async () => ({ conversationId: conversation.id, artifactPath,
            sessionKey: { engine: "codex", sessionId: generation.id },
            hostKind: "codex-app-server", host: "hosted", turn: "busy",
            capabilities: { steer: true, structuredAttention: true } }),
          command: async () => { commands++; throw new Error("revoked message reached the host"); },
        } as unknown as RuntimeHostClient;
        try {
          await holder.hold(5_000);
          const sending = enqueueStructuredMessage({
            path: artifactPath, conversationId: conversation.id, policy: "queue",
            text: "Linked words awaiting authorization.", clientMessageId: "linked-writer-wait",
            admissionGuard: () => {
              guardReads++;
              if (!authorized) throw new DeliveryAdmissionRefusedError(refusal);
            },
          }, { enabled: () => true, client: () => syncing ? null : client, registry: () => registry,
            kick: () => {}, requestMigrationTick: () => { migrationTicks++; }, startupFailed: () => false, progress: null });
          // The preliminary check has passed, while the other process owns the writer.
          for (let tries = 0; tries < 100 && guardReads === 0; tries++) await Bun.sleep(5);
          expect(guardReads).toBeGreaterThan(0);
          await Bun.sleep(30);
          authorized = false;
          await holder.release();
          expect(await sending).toMatchObject({ ok: false, status: 409, error: refusal });
          expect(Object.values(registry.snapshot().heldDeliveries)).toHaveLength(0);
          expect(Object.values(registry.snapshot().deliveryOperationOwners)).toHaveLength(0);
          // A requested migration can run independently of the refused reservation.
          if (registry.conversation(conversation.id)!.migration) {
            await advanceConversationMigration(conversation.id, registry, provider);
          }
          const after = registry.snapshot();
          expect(successorCreates).toBe(0);
          expect(after.migrationIntents).toEqual(before.migrationIntents);
          expect(registry.conversation(conversation.id)!.migration).toBeNull();
          expect(registry.conversation(conversation.id)!.generations).toEqual(conversation.generations);
          expect(after.engineRouting).toEqual(before.engineRouting);
          expect(migrationTicks).toBe(0);
          expect(commands).toBe(0);
        } finally {
          await holder.close(); registry.close(); fixture.cleanup();
        }
      });
    }
  }
}


for (const syncing of [false, true]) {
  for (const admitted of [false, true]) {
    for (const refusal of ["project_not_linked", "link_revoked"] as const) {
      test(`linked reseat ${admitted ? "recovers an admitted operation" : "leaves no migration when reservation admission refuses"} (${syncing ? "synchronizing" : "live"}, ${refusal})`, async () => {
        const fixture = sqliteRegistryFixture("llv-link-reservation-wait");
        const { registry, sqliteFilename, root } = fixture;
        const previousState = process.env.LLV_STATE_DIR;
        process.env.LLV_STATE_DIR = path.join(root, "link-state");
        const holder = registryLockHolder(sqliteFilename);
        const artifactPath = "/sessions/link-reservation.jsonl";
        const conversation = registry.ensureConversation("codex", artifactPath, "default");
        const generation = conversation.generations.at(-1)!;
        const project = projectIdentityFromRemote("https://code.example.test/acme/reservation", root)!;
        const peer: Link = { id: "fixture-peer", install: crypto.randomUUID(), label: "Other", grantId: crypto.randomUUID(),
          token: "fixture", state: "active", lastCall: null, error: null, url: "http://127.0.0.1:1", store: crypto.randomUUID() };
        recordProjectRemote(project);
        setShared({ v: 1, all: false, projects: [project.project] });
        atomicWrite(path.join(process.env.LLV_STATE_DIR, "links/self.json"), { v: 1, installId: crypto.randomUUID() });
        writePeers({ v: 1, peers: [peer] });
        updateRemoteProjects(peer.id, [{ key: project.project, name: "reservation" }], peer.store);
        const guard = () => {
          const live = linkedPeer("peer", peer.id);
          if (!live) throw new DeliveryAdmissionRefusedError("link_revoked");
          if (!live.projects.has(project.project)) throw new DeliveryAdmissionRefusedError("project_not_linked");
        };
        guard();
        registry.upsert({ key: { engine: "codex", sessionId: generation.id }, artifactPath,
          cwd: generation.launchProfile.cwd, accountId: generation.accountId, status: "idle", host: null,
          structuredHost: { kind: "codex-app-server", endpoint: "stdio:link-fixture",
            process: { pid: 101, startIdentity: "link-fixture" }, eventCursor: 1, protocolVersion: "v2",
            writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
          claimEpoch: 1, claimOwner: "structured-host:link-fixture", pendingAction: null });
        registry.setEngineRouting("codex", "seat-active");
        const original = admitted ? registry.holdDelivery(conversation.id,
          "Words waiting for a durable reservation.", "linked-reservation-wait", "text", [], null, { policy: "queue" }) : null;
        const before = registry.snapshot();
        let commands = 0;
        let successorCreates = 0;
        let ticks = 0;
        let waiting = false;
        let guardDuringWait = false;
        const originalHold = registry.holdDeliveryOffLoop.bind(registry);
        const hold = spyOn(registry, "holdDeliveryOffLoop").mockImplementation(async (...args) => {
          if (!waiting) {
            await holder.hold(5_000);
            waiting = true;
          }
          return originalHold(...args);
        });
        const provider: SuccessorProviderPort = { virtualSource: true,
          async create(input) { successorCreates++; return { operationId: input.operationId, nativeId: "link-successor",
            path: "/sessions/link-successor.jsonl", continuityPaths: [], historyHash: "fixture-history",
            host: { kind: "codex-app-server", identity: "link-successor", epoch: 1, verifiedAt: "2026-10-09T00:00:00.000Z" } }; },
          async verify() {} };
        const client = { readSession: async () => ({ conversationId: conversation.id, artifactPath,
          sessionKey: { engine: "codex", sessionId: generation.id }, hostKind: "codex-app-server", host: "hosted", turn: "busy",
          capabilities: { steer: true, structuredAttention: true } }),
          command: async () => { commands++; throw new Error("refused message reached the host"); } } as unknown as RuntimeHostClient;
        try {
          const sending = enqueueStructuredMessage({ path: artifactPath, conversationId: conversation.id, policy: "queue",
            text: "Words waiting for a durable reservation.", clientMessageId: "linked-reservation-wait",
            admissionGuard: () => { if (waiting) guardDuringWait = true; guard(); } },
          { enabled: () => true, client: () => syncing ? null : client, registry: () => registry,
            kick: () => {}, requestMigrationTick: () => { ticks++; }, startupFailed: () => false, progress: null });
          for (let tries = 0; tries < 200 && !waiting; tries++) await Bun.sleep(5);
          expect(waiting).toBe(true);
          if (refusal === "project_not_linked") setShared({ v: 1, all: false, projects: [] });
          else writePeers({ v: 1, peers: [{ ...peer, state: "revoked" }] });
          await holder.release();
          const result = await sending;
          if (original) {
            expect(result).toMatchObject({ ok: true, outcome: "held", operationId: original.command.operationId });
            await advanceConversationMigration(conversation.id, registry, provider);
            const delivered: string[] = [];
            const delivery = { async deliver(input: { delivery: { command: { operationId: string } }; path: string }) {
              expect(input.path).toBe("/sessions/link-successor.jsonl");
              delivered.push(input.delivery.command.operationId);
              return "delivered" as const;
            } };
            await drainHeldDeliveries(conversation.id, delivery, registry);
            await drainHeldDeliveries(conversation.id, delivery, registry);
            expect(delivered).toEqual([original.command.operationId]);
            expect(successorCreates).toBe(1);
            expect(registry.conversation(conversation.id)!.migration?.phase).toBe("committed");
            expect(commands).toBe(0);
            return;
          }
          expect(result).toMatchObject({ ok: false, status: 409, error: refusal, admission: "refused" });
          expect(guardDuringWait).toBe(true);
          if (registry.conversation(conversation.id)!.migration) await advanceConversationMigration(conversation.id, registry, provider);
          const after = registry.snapshot();
          expect(successorCreates).toBe(0);
          expect(after.migrationIntents).toEqual(before.migrationIntents);
          expect(registry.conversation(conversation.id)!.migration).toBeNull();
          expect(registry.conversation(conversation.id)!.generations).toEqual(conversation.generations);
          expect(after.heldDeliveries).toEqual(before.heldDeliveries);
          expect(after.deliveryOperationOwners).toEqual(before.deliveryOperationOwners);
          expect(after.engineRouting).toEqual(before.engineRouting);
          expect(commands).toBe(0);
          expect(ticks).toBe(0);
        } finally {
          hold.mockRestore(); await holder.close(); registry.close();
          if (previousState === undefined) delete process.env.LLV_STATE_DIR;
          else process.env.LLV_STATE_DIR = previousState;
          fixture.cleanup();
        }
      });
    }
  }
}


for (const syncing of [false, true]) {
  test(`a full reservation queue rolls back its account reseat (${syncing ? "synchronizing" : "live"})`, async () => {
    const fixture = sqliteRegistryFixture("llv-link-full-reservation");
    const { registry } = fixture;
    const artifactPath = "/sessions/full-reservation.jsonl";
    try {
      const conversation = registry.ensureConversation("codex", artifactPath, "default");
      const generation = conversation.generations.at(-1)!;
      for (let n = 0; n < 100; n++) registry.holdDelivery(conversation.id, "Admitted words.", `admitted-${n}`);
      registry.setEngineRouting("codex", "seat-active");
      const before = registry.snapshot();
      const client = { readSession: async () => ({ conversationId: conversation.id, artifactPath,
        sessionKey: { engine: "codex", sessionId: generation.id }, hostKind: "codex-app-server", host: "hosted", turn: "busy",
        capabilities: { steer: true, structuredAttention: true } }),
        command: async () => { throw new Error("full queue reached the host"); } } as unknown as RuntimeHostClient;
      const result = await enqueueStructuredMessage({ path: artifactPath, conversationId: conversation.id,
        text: "Words exceeding the queue limit.", clientMessageId: "full-reservation", admissionGuard: () => {} },
      { enabled: () => true, client: () => syncing ? null : client, registry: () => registry,
        kick: () => {}, requestMigrationTick: () => {}, startupFailed: () => false, progress: null });
      expect(result).toMatchObject({ ok: false, error: "held delivery limit reached for conversation" });
      expect(registry.snapshot()).toEqual(before);
    } finally {
      registry.close(); fixture.cleanup();
    }
  });
}


for (const syncing of [false, true]) {
  test(`an admitted linked operation keeps its terminal recovery after revocation (${syncing ? "synchronizing" : "live"})`, async () => {
    const fixture = sqliteRegistryFixture("llv-link-admitted-recovery");
    const { registry } = fixture;
    const artifactPath = "/sessions/link-recovery.jsonl";
    try {
      const conversation = registry.ensureConversation("codex", artifactPath, "default");
      const generation = conversation.generations.at(-1)!;
      const original = registry.holdDelivery(conversation.id, "Already admitted words.", "link-recovery");
      registry.recordDeliveryOutcome(original.id, "delivered", null, "delivered");
      registry.setEngineRouting("codex", "seat-active");
      const before = registry.snapshot();
      let guardReads = 0;
      let commands = 0;
      const client = {
        readSession: async () => ({ conversationId: conversation.id, artifactPath,
          sessionKey: { engine: "codex", sessionId: generation.id },
          hostKind: "codex-app-server", host: "hosted", turn: "idle",
          capabilities: { steer: true, structuredAttention: true } }),
        command: async () => { commands++; throw new Error("terminal replay reached the host"); },
      } as unknown as RuntimeHostClient;
      const result = await enqueueStructuredMessage({
        path: artifactPath, conversationId: conversation.id,
        text: original.text, clientMessageId: original.clientMessageId!,
        admissionGuard: () => { guardReads++; throw new DeliveryAdmissionRefusedError("link_revoked"); },
      }, { enabled: () => true, client: () => syncing ? null : client, registry: () => registry,
        kick: () => {}, requestMigrationTick: () => {}, startupFailed: () => false, progress: null });
      expect(result).toMatchObject({ ok: true, outcome: "delivered", operationId: original.command.operationId });
      expect(guardReads).toBe(0);
      expect(commands).toBe(0);
      const after = registry.snapshot();
      expect(after.heldDeliveries).toEqual(before.heldDeliveries);
      expect(after.deliveryOperationOwners).toEqual(before.deliveryOperationOwners);
      expect(after.migrationIntents).toEqual(before.migrationIntents);
      expect(registry.conversation(conversation.id)!.migration).toBeNull();
      expect(registry.conversation(conversation.id)!.generations).toEqual(conversation.generations);
    } finally {
      registry.close(); fixture.cleanup();
    }
  });
}

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

function hostedSession(conversationId: string, artifactPath: string, sessionId: string, engine: "claude" | "codex", host: "hosted" | "dead", imageInput?: ReturnType<typeof runtimeImageCapability>) {
  return {
    conversationId, artifactPath,
    sessionKey: { engine, sessionId },
    hostKind: engine === "codex" ? "codex-app-server" : "claude-broker", host, turn: "idle",
    capabilities: { steer: engine === "codex", structuredAttention: true, ...(imageInput ? { imageInput } : {}) },
  };
}

test("an image reserved before a dead host recovers, whose rejection the lock refused, ends with the payload's rejection and reaches no host", async () => {
  /* docs/design/delivery-progress-and-drain.md, Note 2: a refused ending of a
     payload the recovered host cannot take answers held, and the drain
     enforces the same rejection before any command. */
  const made = sqliteRegistryFixture("llv-payload-refusal", { sqliteWriterDeadlineMs: 150 });
  const holder = registryLockHolder(made.sqliteFilename);
  const registry = made.registry;
  try {
    const artifactPath = "/sessions/payload-refusal.jsonl";
    const conversation = registry.ensureConversation("claude", artifactPath, "default");
    const generation = conversation.generations.at(-1)!;
    const imageRef = { sha256: "d".repeat(64), mime: "image/png" as const, bytes: 67 };
    const tooSmall = { ...runtimeImageCapability("claude", true), maxEncodedBytesPerRequest: 1 };
    let recovered = false;
    let commands = 0;
    const client = {
      readSession: async () => hostedSession(conversation.id, artifactPath, generation.id, "claude", recovered ? "hosted" : "dead", recovered ? tooSmall : undefined),
      command: async () => { commands += 1; throw new Error("a rejected payload reached the host"); },
      operationStatus: async () => null,
    } as unknown as RuntimeHostClient;
    const result = await enqueueStructuredMessage({
      path: artifactPath,
      conversationId: conversation.id,
      clientMessageId: "payload-refused",
      text: "",
      images: [{ base64: Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex").toString("base64"), mime: "image/png" }],
    }, {
      enabled: () => true,
      client: () => client,
      registry: () => registry,
      kick: () => {},
      recover: async () => {
        recovered = true;
        await holder.hold(500);
        return { target: null, path: artifactPath, conversationId: conversation.id as never, spawned: true };
      },
      storeImages: () => [imageRef],
      previewImageRefs: () => [imageRef],
    });
    expect(result).toMatchObject({ ok: true, outcome: "held" });
    const operationId = (result as { operationId: string }).operationId;
    expect(registry.pendingDeliveries(conversation.id)).toMatchObject([{ state: "assigned", command: { operationId } }]);

    await new Promise((resolve) => setTimeout(resolve, 600));
    await drainHeldDeliveries(conversation.id, {
      async deliver({ delivery, path: deliveryPath, clientMessageId }) {
        return await deliverHeldStructuredMessage({
          conversationId: conversation.id, path: deliveryPath, deliveryId: delivery.id, clientMessageId,
          text: delivery.text, command: delivery.command, imageRefs: delivery.runtimeImages,
        }, { enabled: () => true, client: () => client, registry: () => registry, kick: () => {} }) ?? "delivery-uncertain";
      },
    }, registry);
    expect(commands).toBe(0);
    const owner = registry.snapshot().deliveryOperationOwners[operationId]!;
    expect(owner).toMatchObject({ terminalState: "failed", terminalDisposition: "lost", terminalReason: "runtime image request encoding is too large" });
  } finally {
    await holder.close();
    registry.close();
    made.cleanup();
  }
});

test("a rejected admission's settle and a refused requeue wait off the loop and leave the reservation for a later pass", async () => {
  const made = sqliteRegistryFixture("llv-admission-writes", { sqliteWriterDeadlineMs: 150 });
  const holder = registryLockHolder(made.sqliteFilename);
  const registry = made.registry;
  try {
    const artifactPath = "/sessions/admission-writes.jsonl";
    const conversation = registry.ensureConversation("codex", artifactPath, "default");
    const generation = conversation.generations.at(-1)!;
    let answer: "rejected" | "queued" = "rejected";
    const client = {
      readSession: async () => hostedSession(conversation.id, artifactPath, generation.id, "codex", "hosted"),
      command: async (command: { operationId: string; idempotencyKey: string }) => {
        if (answer === "rejected") await holder.hold(300);
        return { operationId: command.operationId, replayed: false,
          receipt: { operationId: command.operationId, idempotencyKey: command.idempotencyKey, status: answer, reason: answer === "rejected" ? "no-claim" : null } };
      },
    } as unknown as RuntimeHostClient;
    resetBlockingWaitsForTests(() => {});
    const { value: rejected, gapMs } = await longestLoopGap(() => enqueueStructuredMessage({
      path: artifactPath, conversationId: conversation.id, clientMessageId: "rejected-settle", text: "rejected", policy: "queue",
    }, { enabled: () => true, client: () => client, registry: () => registry, kick: () => {}, requestMigrationTick: () => {} }));
    expect(rejected).toMatchObject({ ok: false, status: 409 });
    expect(gapMs).toBeLessThan(50);
    const rejectedOperation = (rejected as { operationId: string }).operationId;
    expect(blockingWaitDiagnostics().longest.find((sample) => sample.label === "delivery.settle")).toMatchObject({ synchronous: false, operationId: rejectedOperation });
    expect(blockingWaitDiagnostics().sites["registry-lock"]?.synchronousCount ?? 0).toBe(0);

    /* A claim that came back empty is requeued; the lock refuses the requeue,
       and the reservation stays assigned for the drain. */
    answer = "queued";
    const progress = new DeliveryProgressStore(null);
    const emptyClaim = new Proxy(registry, {
      get(target, property) {
        if (property === "beginDeliveryAttemptOffLoop") {
          return async () => { await holder.hold(500); return { acquired: true as const, value: null }; };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const held = await enqueueStructuredMessage({
      path: artifactPath, conversationId: conversation.id, clientMessageId: "requeue-refused", text: "requeue", policy: "queue",
    }, { enabled: () => true, client: () => client, registry: () => emptyClaim, kick: () => {}, requestMigrationTick: () => {}, progress });
    expect(held).toMatchObject({ ok: true, outcome: "held" });
    const heldOperation = (held as { operationId: string }).operationId;
    expect(registry.pendingDeliveries(conversation.id).find((item) => item.command.operationId === heldOperation)).toMatchObject({ state: "assigned", attempts: 0 });
    expect(progress.get(heldOperation)).toMatchObject({ waitReason: "checking", originalKey: "requeue-refused" });
    expect(progress.get(heldOperation)!.detail).toContain("requeue");
  } finally {
    await holder.close();
    registry.close();
    made.cleanup();
  }
});
