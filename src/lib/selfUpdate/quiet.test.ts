import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "@/lib/agent/registry";
import { productionLivenessSources } from "@/lib/lifecycle/liveness";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { deepFreeze } from "@/lib/deepFreeze";
import { bindStructuredDeliveryQueue, structuredDeliveryHeldHosts } from "@/lib/runtime/structuredDeliveryController";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeSession } from "@/lib/runtime/contracts";
import { ownerCensusReader } from "./instance";
import { describeUpdateWait, launchHoldRefusal } from "./launchHold";
import { probeQuiet, registryAdmissionEvidence, sessionClaimsOpenTurn, UNRESOLVED_TURN_GRACE_MS, type OwnerlessReading, type OwnerReading, type QuietPorts, type TailReading } from "./quiet";
import type { Snapshot } from "./types";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;

/* What one conversation's own records say, as the drain's reader returns
   them (docs/design/update-drain-liveness.md, R7). A live host is judged on
   its handle, its row reference, its own writer's journal statement and its
   transcript; the fixture reads that statement off the row's labels, as the
   host's own publication would carry it. */
type Evidence = {
  owners?: Partial<OwnerReading>[];
  /** A row that claims a host and records no process. */
  ownerless?: true;
  /** The registry knows nothing the row names. */
  unresolved?: true;
  /** The reference's own transcript. */
  tail?: TailReading | null;
};
const busy = (lastRecordAt = NOW): TailReading => ({ turn: "busy", lastRecordAt });
const idle: TailReading = { turn: "idle", lastRecordAt: NOW };
const RUNNING: Evidence = { owners: [{ process: "alive", tail: busy() }], tail: busy() };
const SILENT_LIVE: Evidence = { owners: [{ process: "alive", tail: busy(NOW - 24 * 60 * 60_000) }], tail: busy(NOW - 24 * 60 * 60_000) };
const SETTLED_LIVE: Evidence = { owners: [{ process: "alive", tail: idle }], tail: idle };
const STARTING: Evidence = { ownerless: true, tail: null };
const DEAD_OPEN: Evidence = { owners: [{ process: "gone" }], tail: busy() };
const GONE_IDLE: Evidence = { owners: [{ process: "gone" }], tail: idle };
const UNRESOLVED: Evidence = { unresolved: true };
/** A host this Viewer holds for the conversation, reporting `turn`. */
const withHandle = (evidence: Evidence, turn: "busy" | "idle"): Evidence => ({ ...evidence,
  owners: evidence.owners?.some((owner) => owner.process === "alive")
    ? evidence.owners.map((owner) => owner.process === "alive" ? { ...owner, handle: turn } : owner)
    : [...evidence.owners ?? [], { process: "alive", handle: turn, tail: evidence.tail ?? null }] });

/** An owner census whose evidence `read` gives per conversation id. */
function census(read: (conversationId: string) => Evidence | "throws"): NonNullable<QuietPorts["owners"]> {
  return async (sessions) => {
    const built = new Map<string, { owners: OwnerReading[]; ownerless: OwnerlessReading[]; evidence: Evidence }>();
    const of = (conversationId: string) => {
      let held = built.get(conversationId);
      if (held) return held;
      const evidence = read(conversationId);
      if (evidence === "throws") throw new Error("probe failed");
      const row = sessions.find((session) => session.conversationId === conversationId);
      const place = { binding: conversationId, artifactPath: null, entryKey: null, engine: "codex", cwd: null };
      held = { evidence,
        owners: (evidence.owners ?? []).map((owner, index) => ({ ...place, id: `${conversationId}:${index}`, role: "host" as const, process: "alive" as const,
          journal: row && sessionClaimsOpenTurn(row) ? "claimed" as const : null, ...owner })),
        ownerless: evidence.ownerless ? [{ ...place, id: `${conversationId}:ownerless`, kind: "hosted-row" as const, updatedAt: NOW, tail: evidence.tail ?? null }] : [] };
      built.set(conversationId, held);
      return held;
    };
    for (const session of sessions) of(session.conversationId);
    const all = <T,>(pick: (held: { owners: OwnerReading[]; ownerless: OwnerlessReading[] }) => T[]) => [...built.values()].flatMap(pick);
    return {
      owners: all((held) => held.owners),
      ownerless: all((held) => held.ownerless),
      bound: (reference) => reference.conversationId ? [...of(reference.conversationId).owners, ...of(reference.conversationId).ownerless] : [],
      names: (reference) => !!reference.conversationId && !of(reference.conversationId).evidence.unresolved,
      tail: async (reference) => reference.conversationId ? of(reference.conversationId).evidence.tail ?? null : null,
    };
  };
}

