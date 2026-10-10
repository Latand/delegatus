import { afterAll, expect, spyOn, test } from "bun:test";
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
  const readTurn = h.ports.durableTurnEvidence;
  let continuationStart = h.wallClock() + 1;
  h.ports.durableTurnEvidence = async (...args) => {
    const evidence = await readTurn(...args);
    return evidence && deliveries.size ? { ...evidence, turnStartedAt: evidence.turnStartedAt ?? continuationStart } : evidence;
  };
  h.ports.resumeSeveredTurn = async (input) => { if (!deliveries.has(input.clientMessageId)) { h.continuations.push(input); continuationStart = h.wallClock() + 1; } deliveries.set(input.clientMessageId, { state: "delivered", at: new Date(h.wallClock()+1).toISOString() }); return true; };
  return { ...h, operations, deliveries, setOutcome: (value: typeof outcome) => { outcome = value; }, setSeat: (value: typeof seat) => { seat = value; } };
}
async function requestSwitch(h: ReturnType<typeof switchHarness>, body = {}) {
  const pipeline = await runningStage(h);
  return await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", model: "opus", applyNow: true, ...body }, h.ports, { kind: "operator" });
}

test("the production runtime-switch control preserves the fast flag for Ultrafast", async () => {
  const controls = await import("@/lib/runtime/structuredControls");
  const { defaultPipelinePorts } = await import("./engine");
  const requests: import("@/lib/runtime/structuredControls").StructuredControlRequest[] = [];
  const dispatch = spyOn(controls, "dispatchStructuredControl").mockImplementation(async request => {
    requests.push(request);
    return { status: 202, body: { ok: true, structured: true, target: request.conversationId, operationId: request.operationId!, receipt: { operationId: request.operationId!, status: "queued" } } };
  });
  try {
    await defaultPipelinePorts().runtimeSwitchControl!("conversation_tier_control", "/codex/tier-control.jsonl", "reconfigure", "tier-control",
      { engine: "codex", model: "gpt-6-astra", effort: "high", serviceTier: "ultrafast", accountId: "default", accountPinned: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.reconfiguration).toMatchObject({ fast: true });
  } finally { dispatch.mockRestore(); }
});

for (const edit of ["model", "effort", "account", "standard", "priority"] as const) {
  test(`a displayed Ultrafast stage choice reaches its native generation and pipeline projection: ${edit}`, async () => {
    const { AgentRegistry } = await import("@/lib/agent/registry");
    const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
    const { applyStructuredReconfigure } = await import("@/lib/runtime/structuredReconfigure");
    const { pipelineSwitchFence, switchOperationKey } = await import("./runtimeSwitchFence");
    const { createManagedCodexAccount, listCodexAccounts } = await import("@/lib/accounts/codex");
    const targetAccount = createManagedCodexAccount(`Tier account ${edit}`);
    for (const account of listCodexAccounts()) {
      fs.mkdirSync(account.home, { recursive: true });
      fs.writeFileSync(path.join(account.home, "models_cache.json"), JSON.stringify({ models: ["gpt-6-astra", "gpt-6.1-sol"].map(slug => ({ slug, service_tiers: [{ id: "priority" }, { id: "ultrafast" }] })) }));
    }
    const h = switchHarness();
    h.ports.roleLookup = () => ({ engine: "codex", model: "gpt-6-astra", effort: "high", serviceTier: "ultrafast", access: "read-only", promptScaffold: "Stage guidance" });
    const lane = await runningStage(h);
    const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `tier-${edit}.json`));
    const transcript = path.join(process.env.LLV_STATE_DIR!, `rollout-${crypto.randomUUID()}.jsonl`);
    registry.reconcileConversations([{
      engine: "codex", path: transcript, accountId: "default",
      launchProfile: emptyLaunchProfile({ cwd: lane.worktreeDir, title: "Stage tier", model: "gpt-6-astra", effort: "high", fast: true, serviceTier: "ultrafast" }),
      turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: h.ports.now(),
    }]);
    const conversationId = registry.conversationForPath(transcript)!.id;
    const records = loadPipelines();
    Object.assign(records[0]!.runs[0]!.attempts[0]!, { conversationId, agentPath: transcript });
    savePipelines(records);
    h.ports.pathForConversation = () => transcript;
    h.ports.conversationIdForPath = () => conversationId;
    h.ports.conversationGeneration = () => {
      const generation = registry.conversation(conversationId)!.generations.at(-1)!;
      return { engine: "codex", model: generation.launchProfile.model, effort: generation.launchProfile.effort, serviceTier: generation.launchProfile.serviceTier ?? null,
        accountId: generation.accountId, sessionId: generation.id, agentPath: generation.path };
    };
    let nativeStarts = 0;
    const nativeProfiles: unknown[] = [];
    h.ports.runtimeSwitchControl = async (_id, _path, action, key, target) => {
      h.operations.set(key, action);
      if (action !== "reconfigure") return;
      await applyStructuredReconfigure({ kind: "reconfigure", operationId: key, conversationId,
        model: target!.model!, effort: target!.effort!, fast: ![null, "standard", "default"].includes(target!.serviceTier), accountId: target!.accountId!, eventSeq: 1 }, {
        registry, validateAccount: async () => {}, resolveAccount: () => ({}) as never, releaseHost: async () => true,
        recover: async () => {
          nativeStarts += 1;
          nativeProfiles.push(registry.conversation(conversationId)!.generations.at(-1)!.launchProfile);
          return { target: null, path: transcript, conversationId, spawned: true };
        },
        migrate: async (id, accountId, store, _owns, _operation, authorize) => {
          await authorize?.();
          let migration = store.conversation(id)!.migration!;
          migration = store.transitionConversationMigration(id, migration.revision, [migration.phase], { phase: "successor-starting" }).migration!;
          const receipt = { operationId: migration.operationId, nativeId: crypto.randomUUID(), path: transcript + ".successor.jsonl", continuityPaths: [], historyHash: "tier-history",
            host: { kind: "codex-app-server" as const, identity: "tier-successor", epoch: 1, verifiedAt: h.ports.now() } };
          store.persistMigrationProviderReceipt(id, migration.revision, migration.operationId, receipt);
          const committed = store.commitSuccessor(id, { id: receipt.nativeId, path: receipt.path, accountId, historyHash: receipt.historyHash, host: receipt.host }, migration.revision, migration.operationId, receipt);
          nativeStarts += 1;
          nativeProfiles.push(committed.generations.at(-1)!.launchProfile);
          return committed;
        },
      });
    };
    const tier = edit === "standard" ? "standard" : edit === "priority" ? "priority" : "ultrafast";
    const body = { action: "override-stage" as const, stageId: "plan", engine: "codex" as const, model: edit === "model" ? "gpt-6.1-sol" : "gpt-6-astra",
      effort: edit === "effort" ? "xhigh" : "high", serviceTier: tier, ...(edit === "account" ? { account: targetAccount.id } : {}), applyNow: true };
    const result = await patchPipeline(lane.id, body, h.ports, { kind: "operator" });
    expect(result.error).toBeUndefined();
    expect(result.runtimeSwitch?.to.serviceTier).toBe(tier);
    expect(pipelineSwitchFence(switchOperationKey(result.runtimeSwitch!, "reconfigure"))!.serviceTier).toBe(tier === "standard" ? null : tier);
    expect(await patchPipeline(lane.id, body, h.ports, { kind: "operator" })).toMatchObject({ replayed: true, runtimeSwitch: { id: result.runtimeSwitch!.id } });
    await tickPipelines([], h.ports);
    const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
    expect(attempt.runtimeSwitches).toHaveLength(1);
    expect(attempt.runtimeSwitches![0]!.phase).toBe("committed");
    expect(nativeStarts).toBe(1);
    expect(nativeProfiles).toEqual([expect.objectContaining({ fast: tier !== "standard" })]);
    expect((nativeProfiles[0] as import("@/lib/accounts/migration/contracts").LaunchProfile).serviceTier ?? null).toBe(tier === "standard" ? null : tier);
    expect(attempt.effectiveRole.serviceTier ?? null).toBe(tier === "standard" ? null : tier);
  });
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
test("a delivered failed switch cannot settle on a source account after its project authorization is revoked", async () => {
  const h = switchHarness(); h.setOutcome("pending");
  let allowed = ["default"];
  h.ports.allowedAccountIds = () => allowed;
  const readOutcome = h.ports.runtimeSwitchOutcome!;
  h.ports.runtimeSwitchOutcome = async (...args) => {
    const outcome = await readOutcome(...args);
    if (outcome?.state === "failed") allowed = ["other"];
    return outcome;
  };
  await requestSwitch(h);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("switching");
  h.setOutcome("failed");
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  expect(lane.state).toBe("needs_decision");
  expect(lane.stateDetail).toContain("source account is no longer allowed");
  expect(attempt.accountId).toBe("default");
  expect(attempt.runtimeSwitches?.[0]?.phase).toBe("switching");
});
test("an externally superseded continuation cannot adopt an account outside project policy", async () => {
  const h = switchHarness(); h.setOutcome("pending");
  h.ports.allowedAccountIds = () => ["default"];
  const readOutcome = h.ports.runtimeSwitchOutcome!;
  h.ports.runtimeSwitchOutcome = async (...args) => {
    const outcome = await readOutcome(...args);
    if (outcome?.state === "superseded") {
      h.setSeat({ engine: "claude", model: "sonnet", effort: "high", serviceTier: null, accountId: "outside", sessionId: "session-external", agentPath: STAGE_TRANSCRIPT });
    }
    return outcome;
  };
  await requestSwitch(h);
  await tickPipelines([], h.ports);
  h.setOutcome("superseded");
  await tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  expect(lane.state).toBe("needs_decision");
  expect(lane.stateDetail).toContain("actual account is no longer allowed");
  expect(attempt.accountId).toBe("default");
  expect(attempt.runtimeSwitches?.[0]?.phase).toBe("continuing");
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

test("switch-owned teardown preserves a failed operator stop through compaction", async () => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill, switchOperationKey } = await import("./runtimeSwitch");
  const h = switchHarness();
  const pipeline = await runningStage(h);
  const filename = path.join(process.env.LLV_STATE_DIR!, "switch-stop-custody.sqlite");
  let journal = new RuntimeJournal(filename, { structuredHosts: true, now: h.wallClock });
  const sessionKey = { engine: "claude" as const, sessionId: "switch-stop-session" };
  journal.executeOperation({ kind: "kill", operationId: "real-operator-stop", idempotencyKey: "real-operator-stop", conversationId: STAGE_CONVERSATION, sessionKey, origin: { kind: "operator" } });
  journal.transitionOperation("real-operator-stop", "failed");
  h.ports.allowedAccountIds = () => ["default"];
  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "codex", accountId: "default", kind: "default", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: {} } } as never);
  h.ports.stopStageAgent = async (target, options) => {
    const operationId = options!.operationId!;
    journal.executeOperation({ kind: "kill", operationId, idempotencyKey: operationId, conversationId: target.conversationId!, sessionKey,
      origin: options?.automatic ? { kind: "agent", role: "pipeline" } : { kind: "operator" } });
    journal.transitionOperation(operationId, "delivered");
    return { outcome: "stopped" };
  };
  h.ports.spawnAgent = async (_input, reserved) => {
    await reserved({ launchId: "launch-switch-successor", conversationId: "conversation_switch_successor", accountId: "default" });
    return { launchId: "launch-switch-successor", conversationId: "conversation_switch_successor", accountId: "default", sessionId: "switch-successor", transcript: "/codex/switch-successor.jsonl", paneId: null };
  };
  try {
    expect((await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", engine: "codex", model: "gpt-6.1-sol", applyNow: true }, h.ports)).error).toBeUndefined();
    await tickPipelines([], h.ports);
    const record = loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches![0]!;
    expect(record.phase).toBe("committed");
    journal.append({ scope: { type: "session", id: STAGE_CONVERSATION }, kind: "delta", payload: { text: "later history" } });
    journal.compact(1);
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true });
    const client = { effectBatch: async (kinds, cursor) => journal.effectBatch(100, kinds, cursor), operationStatus: async id => journal.operationResult(id) } as import("@/lib/runtime/client").RuntimeHostClient;
    expect(await hasRuntimeSwitchKill(client, STAGE_CONVERSATION, new Date(h.wallClock() - 1).toISOString(),
      [switchOperationKey(record, "stop"), switchOperationKey(record, "stop-launch")], true)).toBe(true);
  } finally { journal.close(); }
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
test("retry-stage stays fenced while a parked runtime switch still owns its continuation, including after engine restart", async () => {
  const h = switchHarness(); h.setOutcome("pending");
  h.ports.cancelRuntimeSwitch = async () => { throw new Error("switch has already started"); };
  const requested = await requestSwitch(h);
  await tickPipelines([], h.ports); h.advance(10 * 60_000); await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });

  // The retry receipt is complete, yet the accepted switch and queued continuation remain owned.
  h.ports.spawnReceipt = () => ({ state: "completed", launchId: "launch-1" } as never);
  const restarted = await import(`./engine?retry-fence-restart=${crypto.randomUUID()}`) as typeof import("./engine");
  const retry = await restarted.patchPipeline(requested.pipeline!.id, {
    action: "retry-stage", stageId: "plan", launchId: "launch-1", expectedStageId: "plan", expectedAttempt: 1,
  }, h.ports);
  expect(retry).toMatchObject({ status: 409, error: expect.stringContaining("runtime switch") });

  // The persisted open phase continues to fence ticks after a fresh engine module loads.
  await restarted.tickPipelines([], h.ports); await restarted.tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  expect(lane.runs[0]!.attempts).toHaveLength(1);
  expect(lane.runs[0]!.attempts[0]!.runtimeSwitches?.[0]).toMatchObject({ phase: "switching", continuationDispatch: { key: expect.any(String) } });
  expect(lane.cursor).toMatchObject({ stageId: "plan", state: "running" });
  expect(h.continuations).toHaveLength(1);
});
test("retry-stage refuses a dead-host running attempt while its runtime switch remains open", async () => {
  const h = switchHarness();
  const requested = await requestSwitch(h);
  let stops = 0;
  h.ports.resumeSeveredTurn = async () => false;
  h.ports.conversationTurnInterrupted = async () => "dead";
  h.ports.stopStageAgent = async () => { stops++; return { outcome: "not-running" }; };
  h.ports.spawnReceipt = () => ({ state: "completed", launchId: "launch-1" } as never);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("switching");

  const restarted = await import(`./engine?retry-open-switch=${crypto.randomUUID()}`) as typeof import("./engine");
  const retry = await restarted.patchPipeline(requested.pipeline!.id, {
    action: "retry-stage", stageId: "plan", launchId: "launch-1", expectedStageId: "plan", expectedAttempt: 1,
  }, h.ports);
  expect(retry).toMatchObject({ status: 409, error: expect.stringContaining("runtime switch") });
  await restarted.tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("switching");
  expect(stops).toBe(0);
  expect(h.spawnCount()).toBe(1);
});
test("a late successful parked switch accepts its successor verdict once after engine restart", async () => {
  const h = switchHarness(); h.setOutcome("pending");
  h.ports.cancelRuntimeSwitch = async () => { throw new Error("switch has already started"); };
  const requested = await requestSwitch(h);
  await tickPipelines([], h.ports);
  h.advance(10 * 60_000);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });

  h.setOutcome("applied");
  h.setSeat({ engine: "claude", model: "opus", effort: "high", serviceTier: null, accountId: "default", sessionId: "session-fork", agentPath: STAGE_TRANSCRIPT });
  h.setTurn({ turn: "terminal", turnStartedAt: h.wallClock() + 2, message: { text: "Completed in the fork", ts: h.wallClock() + 3 }, lastRecordAt: h.wallClock() + 3 });
  const report = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Completed in the fork" },
    { kind: "agent", conversationId: STAGE_CONVERSATION, role: "builder" }, h.ports);
  expect(report.error).toBeUndefined();

  const restarted = await import(`./engine?late-switch-restart=${crypto.randomUUID()}`) as typeof import("./engine");
  await restarted.tickPipelines([], h.ports);
  await restarted.tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  expect(attempt.runtimeSwitches?.[0]?.phase).toBe("committed");
  expect(attempt).toMatchObject({ n: 1, conversationId: STAGE_CONVERSATION, effectiveRole: { model: "opus" }, verdict: { status: "pass" } });
  expect(attempt.report?.calls).toBe(1);
  expect(attempt.runtimeSwitches).toHaveLength(1);
  expect(h.spawnCount()).toBe(1);
  expect(requested.pipeline!.runs[0]!.attempts[0]!.n).toBe(1);
});
test("a parked fork with a failed send uses one replacement continuation after its outcome settles", async () => {
  const h = switchHarness(); h.setOutcome("pending");
  h.ports.cancelRuntimeSwitch = async () => { throw new Error("switch has already started"); };
  let firstKey: string | null = null;
  h.ports.resumeSeveredTurn = async input => {
    if (firstKey === null) {
      firstKey = input.clientMessageId;
      h.continuations.push(input);
      h.deliveries.set(input.clientMessageId, { state: "failed", at: new Date(h.wallClock() + 1).toISOString() });
    } else if (input.clientMessageId !== firstKey) {
      h.continuations.push(input);
      h.deliveries.set(input.clientMessageId, { state: "delivered", at: new Date(h.wallClock() + 1).toISOString() });
    }
    return true;
  };
  const requested = await requestSwitch(h);
  await tickPipelines([], h.ports);
  h.advance(10 * 60_000);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });

  h.setOutcome("applied");
  h.setSeat({ engine: "claude", model: "opus", effort: "high", serviceTier: null, accountId: "default", sessionId: "session-fork", agentPath: STAGE_TRANSCRIPT });
  const restarted = await import(`./engine?late-send-restart=${crypto.randomUUID()}`) as typeof import("./engine");
  await restarted.tickPipelines([], h.ports);
  await restarted.tickPipelines([], h.ports);
  const continuationKeys = h.continuations.map(item => item.clientMessageId);
  expect(continuationKeys).toHaveLength(2);
  expect(new Set(continuationKeys).size).toBe(2);
  expect(continuationKeys[1]).toContain("continue-2");
  expect(h.deliveries.get(continuationKeys[1]!)?.state).toBe("delivered");

  h.setTurn({ turn: "terminal", turnStartedAt: h.wallClock() + 2, message: { text: "Completed after retry", ts: h.wallClock() + 3 }, lastRecordAt: h.wallClock() + 3 });
  const report = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Completed after retry" },
    { kind: "agent", conversationId: STAGE_CONVERSATION, role: "builder" }, h.ports);
  expect(report.error).toBeUndefined();
  await restarted.tickPipelines([], h.ports);
  await restarted.tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  expect(attempt.runtimeSwitches?.[0]?.phase).toBe("committed");
  expect(attempt).toMatchObject({ n: 1, effectiveRole: { model: "opus" }, verdict: { status: "pass" }, report: { calls: 1 } });
  expect(attempt.runtimeSwitches).toHaveLength(1);
  expect(h.spawnCount()).toBe(1);
  expect(requested.pipeline!.runs[0]!.attempts[0]!.n).toBe(1);
});
test("a completed parked handoff receipt settles its successor after engine restart", async () => {
  const h = switchHarness();
  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "default" } } as never);
  const requested = await requestSwitch(h, { engine: "codex", model: "gpt-6.1-sol" });
  let receipt: ReturnType<PipelinePorts["spawnReceipt"]> = null;
  let handoffCalls = 0;
  h.ports.spawnReceipt = () => receipt;
  h.ports.spawnAgent = async (_input, reserved) => {
    handoffCalls++;
    await reserved({ launchId: "launch-handoff", conversationId: "conversation_fork", accountId: "default" });
    throw new Error("launch acknowledgement lost");
  };
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]).toMatchObject({ conversationId: "conversation_fork", launchId: "launch-handoff", runtimeSwitches: [{ mode: "handoff", phase: "switching" }] });
  h.ports.stopStageAgent = async () => ({ outcome: "unconfirmed", operationId: null, detail: "receipt still pending" });
  h.advance(10 * 60_000);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });

  receipt = { state: "completed", launchId: "launch-handoff", conversationId: "conversation_fork", accountId: "default",
    sessionId: "session-fork", transcript: "/codex/fork.jsonl", paneId: null } as never;
  h.setTurn({ turn: "terminal", turnStartedAt: h.wallClock() + 2, message: { text: "Finished handoff", ts: h.wallClock() + 3 }, lastRecordAt: h.wallClock() + 3 });
  const report = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Finished handoff" },
    { kind: "agent", conversationId: "conversation_fork", role: "builder" }, h.ports);
  expect(report.error).toBeUndefined();

  const restarted = await import(`./engine?handoff-restart=${crypto.randomUUID()}`) as typeof import("./engine");
  await restarted.tickPipelines([], h.ports);
  await restarted.tickPipelines([], h.ports);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.runtimeSwitches?.[0]?.phase).toBe("committed");
  expect(attempt).toMatchObject({ n: 1, launchId: "launch-handoff", conversationId: "conversation_fork", verdict: { status: "pass" } });
  expect(attempt.report?.calls).toBe(1);
  expect(handoffCalls).toBe(1);
  expect(h.spawnCount()).toBe(1);
  expect(requested.pipeline!.runs[0]!.attempts[0]!.n).toBe(1);
});
test("a late failed reconfigure restores the authorized source continuation and its verdict", async () => {
  const h = switchHarness(); h.setOutcome("pending");
  h.ports.cancelRuntimeSwitch = async () => { throw new Error("switch has already started"); };
  const requested = await requestSwitch(h);
  await tickPipelines([], h.ports);
  h.advance(10 * 60_000);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });

  h.setOutcome("failed");
  h.setTurn({ turn: "terminal", turnStartedAt: h.wallClock() + 2, message: { text: "Finished on source runtime", ts: h.wallClock() + 3 }, lastRecordAt: h.wallClock() + 3 });
  const report = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Finished on source runtime" },
    { kind: "agent", conversationId: STAGE_CONVERSATION, role: "builder" }, h.ports);
  expect(report.error).toBeUndefined();

  const restarted = await import(`./engine?late-failure-restart=${crypto.randomUUID()}`) as typeof import("./engine");
  await restarted.tickPipelines([], h.ports);
  await restarted.tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  expect(attempt.runtimeSwitches?.[0]?.phase).toBe("rolled-back");
  expect(attempt).toMatchObject({ n: 1, conversationId: STAGE_CONVERSATION, effectiveRole: { model: "fable" }, verdict: { status: "pass" } });
  expect(attempt.report?.calls).toBe(1);
  expect(h.continuations).toHaveLength(1);
  expect(h.spawnCount()).toBe(1);
  expect(requested.pipeline!.runs[0]!.attempts[0]!.n).toBe(1);
});
test("a parked handoff resumes after the original stop is confirmed", async () => {
  const h = switchHarness();
  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "default" } } as never);
  const requested = await requestSwitch(h, { engine: "codex", model: "gpt-6.1-sol" });
  let stopConfirmed = false;
  let handoffCalls = 0;
  h.ports.stopStageAgent = async () => stopConfirmed
    ? { outcome: "stopped" }
    : { outcome: "unconfirmed", operationId: null, detail: "host stop is unconfirmed" };
  h.ports.spawnAgent = async (_input, reserved) => {
    handoffCalls++;
    await reserved({ launchId: "launch-resumed-handoff", conversationId: "conversation_fork", accountId: "default" });
    return { launchId: "launch-resumed-handoff", conversationId: "conversation_fork", sessionId: "session-fork",
      "transcript": "/codex/fork.jsonl", paneId: null, accountId: "default" } as never;
  };
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("cutting");
  h.advance(10 * 60_000);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });

  stopConfirmed = true;
  const restarted = await import(`./engine?cutting-restart=${crypto.randomUUID()}`) as typeof import("./engine");
  await restarted.tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  expect(lane.state).toBe("running");
  expect(attempt).toMatchObject({ n: 1, state: "running", launchId: "launch-resumed-handoff", conversationId: "conversation_fork", runtimeSwitches: [{ phase: "committed" }] });
  expect(handoffCalls).toBe(1);
  expect(h.spawnCount()).toBe(1);
  expect(requested.pipeline!.runs[0]!.attempts[0]!.n).toBe(1);
});
test("a late failed handoff receipt restores the authorized source conversation", async () => {
  const h = switchHarness();
  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "default" } } as never);
  const requested = await requestSwitch(h, { engine: "codex", model: "gpt-6.1-sol" });
  let receipt: ReturnType<PipelinePorts["spawnReceipt"]> = null;
  h.ports.spawnReceipt = () => receipt;
  h.ports.spawnAgent = async (_input, reserved) => {
    await reserved({ launchId: "launch-failed-handoff", conversationId: "conversation_fork", accountId: "default" });
    throw new Error("launch acknowledgement lost");
  };
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("switching");
  const prematureReport = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Unverified successor" },
    { kind: "agent", conversationId: "conversation_fork", role: "builder" }, h.ports);
  expect(prematureReport).toMatchObject({ status: 409, code: "STAGE_REPORT_RUNTIME_SWITCH" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.report).toBeUndefined();
  h.ports.stopStageAgent = async () => ({ outcome: "unconfirmed", operationId: null, detail: "receipt still pending" });
  h.advance(10 * 60_000);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });

  receipt = { state: "failed", launchId: "launch-failed-handoff", conversationId: "conversation_fork", accountId: "default", error: "spawn refused" } as never;
  const restarted = await import(`./engine?failed-handoff-restart=${crypto.randomUUID()}`) as typeof import("./engine");
  await restarted.tickPipelines([], h.ports);
  await restarted.tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  expect(lane.state).toBe("running");
  expect(attempt.runtimeSwitches?.[0]?.phase).toBe("rolled-back");
  expect(attempt).toMatchObject({ n: 1, conversationId: STAGE_CONVERSATION, launchId: "launch-1", state: "running", effectiveRole: { engine: "claude", model: "fable" } });
  expect(h.continuations).toHaveLength(1);
  expect(h.spawnCount()).toBe(1);
  expect(requested.pipeline!.runs[0]!.attempts[0]!.n).toBe(1);
});
test("a parked handoff rollback with no successor launch settles on the source's late delivery and accepts its verdict once", async () => {
  const h = switchHarness();
  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "default" } } as never);
  /* The source accepts the keyed continuation and delivers it only later. */
  h.ports.resumeSeveredTurn = async (input) => {
    if (!h.deliveries.has(input.clientMessageId)) {
      h.continuations.push(input);
      h.deliveries.set(input.clientMessageId, { state: "pending", at: new Date(h.wallClock()).toISOString() });
    }
    return true;
  };
  const requested = await requestSwitch(h, { engine: "codex", model: "gpt-6.1-sol" });
  let handoffCalls = 0;
  h.ports.spawnAgent = async () => { handoffCalls++; throw new Error("target unavailable"); };
  await tickPipelines([], h.ports);
  const rolling = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(rolling.runtimeSwitches?.[0]).toMatchObject({ phase: "continuing", rollback: true, launch: { launchId: null } });
  h.advance(10 * 60_000);
  await tickPipelines([], h.ports);
  const parkedLane = loadPipelines()[0]!;
  expect(parkedLane).toMatchObject({ state: "needs_decision" });
  const { worktreeDir, branch } = parkedLane;

  /* Still pending after a restart: the lane keeps waiting and nothing is sent again. */
  const early = await import(`./engine?rollback-pending-restart=${crypto.randomUUID()}`) as typeof import("./engine");
  await early.tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("continuing");

  const key = h.continuations[0]!.clientMessageId;
  h.deliveries.set(key, { state: "delivered", at: new Date(h.wallClock() + 1).toISOString() });
  h.setSeat({ engine: "claude", model: "fable", effort: "high", serviceTier: null, accountId: "default", sessionId: "session-1", agentPath: STAGE_TRANSCRIPT });
  h.setTurn({ turn: "busy", turnStartedAt: h.wallClock() + 2, message: null, lastRecordAt: h.wallClock() + 2 });
  const restarted = await import(`./engine?rollback-delivered-restart=${crypto.randomUUID()}`) as typeof import("./engine");
  await restarted.tickPipelines([], h.ports);
  await restarted.tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  const attempt = lane.runs[0]!.attempts[0]!;
  expect(lane).toMatchObject({ state: "running", worktreeDir, branch });
  expect(attempt.runtimeSwitches?.[0]).toMatchObject({ phase: "rolled-back", rollback: true, launch: { launchId: null } });
  expect(attempt).toMatchObject({ n: 1, conversationId: STAGE_CONVERSATION, launchId: "launch-1", state: "running", effectiveRole: { engine: "claude", model: "fable" } });

  h.setTurn({ turn: "terminal", turnStartedAt: h.wallClock() + 2, message: { text: "Finished on source runtime", ts: h.wallClock() + 3 }, lastRecordAt: h.wallClock() + 3 });
  const report = await restarted.reportStageCompletion({ verdict: "pass", findings: [], summary: "Finished on source runtime" },
    { kind: "agent", conversationId: STAGE_CONVERSATION, role: "builder" }, h.ports);
  expect(report.error).toBeUndefined();
  await restarted.tickPipelines([], h.ports);
  const settled = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(settled).toMatchObject({ n: 1, conversationId: STAGE_CONVERSATION, verdict: { status: "pass" } });
  expect(settled.report?.calls).toBe(1);
  expect(settled.runtimeSwitches).toHaveLength(1);
  expect(h.continuations).toHaveLength(1);
  expect(handoffCalls).toBe(1);
  expect(h.spawnCount()).toBe(1);
  expect(requested.pipeline!.runs[0]!.attempts[0]!.n).toBe(1);
});
test("a parked handoff rollback stays fenced when the project dropped the source account", async () => {
  const h = switchHarness();
  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "default" } } as never);
  h.ports.resumeSeveredTurn = async (input) => {
    if (!h.deliveries.has(input.clientMessageId)) {
      h.continuations.push(input);
      h.deliveries.set(input.clientMessageId, { state: "pending", at: new Date(h.wallClock()).toISOString() });
    }
    return true;
  };
  await requestSwitch(h, { engine: "codex", model: "gpt-6.1-sol" });
  h.ports.spawnAgent = async () => { throw new Error("target unavailable"); };
  await tickPipelines([], h.ports);
  h.advance(10 * 60_000);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]).toMatchObject({ state: "needs_decision" });

  h.deliveries.set(h.continuations[0]!.clientMessageId, { state: "delivered", at: new Date(h.wallClock() + 1).toISOString() });
  h.setSeat({ engine: "claude", model: "fable", effort: "high", serviceTier: null, accountId: "default", sessionId: "session-1", agentPath: STAGE_TRANSCRIPT });
  h.setTurn({ turn: "busy", turnStartedAt: h.wallClock() + 2, message: null, lastRecordAt: h.wallClock() + 2 });
  h.ports.allowedAccountIds = (_project, engine) => engine === "claude" ? ["another"] : ["default"];
  const restarted = await import(`./engine?rollback-revoked-restart=${crypto.randomUUID()}`) as typeof import("./engine");
  await restarted.tickPipelines([], h.ports);
  await restarted.tickPipelines([], h.ports);
  const lane = loadPipelines()[0]!;
  expect(lane.state).toBe("needs_decision");
  expect(lane.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("continuing");
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

for (const handoff of [false, true]) test(`operator kill in the switch millisecond fences ${handoff ? "handoff" : "fork"} dispatch`, async () => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const h = switchHarness(); const pipeline = await runningStage(h);
  if (handoff) {
    h.ports.allowedAccountIds = () => ["default"];
    h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { engine: "codex", accountId: "default", kind: "default", home: process.env.LLV_STATE_DIR!, transcriptRoot: process.env.LLV_STATE_DIR!, env: {} } } as never);
    h.ports.stopStageAgent = async () => ({ outcome: "stopped" });
  }
  const requested = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", applyNow: true,
    ...(handoff ? { engine: "codex", model: "gpt-6.1-sol", effort: "high" } : { model: "opus" }) }, h.ports);
  expect(requested.error).toBeUndefined();
  const since = requested.runtimeSwitch!.requestedAt;
  const journal = new RuntimeJournal(path.join(process.env.LLV_STATE_DIR!, `same-millisecond-${handoff}.sqlite`), { structuredHosts: true, now: () => Date.parse(since) });
  try {
    const operationId = "operator-kill";
    journal.executeOperation({ kind: "kill", operationId, idempotencyKey: operationId, conversationId: STAGE_CONVERSATION, sessionKey: { engine: "claude", sessionId: "stage-session" } });
    journal.transitionOperation(operationId, "delivering"); journal.transitionOperation(operationId, "delivered");
    const client = { effectBatch: async (kinds: string[], cursor: number) => journal.effectBatch(100, kinds, cursor), operationStatus: async (id: string) => journal.operationResult(id) };
    h.ports.runtimeSwitchKilled = (id, boundary, ignored) => hasRuntimeSwitchKill(client as never, id, boundary, ignored);
    await tickPipelines([], h.ports); await tickPipelines([], h.ports);
    expect(h.operations.size).toBe(0); expect(h.continuations).toHaveLength(0); expect(h.spawnCount()).toBe(1);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]).toMatchObject({ phase: "failed", outcome: expect.stringContaining("kill") });
    expect(await hasRuntimeSwitchKill(client as never, STAGE_CONVERSATION, since, [operationId])).toBe(false);
    expect(await hasRuntimeSwitchKill(client as never, STAGE_CONVERSATION, new Date(Date.parse(since) + 1).toISOString())).toBe(false);
  } finally { journal.close(); }
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
    expect(await hasRuntimeSwitchKill(client as never, STAGE_CONVERSATION, new Date(h.wallClock()).toISOString())).toBe(true);
    h.ports.runtimeSwitchKilled = (id, since, ignored) => hasRuntimeSwitchKill(client as never, id, since, ignored);
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.stateDetail).toContain("stage stopped by kill");
    h.advance(10 * 60_000); await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.state).toBe("needs_decision"); expect(h.continuations).toHaveLength(1);
  } finally { journal.close(); }
});

