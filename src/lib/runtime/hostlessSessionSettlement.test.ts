/* #2515: a turn whose host died is closed in the runtime journal by the
   delivery controller's own sweep. The registry is real and its rows are ended
   by the registry's own writers; the runtime host is a journal small enough to
   read back. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { AgentRegistry, type ProcessIdentity } from "@/lib/agent/registry";
import { captureProcessIdentity } from "@/lib/processIdentity";

import { RuntimeJournal } from "../../runtime-host/journal";
import type { RuntimeHostClient } from "./client";
import type { RuntimeSession } from "./contracts";
import { bindStructuredDeliveryQueue, settleHostlessSessionProjections } from "./structuredDeliveryController";

let directory: string;
let registry: AgentRegistry;
let deadProcess: ProcessIdentity;
let sessions: Map<string, RuntimeSession>;
let appended: { conversationId: string; host: string; turn: string; activeTurnId: unknown }[];
let keyedReads: string[];
let snapshots: number;
let client: RuntimeHostClient;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "hostless-sessions-"));
  registry = new AgentRegistry(join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const child = Bun.spawn(["sleep", "30"]);
  const identity = captureProcessIdentity(child.pid);
  child.kill();
  await child.exited;
  if (!identity) throw new Error("the fixture process left no identity");
  deadProcess = identity;
  sessions = new Map();
  appended = [];
  keyedReads = [];
  snapshots = 0;
  /* The journal's own merge for a session-status event, so a second read sees
     what the first one published. */
  client = {
    snapshot: async () => { snapshots += 1; return { filesRevision: 0, sessions: [...sessions.values()] }; },
    readSession: async ({ conversationId }: { conversationId: string }) => { keyedReads.push(conversationId); return sessions.get(conversationId) ?? null; },
    append: async (event: { kind: string; scope: { id: string }; payload: Partial<RuntimeSession> }) => {
      if (event.kind !== "session-status") return;
      const merged = { ...sessions.get(event.scope.id), ...event.payload } as RuntimeSession;
      sessions.set(event.scope.id, merged);
      appended.push({ conversationId: event.scope.id, host: merged.host, turn: merged.turn, activeTurnId: merged.activeTurnId });
    },
    effectBatch: async () => [],
    operationStatus: async () => null,
  } as unknown as RuntimeHostClient;
});

afterEach(async () => {
  await bindStructuredDeliveryQueue([], { registry, client: null });
  rmSync(directory, { recursive: true, force: true });
});

