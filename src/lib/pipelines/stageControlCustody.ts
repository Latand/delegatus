import { createHash } from "node:crypto";
import { z } from "zod";
import type { RuntimeOperationResult } from "@/lib/runtime/contracts";
import { claimPipelineControlOwnership, pipelineControlOwnership } from "./store";
import type { PipelineStageHostRef } from "./types";

const idleStopBinding = z.object({
  kind: z.literal("idle-stop"),
  operationId: z.string().min(1),
  conversationId: z.string().min(1),
  sessionKey: z.object({ engine: z.enum(["claude", "codex", "copilot"]), sessionId: z.string().min(1) }),
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
export async function claimIdleStop(key: string, identity: IdleStopIdentity, replaces?: IdleStopBinding) {
  const authority = digest([identity.conversationId, identity.sessionKey.engine, identity.sessionKey.sessionId,
    identity.transcriptPath, identity.revision, identity.writerClaim]);
  const binding = idleStopBinding.parse({ kind: "idle-stop", operationId: "pipeline-stop-" + authority, ...identity });
  // Separate attempts can point at the same observed host. Claim the fence
  // once and store its binding under each attempt key for later readback.
  const record = await claimPipelineControlOwnership(key, JSON.stringify(binding), "pipeline-idle-fence-" + authority,
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

export async function claimWithdrawal(key: string, identity: Omit<WithdrawalBinding, "kind" | "producerPrefix">) {
  const binding = withdrawalBinding.parse({
    kind: "continuation-withdrawal", producerPrefix: "pipeline-withdrawal:" + digest([key, identity]) + ":", ...identity,
  });
  const record = await claimPipelineControlOwnership(key, JSON.stringify(binding));
  return { acquired: record.acquired, binding: withdrawalBinding.parse(JSON.parse(record.binding)) };
}
