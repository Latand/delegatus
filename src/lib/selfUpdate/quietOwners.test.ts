/* The case map of docs/design/update-drain-liveness.md over the real seams:
   AgentRegistry claims, the delivery controller's fallback and seats,
   RuntimeJournal commands and `projectEngineHostEvent`, read by the
   production owner reader and judged by `probeQuiet`. Each test names the
   table row it decides. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, openSync, closeSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, setAgentRegistryForTests, type AgentRegistryEntry, type ProcessIdentity, type StructuredHostColumns } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { productionLivenessSources } from "@/lib/lifecycle/liveness";
import { captureProcessIdentity } from "@/lib/processIdentity";
import type { Flow } from "@/lib/flows/types";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeEventInput, RuntimeSession } from "@/lib/runtime/contracts";
import { projectEngineHostEvent } from "@/lib/runtime/engineHostEvents";
import type { HostState } from "@/lib/runtime/engineHost";
import { FakeEngineHost } from "@/lib/runtime/fixtures/fakeEngineHost";
import type { CodexAppServerHost } from "@/lib/runtime/codexAppServerHost";
import { bindCodexHostPersistence } from "@/lib/runtime/registry";
import { bindStructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryController";
import { RuntimeJournal } from "../../runtime-host/journal";
import { fenceEpoch, journalStatement, ownerCensusReader, productionDeps } from "./instance";
import { ownerVerdict, probeQuiet, type QuietPorts } from "./quiet";
import type { Snapshot } from "./types";

const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;
const FIVE_MINUTES = 5 * 60_000;
const TWELVE_HOURS = 12 * 60 * 60_000;
const previousCodexHome = process.env.LLV_CODEX_HOME;
const viewer = captureProcessIdentity(process.pid)!;
type Key = { engine: "codex"; sessionId: string };

let f: ReturnType<typeof fixture>;
const children: ReturnType<typeof Bun.spawn>[] = [];
let seq = 0;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "quiet-owners-"));
  process.env.LLV_CODEX_HOME = join(dir, "codex");
  mkdirSync(join(process.env.LLV_CODEX_HOME, "sessions", "2026", "01", "01"), { recursive: true });
  const registry = new AgentRegistry(join(dir, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  const journal = new RuntimeJournal(join(dir, "runtime.sqlite"), { structuredHosts: true });
  const client = {
    snapshot: async () => journal.snapshot(),
    readSession: async (query: Parameters<RuntimeJournal["readSession"]>[0]) => journal.readSession(query),
    append: async (event: RuntimeEventInput) => journal.append(event),
    appendSessionFenced: async (event: RuntimeEventInput & { expectedSessionRevision: number }) => {
      if (typeof event.scope !== "object" || journal.readSession({ conversationId: event.scope.id })?.revision !== event.expectedSessionRevision) {
        throw new Error("session revision changed");
      }
      return journal.append(event);
    },
    producerCursor: async () => 0,
    operationStatus: async () => null,
    effectBatch: async () => [],
  } as unknown as RuntimeHostClient;
  return { dir, registry, journal, client };
}

beforeEach(() => { f = fixture(); });

afterEach(async () => {
  await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
  setAgentRegistryForTests(null);
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  f.journal.close();
  rmSync(f.dir, { recursive: true, force: true });
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
});

function ports(overrides: Partial<QuietPorts> = {}): QuietPorts {
  return { ...productionDeps().quiet!, runtimeSnapshot: async () => f.journal.snapshot(),
    owners: ownerCensusReader(productionLivenessSources, { readEvents: async (after) => f.journal.replay(after),
      readProducerCursor: async (kind, prefix) => f.journal.producerCursor(kind, prefix), readSession: (query) => f.client.readSession!(query) }),
    pipelines: () => [], flows: () => [], seats: () => [], presence: () => [],
    registryHealth: () => [], controllerBusyReason: async () => null, memoryAvailableMb: () => 8_192, ...overrides };
}

const probe = (p: QuietPorts = ports(), at = Date.now()) => probeQuiet(snapshot, p, at, true);

test.each(["known identity", "missing identity"])("proved standalone turn remains protected after fresh ports lose its transcript: %s", async (shape) => {
  const now = Date.now(), path = transcript("open"), c = conversation(path), worker = spawn();
  const identity = shape === "known identity" ? worker.identity : { ...worker.identity, startIdentity: null };
  f.registry.upsert({ key: c.key, artifactPath: path, cwd: f.dir, accountId: "fixture", status: "live", host: tmuxHost(identity),
    claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null });
  await fallback();
  expect((await probe(ports(), now)).quiet).toBe(false);
  rmSync(path);
  setAgentRegistryForTests(new AgentRegistry(join(f.dir, "registry.json"), undefined, undefined, { sqliteMode: "off" }));
  const fresh = ports();
  expect((await probe(fresh, now + 1)).quiet).toBe(false);
  expect((await probe(fresh, now + FIVE_MINUTES + 2)).quiet).toBe(false);
  expect((await probe(ports(), now + TWELVE_HOURS)).quiet).toBe(false);
  writeFileSync(path, transcriptText("settled", new Date(now + TWELVE_HOURS + 1).toISOString()));
  expect((await probe(ports(), now + TWELVE_HOURS + 2)).quiet).toBe(true);
  rmSync(path);
  await exit(worker);
  expect((await probe(ports(), now + TWELVE_HOURS + 3)).quiet).toBe(true);
});

test("independent controller ordering: own event reaches the journal before its queued running publication during reconnect", async () => {
  const path = transcript("settled"), c = conversation(path), worker = spawn();
  const claim = claimHost(c.key, path, worker.identity, "idle");
  const held = heldHost(worker.child.pid, { status: "idle", activeTurnRef: null, sessionKey: c.key.sessionId });
  let pushEvent: (value: Parameters<typeof projectEngineHostEvent>[2]) => void = () => {};
  const pendingEvent = new Promise<Parameters<typeof projectEngineHostEvent>[2]>((resolve) => { pushEvent = resolve; });
  held.host.attach = async function* () { yield await pendingEvent; };
  let releasePublication: () => void = () => {}, finishedPublication: () => void = () => {};
  const publicationGate = new Promise<void>((resolve) => { releasePublication = resolve; });
  const publicationDone = new Promise<void>((resolve) => { finishedPublication = resolve; });
  let block = false, publicationEntered = false;
  const client = { ...f.client, append: async (input: RuntimeEventInput) => {
    if (block && input.kind === "session-status" && input.payload.activeTurnId === "own-new-turn") {
      publicationEntered = true;
      await publicationGate;
      try { return await f.client.append(input); } finally { finishedPublication(); }
    }
    return f.client.append(input);
  } } as RuntimeHostClient;
  const stop = await bindCodexHostPersistence(f.registry, c.key, held.host as unknown as CodexAppServerHost,
    claim.fence.slice(0, claim.fence.lastIndexOf(":")), claim.epoch, "unhosted", { cursorDebounceMs: 60_000 });
  try {
    await bindStructuredDeliveryQueue([{ key: c.key, host: held.host }], { registry: f.registry, client, hostlessSettleIntervalMs: 0 });
    expect(f.registry.captureStructuredTerminationSurvivors(c.key, worker.identity, [worker.identity])).not.toBeNull();
    block = true;
    const before = held.host.health;
    held.host.health = async () => ({ ...await before(), status: "active", activeTurnRef: "own-new-turn" });
    await held.fire({ status: "active", activeTurnRef: "own-new-turn" });
    expect(publicationEntered).toBe(true);
    pushEvent({ kind: "turn-started", turnId: "own-new-turn", seq: 1 });
    for (let n = 0; n < 100 && row(c.id).activeTurnId !== "own-new-turn"; n++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(row(c.id).activeTurnId).toBe("own-new-turn");
    expect(row(c.id).writerStatus).toMatchObject({ turn: "idle", activeTurnId: null });
    expect(f.registry.readOnlySnapshot().entries[sessionKeyId(c.key)]!.structuredHost!.activeTurnRef).toBeNull();
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    for (const at of [Date.now(), Date.now() + TWELVE_HOURS]) {
      expect(productionLivenessSources().probe.pidAlive(worker.child.pid)).toBe(true);
      expect((await probe(ports(), at)).quiet).toBe(false);
    }
    releasePublication();
    await publicationDone;
    expect((await probe()).quiet).toBe(false);
    held.host.health = before;
    await held.fire({ status: "idle", activeTurnRef: null });
    await bindStructuredDeliveryQueue([{ key: c.key, host: held.host }], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    expect((await probe()).quiet).toBe(true);
  } finally {
    releasePublication();
    if (publicationEntered) await publicationDone;
    stop();
  }
});

test("an older own idle sample appended after a newer engine start cannot release the answering owner", async () => {
  const path = transcript("settled"), c = conversation(path), worker = spawn();
  const claim = claimHost(c.key, path, worker.identity, "idle");
  publish(c.id, c.key, path, claim.fence, null);
  const idleCursor = seq;
  event(c.id, c.key, "turn-started", "new-turn");
  publish(c.id, c.key, path, claim.fence, null, idleCursor);
  expect(row(c.id).turn).toBe("idle");
  expect((await probe(ports(), Date.now() + TWELVE_HOURS)).quiet).toBe(false);
  publish(c.id, c.key, path, claim.fence, null);
  expect((await probe()).quiet).toBe(true);
});

test("each own start holds until its own newer end; another turn ending supplies no settlement", async () => {
  const path = transcript("settled"), c = conversation(path), worker = spawn();
  const claim = claimHost(c.key, path, worker.identity, "idle");
  publish(c.id, c.key, path, claim.fence, null);
  event(c.id, c.key, "turn-started", "first-turn");
  event(c.id, c.key, "turn-started", "newest-turn");
  event(c.id, c.key, "turn-ended", "first-turn");
  expect(row(c.id).turn).toBe("idle");
  expect((await probe()).quiet).toBe(false);
  event(c.id, c.key, "turn-ended", "newest-turn");
  expect((await probe()).quiet).toBe(true);
});

test("a newly admitted native turn holds before its engine event and running publication arrive", async () => {
  const path = transcript("settled"), c = conversation(path), worker = spawn();
  const claim = claimHost(c.key, path, worker.identity, "idle");
  publish(c.id, c.key, path, claim.fence, null);
  f.journal.executeOperation({ kind: "send", operationId: "op-own-send", idempotencyKey: "own-send", conversationId: c.id,
    text: "continue", policy: "queue" });
  f.journal.completeOperation("op-own-send", "turn-started", { turnId: "own-native-turn" });
  expect((await probe(ports(), Date.now() + TWELVE_HOURS)).quiet).toBe(false);
  publish(c.id, c.key, path, claim.fence, "own-native-turn");
  event(c.id, c.key, "turn-ended", "own-native-turn");
  expect((await probe()).quiet).toBe(true);
});

function spawn(): { child: ReturnType<typeof Bun.spawn>; identity: ProcessIdentity } {
  const child = Bun.spawn(["sleep", "60"]);
  children.push(child);
  const identity = captureProcessIdentity(child.pid);
  if (!identity) throw new Error("fixture process identity unavailable");
  return { child, identity };
}

async function exit(process: { child: ReturnType<typeof Bun.spawn> }) {
  process.child.kill();
  await process.child.exited;
}

/** A Codex transcript: `settled` ends in `task_complete`, `open` in a started
    turn, `unmarked` carries no turn marker at all. */
function transcript(state: "settled" | "open" | "unmarked", at = new Date().toISOString(), id = randomUUID()): string {
  const file = join(process.env.LLV_CODEX_HOME!, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  writeFileSync(file, transcriptText(state, at, id));
  return file;
}

function columns(process: ProcessIdentity | null, epoch: number, activeTurnRef: string | null = null): StructuredHostColumns {
  return { kind: "codex-app-server", endpoint: "stdio:fixture", process, eventCursor: 0, protocolVersion: null,
    writerClaimEpoch: epoch, activeTurnRef, pendingAttention: [], activeFlags: [] };
}

/** A conversation whose first generation names `path`, and its session key. */
function conversation(path: string) {
  const created = f.registry.ensureConversation("codex", path, "fixture");
  return { id: created.id, key: { engine: "codex" as const, sessionId: created.generations[0]!.id }, path };
}

/** Records a structured host as a spawn does: this Viewer claims the row,
    then records the host process under that claim. Returns the fence a
    host's own publication carries. */
function claimHost(key: Key, path: string, process: ProcessIdentity | null, status: AgentRegistryEntry["status"] = "idle", activeTurnRef: string | null = null): { fence: string; epoch: number } {
  const claimed = f.registry.claimStructuredHost(key, viewer, { allowUnhosted: true, setupHost: columns(null, 0),
    setupEntry: { artifactPath: path, cwd: f.dir, accountId: "fixture", launchProfile: emptyLaunchProfile({ cwd: f.dir }) } });
  if (!claimed?.claimOwner) throw new Error("fixture claim refused");
  const set = f.registry.setStructuredHostClaimed(key, columns(process, claimed.claimEpoch, activeTurnRef), status, claimed.claimOwner, claimed.claimEpoch);
  if (!set) throw new Error("fixture host columns refused");
  return { fence: `${claimed.claimOwner}:${claimed.claimEpoch}`, epoch: claimed.claimEpoch };
}

function release(key: Key, claim: { fence: string; epoch: number }) {
  expect(f.registry.releaseStructuredHostClaim(key, claim.fence.slice(0, claim.fence.lastIndexOf(":")), claim.epoch)).toBe(true);
}

/** A host's own publication, in the shape `publishHostState` writes. */
function publish(id: string, key: Key, path: string, fence: string | null, activeTurnRef: string | null, cursor = ++seq) {
  f.journal.append({ scope: { type: "session", id }, kind: "session-status",
    producer: { kind: "codex-app-server", eventKey: `structured-host:${sessionKeyId(key)}:${fenceEpoch(fence) ?? 0}:${cursor}:${activeTurnRef ? "active" : "idle"}:${activeTurnRef ?? "idle"}:${randomUUID()}` },
    payload: { conversationId: id, sessionKey: key, hostKind: "codex-app-server", host: "hosted",
      turn: activeTurnRef ? "running" : "idle", provenance: "structured", accountId: "fixture", writerClaim: fence,
      parentConversationId: null, cwd: f.dir, artifactPath: path,
      capabilities: { steer: true, structuredAttention: true }, activeTurnId: activeTurnRef } });
}

/** A turn event a host's pump forwards, through the real projector. */
function event(id: string, key: Key, kind: "turn-started" | "turn-ended", turnId: string) {
  const projected = projectEngineHostEvent(id, sessionKeyId(key), { kind, turnId, seq: ++seq, status: "completed" } as never);
  if (!projected) throw new Error("fixture event did not project");
  f.journal.append(projected);
}

/** The delivery controller's start: the fallback copies the registry for
    every conversation this Viewer does not host. */
const fallback = () => bindStructuredDeliveryQueue([], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });

