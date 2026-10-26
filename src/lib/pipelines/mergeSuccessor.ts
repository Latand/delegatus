import type { Pipeline } from "./types";

type SuccessorKey = string;
type MergeSuccessorIndex = {
  targetPr: Map<SuccessorKey, Pipeline>;
  targetBranch: Map<SuccessorKey, Pipeline>;
  targetUnnumberedBranch: Map<SuccessorKey, Pipeline>;
  mergePr: Map<SuccessorKey, Pipeline>;
};

const targetPrKey = (repository: string, pr: number) => JSON.stringify([repository, pr]);
const targetBranchKey = (repository: string, branch: string) => JSON.stringify([repository, branch]);

function addOwner(index: Map<SuccessorKey, Pipeline>, key: SuccessorKey, candidate: Pipeline): void {
  const current = index.get(key);
  if (!current || current.delivery!.epoch < candidate.delivery!.epoch) index.set(key, candidate);
}

/** Build one bounded owner lookup for a pipeline snapshot. */
export function indexMergeSuccessors(lanes: readonly Pipeline[]): MergeSuccessorIndex {
  const owners: MergeSuccessorIndex = {
    targetPr: new Map(), targetBranch: new Map(), targetUnnumberedBranch: new Map(), mergePr: new Map(),
  };
  for (const candidate of lanes) {
    const delivery = candidate.delivery;
    if (!delivery || delivery.disposition !== "owner" || delivery.ownerId !== candidate.id
      || (!delivery.active && candidate.state !== "completed")) continue;
    addOwner(owners.targetBranch, targetBranchKey(delivery.target.repository, delivery.target.branch), candidate);
    if (delivery.target.pr == null) {
      addOwner(owners.targetUnnumberedBranch, targetBranchKey(delivery.target.repository, delivery.target.branch), candidate);
    } else {
      addOwner(owners.targetPr, targetPrKey(delivery.target.repository, delivery.target.pr), candidate);
    }
    const merge = candidate.merge;
    if (merge?.repository && merge.prNumber != null) addOwner(owners.mergePr, targetPrKey(merge.repository, merge.prNumber), candidate);
  }
  return owners;
}

/** A released delivery's merge belongs to the newer active or completed owner of its PR. */
export function mergeSuccessor(lane: Pipeline, owners: MergeSuccessorIndex): Pipeline | undefined {
  const delivery = lane.delivery;
  if (lane.state !== "completed" || !delivery || delivery.active) return undefined;
  const matches: Pipeline[] = [];
  const target = delivery.target;
  const branchKey = targetBranchKey(target.repository, target.branch);
  if (target.pr == null) {
    const candidate = owners.targetBranch.get(branchKey);
    if (candidate) matches.push(candidate);
  } else {
    const candidate = owners.targetPr.get(targetPrKey(target.repository, target.pr));
    const unnumbered = owners.targetUnnumberedBranch.get(branchKey);
    if (candidate) matches.push(candidate);
    if (unnumbered) matches.push(unnumbered);
  }
  const merge = lane.merge;
  if (merge?.repository && merge.prNumber != null) {
    const candidate = owners.mergePr.get(targetPrKey(merge.repository, merge.prNumber));
    if (candidate) matches.push(candidate);
  }
  return matches.filter(candidate => candidate.id !== lane.id && candidate.delivery!.epoch > delivery.epoch)
    .sort((left, right) => right.delivery!.epoch - left.delivery!.epoch)[0];
}