test("compacted historical operator kills do not block a later switch-owned teardown", async () => {
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { hasRuntimeSwitchKill } = await import("./runtimeSwitch");
  const filename = path.join(process.env.LLV_STATE_DIR!, "historical-kill.sqlite");
  let now = Date.parse("2026-10-02T10:00:00Z");
  const firstAt = now;
  let journal = new RuntimeJournal(filename, { structuredHosts: true, now: () => now });
  const sessionKey = { engine: "claude" as const, sessionId: "historical-kill-session" };
  try {
    for (const [operationId, origin] of [["historical-operator", { kind: "operator" }], ["owned-switch-stop", { kind: "agent", role: "pipeline" }]] as const) {
      journal.executeOperation({ kind: "kill", operationId, idempotencyKey: operationId, conversationId: STAGE_CONVERSATION, sessionKey, origin });
      journal.transitionOperation(operationId, "delivered");
      now += 1000;
    }
    journal.append({ scope: { type: "session", id: STAGE_CONVERSATION }, kind: "delta", payload: { text: "later history" } });
    journal.compact(1);
    journal.close();
    journal = new RuntimeJournal(filename, { structuredHosts: true });
    expect(journal.operationResult("historical-operator")).toBeNull();
    expect(journal.operationResult("owned-switch-stop")).toBeNull();
    const client = { effectBatch: async (kinds: string[], cursor: number) => journal.effectBatch(100, kinds, cursor), operationStatus: async (id: string) => journal.operationResult(id) };
    expect(await hasRuntimeSwitchKill(client as never, STAGE_CONVERSATION, new Date(firstAt + 500).toISOString(), ["owned-switch-stop"])).toBe(false);
    expect(await hasRuntimeSwitchKill(client as never, STAGE_CONVERSATION, new Date(firstAt).toISOString(), ["owned-switch-stop"])).toBe(true);
    expect(await hasRuntimeSwitchKill(client as never, STAGE_CONVERSATION, new Date(firstAt + 500).toISOString())).toBe(true);
    expect(await hasRuntimeSwitchKill(client as never, STAGE_CONVERSATION, new Date(now).toISOString())).toBe(false);
  } finally { journal.close(); }
});

