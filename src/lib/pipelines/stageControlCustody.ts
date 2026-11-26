import { createHash } from "node:crypto";
import { z } from "zod";
import type { RuntimeOperationResult } from "@/lib/runtime/contracts";
import { claimPipelineControlOwnership, consumePipelineControlOwnership, pipelineControlOwnership, settlePipelineControlOwnership } from "./store";
import type { PipelineStageHostRef } from "./types";

const idleStopBinding = z.object({
  kind: z.literal("idle-stop"),
  operationId: z.string().min(1),
  conversationId: z.string().min(1),
  sessionKey: z.object({ engine: z.enum(["claude", "codex", "copilot", "antigravity"]), sessionId: z.string().min(1) }),
  transcriptPath: z.string().min(1),
  revision: z.number().int().nonnegative(),
  writerClaim: z.string().min(1),
}).strict();
export type IdleStopBinding = z.infer<typeof idleStopBinding>;
type IdleStopIdentity = Omit<IdleStopBinding, "kind" | "operationId">;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const idleStopPrefix = "pipeline-idle-stop-";
export function terminalIdleStopKey(target: PipelineStageHostRef): string {
  return idleStopPrefix + digest([target.conversationId, target.launchId, target.agentPath, target.paneId]);
}
export function terminalIdleStopOwner(key: string | undefined): key is string {
  return key?.startsWith(idleStopPrefix) === true;
}

export async function readIdleStop(key: string): Promise<IdleStopBinding | null> {
  const record = await pipelineControlOwnership(key);
  return record === null ? null : idleStopBinding.parse(JSON.parse(record));
}

/** Commit an immutable authority binding before the attempt can acquire
 * dispatch rights. Recovery can read the same operation across a restart. */
export async function claimIdleStop(key: string, identity: IdleStopIdentity, replaces?: IdleStopBinding, retryAfter?: string) {
  const authority = digest([identity.conversationId, identity.sessionKey.engine, identity.sessionKey.sessionId,
    identity.transcriptPath, identity.revision, identity.writerClaim]);
  // A receipt that proves a previous idle stop had no effect permits a fresh
  // operation after the caller has observed idle state and the current writer.
  // Chain the new key to that exact receipt so replay remains idempotent.
  const operationId = "pipeline-stop-" + digest([authority, retryAfter ?? null]);
  const binding = idleStopBinding.parse({ kind: "idle-stop", operationId, ...identity });
  // Separate attempts can point at the same observed host. Claim the fence
  // once and store its binding under each attempt key for later readback.
  const record = await claimPipelineControlOwnership(key, JSON.stringify(binding), "pipeline-idle-fence-" + operationId,
    replaces && JSON.stringify(replaces));
  return { acquired: record.acquired, binding: idleStopBinding.parse(JSON.parse(record.binding)) };
}

export function idleStopReceiptMatches(result: RuntimeOperationResult, binding: IdleStopBinding): boolean {
  const { receipt } = result;
  return result.operationId === binding.operationId && receipt.operationId === binding.operationId
    && receipt.idempotencyKey === binding.operationId && receipt.conversationId === binding.conversationId
    && receipt.kind === "kill" && receipt.origin === "system" && receipt.originAuthenticated === true;
}

const withdrawalBinding = z.object({
  kind: z.literal("continuation-withdrawal"),
  conversationId: z.string().min(1),
  producerPrefix: z.string().min(1),
  sessionKey: idleStopBinding.shape.sessionKey,
  artifactPath: z.string().min(1),
  revision: z.number().int().nonnegative(),
  writerClaim: z.string().min(1).nullable(),
}).strict();
export type WithdrawalBinding = z.infer<typeof withdrawalBinding>;

export async function readWithdrawal(key: string): Promise<WithdrawalBinding | null> {
  const record = await pipelineControlOwnership(key);
  return record === null ? null : withdrawalBinding.parse(JSON.parse(record));
}

export async function claimWithdrawal(key: string, identity: Omit<WithdrawalBinding, "kind" | "producerPrefix">,
  replaces?: WithdrawalBinding) {
  const authority = digest([identity.conversationId, identity.sessionKey.engine, identity.sessionKey.sessionId,
    identity.artifactPath, identity.revision, identity.writerClaim]);
  const binding = withdrawalBinding.parse({
    kind: "continuation-withdrawal", producerPrefix: "pipeline-withdrawal:" + authority + ":", ...identity,
  });
  const record = await claimPipelineControlOwnership(key, JSON.stringify(binding), "pipeline-withdrawal-fence-" + authority,
    replaces && JSON.stringify(replaces), replaces && deadWithdrawalKey(replaces));
  return { acquired: record.acquired, binding: withdrawalBinding.parse(JSON.parse(record.binding)) };
}

function withdrawalRefusalKey(binding: WithdrawalBinding): string {
  return "pipeline-withdrawal-refusal-" + digest(binding.producerPrefix);
}

/** An explicit pre-admission refusal permits one retry of the same event.
 * Consume it before dispatch so interrupted recovery stays in custody. */
export async function recordWithdrawalRefusal(binding: WithdrawalBinding, reason: string): Promise<void> {
  await claimPipelineControlOwnership(withdrawalRefusalKey(binding), JSON.stringify(reason));
}

export async function hasWithdrawalRefusal(binding: WithdrawalBinding, reason: string): Promise<boolean> {
  return await pipelineControlOwnership(withdrawalRefusalKey(binding)) === JSON.stringify(reason);
}

export async function consumeWithdrawalRefusal(binding: WithdrawalBinding, reason: string): Promise<boolean> {
  return consumePipelineControlOwnership(withdrawalRefusalKey(binding), JSON.stringify(reason));
}

const deadWithdrawalReason = JSON.stringify("expired fence on a dead session");

function deadWithdrawalKey(binding: WithdrawalBinding): string {
  return "pipeline-withdrawal-dead-" + digest(binding.producerPrefix);
}

export async function settleDeadWithdrawal(key: string, binding: WithdrawalBinding): Promise<boolean> {
  return settlePipelineControlOwnership(key, JSON.stringify(binding), deadWithdrawalKey(binding), deadWithdrawalReason);
}

export async function withdrawalSettledDead(binding: WithdrawalBinding): Promise<boolean> {
  return await pipelineControlOwnership(deadWithdrawalKey(binding)) === deadWithdrawalReason;
}
