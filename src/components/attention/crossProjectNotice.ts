import { playCue } from "@/lib/audio/app";
import { captionTargetForRequest } from "@/lib/attention/projectBoundary";
import type { AttentionRequestV1 } from "@/lib/attention/types";
import { cleanTitle } from "@/lib/title";

/**
 * The notification an agent's request becomes when it would take the operator
 * into another project: the cue every request rings, with the caption's click
 * naming where it goes. Keyed by the request id, so the cue rings once however
 * many polls or answers reach it.
 */
export function ringCrossProjectNotice(request: AttentionRequestV1): void {
  playCue({
    cue: "your-move",
    eventId: `attention:${request.id}`,
    obligation: `attention:${request.id}`,
    caption: { what: "attention", subject: cleanTitle(request.reason, 90) || null, target: captionTargetForRequest(request) },
  });
}