function row(id: string): RuntimeSession {
  const read = f.journal.readSession({ conversationId: id });
  if (!read) throw new Error("fixture row missing");
  return read;
}

/** A held host whose health the test sets. Like a real host, its health
    names its process under that process's own start identity. */
function heldHost(pid: number, state: Partial<HostState> = {}) {
  const processStartIdentity = captureProcessIdentity(pid)?.startIdentity ?? null;
  const listeners = new Set<(state: HostState) => void>();
  const host = Object.assign(new FakeEngineHost(), { setWriterFence: () => {}, onStateChange: (listener: (state: HostState) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  } });
  const base = host.health.bind(host);
  host.health = async () => ({ ...await base(), pid, processStartIdentity, ...state });
  return { host, fire: async (next: Partial<HostState>) => {
    const prior = await host.health();
    const current = { ...prior, eventCursor: prior.eventCursor + 1, ...next };
    state = current;
    for (const listener of listeners) listener(current);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } };
}

/** A's row at epoch 1 claims a running turn; A's claim is released and A
    exits; B is claimed under the same key at epoch 2, idle, with no row
    reference, over a settled transcript. */
async function sameKeySuccessor(options: { bTurnRef?: string | null; bTail?: "settled" | "open" } = {}) {
  const path = transcript(options.bTail ?? "settled");
  const c = conversation(path);
  const a = spawn();
  const claimA = claimHost(c.key, path, a.identity, "live", "a-turn");
  publish(c.id, c.key, path, claimA.fence, "a-turn");
  release(c.key, claimA);
  await exit(a);
  const b = spawn();
  const claimB = claimHost(c.key, path, b.identity, "idle", options.bTurnRef ?? null);
  expect(claimB.epoch).toBe(2);
  expect(claimB.fence.slice(0, claimB.fence.lastIndexOf(":"))).toBe(claimA.fence.slice(0, claimA.fence.lastIndexOf(":")));
  return { ...c, a, b, claimA, claimB };
}

/** A publishes at epoch 1 under its key and exits; B is a new generation of
    the same conversation under its own key, settled through the registry's
    spawn request. B's host is recorded by `record`. */
async function differentKeySuccessor() {
  const pathA = transcript("open");
  const c = conversation(pathA);
  const a = spawn();
  const claimA = claimHost(c.key, pathA, a.identity, "live", "a-turn");
  publish(c.id, c.key, pathA, claimA.fence, "a-turn");
  release(c.key, claimA);
  await exit(a);
  const keyB = { engine: "codex" as const, sessionId: randomUUID() };
  const pathB = transcript("settled", undefined, keyB.sessionId);
  const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.dir, transport: "structured", accountId: "fixture",
    purpose: "resume-successor", conversationId: c.id as `conversation_${string}` });
  if (begun.kind !== "created") throw new Error("successor receipt was not created");
  expect(f.registry.settleSpawn(begun.receipt.launchId, { key: keyB, artifactPath: pathB, cwd: f.dir, accountId: "fixture",
    status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null }).kind).toBe("settled");
  return { ...c, a, claimA, pathB, keyB };
}

function tmuxHost(identity: ProcessIdentity): NonNullable<AgentRegistryEntry["host"]> {
  return { kind: "tmux", endpoint: "/tmp/fixture.sock", server: identity, paneId: "%1", panePid: identity,
    windowName: "fixture", agent: identity, argv: ["codex"] };
}

describe("the successor-epoch case", () => {
  test("B idle with a settled tail is released at once while A's epoch-1 row still claims a turn", async () => {
    const s = await sameKeySuccessor();
    expect(row(s.id)).toMatchObject({ turn: "running", activeTurnId: "a-turn", writerClaim: s.claimA.fence });
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0, discounted: 1, unresolved: 0 } });
  });

  test("A's turn id written by a later turn event releases B at once", async () => {
    const s = await sameKeySuccessor();
    event(s.id, s.key, "turn-started", "a-turn");
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("an unfamiliar turn under a reused key holds the answering successor until its own newer idle", async () => {
    const s = await sameKeySuccessor();
    event(s.id, s.key, "turn-started", "unfenced-turn");
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1 } });
    publish(s.id, s.key, s.path, s.claimB.fence, null);
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("B under its own key at epoch 1: the copy relabels A's row and names no writer, then a late turn event", async () => {
    const s = await differentKeySuccessor();
    const b = spawn();
    expect(claimHost(s.keyB, s.pathB, b.identity, "idle").epoch).toBe(1);
    await fallback();
    expect(row(s.id)).toMatchObject({ sessionKey: s.keyB, writerClaim: null });
    event(s.id, s.key, "turn-started", "a-late");
    expect(row(s.id)).toMatchObject({ turn: "running", activeTurnId: "a-late" });
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0, discounted: 1 } });
  });

  test("a row relabelled before the build keeps A's fence until the build's start rewrites it", async () => {
    const s = await differentKeySuccessor();
    const b = spawn();
    claimHost(s.keyB, s.pathB, b.identity, "idle");
    // The relabel as `main` publishes it: key B, no `writerClaim` field, so A's fence survives the merge.
    f.journal.append({ scope: { type: "session", id: s.id }, kind: "session-status", producer: { kind: "codex-app-server", eventKey: "main-relabel" },
      payload: { conversationId: s.id, sessionKey: s.keyB, hostKind: "codex-app-server", host: "unhosted", turn: "idle", provenance: "structured",
        accountId: "fixture", parentConversationId: null, cwd: f.dir, artifactPath: s.pathB, activeTurnId: null } });
    expect(row(s.id)).toMatchObject({ sessionKey: s.keyB, writerClaim: s.claimA.fence });
    await fallback();
    expect(row(s.id).writerClaim ?? null).toBeNull();
    event(s.id, s.key, "turn-started", "a-late");
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("B's own publication under key B at epoch 1 with a turn id holds with no bound", async () => {
    const s = await differentKeySuccessor();
    const b = spawn();
    const claimB = claimHost(s.keyB, s.pathB, b.identity, "idle");
    publish(s.id, s.keyB, s.pathB, claimB.fence, "b-turn");
    for (const at of [Date.now(), Date.now() + TWELVE_HOURS]) {
      expect(await probe(ports(), at)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 0, turnList: [{ reason: "turn-claimed" }] } });
    }
  });

  test("B's own row, then a copy of the registry over it, then a late turn event releases B", async () => {
    const s = await differentKeySuccessor();
    const b = spawn();
    const claimB = claimHost(s.keyB, s.pathB, b.identity, "idle");
    publish(s.id, s.keyB, s.pathB, claimB.fence, null);
    await fallback();
    expect(row(s.id).writerClaim ?? null).toBeNull();
    event(s.id, s.key, "turn-started", "a-late");
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("B's handle reporting a turn holds as host-turn", async () => {
    const s = await sameKeySuccessor();
    const held = heldHost(s.b.child.pid, { status: "active", activeTurnRef: "b-turn" });
    await bindStructuredDeliveryQueue([{ key: s.key, host: held.host }], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "host-turn" }] } });
  });

  test("B's row reference naming a turn holds as turn-claimed", async () => {
    await sameKeySuccessor({ bTurnRef: "b-turn" });
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
  });

  test("B's open tail holds as turn-open", async () => {
    await sameKeySuccessor({ bTail: "open" });
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-open" }] } });
  });

  test("B's writer republishing at epoch 2 with a turn id holds with no bound", async () => {
    const s = await sameKeySuccessor();
    publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
    for (const at of [Date.now(), Date.now() + TWELVE_HOURS]) {
      expect(await probe(ports(), at)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 0, turnList: [{ reason: "turn-claimed" }] } });
    }
  });

  for (const late of ["turn-ended", "turn-started"] as const) {
    test(`B's own running publication holds through A's delayed ${late}, and B's idle publication releases it`, async () => {
      const s = await sameKeySuccessor();
      publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
      event(s.id, s.key, late, "a-turn");
      expect(row(s.id)).toMatchObject(late === "turn-ended" ? { turn: "idle", activeTurnId: null } : { turn: "running", activeTurnId: "a-turn" });
      expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
      publish(s.id, s.key, s.path, s.claimB.fence, null);
      expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
    });
  }

  test("B's own idle publication, then A's delayed turn-started, releases B at once", async () => {
    const s = await sameKeySuccessor();
    publish(s.id, s.key, s.path, s.claimB.fence, null);
    event(s.id, s.key, "turn-started", "a-turn");
    expect(row(s.id)).toMatchObject({ turn: "running", writerClaim: s.claimB.fence });
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0, discounted: 1 } });
  });

  test("B's released claim keeps its epoch and a publication without a writer cannot end its turn", async () => {
    const s = await sameKeySuccessor();
    publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
    release(s.key, s.claimB);
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
    // A host whose claim was released publishes `null` (`publishHostState`, no claim owner).
    publish(s.id, s.key, s.path, null, "b-turn");
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1 } });
    await exit(s.b);
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("a claim at epoch 2 with no live host process holds as setup while its claimant lives", async () => {
    const path = transcript("settled");
    const c = conversation(path);
    const a = spawn();
    const claimA = claimHost(c.key, path, a.identity, "live");
    release(c.key, claimA);
    await exit(a);
    const setup = spawn();
    expect(f.registry.claimStructuredHost(c.key, setup.identity)).toMatchObject({ claimEpoch: 2 });
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "setup" }] } });
    await exit(setup);
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("A alive at epoch 1 with no successor: A's row is A's evidence", async () => {
    const path = transcript("settled");
    const c = conversation(path);
    const a = spawn();
    const claimA = claimHost(c.key, path, a.identity, "live");
    publish(c.id, c.key, path, claimA.fence, "a-turn");
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
  });

  test("an adopted wrapper is judged on the row reference its new claim carried over, and its new writer", async () => {
    const path = transcript("settled");
    const c = conversation(path);
    const a = spawn();
    const claimA = claimHost(c.key, path, a.identity, "live", "a-turn");
    publish(c.id, c.key, path, claimA.fence, "a-turn");
    // The host publishes `dead` before its late reap; a successor claim adopts the orphaned wrapper.
    f.registry.setStructuredHostClaimed(c.key, columns(a.identity, claimA.epoch, "a-turn"), "dead", claimA.fence.slice(0, claimA.fence.lastIndexOf(":")), claimA.epoch);
    release(c.key, claimA);
    const adopted = f.registry.claimStructuredHost(c.key, viewer);
    expect(adopted).toMatchObject({ claimEpoch: 2, structuredHost: { process: { pid: a.child.pid }, activeTurnRef: "a-turn" } });
    f.registry.setStructuredHostClaimed(c.key, columns(a.identity, 2, "a-turn"), "idle", adopted!.claimOwner!, 2);
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
    f.registry.setStructuredHostClaimed(c.key, columns(a.identity, 2, null), "idle", adopted!.claimOwner!, 2);
    publish(c.id, c.key, path, `${adopted!.claimOwner}:2`, null);
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });
});

