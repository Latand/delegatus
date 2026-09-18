import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CreateFlowRequest, Flow } from "@/lib/flows/types";

/* Isolated state only: this suite drives the production pipeline controller
   over a store of its own and must never read or write the operator's. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-severed-turn-resume-"));
const { createPipelineFromRequest, tickPipelines } = await import("./engine");
const { loadPipelines, savePipelines } = await import("./store");
const { registerPipelineTick } = await import("./controllerSignal");
type PipelinePorts = import("./engine").PipelinePorts;
type StageTurnEvidence = import("./durableEvidence").StageTurnEvidence;

/* A tick this suite did not ask for must never reach the real ports. */
registerPipelineTick(async () => {});

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const STAGE_TRANSCRIPT = "/claude/stage-1.jsonl";
const STAGE_CONVERSATION = "conversation_stage_1";
const RESUME_SILENCE_MS = 3 * 60_000;
const PARK_SILENCE_MS = 10 * 60_000;
const PARK_DETAIL =
  "the stage turn was cut when the runtime host was replaced, and one controller continuation did not resume it";

/**
 * The lane the three production deploys left behind: a pane-less Claude stage
 * whose turn was open when the runtime host was replaced. The successor host
 * resumed the session and sits idle over a transcript whose last record is the
 * tool call the deploy cut, while the runtime ledger still projects a running
 * turn — the reading that kept the attempt `running` and the card working.
 */
