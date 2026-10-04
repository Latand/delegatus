import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hardenedRedact } from "@/lib/view/compactText";
import { readMessagesPage } from "@/lib/session/messagesPage";
import { prepareControllerArtifactDirectory } from "./controllerArtifacts";
import type { PipelinePorts } from "./engine";
import type { AgentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { StructuredControlResult } from "@/lib/runtime/structuredControls";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { Pipeline, PipelineStage, PipelineStageAttempt, PipelineRuntimeSeat, PipelineRuntimeSwitch, EffectivePipelineRole } from "./types";

export class RuntimeSwitchSuperseded extends Error {
  constructor() { super("runtime switch changed before dispatch or settlement"); }
}

/** A native no-op has no journal receipt to reconcile. */
export function runtimeSwitchControlAcknowledgement(result: StructuredControlResult | null): "already-current" | void {
  if (!result || !("ok" in result.body) || result.body.ok !== true) throw new Error(result && "error" in result.body ? result.body.error : "structured control unavailable");
  if ("outcome" in result.body && result.body.outcome === "withdrawn") return "already-current";
}

const OPEN = new Set(["requested", "cutting", "switching", "continuing"]);
const BUDGET = 10 * 60_000;
export const openRuntimeSwitch = (attempt: PipelineStageAttempt) => attempt.runtimeSwitches?.find(item => OPEN.has(item.phase));
export function currentRuntimeSeat(attempt: PipelineStageAttempt): PipelineRuntimeSeat {
  return { engine: attempt.effectiveRole.engine, model: attempt.effectiveRole.model, effort: attempt.effectiveRole.effort,
    serviceTier: attempt.effectiveRole.serviceTier ?? null, accountId: attempt.accountId ?? null };
}
export function runtimeTargetsEqual(a: PipelineRuntimeSeat, b: PipelineRuntimeSeat): boolean {
  const tier = (value: string | null) => value === null || value === "default" || value === "standard" ? "standard" : value;
  return a.engine === b.engine && a.model === b.model && a.effort === b.effort && a.accountId === b.accountId
    && tier(a.serviceTier) === tier(b.serviceTier);
}
export function attemptEvidenceFloor(attempt: PipelineStageAttempt): string | null {
  return attempt.runtimeSwitches?.reduce((floor, item) => item.continuedAt && Date.parse(item.continuedAt) > Date.parse(floor ?? "") ? item.continuedAt : floor, attempt.startedAt) ?? attempt.startedAt;
}
export function attemptAccountPin(stage: PipelineStage, attempt: PipelineStageAttempt): string | null {
  if (attempt.runtimeAccountPin !== undefined) return attempt.runtimeAccountPin;
  const switched = attempt.runtimeSwitches?.findLast(item => item.phase === "committed");
  return switched ? switched.to.accountPinned ? switched.to.accountId : null : attempt.definition ? attempt.definition.account : stage.account ?? null;
}
export const switchOperationKey = (record: PipelineRuntimeSwitch, action: string) => `pswitch-${crypto.createHash("sha256").update(record.id).digest("hex").slice(0,40)}-${action}`;

export async function hasRuntimeSwitchKill(client: Pick<RuntimeHostClient, "effectBatch" | "operationStatus">, conversationId: string, since: string, ignoredOperationIds: readonly string[] = []): Promise<boolean> {
  let cursor = 0;
  while (true) {
    const page = await client.effectBatch(["runtime.kill-boundary"], cursor);
    for (const effect of page) {
      if (effect.payload.conversationId !== conversationId || typeof effect.payload.operationId !== "string" || ignoredOperationIds.includes(effect.payload.operationId)) continue;
      const receipt = (await client.operationStatus(effect.payload.operationId))?.receipt;
      if (!receipt) throw new Error("runtime kill boundary has no retained receipt; continuation is fenced");
      if (Date.parse(receipt.admittedAt ?? receipt.at) > Date.parse(since)) return true;
    }
    if (page.length < 100) return false;
    const next = Math.max(...page.map(effect => effect.eventSeq));
    if (!Number.isSafeInteger(next) || next <= cursor) throw new Error("runtime kill boundary page did not advance");
    cursor = next;
  }
}

export function cancelPendingRuntimeSwitch(registry: Pick<AgentRegistry, "conversation" | "withdrawConversationReconfigure" | "cancelConversationSwitch" | "reconfigureOwnedCancellableSwitch" | "releaseSwitchHold">, conversationId: string, operationId: string): void {
  const id = conversationId as ViewerConversationId;
  const withdrawal = registry.withdrawConversationReconfigure(id, operationId);
  if (withdrawal.kind === "claimed") {
    const conversation = withdrawal.conversation;
    if (!conversation.migration || !registry.reconfigureOwnedCancellableSwitch(id)) throw new Error("runtime switch is already applying");
    registry.cancelConversationSwitch(id, conversation.migration.revision);
  } else if (withdrawal.kind === "settled" && withdrawal.conversation.reconfigure?.status !== "failed") {
    throw new Error("runtime switch already settled; reconcile its outcome");
  }
  registry.releaseSwitchHold(id);
}
function clearOldWaits(attempt: PipelineStageAttempt) {
  delete attempt.providerWait; delete attempt.providerRecoveryBudget; delete attempt.severedTurn;
  delete attempt.verdictRequest; delete attempt.backgroundWait; delete attempt.controllerWait;
}

function writeArtifact(file: string, content: string): void {
  const temporary = path.join(path.dirname(file), `.${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** The tick owns this attempt until every accepted operation has a terminal
 * witness. All dispatches replay their persisted key after a process restart. */
export async function driveRuntimeSwitch(
  pipeline: Pipeline, stage: PipelineStage, attempt: PipelineStageAttempt, ports: PipelinePorts, persist: () => void | Promise<void>,
  spawnInput: (role: EffectivePipelineRole) => Promise<Parameters<PipelinePorts["spawnAgent"]>[0]>,
): Promise<void> {
  const record = openRuntimeSwitch(attempt);
  if (!record) return;
  const now = ports.now();
  const expired = Date.parse(now) - Date.parse(record.requestedAt) >= BUDGET;
  const settle = async (phase: PipelineRuntimeSwitch["phase"], reason: string) => {
    record.phase = phase; record.settledAt = now; record.outcome = reason;
    pipeline.stateDetail = reason; await persist();
  };
  const park = async (reason: string) => { pipeline.state = "needs_decision"; pipeline.stateDetail = reason; attempt.state = "needs_decision"; record.outcome = reason; await persist(); };
  const reconfigureKey = switchOperationKey(record, "reconfigure");
  const continueKey = record.continuationKey ?? switchOperationKey(record, "continue");
  const resume = async (key: string) => {
    if (!ports.resumeSeveredTurn || !attempt.agentPath || !attempt.conversationId) throw new Error("stage continuation unavailable");
    const admitted = await ports.resumeSeveredTurn({ conversationId: attempt.conversationId, transcriptPath: attempt.agentPath,
      clientMessageId: key, policy: "queue", project: pipeline.project, cwd: pipeline.worktreeDir, cohortAt: attempt.startedAt ?? undefined,
      text: "Delegatus stopped your turn for a runtime switch. Continue the same stage on the available runtime in the current worktree, preserving every committed and uncommitted change, branch, attempt number and receipts. Report when complete." });
    if (!admitted) throw new Error("stage continuation was not accepted");
  };
  const rollback = async (reason: string) => {
    Object.assign(attempt, { conversationId: record.from.conversationId, launchId: record.from.launchId,
      sessionId: record.from.sessionId, agentPath: record.from.agentPath, accountId: record.from.accountId });
    Object.assign(attempt.effectiveRole, { engine: record.from.engine, model: record.from.model, effort: record.from.effort, serviceTier: record.from.serviceTier ?? undefined });
    record.rollback = true; record.outcome = reason; record.phase = "continuing";
    // Cancelling a migration rearms its held message on the source. Reuse
    // that admission; a new key is safe only after a terminal send failure.
    const previous = await ports.runtimeSwitchDelivery?.(record.from.conversationId, continueKey);
    record.continuationKey = previous?.state === "failed" ? switchOperationKey(record, "rollback") : continueKey; await persist();
    await resume(record.continuationKey);
  };
  try {
    if (await ports.runtimeSwitchKilled?.(attempt.conversationId ?? record.from.conversationId, record.requestedAt,
      record.mode === "handoff" ? [switchOperationKey(record, "stop"), switchOperationKey(record, "stop-launch")] : [])) {
      await settle("failed", "stage stopped by kill during runtime switch");
      await park("stage stopped by kill during runtime switch"); return;
    }
    const pool = ports.allowedAccountIds?.(pipeline.project, record.to.engine);
    if (record.phase === "requested" && pool && !pool.includes(record.to.accountId!)) { await settle("failed", "target account is no longer allowed; stage stays on its runtime"); return; }
    if (record.phase === "requested") {
      if (ports.conversationDeliveryOutstanding?.(record.from.conversationId)) {
        if (expired) await settle("failed", "runtime switch was not started: another delivery is pending");
        else ports.scheduleTick?.(1000);
        return;
      }
      if ((ports.engineReadiness?.(record.to.engine, pipeline.project) ?? "connected") !== "connected") { await settle("failed", "target engine is unavailable; stage stays on its runtime"); return; }
      record.phase = "cutting"; await persist();
    }
    if (record.phase === "cutting") {
      if (record.mode === "fork") {
        if (!ports.runtimeSwitchControl) throw new Error("runtime switch control unavailable");
        await ports.runtimeSwitchControl(record.from.conversationId, record.from.agentPath!, "interrupt", switchOperationKey(record, "interrupt"), record.to);
        record.phase = "switching"; await persist();
      } else {
        const stopped = await ports.stopStageAgent({ stageId: stage.id, attempt: attempt.n, conversationId: record.from.conversationId,
          launchId: record.from.launchId, agentPath: record.from.agentPath, paneId: null }, { operationId: switchOperationKey(record, "stop") });
        if (stopped.outcome !== "stopped" && stopped.outcome !== "not-running") {
          if (stopped.outcome === "unconfirmed" || stopped.outcome === "unresolved") {
            const detail = "detail" in stopped ? stopped.detail : stopped.error;
            if (expired) await park(`runtime switch stop remains unconfirmed: ${detail}`);
            else { pipeline.stateDetail = `runtime switch waiting for confirmed stop: ${detail}`; await persist(); ports.scheduleTick?.(1000); }
            return;
          }
          await settle("failed", `could not stop the running agent: ${"error" in stopped ? stopped.error : stopped.outcome}`); return;
        }
        record.cutAt = ports.now(); record.phase = "switching"; await persist();
      }
    }
    if (record.phase === "switching" && record.mode === "fork") {
      if (!record.reconfigureNoop) {
        const acknowledgement = await ports.runtimeSwitchControl!(record.from.conversationId, record.from.agentPath!, "reconfigure", reconfigureKey, record.to);
        if (acknowledgement === "already-current") { record.reconfigureNoop = true; await persist(); }
      }
      // Queue ordering puts reconfigure before the engagement that performs an account move.
      await resume(continueKey);
      const outcome = record.reconfigureNoop ? { state: "applied" as const } : await ports.runtimeSwitchOutcome?.(record.from.conversationId, reconfigureKey);
      if (!outcome || outcome.state === "pending") {
        if (expired) {
          try { await ports.cancelRuntimeSwitch?.(record.from.conversationId, reconfigureKey); }
          catch (error) { await park(`runtime switch did not settle; cancellation refused: ${String(error)}`); return; }
          if (!ports.cancelRuntimeSwitch) { await park("runtime switch did not settle; cancellation unavailable"); return; }
          await rollback("runtime switch exceeded its budget");
        } else { pipeline.stateDetail = `switching to ${record.to.engine}/${record.to.model}`; await persist(); ports.scheduleTick?.(1000); }
        return;
      }
      if (outcome.state === "failed") {
        const delivery = await ports.runtimeSwitchDelivery?.(record.from.conversationId, continueKey);
        if (delivery?.state === "delivered") {
          record.continuedAt = delivery.at ?? now; clearOldWaits(attempt); await settle("rolled-back", outcome.error ?? "runtime switch failed; continued on previous runtime"); return;
        }
        await ports.cancelRuntimeSwitch?.(record.from.conversationId, reconfigureKey);
        await rollback(outcome.error ?? "runtime switch failed"); return;
      }
      record.cutAt ??= now;
      record.phase = "continuing";
      if (outcome.state === "superseded") record.outcome = "superseded by another runtime selection";
      await persist();
    }
    if (record.phase === "switching" && record.mode === "handoff") {
      const role = { ...attempt.effectiveRole, engine: record.to.engine, model: record.to.model, effort: record.to.effort, serviceTier: record.to.serviceTier ?? undefined };
      delete role.preferredServiceTier; delete role.serviceTierSource;
      const input = await spawnInput(role);
      if (!record.handoff) {
        const tail: string[] = [];
        if (record.from.agentPath && fs.existsSync(record.from.agentPath)) {
          const descriptor = fs.openSync(record.from.agentPath, "r");
          try {
            const page = readMessagesPage({ descriptor, size: fs.fstatSync(descriptor).size, engine: record.from.engine },
              { kinds: new Set(["message", "tool_call", "tool_result"]), roles: new Set(["user", "assistant", "tool", "system"]), limit: 40, maxChars: 2000 });
            tail.push(...page.records.reverse().map(item => `${item.role}: ${item.text}`));
          } finally { fs.closeSync(descriptor); }
        }
        for (const args of [["status", "--porcelain"], ["log", `${pipeline.baseRef}..HEAD`, "--oneline", "-20"]]) {
          const result = await ports.exec("git", args, pipeline.worktreeDir);
          tail.push(result.code === 0 ? result.stdout.split("\n").slice(0,40).join("\n") : "Git observation unavailable");
        }
        const content = hardenedRedact(`Continue attempt ${attempt.n} from ${record.from.engine}/${record.from.model} on ${record.to.engine}/${record.to.model}. Keep the same worktree and branch. Do not reset, stash or discard work.\n${tail.join("\n")}`);
        const directory = await prepareControllerArtifactDirectory(pipeline.worktreeDir, ports.exec);
        const digest = crypto.createHash("sha256").update(content).digest("hex");
        const file = path.join(directory, `runtime-handoff-${digest}.md`);
        writeArtifact(file, content);
        const suffix = `\nContinuing on a new runtime. Read the complete handoff: ${file}\n${content.slice(0,4000)}`;
        // Externalize the bound brief if its framing and the handoff exceed the transport limit.
        let brief = input.prompt;
        if (Buffer.byteLength(brief + suffix) > 32000) {
          const briefFile = path.join(directory, `runtime-brief-${crypto.createHash("sha256").update(brief).digest("hex")}.md`);
          writeArtifact(briefFile, brief); brief = `Read the complete stage brief: ${briefFile}`;
        }
        const prompt = brief + suffix;
        record.handoff = { prompt, digest: crypto.createHash("sha256").update(prompt).digest("hex"), bytes: Buffer.byteLength(prompt) };
        record.launch = { clientAttemptId: input.clientAttemptId, launchId: null, conversationId: null }; await persist();
      }
      const receipt = record.launch?.launchId ? ports.spawnReceipt(record.launch.launchId) : null;
      if (!receipt && record.launch?.launchId && expired) {
        const stopped = await ports.stopStageAgent({ stageId: stage.id, attempt: attempt.n, conversationId: record.launch.conversationId, launchId: record.launch.launchId, agentPath: null, paneId: null }, { operationId: switchOperationKey(record, "stop-launch") });
        if (stopped.outcome !== "stopped" && stopped.outcome !== "not-running") { await park("runtime switch launch could not be proven stopped"); return; }
        await rollback("runtime switch launch receipt unavailable after budget"); return;
      }
      if (receipt && receipt.state !== "completed") {
        if (["failed", "conflicted"].includes(receipt.state) || expired) {
          if (receipt.staged || receipt.state === "path-pending") {
            ports.failStageLaunch?.(receipt.launchId, receipt.conversationId!, "runtime switch launch exceeded its budget");
            const stopped = await ports.stopStageAgent({ stageId: stage.id, attempt: attempt.n, conversationId: receipt.conversationId, launchId: receipt.launchId, agentPath: receipt.transcript, paneId: receipt.paneId }, { operationId: switchOperationKey(record, "stop-launch") });
            if (stopped.outcome !== "stopped" && stopped.outcome !== "not-running") { await park("runtime switch launch could not be proven stopped"); return; }
          }
          await rollback(receipt.error ?? "runtime switch launch failed");
        } else { await ports.recoverStagedLaunch?.(receipt.launchId, () => pipeline.state === "running"); ports.scheduleTick?.(1000); }
        return;
      }
      let spawned;
      try {
        spawned = receipt?.state === "completed" ? receipt : await ports.spawnAgent({ ...input, prompt: record.handoff.prompt, clientAttemptId: record.launch!.clientAttemptId }, async reservation => {
          record.launch!.launchId = reservation.launchId; record.launch!.conversationId = reservation.conversationId;
          attempt.launchId = reservation.launchId; attempt.conversationId = reservation.conversationId; attempt.accountId = reservation.accountId ?? record.to.accountId;
          attempt.sessionId = null; attempt.agentPath = null;
          await persist();
        });
      } catch (error) {
        // A reserved launch may already be running. Reconcile it before rollback.
        if (record.launch?.launchId) { ports.scheduleTick?.(1000); return; }
        await rollback(String(error)); return;
      }
      Object.assign(attempt, { launchId: spawned.launchId, conversationId: spawned.conversationId,
        sessionId: spawned.sessionId, agentPath: spawned.transcript, accountId: spawned.accountId ?? record.to.accountId });
      if (!attempt.agentPath || !attempt.sessionId) { ports.scheduleTick?.(1000); await persist(); return; }
      // The new transcript belongs entirely to the successor, including a
      // turn that finished before its path or launch receipt was published.
      delete attempt.effectiveRole.preferredServiceTier; delete attempt.effectiveRole.serviceTierSource;
      Object.assign(attempt.effectiveRole, role); record.continuedAt = record.cutAt;
      attempt.hostEpoch = await ports.runtimeHostEpoch?.() ?? attempt.hostEpoch;
      attempt.runtimeAccountPin = record.to.accountPinned ? record.to.accountId : null;
      clearOldWaits(attempt); await settle("committed", `continued on ${record.to.engine}/${record.to.model}`); return;
    }
    if (record.phase === "continuing") {
      const key = record.continuationKey ?? continueKey;
      const delivered = await ports.runtimeSwitchDelivery?.(attempt.conversationId!, key);
      if (delivered?.state === "delivered") {
        record.continuedAt = delivered.at ?? now;
        const generation = ports.conversationGeneration?.(attempt.conversationId!);
        if (!generation) { if (expired) await park("continued runtime generation is unavailable"); else ports.scheduleTick?.(1000); return; }
        if (record.reconfigureNoop && !runtimeTargetsEqual(generation, record.to)) record.outcome = "superseded by another runtime selection";
        if (!record.rollback) { delete attempt.effectiveRole.preferredServiceTier; delete attempt.effectiveRole.serviceTierSource; }
        Object.assign(attempt.effectiveRole, { engine: generation.engine, model: generation.model, effort: generation.effort, serviceTier: generation.serviceTier ?? undefined });
        Object.assign(attempt, { accountId: generation.accountId, agentPath: generation.agentPath, sessionId: generation.sessionId });
        clearOldWaits(attempt);
        attempt.hostEpoch = await ports.runtimeHostEpoch?.() ?? attempt.hostEpoch;
        if (!record.rollback && !record.outcome) attempt.runtimeAccountPin = record.to.accountPinned ? record.to.accountId : null;
        await settle(record.rollback ? "rolled-back" : record.outcome ? "superseded" : "committed", record.outcome ?? `continued on ${generation.engine}/${generation.model}`);
      } else if (delivered?.state === "failed") {
        if (record.continuationKey) { await park(`runtime switch continuation failed: ${delivered.error ?? "delivery failed"}`); return; }
        record.continuationKey = switchOperationKey(record, "continue-2"); await persist(); await resume(record.continuationKey);
      } else if (expired) await park("stage stopped mid-turn; runtime switch continuation delivery is still pending");
      else { await resume(key); ports.scheduleTick?.(1000); }
    }
  } catch (error) {
    if (error instanceof RuntimeSwitchSuperseded) throw error;
    pipeline.stateDetail = `runtime switch waiting: ${String(error)}`;
    if (expired) await park(`stage stopped mid-turn; runtime switch could not complete: ${String(error)}`);
    else { await persist(); ports.scheduleTick?.(1000); }
  }
}
