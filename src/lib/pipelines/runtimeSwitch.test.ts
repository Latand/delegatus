import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CreateFlowRequest, Flow } from "@/lib/flows/types";

/* Isolated state only: this suite drives the production pipeline controller
   over a store of its own and must never read or write the operator's. */
process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-severed-turn-resume-"));
const { createPipelineFromRequest, tickPipelines, patchPipeline, reportStageCompletion } = await import("./engine");
const { loadPipelines, savePipelines } = await import("./store");
const { registerPipelineTick } = await import("./controllerSignal");
type PipelinePorts = import("./engine").PipelinePorts;
type StageTurnEvidence = import("./durableEvidence").StageTurnEvidence;

/* A tick this suite did not ask for must never reach the real ports. */
registerPipelineTick(async () => {});

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

const STAGE_TRANSCRIPT = "/claude/stage-1.jsonl";
const STAGE_CONVERSATION = "conversation_stage_1";

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
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 1, stdout: "", stderr: "" };
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
    repoDir: path.join(process.env.LLV_STATE_DIR!, "repo"),
    src: "/claude/creator.jsonl",
    stages: [{ id: "plan", kind: "run", role: { roleId: "architect" }, access: "read-only", "prompt": "Plan", next: null }],
  } as never, h.ports);
  if (!created.pipeline) throw new Error(created.error);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  const running = loadPipelines()[0]!;
  expect(running.runs[0]!.attempts[0]).toMatchObject({ state: "running", paneId: null, conversationId: STAGE_CONVERSATION });
  expect(running.runs[0]!.attempts[0]!.hostEpoch).toBe(1_015);
  fs.mkdirSync(running.worktreeDir, { recursive: true });
  return running;
}

test("apply now admits a durable switch on the same running attempt", async () => {
  const h = harness();
  const pipeline = await runningStage(h);
  const result = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", model: "opus", applyNow: true }, h.ports, { kind: "operator" });
  expect(result.error).toBeUndefined();
  expect(result.runtimeSwitch).toMatchObject({ phase: "requested", mode: "fork", to: { model: "opus" } });
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.n).toBe(1);
  expect(attempt.effectiveRole.model).toBe("fable");
  expect(attempt.runtimeSwitches).toHaveLength(1);
});

