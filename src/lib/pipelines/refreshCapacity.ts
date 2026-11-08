import type { Pipeline, PipelineRefresh, PipelineRefreshCapacity } from "./types";
import type { MergeOnReviewSetting } from "@/lib/projects/settings";

/** Chosen policy, measured from reservation admission, including time paused. */
export const REFRESH_CAPACITY_MS = 60 * 60_000;
export const REFRESH_CAPACITY_EXPIRED = "refresh capacity budget expired; original reservation cannot resume";

export type RefreshCreationAuthority = Pick<Pipeline, "id" | "project" | "repoDir" | "spec" | "inputContext"
  | "workspace" | "controlGeneration" | "lastPassedCommit" | "delivery"> & { mergePolicy: MergeOnReviewSetting };

/** Bind child admission to the exact producer snapshot that authorized it. */
export function refreshCreationAuthority(pipeline: Pipeline, mergePolicy: MergeOnReviewSetting): RefreshCreationAuthority {
  return structuredClone({ id: pipeline.id, project: pipeline.project, repoDir: pipeline.repoDir,
    spec: pipeline.spec, inputContext: pipeline.inputContext, workspace: pipeline.workspace,
    controlGeneration: pipeline.controlGeneration, lastPassedCommit: pipeline.lastPassedCommit,
    delivery: pipeline.delivery, mergePolicy });
}

export function refreshCapacity(reservation: PipelineRefresh): PipelineRefreshCapacity {
  return { key: reservation.key, digest: reservation.digest, head: reservation.head, requestedAt: reservation.requestedAt,
    deadline: new Date(Date.parse(reservation.requestedAt) + REFRESH_CAPACITY_MS).toISOString() };
}

export function capacityYieldPending(pipeline: Pipeline): boolean {
  const capacity = pipeline.refreshOf?.capacity;
  return pipeline.runs.some(run => run.attempts.some(attempt => {
    const suspension = attempt.suspension, marker = suspension?.capacityYield;
    if (!marker) return false;
    return !marker.settledAt || !suspension.stoppedAt || !capacity || marker.reservationKey !== capacity.key
      || marker.deadline !== capacity.deadline || marker.headBefore === undefined || marker.headBefore !== null && !marker.headAfter
      || marker.target.stageId !== run.stageId || marker.target.attempt !== attempt.n
      || marker.target.launchId !== attempt.launchId || marker.target.conversationId !== attempt.conversationId
      || marker.target.agentPath !== attempt.agentPath || marker.target.paneId !== attempt.paneId;
  }));
}

export function holdsRefreshCapacity(pipeline: Pipeline): boolean {
  if (capacityYieldPending(pipeline) || pipeline.refreshOf?.capacityRefusal) return true;
  if (!pipeline.refreshOf || pipeline.cursor?.stageId !== "refresh") return false;
  if (pipeline.state === "provisioning") return true;
  if (pipeline.state !== "running") return false;
  const attempt = pipeline.runs.find(run => run.stageId === "refresh")?.attempts.filter(item => !item.historical).at(-1);
  if (pipeline.cursor.state === "pending") return true;
  return Boolean(attempt && ["spawning", "running", "reviewing"].includes(attempt.state));
}

/** Validate the capsule against its exact parent, never manufacture a new origin. */
export function refreshCapacityOrigin(child: Pipeline, parent: Pipeline | null): { capacity: PipelineRefreshCapacity } | { reason: string } {
  const original = parent?.merge?.refresh;
  const request = child.creationRequest;
  const target = child.delivery?.target;
  const parentTarget = parent?.delivery?.target;
  const sameTarget = target && parentTarget && ["repository", "remote", "branch", "prRepository"]
    .every(key => target[key as keyof typeof target] === parentTarget[key as keyof typeof parentTarget])
    && (target.pr ?? parent?.merge?.prNumber) === (parentTarget.pr ?? parent?.merge?.prNumber);
  if (!original || !request || child.refreshOf?.pipelineId !== parent!.id || child.repoDir !== parent!.repoDir
    || original.key !== request.key || original.digest !== request.digest || original.base !== child.refreshOf.base
    || original.pipelineId !== null && original.pipelineId !== child.id
    || !sameTarget) {
    return { reason: "refresh capacity origin is missing or conflicting; execution remains UNKNOWN" };
  }
  if (!Number.isFinite(new Date(Date.parse(original.requestedAt) + REFRESH_CAPACITY_MS).getTime())) {
    return { reason: "refresh capacity origin time is unreadable; execution remains UNKNOWN" };
  }
  const capacity = refreshCapacity(original);
  if (original.capacityDeadline !== undefined && original.capacityDeadline !== capacity.deadline
    || child.refreshOf.capacity && (Object.keys(capacity) as Array<keyof PipelineRefreshCapacity>)
      .some(key => child.refreshOf!.capacity![key] !== capacity[key])) {
    return { reason: "refresh capacity deadline conflicts with the original reservation; execution refused" };
  }
  return { capacity };
}

export function refreshConcurrency(value: number | undefined): number {
  return Math.max(1, Math.min(2, Math.floor(value ?? 1) || 1));
}

/** A keyed create with an unknown answer owns one place even without a child.
 * A found child, including a settled child, replaces that place exactly once. */
export function refreshCapacityHolders(pipelines: readonly Pipeline[], repository: string,
  repositoryOf: (pipeline: Pipeline) => string | null | undefined, excludeId?: string): Pipeline[] {
  const byKey = new Map<string, Pipeline[]>();
  for (const child of pipelines) {
    if (!child.refreshOf || !child.creationRequest) continue;
    const bucket = byKey.get(child.creationRequest.key) ?? [];
    bucket.push(child); byKey.set(child.creationRequest.key, bucket);
  }
  const held = new Map<string, Pipeline>();
  const byId = new Map(pipelines.map(row => [row.id, row]));
  for (const pipeline of pipelines) {
    if (repositoryOf(pipeline) !== repository) continue;
    const marker = pipeline.runs.some(run => run.attempts.some(attempt => attempt.suspension?.capacityYield));
    const origin = marker && pipeline.refreshOf ? refreshCapacityOrigin(pipeline, byId.get(pipeline.refreshOf.pipelineId) ?? null) : null;
    if ((holdsRefreshCapacity(pipeline) || origin && "reason" in origin) && pipeline.id !== excludeId) held.set(pipeline.creationRequest?.key ?? pipeline.id, pipeline);
    const reservation = pipeline.merge?.refresh;
    if (!reservation) continue;
    if (byKey.get(reservation.key)?.some(child => !("reason" in refreshCapacityOrigin(child, pipeline)))) continue;
    // A missing creation answer never proves nonexecution, even after a park.
    held.set(reservation.key, pipeline);
  }
  return [...held.values()];
}