function ports(turn = "idle", host = "hosted", cursor = "pending", ageMinutes = 11): QuietPorts {
  return {
    runtimeSnapshot: async () => ({ sessions: [{ conversationId: "conversation_fixture", turn, host, activeTurnId: null }] }) as Awaited<ReturnType<QuietPorts["runtimeSnapshot"]>>,
    owners: census(() => ["running", "interrupt_requested"].includes(turn) ? RUNNING : SETTLED_LIVE),
    pipelines: () => [{ state: "running", cursor: { state: cursor } }] as unknown as ReturnType<QuietPorts["pipelines"]>,
    presence: () => [{ lastInteractionAt: NOW - ageMinutes * 60_000 }] as unknown as ReturnType<QuietPorts["presence"]>,
    registryHealth: () => [],
  };
}

test("held review flows stop blocking deployment while admitted reviewers and relays remain blockers", async () => {
  const p = ports();
  p.pipelines = () => [{ id: "lane", state: "running", cursor: { stageId: "review", state: "reviewing" },
    runs: [{ stageId: "review", attempts: [{ flowId: "review-flow", conversationId: null }] }] }] as never;
  let state: "spawning" | "relaying" = "spawning";
  let started = false;
  let mode: "auto" | "manual" = "auto";
  const withFlows = { ...p, flows: () => [{ id: "review-flow", state, mode,
    rounds: [{ spawnStartedAt: state === "spawning" && started ? "started" : null,
      relayStartedAt: state === "relaying" && started ? "started" : null, relayedAt: null }] }] as never };
  for (state of ["spawning", "relaying"] as const) {
    expect((await probeQuiet(snapshot, withFlows, NOW, true)).quiet).toBe(true);
    expect((await probeQuiet(snapshot, withFlows, NOW, false)).quiet).toBe(false);
    started = true;
    expect((await probeQuiet(snapshot, withFlows, NOW, true)).quiet).toBe(false);
    started = false;
    mode = "manual";
    expect((await probeQuiet(snapshot, withFlows, NOW, true)).quiet).toBe(false);
    mode = "auto";
    withFlows.runtimeSnapshot = async () => ({ sessions: [{ conversationId: "operator-turn", host: "hosted", turn: "running" }] }) as never;
    expect((await probeQuiet(snapshot, withFlows, NOW, true)).quiet).toBe(false);
    withFlows.runtimeSnapshot = p.runtimeSnapshot;
  }
});

test("live turns and transitioning hosts block either restart", async () => {
  for (const turn of ["running", "interrupt_requested"]) expect((await probeQuiet(snapshot, ports(turn), NOW)).quiet).toBe(false);
  for (const host of ["registering", "recovering"]) expect((await probeQuiet(snapshot, ports("idle", host), NOW)).quiet).toBe(false);
  for (const host of ["hosted", "unhosted", "dead"]) expect((await probeQuiet(snapshot, ports("unknown", host), NOW)).quiet).toBe(true);
});

test("isolated record diagnostics remain visible without preventing the quiet update", async () => {
  const p = ports();
  p.registryHealth = () => [{ collection: "pipelines", id: "future-lane", reason: "unknown-but-preserved", detail: "unsupported role; preserved without execution" }];
  expect(await probeQuiet(snapshot, p, NOW)).toMatchObject({ quiet: true, blockers: { unreadable: null, registryIssues: [{ id: "future-lane" }] } });
  p.registryHealth = () => { throw new Error("corrupt pipelines SQLite row: broken-lane"); };
  expect(await probeQuiet(snapshot, p, NOW)).toMatchObject({ quiet: false, blockers: { unreadable: "corrupt pipelines SQLite row: broken-lane" } });
});

test("active pipeline stages and recent operator input block", async () => {
  for (const cursor of ["spawning", "running", "reviewing", "committing"]) expect((await probeQuiet(snapshot, ports("idle", "hosted", cursor), NOW)).blockers.stages).toBe(1);
  expect((await probeQuiet(snapshot, ports("idle", "hosted", "pending", 9), NOW)).quiet).toBe(false);
  expect((await probeQuiet(snapshot, ports("idle", "hosted", "pending", 11), NOW)).quiet).toBe(true);
});

