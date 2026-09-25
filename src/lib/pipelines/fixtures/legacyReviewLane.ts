import type { NewLegacyReviewOutcome } from "../legacyReviewDefinition";
import type { Pipeline } from "../types";

/**
 * A created lane as an engine before #2187 stored it: every review-loop stage
 * the creation converted goes back to the review-loop it was sent as, with no
 * fail edge, and the fix stage the conversion added is dropped with its run.
 *
 * Lanes stored before #2187 still run their review through an embedded flow,
 * and the conversion only ever reads the request, so the flow path's tests
 * build such a lane through the real engine and then undo the conversion
 * here. The reviewer's resolved role is the one creation resolved for the
 * review-loop kind, so nothing else differs from the older record.
 */
export function asStoredLegacyReviewLane(
  pipeline: Pipeline,
  converted: NewLegacyReviewOutcome["convertedStages"] = [],
): Pipeline {
  const lane = structuredClone(pipeline);
  for (const { reviewer, fixer } of converted) {
    const stage = lane.stages.find((candidate) => candidate.id === reviewer);
    if (!stage) throw new Error(`converted reviewer ${reviewer} is not in the plan`);
    stage.kind = "review-loop";
    stage.onFail = null;
    lane.stages = lane.stages.filter((candidate) => candidate.id !== fixer);
    lane.runs = lane.runs.filter((run) => run.stageId !== fixer);
  }
  return lane;
}
