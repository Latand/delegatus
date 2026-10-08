/* #2515: a turn whose host died is closed in the runtime journal by the
   delivery controller's own sweep. The registry is real and its rows are ended
   by the registry's own writers; the runtime host is a journal small enough to
   read back. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { AgentRegistry, setAgentRegistryForTests, type ProcessIdentity } from "@/lib/agent/registry";
import { captureProcessIdentity } from "@/lib/processIdentity";

import { RuntimeJournal } from "../../runtime-host/journal";
import { RuntimeHost } from "../../runtime-host/host";
import { serveRuntimeHost } from "../../runtime-host/socket";
import { productionDeps } from "../selfUpdate/instance";
import { probeQuiet, type QuietPorts } from "../selfUpdate/quiet";
import type { Snapshot } from "../selfUpdate/types";
import { UnixRuntimeHostClient, type RuntimeHostClient } from "./client";
import type { RuntimeEventInput, RuntimeSession } from "./contracts";
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
      const merged = { ...sessions.get(event.scope.id), ...event.payload, revision: (sessions.get(event.scope.id)?.revision ?? 0) + 1 } as RuntimeSession;
      sessions.set(event.scope.id, merged);
      appended.push({ conversationId: event.scope.id, host: merged.host, turn: merged.turn, activeTurnId: merged.activeTurnId });
    },
    effectBatch: async () => [],
    operationStatus: async () => null,
  } as unknown as RuntimeHostClient;
  client.appendSessionFenced = async (event) => {
    if (typeof event.scope !== "object") throw new Error("session scope is required");
    if (sessions.get(event.scope.id)?.revision !== event.expectedSessionRevision) throw new Error("session revision changed");
    return client.append(event);
  };
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
    revision: 1, host: "hosted", turn: "running", activeTurnId: "turn-1", provenance: "structured", artifactPath, attentionIds: [], ...row } as RuntimeSession);
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

test("a client with no fenced append leaves settlement for a supporting host", async () => {
  const fixture = hosted(deadProcess);
  end(fixture);
  delete client.appendSessionFenced;
  await bindStructuredDeliveryQueue([], { registry, client, hostlessSettleIntervalMs: 0 });
  expect(await settleHostlessSessionProjections()).toBe(0);
  expect(appended).toEqual([]);
  expect(keyedReads).toEqual([]);
  expect(sessions.get(fixture.id)).toMatchObject({ turn: "running", activeTurnId: "turn-1" });
});

test("a session row published open after the first reading is closed by the next sweep", async () => {
  /* The real journal, so a late write lands exactly as a host's own would. */
  const journal = new RuntimeJournal(join(directory, "runtime.sqlite"), { structuredHosts: true });
  const real = { snapshot: async () => journal.snapshot(), readSession: async (identity: { conversationId: string }) => journal.readSession(identity),
    append: async (event: never) => journal.append(event), appendSessionFenced: async (event: never) => journal.append(event), effectBatch: async () => [], operationStatus: async () => null } as unknown as RuntimeHostClient;
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

/* The sweep's verdict against a launch that takes the conversation while one
   of its two awaited steps is in flight: the real journal, the registry's own
   writer for the new owner, and the drain's production liveness wiring. */