test("an unreadable runtime snapshot fails closed", async () => {
  const p = ports();
  p.runtimeSnapshot = async () => { throw new Error("socket unavailable"); };
  expect(await probeQuiet(snapshot, p, NOW)).toMatchObject({ quiet: false, blockers: { unreadable: "socket unavailable" } });
});

test("89 stale journal turns are discounted and the four working turns are named", async () => {
  const p = ports();
  const stale = Array.from({ length: 89 }, (_, i) => ({ conversationId: `conversation_stale-${i}`, engine: "codex", cwd: null,
    host: i < 20 ? "unhosted" : i < 40 ? "dead" : i === 88 ? "registering" : "hosted", turn: "running" }));
  const live = Array.from({ length: 4 }, (_, i) => ({ conversationId: `conversation_work-${i}`, engine: "codex", cwd: null, host: "hosted", turn: "running" }));
  p.runtimeSnapshot = async () => ({ sessions: [...stale, ...live] }) as never;
  p.owners = census((id) => id.startsWith("conversation_work") ? RUNNING : id.endsWith("87") ? GONE_IDLE : DEAD_OPEN);
  const result = await probeQuiet(snapshot, p, NOW);
  expect(result.blockers).toMatchObject({ turns: 4, discounted: 89 });
  expect(result.blockers.turnList!.map((turn) => turn.conversationId)).toEqual(live.map((turn) => turn.conversationId));
});

test("a pending restart or a launcher still starting blocks; closed stages do not", async () => {
  const p = ports();
  p.pipelines = () => [{ state: "closed", cursor: { state: "running" } }] as unknown as ReturnType<QuietPorts["pipelines"]>;
  expect((await probeQuiet(snapshot, p, NOW)).quiet).toBe(true);
  expect((await probeQuiet({ ...snapshot, busy: "restart-web" }, p, NOW)).blockers.busy).toBe(true);
  expect((await probeQuiet({ ...snapshot, processes: { ...snapshot.processes, web: { ...snapshot.processes.web, state: "starting" } } }, p, NOW)).quiet).toBe(false);
});

test("uncertain liveness keeps turns counted, and only severed stages are discounted", async () => {
  for (const verdict of [STARTING, RUNNING, "throws"] as const) {
    const p = ports("running");
    p.owners = census(() => verdict);
    // A reading that throws is no verdict: it holds admission as unreadable (R7).
    const { blockers } = await probeQuiet(snapshot, p, NOW);
    expect(verdict === "throws" ? blockers.unreadable : blockers.turns).toBe(verdict === "throws" ? "probe failed" : 1);
  }
  const p = ports();
  p.owners = census(() => DEAD_OPEN);
  p.pipelines = () => ["running", "spawning", "committing"].map((state) => ({ id: state, task: "Finish work\nDetails", state: "running",
    cursor: { stageId: "build", state }, runs: [{ stageId: "build", attempts: [{ conversationId: "conversation_gone" }] }] })) as never;
  expect((await probeQuiet(snapshot, p, NOW)).blockers).toMatchObject({ stages: 2, stageList: [{ cursor: "spawning" }, { cursor: "committing" }] });
  // A settled turn under a dead host is the engine's to read: the stage has an outcome to collect,
  // for the stated bound. An open or unreadable turn with no process left releases it at once.
  p.owners = census(() => GONE_IDLE);
  expect((await probeQuiet(snapshot, p, NOW)).blockers).toMatchObject({ stages: 3, settled: 1 });
  expect((await probeQuiet(snapshot, p, NOW + UNRESOLVED_TURN_GRACE_MS)).blockers).toMatchObject({ stages: 2, settled: 1 });
  p.owners = census(() => ({ ...DEAD_OPEN, tail: { turn: "unknown", lastRecordAt: NOW } }));
  expect((await probeQuiet(snapshot, p, NOW)).blockers).toMatchObject({ stages: 2, settled: 0 });
  // A headless reviewer its flow records keeps both, whatever the rest of the evidence says.
  p.runtimeSnapshot = async () => ({ sessions: [{ conversationId: "conversation_gone", turn: "running", host: "hosted" }] }) as never;
  p.owners = census(() => ({ owners: [{ process: "gone" }, { role: "reviewer", process: "alive" }], tail: null }));
  expect((await probeQuiet(snapshot, p, NOW)).blockers).toMatchObject({ stages: 3, turns: 1 });
});

