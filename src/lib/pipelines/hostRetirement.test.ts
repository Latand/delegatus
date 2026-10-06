import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { pipelineHostHasLiveWork } from "./hostRetirement";
import * as retirement from "./hostRetirement";
import { runtimeIdleKillMatches } from "@/lib/runtime/contracts";
import { sameRecordedProcessIdentity } from "@/lib/processIdentity";
import { blockingHostActivityFlags } from "@/lib/runtime/hostActivityFlags";
import { terminateStructuredHostTree } from "@/lib/runtime/structuredHostControl";
import type { Pipeline, PipelineStageAttempt } from "./types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const cut = Date.parse("2026-10-01T10:00:02Z");
const ref = { pipelineId: "pipeline-fixture", stageId: "builder", attempt: 1, turnTs: cut, controlGeneration: "control-fixture" };

/** Execute the exact production queue callback with fake kernel boundaries.
    Source extraction keeps this suite independent of global controller timers. */
function productionTermination(dependencies: Record<string, unknown>) {
  const source = fs.readFileSync(path.join(import.meta.dir, "../runtime/structuredDeliveryController.ts"), "utf8");
  const begin = source.indexOf("    async (conversationId, expectedKey, onlyIfIdle, authority");
  const end = source.indexOf("\n    () => scheduleAutomaticRetry(),", begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const callback = source.slice(begin, end).trim().replace(/,$/, "");
  const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(`const callback = ${callback};`);
  return new Function(...Object.keys(dependencies), `${javascript} return callback;`)(...Object.values(dependencies)) as
    (conversation: string, key: { engine: "codex" | "claude"; sessionId: string }, idle: unknown, authority: unknown, recovery?: typeof ref) => Promise<boolean>;
}

function fixture(engine: "codex" | "claude" = "codex") {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "provider-retirement-"));
  roots.push(root);
  const transcript = path.join(root, "session.jsonl");
  const record = (time: number, payload: Record<string, unknown>) => ({ type: "event_msg", timestamp: new Date(time).toISOString(), payload });
  const nativeCut = (time: number) => engine === "codex"
    ? record(time, { type: "task_complete", error: { message: "capacity exhausted", codex_error_info: "usage_limit" } })
    : { type: "assistant", timestamp: new Date(time).toISOString(), isApiErrorMessage: true, error: "rate_limit",
        message: { content: [{ type: "text", text: "You've hit your session limit" }] } };
  fs.writeFileSync(transcript, [record(cut - 1000, { type: "task_started" }), nativeCut(cut)].map(row => JSON.stringify(row)).join("\n") + "\n");
  const conversationId = "conversation_fixture";
  const key = { engine, sessionId: "session-fixture" };
  const processRef = { pid: 987001, startIdentity: "fake-root", bootEpoch: "fake-boot" };
  const attempt = { n: 1, state: "running", conversationId, sessionId: key.sessionId, agentPath: transcript,
    paneId: null, launchId: null, startedAt: new Date(cut - 2000).toISOString(), completedAt: null,
    effectiveRole: { engine }, providerWait: { condition: { kind: "usage_limit" }, turnTs: cut } } as PipelineStageAttempt;
  const pipeline = { id: ref.pipelineId, state: "running", controlGeneration: ref.controlGeneration,
    srcConversationId: null, srcPath: null, cursor: { stageId: "builder", state: "running" },
    stages: [{ id: "builder", kind: "run" }], runs: [{ stageId: "builder", attempts: [attempt] }] } as Pipeline;
  const entry = { artifactPath: transcript, host: null, status: "idle", claimOwner: "fixture", claimEpoch: 1,
    structuredHost: { process: processRef, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    structuredTerminationSurvivors: [] as unknown[] };
  const conversation = { id: conversationId, generations: [{ id: key.sessionId }] };
  const snapshot = { entries: { [`${engine}:session-fixture`]: entry }, memberships: {}, heldDeliveries: {}, receipts: {} };
  const claim = { executorId: "fixture-executor", process: processRef };
  const authority = { operationId: "fixture-retire", claim };
  const idle = { revision: 1, writerClaim: "fixture:1" };
  const session = { conversationId, sessionKey: key, host: "hosted", turn: "idle", activeTurnId: null,
    attentionIds: [], writerClaim: "fixture:1", revision: 1, retirementBlocked: false };
  const signals: number[] = [];
  const alive = new Set([processRef.pid, processRef.pid + 1]);
  let beforeSignal: (() => void) | undefined;
  const queue = {};
  const state = { activeQueue: queue };
  let pipelineReads = 0;
  const deps = {
    ...retirement, runtimeIdleKillMatches, sameRecordedProcessIdentity, blockingHostActivityFlags,
    stopped: false, state, queue,
    client: { readSession: async () => session, operationStatus: async () => ({ receipt: { status: "delivering", retirementClaim: claim } }) },
    registry: { readOnlySnapshot: () => snapshot, conversation: () => conversation,
      terminateInactiveStructuredHost: () => false,
      recordStructuredTerminationSurvivors: (_key: unknown, _ref: unknown, identities: unknown[]) => { entry.structuredTerminationSurvivors = identities; return true; },
      terminateStructuredHost: () => true },
    loadPipelinesForRetirement: () => { pipelineReads++; return [pipeline]; },
    handoffQueue: () => ({ rows: () => [] }),
    sessionKeyId: () => `${engine}:session-fixture`, resolveConversationAlias: (_snapshot: unknown, id: string) => id,
    readOrchestratorSeatRetirementEvidenceOrNull: () => ({ seats: {}, pending: {}, revocations: [] }),
    canonicalOrchestratorProject: (id: string) => id,
    branchSharesRootHost: () => false, BRANCH_SHARED_HOST_ERROR: "shared host",
    structuredHostKillRefFromRegistry: () => ({ ok: true, ref: { ...processRef, conversationId, engine: key.engine, sessionId: key.sessionId } }),
    terminateStructuredHostTree: (target: Parameters<typeof terminateStructuredHostTree>[0], dependencies: Parameters<typeof terminateStructuredHostTree>[1]) =>
      terminateStructuredHostTree(target, { ...dependencies,
        processIdentity: pid => alive.has(pid) ? pid === processRef.pid ? "fake-root" : "fake-child" : null,
        bootEpoch: () => "fake-boot", pidAlive: pid => alive.has(pid),
        ppidMap: () => new Map([[processRef.pid + 1, processRef.pid]]), processGroupId: () => null,
        signal: pid => { signals.push(pid); alive.delete(pid); beforeSignal?.(); }, sleep: async () => {} }),
    refreshCurrentProjection: async () => {},
  };
  const terminate = (recovery = ref) => productionTermination(deps)(conversationId, key, idle, authority, recovery);
  const append = (payload: Record<string, unknown>, time = cut + 1) => fs.appendFileSync(transcript, JSON.stringify(record(time, payload)) + "\n");
  return { pipeline, attempt, entry, snapshot, conversation, session, signals, deps, terminate, append, nativeCut,
    transcript, setBeforeSignal: (callback: () => void) => { beforeSignal = callback; }, reads: () => pipelineReads };
}

