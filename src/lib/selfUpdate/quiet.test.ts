import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "@/lib/agent/registry";
import { productionLivenessSources } from "@/lib/lifecycle/liveness";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { bindStructuredDeliveryQueue, structuredDeliveryHostForConversation } from "@/lib/runtime/structuredDeliveryController";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeSession } from "@/lib/runtime/contracts";
import { turnEvidenceReader } from "./instance";
import { describeUpdateWait, launchHoldRefusal } from "./launchHold";
import { probeQuiet, currentHostTurnIdle, UNRESOLVED_TURN_GRACE_MS, type QuietPorts, type TurnEvidence } from "./quiet";
import type { Snapshot } from "./types";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;

/* The readings `agent_activity` gives, as the drain receives them. */
const LIVE_HOST = { state: "alive", processAlive: true } as const;
const GONE_HOST = { state: "gone", processAlive: false } as const;
const RUNNING: TurnEvidence = { record: { lifecycle: "running", reason: "host_alive_turn_active", turnState: "busy", host: { state: "alive" } }, registryHost: LIVE_HOST };
const SILENT_LIVE: TurnEvidence = { record: { lifecycle: "stalled", reason: "host_alive_transcript_silent", turnState: "busy", host: { state: "alive" } }, registryHost: LIVE_HOST };
const SETTLED_LIVE: TurnEvidence = { record: { lifecycle: "waiting", reason: "host_alive_turn_idle", turnState: "idle", host: { state: "alive" } }, registryHost: LIVE_HOST };
const STARTING: TurnEvidence = { record: { lifecycle: "starting", reason: "launch_unproven", turnState: "unknown", host: { state: "unknown" } }, registryHost: null };
const DEAD_OPEN: TurnEvidence = { record: { lifecycle: "stalled", reason: "host_gone_turn_open", turnState: "busy", host: { state: "gone" } }, registryHost: GONE_HOST };
const GONE_IDLE: TurnEvidence = { record: { lifecycle: "gone", reason: "host_gone_turn_settled", turnState: "idle", host: { state: "gone" } }, registryHost: GONE_HOST };
const UNRESOLVED: TurnEvidence = { record: null, registryHost: null };

function ports(turn = "idle", host = "hosted", cursor = "pending", ageMinutes = 11): QuietPorts {
  return {
    runtimeSnapshot: async () => ({ sessions: [{ turn, host }] }) as Awaited<ReturnType<QuietPorts["runtimeSnapshot"]>>,
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
  p.turnLiveness = async ({ conversationId: id }) => id.startsWith("conversation_work") ? RUNNING : id.endsWith("87") ? GONE_IDLE : DEAD_OPEN;
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
    p.turnLiveness = async () => { if (verdict === "throws") throw new Error("probe failed"); return verdict; };
    expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  }
  const p = ports();
  p.turnLiveness = async () => DEAD_OPEN;
  p.pipelines = () => ["running", "spawning", "committing"].map((state) => ({ id: state, task: "Finish work\nDetails", state: "running",
    cursor: { stageId: "build", state }, runs: [{ stageId: "build", attempts: [{ conversationId: "conversation_gone" }] }] })) as never;
  expect((await probeQuiet(snapshot, p, NOW)).blockers).toMatchObject({ stages: 2, stageList: [{ cursor: "spawning" }, { cursor: "committing" }] });
  // A settled turn under a dead host is the engine's to read: the stage has an outcome to collect,
  // for the stated bound. An open or unreadable turn with no process left releases it at once.
  p.turnLiveness = async () => GONE_IDLE;
  expect((await probeQuiet(snapshot, p, NOW)).blockers).toMatchObject({ stages: 3, settled: 1 });
  expect((await probeQuiet(snapshot, p, NOW + UNRESOLVED_TURN_GRACE_MS)).blockers).toMatchObject({ stages: 2, settled: 1 });
  p.turnLiveness = async () => ({ ...DEAD_OPEN, record: { ...DEAD_OPEN.record!, turnState: "unknown" } });
  expect((await probeQuiet(snapshot, p, NOW)).blockers).toMatchObject({ stages: 2, settled: 0 });
  // A headless reviewer its flow records keeps both, whatever the rest of the evidence says.
  p.runtimeSnapshot = async () => ({ sessions: [{ conversationId: "conversation_gone", turn: "running", host: "hosted" }] }) as never;
  p.turnLiveness = async () => ({ record: null, registryHost: GONE_HOST, headlessReviewerAlive: true });
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
  p.turnLiveness = async () => SILENT_LIVE;
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  // The row's status word says the host is gone while the process it records still answers.
  p.turnLiveness = async () => ({ ...DEAD_OPEN, registryHost: { state: "gone", processAlive: true } });
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  p.turnLiveness = async () => ({ record: null, registryHost: { state: "gone", processAlive: true } });
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
  p.turnLiveness = async () => ({ ...SETTLED_LIVE, currentTurnIdle: false });
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  // A settled transcript under a live process proves nothing until the host itself says it is idle.
  p.turnLiveness = async () => SETTLED_LIVE;
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  p.turnLiveness = async () => ({ ...SETTLED_LIVE, currentTurnIdle: true });
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(0);
});

test("a replacement host running a turn overrides the old process death", async () => {
  for (const evidence of [GONE_IDLE, DEAD_OPEN, { record: null, registryHost: GONE_HOST }]) {
    const p = ports("running");
    p.turnLiveness = async () => ({ ...evidence, currentTurnIdle: false });
    expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  }
});

