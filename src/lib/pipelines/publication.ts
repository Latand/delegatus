import type { Pipeline } from "./types";

/** Implicit owner publication requires a stored remote. Explicit remote
    publication keeps its remote fence even on older remote-less records. */
export function pipelinePublishesRemoteBranch(pipeline: Pick<Pipeline, "publication" | "delivery">): boolean {
  return pipeline.publication === "remote-branch"
    || (pipeline.publication === undefined && pipeline.delivery?.disposition === "owner" && !!pipeline.delivery.target.remote);
}

export const MISSING_DELIVERY_REMOTE = "this lane publishes its branch (publication remote-branch), but its delivery target has no remote. Add a remote to the repository and run pipeline_action set-delivery-remote, or close the lane.";
export const LOCAL_DELIVERY_PUBLISH_REFUSAL = "this lane's delivery target has no remote, so there is nothing to publish to; add a remote and run set-delivery-remote";