function switchHarness() {
  const h = harness();
  const operations = new Map<string, string>();
  const deliveries = new Map<string, { state: "delivered" | "failed" | "pending"; at: string }>();
  let outcome: "pending" | "applied" | "failed" | "superseded" = "applied";
  let seat: import("./types").PipelineRuntimeSeat & { sessionId: string; agentPath: string } = { engine: "claude", model: "fable", effort: "high", serviceTier: null, accountId: "default", sessionId: "session-new", agentPath: STAGE_TRANSCRIPT };
  h.ports.runtimeSwitchControl = async (_id, _path, action, key, target) => { operations.set(key, action); if (action === "reconfigure" && (outcome === "applied" || outcome === "superseded")) seat = { ...seat, ...target }; };
  h.ports.runtimeSwitchOutcome = async () => ({ state: outcome, error: outcome === "failed" ? "account refused" : undefined });
  h.ports.runtimeSwitchDelivery = (_id, key) => deliveries.get(key) ?? { state: "pending" };
  h.ports.cancelRuntimeSwitch = async () => { operations.set("cancel", "cancel"); };
  h.ports.conversationGeneration = () => seat;
  h.ports.resumeSeveredTurn = async (input) => { if (!deliveries.has(input.clientMessageId)) h.continuations.push(input); deliveries.set(input.clientMessageId, { state: "delivered", at: new Date(h.wallClock()+1).toISOString() }); return true; };
  return { ...h, operations, deliveries, setOutcome: (value: typeof outcome) => { outcome = value; }, setSeat: (value: typeof seat) => { seat = value; } };
}
async function requestSwitch(h: ReturnType<typeof switchHarness>, body = {}) {
  const pipeline = await runningStage(h);
  return await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", model: "opus", applyNow: true, ...body }, h.ports, { kind: "operator" });
}
test("a model switch interrupts, reconfigures and continues once, keeping the attempt and receipts", async () => {
  const h = switchHarness(); const requested = await requestSwitch(h);
  await tickPipelines([], h.ports);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.runtimeSwitches?.[0]?.phase).toBe("committed");
  expect([...h.operations.values()]).toEqual(["interrupt", "reconfigure"]);
  expect(h.continuations).toHaveLength(1);
  expect(h.continuations[0]?.text).not.toContain("cut by aborted");
  expect(attempt).toMatchObject({ n: 1, conversationId: STAGE_CONVERSATION, launchId: "launch-1", effectiveRole: { model: "opus" } });
  expect(attempt.providerWait).toBeUndefined();
  expect(attempt.definition?.prompt).toBe("Plan");
  expect(requested.pipeline?.branch).toBe(loadPipelines()[0]?.branch);
});
test("concurrent requests replay one target and refuse a different target", async () => {
  const h = switchHarness(); const first = await requestSwitch(h); const id = first.pipeline!.id;
  const replay = await patchPipeline(id, { action: "override-stage", stageId: "plan", model: "opus", applyNow: true }, h.ports);
  expect(replay).toMatchObject({ replayed: true, runtimeSwitch: { id: first.runtimeSwitch!.id } });
  const conflict = await patchPipeline(id, { action: "override-stage", stageId: "plan", model: "sonnet", applyNow: true }, h.ports);
  expect(conflict).toMatchObject({ status: 409, code: "RUNTIME_SWITCH_IN_PROGRESS" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches).toHaveLength(1);
});
test("persisted switching replays deterministic operations and owes only one continuation", async () => {
  const h = switchHarness(); h.setOutcome("pending"); await requestSwitch(h);
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  expect([...h.operations.values()]).toEqual(["interrupt", "reconfigure"]);
  expect(h.continuations).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.providerWait).toBeUndefined();
  h.setOutcome("applied"); await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("committed");
});
test("a failed account switch releases the hold and delivers a keyed rollback", async () => {
  const h = switchHarness(); h.setOutcome("failed");
  h.ports.resumeSeveredTurn = async input => { h.continuations.push(input); h.deliveries.set(input.clientMessageId, { state: input.clientMessageId.endsWith("rollback") ? "delivered" : "failed", at: new Date(h.wallClock()+1).toISOString() }); return true; };
  await requestSwitch(h); await tickPipelines([], h.ports);
  h.setSeat({ engine: "claude", model: "fable", effort: "high", serviceTier: null, accountId: "default", sessionId: "session-1", agentPath: STAGE_TRANSCRIPT });
  await tickPipelines([], h.ports);
  expect(h.operations.get("cancel")).toBe("cancel");
  expect(h.continuations.filter(item => item.clientMessageId.endsWith("rollback"))).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!).toMatchObject({ n: 1, effectiveRole: { model: "fable" }, runtimeSwitches: [{ phase: "rolled-back" }] });
});
test("apply now refuses prompt edits, reports and unrelated agents", async () => {
  const h = switchHarness(); const pipeline = await runningStage(h);
  expect(await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", prompt: "Changed", applyNow: true }, h.ports)).toMatchObject({ status: 400 });
  expect(await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", model: "opus", applyNow: true }, h.ports, { kind: "agent", conversationId: "conversation_unrelated", role: "builder" })).toMatchObject({ status: 403 });
});

test("engine change stops before spawning and keeps the slot, access and attempt", async () => {
  const h = switchHarness(); const pipeline = await runningStage(h);
  const calls: string[] = []; let input: Parameters<PipelinePorts["spawnAgent"]>[0] | undefined;
  h.ports.allowedAccountIds = () => ["default"];
  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "codex", accountId: "default", kind: "default", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: {} } } as never);
  h.ports.stopStageAgent = async () => { calls.push("stop"); return { outcome: "stopped" }; };
  h.ports.spawnAgent = async (value, reserved) => { calls.push("spawn"); input = value; await reserved({ launchId: "launch-new", conversationId: "conversation_new", accountId: "default" }); return { launchId: "launch-new", conversationId: "conversation_new", accountId: "default", sessionId: "session-new", transcript: "/codex/new.jsonl", paneId: null }; };
  const request = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", engine: "codex", model: "gpt-6.1-sol", effort: "high", applyNow: true }, h.ports);
  expect(request.error).toBeUndefined();
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).not.toContain("waiting:");
  expect(calls).toEqual(["stop", "spawn"]);
  expect(input).toMatchObject({ supersedes: STAGE_CONVERSATION, membership: { slot: "plan:1", round: 1 }, runtimeProfile: { access: "read-only", sandbox: "full" } });
  expect(Buffer.byteLength(input!.prompt)).toBeLessThanOrEqual(32000);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!).toMatchObject({ n: 1, conversationId: "conversation_new", runtimeSwitches: [{ mode: "handoff", phase: "committed" }] });
});

