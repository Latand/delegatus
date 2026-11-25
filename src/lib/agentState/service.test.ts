import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { AgentStateService, startAgentStateService, stopAgentStateService, servingAgentStateService } from "./service";
import { readStructuredHostRecords } from "@/lib/runtime/structuredHostControl";
import { observeAgentProcess } from "./process";
import { StructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryQueue";
import type { EngineHost } from "@/lib/runtime/engineHost";
import * as deliveryController from "@/lib/runtime/structuredDeliveryController";
import { runStructuredHostRetirementSweep } from "@/lib/runtime/structuredHostRetirement";
import { determined } from "@/lib/runtime/determinable";
import { runtimeIdleKillMatches } from "@/lib/runtime/contracts";
import { RuntimeJournal } from "@/runtime-host/journal";
import { cachedAgentObservation, clearAgentObservations } from "./projectionCache";
import { AGENT_STATE_POLICY, centralIdleEligible } from "./model";
import { readAgentProjection, readAgentStateMetrics, subjectId } from "./store";
import { VerifiedBackgroundWorkCache } from "@/lib/pipelines/backgroundTasks";
import { FIXTURE_CONVERSATION, FIXTURE_NOW, FIXTURE_SESSION, fixtureRegistry, fixtureRecords, currentClaudeRecords, type FixtureEngine } from "./testFixture";

const roots: string[] = [], registries: AgentRegistry[] = [];
afterEach(() => { clearAgentObservations(); for (const registry of registries.splice(0)) registry.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(engine: FixtureEngine = "codex", backgroundWork?: (transcriptPath: string, nowMs: number) => Promise<import("@/lib/pipelines/backgroundTasks").VerifiedBackgroundWork>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "central-service-")); roots.push(root);
  const filename = path.join(root, "registry.json");
  fs.writeFileSync(filename, JSON.stringify(fixtureRegistry(root, engine, captureProcessIdentity(process.pid), null)));
  const records = fixtureRecords(engine);
  const transcript = path.join(root, "native.jsonl");
  fs.writeFileSync(transcript, [...records.open, ...records.close].map(row => JSON.stringify(row)).join("\n") + "\n");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") }); registries.push(registry);
  let owns = true, clock = FIXTURE_NOW + 2000, publications = 0;
  const service = new AgentStateService({ registry, now: () => clock, owns: () => owns, process: observeAgentProcess,
    memory: () => null, release: "fixture", backgroundWork, publish: async () => { publications++; return true; } });
  return { root, registry, service, transcript, entry: () => registry.hostEntry({ engine, sessionId: FIXTURE_SESSION })!,
    demote: () => { owns = false; }, advance: (ms: number) => { clock += ms; }, publications: () => publications };
}
test("cycle discovery reuses verified processless archive versions and observes peer changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "central-discovery-"));
  roots.push(root);
  const seed = fixtureRegistry(root, "codex", captureProcessIdentity(process.pid), null);
  const live = seed.entries[`codex:${FIXTURE_SESSION}`]!;
  for (let index = 0; index < 48; index++) {
    const sessionId = `archived-${index}`;
    seed.entries[`codex:${sessionId}`] = { ...structuredClone(live), key: { engine: "codex", sessionId },
      status: "dead", structuredHost: { ...live.structuredHost!, process: null } };
  }
  const filename = path.join(root, "registry.json");
  fs.writeFileSync(filename, JSON.stringify(seed));
  let reads = 0;
  const open = () => new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite"),
    onSqliteRowPayloadRead: (collection, count) => { if (collection === "entries") reads += count; } });
  const registry = open(), peer = open();
  registries.push(registry, peer);
  expect(peer.archiveInactiveRows(128)).toBe(48);
  const service = new AgentStateService({ registry, now: () => FIXTURE_NOW, owns: () => true,
    process: () => "unverified", memory: () => null, publish: async () => false, release: "fixture" });
  const visited: string[] = [];
  spyOn(service, "reconcile").mockImplementation(async entry => { visited.push(entry.key.sessionId); return null; });
  const pass = async () => {
    reads = 0;
    visited.length = 0;
    await service.request();
    return { visited: [...visited], reads };
  };
  expect((await pass()).visited).toEqual([FIXTURE_SESSION]);
  const warm = await pass();
  expect(warm.visited).toEqual([FIXTURE_SESSION]);

  peer.agentStateWrite(file => { file.entries["codex:archived-7"]!.structuredHost!.process = captureProcessIdentity(process.pid); });
  const expected = [FIXTURE_SESSION, "archived-7"];
  expect((await pass()).visited).toEqual([...expected].sort((a, b) => a.localeCompare(b)));

  // A restored mapping can point the same key at another immutable version.
  using db = new Database(path.join(root, "registry.sqlite"));
  const replaceArchived = (sessionId: string, hostPatch: object) => db.transaction(() => {
    const key = `codex:${sessionId}`;
    const version = db.query<{ id: number }, [string, string]>(`INSERT INTO registry_archive(collection,row_key,row_order,value_json)
      SELECT collection,row_key,row_order,json_patch(value_json,?) FROM registry_rows
      WHERE collection='entries' AND row_key=? RETURNING id`).get(JSON.stringify({ structuredHost: hostPatch }), key)!;
    db.run("UPDATE registry_cold SET archive_id=? WHERE collection='entries' AND row_key=?", [version.id, key]);
  })();
  replaceArchived("archived-8", { process: captureProcessIdentity(process.pid) });
  expect((await pass()).visited).toEqual([...expected, "archived-8"].sort((a, b) => a.localeCompare(b)));
  replaceArchived("archived-9", { eventCursor: -1 });
  await expect(pass()).rejects.toThrow("structured host event cursor is invalid");
  expect(warm.reads).toBeLessThan(10);
});

