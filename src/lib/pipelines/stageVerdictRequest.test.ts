import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CreateFlowRequest, Flow } from "@/lib/flows/types";

/* Isolated state only: this suite drives the production pipeline controller
   over a store of its own and must never read or write the operator's. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-verdict-request-"));
const { createPipelineFromRequest, patchPipeline, tickPipelines } = await import("./engine");
const { loadPipelines, savePipelines } = await import("./store");
const { registerPipelineTick } = await import("./controllerSignal");
type PipelinePorts = import("./engine").PipelinePorts;
type StageTurnEvidence = import("./durableEvidence").StageTurnEvidence;

/* A tick this suite did not ask for must never reach the real ports. */
registerPipelineTick(async () => {});

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const STAGE_TRANSCRIPT = "/claude/stage-1.jsonl";
const STAGE_CONVERSATION = "conversation_stage_1";
const BASE_SHA = "9".repeat(40);
const STAGE_HEAD = "7".repeat(40);
const RECOVERY_INTERVAL_MS = 30_000;
const REQUEST_WAIT_MS = 3 * 60_000;

/** The (a) shape, rebuilt from the final message of production lane 42490aea:
    a valid fenced verdict as the last block, and — in the middle of a sentence
    well before it — a fence quoted inside an inline code span. */
const PRODUCTION_FINAL_MESSAGE = [
  "Both findings are fixed on the PR branch.",
  "",
  `**Finding 2 — the strip.** It computes heading levels with fenced blocks (${"`".repeat(4)} ${"`".repeat(3)} ${"`".repeat(4)} and \`~~~\`,`,
  "with the info-string rule) blanked out, and repeats until the heading names",
  "nothing left in the text.",
  "",
  "REVIEW_READY: a published branch",
  "",
  "```json",
  '{"status":"pass","findings":[],"confidence":0.9}',
  "```",
].join("\n");

/** The (b) shape: the turn ended on a progress line while CI was still running,
    so there was no verdict to write yet. */
const PROGRESS_LINE = "Only the runtime check remains. Waiting on it.";