test("quota-neutral switches suppress their own abort notice and old verdicts", async () => {
  const h = switchHarness(); await requestSwitch(h); const cut = h.wallClock();
  await tickPipelines([], h.ports);
  h.setTurn({ turn: "terminal", message: { text: '```json\n{"status":"pass","findings":[]}\n```', ts: cut }, terminalProviderMessage: { text: "aborted", errorClass: "turn_aborted", ts: cut } });
  await tickPipelines([], h.ports);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.state).toBe("running"); expect(attempt.providerWait).toBeUndefined();
  h.setTurn({ turn: "terminal", message: { text: '```json\n{"status":"pass","findings":[]}\n```', ts: cut + 2 } });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
});
test("a failed profile-only switch with a delivered continuation sends no rollback", async () => {
  const h = switchHarness(); h.setOutcome("failed"); await requestSwitch(h); await tickPipelines([], h.ports);
  expect(h.continuations).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("rolled-back");
});
test("a superseding runtime selection follows its actual generation and one continuation", async () => {
  const h = switchHarness(); h.setOutcome("superseded"); await requestSwitch(h); await tickPipelines([], h.ports);
  expect(h.continuations).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!).toMatchObject({ effectiveRole: { model: "opus" }, runtimeSwitches: [{ phase: "superseded" }] });
});
test("budget expiry cancels the accepted switch and rolls back with one continuation", async () => {
  const h = switchHarness(); h.setOutcome("pending"); await requestSwitch(h); await tickPipelines([], h.ports);
  h.advance(10 * 60_000); await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  expect(h.operations.get("cancel")).toBe("cancel");
  expect(h.continuations).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("rolled-back");
});
test("a cancellation that cannot be confirmed parks with its reason", async () => {
  const h = switchHarness(); h.setOutcome("pending");
  h.ports.cancelRuntimeSwitch = async () => { throw new Error("switch has already started"); };
  await requestSwitch(h); await tickPipelines([], h.ports); h.advance(10 * 60_000); await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: expect.stringContaining("switch has already started") });
  expect(h.continuations).toHaveLength(1);
});
test("operator kill supersedes the switch without resurrecting the stage", async () => {
  const h = switchHarness(); await requestSwitch(h); h.ports.runtimeSwitchKilled = async () => true;
  await tickPipelines([], h.ports);
  expect(h.operations.size).toBe(0); expect(h.continuations).toHaveLength(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]).toMatchObject({ phase: "failed", outcome: expect.stringContaining("kill") });
});
test("closing the lane supersedes a requested switch without dispatching it", async () => {
  const h = switchHarness(); const requested = await requestSwitch(h);
  await patchPipeline(requested.pipeline!.id, { action: "close" }, h.ports);
  await tickPipelines([], h.ports);
  expect(h.operations.size).toBe(0); expect(h.continuations).toHaveLength(0);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("superseded");
});
for (const change of ["paused", "spawning", "pane", "historical", "reported"] as const) {
  test(`apply now refuses ${change} without changing the stage`, async () => {
    const h = switchHarness(); const lane = await runningStage(h); const attempt = lane.runs[0]!.attempts[0]!;
    if (change === "paused") lane.state = "paused";
    if (change === "spawning") attempt.state = "spawning";
    if (change === "pane") attempt.paneId = "%1";
    if (change === "historical") attempt.historical = true;
    if (change === "reported") attempt.report = { seq: 1, calls: 1, at: h.ports.now(), verdict: { status: "pass", findings: [] }, summary: null, conversationId: STAGE_CONVERSATION, launchId: "launch-1", actor: { kind: "agent", role: "architect", conversationId: STAGE_CONVERSATION }, provenance: { head: null, branch: lane.branch, uncommitted: [], pullRequest: null, outputs: [] } } as never;
    savePipelines([lane]);
    const result = await patchPipeline(lane.id, { action: "override-stage", stageId: "plan", model: "opus", applyNow: true }, h.ports);
    expect(result.status).toBe(409);
    expect(loadPipelines()[0]!.stages[0]!.effectiveRole.model).toBe("fable");
  });
}
test("the current runtime is a no-op with no switch record", async () => {
  const h = switchHarness(); const lane = await runningStage(h);
  expect(await patchPipeline(lane.id, { action: "override-stage", stageId: "plan", applyNow: true }, h.ports)).toMatchObject({ runtimeSwitch: null, appliedNow: "already-current" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches).toBeUndefined();
});
test("an unconfirmed handoff stop never spawns a second agent", async () => {
  const h = switchHarness(); const lane = await runningStage(h);
  h.ports.allowedAccountIds = () => ["default"];
  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "codex", accountId: "default", kind: "managed", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" } } });
  h.ports.stopStageAgent = async () => ({ outcome: "failed", error: "identity changed" });
  const result = await patchPipeline(lane.id, { action: "override-stage", stageId: "plan", engine: "codex", model: "gpt-6.1-sol", applyNow: true }, h.ports);
  expect(result.error).toBeUndefined(); await tickPipelines([], h.ports);
  expect(h.spawnCount()).toBe(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!).toMatchObject({ conversationId: STAGE_CONVERSATION, runtimeSwitches: [{ phase: "failed" }] });
});


test("creator can move its stage before any orchestrator seat exists", async () => {
  const h = switchHarness(); const pipeline = await runningStage(h);
  const result = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", model: "opus", applyNow: true }, h.ports, { kind: "agent", conversationId: "conversation_creator", role: "builder" });
  expect(result.error).toBeUndefined();
  expect(result.runtimeSwitch?.phase).toBe("requested");
});
test("an already-current runtime can still persist a changed account pin for future attempts", async () => {
  const h = switchHarness(); const pipeline = await runningStage(h);
  const result = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", account: "default", applyNow: true }, h.ports);
  expect(result.appliedNow).toBe("already-current");
  expect(loadPipelines()[0]!.stages[0]!.account).toBe("default");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches).toBeUndefined();
});
test("switch admission uses project selection with continuity and known exhausted accounts", async () => {
  const h = switchHarness(); const pipeline = await runningStage(h);
  const state = loadPipelines(); state[0]!.runs[0]!.attempts[0]!.usageLimitedAccounts = [{ engine: "claude", accountId: "default", limitedAt: h.wallClock(), resetsAt: null }]; savePipelines(state);
  h.ports.allowedAccountIds = () => ["default", "account-b"];
  const selections: unknown[] = [];
  h.ports.resolveProjectSpawn = (_engine, request) => { selections.push(request); return { kind: "available", account: { accountId: "account-b" } } as never; };
  const answer = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", model: "opus", applyNow: true }, h.ports);
  expect(selections).toMatchObject([{ project: "viewer", preferredId: "default", unavailableIds: ["default"] }]);
  expect(answer.runtimeSwitch?.to.accountId).toBe("account-b");
});
test("a handoff stop's own kill boundary cannot cancel reconciliation after spawn fails before reservation", async () => {
  const h = switchHarness(); h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "default" } } as never);
  const request = await requestSwitch(h, { engine: "codex", model: "gpt-6.1-sol", effort: "high" }); expect(request.error).toBeUndefined();
  let ownKillAt = 0;
  h.ports.stopStageAgent = async () => { h.advance(1000); ownKillAt = h.wallClock(); h.advance(1); return { outcome: "stopped" }; };
  h.ports.runtimeSwitchKilled = async (_id, since, ignored) => ownKillAt > Date.parse(since) && !ignored?.some(key => key.endsWith("-stop"));
  h.ports.spawnAgent = async () => { throw new Error("target unavailable"); };
  await tickPipelines([], h.ports);
  h.setSeat({ engine: "claude", model: "fable", effort: "high", serviceTier: null, accountId: "default", sessionId: "session-1", agentPath: STAGE_TRANSCRIPT });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("rolled-back");
});

