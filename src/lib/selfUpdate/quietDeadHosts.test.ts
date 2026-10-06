/* #2515 at the production seam: the drain's own liveness wiring
   (`productionDeps().quiet.turnLiveness`), a real registry whose rows are ended
   by the registry's own writers, and real transcripts under a scanner root.
   Only what the Viewer reads from other processes is replaced: the journal's
   session rows, the pipelines, and the operator's presence. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { AgentRegistry, setAgentRegistryForTests, type ProcessIdentity } from "@/lib/agent/registry";
import { newRound, reserveReviewerSpawn } from "@/lib/flows/engine";
import { loadFlows, saveFlows } from "@/lib/flows/store";
import { agentLivenessSnapshot, productionLivenessSources } from "@/lib/lifecycle/liveness";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { bindStructuredDeliveryQueue, publishStructuredDeliveryHost } from "@/lib/runtime/structuredDeliveryController";
import { FakeEngineHost } from "@/lib/runtime/fixtures/fakeEngineHost";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { RuntimeJournal } from "../../runtime-host/journal";

import { productionDeps, turnEvidenceReader } from "./instance";
import { probeQuiet, type QuietPorts } from "./quiet";
import type { Snapshot } from "./types";

const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;
const FIVE_MINUTES = 5 * 60_000;

let directory: string;
let registry: AgentRegistry;
let deadProcess: ProcessIdentity;
let previousCodexHome: string | undefined;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "quiet-dead-hosts-"));
  /* The legacy Codex home is a scanner root, so `agent_activity` can describe
     the transcripts below exactly as it describes real ones. */
  previousCodexHome = process.env.LLV_CODEX_HOME;
  process.env.LLV_CODEX_HOME = join(directory, "codex-home");
  mkdirSync(join(process.env.LLV_CODEX_HOME, "sessions", "2026", "01", "01"), { recursive: true });
  registry = new AgentRegistry(join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
  /* A process identity that was real and is gone. */
  const child = Bun.spawn(["sleep", "30"]);
  const identity = captureProcessIdentity(child.pid);
  child.kill();
  await child.exited;
  if (!identity) throw new Error("the fixture process left no identity");
  deadProcess = identity;
});

afterAll(() => {
  setAgentRegistryForTests(null);
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  rmSync(directory, { recursive: true, force: true });
});

function transcript(turn: "open" | "settled" | "none"): string {
  const id = randomUUID();
  const file = join(process.env.LLV_CODEX_HOME!, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  const at = new Date().toISOString();
  const event = (type: string) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type } });
  writeFileSync(file, turn === "none" ? "" : [
    JSON.stringify({ timestamp: at, type: "session_meta", payload: { id, cwd: directory } }),
    event("task_started"),
    event("user_message"),
    ...(turn === "settled" ? [event("task_complete")] : []),
  ].join("\n") + "\n");
  return file;
}

/** A structured conversation hosted by `process`, as a launch leaves it. */
function hosted(turn: "open" | "settled", process: ProcessIdentity) {
  const artifactPath = transcript(turn);
  const conversation = registry.ensureConversation("codex", artifactPath, "fixture");
  const key = { engine: "codex" as const, sessionId: conversation.generations[0]!.id };
  registry.upsert({ key, artifactPath, cwd: directory, accountId: "fixture", status: turn === "open" ? "live" : "idle", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: null,
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:fixture", process,
      eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: null, pendingAttention: [], activeFlags: [] } });
  return { conversation, key, artifactPath };
}

/** The same conversation after its host died and the registry ended the row. */
function ended(turn: "open" | "settled") {
  const fixture = hosted(turn, deadProcess);
  expect(registry.terminateInactiveStructuredHost(fixture.conversation.id, fixture.key)).toBe("current");
  expect(registry.readOnlySnapshot().entries[`codex:${fixture.key.sessionId}`]).toMatchObject({ status: "dead", structuredHost: null });
  return fixture;
}

function ports(sessions: unknown[], pipelines: unknown[] = []): QuietPorts {
  return { ...productionDeps({ ...process.env }).quiet!,
    runtimeSnapshot: async () => ({ sessions }) as never,
    pipelines: () => pipelines as never,
    flows: () => [], seats: () => [], presence: () => [], registryHealth: () => [],
    controllerBusyReason: async () => null, memoryAvailableMb: () => 8_192 };
}

/** What `agent_activity` answers for one conversation, through its own read. */
async function agentActivity(conversationId: string) {
  return (await agentLivenessSnapshot({ conversationId, limit: 1 }, productionLivenessSources())).conversations;
}

const row = (fixture: { conversation: { id: string }; artifactPath: string }, host: string, turn = "running") =>
  ({ conversationId: fixture.conversation.id, sessionKey: { engine: "codex" }, cwd: null, artifactPath: fixture.artifactPath, host, turn, activeTurnId: "turn" });

test("a conversation whose host died with its turn open does not block the drain", async () => {
  const dead = ended("open");
  expect(await agentActivity(dead.conversation.id)).toMatchObject([{ lifecycle: "stalled", reason: "host_gone_turn_open", turnState: "busy", host: { state: "gone" } }]);
  const result = await probeQuiet(snapshot, ports([row(dead, "hosted")]), Date.now(), true);
  expect(result).toMatchObject({ quiet: true, blockers: { turns: 0, turnList: [], discounted: 1 } });
});

test("a conversation whose host is gone and whose turn settled does not block the drain", async () => {
  const gone = ended("settled");
  expect(await agentActivity(gone.conversation.id)).toMatchObject([{ lifecycle: "gone", turnState: "idle", host: { state: "gone" } }]);
  const result = await probeQuiet(snapshot, ports([row(gone, "unhosted")]), Date.now(), true);
  expect(result).toMatchObject({ quiet: true, blockers: { turns: 0, turnList: [], discounted: 1 } });
});

test("a dead host is discounted whether or not its registry row was ended", async () => {
  /* The row a startup leaves exactly as it was: still `live`, its process gone. */
  const stale = hosted("open", deadProcess);
  /* A transcript the scanner cannot read leaves the registry row as the only evidence. */
  const unreadable = ended("open");
  rmSync(unreadable.artifactPath);
  expect(await agentActivity(stale.conversation.id)).toMatchObject([{ lifecycle: "stalled", reason: "host_gone_turn_open" }]);
  expect(await agentActivity(unreadable.conversation.id)).toEqual([]);
  const result = await probeQuiet(snapshot, ports([row(stale, "unhosted"), row(unreadable, "hosted"), row(unreadable, "registering", "unknown")]), Date.now(), true);
  expect(result).toMatchObject({ quiet: true, blockers: { turns: 0, discounted: 3 } });
});