function harness() {
  const continuations: Array<{ conversationId: string; transcriptPath: string; clientMessageId: string; text: string }> = [];
  /* The production clock of the third deploy: the lane's last transcript
     record at 15:59:11, the succession that cut it at 16:02:32 — silent for
     three minutes and twenty-one seconds before its host was replaced. */
  let wall = Date.parse("2026-09-18T16:02:32.000Z");
  let hostEpoch = 1_015;
  let turn: StageTurnEvidence = { turn: "busy", message: null, lastRecordAt: Date.parse("2026-09-18T15:59:11.000Z") };
  let deliveryOutstanding = false;
  let resumeAccepted = true;
  let spawns = 0;
  const ports: PipelinePorts = {
    exec: (rawCommand, rawArgs) => {
      const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "branch") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `${"9".repeat(40)}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({
      ok: true,
      repoDir,
      gitCommonDir: path.join(repoDir, ".git"),
      worktreeParent: path.dirname(repoDir),
    }),
    roleLookup: (roleId) => roleId === "builder"
      ? { engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: "Builder guidance" }
      : { engine: "claude", model: "fable", effort: "high", access: "read-only", promptScaffold: "Architect guidance" },
    spawnAgent: async (_input, onReserved) => {
      spawns += 1;
      onReserved({ launchId: `launch-${spawns}`, conversationId: STAGE_CONVERSATION, accountId: "default" });
      return {
        launchId: `launch-${spawns}`,
        conversationId: STAGE_CONVERSATION,
        sessionId: `session-${spawns}`,
        "transcript": STAGE_TRANSCRIPT,
        /* Pane-less: the transport a release succession replaces. */
        paneId: null,
        accountId: "default",
      };
    },
    spawnReceipt: () => null,
    claimSpawnRetry: () => "claimed",
    paneAgentAlive: async () => false,
    stopStageAgent: async () => ({ outcome: "not-running" }),
    stopStagePane: async () => ({ outcome: "not-running" }),
    stageHostResident: async () => false,
    monotonicNow: () => wall,
    worktreePresent: () => true,
    /* The ledger reading that outlives the cut: the turn still reads running. */
    conversationAgentActive: async () => true,
    runtimeHostEpoch: async () => hostEpoch,
    conversationDeliveryOutstanding: () => deliveryOutstanding,
    transcriptPresent: () => true,
    resumeSeveredTurn: async (input) => {
      continuations.push({ ...input });
      return resumeAccepted;
    },
    durableTurnEvidence: async () => turn,
    headCwd: () => loadPipelines()[0]?.worktreeDir ?? null,
    lastMessage: () => null,
    pathForConversation: (id) => id === STAGE_CONVERSATION ? STAGE_TRANSCRIPT : null,
    sourcePathAllowed: (pathname) => pathname.endsWith(".jsonl"),
    conversationIdForPath: (pathname) => pathname === STAGE_TRANSCRIPT
      ? STAGE_CONVERSATION
      : pathname === "/claude/creator.jsonl" ? "conversation_creator" : null,
    pipelineAdoptionCandidates: () => [],
    createFlow: async (request: CreateFlowRequest) => ({ flow: { id: "flow-1", implementerPath: request.implementerPath } as unknown as Flow }),
    patchFlow: () => ({}),
    closeFlow: async () => {},
    getFlow: () => null,
    findFlow: () => null,
    projectForCwd: () => "viewer",
    now: () => new Date(wall).toISOString(),
  };
  return {
    ports,
    continuations,
    advance: (milliseconds: number) => { wall += milliseconds; },
    succeed: () => { hostEpoch += 2; },
    setTurn: (next: StageTurnEvidence) => { turn = next; },
    setDeliveryOutstanding: (outstanding: boolean) => { deliveryOutstanding = outstanding; },
    refuseResume: () => { resumeAccepted = false; },
    acceptResume: () => { resumeAccepted = true; },
    spawnCount: () => spawns,
    wallClock: () => wall,
  };
}

/** A pipeline whose single read-only stage is running, pane-less and silent. */
async function runningStage(h: ReturnType<typeof harness>) {
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Survive a deploy",
    spec: "AC1",
    repoDir: "/repo",
    src: "/claude/creator.jsonl",
    stages: [{ id: "plan", kind: "run", role: { roleId: "architect" }, access: "read-only", "prompt": "Plan", next: null }],
  } as never, h.ports);
  if (!created.pipeline) throw new Error(created.error);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  expect(running.runs[0]!.attempts[0]).toMatchObject({ state: "running", paneId: null, conversationId: STAGE_CONVERSATION });
  expect(running.runs[0]!.attempts[0]!.hostEpoch).toBe(1_015);
  return running;
}

test("a running attempt silent since a host succession is resumed exactly once (#1747)", async () => {
  const h = harness();
  await runningStage(h);

  /* The deploy: a new runtime host generation, the same silent transcript. */
  h.succeed();
  await tickPipelines([], h.ports);
  /* The first sighting only records the witness; nothing is sent on it. */
  expect(h.continuations).toEqual([]);
  const sighted = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(sighted.severedTurn).toMatchObject({ epoch: 1_017, silentSince: Date.parse("2026-09-18T15:59:11.000Z") });
  expect(sighted.severedTurn!.resumedAt).toBeUndefined();

  /* Still silent a minute later: inside the bound, still nothing. */
  h.advance(60_000);
  await tickPipelines([], h.ports);
  expect(h.continuations).toEqual([]);
  expect(loadPipelines()[0]!.state).toBe("running");

  h.advance(RESUME_SILENCE_MS);
  await tickPipelines([], h.ports);
  expect(h.continuations).toHaveLength(1);
  expect(h.continuations[0]).toMatchObject({
    conversationId: STAGE_CONVERSATION,
    transcriptPath: STAGE_TRANSCRIPT,
  });
  expect(h.continuations[0]!.text).toContain("deploy");
  const resumed = loadPipelines()[0]!;
  expect(resumed.state).toBe("running");
  expect(resumed.runs[0]!.attempts[0]!.severedTurn).toMatchObject({
    epoch: 1_017,
    clientMessageId: expect.stringContaining("stage-continuation-"),
    resumedAt: expect.any(String),
  });

  /* Replayed ticks over the same succession send nothing more. */
  h.advance(60_000);
  await tickPipelines([], h.ports);
  h.advance(60_000);
  await tickPipelines([], h.ports);
  expect(h.continuations).toHaveLength(1);
  expect(h.spawnCount()).toBe(1);
});

test("an attempt whose transcript moved since the succession is never messaged (#1747)", async () => {
  const h = harness();
  await runningStage(h);
  h.succeed();
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.severedTurn).toBeDefined();

  /* A turn is in progress on the new host: the transcript's newest record has
     moved since the sighting, whatever the ledger and the clock say. */
  h.advance(RESUME_SILENCE_MS + 60_000);
  h.setTurn({ turn: "busy", message: null, lastRecordAt: Date.parse("2026-09-18T16:05:00.000Z") });
  await tickPipelines([], h.ports);

  expect(h.continuations).toEqual([]);
  const adopted = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  /* The attempt adopts the generation it is demonstrably alive on, so the
     witness cannot re-arm on the same succession. */
  expect(adopted.hostEpoch).toBe(1_017);
  expect(adopted.severedTurn).toBeUndefined();
  expect(loadPipelines()[0]!.state).toBe("running");

  h.advance(PARK_SILENCE_MS);
  await tickPipelines([], h.ports);
  expect(h.continuations).toEqual([]);
  expect(loadPipelines()[0]!.state).toBe("running");
});

/* Review round 1: the sighting is one tick later than the succession, and a
   record written inside that window — the runtime's own interrupted-turn
   continuation, or somebody's "continue" — used to become the baseline the
   silence was measured from. An agent that really had resumed would then be
   sent a continuation saying its in-flight work was gone, in the middle of a
   live turn: exactly what the requirement forbids. */
test("an attempt whose transcript moved just before the sighting is never messaged, however long it then goes quiet (#1747)", async () => {
  const h = harness();
  await runningStage(h);
  h.succeed();
  /* The resumed turn wrote thirty seconds ago: whatever the controller can
     see, this is not silence since the handover. */
  h.setTurn({ turn: "busy", message: null, lastRecordAt: h.wallClock() - 30_000 });
  await tickPipelines([], h.ports);

  const adopted = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(h.continuations).toEqual([]);
  expect(adopted.severedTurn).toBeUndefined();
  expect(adopted.hostEpoch).toBe(1_017);

  /* And it now sits inside one long tool call for longer than both bounds:
     still no continuation, and still no park. */
  h.advance(RESUME_SILENCE_MS + PARK_SILENCE_MS);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(h.continuations).toEqual([]);
  expect(loadPipelines()[0]!).toMatchObject({ state: "running", cursor: { stageId: "plan", state: "running" } });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.severedTurn).toBeUndefined();
});

test("an attempt with a delivery already outstanding is never messaged (#1747)", async () => {
  const h = harness();
  await runningStage(h);
  h.succeed();
  await tickPipelines([], h.ports);

  /* Somebody's prompt is already on its way to this conversation. */
  h.setDeliveryOutstanding(true);
  h.advance(RESUME_SILENCE_MS + 60_000);
  await tickPipelines([], h.ports);
  expect(h.continuations).toEqual([]);
  expect(loadPipelines()[0]!.state).toBe("running");

  /* It lands and the agent answers: the attempt is alive, and still unmessaged. */
  h.setDeliveryOutstanding(false);
  h.setTurn({ turn: "busy", message: null, lastRecordAt: Date.parse("2026-09-18T16:20:00.000Z") });
  await tickPipelines([], h.ports);
  expect(h.continuations).toEqual([]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.hostEpoch).toBe(1_017);
});

test("a running attempt on the generation it was launched under is never messaged (#1747)", async () => {
  const h = harness();
  await runningStage(h);

  /* No succession: a long, silent tool call is just a long tool call. */
  h.advance(PARK_SILENCE_MS + RESUME_SILENCE_MS);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);

  expect(h.continuations).toEqual([]);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.severedTurn).toBeUndefined();
  expect(loadPipelines()[0]!).toMatchObject({ state: "running", cursor: { stageId: "plan", state: "running" } });
});

test("an attempt still silent after its one continuation parks saying a deploy cut the turn (#1747)", async () => {
  const h = harness();
  await runningStage(h);
  h.succeed();
  await tickPipelines([], h.ports);
  h.advance(RESUME_SILENCE_MS);
  await tickPipelines([], h.ports);
  expect(h.continuations).toHaveLength(1);

  /* Silent through the second bound: one continuation was all it was owed. */
  h.advance(PARK_SILENCE_MS);
  await tickPipelines([], h.ports);

  const parked = loadPipelines()[0]!;
  expect(h.continuations).toHaveLength(1);
  expect(parked).toMatchObject({ state: "needs_decision", stateDetail: PARK_DETAIL });
  expect(parked.runs[0]!.attempts[0]).toMatchObject({ state: "needs_decision", error: PARK_DETAIL });
});

test("a continuation the delivery surface refuses stays owed and is sent once when it is accepted (#1747)", async () => {
  const h = harness();
  await runningStage(h);
  h.succeed();
  await tickPipelines([], h.ports);
  h.refuseResume();
  h.advance(RESUME_SILENCE_MS);
  await tickPipelines([], h.ports);
  expect(h.continuations).toHaveLength(1);
  /* Refused: nothing was delivered, so nothing is recorded as resumed. */
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.severedTurn!.resumedAt).toBeUndefined();

  h.acceptResume();
  h.advance(60_000);
  await tickPipelines([], h.ports);
  expect(h.continuations).toHaveLength(2);
  /* The same durable identity both times, so the delivery queue's own dedupe
     is the last fence behind the record. */
  expect(h.continuations[0]!.clientMessageId).toBe(h.continuations[1]!.clientMessageId);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.severedTurn!.resumedAt).toEqual(expect.any(String));

  h.advance(60_000);
  await tickPipelines([], h.ports);
  expect(h.continuations).toHaveLength(2);
});