test("an early continuation verdict survives a delayed send acknowledgement", async () => {
  const h = switchHarness(); await requestSwitch(h); const started = h.wallClock();
  h.ports.resumeSeveredTurn = async input => {
    if (!h.deliveries.has(input.clientMessageId)) h.continuations.push(input);
    h.setTurn({ turn: "terminal", message: { text: '```json\n{"status":"pass","findings":[]}\n```', ts: started + 1000 }, lastRecordAt: started + 1000, turnStartedAt: started + 500 });
    h.deliveries.set(input.clientMessageId, { state: "delivered", at: new Date(started + 2000).toISOString() }); h.advance(2000); return true;
  };
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
});

test("a changed account pin conflicts with an open automatic-account switch", async () => {
  const h = switchHarness(); const first = await requestSwitch(h);
  const answer = await patchPipeline(first.pipeline!.id, { action: "override-stage", stageId: "plan", model: "opus", account: "default", applyNow: true }, h.ports, { kind: "operator" });
  expect(answer).toMatchObject({ status: 409, code: "RUNTIME_SWITCH_IN_PROGRESS" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches).toHaveLength(1);
});


test("the continuation boundary excludes a late predecessor verdict before the new native turn", async () => {
  const h = switchHarness(); await requestSwitch(h); const started = h.wallClock();
  h.ports.resumeSeveredTurn = async input => {
    h.setTurn({ turn: "terminal", message: { text: '```json\n{"status":"pass","findings":[]}\n```', ts: started + 1000 }, lastRecordAt: started + 2000, turnStartedAt: started + 1500 });
    h.deliveries.set(input.clientMessageId, { state: "delivered", at: new Date(started + 500).toISOString() }); h.advance(2000); return true;
  };
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict).toBeNull();
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.continuedAt).toBe(new Date(started + 1500).toISOString());
});


