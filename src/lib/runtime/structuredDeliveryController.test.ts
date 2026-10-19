import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import { conversationDeliverabilityFromRecord } from "@/lib/conversation/deliverability";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { registryLockHolder } from "@/lib/agent/registryLockHolderFixture";
import { migrationDeliveryFixture } from "@/test-helpers/migrationDelivery";
import type { RuntimeHostClient } from "./client";
import {
  bindStructuredDeliveryQueue,
  publishStructuredHostProjection,
  terminateStructuredDeliveryHost,
} from "./structuredDeliveryController";

for (const qualified of [false, true]) test(`${qualified ? "qualified" : "unqualified"} termination preserves a replacement host claimed during writer admission`, async () => {
  const f = migrationDeliveryFixture();
  const registeredHost = qualified ? Object.assign(f.host, { releaseIfOwned: async () => true }) : f.host;
  const holder = registryLockHolder(path.join(f.root, "registry.sqlite"));
  const originalWithWriter = SqliteAgentRegistryStore.prototype.withWriter;
  let observedWait!: () => void;
  const waiting = new Promise<void>(resolve => { observedWait = resolve; });
  const withWriter = spyOn(SqliteAgentRegistryStore.prototype, "withWriter").mockImplementation((async function (
    this: SqliteAgentRegistryStore, ...args: Parameters<SqliteAgentRegistryStore["withWriter"]>
  ) {
    if (this.filename === holder.sqliteFilename) observedWait();
    return originalWithWriter.apply(this, args);
  }) as typeof originalWithWriter);
  const originalDeliveryWrite = f.registry.deliveryWriteOrBusy.bind(f.registry);
  let replacementPublished = false;
  const admission = spyOn(f.registry, "deliveryWriteOrBusy").mockImplementation(async (correlation, write) => {
    if (correlation.label !== "registry.terminateStructuredHost") return originalDeliveryWrite(correlation, write);
    return originalDeliveryWrite(correlation, () => {
      const current = f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
      f.registry.upsert({ ...current, status: "live", claimEpoch: 2, claimOwner: "replacement-owner",
        structuredHost: { ...current.structuredHost!, endpoint: "replacement", writerClaimEpoch: 2 } });
      replacementPublished = true;
      return write();
    });
  });
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: registeredHost }], { registry: f.registry, client: f.client,
      watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
    await holder.hold();
    const termination = terminateStructuredDeliveryHost(f.key, qualified ? { pid: process.pid + 100_000, startIdentity: "expected-old-host" } : undefined);
    await waiting;
    await holder.release();
    expect(await termination).toBe(true);
    expect(replacementPublished).toBe(true);
    expect(f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]).toMatchObject({
      status: "live", claimEpoch: 2, claimOwner: "replacement-owner",
      structuredHost: { endpoint: "replacement", writerClaimEpoch: 2 },
    });
  } finally {
    admission.mockRestore();
    withWriter.mockRestore();
    await holder.close();
    await f.cleanup();
  }
});