test("an id nothing resolves stops blocking after five minutes and stays counted", async () => {
  const orphan = { conversationId: `conversation_${randomUUID()}`, sessionKey: { engine: "claude" }, cwd: null, artifactPath: null, host: "hosted", turn: "running", activeTurnId: "turn" };
  expect(await agentActivity(orphan.conversationId)).toEqual([]);
  const p = ports([orphan]);
  const now = Date.now();
  expect(await probeQuiet(snapshot, p, now, true)).toMatchObject({ quiet: false, blockers: { turns: 1, turnList: [{ conversationId: orphan.conversationId }] } });
  expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES - 1, true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
  const past = await probeQuiet(snapshot, p, now + FIVE_MINUTES, true);
  expect(past).toMatchObject({ quiet: true, blockers: { turns: 0, turnList: [], unresolved: 1 } });
});

test("a turn that is really running and a stage that is really running still block", async () => {
  const live = hosted("open", captureProcessIdentity(process.pid)!);
  const dead = ended("open");
  expect(await agentActivity(live.conversation.id)).toMatchObject([{ lifecycle: "running", turnState: "busy", host: { state: "alive" } }]);
  const stage = (id: string, conversationId: string) => ({ id, task: "Finish the work", state: "running",
    cursor: { stageId: "build", state: "running" }, runs: [{ stageId: "build", attempts: [{ conversationId }] }] });
  const p = ports([row(live, "hosted"), row(dead, "hosted")], [stage("lane_live", live.conversation.id), stage("lane_dead", dead.conversation.id)]);
  const now = Date.now();
  for (const at of [now, now + FIVE_MINUTES, now + 12 * 60 * 60_000]) {
    const result = await probeQuiet(snapshot, p, at, true);
    expect(result.quiet).toBe(false);
    expect(result.blockers).toMatchObject({ turns: 1, stages: 1, discounted: 1,
      turnList: [{ conversationId: live.conversation.id, stage: { pipelineId: "lane_live", stageId: "build" } }],
      stageList: [{ pipelineId: "lane_live", conversationId: live.conversation.id }] });
  }
});

const lane = (id: string, cursor: "running" | "reviewing", attempt: Record<string, unknown>) => ({ id, task: "Finish the work", state: "running",
  cursor: { stageId: "stage", state: cursor }, runs: [{ stageId: "stage", attempts: [attempt] }] });

test("a stage whose conversation nothing resolves stops blocking after five minutes and stays counted", async () => {
  const orphan = { conversationId: `conversation_${randomUUID()}`, sessionKey: { engine: "codex" }, cwd: null, artifactPath: null, host: "hosted", turn: "running", activeTurnId: "turn" };
  const now = Date.now();
  /* With its journal row, and with the row gone: the stage alone names the id. */
  for (const sessions of [[orphan], []]) {
    const p = ports(sessions, [lane("lane_orphan", "running", { conversationId: orphan.conversationId })]);
    expect(await probeQuiet(snapshot, p, now, true)).toMatchObject({ quiet: false, blockers: { turns: sessions.length, stages: 1, unresolved: 1, unresolvedBlocking: 1 } });
    expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES - 1, true)).toMatchObject({ quiet: false, blockers: { stages: 1, unresolvedBlocking: 1 } });
    expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES, true)).toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0, unresolved: 1, unresolvedBlocking: 0 } });
  }
});

test("a dead host whose transcript was deleted releases its running stage", async () => {
  const dead = ended("open");
  rmSync(dead.artifactPath);
  expect(await agentActivity(dead.conversation.id)).toEqual([]);
  const p = ports([row(dead, "hosted")], [lane("lane_deleted", "running", { conversationId: dead.conversation.id, agentPath: dead.artifactPath })]);
  expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0, discounted: 1, unresolved: 0 } });
});

test("a process the row still records keeps its turn and stage under a dead status and no transcript", async () => {
  const live = hosted("open", captureProcessIdentity(process.pid)!);
  registry.upsert({ ...registry.readOnlySnapshot().entries[`codex:${live.key.sessionId}`]!, status: "dead" });
  rmSync(live.artifactPath);
  const p = ports([row(live, "unhosted")], [lane("lane_lagging", "running", { conversationId: live.conversation.id, agentPath: live.artifactPath })]);
  expect(await probeQuiet(snapshot, p, Date.now() + 12 * 60 * 60_000, true)).toMatchObject({ quiet: false, blockers: { turns: 1, stages: 1 } });
});

/** A stored review flow whose newest round is `round`, read back through the flow store. */
function reviewFlow(id: string, implementerPath: string, state: string, round: Record<string, unknown>): void {
  const at = new Date().toISOString();
  saveFlows([{ id, template: "implement-review-loop", project: "fixture", cwd: directory, implementerPath,
    roles: { implementer: { engine: "codex", model: null, effort: null }, reviewer: { engine: "codex", model: null, effort: null } },
    baseRef: "a".repeat(40), baseMode: "head", mode: "auto", reviewerMode: "headless", roundLimit: 3, state, stateDetail: null, createdAt: at, closedAt: null,
    rounds: [{ n: 2, reviewerPath: null, findingsPath: null, triggeredBy: "button", readyNote: null, verdict: null, findingsCount: null,
      startedAt: at, error: null, ...round }] }] as never);
}

test("a review stage still bound to the ended previous reviewer is held by its flow's new round", async () => {
  const previous = ended("open");
  const self = captureProcessIdentity(process.pid)!;
  const reviewer = hosted("open", self);
  const at = new Date().toISOString();
  const stage = lane("lane_review", "reviewing", { conversationId: previous.conversation.id, agentPath: previous.artifactPath, flowId: "flow_rebound", launchId: "previous-launch" });
  const p = { ...ports([row(previous, "hosted")], [stage]), flows: loadFlows };
  try {
    /* The new round names its reviewer and that reviewer's process answers. */
    reviewFlow("flow_rebound", previous.artifactPath, "reviewing", { reviewerPath: reviewer.artifactPath, reviewerConversationId: reviewer.conversation.id,
      reviewerPid: self.pid, reviewerIdentity: self.startIdentity, sessionId: reviewer.key.sessionId, launchId: "new-launch", spawnStartedAt: at });
    expect(await agentActivity(reviewer.conversation.id)).toMatchObject([{ host: { state: "alive" }, turnState: "busy" }]);
    for (const draining of [true, false]) {
      expect(await probeQuiet(snapshot, p, Date.now(), draining)).toMatchObject({ quiet: false,
        blockers: { turns: 0, stages: 1, discounted: 1, stageList: [{ pipelineId: "lane_review", conversationId: previous.conversation.id }] } });
    }
    /* A launch that has started and names no conversation yet cannot be proven dead. */
    reviewFlow("flow_rebound", previous.artifactPath, "spawning", { launchId: "new-launch", spawnStartedAt: at });
    expect(await probeQuiet(snapshot, p, Date.now() + 12 * 60 * 60_000, true)).toMatchObject({ quiet: false, blockers: { stages: 1 } });
    /* The new round's reviewer died too: nothing is left to finish the stage. */
    const second = ended("open");
    reviewFlow("flow_rebound", previous.artifactPath, "reviewing", { reviewerPath: second.artifactPath, reviewerConversationId: second.conversation.id, launchId: "new-launch", spawnStartedAt: at });
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
    /* No round is running: the dead previous reviewer alone decides. */
    reviewFlow("flow_rebound", previous.artifactPath, "reviewing", { reviewerPath: previous.artifactPath, reviewerConversationId: previous.conversation.id, launchId: "previous-launch", spawnStartedAt: at });
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { stages: 0, discounted: 1 } });
    reviewFlow("flow_rebound", previous.artifactPath, "needs_decision", { launchId: "new-launch", spawnStartedAt: at });
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
  } finally { saveFlows([]); }
});