test("resetting a runtime field resolves the existing native generation before cutting", async () => {
  const h = switchHarness(); const answer = await requestSwitch(h, { model: null, effort: "xhigh" });
  expect(answer.error).toBeUndefined();
  expect(answer.runtimeSwitch?.to.model).toBe("fable");
});
test("kill boundary lookup includes later pages and fails closed on a stalled cursor", async () => {
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const calls: number[] = [];
  const client = { effectBatch: async (_kinds: unknown, after = 0) => { calls.push(after); return after === 0 ? Array.from({ length: 100 }, (_, index) => ({ eventSeq: index + 1, payload: { conversationId: "conversation_other", operationId: `old-${index}` } })) : [{ eventSeq: 101, payload: { conversationId: STAGE_CONVERSATION, operationId: "kill-new" } }]; }, operationStatus: async () => ({ receipt: { admittedAt: "2026-10-02T10:01:00Z", at: "2026-10-02T10:01:01Z" } }) };
  expect(await hasRuntimeSwitchKill(client as never, STAGE_CONVERSATION, "2026-10-02T10:00:00Z")).toBe(true);
  expect(calls).toEqual([0, 100]);
});
test("cancellation cannot claim success when withdrawal loses to a queue claim", async () => {
  const { cancelPendingRuntimeSwitch } = await import("./runtimeSwitch");
  let released = false;
  const registry = { conversation: () => ({}), withdrawConversationReconfigure: () => ({ kind: "claimed", conversation: {} }), releaseSwitchHold: () => { released = true; } };
  expect(() => cancelPendingRuntimeSwitch(registry as never, STAGE_CONVERSATION, "switch-one")).toThrow("already applying");
  expect(released).toBe(false);
});

