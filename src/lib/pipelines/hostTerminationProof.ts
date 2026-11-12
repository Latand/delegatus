import crypto from "node:crypto";
import type { Pipeline, PipelineStageHostRef } from "./types";

export type HostTerminationProgress = { source: string; next: number };
export const hostTerminationKey = (host: PipelineStageHostRef) => crypto.createHash("sha256")
  .update(JSON.stringify([host.stageId, host.attempt, host.conversationId, host.agentPath, host.paneId ?? null])).digest("hex");

export function isHostTerminationProgress(value: unknown): value is Record<string, HostTerminationProgress> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => /^[a-f0-9]{64}$/.test(key) && item && typeof item === "object"
      && /^[a-f0-9]{64}$/.test(item.source) && Number.isSafeInteger(item.next) && item.next >= 0);
}

// Scoped to the exact mutable row. Validation runs synchronously inside the
// SQLite write transaction, after asynchronous checkpoint admission. Copies
// never inherit callbacks; their proofs must be observed again.
const owner = globalThis as typeof globalThis & { __llvHostTerminationCheckpoints?: WeakMap<Pipeline, Array<() => boolean>> };
const checkpoints = owner.__llvHostTerminationCheckpoints ??= new WeakMap<Pipeline, Array<() => boolean>>();
export function guardHostTerminationCheckpoint(pipeline: Pipeline, verify: () => boolean): void {
  const checks = checkpoints.get(pipeline) ?? [];
  checks.push(verify);
  checkpoints.set(pipeline, checks);
}
export const hostTerminationCheckpointCurrent = (pipeline: Pipeline) => checkpoints.get(pipeline)?.every(check => check()) ?? true;