describe("the tmux successor", () => {
  /** B recorded with a tmux host: as a tmux launch settles it under its own
      key at claim epoch 0, or as the tmux observer's upsert records it under
      A's key, keeping A's structured columns at epoch 1. */
  async function tmuxSuccessor(under: "own key" | "A's key", status: "idle" | "live", bTail: "settled" | "open" | "unmarked" = "settled", at?: string) {
    if (under === "own key") {
      const s = await differentKeySuccessor();
      const b = spawn();
      writeFileSync(s.pathB, transcriptText(bTail, at, s.keyB.sessionId));
      f.registry.upsert({ ...f.registry.readOnlySnapshot().entries[sessionKeyId(s.keyB)]!, status, host: tmuxHost(b.identity), claimEpoch: 0 });
      return { id: s.id, key: s.key, claimA: s.claimA, b, bKey: s.keyB };
    }
    const path = transcript(bTail, at);
    const c = conversation(path);
    const a = spawn();
    const claimA = claimHost(c.key, path, a.identity, "live", "a-turn");
    publish(c.id, c.key, path, claimA.fence, "a-turn");
    release(c.key, claimA);
    await exit(a);
    const b = spawn();
    const entry = f.registry.readOnlySnapshot().entries[sessionKeyId(c.key)]!;
    f.registry.upsert({ ...entry, status, host: tmuxHost(b.identity), structuredHost: entry.structuredHost });
    expect(f.registry.readOnlySnapshot().entries[sessionKeyId(c.key)]).toMatchObject({ structuredHost: { writerClaimEpoch: 1 }, host: { kind: "tmux" } });
    return { id: c.id, key: c.key, claimA, b, bKey: c.key };
  }

  for (const under of ["own key", "A's key"] as const) {
    for (const status of ["idle", "live"] as const) {
      test(`B under ${under} with status ${status}: the copy and A's late turn event release B over a settled tail`, async () => {
        const t = await tmuxSuccessor(under, status);
        const entry = f.registry.readOnlySnapshot().entries[sessionKeyId(t.bKey)]!;
        writeFileSync(entry.artifactPath, transcriptText("settled", new Date(Date.parse(entry.updatedAt) + 1).toISOString()));
        await fallback();
        event(t.id, t.key, "turn-started", "a-late");
        expect(row(t.id)).toMatchObject({ writerClaim: null, turn: "running" });
        expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
      });
    }
    test(`B under ${under} with A's fence still on the row is released over a settled tail`, async () => {
      const t = await tmuxSuccessor(under, "live");
      const entry = f.registry.readOnlySnapshot().entries[sessionKeyId(t.bKey)]!;
      writeFileSync(entry.artifactPath, transcriptText("settled", new Date(Date.parse(entry.updatedAt) + 1).toISOString()));
      expect(row(t.id)).toMatchObject({ writerClaim: t.claimA.fence, turn: "running" });
      expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
    });
    test(`B under ${under} with an open tail holds as turn-open, with or without A's late event`, async () => {
      const t = await tmuxSuccessor(under, "idle", "open");
      await fallback();
      expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-open" }] } });
      event(t.id, t.key, "turn-started", "a-late");
      expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-open" }] } });
    });
  }

  test("a live tmux pane keeps ambiguous custody over a completion preceding its admission", async () => {
    const path = transcript("settled");
    const c = conversation(path);
    const b = spawn();
    f.registry.upsert({ key: c.key, artifactPath: path, cwd: f.dir, accountId: "fixture", status: "live", host: tmuxHost(b.identity),
      claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null });
    await fallback();
    expect(row(c.id)).toMatchObject({ host: "hosted", turn: "running", writerClaim: null });
    for (const at of [Date.now(), Date.now() + TWELVE_HOURS]) expect(await probe(ports(), at)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
    await exit(b);
    expect((await probe()).quiet).toBe(true);
  });

  test("B's confirmed host with no turn marker holds until its own completion", async () => {
    const now = Date.now();
    const t = await tmuxSuccessor("own key", "idle", "unmarked", new Date(now).toISOString());
    await fallback();
    for (const at of [now, now + FIVE_MINUTES, now + TWELVE_HOURS]) {
      expect(await probe(ports(), at)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 0,
        turnList: [{ conversationId: t.id, reason: "turn-unread" }] } });
    }
    writeFileSync(f.registry.readOnlySnapshot().entries[sessionKeyId(t.bKey)]!.artifactPath,
      transcriptText("settled", new Date(now + TWELVE_HOURS).toISOString()));
    expect(await probe(ports(), now + TWELVE_HOURS + 1)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("a handle this Viewer holds under B's key reporting a turn holds as host-turn", async () => {
    const t = await tmuxSuccessor("own key", "idle");
    await fallback();
    const held = heldHost(t.b.child.pid, { status: "active", activeTurnRef: "b-turn" });
    const p = ports({ owners: ownerCensusReader(productionLivenessSources, { readEvents: async (after) => f.journal.replay(after), readSession: (query) => f.client.readSession!(query),
      heldHosts: () => new Map([[sessionKeyId(t.bKey), held.host]]) }) });
    expect(await probe(p)).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "host-turn" }] } });
  });

  test("control: B structured at epoch 1 under its own key, the copy and A's late event release B", async () => {
    const s = await differentKeySuccessor();
    const b = spawn();
    claimHost(s.keyB, s.pathB, b.identity, "idle");
    await fallback();
    event(s.id, s.key, "turn-started", "a-late");
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });
});

describe("the delayed predecessor write", () => {
  test("a late send outcome over B's own idle publication releases B at once", async () => {
    const s = await sameKeySuccessor();
    // A's row is hosted when the send is admitted; the outcome lands after B's publication.
    f.journal.executeOperation({ kind: "send", operationId: "op-a-send", idempotencyKey: "a-send", conversationId: s.id,
      text: "continue", policy: "queue" });
    publish(s.id, s.key, s.path, s.claimA.fence, "a-sent-turn");
    publish(s.id, s.key, s.path, s.claimB.fence, null);
    f.journal.completeOperation("op-a-send", "turn-started", { turnId: "a-sent-turn" });
    expect(row(s.id)).toMatchObject({ turn: "running", activeTurnId: "a-sent-turn", writerClaim: s.claimB.fence });
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0, discounted: 1 } });
  });

  test("an interrupt command over B's own idle publication releases B; no predecessor is needed", async () => {
    const s = await sameKeySuccessor();
    publish(s.id, s.key, s.path, s.claimB.fence, null);
    f.journal.executeOperation({ kind: "interrupt", operationId: "op-interrupt", idempotencyKey: "interrupt", conversationId: s.id, turnId: null });
    expect(row(s.id)).toMatchObject({ turn: "interrupt_requested" });
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("a spawn placeholder over B's own idle publication releases B by this rule", async () => {
    const s = await sameKeySuccessor();
    publish(s.id, s.key, s.path, s.claimB.fence, null);
    f.journal.executeOperation({ kind: "spawn", operationId: "op-resume", idempotencyKey: "resume", conversationId: s.id,
      engine: "codex", cwd: f.dir, "prompt": "", sessionId: "resume-session" });
    expect(row(s.id)).toMatchObject({ host: "registering", sessionKey: { sessionId: "resume-session" }, writerClaim: s.claimB.fence });
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("A's registration, still seated after B's claim, publishes nothing under B's fence, also through a controller swap", async () => {
    const path = transcript("settled");
    const c = conversation(path);
    const a = spawn();
    const claimA = claimHost(c.key, path, a.identity, "live");
    const seatA = heldHost(a.child.pid, { status: "idle", activeTurnRef: null });
    await bindStructuredDeliveryQueue([{ key: c.key, host: seatA.host }], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
    expect(row(c.id)).toMatchObject({ writerClaim: claimA.fence });
    // A reports `dead` before its reap; B's claim adopts the terminal row at epoch 2.
    f.registry.setStructuredHostClaimed(c.key, columns(a.identity, claimA.epoch), "dead", claimA.fence.slice(0, claimA.fence.lastIndexOf(":")), claimA.epoch);
    release(c.key, claimA);
    const b = spawn();
    const claimed = f.registry.claimStructuredHost(c.key, viewer);
    expect(claimed).toMatchObject({ claimEpoch: 2 });
    f.registry.setStructuredHostClaimed(c.key, columns(b.identity, 2), "idle", claimed!.claimOwner!, 2);
    const fenceB = `${claimed!.claimOwner}:2`;
    publish(c.id, c.key, path, fenceB, null);
    await seatA.fire({ status: "active", activeTurnRef: "a-turn" });
    expect(row(c.id)).toMatchObject({ writerClaim: fenceB, turn: "idle", activeTurnId: null });
    await fallback(); // the swap carries A's seat with the epoch it was seated at
    expect(row(c.id)).toMatchObject({ writerClaim: fenceB, turn: "idle", activeTurnId: null });
    await seatA.fire({ status: "active", activeTurnRef: "a-second-turn" });
    expect(row(c.id)).toMatchObject({ writerClaim: fenceB, turn: "idle", activeTurnId: null });
  });

  test("control: B's own publication with a turn id holds before and after B's own turn-started for it", async () => {
    const s = await sameKeySuccessor();
    publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
    event(s.id, s.key, "turn-started", "b-turn");
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
  });

  test("B's own turn-started over its idle publication holds through the row reference until its publication lands", async () => {
    const s = await sameKeySuccessor({ bTurnRef: "b-turn" });
    publish(s.id, s.key, s.path, s.claimB.fence, null);
    event(s.id, s.key, "turn-started", "b-turn");
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
    publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
  });

  test("B's own running publication holds through an interrupt command and a late send outcome", async () => {
    const s = await sameKeySuccessor();
    f.journal.executeOperation({ kind: "send", operationId: "op-a-send", idempotencyKey: "a-send", conversationId: s.id,
      text: "continue", policy: "queue" });
    publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
    f.journal.executeOperation({ kind: "interrupt", operationId: "op-interrupt", idempotencyKey: "interrupt", conversationId: s.id, turnId: null });
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
    f.journal.completeOperation("op-a-send", "turn-started", { turnId: "a-sent-turn" });
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
  });

  test("B's own running publication holds after a placeholder moves the row to a resume's key, which reads nothing from it", async () => {
    const s = await sameKeySuccessor();
    publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
    f.journal.executeOperation({ kind: "spawn", operationId: "op-resume", idempotencyKey: "resume", conversationId: s.id,
      engine: "codex", cwd: f.dir, "prompt": "", sessionId: "resume-session" });
    expect(row(s.id)).toMatchObject({ sessionKey: { sessionId: "resume-session" }, writerStatus: { sessionKey: s.key, writerClaim: s.claimB.fence } });
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
    // An owner under the resume's key at epoch 2 reads nothing from B's mark.
    const resume = spawn();
    const resumeKey = { engine: "codex" as const, sessionId: "resume-session" };
    f.registry.upsert({ key: resumeKey, artifactPath: transcript("settled"), cwd: f.dir, accountId: "fixture", status: "idle", host: null,
      claimEpoch: 2, claimOwner: null, pendingAction: null, structuredHost: columns(resume.identity, 2) });
    const census = await ports().owners!(f.journal.snapshot().sessions, {});
    const read = census.owners.find((owner) => owner.entryKey === sessionKeyId(resumeKey))!;
    expect(read).toMatchObject({ process: "alive", journal: null });
    expect(ownerVerdict(read)).toEqual({ verdict: "released", reason: "turn-settled" });
  });

  test("B's own running publication survives a copy of the registry and A's late event", async () => {
    const s = await sameKeySuccessor();
    publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
    await fallback();
    event(s.id, s.key, "turn-started", "a-late");
    expect(row(s.id)).toMatchObject({ writerClaim: null, turn: "running" });
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1 } });
    publish(s.id, s.key, s.path, s.claimB.fence, null);
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  describe("a row at B's fence that claims a turn and carries no mark", () => {
    /** The row a runtime host from before the build leaves: the build's
        journal writes a mark for every named publication, so it is removed. */
    const unmarked = (overrides: Partial<QuietPorts> = {}) => ports({ runtimeSnapshot: async () => ({
      sessions: f.journal.snapshot().sessions.map((session) => ({ ...session, writerStatus: undefined })) }), ...overrides });

    test("holds a confirmed host past five minutes even when the journal kept no author", async () => {
      const now = Date.now();
      const s = await sameKeySuccessor();
      writeFileSync(s.path, transcriptText("settled", new Date(now).toISOString()));
      publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
      const p = unmarked();
      for (const at of [now, now + FIVE_MINUTES, now + TWELVE_HOURS]) {
      expect(await probe(p, at)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 0 } });
      }
    });

    test("holds a confirmed host on a cold probe over an older settled tail", async () => {
      const s = await sameKeySuccessor();
      writeFileSync(s.path, transcriptText("settled", new Date(Date.now() - 2 * FIVE_MINUTES).toISOString()));
      publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
      expect(await probe(unmarked())).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 0 } });
    });

    test("an answering host with a null start identity holds its unattributed claim without a grace", async () => {
      const now = Date.now();
      const s = await sameKeySuccessor();
      writeFileSync(s.path, transcriptText("settled", new Date(now).toISOString()));
      const entry = f.registry.readOnlySnapshot().entries[sessionKeyId(s.key)]!;
      f.registry.upsert({ ...entry, status: "starting", structuredHost: { ...entry.structuredHost!,
        process: { ...s.b.identity, startIdentity: null } } });
      publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
      const p = unmarked();
      expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 0 } });
      expect(await probe(p, now + TWELVE_HOURS)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 0 } });
    });

    test("an unordered idle handle cannot release a claim whose journal author is missing", async () => {
      const s = await sameKeySuccessor();
      publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
      const idle = heldHost(s.b.child.pid, { status: "idle", activeTurnRef: null });
      const withHandle = unmarked({ owners: ownerCensusReader(productionLivenessSources, { readEvents: async (after) => f.journal.replay(after), readSession: (query) => f.client.readSession!(query),
        heldHosts: () => new Map([[sessionKeyId(s.key), idle.host]]) }) });
      expect(await probe(withHandle)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
      writeFileSync(s.path, transcriptText("open"));
      expect(await probe(unmarked())).toMatchObject({ quiet: false, blockers: { turns: 1 } });
    });
  });
});