test("provider recovery retires its own running cut through the production callback", async () => {
  const f = fixture();
  expect(pipelineHostHasLiveWork([f.pipeline], { conversationId: f.attempt.conversationId, agentPath: f.transcript, paneId: null, launchId: null })).toBe(true);
  expect(await f.terminate()).toBe(true);
  expect(f.signals).toEqual([987001, 987002]);
  expect(f.reads()).toBeGreaterThan(2);
});

test("provider recovery retires an unchanged parked quota retry", async () => {
  const f = fixture();
  f.pipeline.state = "needs_decision";
  f.pipeline.stateDetail = f.attempt.error = "quota park";
  f.attempt.state = "needs_decision";
  f.attempt.completedAt = new Date(cut + 1).toISOString();
  f.attempt.providerWait!.stageRetry = { controlGeneration: ref.controlGeneration, detail: "quota park" };
  expect(await f.terminate()).toBe(true);
});

test.each(["human", "human-before-new-cut", "control", "report", "verdict", "new-cut", "retry-cancelled", "other-attempt", "other-owner", "publication", "source-owner", "cursor", "session", "transcript", "writer", "seat", "delivery", "attention", "unknown", "incomplete", "reference-cut", "different-class", "prose", "pipeline-read", "claim", "generation", "rebind"] as const)("provider recovery refuses %s", async change => {
  const f = fixture();
  if (change === "human" || change === "human-before-new-cut") f.append({ type: "user_message", message: "operator followup" });
  if (change === "human-before-new-cut" || change === "new-cut") fs.appendFileSync(f.transcript, JSON.stringify(f.nativeCut(cut + 2)) + "\n");
  if (change === "control") f.pipeline.controlGeneration = "new-control";
  if (change === "report") f.attempt.report = { at: new Date(cut).toISOString() } as PipelineStageAttempt["report"];
  if (change === "verdict") f.attempt.verdict = { status: "pass" } as PipelineStageAttempt["verdict"];
  if (change === "retry-cancelled") f.attempt.providerWait!.retryCancelled = true;
  if (change === "other-attempt") f.pipeline.runs[0]!.attempts.push({ ...f.attempt, n: 2 });
  if (change === "other-owner") f.pipeline.runs.push({ stageId: "other", attempts: [{ ...f.attempt, n: 2 }] } as Pipeline["runs"][number]);
  if (change === "publication") f.pipeline.publicationAdmission = { state: "pending" } as Pipeline["publicationAdmission"];
  if (change === "source-owner") f.pipeline.srcConversationId = f.attempt.conversationId;
  if (change === "cursor") f.pipeline.cursor!.stageId = "other";
  if (change === "session") f.attempt.sessionId = "other-session";
  if (change === "transcript") f.attempt.agentPath = path.join(path.dirname(f.transcript), "missing.jsonl");
  if (change === "writer") f.entry.claimOwner = "new-writer";
  if (change === "seat") f.deps.readOrchestratorSeatRetirementEvidenceOrNull = () => ({ seats: { fixture: { conversationId: f.attempt.conversationId, seatEpoch: 1, project: "fixture" } }, pending: {}, revocations: [] }) as never;
  if (change === "delivery") Object.assign(f.snapshot.heldDeliveries, { fixture: { conversationId: f.attempt.conversationId, state: "held" } });
  if (change === "attention") f.entry.structuredHost.pendingAttention.push("attention" as never);
  if (change === "unknown") fs.writeFileSync(f.transcript, "");
  if (change === "incomplete") fs.appendFileSync(f.transcript, '{"partial":');
  if (change === "reference-cut") f.attempt.providerWait!.turnTs += 1;
  if (change === "different-class") fs.writeFileSync(f.transcript, JSON.stringify({ type: "event_msg", timestamp: new Date(cut).toISOString(),
    payload: { type: "task_complete", error: { message: "connection failed", codex_error_info: "stream_disconnected" } } }) + "\n");
  if (change === "prose") fs.writeFileSync(f.transcript, JSON.stringify({ type: "response_item", timestamp: new Date(cut).toISOString(),
    payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "usage limit" }] } }) + "\n");
  if (change === "pipeline-read") f.deps.loadPipelinesForRetirement = () => { throw new Error("ownership unknown"); };
  if (change === "claim") f.deps.client.operationStatus = async () => ({ receipt: { status: "delivering", retirementClaim: { executorId: "replacement", process: { pid: 987001, startIdentity: "fake-root", bootEpoch: "fake-boot" } } } });
  if (change === "generation") f.conversation.generations.push({ id: "new-generation" });
  if (change === "rebind") f.deps.state.activeQueue = {};
  expect(await f.terminate()).toBe(false);
  expect(f.signals).toEqual([]);
});