test("draining uses a two-minute operator window and names the busy process", async () => {
  const p = ports("idle", "hosted", "pending", 3);
  expect((await probeQuiet(snapshot, p, NOW)).quiet).toBe(false);
  expect((await probeQuiet(snapshot, p, NOW, true)).quiet).toBe(true);
  for (const [busy, reason] of [["update", "update"], ["restart-web", "web"], ["restart-runtime-host", "runtime-host"]] as const) {
    expect((await probeQuiet({ ...snapshot, busy }, p, NOW)).blockers.busyReason).toBe(reason);
  }
  p.controllerBusyReason = async () => "seat-tick";
  expect((await probeQuiet(snapshot, p, NOW)).blockers.busyReason).toBe("seat-tick");
});

test("a liveness-stalled process that still owns its pid blocks the update", async () => {
  const p = ports("running");
  p.owners = census(() => SILENT_LIVE);
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  // The row's status word says the host is gone while the process it records still answers.
  p.owners = census(() => ({ owners: [{ process: "alive", tail: busy() }], tail: busy() }));
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  p.owners = census(() => ({ owners: [{ process: "alive", tail: null }], tail: null }));
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
});

test("an undispatched held reservation cannot block its own drain", async () => {
  const p = ports();
  const attempt = { conversationId: null, launchId: null, activation: { phase: "reserved" } };
  p.pipelines = () => [{ id: "pipeline_reserved", state: "running", task: "Work", cursor: { stageId: "build", state: "spawning" },
    runs: [{ stageId: "build", attempts: [attempt] }] }] as never;
  expect((await probeQuiet(snapshot, p, NOW, true)).quiet).toBe(true);
  Object.assign(attempt.activation, { owner: { pid: 100 } });
  expect((await probeQuiet(snapshot, p, NOW, true)).blockers.stages).toBe(1);
});

test("a previous terminal transcript cannot hide a newly admitted turn", async () => {
  const p = ports("running");
  p.owners = census(() => withHandle(SETTLED_LIVE, "busy"));
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  // A settled transcript under a live process proves nothing until the host itself says it is idle.
  p.owners = census(() => SETTLED_LIVE);
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  p.owners = census(() => withHandle(SETTLED_LIVE, "idle"));
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(0);
});

test("a replacement host running a turn overrides the old process death", async () => {
  for (const evidence of [GONE_IDLE, DEAD_OPEN, { owners: [{ process: "gone" as const }], tail: null }]) {
    const p = ports("running");
    p.owners = census(() => withHandle(evidence, "busy"));
    expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  }
});

test("dead host health does not veto proof of death; active replacement health does", async () => {
  for (const status of ["dead", "unhosted", "active"] as const) {
    const p = ports("running");
    // A held host reporting `dead` or `unhosted` is no handle; an active one is an owner of its own.
    p.owners = census(() => status === "active" ? withHandle(DEAD_OPEN, "busy") : DEAD_OPEN);
    expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(status === "active" ? 1 : 0);
  }
});


test.each(["unhosted", "dead", "conflict"])("a %s running journal row needs current liveness before discounting", async (host) => {
  for (const evidence of [RUNNING, STARTING, SETTLED_LIVE, SILENT_LIVE, UNRESOLVED, "throws"] as const) {
    const p = ports("running", host);
    let reads = 0;
    p.owners = census(() => { reads++; return evidence; });
    const { blockers } = await probeQuiet(snapshot, p, NOW);
    // A reading that throws is no verdict: it holds admission as unreadable (R7).
    expect(evidence === "throws" ? blockers.unreadable : blockers.turns).toBe(evidence === "throws" ? "probe failed" : 1);
    expect(reads).toBe(1);
    p.owners = census(() => DEAD_OPEN);
    expect((await probeQuiet(snapshot, p, NOW)).quiet).toBe(true);
    p.owners = census(() => withHandle(SETTLED_LIVE, "idle"));
    expect((await probeQuiet(snapshot, p, NOW)).quiet).toBe(true);
  }
});

