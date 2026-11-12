import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { AgentRegistry } from "@/lib/agent/registry";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { AgentStateService } from "./service";
import { readStructuredHostRecords } from "@/lib/runtime/structuredHostControl";
import { observeAgentProcess } from "./process";
import { cachedAgentObservation, clearAgentObservations } from "./projectionCache";
import { centralIdleEligible } from "./model";
import { readAgentProjection, readAgentStateMetrics, subjectId } from "./store";
import { FIXTURE_NOW, FIXTURE_SESSION, fixtureRegistry, fixtureRecords, type FixtureEngine } from "./testFixture";

const roots: string[] = [], registries: AgentRegistry[] = [];
afterEach(() => { clearAgentObservations(); for (const registry of registries.splice(0)) registry.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(engine: FixtureEngine = "codex") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "central-service-")); roots.push(root);
  const filename = path.join(root, "registry.json");
  fs.writeFileSync(filename, JSON.stringify(fixtureRegistry(root, engine, captureProcessIdentity(process.pid), null)));
  const records = fixtureRecords(engine);
  const transcript = path.join(root, "native.jsonl");
  fs.writeFileSync(transcript, [...records.open, ...records.close].map(row => JSON.stringify(row)).join("\n") + "\n");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") }); registries.push(registry);
  let owns = true, clock = FIXTURE_NOW + 2000, publications = 0;
  const service = new AgentStateService({ registry, now: () => clock, owns: () => owns, process: observeAgentProcess,
    memory: () => null, release: "fixture", publish: async () => { publications++; return true; } });
  return { root, registry, service, transcript, entry: () => registry.hostEntry({ engine, sessionId: FIXTURE_SESSION })!,
    demote: () => { owns = false; }, advance: (ms: number) => { clock += ms; }, publications: () => publications };
}
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
