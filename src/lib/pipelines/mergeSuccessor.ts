import type { Pipeline } from "./types";

/** A released delivery's merge belongs to the newer active owner of its PR. */
export function mergeSuccessor(lane: Pipeline, lanes: readonly Pipeline[]): Pipeline | undefined {
  const delivery = lane.delivery;
  if (lane.state !== "completed" || !delivery || delivery.active) return undefined;
  return lanes.find(candidate => {
    const next = candidate.delivery;
    if (candidate.id === lane.id || !next?.active || next.disposition !== "owner"
      || next.ownerId !== candidate.id || next.epoch <= delivery.epoch) return false;
    const sameTarget = next.target.repository === delivery.target.repository
      && (delivery.target.pr !== undefined && next.target.pr !== undefined
        ? delivery.target.pr === next.target.pr
        : delivery.target.branch === next.target.branch);
    const samePr = lane.merge?.prNumber != null && lane.merge.repository
      && lane.merge.repository === candidate.merge?.repository && lane.merge.prNumber === candidate.merge.prNumber;
    return Boolean(sameTarget || samePr);
  });
}