/** A journal that holds `rows` as open sessions, read back as the runtime host serves them. */
function journalOf<T extends { conversationId: string; sessionKey: unknown }>(name: string, rows: T[]): RuntimeJournal {
  const journal = new RuntimeJournal(join(directory, `${name}.sqlite`), { structuredHosts: true });
  for (const row of rows) {
    journal.append({ scope: { type: "session", id: row.conversationId }, kind: "session-status",
      producer: { kind: "codex-app-server", eventKey: `${name}-${row.conversationId}` }, payload: row } as never);
  }
  return journal;
}

test("a headless reviewer whose transcript is gone still holds its stage while its process answers", async () => {
  const previous = ended("open");
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  const reviewerPath = transcript("open");
  /* Reserved and settled as `launchReviewer` does it: the process is written to the flow round only. */
  reviewFlow("flow_headless", previous.artifactPath, "reviewing", {});
  const flow = loadFlows()[0]!;
  flow.implementerConversationId = previous.conversation.id;
  const begun = reserveReviewerSpawn(flow, newRound(flow, "button", null), flow.roles.reviewer, "fixture", registry);
  const settled = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId: randomUUID() }, artifactPath: reviewerPath,
    cwd: directory, accountId: "fixture", status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
  if (settled.kind === "conflict") throw new Error(settled.code);
  expect(settled.entry).toMatchObject({ status: "starting", host: null, pendingAction: "spawn" });
  const round = (reviewerIdentity: string | null) => reviewFlow("flow_headless", previous.artifactPath, "reviewing", { reviewerPath,
    reviewerConversationId: settled.conversation.id, reviewerPid: identity.pid, reviewerIdentity, sessionId: settled.entry.key.sessionId,
    launchId: begun.receipt.launchId, spawnStartedAt: new Date().toISOString() });
  round(identity.startIdentity);
  /* The launch marker, aged past its grace: the registry alone now reads the reviewer as gone. */
  const disk = JSON.parse(readFileSync(registry.filename, "utf8"));
  disk.entries[`codex:${settled.entry.key.sessionId}`].updatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(registry.filename, JSON.stringify(disk));
  const journal = journalOf("headless", [{ ...row(previous, "hosted"), sessionKey: previous.key }]);
  const p = { ...ports([], [lane("lane_headless", "reviewing", { conversationId: previous.conversation.id, agentPath: previous.artifactPath, flowId: "flow_headless" })]),
    flows: loadFlows, runtimeSnapshot: async () => journal.snapshot() };
  try {
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: false, blockers: { stages: 1 } });
    rmSync(reviewerPath);
    expect(await agentActivity(settled.conversation.id)).toEqual([]);
    for (const at of [Date.now(), Date.now() + 12 * 60 * 60_000]) {
      expect(await probeQuiet(snapshot, p, at, true)).toMatchObject({ quiet: false, blockers: { stages: 1, stageList: [{ pipelineId: "lane_headless" }] } });
    }
    /* Another process under the same pid holds nothing, and neither does an exited one. */
    round(`${identity.startIdentity}-other`);
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
    round(identity.startIdentity);
    child.kill();
    await child.exited;
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
  } finally { saveFlows([]); journal.close(); child.kill(); await child.exited; }
});

test("a transcript no registry row ever hosted releases its stage once it has aged out of the launch grace", async () => {
  const path = transcript("open");
  const old = new Date(Date.now() - 24 * 60 * 60_000);
  writeFileSync(path, [
    JSON.stringify({ timestamp: old.toISOString(), type: "session_meta", payload: { id: randomUUID(), cwd: directory } }),
    JSON.stringify({ timestamp: old.toISOString(), type: "event_msg", payload: { type: "task_started" } }),
  ].join("\n") + "\n");
  utimesSync(path, old, old);
  const orphan = { conversationId: `conversation_${randomUUID()}`, artifactPath: path, sessionKey: { engine: "codex", sessionId: "orphan-session" }, host: "hosted", turn: "running" };
  const journal = journalOf("orphan", [orphan]);
  const p = { ...ports([], [lane("lane_orphan_transcript", "running", { conversationId: orphan.conversationId, agentPath: path })]), runtimeSnapshot: async () => journal.snapshot() };
  try {
    expect(await p.turnLiveness!(orphan, {})).toMatchObject({ record: { reason: "launch_unproven_expired", host: { state: "unknown" } }, registryHost: null });
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0, discounted: 1 } });
  } finally { journal.close(); }
});

test("a dead host whose transcript shows no turn state releases its stage", async () => {
  const dead = ended("open");
  writeFileSync(dead.artifactPath, JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: dead.key.sessionId, cwd: directory } }) + "\n");
  const p = ports([row(dead, "hosted")], [lane("lane_unknown_turn", "running", { conversationId: dead.conversation.id, agentPath: dead.artifactPath })]);
  expect(await p.turnLiveness!({ conversationId: dead.conversation.id, artifactPath: dead.artifactPath }, {}))
    .toMatchObject({ record: { host: { state: "gone" }, turnState: "unknown" }, registryHost: { state: "gone", processAlive: false } });
  expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0, discounted: 1 } });
});

test("a stage whose dead host settled its turn holds for the bound, then stays counted", async () => {
  const gone = ended("settled");
  const p = ports([], [lane("lane_settled", "running", { conversationId: gone.conversation.id, agentPath: gone.artifactPath })]);
  const now = Date.now();
  expect(await probeQuiet(snapshot, p, now, true)).toMatchObject({ quiet: false, blockers: { stages: 1, settled: 1, unresolved: 0 } });
  expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES - 1, true)).toMatchObject({ quiet: false, blockers: { stages: 1, settled: 1 } });
  expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES, true)).toMatchObject({ quiet: true, blockers: { stages: 0, settled: 1 } });
});

