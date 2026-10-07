/* The case map of docs/design/update-drain-liveness.md over the real seams:
   AgentRegistry claims, the delivery controller's fallback and seats,
   RuntimeJournal commands and `projectEngineHostEvent`, read by the
   production owner reader and judged by `probeQuiet`. Each test names the
   table row it decides. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    owners: ownerCensusReader(productionLivenessSources, { readSession: (query) => f.client.readSession!(query) }),
    pipelines: () => [], flows: () => [], seats: () => [], presence: () => [],
    registryHealth: () => [], controllerBusyReason: async () => null, memoryAvailableMb: () => 8_192, ...overrides };
}

const probe = (p: QuietPorts = ports(), at = Date.now()) => probeQuiet(snapshot, p, at, true);

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
function publish(id: string, key: Key, path: string, fence: string | null, activeTurnRef: string | null) {
  f.journal.append({ scope: { type: "session", id }, kind: "session-status",
    producer: { kind: "codex-app-server", eventKey: randomUUID() },
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

/** A held host whose health the test sets. */
function heldHost(pid: number, state: Partial<HostState> = {}) {
  const listeners: ((state: HostState) => void)[] = [];
  const host = Object.assign(new FakeEngineHost(), { onStateChange: (listener: (state: HostState) => void) => {
    listeners.push(listener);
    return () => {};
  } });
  const base = host.health.bind(host);
  host.health = async () => ({ ...await base(), pid, ...state });
  return { host, fire: async (next: Partial<HostState>) => {
    const current = { ...await host.health(), ...next };
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
    event(s.id, s.key, "turn-started", "a-late");
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

  test("B's released claim keeps its epoch, so its statement stands until a publication names no writer", async () => {
    const s = await sameKeySuccessor();
    publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
    release(s.key, s.claimB);
    expect(await probe()).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-claimed" }] } });
    // A host whose claim was released publishes `null` (`publishHostState`, no claim owner).
    publish(s.id, s.key, s.path, null, "b-turn");
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
        await fallback();
        event(t.id, t.key, "turn-started", "a-late");
        expect(row(t.id)).toMatchObject({ writerClaim: null, turn: "running" });
        expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
      });
    }
    test(`B under ${under} with A's fence still on the row is released over a settled tail`, async () => {
      const t = await tmuxSuccessor(under, "live");
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

  test("a live tmux pane over a settled transcript with only the copy of its own entry is released", async () => {
    const path = transcript("settled");
    const c = conversation(path);
    const b = spawn();
    f.registry.upsert({ key: c.key, artifactPath: path, cwd: f.dir, accountId: "fixture", status: "live", host: tmuxHost(b.identity),
      claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null });
    await fallback();
    expect(row(c.id)).toMatchObject({ host: "hosted", turn: "running", writerClaim: null });
    for (const at of [Date.now(), Date.now() + TWELVE_HOURS]) expect(await probe(ports(), at)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  test("B's transcript with no turn marker is unknown for five minutes from its newest record", async () => {
    const now = Date.now();
    const t = await tmuxSuccessor("own key", "idle", "unmarked", new Date(now).toISOString());
    await fallback();
    expect(await probe(ports(), now)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 1, unresolvedBlocking: 1,
      turnList: [{ conversationId: t.id, reason: "turn-unread", unresolved: true }] } });
    expect(await probe(ports(), now + FIVE_MINUTES)).toMatchObject({ quiet: true, blockers: { turns: 0, unresolved: 1, unresolvedBlocking: 0 } });
  });

  test("a handle this Viewer holds under B's key reporting a turn holds as host-turn", async () => {
    const t = await tmuxSuccessor("own key", "idle");
    await fallback();
    const held = heldHost(t.b.child.pid, { status: "active", activeTurnRef: "b-turn" });
    const p = ports({ owners: ownerCensusReader(productionLivenessSources, { readSession: (query) => f.client.readSession!(query),
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

  test("B's own running publication, a copy of the registry, then A's late event leave B to its own sources", async () => {
    const s = await sameKeySuccessor();
    publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
    await fallback();
    event(s.id, s.key, "turn-started", "a-late");
    expect(row(s.id)).toMatchObject({ writerClaim: null, turn: "running" });
    expect(await probe()).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  });

  describe("a row at B's fence that claims a turn and carries no mark", () => {
    /** The row a runtime host from before the build leaves: the build's
        journal writes a mark for every named publication, so it is removed. */
    const unmarked = (overrides: Partial<QuietPorts> = {}) => ports({ runtimeSnapshot: async () => ({
      sessions: f.journal.snapshot().sessions.map((session) => ({ ...session, writerStatus: undefined })) }), ...overrides });

    test("is unknown until five minutes after the transcript's newest record, then released and counted", async () => {
      const now = Date.now();
      const s = await sameKeySuccessor();
      writeFileSync(s.path, transcriptText("settled", new Date(now).toISOString()));
      publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
      const p = unmarked();
      expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 1, turnList: [{ reason: "turn-unattributed", unresolved: true }] } });
      expect(await probe(p, now + FIVE_MINUTES)).toMatchObject({ quiet: true, blockers: { turns: 0, unresolved: 1, unresolvedBlocking: 0 } });
    });

    test("is released on the first probe when that record is already older", async () => {
      const s = await sameKeySuccessor();
      writeFileSync(s.path, transcriptText("settled", new Date(Date.now() - 2 * FIVE_MINUTES).toISOString()));
      publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
      expect(await probe(unmarked())).toMatchObject({ quiet: true, blockers: { turns: 0, unresolved: 1 } });
    });

    test("is released at once by a handle that says idle, and held as turn-open by an open tail", async () => {
      const s = await sameKeySuccessor();
      publish(s.id, s.key, s.path, s.claimB.fence, "b-turn");
      const idle = heldHost(s.b.child.pid, { status: "idle", activeTurnRef: null });
      const withHandle = unmarked({ owners: ownerCensusReader(productionLivenessSources, { readSession: (query) => f.client.readSession!(query),
        heldHosts: () => new Map([[sessionKeyId(s.key), idle.host]]) }) });
      expect(await probe(withHandle)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
      writeFileSync(s.path, transcriptText("open"));
      expect(await probe(unmarked())).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ reason: "turn-open" }] } });
    });
  });
});

function transcriptText(state: "settled" | "open" | "unmarked", at = new Date().toISOString(), id = randomUUID()): string {
  const event = (type: string) => ({ timestamp: at, type: "event_msg", payload: { type } });
  return [{ timestamp: at, type: "session_meta", payload: { id, cwd: f.dir } },
    ...(state === "unmarked" ? [] : [event("task_started"), event("user_message")]),
    ...(state === "settled" ? [event("task_complete")] : [])].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

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

  test("a live host whose transcript carries no turn marker holds for five minutes from its newest record and stays counted", async () => {
    const now = Date.now();
    const path = transcript("unmarked", new Date(now).toISOString());
    const c = conversation(path);
    const b = spawn();
    claimHost(c.key, path, b.identity, "idle");
    expect(await probe(ports(), now)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 1, turnList: [{ reason: "turn-unread" }] } });
    expect(await probe(ports(), now + FIVE_MINUTES - 1)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
    expect(await probe(ports(), now + FIVE_MINUTES)).toMatchObject({ quiet: true, blockers: { turns: 0, unresolved: 1, unresolvedBlocking: 0 } });
  });

  test("with no readable transcript the five minutes run from the first probe", async () => {
    const path = transcript("settled");
    const c = conversation(path);
    const b = spawn();
    claimHost(c.key, path, b.identity, "idle");
    rmSync(path);
    const p = ports(), now = Date.now();
    expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 1, turnList: [{ reason: "turn-unread" }] } });
    expect(await probe(p, now + FIVE_MINUTES - 1)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
    expect(await probe(p, now + FIVE_MINUTES)).toMatchObject({ quiet: true, blockers: { turns: 0, unresolved: 1 } });
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
        publish(t.id, t.key, t.path, t.fence, null);
        if (write === "send outcome") f.journal.executeOperation({ kind: "send", operationId: "op-late", idempotencyKey: "late", conversationId: t.id, text: "go", policy: "queue" });
      },
      apply: (t: Target) => foreignWrite(t, write),
    })),
    ...(["turn-ended", "turn-started", "send outcome", "interrupt"] as const).map((write) => ({
      name: `the owner's own running publication, then a foreign ${write}`, writer: true as const,
      base: (t: Target) => {
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

  test("the mark speaks for the owner its key and writer epoch name while the row still carries its fence, whatever the row's own status says", () => {
    expect(journalStatement([literal({})], owner)).toBe("claimed");
    expect(journalStatement([literal({ turn: "idle", activeTurnId: null, host: "dead" })], owner)).toBe("claimed");
    expect(journalStatement([literal({ turn: "running", activeTurnId: "a-turn", writerStatus: { ...mark, turn: "idle", activeTurnId: null } })], owner)).toBeNull();
  });

  test("it speaks for nobody once the row names no writer or another writer, nor under another key or epoch", () => {
    expect(journalStatement([literal({ writerClaim: null })], owner)).toBeNull();
    expect(journalStatement([literal({ writerClaim: "structured-host:{\"pid\":1}:3" })], owner)).toBeNull();
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
    expect(ownerVerdict({ ...live, handle: "idle", journal: "claimed", rowReference: true, tail: idleTail })).toEqual({ verdict: "released", reason: "turn-settled" });
    expect(ownerVerdict({ ...live, handle: "idle", tail: { turn: "busy", lastRecordAt: 0 } })).toEqual({ verdict: "holds", reason: "turn-open" });
    expect(ownerVerdict({ ...live, journal: "unattributed", tail: idleTail })).toEqual({ verdict: "unknown", reason: "turn-unattributed" });
    expect(ownerVerdict({ ...live, handle: "idle", journal: "unattributed", tail: idleTail })).toEqual({ verdict: "released", reason: "turn-settled" });
    expect(ownerVerdict({ ...live, tail: { turn: "unknown", lastRecordAt: 0 } })).toEqual({ verdict: "unknown", reason: "turn-unread" });
    expect(ownerVerdict({ ...live, handle: "idle", tail: null })).toEqual({ verdict: "unknown", reason: "turn-unread" });
  });
});

/* Each owner is judged and bounded on its own records: its unknown runs its
   own five minutes, a round describes only the launch it names, its journal
   statement is found by its mark's key and writer, and a read that fails is
   no verdict. */
describe("each owner on its own records", () => {
  test("an owner's unknown runs its own bound: an earlier owner of the same conversation neither starts nor ends it (R8, R12)", async () => {
    const path = transcript("settled");
    const c = conversation(path);
    const a = spawn();
    const claimA = claimHost(c.key, path, a.identity, "idle");
    rmSync(path);
    const p = ports(), now = Date.now();
    expect(await probe(p, now)).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ conversationId: c.id, reason: "turn-unread" }] } });
    const b = spawn();
    claimHost({ engine: "codex", sessionId: randomUUID() }, path, b.identity, "idle");
    expect(await probe(p, now + FIVE_MINUTES)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolvedBlocking: 1,
      turnList: [{ conversationId: c.id, reason: "turn-unread", unresolved: true }] } });
    release(c.key, claimA);
    await exit(a);
    expect(await probe(p, now + 2 * FIVE_MINUTES - 1)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolvedBlocking: 1 } });
    expect(await probe(p, now + 2 * FIVE_MINUTES)).toMatchObject({ quiet: true, blockers: { turns: 0, unresolvedBlocking: 0 } });
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
    { readSession: (query) => f.client.readSession!(query) }) });
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
    const p = ports({ owners: ownerCensusReader(productionLivenessSources, { readSession: (query) => f.client.readSession!(query), heldHosts: () => new Map() }) });
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
    }, { readSession: (query) => f.client.readSession!(query) }) });
    const now = Date.now();
    for (const at of [now, now + FIVE_MINUTES, now + TWELVE_HOURS]) {
      expect(await probe(p, at)).toMatchObject({ quiet: false, blockers: { unreadable: "independent transcript read failure" } });
    }
    failing = false;
    expect(await probe(p, now + TWELVE_HOURS)).toMatchObject({ quiet: true, blockers: { turns: 0, unreadable: null } });
  });
});