function transcriptText(state: "settled" | "open" | "unmarked", at = new Date().toISOString(), id = randomUUID()): string {
  const event = (type: string) => ({ timestamp: at, type: "event_msg", payload: { type } });
  return [{ timestamp: at, type: "session_meta", payload: { id, cwd: f.dir } },
    ...(state === "unmarked" ? [] : [event("task_started"), event("user_message")]),
    ...(state === "settled" ? [event("task_complete")] : [])].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

describe("reconnect with a registry checkpoint held by termination", () => {
  for (const ending of ["idle", "death", "reuse"] as const) {
    test(`fallback and late events preserve the host's current turn until its own ${ending}`, async () => {
      const now = Date.now();
      const path = transcript("settled", new Date(now - TWELVE_HOURS).toISOString());
      const c = conversation(path), b = spawn();
      const claim = claimHost(c.key, path, b.identity, "idle");
      const held = heldHost(b.child.pid, { status: "idle", activeTurnRef: null, sessionKey: c.key.sessionId });
      const stop = await bindCodexHostPersistence(f.registry, c.key, held.host as unknown as CodexAppServerHost,
        claim.fence.slice(0, claim.fence.lastIndexOf(":")), claim.epoch, "unhosted", { cursorDebounceMs: 60_000 });
      try {
        await bindStructuredDeliveryQueue([{ key: c.key, host: held.host }], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
        const capture = f.registry.captureStructuredTerminationSurvivors(c.key, b.identity, [b.identity]);
        expect(capture).not.toBeNull();
        await held.fire({ status: "active", activeTurnRef: "b-turn" });
        expect(await held.host.health()).toMatchObject({ status: "active", activeTurnRef: "b-turn" });
        expect(f.registry.readOnlySnapshot().entries[sessionKeyId(c.key)]!.structuredHost!.activeTurnRef).toBeNull();
        expect(row(c.id).writerStatus).toMatchObject({ writerClaim: claim.fence, turn: "running", activeTurnId: "b-turn" });
        const old = ports();
        expect(await probe(old, now)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
        await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
        await fallback();
        event(c.id, { engine: "codex", sessionId: "prior-session" }, "turn-started", "a-late");
        expect(row(c.id)).toMatchObject({ writerClaim: null, activeTurnId: "a-late" });
        for (const p of [old, ports()]) {
          expect(await probe(p, now + TWELVE_HOURS)).toMatchObject({ quiet: false, blockers: { turns: 1, stages: 0 } });
        }
        event(c.id, { engine: "codex", sessionId: "prior-session" }, "turn-ended", "a-late");
        expect(await probe(ports(), now + TWELVE_HOURS + 1)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
        if (ending === "idle") {
          await held.fire({ status: "idle", activeTurnRef: null });
          await bindStructuredDeliveryQueue([{ key: c.key, host: held.host }], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
          await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
          await fallback();
          event(c.id, { engine: "codex", sessionId: "prior-session" }, "turn-started", "a-later");
        } else if (ending === "death") {
          release(c.key, claim);
          await exit(b);
        } else {
          expect(f.registry.withdrawStructuredTerminationSurvivors(c.key, b.identity, capture!)).toBe(true);
          release(c.key, claim);
          const entry = f.registry.readOnlySnapshot().entries[sessionKeyId(c.key)]!;
          const reused = { ...b.identity, startIdentity: `${b.identity.startIdentity}-reused` };
          f.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!, process: reused }, structuredTerminationSurvivors: [reused] });
        }
        expect(await probe(ports(), now + TWELVE_HOURS + 2)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
      } finally { stop(); }
    });
  }
});

describe("R6b and the unknown bounds", () => {
  test("a host this Viewer holds under a terminal status, with this Viewer's claim, releases over a settled transcript and holds on a busy handle", async () => {
    const path = transcript("settled");
    const c = conversation(path);
    const b = spawn();
    const claim = claimHost(c.key, path, b.identity, "idle");
    const owner = claim.fence.slice(0, claim.fence.lastIndexOf(":"));
    f.registry.setStructuredHostClaimed(c.key, columns(b.identity, claim.epoch), "dead", owner, claim.epoch);
    const held = heldHost(b.child.pid, { status: "idle", activeTurnRef: null });
    await bindStructuredDeliveryQueue([{ key: c.key, host: held.host }], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
    const idle = held.host.health;
    held.host.health = async () => ({ ...await idle(), status: "active", activeTurnRef: "b-turn" });
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "host-turn" }] } });
  });

  test("an answering host with a null start identity holds when its transcript carries no turn marker", async () => {
    const now = Date.now();
    const path = transcript("unmarked", new Date(now).toISOString());
    const c = conversation(path);
    const b = spawn();
    claimHost(c.key, path, { ...b.identity, startIdentity: null }, "starting");
    expect(await probe(ports(), now)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 0, turnList: [{ reason: "turn-unread" }] } });
    expect(await probe(ports(), now + FIVE_MINUTES - 1)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
    expect(await probe(ports(), now + FIVE_MINUTES)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 0, unresolvedBlocking: 0 } });
  });

  test("an answering host with a null start identity holds without a readable transcript", async () => {
    const path = transcript("settled");
    const c = conversation(path);
    const b = spawn();
    claimHost(c.key, path, { ...b.identity, startIdentity: null }, "starting");
    rmSync(path);
    const p = ports(), now = Date.now();
    expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 0, turnList: [{ reason: "turn-unread" }] } });
    expect(await probe(p, now + FIVE_MINUTES - 1)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
    expect(await probe(p, now + FIVE_MINUTES)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 0 } });
  });
});

/* A turn the owner's own sources proved stays held after its evidence becomes
   unreadable: only its own settled tail, its process exiting, or its pid
   naming another process ends it (R8). */
describe("a proven turn whose evidence is lost", () => {
  /** A standalone tmux owner over an open turn, held as turn-open. */
  async function standalone(now: number, observe = true) {
    const path = transcript("open", new Date(now).toISOString());
    const c = conversation(path);
    const b = spawn();
    f.registry.upsert({ key: c.key, artifactPath: path, cwd: f.dir, accountId: "fixture", status: "live", host: tmuxHost(b.identity),
      claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null });
    await fallback();
    const p = ports();
    if (observe) expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ conversationId: c.id, reason: "turn-open" }] } });
    return { ...c, b, p };
  }
  const at = (ms: number) => new Date(ms).toISOString();
  const losses: { name: string; lose: (path: string, now: number) => void; settle: (path: string, now: number) => void }[] = [
    { name: "the transcript is deleted", lose: (path) => rmSync(path),
      settle: (path, now) => writeFileSync(path, transcriptText("settled", at(now))) },
    { name: "a partial JSON line is appended", lose: (path, now) => appendFileSync(path, `{"timestamp":"${at(now)}","type":"event_msg","payload":{"type":"agent_mess`),
      settle: (path, now) => appendFileSync(path, `age"}}\n${JSON.stringify({ timestamp: at(now), type: "event_msg", payload: { type: "task_complete" } })}\n`) },
    { name: "a large reasoning record pushes the markers out of the tail", lose: (path, now) => appendFileSync(path,
      `${JSON.stringify({ timestamp: at(now), type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "x".repeat(200 * 1024) } })}\n`),
    settle: (path, now) => appendFileSync(path, `${JSON.stringify({ timestamp: at(now), type: "event_msg", payload: { type: "task_complete" } })}\n`) },
  ];
  for (const loss of losses) {
    for (const first of ["cold", "fresh ports"] as const) {
      test(`${first}: ${loss.name} before this Viewer's first probe holds the confirmed owner`, async () => {
        const now = Date.now();
        const s = await standalone(now, first === "fresh ports");
        loss.lose(s.path, now + 1);
        // Reopen the durable registry as a new Viewer would. The cold variant
        // has never probed the open transcript through the drain.
        setAgentRegistryForTests(new AgentRegistry(join(f.dir, "registry.json"), undefined, undefined, { sqliteMode: "off" }));
        const fresh = ports();
        expect(await probe(fresh, now + 1)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
        expect(await probe(fresh, now + FIVE_MINUTES + 2)).toMatchObject({ quiet: false, blockers: { turns: 1, stages: 0 } });
        expect(await probe(ports(), now + TWELVE_HOURS)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
        loss.settle(s.path, now + TWELVE_HOURS);
        expect(await probe(ports(), now + TWELVE_HOURS + 1)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
      });
    }
    test(`${loss.name}: the live owner holds past five minutes until its own tail settles`, async () => {
      const now = Date.now();
      const s = await standalone(now);
      loss.lose(s.path, now + 1);
      expect(await probe(s.p, now + 1)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolvedBlocking: 0,
        turnList: [{ conversationId: s.id, reason: "turn-open" }] } });
      expect(await probe(s.p, now + 1 + FIVE_MINUTES + 1)).toMatchObject({ quiet: false, blockers: { turns: 1, stages: 0,
        turnList: [{ conversationId: s.id, reason: "turn-open" }] } });
      expect(await probe(s.p, now + TWELVE_HOURS)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
      loss.settle(s.path, now + TWELVE_HOURS);
      expect(await probe(s.p, now + TWELVE_HOURS + 1)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
    });
    test(`${loss.name}: the owner's exit releases it`, async () => {
      const now = Date.now();
      const s = await standalone(now);
      loss.lose(s.path, now + 1);
      expect(await probe(s.p, now + 1 + FIVE_MINUTES + 1)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
      await exit(s.b);
      expect(await probe(s.p, now + 1 + FIVE_MINUTES + 2)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
    });
  }

  test("a record that names the pid under another start identity proves nothing about the turn the old process showed", async () => {
    const now = Date.now();
    const s = await standalone(now);
    rmSync(s.path);
    expect(await probe(s.p, now + 1)).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-open" }] } });
    const reused = { ...s.b.identity, startIdentity: `${s.b.identity.startIdentity}-reused` };
    f.registry.upsert({ ...f.registry.readOnlySnapshot().entries[sessionKeyId(s.key)]!, host: tmuxHost(reused) });
    expect(await probe(s.p, now + 2)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("control: an answering launch with no saved start identity holds after its evidence is lost", async () => {
    const now = Date.now();
    const path = transcript("unmarked", at(now));
    const c = conversation(path);
    const b = spawn();
    f.registry.upsert({ key: c.key, artifactPath: path, cwd: f.dir, accountId: "fixture", status: "starting", host: tmuxHost({ ...b.identity, startIdentity: null }),
      claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null });
    await fallback();
    const p = ports();
    expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolvedBlocking: 0, turnList: [{ reason: "turn-unread" }] } });
    rmSync(path);
    expect(await probe(p, now + 1)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolvedBlocking: 0 } });
    expect(await probe(p, now + 1 + FIVE_MINUTES + 1)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 0, unresolvedBlocking: 0 } });
  });
});

/* R12: the verdict of an owner is a function of its own records. Each
   perturbation adds a record that names a different process, or a write
   that names no writer, and must leave the owner's verdict as it was. */
