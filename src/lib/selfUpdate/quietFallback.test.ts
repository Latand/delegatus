/* Real controller fallback + RuntimeJournal, with the production liveness reader. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { agentLivenessSnapshot, productionLivenessSources, livenessRecordIsLive } from "@/lib/lifecycle/liveness";
import { bindStructuredDeliveryQueue, settleHostlessSessionProjections } from "@/lib/runtime/structuredDeliveryController";
import { FakeEngineHost } from "@/lib/runtime/fixtures/fakeEngineHost";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeEventInput, RuntimeHostAxis, RuntimeSession, RuntimeTurnAxis } from "@/lib/runtime/contracts";
import type { Pipeline, PipelineCursorState } from "@/lib/pipelines/types";
import type { Flow } from "@/lib/flows/types";
import { RuntimeJournal } from "../../runtime-host/journal";
import type { SessionHostMetadata } from "../../runtime-host/journalSessionMetadata";
import { productionDeps, registeredTurnOwnerReader } from "./instance";
import { probeQuiet, type QuietPorts } from "./quiet";
import type { Snapshot } from "./types";

const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;
const previousCodexHome = process.env.LLV_CODEX_HOME;
let f: ReturnType<typeof fixture>;
let child: ReturnType<typeof Bun.spawn>;

function ports(journal: RuntimeJournal): QuietPorts {
  return { ...productionDeps().quiet!, runtimeSnapshot: async () => journal.snapshot(),
    turnOwners: registeredTurnOwnerReader(() => f.client),
    pipelines: () => [], flows: () => [], seats: () => [], presence: () => [],
    registryHealth: () => [], controllerBusyReason: async () => null, memoryAvailableMb: () => 8_192 };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "quiet-fallback-"));
  process.env.LLV_CODEX_HOME = join(dir, "codex");
  const transcriptDir = join(process.env.LLV_CODEX_HOME, "sessions", "2026", "01", "01");
  mkdirSync(transcriptDir, { recursive: true });
  const id = randomUUID(), at = new Date().toISOString();
  const file = join(transcriptDir, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  writeFileSync(file, [
    { timestamp: at, type: "session_meta", payload: { id, cwd: dir } },
    { timestamp: at, type: "event_msg", payload: { type: "task_started" } },
    { timestamp: at, type: "event_msg", payload: { type: "user_message", message: "Run the task" } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const registry = new AgentRegistry(join(dir, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  const conversation = registry.ensureConversation("codex", file, "fixture");
  const key = { engine: "codex" as const, sessionId: conversation.generations[0]!.id };
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
    operationStatus: async () => null,
    effectBatch: async () => [],
  } as unknown as RuntimeHostClient;
  return { dir, registry, conversation, key, file, journal, client };
}

beforeEach(() => {
  f = fixture();
  child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid);
  if (!identity) throw new Error("fixture process identity unavailable");
  f.registry.upsert({ key: f.key, artifactPath: f.file, cwd: f.dir, accountId: "fixture", status: "live", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: null,
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:fixture", process: identity,
      eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: "running-turn", pendingAttention: [], activeFlags: [] } });
});

afterEach(async () => {
  await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
  setAgentRegistryForTests(null);
  if (child.exitCode === null) child.kill();
  await child.exited;
  f.journal.close();
  rmSync(f.dir, { recursive: true, force: true });
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
});

function journalRow(overrides: Partial<RuntimeSession> = {}) {
  f.journal.append({ scope: { type: "session", id: f.conversation.id }, kind: "session-status",
    producer: { kind: "codex-app-server", eventKey: randomUUID() },
    payload: { sessionKey: f.key, hostKind: "codex-app-server", host: "hosted", turn: "running", provenance: "structured",
      artifactPath: f.file, cwd: f.dir, accountId: "fixture", activeTurnId: "running-turn", ...overrides } });
}

async function fallback(status: "dead" | "unhosted" | "idle") {
  const entry = f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
  f.registry.upsert({ ...entry, status });
  await bindStructuredDeliveryQueue([], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
}

async function activity() {
  return (await agentLivenessSnapshot({ conversationId: f.conversation.id, limit: 1 }, productionLivenessSources())).conversations;
}

function stage(owner: object, state: Pipeline["state"] = "running", cursor: PipelineCursorState | null = "running"): Pipeline {
  return { id: "lane", state, cursor: cursor ? { state: cursor, stageId: "build" } : null,
    runs: [{ stageId: "build", attempts: [{ n: 1, ...owner }] }] } as unknown as Pipeline;
}

function inactiveHistory() {
  for (let n = 0; n < 129; n++) {
    const file = join(f.dir, `finished-${n}.jsonl`);
    const owner = f.registry.ensureConversation("codex", file, "fixture");
    const key = { engine: "codex" as const, sessionId: owner.generations[0]!.id };
    f.registry.upsert({ key, artifactPath: file, cwd: f.dir, accountId: "fixture", status: "dead", host: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: null });
    f.journal.append({ scope: { type: "session", id: owner.id }, kind: "session-status",
      producer: { kind: "fixture", eventKey: `finished-${n}` }, payload: {
        sessionKey: key, hostKind: "unhosted", host: "dead", turn: "idle", activeTurnId: null,
        artifactPath: file, provenance: "derived" } });
  }
}

function snapshotSelection(indexed: boolean, target = f.conversation.id) {
  const metadata = (f.journal as unknown as { sessionHostMetadata: SessionHostMetadata }).sessionHostMetadata;
  metadata.close();
  if (indexed) {
    for (let step = 0; !metadata.ready && step < 100; step++) metadata.step();
    expect(metadata.ready).toBe(true);
  } else metadata.ready = false;
  const rows = f.journal.snapshot().sessions;
  expect(rows).toHaveLength(128);
  expect(rows.some(row => row.conversationId === target)).toBe(false);
  expect(f.journal.readSession({ conversationId: target })).not.toBeNull();
}

for (const status of ["dead", "unhosted", "idle"] as const) {
  for (const indexed of [false, true]) {
    test(`snapshot cap preserves live ${status} fallback owner with ${indexed ? "indexed" : "legacy"} selection`, async () => {
      journalRow();
      await fallback(status);
      inactiveHistory();
      snapshotSelection(indexed);
      const p = ports(f.journal), reader = p.turnLiveness!;
      const asked: string[] = [];
      p.turnLiveness = async (row, probe) => { asked.push(row.conversationId); return reader(row, probe); };
      expect((await activity())[0]).toMatchObject({ host: { state: "alive" }, turnState: "busy" });
      expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1, stages: 0 } });
      expect(asked.filter(id => id === f.conversation.id)).toHaveLength(1);
    });
  }
  test(`snapshot cap keeps live ${status} owner after unresolved history expires`, async () => {
    journalRow();
    await fallback(status);
    // These newer rows have no registry binding or readable transcript.
    for (let n = 0; n < 129; n++) {
      f.journal.append({ scope: { type: "session", id: `conversation_${randomUUID()}` }, kind: "session-status",
        producer: { kind: "fixture", eventKey: `unknown-${n}` }, payload: {
          sessionKey: { engine: "codex", sessionId: `unknown-${n}` }, hostKind: "unhosted", host: "unhosted",
          turn: "unknown", activeTurnId: null, provenance: "derived" } });
    }
    snapshotSelection(true);
    const p = ports(f.journal), now = Date.now();
    expect(await probeQuiet(snapshot, p, now, true)).toMatchObject({ quiet: false, blockers: { turns: 129, unresolved: 128 } });
    expect(await probeQuiet(snapshot, p, now + 300_000, true)).toMatchObject({ quiet: false,
      blockers: { turns: 1, unresolved: 128, unresolvedBlocking: 0 } });
  });
  for (const control of ["dead", "reused", "idle"] as const) {
    test(`snapshot cap releases ${control} owner after ${status} fallback`, async () => {
      if (control === "dead") { child.kill(); await child.exited; }
      if (control === "idle") settleTranscript();
      if (control === "reused") {
        const entry = f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
        f.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!,
          process: { ...entry.structuredHost!.process!, startIdentity: "different-start" } } });
      }
      journalRow();
      await fallback(status);
      inactiveHistory();
      snapshotSelection(true);
      const p = ports(f.journal), reader = p.turnLiveness!;
      let asked = false;
      p.turnLiveness = async (row, probe) => { if (row.conversationId === f.conversation.id) asked = true; return reader(row, probe); };
      expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0 } });
      expect(asked).toBe(true);
    });
  }
}

test("a registered live owner without a journal projection still holds the drain", async () => {
  expect(f.journal.snapshot().sessions).toHaveLength(0);
  const p = ports(f.journal);
  expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
  child.kill();
  await child.exited;
  expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
});

test.each(["live", "unowned", "dead", "reused"] as const)("a hidden %s setup receipt is judged before its conversation binding materializes", async (kind) => {
  settleTranscript();
  const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.dir, transport: "structured", accountId: "fixture" });
  if (begun.kind !== "created") throw new Error("fixture launch receipt unavailable");
  const disk = f.registry.snapshot(), receipt = disk.receipts[begun.receipt.launchId]!;
  const identity = captureProcessIdentity(child.pid)!;
  receipt.admissionOwner = kind === "unowned" ? null : kind === "reused"
    ? { ...identity, startIdentity: "different-start" } : identity;
  if (kind === "dead") { child.kill(); await child.exited; }
  delete disk.conversations[receipt.conversationId];
  writeFileSync(f.registry.filename, JSON.stringify(disk));
  expect(f.registry.readOnlySnapshot().conversations[receipt.conversationId]).toBeUndefined();
  f.journal.append({ scope: { type: "session", id: receipt.conversationId }, kind: "session-status",
    producer: { kind: "fixture", eventKey: "receipt-setup" }, payload: {
      sessionKey: { engine: "codex", sessionId: "receipt-setup" }, hostKind: "unhosted", host: "unhosted",
      turn: "unknown", activeTurnId: null, provenance: "derived" } });
  inactiveHistory();
  snapshotSelection(true, receipt.conversationId);
  const p = ports(f.journal), now = Date.now();
  const held = kind === "live" || kind === "unowned";
  expect(await probeQuiet(snapshot, p, now, true)).toMatchObject({ quiet: !held, blockers: { turns: held ? 1 : 0 } });
  expect(await probeQuiet(snapshot, p, now + 300_000, true)).toMatchObject({ quiet: kind !== "live",
    blockers: { turns: kind === "live" ? 1 : 0, unresolved: kind === "unowned" ? 1 : 0, unresolvedBlocking: 0 } });
  if (kind === "live") {
    child.kill();
    await child.exited;
    expect(await probeQuiet(snapshot, p, now + 300_000, true)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
  }
});

test("an unbound registry entry still exposes its hidden live journal owner by path", async () => {
  journalRow();
  await fallback("idle");
  const disk = f.registry.snapshot();
  delete disk.conversations[f.conversation.id];
  writeFileSync(f.registry.filename, JSON.stringify(disk));
  inactiveHistory();
  snapshotSelection(true);
  expect(await probeQuiet(snapshot, ports(f.journal), Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
});

test("keyed reads retain a hidden journal turn hint over a settled transcript", async () => {
  settleTranscript();
  journalRow({ host: "unhosted", turn: "idle", activeTurnId: "new-turn" });
  inactiveHistory();
  snapshotSelection(true);
  expect(await probeQuiet(snapshot, ports(f.journal), Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
});

test("unreadable hidden journal evidence holds admission and can recover on the next probe", async () => {
  journalRow();
  await fallback("idle");
  inactiveHistory();
  snapshotSelection(true);
  const p = ports(f.journal), read = f.client.readSession!;
  f.client.readSession = async () => { throw new Error("fixture keyed read unavailable"); };
  expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: false, blockers: { unreadable: expect.any(String) } });
  f.client.readSession = read;
  expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1, unreadable: null } });
});

for (const status of ["dead", "unhosted", "idle"] as const) {
  test(`production fallback retains a live standalone turn with lagging ${status} registry status`, async () => {
    journalRow();
    const p = ports(f.journal);
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
    await fallback(status);
    expect(f.journal.readSession({ conversationId: f.conversation.id })).toMatchObject({
      host: status === "dead" ? "dead" : "unhosted", turn: status === "idle" ? "idle" : "unknown", activeTurnId: null,
    });
    expect(await settleHostlessSessionProjections()).toBe(0);
    const live = await activity();
    expect(live.filter(livenessRecordIsLive)).toHaveLength(1);
    expect(live[0]).toMatchObject({ host: { state: "alive" }, turnState: "busy" });
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1, stages: 0 } });
  });
}

for (const host of ["hosted", "unhosted", "dead", "conflict"] satisfies RuntimeHostAxis[]) {
  for (const turn of ["unknown", "idle"] satisfies RuntimeTurnAxis[]) {
    test(`shared busy verdict is read for ${host}/${turn} with no active turn id`, async () => {
      await fallback("idle");
      journalRow({ host, turn, activeTurnId: null });
      const p = ports(f.journal), reader = p.turnLiveness!;
      let reads = 0;
      p.turnLiveness = async (row, probe) => { reads++; return reader(row, probe); };
      expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
      expect(reads).toBe(1);
    });
  }
}

test.each(["running", "unknown", "idle"] as const)("missing conversation with %s labels expires exactly at five minutes and stays diagnosed", async (turn) => {
  settleTranscript();
  const orphan = `conversation_${randomUUID()}`;
  f.journal.append({ scope: { type: "session", id: orphan }, kind: "session-status",
    producer: { kind: "fixture", eventKey: "orphan" }, payload: { sessionKey: { engine: "codex", sessionId: "orphan" },
      hostKind: "codex-app-server", host: "unhosted", turn, activeTurnId: null, provenance: "structured" } });
  const p = ports(f.journal), now = Date.now();
  expect(await probeQuiet(snapshot, p, now, true)).toMatchObject({ quiet: false, blockers: { turns: 1, unresolved: 1 } });
  expect(await probeQuiet(snapshot, p, now + 299_999, true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
  expect(await probeQuiet(snapshot, p, now + 300_000, true)).toMatchObject({ quiet: true, blockers: { turns: 0, unresolved: 1, unresolvedBlocking: 0 } });
});

test("a proven dead PID releases its open turn and running stage immediately", async () => {
  child.kill();
  await child.exited;
  journalRow();
  const p = ports(f.journal);
  p.pipelines = () => [stage({ conversationId: f.conversation.id, agentPath: f.file })];
  expect((await activity()).filter(livenessRecordIsLive)).toHaveLength(0);
  expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0, discounted: 1 } });
});

test("a running stage keeps its live owner after fallback and beyond the unresolved bound", async () => {
  await fallback("idle");
  const p = ports(f.journal);
  p.pipelines = () => [stage({ conversationId: f.conversation.id, agentPath: f.file })];
  expect(await probeQuiet(snapshot, p, Date.now() + 3_600_000, true)).toMatchObject({ quiet: false, blockers: { stages: 1 } });
});

function settleTranscript() {
  appendFileSync(f.file, JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "task_complete" } }) + "\n");
  const entry = f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
  f.registry.upsert({ ...entry, status: "idle", structuredHost: { ...entry.structuredHost!, activeTurnRef: null } });
}

test("a genuinely settled idle turn stays quiet while its host process lives", async () => {
  settleTranscript();
  await fallback("idle");
  expect((await activity())[0]).toMatchObject({ host: { state: "alive" }, turnState: "idle" });
  expect(await probeQuiet(snapshot, ports(f.journal), Date.now(), true)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
});

test("an active turn id with idle journal labels protects a newly admitted turn over a settled transcript", async () => {
  settleTranscript();
  await fallback("idle");
  journalRow({ host: "unhosted", turn: "idle", activeTurnId: "new-turn" });
  expect(await probeQuiet(snapshot, ports(f.journal), Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
});

test("an active registry turn retains custody over a previous settled transcript after fallback", async () => {
  settleTranscript();
  const entry = f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
  f.registry.upsert({ ...entry, structuredHost: { ...entry.structuredHost!, activeTurnRef: "new-turn" } });
  await fallback("idle");
  expect(f.journal.readSession({ conversationId: f.conversation.id })).toMatchObject({ turn: "idle", activeTurnId: null });
  expect((await activity())[0]).toMatchObject({ turnState: "idle" });
  expect(await probeQuiet(snapshot, ports(f.journal), Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
  const idle = Object.assign(new FakeEngineHost(), { onStateChange: () => () => {} });
  await bindStructuredDeliveryQueue([{ key: f.key, host: idle }], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
  expect(await probeQuiet(snapshot, ports(f.journal), Date.now(), true)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
});

test("an admitted standalone resume retains custody over settled journal and transcript labels", async () => {
  settleTranscript();
  const begun = beginLegacySpawnFixture(f.registry, { engine: "codex", cwd: f.dir, transport: "structured", accountId: "fixture",
    conversationId: f.conversation.id, purpose: "resume-successor", expectedArtifactPath: f.file });
  expect(begun.kind).toBe("created");
  await fallback("idle");
  expect(f.journal.readSession({ conversationId: f.conversation.id })).toMatchObject({ turn: "idle", activeTurnId: null });
  expect(await probeQuiet(snapshot, ports(f.journal), Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
  const oldIdleHost = Object.assign(new FakeEngineHost(), { onStateChange: () => () => {} });
  await bindStructuredDeliveryQueue([{ key: f.key, host: oldIdleHost }], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
  expect(await probeQuiet(snapshot, ports(f.journal), Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
});

test("current writer setup retains custody after fallback without a host process or launch receipt", async () => {
  settleTranscript();
  const entry = f.registry.readOnlySnapshot().entries[`codex:${f.key.sessionId}`]!;
  const owner = captureProcessIdentity(child.pid)!;
  f.registry.upsert({ ...entry, claimEpoch: 1, claimOwner: `structured-host:${JSON.stringify(owner)}`,
    structuredHost: { ...entry.structuredHost!, process: null, writerClaimEpoch: 1 } });
  await fallback("idle");
  expect(await probeQuiet(snapshot, ports(f.journal), Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
  child.kill();
  await child.exited;
  expect(await probeQuiet(snapshot, ports(f.journal), Date.now(), true)).toMatchObject({ quiet: true, blockers: { turns: 0 } });
});

test("current host work overrides idle journal labels and a settled transcript", async () => {
  settleTranscript();
  const host = Object.assign(new FakeEngineHost(), { onStateChange: () => () => {} });
  const health = await host.health();
  host.health = async () => ({ ...health, status: "active", activeTurnRef: "new-turn" });
  await bindStructuredDeliveryQueue([{ key: f.key, host }], { registry: f.registry, client: f.client, hostlessSettleIntervalMs: 0 });
  journalRow({ host: "unhosted", turn: "idle", activeTurnId: null });
  expect(await probeQuiet(snapshot, ports(f.journal), Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
});

for (const [state, cursor] of [["paused", "running"], ["needs_decision", "running"], ["completed", "running"],
  ["closed", "running"], ["running", "pending"], ["running", null]] as const) {
  test(`stage eligibility ${state}/${cursor} cannot hide a live historical journal turn`, async () => {
    await fallback("idle");
    const p = ports(f.journal);
    p.pipelines = () => [stage({ conversationId: f.conversation.id, agentPath: f.file, historical: true }, state, cursor)];
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1, stages: 0 } });
  });
}

test("unreadable shared evidence holds even a settled fallback row", async () => {
  settleTranscript();
  await fallback("idle");
  const p = ports(f.journal);
  p.turnLiveness = async () => { throw new Error("fixture evidence unavailable"); };
  expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
});

test("a held reservation with a readable owner path retains stage custody", async () => {
  await fallback("idle");
  const p = ports(f.journal);
  p.runtimeSnapshot = async () => ({ sessions: [] });
  const reader = p.turnLiveness!;
  let reads = 0;
  p.turnLiveness = async (row, probe) => { reads++; return reader(row, probe); };
  p.pipelines = () => [stage({ conversationId: null, launchId: null, agentPath: f.file, activation: { phase: "reserved" } }, "running", "spawning")];
  expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: false, blockers: { stages: 1 } });
  // The path-only stage and the independently inventoried conversation each
  // ask the shared reader; neither identity substitutes for the other.
  expect(reads).toBe(2);
  child.kill();
  await child.exited;
  expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
  p.pipelines = () => [stage({ conversationId: null, launchId: null, activation: { phase: "reserved" } }, "running", "spawning")];
  expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
});

test("the flow implementer phase exclusion cannot hide its live fallback journal turn", async () => {
  await fallback("idle");
  const p = ports(f.journal);
  p.flows = () => [{ id: "review-flow", state: "reviewing", implementerConversationId: f.conversation.id,
    implementerPath: f.file, rounds: [] } as unknown as Flow];
  expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: false, blockers: { turns: 1, stages: 0 } });
});