test("a review round that names no conversation is held by the process it records, and released once that process is proven gone", async () => {
  const previous = ended("open");
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  /* A stored headless round with no binding yet, its launch marker twelve hours old. */
  const round = (reviewerPid: number | null, reviewerIdentity: string | null) => reviewFlow("flow_unbound", previous.artifactPath, "reviewing", {
    reviewerConversationId: null, reviewerPath: null, reviewerPid, reviewerIdentity, launchId: "unbound-launch",
    spawnStartedAt: new Date(Date.now() - 12 * 60 * 60_000).toISOString() });
  const journal = journalOf("unbound", [{ ...row(previous, "hosted"), sessionKey: previous.key }]);
  const p = { ...ports([], [lane("lane_unbound", "reviewing", { conversationId: previous.conversation.id, agentPath: previous.artifactPath, flowId: "flow_unbound" })]),
    flows: loadFlows, runtimeSnapshot: async () => journal.snapshot() };
  const held = { quiet: false, blockers: { stages: 1, stageList: [{ pipelineId: "lane_unbound" }] } };
  const released = { quiet: true, blockers: { turns: 0, stages: 0, unresolved: 0 } };
  try {
    round(identity.pid, identity.startIdentity);
    for (const at of [Date.now(), Date.now() + 12 * 60 * 60_000]) expect(await probeQuiet(snapshot, p, at, true)).toMatchObject(held);
    /* A launch that records no process yet, and a pid whose start identity was never saved, prove nothing. */
    round(null, null);
    expect(await probeQuiet(snapshot, p, Date.now() + 12 * 60 * 60_000, true)).toMatchObject(held);
    round(identity.pid, null);
    expect(await probeQuiet(snapshot, p, Date.now() + 12 * 60 * 60_000, true)).toMatchObject(held);
    /* Another process under the same pid owns nothing here. */
    round(identity.pid, `${identity.startIdentity}-other`);
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject(released);
    round(identity.pid, identity.startIdentity);
    child.kill();
    await child.exited;
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject(released);
    round(deadProcess.pid, deadProcess.startIdentity);
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject(released);
  } finally { saveFlows([]); journal.close(); child.kill(); await child.exited; }
});

// Independent identity-read and incomplete-binding attacks.
for (const missingIdentity of [false, true]) {
 test(`attack: a bound live headless round preserves its stage when identity ${missingIdentity ? 'was not saved' : 'cannot be read'}`, async () => {
  const previous = ended("open");
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  const reviewerPath = transcript("open");
  reviewFlow("flow_identity_gap", previous.artifactPath, "reviewing", {});
  const flow = loadFlows()[0]!;
  flow.implementerConversationId = previous.conversation.id;
  const begun = reserveReviewerSpawn(flow, newRound(flow, "button", null), flow.roles.reviewer, "fixture", registry);
  const settled = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId: randomUUID() }, artifactPath: reviewerPath,
    cwd: directory, accountId: "fixture", status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
  if (settled.kind === "conflict") throw new Error(settled.code);
  reviewFlow("flow_identity_gap", previous.artifactPath, "reviewing", { reviewerPath, reviewerConversationId: settled.conversation.id,
    reviewerPid: identity.pid, reviewerIdentity: missingIdentity ? null : identity.startIdentity, sessionId: settled.entry.key.sessionId,
    launchId: begun.receipt.launchId, spawnStartedAt: new Date().toISOString() });
  const disk = JSON.parse(readFileSync(registry.filename, "utf8"));
  disk.entries[`codex:${settled.entry.key.sessionId}`].updatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(registry.filename, JSON.stringify(disk));
  rmSync(reviewerPath);
  const p = { ...ports([], [lane("lane_identity_gap", "reviewing", { conversationId: previous.conversation.id, agentPath: previous.artifactPath, flowId: "flow_identity_gap" })]), flows: loadFlows };
  if (!missingIdentity) {
    const { turnEvidenceReader } = await import("./instance");
    p.turnLiveness = turnEvidenceReader(() => { const sources = productionLivenessSources(); return { ...sources, probe: { ...sources.probe, processIdentity: (pid: number) => pid === child.pid ? null : sources.probe.processIdentity(pid) } }; });
  }
  try {
    expect(Bun.spawnSync(["kill", "-0", String(child.pid)]).exitCode).toBe(0);
    for (const at of [Date.now(), Date.now() + 12 * 60 * 60_000]) {
      expect(await probeQuiet(snapshot, p, at, true)).toMatchObject({ quiet: false, blockers: { stages: 1 } });
    }
    /* Readable evidence of a replaced process releases the bound stage. */
    const { turnEvidenceReader } = await import("./instance");
    p.turnLiveness = turnEvidenceReader();
    const changed = loadFlows()[0]!;
    changed.rounds.at(-1)!.reviewerIdentity = `${identity.startIdentity}-replaced`;
    saveFlows([changed]);
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
    changed.rounds.at(-1)!.reviewerIdentity = missingIdentity ? null : identity.startIdentity;
    saveFlows([changed]);
    child.kill();
    await child.exited;
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
  } finally { saveFlows([]); child.kill(); await child.exited; }
 });
}

test("attack: an aliased live headless owner without a journal artifact path protects its open turn", async () => {
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  const reviewer = hosted("open", deadProcess);
  const stored = registry.readOnlySnapshot().entries[`codex:${reviewer.key.sessionId}`]!;
  registry.upsert({ ...stored, status: "starting", structuredHost: null, pendingAction: "spawn" });
  const alias = `conversation_${randomUUID()}`;
  const disk = JSON.parse(readFileSync(registry.filename, "utf8"));
  disk.conversationAliases[alias] = reviewer.conversation.id;
  disk.entries[`codex:${reviewer.key.sessionId}`].updatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(registry.filename, JSON.stringify(disk));
  reviewFlow("flow_alias", reviewer.artifactPath, "reviewing", { reviewerConversationId: reviewer.conversation.id,
    reviewerPath: reviewer.artifactPath, reviewerPid: identity.pid, reviewerIdentity: identity.startIdentity });
  const aliased = {...row(reviewer, "hosted"), conversationId: alias, artifactPath: null, sessionKey: reviewer.key};
  const journal = journalOf("alias", [aliased]);
  const p = {...ports([]), runtimeSnapshot: async () => journal.snapshot()};
  try {
    rmSync(reviewer.artifactPath);
    const direct = await p.turnLiveness!({conversationId: reviewer.conversation.id, artifactPath: reviewer.artifactPath}, {});
    expect(direct.headlessReviewerProcess).toBe("alive");
    const result = await probeQuiet(snapshot, p, Date.now(), true);
    expect(result).toMatchObject({quiet:false, blockers:{turns:1}});
    reviewFlow("flow_alias", reviewer.artifactPath, "reviewing", { reviewerConversationId: reviewer.conversation.id,
      reviewerPath: reviewer.artifactPath, reviewerPid: identity.pid, reviewerIdentity: `${identity.startIdentity}-replaced` });
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({quiet:true, blockers:{turns:0}});
    reviewFlow("flow_alias", reviewer.artifactPath, "reviewing", { reviewerConversationId: reviewer.conversation.id,
      reviewerPath: reviewer.artifactPath, reviewerPid: identity.pid, reviewerIdentity: identity.startIdentity });
    child.kill();
    await child.exited;
    expect(await probeQuiet(snapshot, p, Date.now(), true)).toMatchObject({quiet:true, blockers:{turns:0}});
  } finally { child.kill(); await child.exited; journal.close(); saveFlows([]); }
});