test("a delivered continuation waits for its native turn witness without dispatching twice", async () => {
  const h = switchHarness(); await requestSwitch(h);
  const predecessorStart = h.wallClock() - 1000;
  h.ports.durableTurnEvidence = async () => ({ turn: "terminal", message: null, turnStartedAt: predecessorStart });
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("continuing");
  expect(h.continuations).toHaveLength(1);
  h.advance(10 * 60_000); await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("native turn start");
  expect(h.continuations).toHaveLength(1);
});


test("a kill after reconfigure admission prevents the continuation dispatch", async () => {
  const h = switchHarness(); await requestSwitch(h); let killed = false;
  const control = h.ports.runtimeSwitchControl!;
  h.ports.runtimeSwitchKilled = async () => killed;
  h.ports.runtimeSwitchControl = async (...args) => { const result = await control(...args); if (args[2] === "reconfigure") killed = true; return result; };
  await tickPipelines([], h.ports);
  expect(h.continuations).toHaveLength(0);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
});

test("the verdict evidence boundary survives bounded switch-history eviction", async () => {
  const h = switchHarness(); const first = await requestSwitch(h); await tickPipelines([], h.ports);
  const floor = loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches![0]!.continuedAt!;
  for (let n = 0; n < 8; n++) {
    h.ports.allowedAccountIds = () => ["default"];
    const result = await patchPipeline(first.pipeline!.id, { action: "override-stage", stageId: "plan", model: n % 2 ? "sonnet" : "fable", applyNow: true }, h.ports, { kind: "operator" });
    expect(result.error).toBeUndefined();
    h.ports.allowedAccountIds = () => [];
    await tickPipelines([], h.ports);
  }
  const { attemptEvidenceFloor } = await import("./runtimeSwitch");
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.runtimeSwitches).toHaveLength(8);
  expect(attemptEvidenceFloor(attempt)).toBe(floor);
});