describe("independence (R12)", () => {
  type Target = { id: string; key: Key; path: string; fence: string | null; process: ReturnType<typeof spawn>; previous: Key | null };
  type Fixture = "structured at epoch 1" | "tmux under its own key" | "tmux under its predecessor's key";
  type State = "settled" | "open" | "gone";

  async function target(kind: Fixture, state: State): Promise<Target> {
    const path = transcript(state === "open" ? "open" : "settled");
    const c = conversation(path);
    const process = spawn();
    let fence: string | null = null;
    if (kind === "structured at epoch 1") {
      fence = claimHost(c.key, path, process.identity, "idle").fence;
    } else if (kind === "tmux under its own key") {
      f.registry.upsert({ key: c.key, artifactPath: path, cwd: f.dir, accountId: "fixture", status: "live", host: tmuxHost(process.identity),
        claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null });
    } else {
      const a = spawn();
      const claimA = claimHost(c.key, path, a.identity, "live", "a-turn");
      publish(c.id, c.key, path, claimA.fence, "a-turn");
      release(c.key, claimA);
      await exit(a);
      const entry = f.registry.readOnlySnapshot().entries[sessionKeyId(c.key)]!;
      f.registry.upsert({ ...entry, status: "live", host: tmuxHost(process.identity), structuredHost: entry.structuredHost });
    }
    if (state === "gone") await exit(process);
    return { ...c, fence, process, previous: null };
  }

  /** The target's own verdict, read through the production reader (R7). */
  async function verdict(t: Target): Promise<string> {
    const census = await ports().owners!(f.journal.snapshot().sessions, {});
    const own = census.owners.filter((owner) => owner.entryKey === sessionKeyId(t.key) && owner.id.includes(`:${t.process.child.pid}:`));
    expect(own).toHaveLength(1);
    const { verdict, reason } = ownerVerdict(own[0]!);
    return `${verdict}:${reason}`;
  }

  const other = () => ({ engine: "codex" as const, sessionId: randomUUID() });
  const perturbations: { name: string; writer?: true; base?: (t: Target) => void | Promise<void>; apply: (t: Target) => void | Promise<void> }[] = [
    { name: "a sibling row at the same transcript", apply: (t) => {
      f.registry.upsert({ key: other(), artifactPath: t.path, cwd: f.dir, accountId: "fixture", status: "live", host: null,
        claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: columns(spawn().identity, 0, "sibling-turn") });
    } },
    { name: "a successor generation", apply: (t) => {
      const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.dir, transport: "structured", accountId: "fixture",
        purpose: "resume-successor", conversationId: t.id as `conversation_${string}` });
      if (begun.kind !== "created") throw new Error("successor receipt was not created");
      const successor = other();
      f.registry.settleSpawn(begun.receipt.launchId, { key: successor, artifactPath: transcript("open", undefined, successor.sessionId), cwd: f.dir, accountId: "fixture",
        status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: columns(spawn().identity, 0, "successor-turn") });
    } },
    { name: "an earlier generation's row under the same conversation", apply: (t) => {
      const earlier = transcript("open");
      const merged = conversation(earlier);
      f.registry.upsert({ key: merged.key, artifactPath: earlier, cwd: f.dir, accountId: "fixture", status: "live", host: null,
        claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: columns(spawn().identity, 0, "earlier-turn") });
      const disk = f.registry.snapshot();
      disk.conversations[t.id as `conversation_${string}`]!.continuityPaths.push(earlier);
      writeFileSync(f.registry.filename, JSON.stringify(disk));
    } },
    { name: "an alias", apply: (t) => {
      const aliased = transcript("open");
      const merged = conversation(aliased);
      f.registry.upsert({ key: merged.key, artifactPath: aliased, cwd: f.dir, accountId: "fixture", status: "live", host: null,
        claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: columns(spawn().identity, 0, "alias-turn") });
      const disk = f.registry.snapshot();
      disk.conversationAliases[merged.id as `conversation_${string}`] = t.id as `conversation_${string}`;
      writeFileSync(f.registry.filename, JSON.stringify(disk));
    } },
    { name: "a receipt", apply: (t) => {
      const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.dir, transport: "structured", accountId: "fixture",
        purpose: "resume-successor", conversationId: t.id as `conversation_${string}` });
      if (begun.kind !== "created") throw new Error("receipt was not created");
      const disk = f.registry.snapshot();
      disk.receipts[begun.receipt.launchId]!.admissionOwner = spawn().identity;
      writeFileSync(f.registry.filename, JSON.stringify(disk));
    } },
    { name: "a foreign journal row", apply: () => {
      const foreign = transcript("open");
      const c = conversation(foreign);
      publish(c.id, c.key, foreign, "structured-host:{}:1", "foreign-turn");
    } },
    { name: "a turn claim under an earlier writer epoch of the owner's own entry", apply: (t) => {
      publish(t.id, t.key, t.path, "structured-host:{}:0", "earlier-turn");
    } },
    { name: "a row of another key at the owner's epoch, relabelled by the real fallback", apply: async (t) => {
      publish(t.id, other(), t.path, t.fence ?? "structured-host:{}:1", "other-turn");
      await fallback();
    } },
    { name: "a copy of the registry marked running by a predecessor's late turn event", apply: async (t) => {
      await fallback();
      event(t.id, other(), "turn-started", "late-turn");
    } },
    ...(["turn-started", "send outcome", "interrupt"] as const).map((write) => ({
      name: `the owner's own idle publication, then a foreign ${write}`, writer: true as const,
      base: (t: Target) => {
        if (write === "send outcome") publish(t.id, other(), t.path, "structured-host:{}:1", "foreign-sent-turn");
        publish(t.id, t.key, t.path, t.fence, null);
        if (write === "send outcome") f.journal.executeOperation({ kind: "send", operationId: "op-late", idempotencyKey: "late", conversationId: t.id, text: "go", policy: "queue" });
      },
      apply: (t: Target) => foreignWrite(t, write),
    })),
    ...(["turn-ended", "turn-started", "send outcome", "interrupt"] as const).map((write) => ({
      name: `the owner's own running publication, then a foreign ${write}`, writer: true as const,
      base: (t: Target) => {
        if (write === "send outcome") publish(t.id, other(), t.path, "structured-host:{}:1", "foreign-sent-turn");
        publish(t.id, t.key, t.path, t.fence, "own-turn");
        if (write === "send outcome") f.journal.executeOperation({ kind: "send", operationId: "op-late", idempotencyKey: "late", conversationId: t.id, text: "go", policy: "queue" });
      },
      apply: (t: Target) => foreignWrite(t, write),
    })),
  ];

  function foreignWrite(t: Target, write: "turn-started" | "turn-ended" | "send outcome" | "interrupt") {
    if (write === "turn-started") event(t.id, other(), "turn-started", "foreign-turn");
    else if (write === "turn-ended") event(t.id, other(), "turn-ended", "foreign-turn");
    else if (write === "send outcome") f.journal.completeOperation("op-late", "turn-started", { turnId: "foreign-sent-turn" });
    else f.journal.executeOperation({ kind: "interrupt", operationId: `op-interrupt-${randomUUID()}`, idempotencyKey: randomUUID(), conversationId: t.id, turnId: null });
  }

  for (const kind of ["structured at epoch 1", "tmux under its own key", "tmux under its predecessor's key"] as const) {
    for (const state of ["settled", "open", "gone"] as const) {
      for (const perturbation of perturbations) {
        if (perturbation.writer && kind !== "structured at epoch 1") continue;
        test(`${kind}, ${state}: ${perturbation.name}`, async () => {
          const t = await target(kind, state);
          await perturbation.base?.(t);
          const before = await verdict(t);
          await perturbation.apply(t);
          expect(await verdict(t)).toBe(before);
        });
      }
    }
  }
});

describe("the reader's reading of a row (R5, source 3)", () => {
  const key = { engine: "codex" as const, sessionId: "session-b" };
  const fence = "structured-host:{\"pid\":1}:2";
  const mark = { sessionKey: key, writerClaim: fence, host: "hosted" as const, turn: "running" as const, activeTurnId: "b-turn" };
  const literal = (overrides: Partial<RuntimeSession>): RuntimeSession => ({ conversationId: "conversation_b", sessionKey: key, hostKind: "codex-app-server",
    host: "hosted", turn: "idle", provenance: "structured", revision: 1, attentionIds: [], recentReceipts: [], accountId: null,
    parentConversationId: null, flowId: null, workflowId: null, cwd: null, artifactPath: null, capabilities: { steer: true, structuredAttention: true },
    activeTurnId: null, pendingReconfigure: null, drift: null, writerClaim: fence, writerStatus: mark, ...overrides } as RuntimeSession);
  const owner = { entryKey: "codex:session-b", writerEpoch: 2 };

  test("a fence names the epoch its string ends with; null and a missing field name none", () => {
    expect(fenceEpoch(fence)).toBe(2);
    expect(fenceEpoch(null)).toBeNull();
    expect(fenceEpoch(undefined)).toBeNull();
  });

  test("the mark speaks for the owner its own key and writer epoch name, whatever the row's status or fence says", () => {
    expect(journalStatement([literal({})], owner)).toBe("claimed");
    expect(journalStatement([literal({ turn: "idle", activeTurnId: null, host: "dead" })], owner)).toBe("claimed");
    expect(journalStatement([literal({ turn: "running", activeTurnId: "a-turn", writerStatus: { ...mark, turn: "idle", activeTurnId: null } })], owner)).toBe("idle");
  });

  test("foreign fence writes preserve the mark; another key or epoch reads no statement", () => {
    expect(journalStatement([literal({ writerClaim: null })], owner)).toBe("claimed");
    expect(journalStatement([literal({ writerClaim: "structured-host:{\"pid\":1}:3" })], owner)).toBe("claimed");
    expect(journalStatement([literal({ sessionKey: { engine: "codex", sessionId: "resume" } })], { entryKey: "codex:resume", writerEpoch: 2 })).toBeNull();
    expect(journalStatement([literal({})], { ...owner, writerEpoch: 1 })).toBeNull();
    expect(journalStatement([literal({})], { ...owner, writerEpoch: null })).toBeNull();
  });

  test("a row at the owner's fence that claims a turn and carries no mark is unattributed", () => {
    expect(journalStatement([literal({ writerStatus: undefined, turn: "running" })], owner)).toBe("unattributed");
    expect(journalStatement([literal({ writerStatus: undefined, turn: "idle" })], owner)).toBeNull();
    expect(journalStatement([literal({ writerStatus: undefined, turn: "running", writerClaim: null })], owner)).toBeNull();
  });

  test("the verdict table decides top to bottom (R7)", () => {
    const live = { role: "host" as const, process: "alive" as const };
    const idleTail = { turn: "idle" as const, lastRecordAt: 0 };
    expect(ownerVerdict({ ...live, process: "gone", handle: "busy" })).toEqual({ verdict: "released", reason: "process-gone" });
    expect(ownerVerdict({ ...live, role: "setup" })).toEqual({ verdict: "holds", reason: "setup" });
    expect(ownerVerdict({ ...live, role: "reviewer" })).toEqual({ verdict: "holds", reason: "reviewer" });
    expect(ownerVerdict({ ...live, handle: "busy", tail: idleTail })).toEqual({ verdict: "holds", reason: "host-turn" });
    expect(ownerVerdict({ ...live, rowReference: true, tail: idleTail })).toEqual({ verdict: "holds", reason: "turn-claimed" });
    expect(ownerVerdict({ ...live, journal: "claimed", tail: idleTail })).toEqual({ verdict: "holds", reason: "turn-claimed" });
    expect(ownerVerdict({ ...live, handle: "idle", journal: "claimed", rowReference: true, tail: idleTail })).toEqual({ verdict: "holds", reason: "turn-claimed" });
    expect(ownerVerdict({ ...live, handle: "idle", tail: { turn: "busy", lastRecordAt: 0 } })).toEqual({ verdict: "holds", reason: "turn-open" });
    expect(ownerVerdict({ ...live, journal: "unattributed", tail: idleTail })).toEqual({ verdict: "holds", reason: "turn-unattributed" });
    expect(ownerVerdict({ ...live, handle: "idle", journal: "unattributed", tail: idleTail })).toEqual({ verdict: "holds", reason: "turn-unattributed" });
    expect(ownerVerdict({ ...live, tail: { turn: "unknown", lastRecordAt: 0 } })).toEqual({ verdict: "holds", reason: "turn-unread" });
    expect(ownerVerdict({ ...live, handle: "idle", tail: null })).toEqual({ verdict: "released", reason: "turn-settled" });
  });
});

/* Each owner is judged and bounded on its own records: its unknown runs its
   own five minutes, a round describes only the launch it names, its journal
   statement is found by its mark's key and writer, and a read that fails is
   no verdict. */