test("the initial review round is judged on its process before the attempt has a conversation binding", async () => {
  const previous = ended("open");
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  const round = (pid: number | null, saved: string | null) => reviewFlow("flow_first_round", previous.artifactPath, "reviewing", {
    reviewerConversationId: null, reviewerPath: null, reviewerPid: pid, reviewerIdentity: saved,
    launchId: "first-round", spawnStartedAt: new Date().toISOString() });
  const p = { ...ports([], [lane("lane_first_round", "reviewing", { conversationId: null, agentPath: null, flowId: "flow_first_round" })]), flows: loadFlows };
  try {
    for (const saved of [identity.startIdentity, null]) {
      round(identity.pid, saved);
      for (const at of [Date.now(), Date.now() + 12 * 60 * 60_000]) {
        expect(await probeQuiet(snapshot, p, at, true)).toMatchObject({ quiet: false, blockers: { stages: 1 } });
      }
    }
    for (const [pid, saved] of [[deadProcess.pid, deadProcess.startIdentity], [identity.pid, `${identity.startIdentity}-replaced`]] as const) {
      round(pid, saved);
      for (const at of [Date.now(), Date.now() + 12 * 60 * 60_000]) {
        expect(await probeQuiet(snapshot, p, at, true)).toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0 } });
      }
    }
    round(null, null);
    expect(await probeQuiet(snapshot, p, Date.now() + 12 * 60 * 60_000, true)).toMatchObject({ quiet: false, blockers: { stages: 1 } });
  } finally { saveFlows([]); child.kill(); await child.exited; }
});

/** A headless reviewer bound by the production launch writers, with no registry host. */
function boundHeadlessReviewer(identity: ProcessIdentity, savedIdentity: string | null, aged = false) {
  const previous = ended("open");
  const reviewerPath = transcript("open");
  const flowId = `flow_${randomUUID()}`;
  reviewFlow(flowId, previous.artifactPath, "reviewing", {});
  const flow = loadFlows()[0]!;
  flow.implementerConversationId = previous.conversation.id;
  const begun = reserveReviewerSpawn(flow, newRound(flow, "button", null), flow.roles.reviewer, "fixture", registry);
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId: randomUUID() }, artifactPath: reviewerPath,
    cwd: directory, accountId: "fixture", status: "starting", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: "spawn",
  });
  if (settled.kind === "conflict") throw new Error(settled.code);
  const startedAt = new Date(Date.now() - (aged ? 10 * 60_000 : 0)).toISOString();
  reviewFlow(flowId, previous.artifactPath, "reviewing", {
    reviewerPath, reviewerConversationId: settled.conversation.id,
    reviewerPid: identity.pid, reviewerIdentity: savedIdentity,
    sessionId: settled.entry.key.sessionId, launchId: begun.receipt.launchId, spawnStartedAt: startedAt,
  });
  if (aged) {
    const disk = JSON.parse(readFileSync(registry.filename, "utf8"));
    disk.entries[`codex:${settled.entry.key.sessionId}`].updatedAt = startedAt;
    writeFileSync(registry.filename, JSON.stringify(disk));
  }
  const reviewer = { conversation: settled.conversation, artifactPath: reviewerPath };
  const session = { ...row(reviewer, "hosted"), sessionKey: settled.entry.key };
  const journal = journalOf(randomUUID(), [session]);
  const stage = lane("lane_bound", "reviewing", {
    conversationId: settled.conversation.id, agentPath: reviewerPath, flowId,
  });
  const p = { ...ports([], [stage]), flows: loadFlows, runtimeSnapshot: async () => journal.snapshot() };
  return { previous, settled, reviewer, session, journal, stage, p };
}

for (const replaced of [false, true]) {
  test(`a fresh bound headless ${replaced ? "replaced PID" : "dead PID"} immediately releases its turn and stage`, async () => {
    const child = Bun.spawn(["sleep", "60"]);
    const identity = captureProcessIdentity(child.pid)!;
    const fixture = boundHeadlessReviewer(identity, replaced ? `${identity.startIdentity}-replaced` : identity.startIdentity);
    try {
      if (!replaced) { child.kill(); await child.exited; }
      const evidence = await fixture.p.turnLiveness!(fixture.session, {});
      expect(evidence).toMatchObject({ record: { host: { state: "gone" } }, headlessReviewerProcess: "gone", registryHost: { processAlive: false } });
      expect(await agentActivity(fixture.reviewer.conversation.id)).toMatchObject([{ host: { state: "gone" } }]);
      expect(await probeQuiet(snapshot, fixture.p, Date.now(), true))
        .toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0, discounted: 1 } });
    } finally { saveFlows([]); fixture.journal.close(); child.kill(); await child.exited; }
  });
}

for (const paused of [false, true]) {
  test(`a live headless reviewer preserves turn and stage blockers after tickFlows enters ${paused ? "paused" : "needs_decision"}`, async () => {
    const child = Bun.spawn(["sleep", "60"]);
    const identity = captureProcessIdentity(child.pid)!;
    const fixture = boundHeadlessReviewer(identity, paused ? identity.startIdentity : null, true);
    const held = { quiet: false, blockers: { turns: 1, stages: 1 } };
    try {
      expect(await probeQuiet(snapshot, fixture.p, Date.now(), true)).toMatchObject(held);
      const { tickFlows } = await import("@/lib/flows/engine");
      await tickFlows(paused ? [] : [{ path: fixture.previous.artifactPath } as never]);
      expect(loadFlows()[0]!.state).toBe(paused ? "paused" : "needs_decision");
      expect(captureProcessIdentity(child.pid)).toMatchObject(identity);
      expect(registry.readOnlySnapshot().entries[`codex:${fixture.settled.entry.key.sessionId}`])
        .toMatchObject({ status: "starting", pendingAction: "spawn" });
      expect(await agentActivity(fixture.reviewer.conversation.id))
        .toMatchObject([{ host: { state: paused ? "alive" : "unknown", kind: "headless" } }]);
      for (const at of [Date.now(), Date.now() + 12 * 60 * 60_000]) {
        expect(await probeQuiet(snapshot, fixture.p, at, true)).toMatchObject(held);
      }
      // The attempt can still name the previous round while the flow is parked.
      Object.assign(fixture.stage.runs[0]!.attempts[0]!, {
        conversationId: fixture.previous.conversation.id, agentPath: fixture.previous.artifactPath,
      });
      expect(await probeQuiet(snapshot, fixture.p, Date.now(), true)).toMatchObject(held);
      if (paused) {
        const flow = loadFlows()[0]!;
        flow.rounds.at(-1)!.reviewerIdentity = `${identity.startIdentity}-replaced`;
        saveFlows([flow]);
        expect(await probeQuiet(snapshot, fixture.p, Date.now(), true))
          .toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0 } });
        flow.rounds.at(-1)!.reviewerIdentity = identity.startIdentity;
        saveFlows([flow]);
      }
      child.kill();
      await child.exited;
      expect(await agentActivity(fixture.reviewer.conversation.id)).toMatchObject([{ host: { state: "gone" } }]);
      expect(await probeQuiet(snapshot, fixture.p, Date.now(), true))
        .toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0 } });
    } finally { saveFlows([]); fixture.journal.close(); child.kill(); await child.exited; }
  });
}