test.each(["control", "report", "human", "new-cut", "other-owner", "publication", "writer"] as const)("provider recovery revalidates before the next signal: %s", async change => {
  const f = fixture();
  f.setBeforeSignal(() => {
    if (change === "control") f.pipeline.controlGeneration = "new-control";
    if (change === "report") f.attempt.report = { at: new Date(cut).toISOString() } as PipelineStageAttempt["report"];
    if (change === "human") f.append({ type: "user_message", message: "operator followup" });
    if (change === "new-cut") fs.appendFileSync(f.transcript, JSON.stringify(f.nativeCut(cut + 1)) + "\n");
    if (change === "other-owner") f.pipeline.runs.push({ stageId: "other", attempts: [{ ...f.attempt, n: 2 }] } as Pipeline["runs"][number]);
    if (change === "publication") f.pipeline.publicationAdmission = { state: "pending" } as Pipeline["publicationAdmission"];
    if (change === "writer") f.entry.claimOwner = "new-writer";
  });
  await expect(f.terminate()).rejects.toThrow("idle-retirement");
  expect(f.signals).toEqual([987001]);
});

test("unrelated idle retirement keeps the running pipeline protection", async () => {
  const f = fixture();
  expect(await productionTermination(f.deps)(f.attempt.conversationId!, { engine: "codex", sessionId: f.attempt.sessionId! },
    { revision: 1, writerClaim: "fixture:1" }, { operationId: "fixture-retire", claim: { executorId: "fixture-executor", process: { pid: 987001, startIdentity: "fake-root", bootEpoch: "fake-boot" } } })).toBe(false);
  expect(f.signals).toEqual([]);
});


test("provider recovery accepts a native Claude cut and refuses a later SDK prompt", async () => {
  const f = fixture("claude");
  expect(await f.terminate()).toBe(true);
  const changed = fixture("claude");
  fs.appendFileSync(changed.transcript, JSON.stringify({ type: "user", timestamp: new Date(cut + 1).toISOString(),
    promptSource: "sdk", isMeta: true, message: { content: "operator followup" } }) + "\n");
  fs.appendFileSync(changed.transcript, JSON.stringify({ type: "assistant", timestamp: new Date(cut + 2).toISOString(),
    message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } }) + "\n");
  expect(await changed.terminate()).toBe(false);
  expect(changed.signals).toEqual([]);
});

