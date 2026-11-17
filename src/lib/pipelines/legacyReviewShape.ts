import type { PipelineStage } from "./types";

export const LEGACY_REVIEW_LOOP_KIND = "review-loop" as const;
/** Conversion history a record keeps; the store refuses more, so the action refuses first. */
export const MAX_LEGACY_REVIEW_CONVERSIONS = 32;

export type LegacyReviewLoopStage = PipelineStage & { kind: typeof LEGACY_REVIEW_LOOP_KIND };

export function isLegacyReviewLoopStage<T extends { kind?: unknown }>(stage: T): stage is T & { kind: typeof LEGACY_REVIEW_LOOP_KIND } {
  return stage.kind === LEGACY_REVIEW_LOOP_KIND;
}

/** The shape rules a stored review-loop stage keeps: it only ever reviewed,
    declared no worktree outputs, and its flow owned every verdict, so it has
    no fail edge. */
export function legacyReviewLoopShapeValid(stage: PipelineStage): boolean {
  return stage.outputs === undefined && !stage.onFail && stage.effectiveRole.access === "read-only";
}

/** Whether a run stage's pass chain reaches the review-loop, which reviewed
    the session of such a run. Decoding does not require it: a draft written
    before the rule existed still loads, and start refuses it. */
export function legacyReviewLoopReachable(
  stages: ReadonlyArray<Pick<PipelineStage, "id" | "kind" | "next">>,
  stageId: string,
): boolean {
  const nextOf = new Map(stages.map((stage) => [stage.id, stage.next] as const));
  return stages.some((candidate) => {
    if (candidate.kind !== "run") return false;
    let cursor: string | null = candidate.next;
    for (let hops = 0; cursor !== null && hops <= stages.length; hops += 1) {
      if (cursor === stageId) return true;
      cursor = nextOf.get(cursor) ?? null;
    }
    return false;
  });
}
