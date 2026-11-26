/* A message to a stage conversation whose attempt has already settled can
   only be delivered by restarting that conversation's host, and a settled
   attempt is never rehosted (stageGitEnvironment.ts). The send used to be held
   anyway: it cycled awaiting-host for ten minutes, or sat unassigned until the
   migration sweep cancelled it as "upgrade-era" residue. These cases drive the
   real recovery up to the host start and require the send to end at once with
   a code that names what to do instead. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, setSystemTime, test } from "bun:test";
import type { AccountContext } from "@/lib/accounts/contracts";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { drainHeldDeliveries, reconcileMigrations } from "@/lib/accounts/migration/coordinator";
import { AgentRegistry } from "@/lib/agent/registry";
import { buildPipeline, loadPipelines, pipelineIdentity, savePipelines } from "@/lib/pipelines/store";
import type { PipelineAttemptState, PipelineStageAttempt } from "@/lib/pipelines/types";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "./client";
import type { RuntimeSnapshot } from "./contracts";
import { DeliveryProgressStore } from "./deliveryProgress";
import { deliverHeldStructuredMessage, enqueueStructuredMessage } from "./structuredMessageDelivery";
import { recoverDeadStructuredConversation } from "./structuredRecovery";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-settled-stage-send-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
let fixtureNumber = 0;

const role = { roleId: null, engine: "codex" as const, model: null, effort: null,
  access: "read-write" as const, promptScaffold: null };

function attemptRow(n: number, state: PipelineAttemptState, conversationId: string, sessionId: string, agentPath: string): PipelineStageAttempt {
  return { n, state, effectiveRole: role, launchId: `settled-stage-launch-${n}`, conversationId, sessionId, agentPath,
    paneId: null, flowId: null, startedAt: "2026-11-16T22:00:00.000Z",
    completedAt: state === "running" ? null : "2026-11-16T22:59:27.000Z",
    input: null, activatedBy: null, output: null, verdict: null, error: null };
}

/** A Codex stage conversation whose recorded host is dead, in a worktree that
    carries the native stage guard, as a stage attempt in `state`. */