for (const unproven of [false, true]) {
  test(`a ${unproven ? "unproven" : "live"} replacement host overrides a gone headless reviewer`, async () => {
    const child = Bun.spawn(["sleep", "60"]);
    const identity = captureProcessIdentity(child.pid)!;
    const fixture = boundHeadlessReviewer(deadProcess, deadProcess.startIdentity);
    try {
      const entry = registry.readOnlySnapshot().entries[`codex:${fixture.settled.entry.key.sessionId}`]!;
      registry.upsert({ ...entry, status: "live", structuredHost: {
        kind: "codex-app-server", endpoint: "stdio:fixture",
        process: { ...identity, startIdentity: unproven ? null : identity.startIdentity },
        eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0,
        activeTurnRef: "replacement-turn", pendingAttention: [], activeFlags: [],
      } });
      expect(await fixture.p.turnLiveness!(fixture.session, {}))
        .toMatchObject({ headlessReviewerProcess: "gone", registryHost: { processAlive: true } });
      expect(await probeQuiet(snapshot, fixture.p, Date.now(), true))
        .toMatchObject({ quiet: false, blockers: { turns: 1, stages: 1 } });
    } finally { saveFlows([]); fixture.journal.close(); child.kill(); await child.exited; }
  });
}

test("review attack: a review stage remains owned by its live fixing implementer after the reviewer died", async () => {
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  const reviewer = ended("open");
  const implementer = hosted("open", identity);
  // #2507: a continuation can grow the transcript while the host remains idle.
  registry.upsert({...registry.readOnlySnapshot().entries[`codex:${implementer.key.sessionId}`]!, status: "idle"});
  const at = new Date().toISOString();
  const flowId = "flow_fixing_owner";
  reviewFlow(flowId, implementer.artifactPath, "relaying", {
    reviewerPath: reviewer.artifactPath, reviewerConversationId: reviewer.conversation.id,
    reviewerPid: deadProcess.pid, reviewerIdentity: deadProcess.startIdentity,
    verdict: "REQUEST_CHANGES", reviewedAt: at, relayedAt: at,
    relayDelivery: { path: implementer.artifactPath, deliveredAt: at },
  });
  const flow = loadFlows()[0]!;
  flow.implementerConversationId = implementer.conversation.id;
  saveFlows([flow]);
  // The journal still has the idle projection from before legacy relay.
  const journal = journalOf("fixing-owner", [
    {...row(reviewer, "hosted"), sessionKey: reviewer.key},
    {...row(implementer, "hosted", "idle"), sessionKey: implementer.key, activeTurnId: null},
  ]);
  const p = {...ports([], [lane("lane_fixing", "reviewing", {
    conversationId: reviewer.conversation.id, agentPath: reviewer.artifactPath, flowId,
  })]), flows: loadFlows, runtimeSnapshot: async () => journal.snapshot()};
  try {
    const {tickFlows} = await import("@/lib/flows/engine");
    // The actual relay transition, followed by idle-host background work.
    await tickFlows([{path: implementer.artifactPath, engine: "codex", root: "codex-sessions", cwd: directory, project: "fixture"} as never]);
    expect(loadFlows()[0]!.state).toBe("fixing");
    expect(await agentActivity(implementer.conversation.id)).toMatchObject([
      {turnState: "busy", host: {state: "alive"}}
    ]);
    const result = await probeQuiet(snapshot, p, Date.now(), true);
    expect(result).toMatchObject({quiet: false, blockers: {stages: 1}});
    // The same continuation remains owned across parked flow projections and
    // for legacy flows that bind only the implementer's transcript path.
    for (const state of ["fixing", "paused", "needs_decision"] as const) {
      const active = loadFlows()[0]!;
      active.state = state;
      active.pausedState = state === "paused" ? "fixing" : null;
      active.implementerConversationId = null;
      saveFlows([active]);
      expect(await probeQuiet(snapshot, p, Date.now(), true))
        .toMatchObject({quiet: false, blockers: {stages: 1}});
    }
    child.kill();
    await child.exited;
    expect(await agentActivity(implementer.conversation.id)).toMatchObject([{host: {state: "gone"}}]);
    expect(await probeQuiet(snapshot, p, Date.now(), true))
      .toMatchObject({quiet: true, blockers: {stages: 0}});
  } finally { saveFlows([]); journal.close(); child.kill(); await child.exited; }
});