for (const held of ["read", "write"] as const) {
  test(`a new owner that takes the conversation during the sweep's ${held} keeps its running turn`, async () => {
    const fixture = hosted(deadProcess);
    end(fixture);
    const journal = new RuntimeJournal(join(directory, `race-${held}.sqlite`), { structuredHosts: true });
    const publish = (eventKey: string, payload: Partial<RuntimeSession>) => journal.append({ scope: { type: "session", id: fixture.id }, kind: "session-status",
      producer: { kind: "codex-app-server", eventKey }, payload: { ...sessions.get(fixture.id)!, ...payload } } as never);
    publish("old-running", {});
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const real = { snapshot: async () => journal.snapshot(), effectBatch: async () => [], operationStatus: async () => null,
      readSession: async (identity: { conversationId: string }) => {
        const session = journal.readSession(identity);
        if (held === "read") { entered(); await gate; }
        return session;
      },
      append: async (event: never) => journal.append(event),
      appendSessionFenced: async (event: never) => {
        if (held === "write") { entered(); await gate; }
        return journal.append(event);
      } } as unknown as RuntimeHostClient;
    const successor = Bun.spawn(["sleep", "60"]);
    setAgentRegistryForTests(registry);
    await bindStructuredDeliveryQueue([], { registry, client: real, hostlessSettleIntervalMs: 0 });
    try {
      const sweep = settleHostlessSessionProjections();
      await reached;
      registry.upsert({ ...registry.readOnlySnapshot().entries[`codex:${fixture.key.sessionId}`]!, status: "live", claimEpoch: 2, pendingAction: null,
        structuredHost: { kind: "codex-app-server", endpoint: "stdio:successor", process: captureProcessIdentity(successor.pid)!,
          eventCursor: 10, protocolVersion: null, writerClaimEpoch: 2, activeTurnRef: "new-turn", pendingAttention: [], activeFlags: [] } });
      publish("new-running", { host: "hosted", turn: "running", activeTurnId: "new-turn", writerClaim: "new-writer:2" });
      const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;
      const ports = { ...productionDeps({ ...process.env }).quiet!, runtimeSnapshot: async () => journal.snapshot(), pipelines: () => [], flows: () => [],
        seats: () => [], presence: () => [], registryHealth: () => [], controllerBusyReason: async () => null, memoryAvailableMb: () => 8_192 } as QuietPorts;
      expect(await probeQuiet(snapshot, ports, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
      release();
      expect(await sweep).toBe(0);
      expect(journal.readSession({ conversationId: fixture.id })).toMatchObject({ host: "hosted", turn: "running", activeTurnId: "new-turn" });
      expect(await probeQuiet(snapshot, ports, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
      /* The new owner dies in turn: its row is ended and the next sweep closes it. */
      successor.kill();
      await successor.exited;
      end(fixture);
      expect(await settleHostlessSessionProjections()).toBe(1);
      expect(journal.readSession({ conversationId: fixture.id })).toMatchObject({ host: "dead", turn: "unknown", activeTurnId: null });
      expect(await probeQuiet(snapshot, ports, Date.now(), true)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
    } finally {
      release();
      await bindStructuredDeliveryQueue([], { registry, client: null });
      setAgentRegistryForTests(null);
      successor.kill();
      await successor.exited;
      journal.close();
    }
  });
}

/* An incumbent accepts ordinary append and ignores the new revision field.
   Its dispatcher refuses the dedicated method. The real socket and client
   reconnect to the successor's dispatcher on the same endpoint. */
for (const incumbent of [true, false]) {
  test(`a delayed settlement RPC preserves the live successor with ${incumbent ? "an incumbent" : "a fenced"} runtime host`, async () => {
    const fixture = hosted(deadProcess);
    end(fixture);
    const journal = new RuntimeJournal(join(directory, "mixed.sqlite"), { structuredHosts: true });
    const host = new RuntimeHost(journal);
    const publish = (eventKey: string, payload: Partial<RuntimeSession>) => journal.append({ scope: { type: "session", id: fixture.id }, kind: "session-status",
      producer: { kind: "codex-app-server", eventKey }, payload: { ...sessions.get(fixture.id)!, ...payload } });
    publish("old-running", {});
    let legacy = incumbent;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const methods: string[] = [];
    const socketPath = join(directory, "host.sock");
    const server = serveRuntimeHost(socketPath, { handle: async (request) => {
      if (request.method === "append" || request.method === "append-session-fenced") {
        methods.push(request.method);
        entered();
        await gate;
        if (legacy && request.method === "append-session-fenced") return { id: request.id, ok: false, error: "runtime request method is unsupported" };
        if (legacy) {
          const event = { ...request.params!.event as RuntimeEventInput };
          delete event.expectedSessionRevision;
          return host.handle({ ...request, params: { ...request.params, event } });
        }
      }
      return host.handle(request);
    } });
    const real = new UnixRuntimeHostClient(socketPath);
    const successor = Bun.spawn(["sleep", "60"]);
    let sweep: Promise<number> | undefined;
    setAgentRegistryForTests(registry);
    try {
      await bindStructuredDeliveryQueue([], { registry, client: real, hostlessSettleIntervalMs: 0 });
      sweep = settleHostlessSessionProjections();
      await reached;
      registry.upsert({ ...registry.readOnlySnapshot().entries[`codex:${fixture.key.sessionId}`]!, status: "live", claimEpoch: 2, pendingAction: null,
        structuredHost: { kind: "codex-app-server", endpoint: "stdio:successor", process: captureProcessIdentity(successor.pid)!,
          eventCursor: 10, protocolVersion: null, writerClaimEpoch: 2, activeTurnRef: "new-turn", pendingAttention: [], activeFlags: [] } });
      publish("new-running", { host: "hosted", turn: "running", activeTurnId: "new-turn", writerClaim: "new-writer:2" });
      const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;
      const ports = { ...productionDeps({ ...process.env }).quiet!, runtimeSnapshot: () => real.snapshot(), pipelines: () => [], flows: () => [],
        seats: () => [], presence: () => [], registryHealth: () => [], controllerBusyReason: async () => null, memoryAvailableMb: () => 8_192 } as QuietPorts;
      expect(await probeQuiet(snapshot, ports, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
      release();
      expect(await sweep).toBe(0);
      expect(journal.readSession({ conversationId: fixture.id })).toMatchObject({ host: "hosted", turn: "running", activeTurnId: "new-turn" });
      expect(await probeQuiet(snapshot, ports, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
      expect(methods).toEqual(["append-session-fenced"]);
      successor.kill();
      await successor.exited;
      end(fixture);
      /* The old host still cannot accept settlement. No ordinary-append retry. */
      expect(await settleHostlessSessionProjections()).toBe(incumbent ? 0 : 1);
      legacy = false;
      expect(await settleHostlessSessionProjections()).toBe(incumbent ? 1 : 0);
      expect(journal.readSession({ conversationId: fixture.id })).toMatchObject({ host: "dead", turn: "unknown", activeTurnId: null });
      expect(await probeQuiet(snapshot, ports, Date.now(), true)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
    } finally {
      release();
      await sweep;
      await bindStructuredDeliveryQueue([], { registry, client: null });
      setAgentRegistryForTests(null);
      successor.kill();
      await successor.exited;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      journal.close();
    }
  });
}

test("the sweep settles an aliased journal row with no artifact path after its canonical owner dies", async () => {
  const fixture = hosted(deadProcess);
  end(fixture);
  const alias = `conversation_${randomUUID()}`;
  const intermediate = `conversation_${randomUUID()}`;
  const disk = JSON.parse(readFileSync(registry.filename, "utf8"));
  disk.conversationAliases[alias] = intermediate;
  disk.conversationAliases[intermediate] = fixture.id;
  writeFileSync(registry.filename, JSON.stringify(disk));
  const journal = new RuntimeJournal(join(directory, "alias.sqlite"), { structuredHosts: true });
  const socketPath = join(directory, "alias.sock");
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal));
  const real = new UnixRuntimeHostClient(socketPath);
  journal.append({ scope: { type: "session", id: alias }, kind: "session-status",
    producer: { kind: "codex-app-server", eventKey: "aliased-turn" }, payload: { ...sessions.get(fixture.id)!, conversationId: alias, artifactPath: null } });
  try {
    await bindStructuredDeliveryQueue([], { registry, client: real, hostlessSettleIntervalMs: 0 });
    expect(await settleHostlessSessionProjections()).toBe(1);
    expect(journal.readSession({ conversationId: alias })).toMatchObject({ conversationId: alias, host: "dead", turn: "unknown", activeTurnId: null });
    expect(journal.readSession({ conversationId: fixture.id })).toBeNull();
    expect(await settleHostlessSessionProjections()).toBe(0);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    journal.close();
  }
});