test("dead host health does not veto proof of death; active replacement health does", async () => {
  for (const status of ["dead", "unhosted", "active"] as const) {
    const p = ports("running");
    p.turnLiveness = async () => ({ ...DEAD_OPEN, currentTurnIdle: currentHostTurnIdle({ status, activeTurnRef: null }) });
    expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(status === "active" ? 1 : 0);
  }
});


test.each(["unhosted", "dead", "conflict"])("a %s running journal row needs current liveness before discounting", async (host) => {
  for (const evidence of [RUNNING, STARTING, SETTLED_LIVE, SILENT_LIVE, UNRESOLVED, "throws"] as const) {
    const p = ports("running", host);
    let reads = 0;
    p.turnLiveness = async () => {
      reads++;
      if (evidence === "throws") throw new Error("unavailable");
      return evidence;
    };
    expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
    expect(reads).toBe(1);
    p.turnLiveness = async () => DEAD_OPEN;
    expect((await probeQuiet(snapshot, p, NOW)).quiet).toBe(true);
    p.turnLiveness = async () => ({ ...SETTLED_LIVE, currentTurnIdle: true });
    expect((await probeQuiet(snapshot, p, NOW)).quiet).toBe(true);
  }
});

test("a journal row nothing resolves is counted, blocks for its stated bound and then stops (#2515)", async () => {
  const p = ports("idle", "hosted", "pending");
  const rows = (ids: string[]) => async () => ({ sessions: ids.map((conversationId) => ({ conversationId, host: "hosted", turn: "running" })) }) as never;
  p.runtimeSnapshot = rows(["conversation_orphan", "conversation_work"]);
  p.turnLiveness = async ({ conversationId }) => conversationId === "conversation_work" ? RUNNING : UNRESOLVED;
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
  p.turnLiveness = async () => RUNNING;
  expect((await probeQuiet(snapshot, p, NOW + UNRESOLVED_TURN_GRACE_MS)).blockers).toMatchObject({ turns: 1, unresolved: 0 });
  p.turnLiveness = async () => UNRESOLVED;
  expect((await probeQuiet(snapshot, p, NOW + 2 * UNRESOLVED_TURN_GRACE_MS)).blockers).toMatchObject({ turns: 1, unresolvedBlocking: 1 });
  expect((await probeQuiet(snapshot, p, NOW + 3 * UNRESOLVED_TURN_GRACE_MS)).quiet).toBe(true);
});

test("a registry row with no transcript answers at once: gone releases, a young launch holds (#2515)", async () => {
  const p = ports("running");
  p.turnLiveness = async () => ({ record: null, registryHost: GONE_HOST });
  expect(await probeQuiet(snapshot, p, NOW)).toMatchObject({ quiet: true, blockers: { turns: 0, discounted: 1, unresolved: 0 } });
  p.turnLiveness = async () => ({ record: null, registryHost: { state: "unknown", processAlive: false } });
  expect((await probeQuiet(snapshot, p, NOW)).blockers).toMatchObject({ turns: 1, unresolved: 0 });
});

test("a refused launch names what the update waits for (#2515)", async () => {
  const p = ports("idle", "hosted", "running");
  p.runtimeSnapshot = async () => ({ sessions: ["a", "b"].map((id) => ({ conversationId: id, host: "hosted", turn: "running" })) }) as never;
  p.turnLiveness = async () => RUNNING;
  const busy = (await probeQuiet(snapshot, p, NOW, true)).blockers;
  expect(describeUpdateWait(busy)).toBe("2 running turns and 1 pipeline stage to finish");
  expect(launchHoldRefusal({ target: "a".repeat(40), since: "2026-01-01T00:00:00.000Z" }, busy)).toMatchObject({
    code: "launch_held_for_update", waitingFor: "2 running turns and 1 pipeline stage to finish", blockers: { turns: 2, stages: 1 },
    error: "new launches are held while the automatic update waits for 2 running turns and 1 pipeline stage to finish",
  });
  p.turnLiveness = async ({ conversationId }) => conversationId === "a" ? RUNNING : UNRESOLVED;
  p.pipelines = () => [];
  expect(describeUpdateWait((await probeQuiet(snapshot, p, NOW, true)).blockers))
    .toBe("2 running turns to finish (1 turn has no liveness record and stops counting within 5 minutes)");
  // Nothing live: the wait says so, and says what else holds the update.
  p.turnLiveness = async () => DEAD_OPEN;
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
    const production = turnEvidenceReader(() => ({ ...productionLivenessSources(),
      registrySnapshot: () => registry.readOnlySnapshot(), pipelines: () => [], flows: () => [] }));
    p.turnLiveness = async (session, probe) => {
      reads++;
      expect(structuredDeliveryHostForConversation(session.conversationId)).toBeNull();
      const evidence = await production(session, probe);
      // No transcript the scanner can describe, so the registry row alone answers: its process is alive.
      expect(evidence).toMatchObject({ record: null, registryHost: { state: "alive", processAlive: true }, currentTurnIdle: undefined });
      return evidence;
    };
    expect(await probeQuiet(snapshot, p, NOW)).toMatchObject({ quiet: false, blockers: { turns: 1, discounted: 0, unresolved: 0 } });
    expect(reads).toBe(1);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    rmSync(directory, { recursive: true, force: true });
  }
});