test("a journal row nothing resolves is counted, blocks for its stated bound and then stops (#2515)", async () => {
  const p = ports("idle", "hosted", "pending");
  const rows = (ids: string[]) => async () => ({ sessions: ids.map((conversationId) => ({ conversationId, host: "hosted", turn: "running" })) }) as never;
  p.runtimeSnapshot = rows(["conversation_orphan", "conversation_work"]);
  p.owners = census((conversationId) => conversationId === "conversation_work" ? RUNNING : UNRESOLVED);
  const first = await probeQuiet(snapshot, p, NOW);
  expect(first.blockers).toMatchObject({ turns: 2, unresolved: 1, unresolvedBlocking: 1, unresolvedGraceMs: UNRESOLVED_TURN_GRACE_MS, discounted: 0 });
  expect(first.blockers.turnList).toEqual([
    expect.objectContaining({ conversationId: "conversation_orphan", unresolved: true }),
    expect.not.objectContaining({ unresolved: true }),
  ]);
  const inside = await probeQuiet(snapshot, p, NOW + UNRESOLVED_TURN_GRACE_MS - 1);
  expect(inside.blockers).toMatchObject({ turns: 2, unresolved: 1, unresolvedBlocking: 1 });
  // Past the bound the row is still shown as a number and holds nothing; the running turn still does.
  const past = await probeQuiet(snapshot, p, NOW + UNRESOLVED_TURN_GRACE_MS);
  expect(past.blockers).toMatchObject({ turns: 1, unresolved: 1, unresolvedBlocking: 0 });
  expect(past.blockers.turnList!.map((turn) => turn.conversationId)).toEqual(["conversation_work"]);
  p.runtimeSnapshot = rows(["conversation_orphan"]);
  expect(await probeQuiet(snapshot, p, NOW + UNRESOLVED_TURN_GRACE_MS)).toMatchObject({ quiet: true, blockers: { turns: 0, unresolved: 1 } });
  // A row that resolved and comes back unresolved later is a new observation with a new bound.
  p.owners = census(() => RUNNING);
  expect((await probeQuiet(snapshot, p, NOW + UNRESOLVED_TURN_GRACE_MS)).blockers).toMatchObject({ turns: 1, unresolved: 0 });
  p.owners = census(() => UNRESOLVED);
  expect((await probeQuiet(snapshot, p, NOW + 2 * UNRESOLVED_TURN_GRACE_MS)).blockers).toMatchObject({ turns: 1, unresolvedBlocking: 1 });
  expect((await probeQuiet(snapshot, p, NOW + 3 * UNRESOLVED_TURN_GRACE_MS)).quiet).toBe(true);
});

test("a registry row with no transcript answers at once: gone releases, a young launch holds (#2515)", async () => {
  const p = ports("running");
  p.owners = census(() => ({ owners: [{ process: "gone" }], tail: null }));
  expect(await probeQuiet(snapshot, p, NOW)).toMatchObject({ quiet: true, blockers: { turns: 0, discounted: 1, unresolved: 0 } });
  // A hosted row with no process inside its launch grace is an ownerless
  // record: it holds, and is counted as what nothing can yet answer for (R8).
  p.owners = census(() => STARTING);
  expect((await probeQuiet(snapshot, p, NOW)).blockers).toMatchObject({ turns: 1, unresolved: 1, unresolvedBlocking: 1 });
});

test("a refused launch names what the update waits for (#2515)", async () => {
  const p = ports("idle", "hosted", "running");
  p.runtimeSnapshot = async () => ({ sessions: ["a", "b"].map((id) => ({ conversationId: id, host: "hosted", turn: "running" })) }) as never;
  p.owners = census(() => RUNNING);
  const waiting = (await probeQuiet(snapshot, p, NOW, true)).blockers;
  expect(describeUpdateWait(waiting)).toBe("2 running turns and 1 pipeline stage to finish");
  expect(launchHoldRefusal({ target: "a".repeat(40), since: "2026-01-01T00:00:00.000Z" }, waiting)).toMatchObject({
    code: "launch_held_for_update", waitingFor: "2 running turns and 1 pipeline stage to finish", blockers: { turns: 2, stages: 1 },
    error: "new launches are held while the automatic update waits for 2 running turns and 1 pipeline stage to finish",
  });
  p.owners = census((conversationId) => conversationId === "a" ? RUNNING : UNRESOLVED);
  p.pipelines = () => [];
  expect(describeUpdateWait((await probeQuiet(snapshot, p, NOW, true)).blockers))
    .toBe("2 running turns to finish (1 turn has no liveness record and stops counting within 5 minutes)");
  // Nothing live: the wait says so, and says what else holds the update.
  p.owners = census(() => DEAD_OPEN);
  expect(describeUpdateWait((await probeQuiet(snapshot, p, NOW, true)).blockers)).toBe("one quiet minute before it starts; no turn or stage is running");
  p.presence = () => [{ lastInteractionAt: NOW - 30_000 }] as never;
  p.memoryAvailableMb = () => 1_024;
  expect(describeUpdateWait((await probeQuiet(snapshot, p, NOW, true)).blockers))
    .toBe("the operator to be inactive for 2 minutes and free memory to reach 4096 MB (1024 MB now); no turn or stage is running");
  expect(describeUpdateWait(null)).toBe("its first reading of what is running");
});