function stageConversation(options: { state?: PipelineAttemptState; stage?: boolean; successor?: boolean; hostEntry?: boolean } = {}) {
  const n = fixtureNumber += 1;
  const directory = path.join(sandbox, `fixture-${n}`);
  const pipelineId = `settled-stage-${n}`;
  // A lane's worktree path is derived from its repository and id.
  const worktree = pipelineIdentity(pipelineId, "Settled stage delivery", path.join(directory, "repo")).worktreeDir;
  fs.mkdirSync(worktree, { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q", worktree]);
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
  fs.writeFileSync(path.join(worktree, ".git", "delegatus-stage-owner"), "fixture");
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(directory, "sessions", `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const profile = emptyLaunchProfile({ cwd: worktree, project: "fixture" });
  registry.reconcileConversations([{ engine: "codex", path: artifactPath, accountId: "stage-account",
    launchProfile: profile, turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-11-16T22:00:00.000Z" }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  const generation = conversation.generations.at(-1)!;
  if (options.hostEntry !== false) registry.upsert({ key: { engine: "codex", sessionId: generation.id }, artifactPath, cwd: worktree,
    accountId: "stage-account", launchProfile: profile, status: "dead", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:released",
      process: { pid: 4040, startIdentity: "departed-process" }, eventCursor: 9, protocolVersion: "v2",
      writerClaimEpoch: 3, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 3, claimOwner: "structured-host:departed-owner", pendingAction: null });
  if (options.stage !== false) {
    const pipeline = buildPipeline({ id: pipelineId, task: "Settled stage delivery", project: "fixture",
      repoDir: path.join(directory, "repo"), stages: [
        { id: "build", kind: "run", prompt: "Build", next: "review", effectiveRole: role },
        { id: "review", kind: "run", prompt: "Review", next: null, effectiveRole: role },
      ], srcPath: null, srcConversationId: null, now: "2026-11-16T22:00:00.000Z" });
    pipeline.state = "running";
    // A settled build has handed the lane on; a running one still holds the cursor.
    pipeline.cursor = { ...pipeline.cursor!, stageId: (options.state ?? "passed") === "running" ? "build" : "review", state: "running" };
    pipeline.runs[0]!.attempts = [attemptRow(1, options.state ?? "passed", conversation.id, generation.id, artifactPath)];
    if (options.successor) {
      pipeline.runs[0]!.attempts.push(attemptRow(2, "running", "conversation_live-successor", "successor-session",
        path.join(directory, "sessions", "successor.jsonl")));
    }
    registry.rememberMembership(conversation.id, { kind: "pipeline", containerId: pipelineId, role: "builder",
      slot: "build:1", stageId: "build", stageOrder: 0, round: 1, parentConversationId: null });
    savePipelines([...loadPipelines().filter(row => row.id !== pipelineId), pipeline]);
  }
  const account: AccountContext = { engine: "codex", accountId: "stage-account", kind: "managed",
    home: path.join(directory, "account"), transcriptRoot: directory, env: { NODE_ENV: "test" } };
  let spawns = 0, commands = 0, kicks = 0;
  const deadSession: RuntimeSnapshot["sessions"][number] = {
    conversationId: conversation.id, sessionKey: { engine: "codex", sessionId: generation.id },
    hostKind: "codex-app-server", host: "dead", turn: "idle", provenance: "structured", revision: 1, attentionIds: [],
    recentReceipts: [], accountId: null, parentConversationId: null, flowId: null, workflowId: null, cwd: worktree,
    artifactPath, capabilities: { steer: true, structuredAttention: true, imageInput: { supported: false } as never },
    activeTurnId: null,
  };
  const journal = new RuntimeJournal(path.join(directory, "journal.sqlite"), { structuredHosts: true });
  const client = {
    readSession: async () => deadSession,
    operationStatus: async (id: string) => journal.operationResult(id),
    command: async () => { commands += 1; throw new Error("no host may receive this message"); },
  } as unknown as RuntimeHostClient;
  const progress = new DeliveryProgressStore(path.join(directory, "progress.json"));
  /* The real recovery, stopped where a host would start. */
  const recover: typeof recoverDeadStructuredConversation = (request, dependencies) => recoverDeadStructuredConversation(request, {
    ...dependencies, transportAvailable: () => true, resolveAccount: () => account,
    spawn: async () => { spawns += 1; throw new Error("fixture stops at host start"); },
  });
  const dependencies = { enabled: () => true, client: () => client, registry: () => registry, progress,
    kick: () => { kicks += 1; }, requestMigrationTick: () => {}, recover };
  return { registry, conversation, generation, artifactPath, pipelineId, journal, progress, dependencies,
    spawns: () => spawns, commands: () => commands, kicks: () => kicks };
}

for (const state of ["passed", "failed", "needs_decision", "skipped"] as const) {
  test(`a send to a stage whose attempt ${state} ends at once with stage_attempt_settled`, async () => {
    const f = stageConversation({ state });
    try {
      const result = await enqueueStructuredMessage({ path: f.artifactPath, conversationId: f.conversation.id,
        clientMessageId: `settled-${state}`, text: "follow up on the stage's publication" }, f.dependencies);

      expect(result).toMatchObject({ ok: false, outcome: "failed", status: 409, code: "stage_attempt_settled" });
      const error = (result as { error: string }).error;
      expect(error).toContain(`(${state})`);
      expect(error).toContain(state === "needs_decision" ? "resolve-decision or retry-stage" : "pipeline_action retry-stage");
      expect(error).toContain(`pipeline ${f.pipelineId} stage build`);
      expect(error).not.toContain("upgrade-era");
      // Nothing was started, stopped or dispatched, and no drain owns it.
      expect(f.spawns()).toBe(0);
      expect(f.commands()).toBe(0);
      expect(f.kicks()).toBe(0);
      const operationId = (result as { operationId: string }).operationId;
      const record = Object.values(f.registry.snapshot().heldDeliveries).find(row => row.command.operationId === operationId);
      expect(record).toMatchObject({ state: "failed", error });
      expect(f.registry.pendingDeliveries(f.conversation.id).filter(row => row.state !== "failed")).toEqual([]);
      expect(f.progress.get(operationId)).toMatchObject({ terminal: { state: "failed" } });
      expect(JSON.stringify(f.progress.get(operationId))).not.toContain("awaiting-host");
      expect(f.registry.hostEntry({ engine: "codex", sessionId: f.generation.id })).toMatchObject({
        status: "dead", claimEpoch: 3 });
    } finally { f.journal.close(); f.registry.close(); }
  });
}

test("a send to a settled stage names the stage's live successor", async () => {
  const f = stageConversation({ state: "passed", successor: true });
  try {
    const result = await enqueueStructuredMessage({ path: f.artifactPath, conversationId: f.conversation.id,
      clientMessageId: "settled-successor", text: "follow up" }, f.dependencies);
    expect(result).toMatchObject({ ok: false, code: "stage_attempt_settled" });
    expect((result as { error: string }).error).toContain("Send to its live attempt conversation_live-successor");
  } finally { f.journal.close(); f.registry.close(); }
});

for (const shape of ["running stage", "plain conversation"] as const) {
  test(`a send to a ${shape} with a dead host still goes to recovery`, async () => {
    const f = stageConversation(shape === "running stage" ? { state: "running" } : { stage: false });
    try {
      const result = await enqueueStructuredMessage({ path: f.artifactPath, conversationId: f.conversation.id,
        clientMessageId: `unaffected-${shape}`, text: "continue" }, f.dependencies);
      // The rehost was attempted; the fixture's stopped host start keeps the send held for the drain.
      expect(f.spawns()).toBe(1);
      expect(result).toMatchObject({ ok: true, outcome: "held" });
      expect(result).not.toHaveProperty("code");
    } finally { f.journal.close(); f.registry.close(); }
  });
}

test("a held send whose stage settled meanwhile is rejected by its drain, never retried", async () => {
  const f = stageConversation({ state: "passed" });
  try {
    const held = f.registry.holdDelivery(f.conversation.id, "queued before the stage settled", "settled-drain", "text", [], null,
      { operationId: "settled-drain-operation", kind: "send", policy: "queue", turnId: null });
    const outcomes: unknown[] = [];
    await drainHeldDeliveries(f.conversation.id, {
      deliver: async ({ delivery, path: pathname, clientMessageId }) => {
        const outcome = await deliverHeldStructuredMessage({ conversationId: f.conversation.id, path: pathname,
          deliveryId: delivery.id, clientMessageId, text: delivery.text, command: delivery.command }, f.dependencies)
          ?? "delivery-uncertain";
        outcomes.push(outcome);
        return outcome;
      },
    }, f.registry);
    expect(outcomes).toEqual([{ outcome: "rejected", cause: expect.stringContaining("stage attempt already settled (passed)") }]);
    expect(f.spawns()).toBe(0);
    expect(f.commands()).toBe(0);
    expect(f.registry.snapshot().heldDeliveries[held.id]).toMatchObject({
      state: "failed", error: expect.stringContaining("pipeline_action retry-stage") });
  } finally { f.journal.close(); f.registry.close(); }
});

test("a held send the runtime journal already admitted stays uncertain when its stage settled", async () => {
  const f = stageConversation({ state: "passed" });
  try {
    const held = f.registry.holdDelivery(f.conversation.id, "journaled before the host died", "settled-journaled", "text", [], null,
      { operationId: "settled-journaled-operation", kind: "send", policy: "queue", turnId: null });
    f.journal.executeOperation({ kind: "send", conversationId: f.conversation.id, operationId: "settled-journaled-operation",
      idempotencyKey: "settled-journaled", text: held.text, policy: "queue" });
    const outcome = await deliverHeldStructuredMessage({ conversationId: f.conversation.id, path: f.artifactPath,
      deliveryId: held.id, clientMessageId: "settled-journaled", text: held.text, command: held.command }, f.dependencies);
    expect(outcome).toBe("delivery-uncertain");
    expect(f.spawns()).toBe(0);
  } finally { f.journal.close(); f.registry.close(); }
});

test("the migration sweep calls only a reservation older than the serving process upgrade-era", async () => {
  setSystemTime(new Date("2026-11-16T23:14:30.000Z"));
  const f = stageConversation({ stage: false, hostEntry: false });
  try {
    const orphan = f.registry.holdDelivery(f.conversation.id, "never assigned to a host", "orphan-after-start");
    setSystemTime(new Date("2026-11-16T23:49:22.000Z"));
    const servingStartedAt = Date.parse("2026-11-16T22:10:00.000Z");
    await reconcileMigrations({} as never, { async deliver() { throw new Error("an orphan is never delivered"); } },
      f.registry, { servingStartedAt });
    const error = f.registry.snapshot().heldDeliveries[orphan.id]!.error!;
    expect(f.registry.snapshot().heldDeliveries[orphan.id]).toMatchObject({ state: "failed" });
    expect(error).not.toContain("upgrade-era");
    expect(error).toContain("no host owns its conversation and no launch is starting for it");

    const residue = f.registry.holdDelivery(f.conversation.id, "admitted by the previous release", "orphan-before-start");
    await reconcileMigrations({} as never, { async deliver() { throw new Error("an orphan is never delivered"); } },
      f.registry, { servingStartedAt: Date.parse("2026-11-17T00:30:00.000Z") });
    expect(f.registry.snapshot().heldDeliveries[residue.id]).toMatchObject({
      state: "failed", error: expect.stringContaining("upgrade-era reservation has no durable owner evidence") });
  } finally { setSystemTime(); f.journal.close(); f.registry.close(); }
});

test("the delivery queue fails a journaled send to a settled stage once, as safe to resend", async () => {
  const { bindStructuredDeliveryQueue } = await import("./structuredDeliveryController");
  const { sendReceiptFor } = await import("./sendSettlement");
  const { structuredContentDigest } = await import("./structuredContent");
  setSystemTime(new Date("2026-11-16T23:14:30.000Z"));
  const f = stageConversation({ state: "passed" });
  const held = f.registry.holdDelivery(f.conversation.id, "queued for a host that will not return", "settled-queue", "text", [], null,
    { operationId: "settled-queue-operation", kind: "send", policy: "queue", turnId: null });
  f.registry.beginDeliveryAttempt(held.id, f.generation.id);
  const journal = f.journal;
  let commands = 0;
  const client = {
    readSession: async identity => journal.readSession(identity), snapshot: async () => journal.snapshot(),
    append: async event => journal.append(event), events: async after => journal.replay(after),
    effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
    operationStatus: async id => journal.operationResult(id),
    command: async command => { commands++; return journal.executeOperation(command); },
    transitionOperation: async (id, status, details, options) => journal.transitionOperation(id, status, details, options),
  } as RuntimeHostClient;
  journal.append({ scope: { type: "session", id: f.conversation.id }, kind: "session-status", payload: {
    conversationId: f.conversation.id, sessionKey: { engine: "codex", sessionId: f.generation.id },
    hostKind: "codex-app-server", host: "hosted", turn: "idle", activeTurnId: null, writerClaim: null, provenance: "structured",
    attentionIds: [], capabilities: { steer: true, structuredAttention: true }, revision: 1,
  } });
  journal.executeOperation({ kind: "send", conversationId: f.conversation.id, operationId: held.command.operationId,
    idempotencyKey: held.clientMessageId!, text: held.text, policy: "queue",
    contentDigest: structuredContentDigest({ text: held.text, images: [] }) });
  try {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client, progress: f.progress, hostlessSettleIntervalMs: 0,
      watchdogIntervalMs: 0, settlementSweepMs: 0, recover: f.dependencies.recover });
    const failed = journal.operationResult(held.command.operationId)!;
    expect(failed.receipt.status, failed.receipt.reason ?? "").toBe("failed");
    expect(failed.receipt.reason).toContain("stage attempt already settled (passed)");
    expect(failed.receipt.reason).toContain("pipeline_action retry-stage");
    expect(commands).toBe(0);
    expect(f.spawns()).toBe(0);
    expect(sendReceiptFor(f.registry.snapshot(), held.command.operationId)).toMatchObject({
      state: "failed", duplicateRisk: false, resend: "safe" });
  } finally {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    journal.close(); f.registry.close(); setSystemTime();
  }
});