test("rollback reuses a pending held continuation that cancellation rearms", async () => {
  const h = switchHarness(); h.setOutcome("pending");
  h.ports.resumeSeveredTurn = async input => { if (!h.deliveries.has(input.clientMessageId)) { h.continuations.push(input); h.deliveries.set(input.clientMessageId, { state: "pending", at: h.ports.now() }); } return true; };
  h.ports.cancelRuntimeSwitch = async () => { for (const [key] of h.deliveries) h.deliveries.set(key, { state: "delivered", at: h.ports.now() }); };
  await requestSwitch(h); await tickPipelines([], h.ports); h.advance(10 * 60_000); await tickPipelines([], h.ports);
  expect(h.continuations).toHaveLength(1);
  h.setSeat({ engine: "claude", model: "fable", effort: "high", serviceTier: null, accountId: "default", sessionId: "session-1", agentPath: STAGE_TRANSCRIPT });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("rolled-back");
});
test("a crash after the owned stop replays that stop and excludes only its kill boundary", async () => {
  const h = switchHarness(); h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "default" } } as never);
  await requestSwitch(h, { engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  let ownKey: string | undefined; let calls = 0;
  h.ports.runtimeSwitchKilled = async (_id, _since, ignored) => !!ownKey && !ignored?.includes(ownKey);
  h.ports.stopStageAgent = async (_target, options) => { ownKey = options?.operationId; calls++; if (calls === 1) throw new Error("crash after accepted stop"); return { outcome: "stopped" }; };
  h.ports.spawnAgent = async (_input, reserved) => { await reserved({ launchId: "launch-new", conversationId: "conversation_new", accountId: "default" }); return { launchId: "launch-new", conversationId: "conversation_new", accountId: "default", sessionId: "new", transcript: "/codex/new.jsonl", paneId: null }; };
  await tickPipelines([], h.ports); expect(ownKey).toBeString(); await tickPipelines([], h.ports);
  expect(calls).toBe(2);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("committed");
});

test("handoff accepts an early successor verdict and rejects the former conversation's report", async () => {
  const h = switchHarness(); h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "default" } } as never);
  await requestSwitch(h, { engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  const cut = h.wallClock();
  h.ports.spawnAgent = async (_input, reserved) => { await reserved({ launchId: "launch-new", conversationId: "conversation_new", accountId: "default" }); h.advance(1000); return { launchId: "launch-new", conversationId: "conversation_new", accountId: "default", sessionId: "new", transcript: "/codex/new.jsonl", paneId: null }; };
  await tickPipelines([], h.ports);
  const refused = await reportStageCompletion({ verdict: "pass", findings: [] }, { kind: "agent", conversationId: STAGE_CONVERSATION, role: "builder" }, h.ports);
  expect(refused).toMatchObject({ status: 403, code: "STAGE_REPORT_SUPERSEDED" });
  h.setTurn({ turn: "terminal", message: { text: '```json\n{"status":"pass","findings":[]}\n```', ts: cut + 10 } });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
});

