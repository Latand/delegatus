import type { CaptionTarget } from "@/lib/audio/captions";

import type { AttentionRequestV1 } from "./types";

/*
 * The project boundary of an agent's `request_attention`.
 *
 * An agent's request may move the operator's view only inside the project the
 * operator is already in. A request that would carry them into another project
 * arrives as the existing notification (the «An agent asks you to look» sound
 * caption) whose click navigates there, so a request raised by one project's
 * orchestrator never takes the screen from someone typing or dictating in
 * another.
 *
 * Pure and browser-safe. The server resolves aliases from the project map and
 * the browser from the alias table it already polls, so both hand in their own
 * `canonical`. The comparison is made where the move would take effect: the
 * browser reads its current project at that moment, never the one it had when
 * the request was raised.
 */

export type CanonicalProject = (project: string) => string;

/** The project the request's target belongs to, as the record stored it. */
export function requestProject(request: Pick<AttentionRequestV1, "frameAtCreation">): string {
  return request.frameAtCreation.project;
}

/**
 * Whether moving this request's view would take the operator out of the
 * project they are in.
 *
 * - Only a root agent's request is bounded. The operator's own command is
 *   their own act and always moves.
 * - A view in a project is compared by canonical identity, so a key that has
 *   since moved still names the same project.
 * - A view with no project open (the overview) has nothing to protect, so a
 *   request the server directed at it keeps today's move. A request nobody
 *   directed (a notice raised while no view could move, found later by a view
 *   that opened afterwards) is never permission to take a view whose project
 *   is unknown.
 */
export function requestCrossesProject(
  request: Pick<AttentionRequestV1, "origin" | "state" | "frameAtCreation">,
  viewProject: string | null,
  canonical: CanonicalProject,
): boolean {
  if (request.origin !== "root-agent") return false;
  if (viewProject === null) return request.state !== "accepted";
  return canonical(viewProject) !== canonical(requestProject(request));
}

/**
 * Where a click on the notification goes: the card the request named when the
 * sound captions can open it, otherwise its project.
 */
export function captionTargetForRequest(request: Pick<AttentionRequestV1, "target" | "frameAtCreation">): CaptionTarget {
  const project = requestProject(request);
  switch (request.target.kind) {
    case "conversation":
      return { kind: "conversation", path: request.target.path };
    case "pipeline":
    case "stage":
      return { kind: "lane", pipelineId: request.target.pipelineId, project };
    default:
      return { kind: "project", project };
  }
}