test("provider recovery refuses prompt history beyond its verified read bound", async () => {
  const f = fixture();
  const padding = "x".repeat(64 * 1024);
  const row = JSON.stringify({ type: "event_msg", timestamp: new Date(cut + 1).toISOString(), payload: { type: "metadata", padding } }) + "\n";
  fs.appendFileSync(f.transcript, row.repeat(140));
  // The cut and any following prompt are outside even the 8 MiB verified window.
  expect(await f.terminate()).toBe(false);
  expect(f.signals).toEqual([]);
});


test.each([true, false])("provider recovery preserves live background work and permits harness expiry: %s", async persistent => {
  const f = fixture("claude");
  const task = { type: "user", timestamp: new Date(cut - 1000).toISOString(),
    message: { content: [{ tool_use_id: "fixture-monitor", type: "tool_result", content: "Monitor started (task fixture-monitor)." }] },
    toolUseResult: { taskId: "fixture-monitor", timeoutMs: 1, persistent } };
  fs.writeFileSync(f.transcript, JSON.stringify(task) + "\n" + fs.readFileSync(f.transcript, "utf8"));
  expect(await f.terminate()).toBe(!persistent);
  expect(f.signals).toEqual(persistent ? [] : [987001, 987002]);
});


test.each(["claude", "codex"] as const)("provider retirement accepts %s fractional filesystem cut evidence", async engine => {
  const f = fixture(engine);
  const record: Record<string, unknown> = f.nativeCut(cut);
  delete record.timestamp;
  fs.writeFileSync(f.transcript, JSON.stringify(record) + "\n");
  fs.utimesSync(f.transcript, cut / 1000 + 0.123456, cut / 1000 + 0.123456);
  const { durableStageTurnEvidence } = await import("./durableEvidence");
  const evidence = await durableStageTurnEvidence(engine, f.transcript, undefined, f.attempt.startedAt);
  const at = evidence!.terminalProviderMessage!.ts;
  expect(Number.isFinite(at)).toBe(true);
  expect(Number.isInteger(at)).toBe(false);
  const recovery = { ...ref, turnTs: at };
  f.attempt.providerWait!.turnTs = at;
  const { parseRuntimeCommand } = await import("@/lib/runtime/commands");
  const parsed = parseRuntimeCommand("kill", { conversationId: f.attempt.conversationId, idempotencyKey: "filesystem-cut",
    sessionKey: { engine, sessionId: f.attempt.sessionId }, onlyIfIdle: { revision: 1, writerClaim: "fixture:1" }, providerRecovery: recovery });
  expect(parsed).toMatchObject({ providerRecovery: recovery });
  expect(await f.terminate(recovery)).toBe(true);
  expect(f.signals).toEqual([987001, 987002]);
});

for (const engine of ["claude", "codex"] as const) {
  test.each(["before", "after"] as const)(`${engine} retirement orders an equal-time human prompt %s the quota cut`, async position => {
    const f = fixture(engine);
    const rows = fs.readFileSync(f.transcript, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const prompt = engine === "claude" ? { type: "user", timestamp: new Date(cut).toISOString(), message: { content: "Wait for my review" } }
      : { type: "event_msg", timestamp: new Date(cut).toISOString(), payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "Wait for my review" }] } } };
    rows.splice(position === "before" ? 1 : 2, 0, prompt);
    if (position === "after") rows.push(f.nativeCut(cut));
    fs.writeFileSync(f.transcript, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    expect(await f.terminate()).toBe(position === "before");
    expect(f.signals).toHaveLength(position === "before" ? 2 : 0);
  });
}
for (const engine of ["claude", "codex"] as const) {
  test.each([false, true])(`${engine} timestamp-less retirement proof respects human input (human=%s)`, async human => {
    const f = fixture(engine);
    const notice = { ...f.nativeCut(cut) } as Record<string, unknown>;
    delete notice.timestamp;
    const prompt = engine === "claude" ? { type: "user", message: { content: "Wait for my review" } }
      : { type: "event_msg", payload: { type: "user_message", message: "Wait for my review" } };
    fs.writeFileSync(f.transcript, (human ? [notice, prompt, notice] : [notice]).map(row => JSON.stringify(row)).join("\n") + "\n");
    fs.utimesSync(f.transcript, cut / 1000, cut / 1000);
    expect(await retirement.providerRecoveryTurnProven(f.attempt, ref)).toBe(!human);
    expect(await f.terminate()).toBe(!human);
    expect(f.signals).toHaveLength(human ? 0 : 2);
  });
}
