/* #2594, acceptance 1: where an observational probe spends its time on an
   installation shaped like a long-lived one — many retained flows, each with
   the reviewer rounds it moved past, a few running lanes and open journal
   rows. The custody reader is the production one (`ownerCensusReader` over
   `productionLivenessSources`), reading a real registry and real transcripts
   under a temp root; only the journal rows and the pipeline list are handed in.

   It prints one line of phase timings. `LLV_WORK_EVIDENCE_FLOWS` and
   `LLV_WORK_EVIDENCE_ROUNDS` resize the fixture. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { productionLivenessSources } from "@/lib/lifecycle/liveness";
import type { Flow } from "@/lib/flows/types";

import { ownerCensusReader } from "./instance";
import type { QuietPorts } from "./quiet";
import type { Snapshot } from "./types";
import { ObservedWork } from "./workEvidence";

const FLOWS = Number(process.env.LLV_WORK_EVIDENCE_FLOWS ?? 120);
const ROUNDS = Number(process.env.LLV_WORK_EVIDENCE_ROUNDS ?? 6);
const LANES = 12;
const TURNS = 24;

const snapshot = { busy: null, processes: { web: { state: "healthy" }, runtimeHost: { state: "healthy" } } } as Snapshot;

let directory: string;
let registry: AgentRegistry;
let previousCodexHome: string | undefined;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "work-evidence-measure-"));
  previousCodexHome = process.env.LLV_CODEX_HOME;
  process.env.LLV_CODEX_HOME = join(directory, "codex-home");
  mkdirSync(join(process.env.LLV_CODEX_HOME, "sessions", "2026", "01", "01"), { recursive: true });
  registry = new AgentRegistry(join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  setAgentRegistryForTests(registry);
});

afterAll(() => {
  setAgentRegistryForTests(null);
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  rmSync(directory, { recursive: true, force: true });
});

/** A finished Codex conversation the registry knows, with its transcript. */
function conversation(turn: "open" | "settled" = "settled"): { id: string; path: string } {
  const id = randomUUID();
  const path = join(process.env.LLV_CODEX_HOME!, "sessions", "2026", "01", "01", `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  const at = "2026-01-01T00:00:00.000Z";
  const event = (type: string) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type } });
  writeFileSync(path, [JSON.stringify({ timestamp: at, type: "session_meta", payload: { id, cwd: directory } }),
    event("task_started"), event("user_message"), ...(turn === "settled" ? [event("task_complete")] : [])].join("\n") + "\n");
  return { id: registry.ensureConversation("codex", path, "fixture").id, path };
}

function retainedFlow(index: number): Flow {
  const implementer = conversation();
  const rounds = Array.from({ length: ROUNDS }, (_, n) => {
    const reviewer = conversation();
    return { n: n + 1, reviewerPath: reviewer.path, reviewerConversationId: reviewer.id, findingsPath: null, triggeredBy: "button", readyNote: null,
      verdict: n + 1 < ROUNDS ? "REQUEST_CHANGES" : "APPROVE", findingsCount: null, startedAt: "2026-01-01T00:00:00.000Z", error: null };
  });
  return { id: `flow_${index}`, template: "implement-review-loop", project: "fixture", cwd: directory, implementerPath: implementer.path,
    implementerConversationId: implementer.id,
    roles: { implementer: { engine: "codex", model: null, effort: null }, reviewer: { engine: "codex", model: null, effort: null } },
    baseRef: "a".repeat(40), baseMode: "head", mode: "auto", reviewerMode: "headless", roundLimit: ROUNDS, state: "done", stateDetail: null,
    createdAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-01-01T01:00:00.000Z", rounds } as unknown as Flow;
}

test("instrumentation names the dominant phase of one observational probe on long-lived synthetic state", async () => {
  const flows = Array.from({ length: FLOWS }, (_, index) => retainedFlow(index));
  const lanes = Array.from({ length: LANES }, (_, index) => {
    const owner = conversation("open");
    return { id: `lane_${index}`, task: "Finish the work", state: "running", cursor: { stageId: "stage", state: "running" },
      runs: [{ stageId: "stage", attempts: [{ n: 1, conversationId: owner.id, agentPath: owner.path }] }] };
  });
  const sessions = Array.from({ length: TURNS }, () => {
    const owner = conversation("open");
    return { conversationId: owner.id, sessionKey: { engine: "codex" }, cwd: null, artifactPath: owner.path, host: "hosted", turn: "running", activeTurnId: "turn" };
  });
  const sources = () => ({ ...productionLivenessSources(), flows: () => flows, pipelines: () => [] });
  const ports: QuietPorts = {
    runtimeSnapshot: async () => ({ sessions }) as never,
    pipelines: () => lanes as never,
    flows: () => flows,
    presence: () => [],
    registryHealth: () => [],
    seats: () => [],
    controllerBusyReason: async () => null,
    owners: ownerCensusReader(sources, { readEvents: async () => ({ reset: false, floorSeq: 0, events: [] }), readSession: async () => null, heldHosts: () => new Map() }),
  };
  const observed = new ObservedWork(ports, () => Date.now(), () => {});
  expect(observed.observe(snapshot).evidence.state).toBe("pending");
  await observed.settled();
  const { evidence } = observed.observe(snapshot);
  const phases = evidence.phases!;
  console.info(`[#2594] ${FLOWS} retained flows × ${ROUNDS} rounds, ${LANES} lanes, ${TURNS} open journal rows: ${JSON.stringify(phases)}`);
  expect(evidence.state).toBe("ready");
  // Known conversations without a recorded process discount their journal
  // rows; only a stage's custody needs their transcript here (R9).
  expect(phases.readings).toEqual({ pipelines: LANES, flows: FLOWS, historicalReviewers: FLOWS * (ROUNDS - 1), turns: 0 });
  const parts = phases.journalMs + phases.pipelinesMs + phases.flowsMs + phases.historicalReviewersMs + phases.turnsMs + phases.otherMs + phases.yieldedMs + phases.judgingMs;
  expect(Math.abs(parts - phases.totalMs)).toBeLessThan(1);
}, 600_000);