describe("each owner on its own records", () => {
  test("each answering owner holds independently when both saved start identities are null (R8, R12)", async () => {
    const path = transcript("settled");
    const c = conversation(path);
    const a = spawn();
    const claimA = claimHost(c.key, path, { ...a.identity, startIdentity: null }, "starting");
    rmSync(path);
    const p = ports(), now = Date.now();
    expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ conversationId: c.id, reason: "turn-unread" }] } });
    const b = spawn();
    const keyB = { engine: "codex" as const, sessionId: randomUUID() };
    const claimB = claimHost(keyB, path, { ...b.identity, startIdentity: null }, "starting");
    expect(await probe(p, now + FIVE_MINUTES)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolvedBlocking: 0,
      turnList: [{ conversationId: c.id, reason: "turn-unread" }] } });
    release(c.key, claimA);
    await exit(a);
    expect(await probe(p, now + 2 * FIVE_MINUTES - 1)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolvedBlocking: 0 } });
    expect(await probe(p, now + 2 * FIVE_MINUTES)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolvedBlocking: 0 } });
    release(keyB, claimB);
    await exit(b);
    expect(await probe(p, now + TWELVE_HOURS)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("an answering owner whose record moves to a missing transcript keeps holding (R1, R8)", async () => {
    const pathA = transcript("settled");
    const c = conversation(pathA);
    const host = spawn();
    claimHost(c.key, pathA, { ...host.identity, startIdentity: null }, "starting");
    rmSync(pathA);
    const p = ports(), now = Date.now();
    expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-unread" }] } });
    const pathB = join(f.dir, "moved.jsonl");
    f.registry.upsert({ ...f.registry.readOnlySnapshot().entries[sessionKeyId(c.key)]!, artifactPath: pathB });
    expect(await probe(p, now + FIVE_MINUTES)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolvedBlocking: 0 } });
    expect(await probe(p, now + 2 * FIVE_MINUTES)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolvedBlocking: 0 } });
  });

  test("a finished headless round at an earlier artifact leaves a fresh successor's ownerless row its own launch hold (R1, R2, R8)", async () => {
    const now = Date.now();
    const pathA = transcript("settled");
    const c = conversation(pathA);
    const keyB = { engine: "codex" as const, sessionId: randomUUID() };
    const pathB = transcript("unmarked", new Date(now).toISOString(), keyB.sessionId);
    const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.dir, transport: "structured", accountId: "fixture",
      purpose: "resume-successor", conversationId: c.id as `conversation_${string}` });
    if (begun.kind !== "created") throw new Error("successor receipt was not created");
    expect(f.registry.settleSpawn(begun.receipt.launchId, { key: keyB, artifactPath: pathB, cwd: f.dir, accountId: "fixture",
      status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null }).kind).toBe("settled");
    const reviewer = spawn();
    await exit(reviewer);
    const round = (path: string) => ({ n: 1, reviewerPid: reviewer.child.pid, reviewerIdentity: reviewer.identity.startIdentity,
      reviewerPath: path, reviewerConversationId: c.id, verdict: "APPROVE" });
    const withRound = (path: string | null) => ports({ owners: ownerCensusReader(() => ({ ...productionLivenessSources(),
      flows: () => path ? [{ id: "flow_prior", reviewerMode: "headless", state: "completed", rounds: [round(path)] }] as unknown as Flow[] : [] }),
    { readEvents: async (after) => f.journal.replay(after), readSession: (query) => f.client.readSession!(query) }) });
    const held = { quiet: false, blockers: { turns: 1, turnList: [{ conversationId: c.id, reason: "launch-unproven", unresolved: true }] } };
    expect(await probe(withRound(null), now)).toMatchObject(held);
    const p = withRound(pathA);
    expect(await probe(p, now)).toMatchObject(held);
    expect(await probe(p, now + FIVE_MINUTES - 1)).toMatchObject(held);
    // The same round at the successor's own artifact describes that launch, and its gone process releases it.
    expect(await probe(withRound(pathB), now)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("an owner's own running mark under another conversation's row holds, past an idle copy of its entry (R3, R5)", async () => {
    const pathA = transcript("settled");
    const a = conversation(pathA);
    const pathB = transcript("settled");
    const b = conversation(pathB);
    const host = spawn();
    const claim = claimHost(a.key, pathA, host.identity, "idle");
    await fallback();
    expect(row(a.id)).toMatchObject({ writerClaim: null, turn: "idle" });
    const entry = f.registry.readOnlySnapshot().entries[sessionKeyId(a.key)]!;
    f.registry.upsert({ ...entry, artifactPath: pathB });
    expect(f.registry.readOnlySnapshot().entries[sessionKeyId(a.key)]).toMatchObject({ artifactPath: pathB, structuredHost: { activeTurnRef: null } });
    const active = heldHost(host.child.pid, { status: "active", activeTurnRef: "own-turn" });
    await bindStructuredDeliveryQueue([{ key: a.key, host: active.host }], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
    expect(row(b.id).writerStatus).toMatchObject({ sessionKey: a.key, writerClaim: claim.fence, turn: "running" });
    const p = ports({ owners: ownerCensusReader(productionLivenessSources, { readEvents: async (after) => f.journal.replay(after), readSession: (query) => f.client.readSession!(query), heldHosts: () => new Map() }) });
    expect(await probe(p)).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
    expect(await probe(p, Date.now() + TWELVE_HOURS)).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
    release(a.key, claim);
    await exit(host);
    expect(await probe(p)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("a journal row the registry knows nothing about holds only while it claims a turn (R9)", async () => {
    const append = (host: string, turn: "idle" | "running", activeTurnId: string | null) => {
      const id = `conversation_${randomUUID()}`;
      f.journal.append({ scope: { type: "session", id }, kind: "session-status", producer: { kind: "codex-app-server", eventKey: randomUUID() },
        payload: { conversationId: id, sessionKey: { engine: "codex", sessionId: randomUUID() }, hostKind: "codex-app-server", host, turn,
          provenance: "structured", accountId: "fixture", writerClaim: null, parentConversationId: null, cwd: f.dir, artifactPath: null,
          capabilities: { steer: true, structuredAttention: true }, activeTurnId } });
      return id;
    };
    append("dead", "idle", null);
    append("hosted", "idle", null);
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0, unresolved: 0, unresolvedBlocking: 0 } });
    const claiming = append("hosted", "running", "unknown-turn");
    const p = ports(), now = Date.now();
    expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 1, unresolvedBlocking: 1,
      turnList: [{ conversationId: claiming, reason: "unresolved", unresolved: true }] } });
    expect(await probe(p, now + FIVE_MINUTES)).toMatchObject({ quiet: true, blockers: { turns: 0, unresolved: 1, unresolvedBlocking: 0 } });
  });

  test("a transcript read that throws holds through unreadable on every probe until a read succeeds (R7)", async () => {
    const path = transcript("settled");
    const c = conversation(path);
    const host = spawn();
    claimHost(c.key, path, host.identity, "idle");
    let failing = true;
    const p = ports({ owners: ownerCensusReader(() => {
      const sources = productionLivenessSources();
      return { ...sources, transcriptEvidence: (async (...args: Parameters<typeof sources.transcriptEvidence>) => {
        if (failing) throw new Error("independent transcript read failure");
        return sources.transcriptEvidence(...args);
      }) as typeof sources.transcriptEvidence };
    }, { readEvents: async (after) => f.journal.replay(after), readSession: (query) => f.client.readSession!(query) }) });
    const now = Date.now();
    for (const at of [now, now + FIVE_MINUTES, now + TWELVE_HOURS]) {
      expect(await probe(p, at)).toMatchObject({ quiet: false, blockers: { unreadable: "independent transcript read failure" } });
    }
    failing = false;
    expect(await probe(p, now + TWELVE_HOURS)).toMatchObject({ quiet: true, blockers: { turns: 0, unreadable: null } });
  });
});

/* An owner's evidence read whole: every standing mark of its writer, a read
   that fails as itself, every conversation a path binds, a round's key under
   its own engine, and every unknown counted whichever clock releases it. */
describe("each owner's evidence, whole", () => {
  test("an owner's own running mark holds past its own idle mark on another row, in either order (R5, R7)", () => {
    const fence = "structured-host:{\"pid\":1}:1";
    const key = { engine: "codex" as const, sessionId: "session-a" };
    const owner = { entryKey: "codex:session-a", writerEpoch: 1 };
    const marked = (conversationId: string, turn: "idle" | "running") => ({ conversationId, sessionKey: key, host: "hosted", turn: "idle",
      activeTurnId: null, writerClaim: fence, writerStatus: { sessionKey: key, writerClaim: fence, host: "hosted", turn,
        activeTurnId: turn === "running" ? "own-turn" : null } }) as unknown as RuntimeSession;
    const idle = marked("conversation_a", "idle"), running = marked("conversation_b", "running");
    expect(journalStatement([idle, running], owner)).toBe("claimed");
    expect(journalStatement([running, idle], owner)).toBe("claimed");
    expect(journalStatement([idle], owner)).toBe("idle");
  });

  test.each(["idle mark first", "idle mark last"])("an owner's own running mark under a second row holds past its idle mark: %s (R5, R7)", async (order) => {
    const one = conversation(transcript("settled"));
    const two = conversation(transcript("settled"));
    // The journal lists rows by conversation id, so the owner's key picks the order.
    const [first, second] = [one, two].sort((left, right) => left.id < right.id ? -1 : 1);
    const [own, other] = order === "idle mark first" ? [first!, second!] : [second!, first!];
    const host = spawn();
    const claim = claimHost(own.key, own.path, host.identity, "idle");
    publish(own.id, own.key, own.path, claim.fence, null);
    f.registry.upsert({ ...f.registry.readOnlySnapshot().entries[sessionKeyId(own.key)]!, artifactPath: other.path });
    const active = heldHost(host.child.pid, { status: "active", activeTurnRef: "own-turn" });
    await bindStructuredDeliveryQueue([{ key: own.key, host: active.host }], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
    expect(row(own.id).writerStatus).toMatchObject({ sessionKey: own.key, writerClaim: claim.fence, turn: "idle" });
    expect(row(own.id).writerClaim).toBe(claim.fence);
    expect(row(other.id).writerStatus).toMatchObject({ sessionKey: own.key, writerClaim: claim.fence, turn: "running" });
    const p = ports({ owners: ownerCensusReader(productionLivenessSources, { readEvents: async (after) => f.journal.replay(after), readSession: (query) => f.client.readSession!(query), heldHosts: () => new Map() }) });
    const held = { quiet: false, blockers: { turns: 1, discounted: 0, turnList: [{ reason: "turn-claimed" }] } };
    expect(await probe(p)).toMatchObject(held);
    // Foreign writes alter both rows' status and leave the marks as published.
    event(other.id, own.key, "turn-ended", "own-turn");
    event(own.id, own.key, "turn-started", "foreign-turn");
    expect(await probe(p, Date.now() + TWELVE_HOURS)).toMatchObject(held);
  });

  test("a transcript the owner cannot open holds through unreadable past every bound until it can be read (R7)", async () => {
    if (process.getuid?.() === 0) return;
    const path = transcript("open");
    const c = conversation(path);
    const host = spawn();
    claimHost(c.key, path, host.identity, "idle");
    chmodSync(path, 0o000);
    try {
      expect(() => closeSync(openSync(path, "r"))).toThrow(/EACCES/);
      const p = ports(), now = Date.now();
      for (const at of [now, now + FIVE_MINUTES, now + TWELVE_HOURS]) {
        expect(await probe(p, at)).toMatchObject({ quiet: false, blockers: { unreadable: expect.stringContaining("EACCES") } });
      }
      chmodSync(path, 0o600);
      expect(await probe(p, now + TWELVE_HOURS)).toMatchObject({ quiet: false, blockers: { unreadable: null, turns: 1, turnList: [{ reason: "turn-open" }] } });
    } finally {
      chmodSync(path, 0o600);
    }
  });

  test("a stage that names only an entry's moved path holds while any generation of that entry's conversation lives (R10)", async () => {
    const pathA = transcript("settled");
    const c = conversation(pathA);
    const a = spawn();
    const claimA = claimHost(c.key, pathA, a.identity, "idle");
    const keyB = { engine: "codex" as const, sessionId: randomUUID() };
    const pathB = transcript("settled", undefined, keyB.sessionId);
    const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.dir, transport: "structured", accountId: "fixture",
      purpose: "resume-successor", conversationId: c.id as `conversation_${string}` });
    if (begun.kind !== "created") throw new Error("successor receipt was not created");
    expect(f.registry.settleSpawn(begun.receipt.launchId, { key: keyB, artifactPath: pathB, cwd: f.dir, accountId: "fixture",
      status: "dead", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null }).kind).toBe("settled");
    const b = spawn();
    const claimB = claimHost(keyB, pathB, b.identity, "idle");
    release(keyB, claimB);
    await exit(b);
    const pathC = transcript("settled");
    f.registry.upsert({ ...f.registry.readOnlySnapshot().entries[sessionKeyId(keyB)]!, artifactPath: pathC });
    expect(f.registry.readOnlySnapshot().conversations[c.id]!.generations.map((generation) => generation.path)).toEqual([pathA, pathB]);
    const pipelines = () => [{ id: "lane_moved", task: "Finish the work", state: "running", cursor: { stageId: "stage", state: "running" },
      runs: [{ stageId: "stage", attempts: [{ n: 1, agentPath: pathC }] }] }] as unknown as ReturnType<QuietPorts["pipelines"]>;
    const p = ports({ pipelines }), now = Date.now();
    expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { stages: 1, turns: 0 } });
    expect(await probe(p, now + FIVE_MINUTES)).toMatchObject({ quiet: false, blockers: { stages: 1, turns: 0 } });
    expect(await probe(p, now + TWELVE_HOURS)).toMatchObject({ quiet: false, blockers: { stages: 1, turns: 0 } });
    release(c.key, claimA);
    await exit(a);
    // With no live owner left, the stage's settled transcript holds it for the bound and then releases it.
    expect(await probe(p, now + TWELVE_HOURS)).toMatchObject({ quiet: false, blockers: { stages: 1, settled: 1 } });
    expect(await probe(p, now + TWELVE_HOURS + FIVE_MINUTES)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
  });

  test("a headless round describes only a launch under its own engine's key (R1, R2, R8, R12)", async () => {
    const now = Date.now();
    const pathA = transcript("settled");
    const c = conversation(pathA);
    const keyB = { engine: "codex" as const, sessionId: randomUUID() };
    const pathB = transcript("unmarked", new Date(now).toISOString(), keyB.sessionId);
    const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.dir, transport: "structured", accountId: "fixture",
      purpose: "resume-successor", conversationId: c.id as `conversation_${string}` });
    if (begun.kind !== "created") throw new Error("successor receipt was not created");
    expect(f.registry.settleSpawn(begun.receipt.launchId, { key: keyB, artifactPath: pathB, cwd: f.dir, accountId: "fixture",
      status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null }).kind).toBe("settled");
    const claudePath = join(f.dir, "claude-review.jsonl");
    writeFileSync(claudePath, "");
    f.registry.upsert({ ...f.registry.readOnlySnapshot().entries[sessionKeyId(keyB)]!, key: { engine: "claude", sessionId: keyB.sessionId },
      artifactPath: claudePath, status: "dead" });
    const reviewer = spawn();
    await exit(reviewer);
    const round = (engine: string | null, path: string) => ({ n: 1, reviewerPid: reviewer.child.pid, reviewerIdentity: reviewer.identity.startIdentity,
      reviewerPath: path, sessionId: keyB.sessionId, verdict: "APPROVE", ...(engine ? { reviewerRole: { engine } } : {}) });
    const withRound = (r: ReturnType<typeof round> | null, flowEngine = "claude") => ports({ owners: ownerCensusReader(() => ({ ...productionLivenessSources(),
      flows: () => r ? [{ id: "flow_review", reviewerMode: "headless", state: "completed", roles: { reviewer: { engine: flowEngine } }, rounds: [r] }] as unknown as Flow[] : [] }),
    { readEvents: async (after) => f.journal.replay(after), readSession: (query) => f.client.readSession!(query) }) });
    const held = { quiet: false, blockers: { turns: 1, unresolved: 1, turnList: [{ reason: "launch-unproven", unresolved: true }] } };
    expect(await probe(withRound(null), now)).toMatchObject(held);
    const p = withRound(round("claude", claudePath));
    expect(await probe(p, now)).toMatchObject(held);
    expect(await probe(p, now + FIVE_MINUTES - 1)).toMatchObject(held);
    // A legacy round with no frozen role takes the flow's reviewer engine.
    expect(await probe(withRound(round(null, claudePath)), now)).toMatchObject(held);
    // A round under the Codex key, at another path, describes that launch, and its gone process releases it.
    expect(await probe(withRound(round("codex", claudePath)), now)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
    expect(await probe(withRound(round(null, claudePath), "codex"), now)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("an ownerless row past its write's grace releases at once and stays counted, also when first seen expired (R8)", async () => {
    const pathA = transcript("settled");
    const c = conversation(pathA);
    const keyB = { engine: "codex" as const, sessionId: randomUUID() };
    const pathB = transcript("unmarked", new Date().toISOString(), keyB.sessionId);
    const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.dir, transport: "structured", accountId: "fixture",
      purpose: "resume-successor", conversationId: c.id as `conversation_${string}` });
    if (begun.kind !== "created") throw new Error("successor receipt was not created");
    expect(f.registry.settleSpawn(begun.receipt.launchId, { key: keyB, artifactPath: pathB, cwd: f.dir, accountId: "fixture",
      status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null }).kind).toBe("settled");
    // The row's own write is the first clock: read every probe after it.
    const now = Date.now() + 1;
    const p = ports();
    expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 1, unresolvedBlocking: 1,
      turnList: [{ reason: "launch-unproven", unresolved: true }] } });
    const released = { quiet: true, blockers: { turns: 0, unresolved: 1, unresolvedBlocking: 0 } };
    expect(await probe(p, now + FIVE_MINUTES)).toMatchObject(released);
    expect(await probe(ports(), now + FIVE_MINUTES)).toMatchObject(released);
  });
});

