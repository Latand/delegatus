import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "@/lib/agent/registry";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { conversationTurnLiveness } from "@/lib/runtime/liveness";
import { bindStructuredDeliveryQueue, structuredDeliveryHostForConversation } from "@/lib/runtime/structuredDeliveryController";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeSession } from "@/lib/runtime/contracts";
import { probeQuiet, currentHostTurnIdle, type QuietPorts } from "./quiet";
import type { Snapshot } from "./types";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;

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
  p.turnLiveness = async (id) => ({ state: id.startsWith("conversation_work") ? "working" : id.endsWith("87") ? "settled" : "severed", hostEvidence: { present: false, expected: { pid: 100, startIdentity: "gone", bootEpoch: null }, observedIdentity: null } });
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
  for (const verdict of ["unknown", "working", null, "throws"] as const) {
    const p = ports("running");
    p.turnLiveness = async () => { if (verdict === "throws") throw new Error("probe failed"); return verdict ? { state: verdict } : null; };
    expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  }
  const p = ports();
  p.turnLiveness = async () => ({ state: "severed", hostEvidence: { present: false, expected: { pid: 100, startIdentity: "gone", bootEpoch: null }, observedIdentity: null } });
  p.pipelines = () => ["running", "spawning", "committing"].map((state) => ({ id: state, task: "Finish work\nDetails", state: "running",
    cursor: { stageId: "build", state }, runs: [{ stageId: "build", attempts: [{ conversationId: "conversation_gone" }] }] })) as never;
  expect((await probeQuiet(snapshot, p, NOW)).blockers).toMatchObject({ stages: 2, stageList: [{ cursor: "spawning" }, { cursor: "committing" }] });
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
  p.turnLiveness = async () => ({ state: "severed", hostEvidence: { present: true, observedIdentity: "same", expected: { startIdentity: "same" } } }) as never;
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
  p.turnLiveness = async () => ({ state: "settled", currentTurnIdle: false,
    hostEvidence: { present: true, observedIdentity: "same", expected: { pid: 100, startIdentity: "same", bootEpoch: null } } });
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  p.turnLiveness = async () => ({ state: "settled", currentTurnIdle: true });
  expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(0);
});

test("a replacement host running a turn overrides the old process death", async () => {
  for (const state of ["settled", "severed"] as const) {
    const p = ports("running");
    p.turnLiveness = async () => ({ state, currentTurnIdle: false,
      hostEvidence: { present: false, expected: { pid: 100, startIdentity: "gone", bootEpoch: null }, observedIdentity: null } });
    expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
  }
});

test("dead host health does not veto proof of death; active replacement health does", async () => {
  for (const status of ["dead", "unhosted", "active"] as const) {
    const p = ports("running");
    p.turnLiveness = async () => ({ state: "severed", currentTurnIdle: currentHostTurnIdle({ status, activeTurnRef: null }),
      hostEvidence: { present: false, expected: { pid: 100, startIdentity: "gone", bootEpoch: null }, observedIdentity: null } });
    expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(status === "active" ? 1 : 0);
  }
});


test.each(["unhosted", "dead", "conflict"])("a %s running journal row needs current liveness before discounting", async (host) => {
  for (const state of ["working", "unknown", "settled", "severed", null, "throws"] as const) {
    const p = ports("running", host);
    let reads = 0;
    p.turnLiveness = async () => {
      reads++;
      if (state === "throws") throw new Error("unavailable");
      return state ? { state, currentTurnIdle: undefined,
        hostEvidence: { present: true, observedIdentity: "same", expected: { pid: 100, startIdentity: "same", bootEpoch: null } } } : null;
    };
    expect((await probeQuiet(snapshot, p, NOW)).blockers.turns).toBe(1);
    expect(reads).toBe(1);
    p.turnLiveness = async () => ({ state: "severed", currentTurnIdle: undefined,
      hostEvidence: { present: false, observedIdentity: null, expected: { pid: 100, startIdentity: "same", bootEpoch: null } } });
    expect((await probeQuiet(snapshot, p, NOW)).quiet).toBe(true);
    p.turnLiveness = async () => ({ state: "settled", currentTurnIdle: true });
    expect((await probeQuiet(snapshot, p, NOW)).quiet).toBe(true);
  }
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
    p.turnLiveness = async (id) => {
      reads++;
      const verdict = await conversationTurnLiveness(registry, id);
      const host = structuredDeliveryHostForConversation(id);
      expect(host).toBeNull();
      expect(verdict).toMatchObject({ state: "unknown", hostEvidence: { present: true } });
      return verdict ? { ...verdict, currentTurnIdle: currentHostTurnIdle(await host?.health()) } : null;
    };
    expect(await probeQuiet(snapshot, p, NOW)).toMatchObject({ quiet: false, blockers: { turns: 1, discounted: 0 } });
    expect(reads).toBe(1);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    rmSync(directory, { recursive: true, force: true });
  }
});