test("unqualified termination still retires its captured host row", async () => {
  const f = migrationDeliveryFixture();
  try {
    await bindStructuredDeliveryQueue([{ key: f.key, host: f.host }], { registry: f.registry, client: f.client,
      watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
    expect(await terminateStructuredDeliveryHost(f.key)).toBe(true);
    expect(f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]).toMatchObject({
      status: "dead", claimOwner: null, structuredHost: null,
    });
  } finally { await f.cleanup(); }
});

test("structured host projection publishes a files revision for connected viewers", async () => {
  let filesRevision = 14;
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const client = {
    append: async (event: { kind: string; payload: Record<string, unknown> }) => {
      events.push(event);
      if (event.kind === "files.revision") filesRevision = Number(event.payload.filesRevision);
    },
    snapshot: async () => ({ filesRevision }),
  } as unknown as RuntimeHostClient;

  await publishStructuredHostProjection(client, {
    scope: { type: "session", id: "conversation-one" },
    kind: "session-status",
    producer: { kind: "claude-broker" },
    payload: {
      conversationId: "conversation-one",
      host: "dead",
      hostKind: "unhosted",
      turn: "idle",
    },
  });

  expect(events.map((event) => event.kind)).toEqual(["session-status", "files.revision"]);
  expect(events[1]?.payload).toEqual({ filesRevision: 15 });
});

test("startup adoption repairs a stale completed structured launch before draining delivery", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-1583-controller-"));
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const profile = emptyLaunchProfile({ cwd: directory, title: "Issue 1583 controller fixture" });
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd: directory,
    accountId: "default",
    transport: "structured",
    expectedArtifactPath: artifactPath,
    launchProfile: profile,
  });
  if (begun.kind !== "created") throw new Error("expected a structured launch receipt");
  const owner = captureProcessIdentity(process.pid);
  const key = { engine: "codex" as const, sessionId };
  const entry = {
    key,
    artifactPath,
    cwd: directory,
    accountId: "default",
    launchProfile: profile,
    status: "idle" as const,
    host: null,
    structuredHost: {
      kind: "codex-app-server" as const,
      endpoint: "stdio:issue-1583-controller",
      process: owner,
      eventCursor: 1,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${JSON.stringify(owner)}`,
    pendingAction: "spawn" as const,
    structuredHostOperationId: begun.receipt.launchId,
  };
  if (registry.stageStructuredSpawn(begun.receipt.launchId, entry).kind !== "settled") {
    throw new Error("expected structured launch staging to settle");
  }
  const evidence = {
    key: entry.key,
    artifactPath: entry.artifactPath,
    cwd: entry.cwd,
    accountId: entry.accountId,
    launchProfile: entry.launchProfile,
    status: entry.status,
    host: entry.host,
    structuredHost: {
      ...entry.structuredHost,
      endpoint: "runtime:reconciled",
      process: null,
      writerClaimEpoch: 0,
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  };
  const recovered = registry.recoverStructuredSpawnFromEvidence(begun.receipt.launchId, {
    ...evidence,
  });
  if (recovered.kind !== "settled") throw new Error("expected structured launch recovery to settle");
  const legacyEntry = { ...recovered.entry };
  delete legacyEntry.structuredHostOperationId;
  registry.upsert({ ...legacyEntry, pendingAction: "spawn" });

  expect(await conversationDeliverabilityFromRecord(registry.snapshot(), {
    conversationId: begun.receipt.conversationId,
  })).toMatchObject({ condition: "synchronizing", deliverable: false });

  await bindStructuredDeliveryQueue([], { registry, client: null });
  expect(registry.readOnlySnapshot().entries[`codex:${sessionId}`]?.pendingAction).toBe("spawn");

  const client = {
    snapshot: async () => ({ filesRevision: 0, sessions: [] }),
    append: async () => {},
    effectBatch: async () => [],
    operationStatus: async () => null,
    transitionOperation: async () => { throw new Error("unexpected operation transition"); },
  } as unknown as RuntimeHostClient;
  try {
    await bindStructuredDeliveryQueue([], { registry, client });
    expect(registry.readOnlySnapshot().entries[`codex:${sessionId}`]?.pendingAction).toBeNull();
    expect(await conversationDeliverabilityFromRecord(registry.snapshot(), {
      conversationId: begun.receipt.conversationId,
    })).toMatchObject({ condition: "deliverable", deliverable: true });
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
  }
});


test("an unpublished staged host stays out of delivery resolution and is released on demotion", async () => {
  const { retainUnpublishedStructuredLaunchHost, releaseStructuredDeliveryHostsForDemotion, hasStructuredDeliveryHost } = await import("./structuredDeliveryController");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-unpublished-release-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const key = { engine: "codex" as const, sessionId: crypto.randomUUID() };
  let released = 0;
  const host = { health: async () => ({ status: "idle" }) } as unknown as import("./structuredDeliveryController").StructuredDeliveryHost["host"];
  const forget = retainUnpublishedStructuredLaunchHost({ key, host, registry, release: async () => { released++; } });
  try {
    expect(hasStructuredDeliveryHost(key)).toBe(false);
    await releaseStructuredDeliveryHostsForDemotion();
    await releaseStructuredDeliveryHostsForDemotion();
    expect(released).toBe(1);
    expect(hasStructuredDeliveryHost(key)).toBe(false);
  } finally {
    forget();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("concurrent unpublished releases run once while runtime projection is unavailable", async () => {
  const { retainUnpublishedStructuredLaunchHost, releaseStructuredDeliveryHost } = await import("./structuredDeliveryController");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-unpublished-outage-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const key = { engine: "codex" as const, sessionId: crypto.randomUUID() };
  const owner = captureProcessIdentity(process.pid);
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: directory, transport: "structured", accountId: "test", launchProfile: emptyLaunchProfile({ cwd: directory, title: "Recover staged publication" }) });
  if (begun.kind !== "created") throw new Error("fixture reservation failed");
  registry.stageStructuredSpawn(begun.receipt.launchId, {
    key, artifactPath: path.join(directory, "session.jsonl"), cwd: directory, accountId: "test",
    status: "idle", host: null, claimEpoch: 1, claimOwner: `structured-host:${JSON.stringify(owner)}`, pendingAction: "spawn",
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:pending", process: owner, eventCursor: 0,
      protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
  });
  const client = {
    snapshot: async () => { throw new Error("runtime host request timed out"); },
    append: async () => { throw new Error("runtime host request timed out"); },
  } as unknown as RuntimeHostClient;
  await bindStructuredDeliveryQueue([], { registry, client, deferStartupWork: true });
  let released = 0;
  let resolve!: () => void;
  const blocked = new Promise<void>((done) => { resolve = done; });
  const host = { health: async () => ({ status: "idle" }) } as unknown as import("./structuredDeliveryController").StructuredDeliveryHost["host"];
  const forget = retainUnpublishedStructuredLaunchHost({ key, host, registry, release: async () => { released++; await blocked; } });
  try {
    const first = releaseStructuredDeliveryHost(key);
    const second = releaseStructuredDeliveryHost(key);
    await Promise.resolve();
    expect(released).toBe(1);
    resolve();
    expect(await Promise.all([first, second])).toEqual([true, true]);
  } finally {
    resolve();
    forget();
    await bindStructuredDeliveryQueue([]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("seat inbox echo stamps every member once with its own ingress and excludes history", async () => {
  const subject = await import("./structuredDeliveryController");
  expect(subject.observeDeliveryEcho).toBeFunction();
  const records = new Map(["one", "two", "foreign"].map((id, i) => [id, { conversationId: id === "foreign" ? "other" : "seat", ingressAt: `2026-10-17T06:00:0${i}.000Z`, engineEchoAt: null as string | null }]));
  let writes = 0;
  const progress = { get: (id: string) => records.get(id), timing: (id: string, values: { engineEchoAt: string }) => {
    const record = records.get(id)!;
    if (!record.engineEchoAt) { record.engineEchoAt = values.engineEchoAt; writes++; }
  } };
  const echo = { operationId: "inbox_batch", memberOperationIds: ["one", "two", "foreign"], at: "2026-10-17T06:01:00.000Z" };
  subject.observeDeliveryEcho(progress, "seat", echo, false);
  expect(writes).toBe(0);
  subject.observeDeliveryEcho(progress, "seat", echo);
  subject.observeDeliveryEcho(progress, "seat", echo);
  expect(writes).toBe(2);
  expect(records.get("one")!.engineEchoAt).toBe(echo.at);
  expect(records.get("two")!.ingressAt).toBe("2026-10-17T06:00:01.000Z");
  expect(records.get("foreign")!.engineEchoAt).toBeNull();
  const latency = ["one", "two"].map(id => Date.parse(records.get(id)!.engineEchoAt!) - Date.parse(records.get(id)!.ingressAt));
  expect(latency).toEqual([60000, 59000]);
  subject.observeDeliveryEcho(progress, "seat", { ...echo, at: null });
  expect(writes).toBe(2);
});
