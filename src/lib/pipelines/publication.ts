import type { Pipeline } from "./types";
import { FORGE_PUSH_MINT_MARKER } from "../../../bin/forge-app-token.mjs";
import { publicationFailurePhase } from "./publicationHistory";

const RUNNER_DEADLINE = /^NEW .*<runner error> runner did not finish \(124\)$/;

function decisiveRefusal(line: string, allowFrozenInstall = false): boolean {
  const member = /^pre-push: ([^;:]{1,60}): failed \(([^)]*)\)/.exec(line);
  const otherCheckFailed = member && !["touched tests", "Linux tests"].includes(member[1]!) && member[2] !== "124"
    && !(allowFrozenInstall && member[1] === "frozen install");
  return line.startsWith("(fail) ") || (line.startsWith("NEW ") && !RUNNER_DEADLINE.test(line)) || !!otherCheckFailed
    || /surviving owned processes:|stop them before pushing again|PRIVACY GATE: FAIL|budget cleanup failed:|owned test child guardian(?:: surviving owned processes:| could not end an owned process)|owned runner guardian exceeded cleanup deadline/.test(line);
}

export function publicationTransportLine(output: string): string | undefined {
  return output.split("\n").map(line => line.trim()).find(line =>
    /^(?:fatal:|error: RPC failed|error: .*transport|remote:.*(?:denied|403))/.test(line));
}

/** A phase marker alone cannot erase a later transport or verification refusal. */
export function publicationFrozenInstallFailure(output: string): boolean {
  return publicationFailurePhase({ outputTail: output }) === "frozen install"
    && !publicationTransportLine(output) && !publicationApp403(output)
    && !output.split("\n").some(line => decisiveRefusal(line.trim(), true) || /\berror TS\d+:/.test(line));
}

/** A verification refusal (including a mint's own 403) has no fresh-use marker. */
export function publicationApp403(output: string): boolean {
  return output.split("\n").some(line => line.trim() === FORGE_PUSH_MINT_MARKER)
    && !output.includes("Delegatus refused this GitHub write")
    && !/^(?:pre-push: .*failed \(|\(fail\) |NEW |PRIVACY GATE: FAIL)/m.test(output)
    && (/^remote:\s*Permission to .+ denied to .*(?:\[bot\]|App bot)(?:[.\s]|$).*$/im.test(output)
      || /(?:requested URL returned error:\s*403|HTTP(?:\/\d(?:\.\d)?)?\s+403)\b/i.test(output));
}

/** Implicit owner publication requires a stored remote. Explicit remote
    publication keeps its remote fence even on older remote-less records. */
export function pipelinePublishesRemoteBranch(pipeline: Pick<Pipeline, "publication" | "delivery">): boolean {
  return pipeline.publication === "remote-branch"
    || (pipeline.publication === undefined && pipeline.delivery?.disposition === "owner" && !!pipeline.delivery.target.remote);
}

export const MISSING_DELIVERY_REMOTE = "this lane publishes its branch (publication remote-branch), but its delivery target has no remote. Add a remote to the repository and run pipeline_action set-delivery-remote, or close the lane.";
export const LOCAL_DELIVERY_PUBLISH_REFUSAL = "this lane's delivery target has no remote, so there is nothing to publish to; add a remote and run set-delivery-remote";

/** A deadline without a decisive refusal is a capacity retry.
 * Inspect the complete captured output before publication keeps a bounded tail.
 * A test assertion, another failed check or failed cleanup always wins. */
export function publicationDeadlineKind(output: string): "execution" | "admission" | null {
  let deadline = false;
  let admission = false, admissionExpired = false, checksStarted = false;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const member = /^pre-push: ([^;:]{1,60}): failed \(([^)]*)\)/.exec(line);
    if (decisiveRefusal(line)) return null;
    const phase = /^pre-push: ([^;:]{1,60})$/.exec(line)?.[1];
    if (phase === "CPU admission for publication checks") admission = true;
    else if (phase && phase !== "privacy" && !phase.startsWith("branch is ")) checksStarted = true;
    if (member) checksStarted = true;
    if (/^gate-slot: CPU admission queue lock deadline exceeded after \d+ ms; checks did not start$/.test(line)) admissionExpired = true;
    if (/^command timed out after \d+ms/.test(line)
      || /^pre-push: no verdict within the push budget of \d+ s:/.test(line)
      || /^owned runner: (?:deadline expired|execution guard expired)$/.test(line)
      // The gate runner lost a started run: nothing was judged, and the
      // retries after 1, 5 and 15 minutes run here (scripts/gate-runner).
      || /^gate-runner: no verdict:/.test(line)
      || RUNNER_DEADLINE.test(line)) deadline = true;
  }
  if (admission && admissionExpired && !checksStarted) return "admission";
  return deadline ? "execution" : null;
}

export function publicationDeadlineOnly(output: string): boolean {
  return publicationDeadlineKind(output) !== null;
}