test("a handoff successor report waits for its completed launch receipt", async () => {
  const h = switchHarness(); h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "default" } } as never);
  await requestSwitch(h, { engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  let receipt: ReturnType<PipelinePorts["spawnReceipt"]> = null;
  h.ports.spawnReceipt = () => receipt;
  h.ports.spawnAgent = async (_input, reserved) => {
    await reserved({ launchId: "launch-new", conversationId: "conversation_new", accountId: "default" });
    throw new Error("launch acknowledgement unavailable");
  };
  await tickPipelines([], h.ports);
  const prematureReport = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Completed in the successor" }, { kind: "agent", conversationId: "conversation_new", role: "builder" }, h.ports);
  expect(prematureReport).toMatchObject({ status: 409, code: "STAGE_REPORT_RUNTIME_SWITCH" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.report).toBeUndefined();
  receipt = { state: "completed", launchId: "launch-new", conversationId: "conversation_new", accountId: "default", sessionId: "new", transcript: "/codex/new.jsonl", paneId: null } as never;
  const report = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Completed in the successor" }, { kind: "agent", conversationId: "conversation_new", role: "builder" }, h.ports);
  expect(report?.error).toBeUndefined();
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.report?.verdict.status).toBe("pass");
  h.setTurn({ turn: "terminal", message: null, lastRecordAt: h.wallClock() + 10 });
  await tickPipelines([], h.ports); await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
});