/* What one owner reads stays its own when another record stands beside it: a
   row of another engine at its transcript, an idle mark of its own writer on
   a listed row, a directory that refuses the description of a path, and an
   entry that records the process a receipt launched. */
describe("each owner's evidence beside another record", () => {
  const noHandles = (overrides: Partial<QuietPorts> = {}) => ports({ owners: ownerCensusReader(productionLivenessSources,
    { readEvents: async (after) => f.journal.replay(after), readSession: (query) => f.client.readSession!(query), heldHosts: () => new Map() }), ...overrides });

  test.each(["claude row first", "codex row first"])("each owner's engine reads its own tail, whichever row the registry lists first: %s (R3, R12)", async (order) => {
    const now = Date.now();
    const path = transcript("open", new Date(now - 2 * FIVE_MINUTES).toISOString());
    const claude = spawn(), codex = spawn();
    const record = (engine: "claude" | "codex", identity: ProcessIdentity) => f.registry.upsert({ key: { engine, sessionId: randomUUID() },
      artifactPath: path, cwd: f.dir, accountId: "fixture", status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
      structuredHost: { ...columns(identity, 0), kind: engine === "claude" ? "claude-broker" : "codex-app-server" } });
    if (order === "claude row first") { record("claude", claude.identity); record("codex", codex.identity); }
    else { record("codex", codex.identity); record("claude", claude.identity); }
    expect(Object.values(f.registry.readOnlySnapshot().entries).map((entry) => entry.key.engine))
      .toEqual(order === "claude row first" ? ["claude", "codex"] : ["codex", "claude"]);
    for (const at of [now, now + TWELVE_HOURS]) {
      const result = await probe(noHandles(), at);
      expect(result).toMatchObject({ quiet: false, blockers: { turns: 2, unresolved: 0 } });
      expect(result.blockers.turnList).toEqual(expect.arrayContaining([
        expect.objectContaining({ engine: "codex", reason: "turn-open" }),
        expect.objectContaining({ engine: "claude", reason: "turn-unread" }),
      ]));
    }
    await exit(codex);
    expect(await probe(noHandles(), now)).toMatchObject({ quiet: false, blockers: { turns: 1,
      turnList: [{ engine: "claude", reason: "turn-unread" }] } });
    await exit(claude);
    expect(await probe(noHandles(), now)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test.each(["beside a listed idle mark", "alone"])("a running mark on a row the snapshot omits is fetched %s (R5, R9)", async (shape) => {
    const own = conversation(transcript("settled"));
    const other = conversation(transcript("settled"));
    const host = spawn();
    const claim = claimHost(own.key, own.path, host.identity, "idle");
    if (shape === "beside a listed idle mark") publish(other.id, own.key, other.path, claim.fence, null);
    publish(own.id, own.key, own.path, claim.fence, "own-turn");
    const held = { quiet: false, blockers: { turns: 1, turnList: [{ conversationId: own.id, reason: "turn-claimed" }] } };
    expect(await probe(noHandles())).toMatchObject(held);
    // A write that names no writer moves the row behind the cap and leaves the mark and the fence.
    f.journal.append({ scope: { type: "session", id: own.id }, kind: "session-status",
      producer: { kind: "fixture", eventKey: randomUUID() }, payload: { host: "dead" } });
    for (let n = 0; n < 129; n++) {
      const id = `conversation_${randomUUID()}`;
      f.journal.append({ scope: { type: "session", id }, kind: "session-status", producer: { kind: "fixture", eventKey: randomUUID() },
        payload: { conversationId: id, sessionKey: { engine: "codex", sessionId: randomUUID() }, hostKind: "unhosted", host: "dead",
          turn: "idle", activeTurnId: null, provenance: "derived" } });
    }
    expect(f.journal.snapshot().sessions.some((session) => session.conversationId === own.id)).toBe(false);
    expect(row(own.id)).toMatchObject({ host: "dead", writerClaim: claim.fence, writerStatus: { writerClaim: claim.fence, turn: "running" } });
    expect(await probe(noHandles())).toMatchObject(held);
    expect(await probe(noHandles(), Date.now() + TWELVE_HOURS)).toMatchObject(held);
    release(own.key, claim);
    await exit(host);
    expect(await probe(noHandles())).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("a journal path whose directory refuses its description holds through unreadable past the bound (R7, R8, R9)", async () => {
    if (process.getuid?.() === 0) return;
    const directory = join(process.env.LLV_CODEX_HOME!, "sessions", "2026", "01", "02");
    mkdirSync(directory, { recursive: true });
    const sessionId = randomUUID();
    const path = join(directory, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);
    writeFileSync(path, transcriptText("open", new Date().toISOString(), sessionId));
    const id = `conversation_${randomUUID()}`;
    publish(id, { engine: "codex", sessionId }, path, null, "unknown-turn");
    expect(f.registry.readOnlySnapshot()).toMatchObject({ entries: {}, conversations: {} });
    chmodSync(directory, 0o000);
    try {
      await expect(productionLivenessSources().transcriptEvidence("codex", path, { strict: true })).rejects.toThrow(/EACCES/);
      const p = ports(), now = Date.now();
      for (const at of [now, now + FIVE_MINUTES, now + TWELVE_HOURS]) {
        expect(await probe(p, at)).toMatchObject({ quiet: false, blockers: { unreadable: expect.stringContaining("EACCES") } });
      }
      chmodSync(directory, 0o700);
      expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { unreadable: null, turns: 1,
        turnList: [{ conversationId: id, reason: "unresolved", unresolved: true }] } });
    } finally {
      chmodSync(directory, 0o700);
    }
  });

  test("an entry that records a receipt's launched process keeps that receipt's conversation custody (R1, R10)", async () => {
    const path = transcript("settled");
    const host = spawn();
    const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.dir, transport: "tmux", accountId: "fixture" });
    if (begun.kind !== "created") throw new Error("fixture launch receipt unavailable");
    const launchId = begun.receipt.launchId, evidence = tmuxHost(host.identity);
    f.registry.bindSpawnPane(launchId, { endpoint: evidence.endpoint, server: evidence.server, paneId: evidence.paneId, panePid: evidence.panePid, target: evidence.paneId });
    f.registry.markSpawnHostVerified(launchId, evidence);
    const key = { engine: "codex" as const, sessionId: randomUUID() };
    const entry = { key, artifactPath: path, cwd: f.dir, accountId: "fixture", status: "idle" as const, host: evidence,
      claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null };
    expect(f.registry.settleSpawn(launchId, entry).kind).toBe("settled");
    // The receipt as it stands before its conversation row and its entry are written.
    const disk = f.registry.snapshot(), receipt = disk.receipts[launchId]!;
    expect(receipt).toMatchObject({ state: "completed", verifiedHost: { agent: host.identity } });
    delete disk.conversations[receipt.conversationId];
    delete disk.entries[sessionKeyId(key)];
    writeFileSync(f.registry.filename, JSON.stringify(disk));
    const pipelines = () => [{ id: "lane_receipt", task: "Finish the work", state: "running", cursor: { stageId: "stage", state: "running" },
      runs: [{ stageId: "stage", attempts: [{ n: 1, conversationId: receipt.conversationId }] }] }] as unknown as ReturnType<QuietPorts["pipelines"]>;
    const p = noHandles({ pipelines }), now = Date.now();
    expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { stages: 1 } });
    f.registry.upsert(entry);
    expect(f.registry.readOnlySnapshot()).toMatchObject({ entries: { [sessionKeyId(key)]: { host: { agent: host.identity } } } });
    expect(f.registry.readOnlySnapshot().conversations[receipt.conversationId]).toBeUndefined();
    expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { stages: 1 } });
    expect(await probe(p, now + TWELVE_HOURS)).toMatchObject({ quiet: false, blockers: { stages: 1 } });
    await exit(host);
    // With the process gone the stage's settled transcript holds it for the bound only.
    expect(await probe(p, now + TWELVE_HOURS + FIVE_MINUTES)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
  });

  test("an entry that records a receipt's agent beside another pane leaves the receipt's live pane its own owner (R1, R2, R10)", async () => {
    const path = transcript("open");
    const agent = spawn(), pane = spawn(), otherPane = spawn();
    await exit(agent);
    await exit(otherPane);
    const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.dir, transport: "tmux", accountId: "fixture" });
    if (begun.kind !== "created") throw new Error("fixture launch receipt unavailable");
    const launchId = begun.receipt.launchId, evidence = { ...tmuxHost(agent.identity), panePid: pane.identity };
    f.registry.bindSpawnPane(launchId, { endpoint: evidence.endpoint, server: evidence.server, paneId: evidence.paneId, panePid: evidence.panePid, target: evidence.paneId });
    f.registry.markSpawnHostVerified(launchId, evidence);
    const key = { engine: "codex" as const, sessionId: randomUUID() };
    const entry = { key, artifactPath: path, cwd: f.dir, accountId: "fixture", status: "idle" as const, host: evidence,
      claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null };
    expect(f.registry.settleSpawn(launchId, entry).kind).toBe("settled");
    const disk = f.registry.snapshot(), receipt = disk.receipts[launchId]!;
    expect(receipt).toMatchObject({ state: "completed", verifiedHost: { agent: agent.identity }, pane: { panePid: pane.identity } });
    delete disk.conversations[receipt.conversationId];
    delete disk.entries[sessionKeyId(key)];
    writeFileSync(f.registry.filename, JSON.stringify(disk));
    const pipelines = () => [{ id: "lane_pane", task: "Finish the work", state: "running", cursor: { stageId: "stage", state: "running" },
      runs: [{ stageId: "stage", attempts: [{ n: 1, conversationId: receipt.conversationId }] }] }] as unknown as ReturnType<QuietPorts["pipelines"]>;
    const p = noHandles({ pipelines }), now = Date.now();
    const held = { quiet: false, blockers: { turns: 1, stages: 1, turnList: [{ reason: "turn-open" }] } };
    expect(await probe(p, now)).toMatchObject(held);
    // The entry records the same agent, gone, beside a pane of its own, gone too.
    f.registry.upsert({ ...entry, host: { ...evidence, panePid: otherPane.identity } });
    expect(f.registry.readOnlySnapshot().entries[sessionKeyId(key)]).toMatchObject({ host: { agent: agent.identity, panePid: otherPane.identity } });
    expect(await probe(p, now)).toMatchObject(held);
    expect(await probe(p, now + TWELVE_HOURS)).toMatchObject(held);
    await exit(pane);
    expect(await probe(p, now)).toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0 } });
  });

  test("a round an entry records keeps the round's conversation custody past the unresolved bound (R1, R10)", async () => {
    const path = transcript("settled");
    const reviewer = spawn();
    const reviewerConversationId = `conversation_${randomUUID()}`;
    const flows = [{ id: "flow_detached", reviewerMode: "headless", state: "completed", rounds: [{ n: 1, reviewerPid: reviewer.child.pid,
      reviewerIdentity: reviewer.identity.startIdentity, reviewerPath: path, reviewerConversationId, verdict: "APPROVE" }] }] as unknown as Flow[];
    const pipelines = () => [{ id: "lane_round", task: "Review the work", state: "running", cursor: { stageId: "stage", state: "running" },
      runs: [{ stageId: "stage", attempts: [{ n: 1, conversationId: reviewerConversationId }] }] }] as unknown as ReturnType<QuietPorts["pipelines"]>;
    const p = ports({ pipelines, owners: ownerCensusReader(() => ({ ...productionLivenessSources(), flows: () => flows }),
      { readEvents: async (after) => f.journal.replay(after), readSession: (query) => f.client.readSession!(query), heldHosts: () => new Map() }) });
    const now = Date.now();
    const held = { quiet: false, blockers: { stages: 1 } };
    expect(await probe(p, now)).toMatchObject(held);
    // An idle entry records the reviewer at the round's transcript under another conversation.
    const other = conversation(transcript("settled"));
    f.registry.upsert({ key: other.key, artifactPath: path, cwd: f.dir, accountId: "fixture", status: "idle", host: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: columns(reviewer.identity, 0) });
    expect(f.registry.readOnlySnapshot().conversations[reviewerConversationId]).toBeUndefined();
    for (const at of [now, now + FIVE_MINUTES + 1, now + TWELVE_HOURS]) expect(await probe(p, at)).toMatchObject(held);
    await exit(reviewer);
    expect(await probe(p, now + TWELVE_HOURS)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
  });

  test.each(["a settled tail", "an open tail and a running journal row"])(
    "a round with no start identity holds beside a reused entry at its pid until its own process is gone, over %s (R1, R4)", async (shape) => {
      const open = shape !== "a settled tail";
      const c = conversation(transcript(open ? "open" : "settled"));
      const reviewer = spawn();
      // The entry records an earlier process under the reviewer's pid.
      release(c.key, claimHost(c.key, c.path, { ...reviewer.identity, startIdentity: "earlier-process" }, "idle"));
      const flows = [{ id: "flow_unproven", reviewerMode: "headless", state: "completed", rounds: [{ n: 1, reviewerPid: reviewer.child.pid,
        reviewerIdentity: null, reviewerPath: c.path, reviewerConversationId: c.id, verdict: "APPROVE" }] }] as unknown as Flow[];
      if (open) publish(c.id, c.key, c.path, null, "active-review");
      const owners = ownerCensusReader(() => ({ ...productionLivenessSources(), flows: () => flows }),
        { readEvents: async (after) => f.journal.replay(after), readSession: (query) => f.client.readSession!(query), heldHosts: () => new Map() });
      const p = ports({ flows: () => flows, owners });
      const read = await owners([], {});
      expect(read.owners.map((owner) => [owner.role, owner.process])).toEqual([["host", "gone"], ["reviewer", "alive"]]);
      expect(await probe(p)).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "reviewer" }] } });
      await exit(reviewer);
      expect(await probe(p)).toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0 } });
    });

  test("a round that records an entry's exact process after the entry's artifact moved is that entry's owner (R1, R3, R10)", async () => {
    const now = Date.now();
    const launchPath = transcript("open");
    const c = conversation(launchPath);
    const reviewer = spawn();
    release(c.key, claimHost(c.key, launchPath, reviewer.identity, "idle"));
    f.registry.upsert({ ...f.registry.snapshot().entries[sessionKeyId(c.key)]!, artifactPath: transcript("settled") });
    const roundConversationId = `conversation_${randomUUID()}`;
    const flows = [{ id: "flow_moved", reviewerMode: "headless", state: "completed", rounds: [{ n: 1, reviewerPid: reviewer.child.pid,
      reviewerIdentity: reviewer.identity.startIdentity, reviewerPath: launchPath, reviewerConversationId: roundConversationId,
      verdict: "APPROVE" }] }] as unknown as Flow[];
    const owners = ownerCensusReader(() => ({ ...productionLivenessSources(), flows: () => flows }),
      { readEvents: async (after) => f.journal.replay(after), readSession: (query) => f.client.readSession!(query), heldHosts: () => new Map() });
    const read = await owners([], {});
    expect(read.owners).toHaveLength(1);
    expect(read.owners[0]).toMatchObject({ role: "host", custody: [roundConversationId] });
    // The settled entry artifact releases the turn; the round's own flow
    // custody holds while its process lives (R10).
    expect(await probe(ports({ flows: () => flows, owners }), now + TWELVE_HOURS)).toMatchObject({ quiet: false, blockers: { turns: 0, stages: 1 } });
    // A stage that names the round's conversation reaches its live process
    // through the census alone.
    const pipelines = () => [{ id: "lane_moved", task: "Review the work", state: "running", cursor: { stageId: "stage", state: "running" },
      runs: [{ stageId: "stage", attempts: [{ n: 1, conversationId: roundConversationId }] }] }] as unknown as ReturnType<QuietPorts["pipelines"]>;
    const staged = ports({ owners, pipelines });
    expect(await probe(staged, now + TWELVE_HOURS)).toMatchObject({ quiet: false, blockers: { turns: 0, stages: 1 } });
    await exit(reviewer);
    expect(await probe(staged, now + TWELVE_HOURS)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
  });

  describe("a handle's health is judged on the process it names (R4)", () => {
    const withHandle = (key: Key, state: Partial<HostState> & { pid: number }) => {
      const handle = heldHost(state.pid, state);
      return ports({ owners: ownerCensusReader(productionLivenessSources, { readEvents: async (after) => f.journal.replay(after), readSession: (query) => f.client.readSession!(query),
        heldHosts: () => new Map([[sessionKeyId(key), handle.host]]) }) });
    };

    test.each(["its own start identity", "no start identity"])("stale health naming the recorded host, gone, with %s releases at once", async (shape) => {
      const c = conversation(transcript("settled"));
      const wrapper = spawn();
      claimHost(c.key, c.path, wrapper.identity, "live", "w-turn");
      await exit(wrapper);
      const p = withHandle(c.key, { pid: wrapper.child.pid, status: "active", activeTurnRef: "w-turn",
        processStartIdentity: shape === "no start identity" ? null : wrapper.identity.startIdentity });
      expect(await probe(p)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
    });

    test.each(["the recorded start identity", "no start identity"])("health naming a reused pid with %s requires comparable identity or death", async (shape) => {
      const c = conversation(transcript("settled"));
      const reuser = spawn();
      const recorded = { ...reuser.identity, startIdentity: "an-earlier-process" };
      claimHost(c.key, c.path, recorded, "live", "w-turn");
      const p = withHandle(c.key, { pid: reuser.child.pid, status: "active", activeTurnRef: "w-turn",
        processStartIdentity: shape === "no start identity" ? null : recorded.startIdentity });
      const unproven = shape === "no start identity";
      expect(await probe(p)).toMatchObject({ quiet: !unproven, blockers: { turns: unproven ? 1 : 0 } });
      await exit(reuser);
      expect((await probe(p)).quiet).toBe(true);
    });

    test("control: health naming another live process holds under that process until it exits", async () => {
      const c = conversation(transcript("settled"));
      const wrapper = spawn(), successor = spawn();
      claimHost(c.key, c.path, wrapper.identity, "live", "w-turn");
      await exit(wrapper);
      const p = withHandle(c.key, { pid: successor.child.pid, status: "active", activeTurnRef: "s-turn" });
      expect(await probe(p)).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ conversationId: c.id, reason: "host-turn" }] } });
      await exit(successor);
      expect(await probe(p)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
    });
  });
});

