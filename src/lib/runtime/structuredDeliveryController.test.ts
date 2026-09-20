import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { conversationDeliverabilityFromRecord } from "@/lib/conversation/deliverability";
import { captureProcessIdentity } from "@/lib/processIdentity";
import type { RuntimeHostClient } from "./client";
import {
  bindStructuredDeliveryQueue,
  publishStructuredHostProjection,
} from "./structuredDeliveryController";

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

  expect(conversationDeliverabilityFromRecord(registry.snapshot(), {
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
    expect(conversationDeliverabilityFromRecord(registry.snapshot(), {
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
