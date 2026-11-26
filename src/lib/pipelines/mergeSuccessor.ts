import { MERGE_REASONS } from "@/lib/forge/mergeReasons";
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
export function indexMergeSuccessors(lanes: readonly Pipeline[], deliveryAuthority = false): MergeSuccessorIndex {
  const owners: MergeSuccessorIndex = {
    targetPr: new Map(), targetBranch: new Map(), targetUnnumberedBranch: new Map(), mergePr: new Map(),
  };
  for (const candidate of lanes) {
    const delivery = candidate.delivery;
    if (!delivery || delivery.disposition !== "owner" || delivery.ownerId !== candidate.id
      || (!deliveryAuthority && !delivery.active && candidate.state !== "completed")) continue;
    // A completed claim can be refused merge admission. Its predecessor still
    // owns the actionable merge stop until the successor carries a merge.
    if (!deliveryAuthority && candidate.state === "completed" && !candidate.merge) continue;
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
  return deliverySuccessor(lane, owners);
}

function deliverySuccessor(lane: Pipeline, owners: MergeSuccessorIndex): Pipeline | undefined {
  const delivery = lane.delivery;
  if (!delivery) return undefined;
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

/** Queue authority includes claims that have not reached merge admission yet.
 * Completion releases publication, so active:false alone does not revoke merge. */
export function mergeWithdrawalReason(lane: Pipeline, owners: MergeSuccessorIndex): string | null {
  if (lane.state === "closed") return "Lane is closed";
  const delivery = lane.delivery;
  if (delivery?.disposition === "comparison") return "comparison lane does not own publication";
  if (delivery && delivery.ownerId !== lane.id) return "Lane no longer owns delivery";
  const successor = deliverySuccessor(lane, owners);
  return successor ? `Merge superseded by delivery owner ${successor.id}` : null;
}

/** Avoid reopening the writer for an already withdrawn or reconciled entry. */
export function mergeWithdrawalNeeded(lane: Pipeline, reason: string): boolean {
  const merge = lane.merge;
  if (!merge || merge.state === "merged" || merge.state === "merging" || merge.effectUncertain
    || merge.state === "blocked" && merge.reason === MERGE_REASONS.closed
    || merge.state === "cancelled" && merge.reason === reason) return false;
  return true;
}

/** Withdraw undispatched work while retaining any outstanding landing receipt. */
export function withdrawPipelineMerge(lane: Pipeline, reason: string, at: string): boolean {
  if (!mergeWithdrawalNeeded(lane, reason)) return false;
  const merge = lane.merge!;
  merge.state = "cancelled";
  merge.reason = reason;
  merge.nextReadAt = null;
  merge.updatedAt = new Date(Math.max(Date.parse(at), Date.parse(merge.updatedAt) + 1)).toISOString();
  return true;
}