// The three retained review reproductions, through the production drain seam.
test("safety comparison: live standalone tmux owner accepts a new turn over an older completed tail", async () => {
  const path = transcript("settled", new Date(Date.now() - 60_000).toISOString());
  const c = conversation(path);
  const child = Bun.spawn([process.execPath, "-e",
    "process.stdin.once('data', () => { process.stdout.write('WORK_ACCEPTED\\n'); setInterval(() => {}, 1000); });"],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const identity = captureProcessIdentity(child.pid)!;
  expect(identity).not.toBeNull();
  f.registry.upsert({ key: c.key, artifactPath: path, cwd: f.dir, accountId: "fixture", status: "live",
    host: { ...tmuxHost(identity), endpoint: join(f.dir, "fixture.sock") },
    claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null });
  child.stdin.write("new prompt\n");
  child.stdin.flush();
  const response = await child.stdout.getReader().read();
  expect(new TextDecoder().decode(response.value)).toContain("WORK_ACCEPTED");
  await fallback();
  expect(row(c.id)).toMatchObject({ host: "hosted", turn: "running", hostKind: "tmux-legacy" });
  expect(productionLivenessSources().probe.pidAlive(child.pid)).toBe(true);
  expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1 } });
  const admission = Date.parse(f.registry.readOnlySnapshot().entries[sessionKeyId(c.key)]!.updatedAt);
  // Fresh output after an old completion supplies no settlement for new work.
  appendFileSync(path, JSON.stringify({ timestamp: new Date(admission + 1).toISOString(),
    type: "response_item", payload: { type: "reasoning", summary: [] } }) + "\n");
  expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1 } });
  // A strictly newer terminal marker settles this owner's admitted work.
  appendFileSync(path, JSON.stringify({ timestamp: new Date(admission + 2).toISOString(),
    type: "event_msg", payload: { type: "task_complete" } }) + "\n");
  expect((await probe()).quiet).toBe(true);
  // Losing that settlement restores custody while the process still answers.
  writeFileSync(path, transcriptText("settled", new Date(admission - 1).toISOString()));
  expect((await probe()).quiet).toBe(false);
  await exit({ child });
  expect((await probe()).quiet).toBe(true);
});

test.each(["minimal", "production"])("safety comparison: compacted deciding start holds under %s retention", async (retention) => {
  const path = transcript("settled", new Date(Date.now() - 60_000).toISOString());
  const c = conversation(path), worker = spawn();
  const claim = claimHost(c.key, path, worker.identity, "live", null);
  const status = (cursor: number, fence = claim.fence) => f.journal.append({ scope: { type: "session", id: c.id }, kind: "session-status",
    producer: { kind: "codex-app-server", eventKey: `structured-host:${sessionKeyId(c.key)}:${fenceEpoch(fence)}:${cursor}:idle:${randomUUID()}` },
    payload: { conversationId: c.id, sessionKey: c.key, hostKind: "codex-app-server", host: "hosted", turn: "idle", activeTurnId: null,
      writerClaim: fence, artifactPath: path, cwd: f.dir, accountId: "fixture" } });
  status(10);
  f.journal.append(projectEngineHostEvent(c.id, sessionKeyId(c.key), { kind: "turn-started", turnId: "new-active-turn", seq: 20 } as never)!);
  status(10); // An old idle sample appended late.
  await fallback(); // Preserves the idle mark beside the registry's live copy.
  expect((await probe()).quiet).toBe(false);
  if (retention === "production") {
    // The unchanged production 20,000-event window, with unrelated output.
    for (let i = 0; i < 19_998; i++) f.journal.append({ scope: { type: "session", id: "noise" }, kind: "delta",
      producer: { kind: "codex-app-server", eventKey: `noise:${i}` }, payload: { text: "output" } });
  } else f.journal.compact(2);
  expect(f.journal.replay(0)).toMatchObject({ reset: true, floorSeq: 2 });
  expect(productionLivenessSources().probe.pidAlive(worker.child.pid)).toBe(true);
  expect(await probe(ports())).toMatchObject({ quiet: false, blockers: { turns: 1, unreadable: null } });
  if (retention === "minimal") {
    status(20); // Equality cannot prove a settlement newer than the lost start.
    expect((await probe(ports())).quiet).toBe(false);
    status(30, claim.fence.replace(/:\d+$/, `:${claim.epoch + 1}`));
    expect((await probe(ports())).quiet).toBe(false); // Another epoch cannot settle this one.
  }
  status(30); // An own checkpoint beyond the retained engine high-water mark.
  expect((await probe(ports())).quiet).toBe(true);
  const unknown = ports({ owners: ownerCensusReader(productionLivenessSources, {
    readEvents: async (after) => f.journal.replay(after), readProducerCursor: async () => 0,
    readSession: (query) => f.client.readSession!(query),
  }) });
  expect((await probe(unknown)).quiet).toBe(false);
  // Remove the fixture Viewer's separate setup claim before testing death.
  release(c.key, claim);
  await exit(worker);
  expect((await probe(unknown)).quiet).toBe(true);
}, 120_000);

test("safety comparison: busy answering handle with no start identity must survive a reused registry identity", async () => {
  const c = conversation(transcript("settled")), worker = spawn();
  claimHost(c.key, c.path, { ...worker.identity, startIdentity: "earlier-process" }, "live", "earlier-turn");
  const held = heldHost(worker.child.pid, { status: "active", activeTurnRef: "current-live-turn", processStartIdentity: null });
  await bindStructuredDeliveryQueue([{ key: c.key, host: held.host }], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
  expect(productionLivenessSources().probe.pidAlive(worker.child.pid)).toBe(true);
  expect(await held.host.health()).toMatchObject({ status: "active", activeTurnRef: "current-live-turn", pid: worker.child.pid, processStartIdentity: null });
  const p = ports();
  expect(await probe(p)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
  await exit(worker);
  expect((await probe(p)).quiet).toBe(true);
});