test("a stopped unpublished handoff rolls back through its own switch driver", async () => {
  const h = switchHarness(); h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "default" } } as never);
  await requestSwitch(h, { engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  h.ports.spawnAgent = async (_input, reserved) => { await reserved({ launchId: "launch-new", conversationId: "conversation_new", accountId: "default" }); throw new Error("launch acknowledgement unavailable"); };
  await tickPipelines([], h.ports);
  h.ports.spawnReceipt = id => id === "launch-new" ? { launchId: id, conversationId: "conversation_new", sessionId: null, transcript: null, paneId: null, accountId: "default", state: "path-pending", staged: true, error: "structured launch recovery: " + JSON.stringify({ phase: "unpublished", startedAt: h.wallClock(), checks: 3, nextTryAt: h.wallClock(), reason: "first delivery refused", stopped: true }) } : null;
  h.ports.failStageLaunch = () => true;
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(h.continuations).toHaveLength(1);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt).toMatchObject({ n: 1, conversationId: STAGE_CONVERSATION, completedAt: null });
  expect(attempt.runtimeSwitches?.[0]?.rollback).toBe(true);
});


test("a predecessor report preflight cannot cross a committed same-engine switch", async () => {
  const h = switchHarness(); const pipeline = await runningStage(h);
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  const read = h.ports.durableTurnEvidence; let first = true;
  h.ports.durableTurnEvidence = async (...args) => { if (first) { first = false; enter(); await held; } return await read(...args); };
  const stale = reportStageCompletion({ verdict: "fail", findings: [{ severity: "P1", text: "Predecessor result" }], summary: "Predecessor result" }, { kind: "agent", conversationId: STAGE_CONVERSATION, role: "builder" }, h.ports);
  await entered;
  await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", model: "opus", applyNow: true }, h.ports, { kind: "operator" });
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("committed");
  release(); const report = await stale;
  expect(report).toMatchObject({ status: 409, code: "STAGE_REPORT_CHANGED" });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.report).toBeUndefined();
});

test("target account revocation during interrupt fences reconfigure and continuation", async () => {
  const h = switchHarness(); let allowed = ["default", "target"];
  h.ports.allowedAccountIds = () => allowed;
  h.ports.resolveProjectSpawn = () => ({ kind: "available", account: { accountId: "target" } } as never);
  await requestSwitch(h, { account: "target" });
  const control = h.ports.runtimeSwitchControl!;
  h.ports.runtimeSwitchControl = async (...args) => { const result = await control(...args); if (args[2] === "interrupt") allowed = ["default"]; return result; };
  await tickPipelines([], h.ports);
  expect([...h.operations.values()]).not.toContain("reconfigure");
  expect(h.continuations).toHaveLength(0);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("no longer allowed");
});