/** A structured conversation as a launch leaves it, with its session row. */
function hosted(process: ProcessIdentity, row: Partial<RuntimeSession> = {}) {
  const artifactPath = join(directory, `${randomUUID()}.jsonl`);
  writeFileSync(artifactPath, "");
  const conversation = registry.ensureConversation("codex", artifactPath, "fixture");
  const key = { engine: "codex" as const, sessionId: conversation.generations[0]!.id };
  registry.upsert({ key, artifactPath, cwd: directory, accountId: "fixture", status: "live", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: null,
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:fixture", process,
      eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
  sessions.set(conversation.id, { conversationId: conversation.id, sessionKey: key, hostKind: "codex-app-server",
    host: "hosted", turn: "running", activeTurnId: "turn-1", provenance: "structured", artifactPath, attentionIds: [], ...row } as RuntimeSession);
  return { id: conversation.id, key };
}

/** The registry ends the row of a host that is gone: `dead`, no host columns. */
function end(fixture: { id: string; key: { engine: "codex"; sessionId: string } }): void {
  expect(registry.terminateInactiveStructuredHost(fixture.id as `conversation_${string}`, fixture.key)).toBe("current");
  expect(registry.readOnlySnapshot().entries[`codex:${fixture.key.sessionId}`]).toMatchObject({ status: "dead", structuredHost: null });
}

const closed = (id: string) => ({ conversationId: id, host: "dead", turn: "unknown", activeTurnId: null });

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

test("the controller's own timer closes the open turn of a host that died with the Viewer", async () => {
  const dead = hosted(deadProcess);
  end(dead);
  const recovering = hosted(deadProcess, { host: "recovering", turn: "unknown", activeTurnId: null });
  end(recovering);
  await bindStructuredDeliveryQueue([], { registry, client, hostlessSettleIntervalMs: 10 });
  /* Startup publishes nothing for a row with no host columns, and reads nothing for it. */
  expect(appended).toEqual([]);
  await until(() => appended.length === 2, "the sweep");
  expect(appended).toContainEqual(closed(dead.id));
  expect(appended).toContainEqual(closed(recovering.id));
  expect(sessions.get(dead.id)).toMatchObject({ host: "dead", turn: "unknown", activeTurnId: null });
  /* Keyed reads of the two ended rows only, no snapshot, and nothing published twice. */
  await Bun.sleep(60);
  expect([...new Set(keyedReads)].sort()).toEqual([dead.id, recovering.id].sort());
  expect(snapshots).toBe(0);
  expect(appended).toHaveLength(2);
});

test("a host that ends while the Viewer keeps running has its turn closed by the next sweep", async () => {
  const fixture = hosted(deadProcess);
  await bindStructuredDeliveryQueue([], { registry, client, hostlessSettleIntervalMs: 0 });
  /* Still `live` in the registry: the startup fallback republishes the row's
     own words, and the turn stays open. */
  expect(sessions.get(fixture.id)).toMatchObject({ turn: "running" });
  expect(await settleHostlessSessionProjections()).toBe(0);
  end(fixture);
  appended.length = 0;
  keyedReads.length = 0;
  expect(await settleHostlessSessionProjections()).toBe(1);
  expect(appended).toEqual([closed(fixture.id)]);
  /* Settled once: a later sweep reads the closed row again and publishes nothing. */
  expect(await settleHostlessSessionProjections()).toBe(0);
  expect(keyedReads).toEqual([fixture.id, fixture.id]);
  expect(appended).toEqual([closed(fixture.id)]);
});

test("a session a process can still own, or one with no open turn, is left alone", async () => {
  await bindStructuredDeliveryQueue([], { registry, client, hostlessSettleIntervalMs: 0 });
  /* A live process under a row that still hosts it. */
  const live = hosted(captureProcessIdentity(process.pid)!);
  /* A status word that says dead while the process the row records still answers. */
  const lagging = hosted(captureProcessIdentity(process.pid)!);
  registry.upsert({ ...registry.readOnlySnapshot().entries[`codex:${lagging.key.sessionId}`]!, status: "dead" });
  /* A row ended, its host gone, and no turn open: nothing here to close. */
  const idle = hosted(deadProcess, { turn: "idle", activeTurnId: null });
  end(idle);
  /* A session the registry holds no conversation for proves nothing either way. */
  sessions.set("conversation_unknown", { conversationId: "conversation_unknown", host: "hosted", turn: "running", activeTurnId: "turn-1" } as RuntimeSession);
  expect(await settleHostlessSessionProjections()).toBe(0);
  expect(appended).toEqual([]);
  /* Only the row the registry ended was even asked about. */
  expect(keyedReads).toEqual([idle.id]);
  expect(sessions.get(live.id)).toMatchObject({ host: "hosted", turn: "running" });
  expect(sessions.get(lagging.id)).toMatchObject({ host: "hosted", turn: "running", activeTurnId: "turn-1" });
  expect(sessions.get(idle.id)).toMatchObject({ host: "hosted", turn: "idle" });
});

test("a backlog of ended rows is worked through in bounded sweeps, newest first", async () => {
  const backlog = Array.from({ length: 70 }, () => { const fixture = hosted(deadProcess); end(fixture); return fixture; });
  await bindStructuredDeliveryQueue([], { registry, client, hostlessSettleIntervalMs: 0 });
  expect(await settleHostlessSessionProjections()).toBe(64);
  expect(keyedReads).toHaveLength(64);
  /* The six left over go first; the rest of the batch reads again the rows read longest ago. */
  expect(await settleHostlessSessionProjections()).toBe(6);
  expect(keyedReads).toHaveLength(128);
  expect(new Set(keyedReads)).toEqual(new Set(backlog.map((fixture) => fixture.id)));
  expect(new Set(appended.map((event) => event.conversationId))).toEqual(new Set(backlog.map((fixture) => fixture.id)));
  /* Every later sweep stays inside the batch and takes the rows in turn. */
  keyedReads.length = 0;
  expect(await settleHostlessSessionProjections()).toBe(0);
  expect(await settleHostlessSessionProjections()).toBe(0);
  expect(keyedReads).toHaveLength(128);
  expect(new Set(keyedReads.slice(0, 70)).size).toBe(70);
  expect(appended).toHaveLength(70);
  expect(snapshots).toBe(0);
});

test("a journal read that fails settles nothing and is asked again on the next sweep", async () => {
  const fixture = hosted(deadProcess);
  await bindStructuredDeliveryQueue([], { registry, client, hostlessSettleIntervalMs: 0 });
  end(fixture);
  appended.length = 0;
  const read = client.readSession!;
  (client as { readSession: unknown }).readSession = async () => { throw new Error("socket unavailable"); };
  expect(await settleHostlessSessionProjections()).toBe(0);
  expect(appended).toEqual([]);
  (client as { readSession: unknown }).readSession = read;
  expect(await settleHostlessSessionProjections()).toBe(1);
  expect(appended).toEqual([closed(fixture.id)]);
});

test("a client with no keyed read answers from one snapshot", async () => {
  delete (client as { readSession?: unknown }).readSession;
  const fixture = hosted(deadProcess);
  await bindStructuredDeliveryQueue([], { registry, client, hostlessSettleIntervalMs: 0 });
  end(fixture);
  appended.length = 0;
  snapshots = 0;
  expect(await settleHostlessSessionProjections()).toBe(1);
  expect(appended).toEqual([closed(fixture.id)]);
  expect(snapshots).toBe(1);
  /* A later sweep asks again with one more snapshot and publishes nothing. */
  expect(await settleHostlessSessionProjections()).toBe(0);
  expect(snapshots).toBe(2);
  expect(appended).toEqual([closed(fixture.id)]);
  /* With no ended row left there is nothing to ask about, so nothing is read. */
  registry.upsert({ ...registry.readOnlySnapshot().entries[`codex:${fixture.key.sessionId}`]!, status: "live", claimOwner: "fixture" } as never);
  expect(await settleHostlessSessionProjections()).toBe(0);
  expect(snapshots).toBe(2);
});

test("a process that publishes no delivery controller settles nothing", async () => {
  const fixture = hosted(deadProcess);
  end(fixture);
  expect(await settleHostlessSessionProjections()).toBe(0);
  expect(appended).toEqual([]);
  expect(keyedReads).toEqual([]);
});

test("a session row published open after the first reading is closed by the next sweep", async () => {
  /* The real journal, so a late write lands exactly as a host's own would. */
  const journal = new RuntimeJournal(join(directory, "runtime.sqlite"), { structuredHosts: true });
  const real = { snapshot: async () => journal.snapshot(), readSession: async (identity: { conversationId: string }) => journal.readSession(identity),
    append: async (event: never) => journal.append(event), effectBatch: async () => [], operationStatus: async () => null } as unknown as RuntimeHostClient;
  const fixture = hosted(deadProcess);
  end(fixture);
  /* A host the registry never ended, published open at the same moment. */
  const live = hosted(captureProcessIdentity(process.pid)!);
  const publish = (id: string, eventKey: string) => journal.append({ scope: { type: "session", id }, kind: "session-status",
    producer: { kind: "codex-app-server", eventKey }, payload: sessions.get(id)! } as never);
  try {
    await bindStructuredDeliveryQueue([], { registry, client: real, hostlessSettleIntervalMs: 0 });
    /* The first reading finds no session row at all. */
    expect(journal.readSession({ conversationId: fixture.id })).toBeNull();
    expect(await settleHostlessSessionProjections()).toBe(0);
    publish(fixture.id, "late-status");
    publish(live.id, "live-status");
    expect(journal.readSession({ conversationId: fixture.id })).toMatchObject({ turn: "running", activeTurnId: "turn-1" });
    expect(await settleHostlessSessionProjections()).toBe(1);
    expect(journal.readSession({ conversationId: fixture.id })).toMatchObject({ host: "dead", turn: "unknown", activeTurnId: null });
    /* Closed again after a second late write, and quiet once nothing is open. */
    publish(fixture.id, "later-status");
    expect(await settleHostlessSessionProjections()).toBe(1);
    expect(await settleHostlessSessionProjections()).toBe(0);
    expect(journal.readSession({ conversationId: fixture.id })).toMatchObject({ host: "dead", activeTurnId: null });
    expect(journal.readSession({ conversationId: live.id })).toMatchObject({ host: "hosted", turn: "running", activeTurnId: "turn-1" });
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
  }
});
