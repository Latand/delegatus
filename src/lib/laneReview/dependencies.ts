import { getPipeline } from "@/lib/pipelines/engine";
import { realExec } from "@/lib/workflows/provision";
import { deliverLaneReview, type LaneReviewDependencies } from "./http";

/** The production ports of the lane review routes. */
export const laneReviewDependencies: LaneReviewDependencies = {
  pipeline: getPipeline,
  exec: realExec,
  deliver: deliverLaneReview,
};