test("rollback refuses to cancel or rearm a continuation on a revoked source account", async () => {
  const h = switchHarness(); h.setOutcome("failed"); let allowed = ["default", "target"];
  h.ports.allowedAccountIds = () => allowed;
  h.ports.runtimeSwitchControl = async (_id, _path, action, key) => {
    h.operations.set(key, action);
    if (action === "interrupt") allowed = ["target"];
  };
  h.ports.resumeSeveredTurn = async input => {
    if (!h.deliveries.has(input.clientMessageId)) {
      h.continuations.push(input);
      h.deliveries.set(input.clientMessageId, { state: "failed", at: h.ports.now() });
    }
    return true;
  };
  await requestSwitch(h, { account: "target" });
  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("source account is no longer allowed");
  expect(h.operations.get("cancel")).toBeUndefined();
  expect(h.continuations).toHaveLength(1);
});

test("rollback waits visibly when source account authorization cannot be read", async () => {
  const h = switchHarness(); let unreadable = false;
  h.ports.allowedAccountIds = () => { if (unreadable) throw new Error("project account bindings are unreadable"); return ["default"]; };
  h.ports.runtimeSwitchOutcome = async () => { unreadable = true; return { state: "failed", error: "account refused" }; };
  h.ports.resumeSeveredTurn = async input => {
    if (!h.deliveries.has(input.clientMessageId)) {
      h.continuations.push(input);
      h.deliveries.set(input.clientMessageId, { state: "failed", at: h.ports.now() });
    }
    return true;
  };
  await requestSwitch(h);
  await tickPipelines([], h.ports);
  const parked = loadPipelines()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("account authorization unavailable");
  expect(h.operations.get("cancel")).toBeUndefined();
  expect(h.continuations).toHaveLength(1);
});

test("rollback does not rearm a held continuation after its source account is revoked", async () => {
  const h = switchHarness(); h.setOutcome("pending"); let allowed = ["default", "target"];
  h.ports.allowedAccountIds = () => allowed;
  h.ports.resumeSeveredTurn = async input => {
    if (!h.deliveries.has(input.clientMessageId)) {
      h.continuations.push(input);
      h.deliveries.set(input.clientMessageId, { state: "pending", at: h.ports.now() });
    }
    return true;
  };
  h.ports.cancelRuntimeSwitch = async () => {
    h.operations.set("cancel", "cancel");
    for (const key of h.deliveries.keys()) h.deliveries.set(key, { state: "delivered", at: h.ports.now() });
  };
  await requestSwitch(h, { account: "target" });
  await tickPipelines([], h.ports);
  expect(h.continuations).toHaveLength(1);
  allowed = ["target"];
  h.advance(10 * 60_000);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("source account is no longer allowed");
  expect(h.operations.get("cancel")).toBeUndefined();
  expect(h.continuations).toHaveLength(1);
});