test("review attack: accepted structured relay still holds its stage before the implementer turn starts", async () => {
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  const reviewer = ended("open");
  const implementer = hosted("settled", identity);
  const flowId = "flow_relay_owner";
  const findingsPath = join(directory, "relay-findings.md");
  writeFileSync(findingsPath, "VERDICT: REQUEST_CHANGES\n\nComplete the requested work.\n");
  reviewFlow(flowId, implementer.artifactPath, "relaying", {
    reviewerPath: reviewer.artifactPath, reviewerConversationId: reviewer.conversation.id,
    reviewerPid: deadProcess.pid, reviewerIdentity: deadProcess.startIdentity,
    findingsPath, verdict: "REQUEST_CHANGES", findingsCount: 1,
    relayedAt: null, reviewedAt: new Date().toISOString(),
  });
  const flow = loadFlows()[0]!;
  flow.implementerConversationId = implementer.conversation.id;
  saveFlows([flow]);
  const journal = journalOf("relay-owner", [
    {...row(reviewer, "hosted"), sessionKey: reviewer.key},
    {...row(implementer, "hosted", "idle"), sessionKey: implementer.key, hostKind: "codex-app-server", activeTurnId: null, capabilities: {steer: true, structuredAttention: true}},
  ]);
  const {tickFlows, setRelayDeliveryForTest, sendToImplementer} = await import("@/lib/flows/engine");
  const {enqueueStructuredMessage} = await import("@/lib/runtime/structuredMessageDelivery");
  const client = {
    snapshot: async () => journal.snapshot(),
    readSession: async (ref: Parameters<RuntimeJournal["readSession"]>[0]) => journal.readSession(ref),
    command: async (command: Parameters<RuntimeJournal["executeOperation"]>[0]) => { const receipt = journal.executeOperation(command); return journal.operationResult(receipt.operationId)!; },
  } as never;
  const restore = setRelayDeliveryForTest((active, entries, text, options) => sendToImplementer(active, entries, text, {
    ...options,
    recover: async () => ({target: null, path: implementer.artifactPath, conversationId: implementer.conversation.id, spawned: false}),
    enqueueStructured: (request) => enqueueStructuredMessage(request, {
      enabled: () => true, client: () => client, registry: () => registry, kick: () => {},
    }),
  }));
  const p = {...ports([], [lane("lane_relay", "reviewing", {
    conversationId: reviewer.conversation.id, agentPath: reviewer.artifactPath, flowId,
  })]), flows: loadFlows, runtimeSnapshot: async () => journal.snapshot()};
  const {drainFile, writeDrain, releaseDrain} = await import("./drain");
  const holdId = randomUUID();
  try {
    await tickFlows([{path: implementer.artifactPath, engine: "codex", root: "codex-sessions", cwd: directory, project: "fixture"} as never]);
    expect(loadFlows()[0]).toMatchObject({
      state: "relaying", rounds: [{relayStartedAt: expect.any(String), relayPendingSettlement: {path: implementer.artifactPath}, relayedAt: null}],
    });
    // Take real custody only after the relay operation has been admitted.
    writeDrain(drainFile(), {id: holdId, target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true});
    const result = await probeQuiet(snapshot, p, Date.now(), true);
    expect(result).toMatchObject({quiet: false, blockers: {stages: 1}});
    child.kill();
    await child.exited;
    const now = Date.now();
    // An accepted operation has custody even if both processes have gone,
    // including after a settled transcript owner's five-minute bound.
    expect(await probeQuiet(snapshot, p, now, true))
      .toMatchObject({quiet: false, blockers: {stages: 1}});
    expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES, true))
      .toMatchObject({quiet: false, blockers: {stages: 1}});
    // The real controller's bounded timeout refuses this attempt and holds
    // its retry for fresh admission. Once custody is cleared it can drain.
    const pending = loadFlows()[0]!;
    pending.rounds.at(-1)!.relayPendingSettlement!.since = new Date(now - FIVE_MINUTES).toISOString();
    saveFlows([pending]);
    await tickFlows([{path: implementer.artifactPath, engine: "codex", root: "codex-sessions", cwd: directory, project: "fixture"} as never]);
    expect(loadFlows()[0]!.rounds.at(-1)).toMatchObject({relayPendingSettlement: null, relayStartedAt: null, relayRetryRequiresIdempotency: true});
    expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES, true))
      .toMatchObject({quiet: true, blockers: {stages: 0}});
  } finally { releaseDrain(drainFile(), holdId); restore(); saveFlows([]); journal.close(); child.kill(); await child.exited; }
});

test("independent attack: a path-only fixing implementer with live recorded process survives lagging dead status", async () => {
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  const reviewer = ended("open");
  const implementer = hosted("open", identity);
  registry.upsert({ ...registry.readOnlySnapshot().entries[`codex:${implementer.key.sessionId}`]!, status: "dead" });
  const at = new Date().toISOString();
  const flowId = "flow_path_live";
  reviewFlow(flowId, implementer.artifactPath, "relaying", {
    reviewerPath: reviewer.artifactPath, reviewerConversationId: reviewer.conversation.id,
    reviewerPid: deadProcess.pid, reviewerIdentity: deadProcess.startIdentity,
    verdict: "REQUEST_CHANGES", reviewedAt: at, relayedAt: at,
    relayDelivery: { path: implementer.artifactPath, deliveredAt: at },
  });
  const journal = journalOf("path-only-fixing", [
    { ...row(reviewer, "hosted"), sessionKey: reviewer.key },
    { ...row(implementer, "hosted", "idle"), sessionKey: implementer.key, activeTurnId: null },
  ]);
  const p = { ...ports([], [lane("lane_path_live", "reviewing", {
    conversationId: reviewer.conversation.id, agentPath: reviewer.artifactPath, flowId,
  })]), flows: loadFlows, runtimeSnapshot: async () => journal.snapshot() };
  try {
    const { tickFlows } = await import("@/lib/flows/engine");
    await tickFlows([{ path: implementer.artifactPath, engine: "codex", root: "codex-sessions", cwd: directory, project: "fixture" } as never]);
    expect(loadFlows()[0]!.state).toBe("fixing");
    const now = Date.now();
    for (const at of [now, now + FIVE_MINUTES, now + 12 * 60 * 60_000]) {
      expect(await probeQuiet(snapshot, p, at, true)).toMatchObject({ quiet: false, blockers: { stages: 1, unresolved: 0 } });
    }
    child.kill();
    await child.exited;
    expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES, true)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
  } finally {
    saveFlows([]);
    journal.close();
    child.kill();
    await child.exited;
  }
});

test("independent attack: a deleted transcript cannot hide a live path-only fixing implementer", async () => {
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  const reviewer = ended("open");
  const implementer = hosted("open", identity);
  const at = new Date().toISOString();
  const flowId = "flow_path_deleted";
  reviewFlow(flowId, implementer.artifactPath, "fixing", {
    reviewerPath: reviewer.artifactPath, reviewerConversationId: reviewer.conversation.id,
    reviewerPid: deadProcess.pid, reviewerIdentity: deadProcess.startIdentity,
    verdict: "REQUEST_CHANGES", reviewedAt: at, relayedAt: at,
  });
  rmSync(implementer.artifactPath);
  const journal = journalOf("path-deleted-fixing", [
    { ...row(reviewer, "hosted"), sessionKey: reviewer.key },
    { ...row(implementer, "hosted", "idle"), sessionKey: implementer.key, activeTurnId: null },
  ]);
  const p = { ...ports([], [lane("lane_path_deleted", "reviewing", {
    conversationId: reviewer.conversation.id, agentPath: reviewer.artifactPath, flowId,
  })]), flows: loadFlows, runtimeSnapshot: async () => journal.snapshot() };
  try {
    const now = Date.now();
    for (const at of [now, now + FIVE_MINUTES, now + 12 * 60 * 60_000]) {
      expect(await probeQuiet(snapshot, p, at, true)).toMatchObject({ quiet: false, blockers: { stages: 1, unresolved: 0 } });
    }
    child.kill();
    await child.exited;
    expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES, true)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
  } finally {
    saveFlows([]);
    journal.close();
    child.kill();
    await child.exited;
  }
});