for (const drift of ["owner", "turn", "attention", "artifact", "demotion"] as const) {
  test(`a ${drift} change after native acquisition refuses the old proposal before any repair or publication`, async () => {
    const f = fixture(), original = f.service.cache.acquire.bind(f.service.cache);
    f.service.cache.acquire = async input => {
      const native = await original(input);
      if (drift === "demotion") f.demote();
      else if (drift === "artifact") fs.appendFileSync(f.transcript, '{"type":"ignored"}\n');
      else await f.registry.deliveryWriteOrBusy({ label: "fixture.replace" }, () => f.registry.agentStateWrite(file => {
        const entry = file.entries[`codex:${FIXTURE_SESSION}`]!;
        if (drift === "owner") { entry.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`; entry.claimEpoch++; }
        if (drift === "turn") entry.structuredHost!.activeTurnRef = "later-native-turn";
        if (drift === "attention") entry.structuredHost!.pendingAttention.push("new-permission");
      }));
      return native;
    };
    await f.service.request();
    expect(f.entry().structuredHost!.activeTurnRef).not.toBeNull();
    expect(readAgentStateMetrics(f.registry).registryTranscriptDivergencesTotal).toBe(0);
    expect(f.publications()).toBe(0);
  });
}
test("restart validates the persisted artifact summary with zero payload reads and unchanged observations create no journal rows", async () => {
  const f = fixture();
  await f.service.request();
  const before = readAgentStateMetrics(f.registry);
  const successor = new AgentStateService({ ...f.service.ports });
  await successor.request();
  expect(successor.cache.counters.payloadBytes).toBe(0);
  expect(readAgentStateMetrics(f.registry).journalRows).toBe(before.journalRows);
});
test("physical aliases count one unowned host and RSS measurement; dead proof cannot discard native interruption facts", async () => {
  const f = fixture();
  await f.registry.deliveryWriteOrBusy({ label: "fixture.alias" }, () => f.registry.agentStateWrite(file => {
    const entry = JSON.parse(JSON.stringify(file.entries[`codex:${FIXTURE_SESSION}`]!));
    entry.key = { ...entry.key, sessionId: "other-native-generation" };
    file.entries["codex:other-native-generation"] = entry;
  }));
  await f.service.request();
  expect(readAgentStateMetrics(f.registry).unownedHosts).toBe(1);
  const subject = subjectId(f.entry());
  f.service.observeResourceSample([{ agentState: { subject }, rssBytes: 8192 }], FIXTURE_NOW + 2000);
  await f.service.request();
  expect(readAgentStateMetrics(f.registry)).toMatchObject({ unownedHosts: 1, unownedRssMeasured: 1, unownedRssBytes: 8192 });
  f.advance(3 * 60_000);
  await f.service.request();
  expect(readAgentStateMetrics(f.registry)).toMatchObject({ unownedRssMeasured: 0, unownedRssUnknown: 1, unownedRssBytes: null });
  f.service.ports.process = () => "dead";
  await f.service.request();
  expect(readAgentProjection(f.registry, subject)!.verdict.state).toBe("dead");
  expect(readAgentProjection(f.registry, subject)!.facts.turn).toMatchObject({ determined: true, value: { state: "closed" } });
  expect(readAgentStateMetrics(f.registry).unownedHosts).toBe(0);
});
test("missing process identity stays unverified and a foreign PID namespace is never a dead proof", () => {
  expect(observeAgentProcess({ pid: process.pid, startIdentity: null, bootEpoch: "unknown" })).toBe("unverified");
  const identity = captureProcessIdentity(process.pid);
  if (process.platform === "linux") expect(observeAgentProcess({ ...identity, bootEpoch: identity.bootEpoch!.replace(/pidns:.+$/, "pidns:foreign") })).toBe("unverified");
});
test("owned native repair commits its journal before the memory adapter and preserves a later accepted turn", async () => {
  const f = fixture();
  await f.registry.deliveryWriteOrBusy({ label: "fixture.hold" }, () => f.registry.agentStateWrite(file => {
    file.entries[`codex:${FIXTURE_SESSION}`]!.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
  }));
  let active = f.entry().structuredHost!.activeTurnRef, settlements = 0;
  f.service.ports.memory = () => ({ activeTurnRef: active, pendingAttention: [], eventCursor: 0 });
  f.service.ports.settleMemory = () => { settlements++; active = null; return true; };
  const db = new Database(path.join(f.root, "registry.sqlite"));
  try {
    db.exec("CREATE TRIGGER refuse_owned_journal BEFORE INSERT ON registry_rows WHEN NEW.collection='agentStateJournal' BEGIN SELECT RAISE(ABORT,'owned journal refusal'); END");
    await expect(f.service.reconcile(f.entry())).rejects.toThrow("owned journal refusal");
    expect(active).not.toBeNull();
    expect(settlements).toBe(0);
    db.exec("DROP TRIGGER refuse_owned_journal");
    await f.service.request();
    expect(f.entry().structuredHost!.activeTurnRef).toBeNull();
    expect(active).toBeNull();
    expect(settlements).toBe(1);
    await f.registry.deliveryWriteOrBusy({ label: "fixture.next-message" }, () => f.registry.agentStateWrite(file => {
      file.entries[`codex:${FIXTURE_SESSION}`]!.structuredHost!.activeTurnRef = active = "later-accepted-turn";
    }));
    await f.service.request();
    expect(f.entry().structuredHost!.activeTurnRef).toBe("later-accepted-turn");
    expect(settlements).toBe(1);
  } finally { db.close(); }
});


for (const engine of ["codex", "claude", "copilot"] as FixtureEngine[]) test(`${engine}: native correlation survives disagreement between event and filesystem clocks`, async () => {
  const f = fixture(engine);
  await f.registry.deliveryWriteOrBusy({ label: "fixture.clock" }, () => f.registry.agentStateWrite(file => {
    const entry = file.entries[`${engine}:${FIXTURE_SESSION}`]!;
    entry.updatedAt = new Date(FIXTURE_NOW + 86400_000).toISOString();
    entry.structuredHost!.agentStateTurnStartedAt = FIXTURE_NOW + 86400_000;
  }));
  await f.service.request();
  expect(f.entry().structuredHost!.activeTurnRef).toBeNull();
  expect(readAgentProjection(f.registry, subjectId(f.entry()))!.facts.turn).toMatchObject({ determined: true, value: { state: "closed" } });
});

for (const drift of ["conversation", "owner-process", "memory"] as const) test(`projection replay rejects ${drift} replacement after awaited publication preparation`, async () => {
  const f = fixture();
  let ownerAlive = true;
  const owner = { ...captureProcessIdentity(process.pid), pid: process.pid + 100000 };
  const memory = { activeTurnRef: f.entry().structuredHost!.activeTurnRef, pendingAttention: [] as string[], eventCursor: 0 };
  if (drift !== "conversation") {
    await f.registry.deliveryWriteOrBusy({ label: "fixture.publisher-owner" }, () => f.registry.agentStateWrite(file => {
      file.entries[`codex:${FIXTURE_SESSION}`]!.claimOwner = `structured-host:${JSON.stringify(owner)}`;
    }));
    f.service.ports.process = identity => identity.pid === owner.pid ? ownerAlive ? "alive" : "dead" : observeAgentProcess(identity);
    f.service.ports.memory = () => memory;
    f.service.ports.settleMemory = () => { memory.activeTurnRef = null; return true; };
  }
  let attempted = 0;
  f.service.ports.publish = async (_projection, current) => {
    attempted++;
    await Promise.resolve();
    if (drift === "owner-process") ownerAlive = false;
    else if (drift === "memory") memory.pendingAttention.push("new-ask");
    else await f.registry.deliveryWriteOrBusy({ label: "fixture.publisher-conversation" }, () => f.registry.agentStateWrite(file => {
      const conversation = Object.values(file.conversations)[0]!;
      conversation.turn = { ...conversation.turn, state: "busy" };
    }));
    expect(current()).toBe(false);
    return true;
  };
  await f.service.request();
  expect(attempted).toBe(1);
  expect(readAgentProjection(f.registry, subjectId(f.entry()))!.pendingPublication).toBe(true);
});

test("host invalidations coalesce keyed refreshes and stop with the serving generation", async () => {
  const f = fixture();
  await f.service.request();
  const acquired: string[] = [];
  const acquire = f.service.cache.acquire.bind(f.service.cache);
  let observed: () => void = () => undefined;
  const refreshed = new Promise<void>(resolve => { observed = resolve; });
  f.service.cache.acquire = async input => { acquired.push(input.path); observed(); return acquire(input); };
  const key = `codex:${FIXTURE_SESSION}`;
  f.service.invalidate(key); f.service.invalidate(key); f.service.invalidate(key);
  await refreshed;
  await f.service.request();
  expect(acquired).toEqual([f.transcript]);
  f.service.stop();
  f.service.invalidate(key);
  await f.service.request();
  expect(acquired).toEqual([f.transcript]);
});

test("unchanged idle evidence refreshes in memory without changing the durable revision or journal", async () => {
  const f = fixture();
  const idleAt = FIXTURE_NOW - 7 * 3600_000;
  fs.utimesSync(f.transcript, new Date(idleAt), new Date(idleAt));
  await f.service.request();
  const first = readAgentProjection(f.registry, subjectId(f.entry()))!;
  f.advance(60_000);
  expect(centralIdleEligible(first.facts, FIXTURE_NOW + 62_000)).toBe(false);
  await f.service.request();
  const durable = readAgentProjection(f.registry, first.subject)!;
  expect(durable.revision).toBe(first.revision);
  expect(durable.facts.process.evidence.observedAt).toBe(first.facts.process.evidence.observedAt);
  expect(centralIdleEligible(cachedAgentObservation(first.subject)!.facts, FIXTURE_NOW + 62_000)).toBe(true);
});

test("idle host memory cannot hide a generation-bound native open turn", async () => {
  const f = fixture();
  fs.writeFileSync(f.transcript, fixtureRecords("codex").open.map(row => JSON.stringify(row)).join("\n") + "\n");
  const entry = f.entry();
  await f.registry.deliveryWriteOrBusy({ label: "fixture.memory-owner" }, () => f.registry.agentStateWrite(file => {
    file.entries[`codex:${FIXTURE_SESSION}`]!.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
  }));
  f.service.ports.memory = () => ({ activeTurnRef: null, pendingAttention: [], eventCursor: entry.structuredHost!.eventCursor + 1 });
  await f.service.request();
  const row = readAgentProjection(f.registry, subjectId(f.entry()))!;
  expect(row).toMatchObject({ divergence: "native-open-memory-idle", verdict: { state: null, quality: "unverified" } });
  expect(row.facts.turn).toMatchObject({ determined: false, why: "host-memory-idle-conflicts-with-native-open-turn" });
  expect(readAgentStateMetrics(f.registry)).toMatchObject({ registryTranscriptDivergencesTotal: 1, registryTranscriptDivergencesCurrent: 1 });
  expect(f.entry().structuredHost!.activeTurnRef).toBe("native-turn-one");
});

test("idle Claude memory with current end_turn shape settles and becomes eligible at the idle bound", async () => {
  const f = fixture("claude"), records = currentClaudeRecords(40);
  fs.writeFileSync(f.transcript, [...records.open, ...records.close].map(row => JSON.stringify(row)).join("\n") + "\n");
  fs.utimesSync(f.transcript, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
  await f.registry.deliveryWriteOrBusy({ label: "fixture.idle-claude" }, () => f.registry.agentStateWrite(file => {
    file.entries[`claude:${FIXTURE_SESSION}`]!.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
    file.entries[`claude:${FIXTURE_SESSION}`]!.structuredHost!.activeTurnRef = null;
  }));
  f.service.ports.memory = () => ({ activeTurnRef: null, pendingAttention: [], eventCursor: 1 });
  await f.service.request();
  const row = readAgentProjection(f.registry, subjectId(f.entry()))!;
  expect(row).toMatchObject({ divergence: null, verdict: { state: "idle", quality: "verified" }, facts: { turn: { determined: true, value: { state: "closed" } } } });
  expect(centralIdleEligible(cachedAgentObservation(row.subject)!.facts, FIXTURE_NOW + 2000)).toBe(false);
  f.advance(AGENT_STATE_POLICY.idleMs);
  await f.service.request();
  expect(centralIdleEligible(cachedAgentObservation(row.subject)!.facts, f.service.ports.now())).toBe(true);
});

test("idle Claude conflict has a restart-stable deadline and retains genuinely open native work", async () => {
  const f = fixture("claude");
  fs.writeFileSync(f.transcript, currentClaudeRecords().open.map(row => JSON.stringify(row)).join("\n") + "\n");
  fs.utimesSync(f.transcript, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
  await f.registry.deliveryWriteOrBusy({ label: "fixture.conflicting-claude" }, () => f.registry.agentStateWrite(file => {
    file.entries[`claude:${FIXTURE_SESSION}`]!.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
  }));
  f.service.ports.memory = () => ({ activeTurnRef: null, pendingAttention: [], eventCursor: 1 });
  await f.service.request();
  const subject = subjectId(f.entry());
  expect(readAgentProjection(f.registry, subject)!.facts.turn.determined).toBe(false);
  f.advance(AGENT_STATE_POLICY.startupGraceMs - 2001);
  const successor = new AgentStateService({ ...f.service.ports });
  await successor.request();
  expect(readAgentProjection(f.registry, subject)!.facts.turn.determined).toBe(false);
  f.advance(1);
  await successor.request();
  const row = cachedAgentObservation(subject)!;
  expect(row.facts.turn).toMatchObject({ determined: true, value: { state: "open" }, evidence: { ref: "native-open-after-idle-conflict-grace" } });
  expect(row.verdict.state).toBe("working");
  expect(centralIdleEligible(row.facts, f.service.ports.now())).toBe(false);
});

test.each([
  { policy: "queue", onlyIfIdle: false, busy: false },
  { policy: "interrupt-active", onlyIfIdle: false, busy: false },
  { policy: "queue", onlyIfIdle: true, busy: false },
  { policy: "queue", onlyIfIdle: true, busy: true },
] as const)("Claude delivery reads live host health despite an unknown central turn: %j", async ({ policy, onlyIfIdle, busy }) => {
  const f = fixture("claude");
  fs.writeFileSync(f.transcript, currentClaudeRecords().open.map(row => JSON.stringify(row)).join("\n") + "\n");
  fs.utimesSync(f.transcript, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
  await f.registry.deliveryWriteOrBusy({ label: "fixture.delivery-memory" }, () => f.registry.agentStateWrite(file => {
    file.entries[`claude:${FIXTURE_SESSION}`]!.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
  }));
  f.service.ports.memory = () => ({ activeTurnRef: null, pendingAttention: [], eventCursor: 1 });
  await f.service.request();
  expect(readAgentProjection(f.registry, subjectId(f.entry()))!.facts.turn.determined).toBe(false);
  let sends = 0;
  const host: EngineHost = {
    supportsQueuedSend: true, sendWaitsForRunningTurn: true,
    attach: () => ({ async *[Symbol.asyncIterator]() {} }),
    health: async () => ({ status: busy ? "active" : "idle", sessionKey: FIXTURE_SESSION, endpoint: "test:claude", pid: process.pid,
      processStartIdentity: "fixture", eventCursor: 1, protocolVersion: "test", activeTurnRef: busy ? "running-turn" : null,
      pendingAttention: [], activeFlags: [], account: null }),
    send: async () => { sends++; return { outcome: "turn-started", turnId: "next-turn" }; },
    interrupt: async () => { throw new Error("idle send must not interrupt"); }, answer: async () => {}, release: async () => {},
  };
  expect(f.publications()).toBe(0);
  const journal = new RuntimeJournal(path.join(f.root, "runtime.sqlite"), { structuredHosts: true, now: f.service.ports.now });
  const conversationId = readAgentProjection(f.registry, subjectId(f.entry()))!.conversationId!, operationId = "delivery-fixture";
  try {
    journal.append({ scope: { type: "session", id: conversationId }, kind: "session-status", payload: {
      conversationId, sessionKey: { engine: "claude", sessionId: FIXTURE_SESSION }, hostKind: "claude-broker", host: "hosted",
      turn: busy ? "running" : "idle", activeTurnId: busy ? "running-turn" : null, writerClaim: "fixture:1", attentionIds: [],
      capabilities: { steer: false, structuredAttention: true },
    } });
    journal.executeOperation({ kind: "send", conversationId, operationId, idempotencyKey: operationId, text: "fixture input", policy,
      ...(onlyIfIdle ? { turnId: null, onlyIfIdle: { revision: journal.readSession({ conversationId })!.revision, writerClaim: "fixture:1" } } : {}) });
    const queue = new StructuredDeliveryQueue({
      effects: async () => journal.effectBatch(100, ["runtime.send"]),
      status: async id => journal.operationResult(id)?.receipt ?? null, hostClaim: async () => "fixture:1",
      idleContinuationCurrent: async (_id, fence) => {
        const current = journal.readSession({ conversationId })!;
        return runtimeIdleKillMatches({ ...current, retirementBlocked: false }, current.sessionKey, fence);
      },
      transition: async (id, status, details, options) => { journal.transitionOperation(id, status, details, options); },
    }, () => host, undefined, undefined, null, undefined, undefined, undefined, { now: f.service.ports.now });
    await queue.drain();
    expect(sends).toBe(busy ? 0 : 1);
    expect(journal.operationResult(operationId)!.receipt).toMatchObject(busy
      ? { status: "rejected", reason: "idle-continuation-cancelled" } : { status: "delivered" });
  } finally { journal.close(); }
});

const retirementScenarios: { name: string; hours: number; held: boolean; closed: boolean; operation: boolean;
  clause: string | null; legacy?: boolean; pending?: boolean;
  boundary?: "mismatched" | "memory-mismatched" | "retained" | "accepted" | "unbound" }[] = [
  { name: "a held open turn", hours: 7, held: true, closed: false, operation: true, clause: "turn-settled" },
  { name: "an ownerless open turn before the abandoned-turn bound", hours: 5, held: false, closed: false, operation: true, clause: "turn-settled" },
  { name: "an abandoned open turn with an unresolved launch", hours: 7, held: false, closed: false, operation: true, clause: "no-open-operation" },
  { name: "an abandoned open turn without an operation", hours: 7, held: false, closed: false, operation: false, clause: null },
  { name: "a native end_turn with a historical launch", hours: 1, held: false, closed: true, operation: true, clause: null },
  { name: "a held native end_turn with a historical launch", hours: 1, held: true, closed: true, operation: true, clause: null },
  { name: "a held legacy native end_turn with a historical launch", hours: 1, held: true, closed: true, operation: true, legacy: true, clause: null },
  { name: "a held native end_turn without an operation", hours: 1, held: true, closed: true, operation: false, clause: null },
  { name: "a held native end_turn with a pending operation", hours: 1, held: true, closed: true, operation: true, pending: true, clause: "no-open-operation" },
  { name: "a held terminal from a different native turn", hours: 1, held: true, closed: true, operation: true, boundary: "mismatched", clause: "no-open-operation" },
  { name: "a held terminal with a different memory native id", hours: 1, held: true, closed: true, operation: true, boundary: "memory-mismatched", clause: "no-open-operation" },
  { name: "a held terminal with an unresolved local reference", hours: 1, held: true, closed: true, operation: true, boundary: "retained", clause: "no-open-operation" },
  { name: "a held terminal before a later accepted turn", hours: 1, held: true, closed: true, operation: true, boundary: "accepted", clause: "turn-settled" },
  { name: "a held terminal without artifact binding", hours: 1, held: true, closed: true, operation: true, boundary: "unbound", clause: "turn-settled" },
];
for (const scenario of retirementScenarios) test(`retirement with idle memory preserves ${scenario.name}`, async () => {
  const f = fixture("claude"), rows = scenario.legacy ? fixtureRecords("claude") : currentClaudeRecords();
  fs.writeFileSync(f.transcript, [...rows.open, ...(scenario.closed ? rows.close : [])].map(row => JSON.stringify(row)).join("\n") + "\n");
  fs.utimesSync(f.transcript, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
  await f.registry.deliveryWriteOrBusy({ label: "fixture.retirement-policy" }, () => f.registry.agentStateWrite(file => {
    const entry = file.entries[`claude:${FIXTURE_SESSION}`]!;
    if (scenario.held) entry.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
    if (scenario.held && scenario.closed) {
      // The broker clears both references when idle, in currentState and
      // agentStateMemory. Keep the historical launch reference independent.
      entry.structuredHost!.activeTurnRef = null;
      entry.structuredHost!.agentStateNativeTurnId = null;
    }
    if (scenario.boundary === "mismatched") entry.structuredHost!.agentStateNativeTurnId = "later-native-turn";
    if (scenario.boundary === "retained") entry.structuredHost!.activeTurnRef = "unresolved-local-turn";
    if (scenario.boundary === "accepted") entry.structuredHost!.activeTurnRef = "later-local-turn";
    if (scenario.boundary === "unbound") file.conversations[FIXTURE_CONVERSATION]!.generations[0]!.path = path.join(f.root, "other.jsonl");
    if (scenario.pending) entry.pendingAction = "resume";
    if (!scenario.operation) entry.structuredHostOperationId = null;
  }));
  const unexpected = () => { throw new Error("retirement must use central facts without host actuation"); };
  const idleMemory = () => ({ activeTurnRef: scenario.boundary === "accepted" ? "later-local-turn" : null,
    nativeTurnId: scenario.boundary === "accepted" || scenario.boundary === "memory-mismatched" ? "later-native-turn" : null,
    pendingAttention: [], eventCursor: 1 });
  if (scenario.held) f.service.ports.memory = idleMemory;
  f.advance(scenario.hours * 3600_000);
  await f.service.request();
  const projection = readAgentProjection(f.registry, subjectId(f.entry()))!;
  expect(projection.facts.owner).toMatchObject({ determined: true, value: scenario.held ? "held" : "absent" });
  const turnState = scenario.closed && scenario.boundary !== "accepted" ? "closed" : "open";
  expect(projection.facts.turn).toMatchObject({ determined: true, value: { state: turnState } });
  if (scenario.pending) expect(projection.facts.obligations).toMatchObject({ determined: true, value: ["pending-resume"] });
  const idleHost: EngineHost = { agentStateMemory: idleMemory,
    attach: unexpected, health: unexpected, send: unexpected, interrupt: unexpected, answer: unexpected, release: unexpected };
  const memory = spyOn(deliveryController, "structuredDeliveryHostForConversation").mockReturnValue(idleHost);
  const held = spyOn(deliveryController, "hasStructuredDeliveryHost").mockReturnValue(scenario.held);
  setAgentRegistryForTests(f.registry);
  let terminations = 0;
  try {
    const report = await runStructuredHostRetirementSweep({ snapshot: () => f.registry.readOnlySnapshot(), publicationState: () => "ready",
      handoffRows: () => determined([]), durableEventTail: () => determined(0), realtimeBound: () => determined(false),
      orchestratorSeatConversations: () => determined(new Set()), revokedSeatConversations: () => determined(new Set()),
      readCursor: () => null, writeCursor: () => {}, record: () => {}, now: f.service.ports.now, owned: () => scenario.held,
      treePss: () => ({ bytes: null, measuredProcesses: 0 }),
      terminate: async () => { terminations++; return { ok: true, via: "runtime", pids: [] }; } });
    expect(report.failed).toEqual([]);
    if (scenario.clause) {
      expect(terminations).toBe(0);
      expect(report.retired).toEqual([]);
      expect(report.refused).toContainEqual(expect.objectContaining({ clause: scenario.clause }));
    } else {
      expect(terminations).toBe(1);
      expect(report.refused).toEqual([]);
      expect(report.retired).toHaveLength(1);
      expect(report.retired[0]!.reason).toBe(scenario.closed ? undefined : "abandoned turn");
      if (scenario.closed) expect(projection.facts.turn.evidence.source).toBe("native-transcript");
    }
    // Retirement eligibility must preserve the native boundary for resume.
    expect(readAgentProjection(f.registry, subjectId(f.entry()))!.facts.turn).toMatchObject({ determined: true,
      value: { state: turnState } });
  } finally { held.mockRestore(); memory.mockRestore(); setAgentRegistryForTests(null); }
});

test("an unreported Claude background task remains a central obligation and blocks retirement", async () => {
  const f = fixture("claude");
  const rows = currentClaudeRecords();
  const result = rows.open.find(row => row.type === "user" && Array.isArray((row.message as { content?: { type?: string }[] }).content)
    && (row.message as { content: { type?: string }[] }).content.some(part => part.type === "tool_result"));
  if (!result) throw new Error("Claude tool result fixture missing");
  result.toolUseResult = { backgroundTaskId: "fixture-background" };
  fs.writeFileSync(f.transcript, [...rows.open, ...rows.close].map(row => JSON.stringify(row)).join("\n") + "\n");
  fs.utimesSync(f.transcript, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
  f.advance(7 * 3600_000);
  await f.registry.deliveryWriteOrBusy({ label: "fixture.idle-background-host" }, () => f.registry.agentStateWrite(file => {
    file.entries[`claude:${FIXTURE_SESSION}`]!.structuredHost!.activeTurnRef = null;
  }));
  f.service.ports.memory = () => ({ activeTurnRef: null, pendingAttention: [], eventCursor: 1 });
  await f.service.request();
  const projection = readAgentProjection(f.registry, subjectId(f.entry()))!;
  expect(projection.facts.turn).toMatchObject({ determined: true, value: { state: "closed" } });
  expect(projection.facts.obligations).toMatchObject({ determined: true, value: ["background:background task fixture-background"] });
  expect(centralIdleEligible(projection.facts, f.service.ports.now())).toBe(false);

  const unexpected = () => { throw new Error("retirement must use central facts without host actuation"); };
  const idleHost: EngineHost = { agentStateMemory: () => ({ activeTurnRef: null, pendingAttention: [], eventCursor: 1 }),
    attach: unexpected, health: unexpected, send: unexpected, interrupt: unexpected, answer: unexpected, release: unexpected };
  const memory = spyOn(deliveryController, "structuredDeliveryHostForConversation").mockReturnValue(idleHost);
  setAgentRegistryForTests(f.registry);
  let terminations = 0;
  try {
    const report = await runStructuredHostRetirementSweep({ snapshot: () => f.registry.readOnlySnapshot(), publicationState: () => "ready",
      handoffRows: () => determined([]), durableEventTail: () => determined(0), realtimeBound: () => determined(false),
      orchestratorSeatConversations: () => determined(new Set()), revokedSeatConversations: () => determined(new Set()),
      readCursor: () => null, writeCursor: () => {}, record: () => {}, now: f.service.ports.now, owned: () => false,
      treePss: () => ({ bytes: null, measuredProcesses: 0 }),
      terminate: async () => { terminations++; return { ok: true, via: "runtime", pids: [] }; } });
    expect(terminations).toBe(0);
    expect(report.retired).toEqual([]);
    expect(report.refused).toContainEqual(expect.objectContaining({ clause: "turn-settled" }));
  } finally { memory.mockRestore(); setAgentRegistryForTests(null); }
});

test("the production scheduler retains background recovery progress past cache capacity", async () => {
  const recovery = new VerifiedBackgroundWorkCache(4, 2048);
  const f = fixture("claude", recovery.acquire.bind(recovery));
  const files = [f.transcript];
  const originalEntryKey = `claude:${FIXTURE_SESSION}`;
  const base = currentClaudeRecords();
  const contents = `${(JSON.stringify({ type: "metadata", padding: "x".repeat(160) }) + "\n").repeat(8)}${[...base.open, ...base.close].map(row => JSON.stringify(row)).join("\n")}\n`;
  fs.writeFileSync(f.transcript, contents);
  fs.utimesSync(f.transcript, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
  const added: { session: string; filename: string }[] = [];
  for (let index = 0; index < 4; index++) {
    const session = `z234567${index}-1234-4123-8123-0123456789ab`;
    const filename = path.join(f.root, `later-native-${index}.jsonl`);
    fs.writeFileSync(filename, contents);
    fs.utimesSync(filename, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
    files.push(filename);
    added.push({ session, filename });
  }
  await f.registry.deliveryWriteOrBusy({ label: "fixture.background-capacity" }, () => f.registry.agentStateWrite(file => {
    const owner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
    for (const entry of Object.values(file.entries)) if (entry.key.engine === "claude") entry.claimOwner = owner;
    for (const { session, filename } of added) {
      const entry = JSON.parse(JSON.stringify(file.entries[originalEntryKey]!));
      entry.key.sessionId = session;
      entry.artifactPath = filename;
      file.entries[`claude:${session}`] = entry;
      const conversation = JSON.parse(JSON.stringify(file.conversations[FIXTURE_CONVERSATION]!));
      conversation.id = `conversation_${session}`;
      conversation.generations = [{ ...conversation.generations.at(-1), id: session, path: filename }];
      file.conversations[conversation.id] = conversation;
    }
  }));
  f.service.ports.memory = entry => ({ activeTurnRef: null, pendingAttention: [], eventCursor: entry.structuredHost!.eventCursor });

  let completedAt = 0;
  for (let cycle = 1; cycle <= 30; cycle++) {
    await f.service.request();
    const projections = files.map(filename => {
      const entry = Object.values(f.registry.readOnlySnapshot().entries).find(row => row.artifactPath === filename)!;
      return readAgentProjection(f.registry, subjectId(entry))!;
    });
    if (projections.every(row => row.facts.obligations.determined)) { completedAt = cycle; break; }
  }
  const projections = files.map(filename => {
    const entry = Object.values(f.registry.readOnlySnapshot().entries).find(row => row.artifactPath === filename)!;
    return readAgentProjection(f.registry, subjectId(entry))!;
  });
  expect(completedAt).toBeGreaterThan(0);
  expect(projections).toHaveLength(5);
  expect(projections.every(row => row.facts.turn.determined && row.facts.turn.value.state === "closed")).toBe(true);
  expect(projections.every(row => row.facts.obligations.determined && row.facts.obligations.value.length === 0)).toBe(true);
});

test("a newer owned memory turn stays ahead of an older native terminal boundary", async () => {
  const f = fixture();
  const entry = f.entry();
  await f.registry.deliveryWriteOrBusy({ label: "fixture.new-memory-owner" }, () => f.registry.agentStateWrite(file => {
    file.entries[`codex:${FIXTURE_SESSION}`]!.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
  }));
  f.service.ports.memory = () => ({ activeTurnRef: "new-memory-turn", pendingAttention: [], eventCursor: entry.structuredHost!.eventCursor + 1,
    nativeTurnId: "new-native-turn", startedAt: FIXTURE_NOW + 2000 });
  await f.service.request();
  const row = readAgentProjection(f.registry, subjectId(f.entry()))!;
  expect(row).toMatchObject({ divergence: null, verdict: { state: "working", quality: "verified" },
    facts: { turn: { determined: true, value: { state: "open", localRef: "new-memory-turn", at: FIXTURE_NOW + 2000 } } } });
  expect(row.facts.turn.evidence.source).toBe("host-memory");
  expect(f.entry().structuredHost!.activeTurnRef).toBe("native-turn-one");
});

test("resource inventory reports central turn evidence and marks expired observations before a keyed refresh", async () => {
  const f = fixture();
  await f.service.request();
  const rows = (now: number) => readStructuredHostRecords({ snapshot: () => f.registry.readOnlySnapshot(), owned: () => false, now: () => now });
  expect(rows(FIXTURE_NOW + 2000)[0]).toMatchObject({ turnBusy: false, agentState: { state: "unowned", quality: "verified" } });
  expect(rows(FIXTURE_NOW + 8000)[0]).toMatchObject({ turnBusy: null, agentState: { state: "unowned", quality: "unverified" } });
  f.advance(6000);
  await f.service.request();
  expect(rows(FIXTURE_NOW + 8000)[0]).toMatchObject({ turnBusy: false, agentState: { quality: "verified" } });
});

test("stuck counters retain engine and current checking detail and clear after native settlement", async () => {
  const f = fixture();
  await f.service.request();
  fs.appendFileSync(f.transcript, fixtureRecords("codex").open.map(row => JSON.stringify(row)).join("\n") + "\n");
  fs.utimesSync(f.transcript, new Date(FIXTURE_NOW - 3600_000), new Date(FIXTURE_NOW - 3600_000));
  await f.registry.deliveryWriteOrBusy({ label: "fixture.checking" }, () => f.registry.agentStateWrite(file => {
    file.entries[`codex:${FIXTURE_SESSION}`]!.structuredHost!.activeFlags = ["checking"];
  }));
  await f.service.request();
  expect(readAgentStateMetrics(f.registry)).toMatchObject({ stuckTurns: 1, stuckByEngine: { codex: 1, claude: 0, copilot: 0 }, stuckByReason: { checking: 1 } });
  fs.appendFileSync(f.transcript, fixtureRecords("codex").close.map(row => JSON.stringify(row)).join("\n") + "\n");
  await f.service.request();
  expect(readAgentStateMetrics(f.registry)).toMatchObject({ stuckTurns: 0, stuckByEngine: { codex: 0 }, stuckByReason: { checking: 0 } });
});

test("a current held question survives an older terminal until its own attention settles", async () => {
  const f = fixture();
  await f.registry.deliveryWriteOrBusy({ label: "fixture.attention-owner" }, () => f.registry.agentStateWrite(file => {
    file.entries[`codex:${FIXTURE_SESSION}`]!.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
  }));
  let active = f.entry().structuredHost!.activeTurnRef, settled = 0;
  const pending = ["current-question"];
  f.service.ports.memory = () => ({ activeTurnRef: active, pendingAttention: [...pending], eventCursor: 0 });
  f.service.ports.settleMemory = () => { settled++; active = null; return true; };
  await f.service.request();
  expect(settled).toBe(0);
  expect(f.entry().structuredHost!.activeTurnRef).not.toBeNull();
  expect(readAgentProjection(f.registry, subjectId(f.entry()))!.verdict.state).toBe("waiting-operator");
  pending.length = 0;
  await f.service.request();
  expect(settled).toBe(1);
  expect(f.entry().structuredHost!.activeTurnRef).toBeNull();
});

test("a resumed scan retains earlier-page failures until a fresh complete census succeeds", async () => {
  const f = fixture();
  await f.registry.deliveryWriteOrBusy({ label: "fixture.scan-checkpoint" }, () => f.registry.agentStateWrite(file => {
    const metrics = readAgentStateMetrics(f.registry);
    metrics.afterKey = "codex:00000000";
    metrics.subjectsDeferred = 1;
    file.agentStateMetrics.current = metrics;
    file.agentStateMetrics.scanProgress = { ...metrics };
  }));
  const successorRegistry = new AgentRegistry(path.join(f.root, "registry.json"), undefined, undefined,
    { sqliteMode: "sqlite", sqliteFilename: path.join(f.root, "registry.sqlite") });
  registries.push(successorRegistry);
  const successor = new AgentStateService({ ...f.service.ports, registry: successorRegistry });
  await successor.request();
  expect(readAgentStateMetrics(successorRegistry)).toMatchObject({ subjectsDeferred: 1, lastCompleteReconciliationAt: null, afterKey: null });
  await successor.request();
  expect(readAgentStateMetrics(successorRegistry)).toMatchObject({ subjectsDeferred: 0, lastCompleteReconciliationAt: FIXTURE_NOW + 2000 });
});

test("a predecessor never reads or settles the successor host's conversation binding", async () => {
  const f = fixture();
  await f.registry.deliveryWriteOrBusy({ label: "fixture.successor-generation" }, () => f.registry.agentStateWrite(file => {
    const conversation = Object.values(file.conversations)[0]!;
    conversation.generations.push({ ...conversation.generations.at(-1)!, id: "successor-session", path: path.join(f.root, "successor.jsonl") });
  }));
  let settlements = 0;
  f.service.ports.memory = () => ({ activeTurnRef: "successor-turn", pendingAttention: [], eventCursor: 0 });
  f.service.ports.settleMemory = () => { settlements++; return true; };
  await f.service.request();
  const projection = readAgentProjection(f.registry, subjectId(f.entry()))!;
  expect(projection.facts.owner).toMatchObject({ determined: true, value: "absent" });
  expect(projection.facts.turn).toMatchObject({ determined: true, value: { state: "closed" } });
  expect(f.entry().structuredHost!.activeTurnRef).toBeNull();
  expect(Object.values(f.registry.readOnlySnapshot().conversations)[0]!.turn.state).toBe("busy");
  expect(settlements).toBe(0);
});

test("the production startup keeps reconciliation scheduled while publication is unbound", async () => {
  const f = fixture();
  setAgentRegistryForTests(f.registry);
  try {
    await startAgentStateService();
    const serving = servingAgentStateService();
    expect(serving).not.toBeNull();
    expect(serving!.ports.owns()).toBe(false);
    await serving!.request();
    expect(readAgentProjection(f.registry, subjectId(f.entry()))).toBeNull();
  } finally { stopAgentStateService(); setAgentRegistryForTests(null); }
});

test("demotion during production startup imports revokes the pending scheduler installation", async () => {
  const f = fixture();
  setAgentRegistryForTests(f.registry);
  try {
    const starting = startAgentStateService();
    stopAgentStateService();
    await starting;
    expect(servingAgentStateService()).toBeNull();
  } finally { stopAgentStateService(); setAgentRegistryForTests(null); }
});
