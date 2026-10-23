import type { Pipeline } from "./types";

/** Implicit owner publication requires a stored remote. Explicit remote
    publication keeps its remote fence even on older remote-less records. */
export function pipelinePublishesRemoteBranch(pipeline: Pick<Pipeline, "publication" | "delivery">): boolean {
  return pipeline.publication === "remote-branch"
    || (pipeline.publication === undefined && pipeline.delivery?.disposition === "owner" && !!pipeline.delivery.target.remote);
}

export const MISSING_DELIVERY_REMOTE = "this lane publishes its branch (publication remote-branch), but its delivery target has no remote. Add a remote to the repository and run pipeline_action set-delivery-remote, or close the lane.";
export const LOCAL_DELIVERY_PUBLISH_REFUSAL = "this lane's delivery target has no remote, so there is nothing to publish to; add a remote and run set-delivery-remote";

/** Only an execution deadline without a decisive refusal is a capacity retry.
 * Inspect the complete captured output before publication keeps a bounded tail.
 * A test assertion, another failed check or failed cleanup always wins. */
export function publicationDeadlineOnly(output: string): boolean {
  const runnerDeadline = /^NEW .*<runner error> runner did not finish \(124\)$/;
  let deadline = false;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const member = /^pre-push: ([^;:]{1,60}): failed \(([^)]*)\)/.exec(line);
    const otherCheckFailed = member && !["touched tests", "Linux tests"].includes(member[1]!) && member[2] !== "124";
    if (line.startsWith("(fail) ") || (line.startsWith("NEW ") && !runnerDeadline.test(line)) || otherCheckFailed
      || /surviving owned processes:|stop them before pushing again|PRIVACY GATE: FAIL|budget cleanup failed:|owned test child guardian(?:: surviving owned processes:| could not end an owned process)|owned runner guardian exceeded cleanup deadline/.test(line)) return false;
    if (/^command timed out after \d+ms/.test(line)
      || /^pre-push: no verdict within the push budget of \d+ s:/.test(line)
      || /^owned runner: (?:deadline expired|execution guard expired)$/.test(line)
      // The gate runner lost a started run: nothing was judged, and the
      // retries after 1, 5 and 15 minutes run here (scripts/gate-runner).
      || /^gate-runner: no verdict:/.test(line)
      || runnerDeadline.test(line)) deadline = true;
  }
  return deadline;
}