function harness() {
  const requests: Array<{ conversationId: string; transcriptPath: string; clientMessageId: string; text: string }> = [];
  let wall = Date.parse("2026-09-19T00:45:00.000Z");
  let turn: StageTurnEvidence = { turn: "busy", message: null, lastRecordAt: wall };
  let deliveryOutstanding = false;
  let requestAccepted = true;
  /* A finished structured agent is hosted and idle, which is exactly what the
     runtime ledger cannot tell apart from anything else: it answers null. */
  let conversationActive: boolean | null = null;
  let head = BASE_SHA;
  let remote = BASE_SHA;
  let spawns = 0;
  const calls: string[] = [];
  const ports: PipelinePorts = {
    exec: (rawCommand, rawArgs) => {
      calls.push(`${rawCommand} ${rawArgs.join(" ")}`);
      const args = rawCommand === "timeout" ? rawArgs.slice(rawArgs.indexOf("git") + 1) : rawArgs;
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: `${BASE_SHA}\n`, stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${head}\n`, stderr: "" };
      if (args[0] === "branch") return { code: 0, stdout: `${loadPipelines()[0]?.branch ?? ""}\n`, stderr: "" };
      if (args[0] === "remote" && args[1] === "get-url") return { code: 0, stdout: "git@example.invalid:owner/repo.git\n", stderr: "" };
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: `${remote}\trefs/heads/${loadPipelines()[0]?.branch ?? "pipeline/test"}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse") return { code: 0, stdout: `${head}\n`, stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    preflightRepo: (repoDir) => ({
      ok: true,
      repoDir,
      gitCommonDir: path.join(repoDir, ".git"),
      worktreeParent: path.dirname(repoDir),
    }),
    roleLookup: () => ({ engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: "Builder guidance" }),
    spawnAgent: async (_input, onReserved) => {
      spawns += 1;
      onReserved({ launchId: `launch-${spawns}`, conversationId: STAGE_CONVERSATION, accountId: "default" });
      return {
        launchId: `launch-${spawns}`,
        conversationId: STAGE_CONVERSATION,
        sessionId: `session-${spawns}`,
        /* Quoted so the publication gate does not read the key as a transcript line. */
        "transcript": STAGE_TRANSCRIPT,
        /* Pane-less: the transport the controller can send one request over. */
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
    conversationAgentActive: async () => conversationActive,
    runtimeHostEpoch: async () => 1_020,
    conversationDeliveryOutstanding: () => deliveryOutstanding,
    transcriptPresent: () => true,
    resumeSeveredTurn: async (input) => {
      requests.push({ ...input });
      return requestAccepted;
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
    requests,
    calls,
    advance: (milliseconds: number) => { wall += milliseconds; },
    /** The turn ended on `text`, as the durable transcript read reports it. */
    endTurn: (text: string, offsetMs = 0) => {
      turn = { turn: "terminal", message: { text, ts: wall + offsetMs }, lastRecordAt: wall + offsetMs };
    },
    keepWorking: (text: string) => {
      turn = { turn: "busy", message: { text, ts: wall }, lastRecordAt: wall };
    },
    setConversationActive: (active: boolean | null) => { conversationActive = active; },
    setDeliveryOutstanding: (outstanding: boolean) => { deliveryOutstanding = outstanding; },
    refuseRequest: () => { requestAccepted = false; },
    setHead: (sha: string) => { head = sha; },
    setRemote: (sha: string) => { remote = sha; },
    spawnCount: () => spawns,
  };
}

/** A pipeline whose first stage is running on a pane-less structured host. */
async function runningStage(h: ReturnType<typeof harness>) {
  savePipelines([]);
  const created = await createPipelineFromRequest({
    task: "Finish the lane",
    spec: "AC1",
    repoDir: "/repo",
    src: "/claude/creator.jsonl",
    stages: [
      { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: "verify" },
      { id: "verify", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Verify {{prev.output}}", next: null },
    ],
  } as never, h.ports);
  if (!created.pipeline) throw new Error(created.error);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  expect(running.runs[0]!.attempts[0]).toMatchObject({ state: "running", paneId: null, conversationId: STAGE_CONVERSATION });
  expect(running.lastPassedCommit).toBe(BASE_SHA);
  return running;
}

test("the production final message that parked lane 42490aea settles the stage as pass (#1756)", async () => {
  const h = harness();
  await runningStage(h);

  h.endTurn(PRODUCTION_FINAL_MESSAGE, 1_000);
  await tickPipelines([], h.ports);

  const settled = loadPipelines()[0]!;
  expect(settled.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass", findings: [], confidence: 0.9 },
  });
  expect(settled.runs[0]!.attempts[0]!.verdictRecovery?.state ?? "none").not.toBe("exhausted");
  /* Nothing was asked: the verdict was there to be read all along. */
  expect(h.requests).toEqual([]);
  expect(settled.state).not.toBe("needs_decision");
});

test("a completed turn without a verdict is asked once and settles when the answer carries it (#1756)", async () => {
  const h = harness();
  await runningStage(h);

  h.endTurn(PROGRESS_LINE, 1_000);
  await tickPipelines([], h.ports);

  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]).toMatchObject({ conversationId: STAGE_CONVERSATION, transcriptPath: STAGE_TRANSCRIPT });
  const asked = loadPipelines()[0]!;
  expect(asked.state).toBe("running");
  /* The request is not a recovery check: none has been spent. */
  expect(asked.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
  expect(asked.runs[0]!.attempts[0]!.verdictRequest).toMatchObject({
    messageTs: expect.any(Number),
    requestedAt: expect.any(String),
    clientMessageId: expect.stringContaining("stage-verdict-request-"),
  });

  /* Replayed ticks inside the wait ask nothing more. */
  h.advance(RECOVERY_INTERVAL_MS);
  await tickPipelines([], h.ports);
  h.advance(RECOVERY_INTERVAL_MS);
  await tickPipelines([], h.ports);
  expect(h.requests).toHaveLength(1);
  expect(loadPipelines()[0]!.state).toBe("running");

  /* The agent answers with the verdict it was holding. */
  h.advance(20_000);
  h.endTurn(`Thanks — the run is green.\n\n\`\`\`json\n{"status":"pass","confidence":0.8}\n\`\`\``);
  await tickPipelines([], h.ports);

  expect(h.requests).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({
    state: "passed",
    verdict: { status: "pass", confidence: 0.8 },
  });
});

test("a second completed turn still without a verdict parks the stage (#1756)", async () => {
  const h = harness();
  await runningStage(h);

  h.endTurn(PROGRESS_LINE, 1_000);
  await tickPipelines([], h.ports);
  expect(h.requests).toHaveLength(1);

  /* The agent answered, and its answer carries no verdict either. From here the
     ordinary recovery checks run and the lane parks for the operator. */
  h.advance(20_000);
  h.endTurn("Still nothing to report.");
  for (let tick = 0; tick < 4; tick += 1) {
    await tickPipelines([], h.ports);
    h.advance(RECOVERY_INTERVAL_MS);
  }

  const parked = loadPipelines()[0]!;
  expect(h.requests).toHaveLength(1);
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("stage verdict recovery exhausted");
  expect(parked.runs[0]!.attempts[0]).toMatchObject({
    state: "needs_decision",
    verdictRecovery: { state: "exhausted" },
  });
});

test("an open turn is never asked for a verdict, however long it runs (#1756)", async () => {
  const h = harness();
  await runningStage(h);

  /* Mid-work: the transcript holds a message with no verdict and the turn is
     open. Nothing about that is a finished stage. */
  h.setConversationActive(null);
  h.keepWorking(PROGRESS_LINE);
  for (let tick = 0; tick < 6; tick += 1) {
    await tickPipelines([], h.ports);
    h.advance(REQUEST_WAIT_MS);
  }

  expect(h.requests).toEqual([]);
  const running = loadPipelines()[0]!;
  expect(running.state).toBe("running");
  expect(running.runs[0]!.attempts[0]!.verdictRequest).toBeUndefined();
  expect(running.runs[0]!.attempts[0]!.state).toBe("running");
});

test("a turn the runtime ledger still reads as running is never asked either (#1756)", async () => {
  const h = harness();
  await runningStage(h);

  /* The durable read says the turn ended, the ledger says it is running: the
     controller may re-evaluate the verdict on that, but it may not send a
     message into the turn the ledger is describing. */
  h.setConversationActive(true);
  h.endTurn(PROGRESS_LINE, 1_000);
  for (let tick = 0; tick < 4; tick += 1) {
    await tickPipelines([], h.ports);
    h.advance(RECOVERY_INTERVAL_MS);
  }

  expect(h.requests).toEqual([]);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRequest).toBeUndefined();
});

