import type { Pipeline } from "./types";

/**
 * The latest instant the engine stamped on a lane as it moved: a round
 * starting or ending, a launch waiting on its controller, a verdict re-read.
 * None of them changes while a lane sits parked on one decision.
 *
 * One definition for every "hidden until something newer" rule: the phone's
 * dismissed-lane predicate (#1671) and the kanban group hide (#1695) read the
 * same stamps, so the two can never disagree about whether a lane moved.
 * Pure and client-safe.
 */
export function laneMovedAt(pipeline: Pipeline): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const run of pipeline.runs) {
    for (const attempt of run.attempts) {
      const stamps = [attempt.startedAt, attempt.completedAt, attempt.controllerWait?.startedAt, attempt.verdictRecovery?.startedAt, attempt.verdictRecovery?.lastCheckedAt];
      for (const stamp of stamps) {
        const at = stamp ? Date.parse(stamp) : Number.NaN;
        if (at > latest) latest = at;
      }
    }
  }
  return latest;
}

/**
 * The movement a surface drew a lane at, as it travels with a dismissal:
 * `laneMovedAt`, or null for a lane that never ran a round.
 */
export function drawnLaneMovement(pipeline: Pipeline): number | null {
  const moved = laneMovedAt(pipeline);
  return Number.isFinite(moved) ? moved : null;
}

/**
 * Whether the lane moved after a surface drew it at `drawn`
 * (docs/design/needs-attention.md §5): a dismissal from that surface would
 * clear a decision nobody saw. A caller that did not say what it drew (an
 * agent) clears the lane as it stands, so `undefined` never counts as moved.
 */
export function laneMovedSince(pipeline: Pipeline, drawn: number | null | undefined): boolean {
  return drawn !== undefined && laneMovedAt(pipeline) > (drawn ?? Number.NEGATIVE_INFINITY);
}