test("an unresolved running identity is refused before any runtime edit", async () => {
  const h = switchHarness(); const pipeline = await runningStage(h); const records = loadPipelines(); records[0]!.runs[0]!.attempts[0]!.conversationId = null; savePipelines(records);
  const answer = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", model: "opus", applyNow: true }, h.ports);
  expect(answer).toMatchObject({ status: 409, code: "RUNTIME_SWITCH_UNAVAILABLE" }); expect(loadPipelines()[0]!.stages[0]!.effectiveRole.model).toBe("fable");
});

test("a kill during switching stays fenced across later recovery ticks", async () => {
  const h = switchHarness(); await requestSwitch(h); h.ports.runtimeSwitchKilled = async () => true;
  await tickPipelines([], h.ports); h.advance(60_000);
  h.ports.conversationAgentActive = async () => false;
  h.setTurn({ turn: "terminal", message: null, terminalProviderMessage: { text: "aborted", errorClass: "turn_aborted", ts: h.wallClock() } });
  await tickPipelines([], h.ports); h.advance(60_000); await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision", stateDetail: "stage stopped by kill during runtime switch" });
  expect(h.continuations).toHaveLength(0); expect(h.spawnCount()).toBe(1);
});

for (const pinned of [true, false]) test(`an already-current runtime updates its live pin (${pinned ? "clear" : "pin"})`, async () => {
  const { attemptAccountPin } = await import("./runtimeSwitch");
  const h = switchHarness(); const pipeline = await runningStage(h); const records = loadPipelines();
  if (pinned) { records[0]!.stages[0]!.account = "default"; records[0]!.runs[0]!.attempts[0]!.definition!.account = "default"; savePipelines(records); }
  const result = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", account: pinned ? null : "default", applyNow: true }, h.ports);
  expect(result.appliedNow).toBe("already-current");
  const stored = loadPipelines()[0]!;
  expect(attemptAccountPin(stored.stages[0]!, stored.runs[0]!.attempts[0]!)).toBe(pinned ? null : "default");
});

for (const action of ["pause", "close"] as const) test(`a held handoff launch leaves ${action} admission free and cannot overwrite it`, async () => {
  const h = switchHarness(); h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "default" } } as never);
  const request = await requestSwitch(h, { engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  let enter!: () => void; let release!: () => void; let dispatched = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  h.ports.spawnAgent = async (_input, reserved) => {
    enter(); await held;
    await reserved({ launchId: "launch-new", conversationId: "conversation_new", accountId: "default" });
    dispatched = true;
    return { launchId: "launch-new", conversationId: "conversation_new", accountId: "default", sessionId: "new", transcript: "/codex/new.jsonl", paneId: null };
  };
  const work = tickPipelines([], h.ports); await entered;
  const oldWait = process.env.LLV_PIPELINE_LOCK_WAIT_MS; process.env.LLV_PIPELINE_LOCK_WAIT_MS = "20";
  try {
    const result = await patchPipeline(request.pipeline!.id, { action }, h.ports);
    expect(result.error).toBeUndefined();
  } finally {
    if (oldWait === undefined) delete process.env.LLV_PIPELINE_LOCK_WAIT_MS; else process.env.LLV_PIPELINE_LOCK_WAIT_MS = oldWait;
    release(); await work;
  }
  expect(dispatched).toBe(false);
  expect(loadPipelines()[0]!.state).toBe(action === "close" ? "closed" : "paused");
});