test("a successor report relays only prose after the native continuation boundary", async () => {
  const h = switchHarness(); await requestSwitch(h); const started = h.wallClock();
  const transcript = path.join(process.env.LLV_STATE_DIR!, "continuation-report-prose.jsonl");
  fs.writeFileSync(transcript, [
    { type: "assistant", timestamp: new Date(started + 100).toISOString(), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Predecessor prose" }] } },
    { type: "user", timestamp: new Date(started + 1000).toISOString(), message: { role: "user", content: "Continue the stage" } },
    { type: "assistant", timestamp: new Date(started + 2000).toISOString(), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Successor conclusion" }] } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const { durableStageTurnEvidence } = await import("./durableEvidence");
  h.ports.durableTurnEvidence = (engine, _path, reportAt, floor) => durableStageTurnEvidence(engine, transcript, reportAt, floor);
  h.ports.resumeSeveredTurn = async input => { h.deliveries.set(input.clientMessageId, { state: "delivered", at: new Date(started).toISOString() }); h.advance(1500); return true; };
  await tickPipelines([], h.ports);
  const result = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Successor report" }, { kind: "agent", conversationId: STAGE_CONVERSATION, role: "builder" }, h.ports);
  expect(result.error).toBeUndefined();
  h.advance(1000); await tickPipelines([], h.ports);
  const output = loadPipelines()[0]!.runs[0]!.attempts[0]!.output;
  expect(output).toContain("Successor conclusion");
  expect(output).not.toContain("Predecessor prose");
});


test("a model-only override prefers the actual native account before snapshot rebinding", async () => {
  const h = switchHarness(); const pipeline = await runningStage(h);
  h.setSeat({ engine: "claude", model: "fable", effort: "high", serviceTier: null, accountId: "native-current", sessionId: "session-native", agentPath: STAGE_TRANSCRIPT });
  h.ports.allowedAccountIds = () => ["default", "native-current"];
  h.ports.resolveProjectSpawn = (_engine, request) => ({ kind: "available", account: { accountId: request.preferredId } } as never);
  const answer = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", model: "opus", applyNow: true }, h.ports, { kind: "operator" });
  expect(answer.error).toBeUndefined();
  expect(answer.runtimeSwitch?.from.accountId).toBe("native-current");
  expect(answer.runtimeSwitch?.to.accountId).toBe("native-current");
});

for (const completion of ["report", "transcript"] as const) {
  test(`a ${completion} before the switch drain supersedes its uncut request`, async () => {
    const { drainRuntimeSwitches } = await import("./engine");
    const h = switchHarness(); await requestSwitch(h);
    if (completion === "report") {
      const report = await reportStageCompletion({ verdict: "pass", findings: [], summary: "Finished before cut" }, { kind: "agent", conversationId: STAGE_CONVERSATION, role: "builder" }, h.ports);
      expect(report.error).toBeUndefined();
    } else h.setTurn({ turn: "terminal", message: { text: '```json\n{"status":"pass","findings":[]}\n```', ts: h.wallClock() + 1 } });
    await drainRuntimeSwitches(h.ports);
    expect(h.operations.size).toBe(0); expect(h.continuations).toHaveLength(0);
    expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("superseded");
  });
}


test("restart settles a delivered continuation whose start is beyond the capped final tail", async () => {
  const h = switchHarness(); await requestSwitch(h); const started = h.wallClock();
  const { switchOperationKey } = await import("./runtimeSwitch");
  const records = loadPipelines(); const record = records[0]!.runs[0]!.attempts[0]!.runtimeSwitches![0]!;
  const key = switchOperationKey(record, "continue"); record.phase = "continuing"; record.cutAt = h.ports.now(); record.continuationDispatch = { key, at: h.ports.now() }; savePipelines(records);
  const file = path.join(process.env.LLV_STATE_DIR!, "large-restarted-continuation.jsonl");
  fs.writeFileSync(file, [
    { type: "user", timestamp: new Date(started + 1000).toISOString(), message: { role: "user", content: "Continue" } },
    ...Array.from({ length: 100 }, () => ({ type: "user", timestamp: new Date(started + 1500).toISOString(), message: { role: "user", content: [{ type: "tool_result", content: "t".repeat(100_000) }] } })),
    { type: "assistant", timestamp: new Date(started + 2000).toISOString(), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: '```json\n{"status":"pass","findings":[]}\n```' }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const { durableStageTurnEvidence } = await import("./durableEvidence");
  h.ports.durableTurnEvidence = (engine, _path, reportAt, floor) => durableStageTurnEvidence(engine, file, reportAt, floor);
  h.deliveries.set(key, { state: "delivered", at: new Date(started).toISOString() });
  h.setSeat({ engine: "claude", model: "opus", effort: "high", serviceTier: null, accountId: "default", sessionId: "new", agentPath: STAGE_TRANSCRIPT });
  h.advance(10 * 60_000 + 1000); await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches?.[0]?.phase).toBe("committed");
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
  expect(h.continuations).toHaveLength(0);
});

/* Review round of 2026-10-05: the request the runtime pill sends. */
test("a choice made on an earlier attempt or conversation is refused before anything changes", async () => {
  const h = switchHarness(); const pipeline = await runningStage(h);
  const send = (body: Record<string, unknown>) => patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", engine: "claude", model: "opus", effort: "high", applyNow: true, ...body } as never, h.ports, { kind: "operator" });
  const before = JSON.stringify(loadPipelines()[0]);
  for (const stale of [{ expectedAttempt: 2 }, { expectedAttempt: 0 }, { expectedAttempt: 1, expectedConversationId: "conversation_before_retry" }, { expectedConversationId: "conversation_before_retry" }]) {
    expect(await send(stale)).toMatchObject({ status: 409, code: "STAGE_CHANGED" });
  }
  expect(JSON.stringify(loadPipelines()[0])).toBe(before);
  expect(h.operations.size).toBe(0);
  expect(await send({ expectedConversationId: "" })).toMatchObject({ status: 400, field: "expectedConversationId" });
  expect(await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", model: "opus", expectedConversationId: STAGE_CONVERSATION } as never, h.ports, { kind: "operator" }))
    .toMatchObject({ status: 400, field: "expectedConversationId" });
  expect(await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", model: "opus", expectedAttempt: 1 } as never, h.ports, { kind: "operator" }))
    .toMatchObject({ status: 400, field: "expectedAttempt" });

  const current = { expectedAttempt: 1, expectedConversationId: STAGE_CONVERSATION };
  const accepted = await send(current);
  expect(accepted.error).toBeUndefined();
  expect(accepted.runtimeSwitch).toMatchObject({ phase: "requested", from: { conversationId: STAGE_CONVERSATION } });
  expect(await send(current)).toMatchObject({ replayed: true, runtimeSwitch: { id: accepted.runtimeSwitch!.id } });
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.runtimeSwitches).toHaveLength(1);
});

test("the pill's own engine moves the running attempt after the next attempt was set to another engine", async () => {
  const h = switchHarness(); const pipeline = await runningStage(h);
  const future = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", engine: "codex", model: "gpt-6.1-sol", effort: "high" }, h.ports, { kind: "operator" });
  expect(future.error).toBeUndefined();
  expect(loadPipelines()[0]!.stages[0]!.effectiveRole.engine).toBe("codex");
  /* The next attempt also carries a Codex speed, which Claude has no place for. */
  const stored = loadPipelines();
  Object.assign(stored[0]!.stages[0]!, { serviceTier: "priority" });
  Object.assign(stored[0]!.stages[0]!.effectiveRole, { serviceTier: "priority", serviceTierSource: "explicit" });
  savePipelines(stored);
  /* Without its engine the choice would be read against the future definition. */
  expect(await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", model: "opus", effort: "high", applyNow: true }, h.ports, { kind: "operator" }))
    .toMatchObject({ status: 400 });
  const moved = await patchPipeline(pipeline.id, { action: "override-stage", stageId: "plan", engine: "claude", model: "opus", effort: "high", serviceTier: null, applyNow: true, expectedAttempt: 1, expectedConversationId: STAGE_CONVERSATION }, h.ports, { kind: "operator" });
  expect(moved.error).toBeUndefined();
  expect(moved.runtimeSwitch?.to.serviceTier).toBeNull();
  expect(moved.runtimeSwitch).toMatchObject({ mode: "fork", from: { engine: "claude", model: "fable" }, to: { engine: "claude", model: "opus", effort: "high" } });
  await tickPipelines([], h.ports);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.runtimeSwitches?.at(-1)?.phase).toBe("committed");
  expect(attempt).toMatchObject({ n: 1, conversationId: STAGE_CONVERSATION, effectiveRole: { engine: "claude", model: "opus" } });
});

test("a continuation on a runtime other than the selected one is never committed as the selection", async () => {
  const h = switchHarness();
  /* The executor reports the operation applied while the conversation keeps its runtime. */
  h.ports.runtimeSwitchControl = async (_id, _path, action, key) => { h.operations.set(key, action); };
  await requestSwitch(h);
  await tickPipelines([], h.ports);
  const attempt = loadPipelines()[0]!.runs[0]!.attempts[0]!;
  expect(attempt.runtimeSwitches?.[0]).toMatchObject({ phase: "superseded", outcome: "continued on a runtime that differs from the selection" });
  expect(attempt.effectiveRole.model).toBe("fable");
  expect(h.continuations).toHaveLength(1);
});

test("the executor's fence reads the switch record and the project's allowed accounts at the time it runs", async () => {
  const { pipelineSwitchFence, switchOperationKey } = await import("./runtimeSwitchFence");
  const { bindAccountToProject, unbindAccountFromProject } = await import("@/lib/accounts/projectBindings");
  const h = switchHarness();
  h.ports.resolveProjectSpawn = undefined;
  expect(bindAccountToProject("claude", "default", "viewer").ok).toBe(true);
  expect(bindAccountToProject("claude", "target", "viewer").ok).toBe(true);
  const requested = await requestSwitch(h, { account: "target" });
  expect(requested.error).toBeUndefined();
  const record = requested.runtimeSwitch!;
  expect(record.to.accountId).toBe("target");
  const operationId = switchOperationKey(record, "reconfigure");

  expect(pipelineSwitchFence("switch-of-a-conversation")).toBeNull();
  const fence = pipelineSwitchFence(operationId)!;
  expect(fence.serviceTier).toBeUndefined();
  expect(() => fence.authorize()).not.toThrow();
  /* Revoked after admission: the fence taken earlier answers for now, and so does one read after a restart. */
  expect(unbindAccountFromProject("claude", "target", "viewer").ok).toBe(true);
  expect(() => fence.authorize()).toThrow("target account is no longer allowed on this project");
  expect(() => pipelineSwitchFence(operationId)!.authorize()).toThrow("target account is no longer allowed on this project");
  expect(bindAccountToProject("claude", "target", "viewer").ok).toBe(true);
  expect(() => fence.authorize()).not.toThrow();
  /* Asked about the account a host would start on, the source included. */
  expect(() => fence.authorize("default")).not.toThrow();
  expect(unbindAccountFromProject("claude", "default", "viewer").ok).toBe(true);
  expect(() => fence.authorize("default")).toThrow("account is no longer allowed on this project");
  expect(() => fence.authorize(null)).toThrow("no longer allowed");
  expect(() => fence.authorize()).not.toThrow();
  expect(bindAccountToProject("claude", "default", "viewer").ok).toBe(true);
  /* A switch whose record is gone authorizes nothing. */
  expect(() => pipelineSwitchFence(switchOperationKey({ id: "p-gone:plan:1:1" }, "reconfigure"))!.authorize()).toThrow("no longer allowed");
  expect(unbindAccountFromProject("claude", "target", "viewer").ok).toBe(true);
  expect(unbindAccountFromProject("claude", "default", "viewer").ok).toBe(true);
});