test("production fallback projection keeps a live registry process without an attached controller blocking", async () => {
  const directory = mkdtempSync("/var/tmp/quiet-fallback-");
  const artifactPath = join(directory, `${randomUUID()}.jsonl`);
  writeFileSync(artifactPath, ""); // Unreadable turn evidence cannot prove the live process idle.
  const registry = new AgentRegistry(join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = registry.ensureConversation("codex", artifactPath, "fixture");
  const key = { engine: "codex" as const, sessionId: conversation.generations[0]!.id };
  registry.upsert({ key, artifactPath, cwd: directory, accountId: "fixture", status: "live", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: null,
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:fixture", process: captureProcessIdentity(process.pid),
      eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
  const sessions: RuntimeSession[] = [];
  const client = {
    snapshot: async () => ({ filesRevision: 0, sessions }),
    append: async (event: { kind: string; payload: RuntimeSession }) => {
      if (event.kind === "session-status") sessions.push(event.payload);
    },
    effectBatch: async () => [],
    operationStatus: async () => null,
  } as unknown as RuntimeHostClient;
  try {
    await bindStructuredDeliveryQueue([], { registry, client });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ conversationId: conversation.id, host: "unhosted", turn: "running" });
    let reads = 0;
    const p = ports();
    p.runtimeSnapshot = async () => ({ sessions });
    const production = ownerCensusReader(() => ({ ...productionLivenessSources(),
      registrySnapshot: () => registry.readOnlySnapshot(), pipelines: () => [], flows: () => [] }), { readSession: async () => null });
    p.owners = async (rows, probe) => {
      reads++;
      expect(structuredDeliveryHeldHosts().size).toBe(0);
      const read = await production(rows, probe);
      // The copy names no writer and the transcript says nothing, so the live
      // process is unknown: held, counted, and bounded (R5, R8).
      expect(read.owners).toMatchObject([{ role: "host", process: "alive", handle: null, rowReference: false, journal: null, tail: { turn: "unknown" } }]);
      return read;
    };
    expect(await probeQuiet(snapshot, p, NOW)).toMatchObject({ quiet: false, blockers: { turns: 1, discounted: 0, unresolved: 1,
      turnList: [{ conversationId: conversation.id, reason: "turn-unread", unresolved: true }] } });
    expect(reads).toBe(1);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the dispatch version's registry evidence only reads the shared view and sees the next write", () => {
  const directory = mkdtempSync("/var/tmp/quiet-admission-evidence-");
  const registry = new AgentRegistry(join(directory, "registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  try {
    const conversation = registry.ensureConversation("codex", join(directory, "admitted.jsonl"), "fixture");
    const artifactPath = conversation.generations[0]!.path;
    registry.upsert({ key: { engine: "codex", sessionId: conversation.generations[0]!.id }, artifactPath, cwd: directory, accountId: "fixture",
      status: "live", host: null, claimEpoch: 3, claimOwner: null, pendingAction: null, structuredHost: null });
    registry.beginSpawn("codex", directory, { title: "Admitted spawn" });
    const shared = registry.readOnlySnapshot();
    const before = JSON.stringify(shared);
    /* Frozen all the way down: a write anywhere in the evidence would throw. */
    const evidence = registryAdmissionEvidence(deepFreeze(structuredClone(registry.snapshot())));
    expect(registryAdmissionEvidence(shared)).toEqual(evidence);
    expect(evidence[0][0]).toEqual([[`codex:${conversation.generations[0]!.id}`, 3, null]]);
    expect(evidence[1]).toHaveLength(1);
    expect(registry.readOnlySnapshot()).toBe(shared);
    expect(JSON.stringify(registry.readOnlySnapshot())).toBe(before);

    registry.beginSpawn("codex", directory, { title: "Admitted later" });
    expect(registryAdmissionEvidence(registry.readOnlySnapshot())[1]).toHaveLength(2);
  } finally {
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