test("a request the delivery surface refuses still parks the lane on its bound (#1756)", async () => {
  const h = harness();
  await runningStage(h);
  h.refuseRequest();

  h.endTurn(PROGRESS_LINE, 1_000);
  await tickPipelines([], h.ports);
  /* Nothing was delivered, so nothing is recorded as asked. */
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdictRequest!.requestedAt).toBeUndefined();

  h.advance(REQUEST_WAIT_MS);
  for (let tick = 0; tick < 4; tick += 1) {
    await tickPipelines([], h.ports);
    h.advance(RECOVERY_INTERVAL_MS);
  }
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
});

/** Park the lane exactly as production lane d0cf20f0 parked: a finished stage
    whose verdict nobody could read, with its work committed past the
    last-passed commit. */
async function parkedFinishedLane(h: ReturnType<typeof harness>) {
  await runningStage(h);
  h.endTurn(PROGRESS_LINE, 1_000);
  await tickPipelines([], h.ports);
  h.advance(20_000);
  h.endTurn("Still nothing to report.");
  for (let tick = 0; tick < 4; tick += 1) {
    await tickPipelines([], h.ports);
    h.advance(RECOVERY_INTERVAL_MS);
  }
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  /* The stage's work is committed in the worktree, past the last-passed commit. */
  h.setHead(STAGE_HEAD);
  return loadPipelines()[0]!;
}

test("skip-stage adopts the parked stage's pushed head and advances the lane (#1756)", async () => {
  const h = harness();
  const pipeline = await parkedFinishedLane(h);
  /* Pushed: the branch on the remote is exactly the worktree HEAD. */
  h.setRemote(STAGE_HEAD);

  const skipped = await patchPipeline(pipeline.id, { action: "skip-stage" }, h.ports);

  expect(skipped.error).toBeUndefined();
  const advanced = loadPipelines()[0]!;
  expect(advanced.lastPassedCommit).toBe(STAGE_HEAD);
  expect(advanced.state).not.toBe("needs_decision");
  expect(advanced.cursor).toMatchObject({ stageId: "verify", state: "pending" });
  expect(advanced.runs[0]!.attempts[0]).toMatchObject({ state: "skipped" });
  expect(advanced.runs[0]!.attempts[0]!.output).toContain(STAGE_HEAD);
  /* The reset holds the adopted head; nothing the stage committed is lost. */
  expect(h.calls.some((call) => call.includes(`reset --hard ${STAGE_HEAD}`))).toBe(true);
});

test("skip-stage is still refused when the parked stage's work was never pushed (#1756)", async () => {
  const h = harness();
  const pipeline = await parkedFinishedLane(h);
  /* The remote is still at the base: nothing the stage did is published. */
  const callsBefore = h.calls.length;

  const refused = await patchPipeline(pipeline.id, { action: "skip-stage" }, h.ports);

  expect(refused.status).toBe(409);
  expect(refused.error).toContain("close");
  expect(h.calls.slice(callsBefore).some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);
  expect(loadPipelines()[0]!).toMatchObject({ state: "needs_decision", lastPassedCommit: BASE_SHA });
});

test("retry-stage is refused over a pushed head, which it would reset away (#1756)", async () => {
  const h = harness();
  const pipeline = await parkedFinishedLane(h);
  h.setRemote(STAGE_HEAD);
  const callsBefore = h.calls.length;

  const refused = await patchPipeline(pipeline.id, { action: "retry-stage" }, h.ports);

  expect(refused.status).toBe(409);
  expect(h.calls.slice(callsBefore).some((call) => call.includes("reset --hard") || call.includes("clean -fd"))).toBe(false);
  expect(loadPipelines()[0]!.lastPassedCommit).toBe(BASE_SHA);
});