test("a Codex tier fallback can hand off to Claude and persist the successor runtime", async () => {
  const h = switchHarness();
  h.ports.roleLookup = () => ({ engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-only", promptScaffold: "Architect guidance" });
  h.setSeat({ engine: "codex", model: "gpt-6.1-sol", effort: "high", serviceTier: null, accountId: "default", sessionId: "session-1", agentPath: STAGE_TRANSCRIPT } as never);
  const pipeline = await runningStage(h); const rows = loadPipelines();
  rows[0]!.runs[0]!.attempts[0]!.effectiveRole.preferredServiceTier = "priority";
  rows[0]!.runs[0]!.attempts[0]!.effectiveRole.serviceTierSource = "role-default";
  savePipelines(rows);
  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "default" } } as never);
  let successorRole: Parameters<PipelinePorts["spawnAgent"]>[0]["role"] | undefined;
  h.ports.spawnAgent = async (input, reserved) => { successorRole = input.role; await reserved({ launchId: "launch-new", conversationId: "conversation_new", accountId: "default" }); return { launchId: "launch-new", conversationId: "conversation_new", accountId: "default", sessionId: "new", transcript: "/claude/new.jsonl", paneId: null }; };
  const answer = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", engine: "claude", model: "opus", effort: "high", applyNow: true }, h.ports);
  expect(answer.error).toBeUndefined(); await tickPipelines([], h.ports);
  expect(successorRole?.preferredServiceTier).toBeUndefined();
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt).toMatchObject({ conversationId: "conversation_new", effectiveRole: { engine: "claude", model: "opus" }, runtimeSwitches: [{ phase: "committed" }] });
  expect(attempt.effectiveRole.preferredServiceTier).toBeUndefined();
});

test("a receipt-free already-current reconfigure continues once and commits promptly", async () => {
  const h = switchHarness(); h.setOutcome("pending");
  h.ports.runtimeSwitchControl = async (_id, _path, action, key) => { h.operations.set(key, action); if (action === "reconfigure") { h.setSeat({ engine: "claude", model: "opus", effort: "high", serviceTier: null, accountId: "default", sessionId: "session-new", agentPath: STAGE_TRANSCRIPT }); return "already-current"; } };
  await requestSwitch(h); await tickPipelines([], h.ports);
  expect(h.continuations).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!).toMatchObject({ effectiveRole: { model: "opus" }, runtimeSwitches: [{ phase: "committed" }] });
});

test("apply now observes a native runtime change before the pipeline rebinds", async () => {
  const h = switchHarness();
  h.setSeat({ engine: "claude", model: "opus", effort: "high", serviceTier: null, accountId: "default", sessionId: "session-new", agentPath: STAGE_TRANSCRIPT });
  const answer = await requestSwitch(h);
  expect(answer.appliedNow).toBe("already-current");
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!).toMatchObject({ effectiveRole: { model: "opus" }, sessionId: "session-new" });
  expect(h.operations.size).toBe(0); expect(h.continuations).toHaveLength(0);
});

test("a retained kill boundary with a compacted receipt fences switch continuation", async () => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const h = switchHarness(); h.setOutcome("pending"); await requestSwitch(h); await tickPipelines([], h.ports);
  let now = h.wallClock() + 1;
  const journal = new RuntimeJournal(path.join(process.env.LLV_STATE_DIR!, "compacted-kill.sqlite"), { structuredHosts: true, now: () => now });
  const key = { engine: "claude" as const, sessionId: "stage-session" };
  try {
    journal.executeOperation({ kind: "kill", operationId: "operator-kill", idempotencyKey: "operator-kill", conversationId: STAGE_CONVERSATION, sessionKey: key });
    journal.transitionOperation("operator-kill", "delivering"); now++; journal.transitionOperation("operator-kill", "delivered"); now++;
    journal.append({ scope: { type: "session", id: STAGE_CONVERSATION }, kind: "session-status", payload: { conversationId: STAGE_CONVERSATION, sessionKey: key, host: "dead", turn: "idle", activeTurnId: null } });
    journal.compact(1);
    expect(journal.operationResult("operator-kill")).toBeNull();
    const client = { effectBatch: async (kinds: string[], cursor: number) => journal.effectBatch(100, kinds, cursor), operationStatus: async (id: string) => journal.operationResult(id) };
    await expect(hasRuntimeSwitchKill(client as never, STAGE_CONVERSATION, new Date(h.wallClock()).toISOString())).rejects.toThrow("kill boundary");
    h.ports.runtimeSwitchKilled = (id, since, ignored) => hasRuntimeSwitchKill(client as never, id, since, ignored);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.stateDetail).toContain("kill boundary");
    h.advance(10 * 60_000); await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.state).toBe("needs_decision"); expect(h.continuations).toHaveLength(1);
  } finally { journal.close(); }
});
