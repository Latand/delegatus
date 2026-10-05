/* #2515 at the production seam: the drain's own liveness wiring
   (`productionDeps().quiet.turnLiveness`), a real registry whose rows are ended
   by the registry's own writers, and real transcripts under a scanner root.
   Only what the Viewer reads from other processes is replaced: the journal's
   session rows, the pipelines, and the operator's presence. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { AgentRegistry, setAgentRegistryForTests, type ProcessIdentity } from "@/lib/agent/registry";
import { loadFlows, saveFlows } from "@/lib/flows/store";
import { agentLivenessSnapshot, productionLivenessSources } from "@/lib/lifecycle/liveness";
import { captureProcessIdentity } from "@/lib/processIdentity";

import { productionDeps } from "./instance";
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