test("independent control: canonical live ownership with a deleted transcript holds until real process death", async () => {
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  const reviewer = ended("open");
  const implementer = hosted("open", identity);
  rmSync(implementer.artifactPath);
  const flowId = "flow_control";
  const at = new Date().toISOString();
  reviewFlow(flowId, implementer.artifactPath, "fixing", {
    reviewerPath: reviewer.artifactPath, reviewerConversationId: reviewer.conversation.id,
    reviewerPid: deadProcess.pid, reviewerIdentity: deadProcess.startIdentity,
    verdict: "REQUEST_CHANGES", reviewedAt: at, relayedAt: at,
  });
  const active = loadFlows()[0]!;
  active.implementerConversationId = implementer.conversation.id;
  saveFlows([active]);
  const journal = journalOf("canonical-control", [
    { ...row(reviewer, "hosted"), sessionKey: reviewer.key },
    { ...row(implementer, "hosted", "idle"), sessionKey: implementer.key, activeTurnId: null },
  ]);
  const p = { ...ports([], [lane("lane_control", "reviewing", {
    conversationId: reviewer.conversation.id, agentPath: reviewer.artifactPath, flowId,
  })]), flows: loadFlows, runtimeSnapshot: async () => journal.snapshot() };
  try {
    const now = Date.now();
    expect(await probeQuiet(snapshot, p, now, true)).toMatchObject({ quiet: false, blockers: { stages: 1 } });
    expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES, true)).toMatchObject({ quiet: false, blockers: { stages: 1 } });
    child.kill();
    await child.exited;
    expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES, true)).toMatchObject({ quiet: true, blockers: { stages: 0 } });
  } finally {
    saveFlows([]);
    journal.close();
    child.kill();
    await child.exited;
  }
});

test("independent cache attack: a stage without a path cannot mask the journal's live transcript evidence", async () => {
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  const live = hosted("open", identity);
  const orphanId = `conversation_${randomUUID()}`;
  const journal = journalOf("cached-path-owner", [
    { ...row(live, "hosted"), conversationId: orphanId, sessionKey: live.key },
  ]);
  const p = { ...ports([], [lane("lane_cached", "running", {
    conversationId: orphanId, agentPath: null,
  })]), runtimeSnapshot: async () => journal.snapshot() };
  try {
    const now = Date.now();
    for (const at of [now, now + FIVE_MINUTES, now + 12 * 60 * 60_000]) {
      expect(await probeQuiet(snapshot, p, at, true)).toMatchObject({ quiet: false, blockers: { turns: 1, stages: 1, unresolved: 0 } });
    }
    child.kill();
    await child.exited;
    expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES, true)).toMatchObject({ quiet: true, blockers: { turns: 0, stages: 0 } });
  } finally {
    journal.close();
    child.kill();
    await child.exited;
  }
});

test("independent cache control: the same journal protects its live process when the stage supplies the path", async () => {
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  const live = hosted("open", identity);
  const orphanId = `conversation_${randomUUID()}`;
  const journal = journalOf("cached-path-control", [
    { ...row(live, "hosted"), conversationId: orphanId, sessionKey: live.key },
  ]);
  const p = { ...ports([], [lane("lane_cached_control", "running", {
    conversationId: orphanId, agentPath: live.artifactPath,
  })]), runtimeSnapshot: async () => journal.snapshot() };
  try {
    const now = Date.now();
    expect(await probeQuiet(snapshot, p, now, true)).toMatchObject({ quiet: false, blockers: { turns: 1, stages: 1 } });
    expect(await probeQuiet(snapshot, p, now + FIVE_MINUTES, true)).toMatchObject({ quiet: false, blockers: { turns: 1, stages: 1 } });
    const runtimeOnly = { ...p, pipelines: () => [] };
    expect(await probeQuiet(snapshot, runtimeOnly, now + FIVE_MINUTES, true)).toMatchObject({ quiet: false, blockers: { turns: 1 } });
  } finally {
    journal.close();
    child.kill();
    await child.exited;
  }
});


test.each(["generation", "continuity", "alias"] as const)("fallback ownership follows a deleted %s path to the current process", async (binding) => {
  const child = Bun.spawn(["sleep", "60"]);
  const identity = captureProcessIdentity(child.pid)!;
  const previous = ended("open");
  const current = hosted("open", identity);
  const disk = registry.readOnlySnapshot();
  if (binding === "alias") disk.conversationAliases[previous.conversation.id] = current.conversation.id;
  else {
    delete disk.conversations[previous.conversation.id];
    const owner = disk.conversations[current.conversation.id]!;
    if (binding === "generation") owner.generations.unshift(previous.conversation.generations[0]!);
    else owner.continuityPaths.push(previous.artifactPath);
  }
  rmSync(previous.artifactPath);
  const read = turnEvidenceReader(() => ({ ...productionLivenessSources(), registrySnapshot: () => disk }));
  const request = { conversationId: "flow:legacy:implementer", artifactPath: previous.artifactPath };
  try {
    expect(await read(request, {})).toMatchObject({ record: null, registryHost: { processAlive: true } });
    child.kill();
    await child.exited;
    expect(await read(request, {})).toMatchObject({ record: null, registryHost: { state: "gone", processAlive: false } });
  } finally { child.kill(); await child.exited; }
});

test("a path-only owner reads its current hosted turn even when registry and transcript say gone", async () => {
  const fixture = ended("open");
  rmSync(fixture.artifactPath);
  const journal = journalOf("path-current-host", []);
  const client = {
    snapshot: async () => journal.snapshot(),
    append: async (event: Parameters<RuntimeJournal["append"]>[0]) => journal.append(event),
    producerCursor: async () => 0,
    effectBatch: async () => [],
    operationStatus: async () => null,
  } as unknown as RuntimeHostClient;
  const fake = new FakeEngineHost();
  const health = await fake.health();
  const host = Object.assign(fake, {
    health: async () => ({ ...health, status: "active" as const, activeTurnRef: "replacement-turn" }),
    onStateChange: () => () => {},
  });
  try {
    await bindStructuredDeliveryQueue([], { registry, client, deferStartupWork: true, hostlessSettleIntervalMs: 0 });
    await publishStructuredDeliveryHost({ key: fixture.key, host });
    const read = productionDeps({ ...process.env }).quiet!.turnLiveness!;
    expect(await read({ conversationId: "flow:legacy:implementer", artifactPath: fixture.artifactPath }, {}))
      .toMatchObject({ record: null, registryHost: { state: "gone", processAlive: false }, currentTurnIdle: false });
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
  }
});
