import type { EffectivePipelineRole, Pipeline, PipelineStage } from "./types";
import { failEdgeExhaustion } from "./failEdgeBudget";

export function isReleasePublishStage(stage: PipelineStage, role: EffectivePipelineRole = stage.effectiveRole): boolean {
  return stage.kind === "run" && stage.role?.roleId === "deployer" && role.roleId === "deployer"
    && stage.role.params?.mode === "release" && role.access === "read-write";
}

export type ReleaseTagPolicy = { head: string; remote: string; branch: string } | { refused: string };

/** Controller-owned inputs. The version is read from this exact Git tree by
 * prepareStageGitGuard; neither the working package nor the role's cut SHA
 * selects the release commit. Approval and release preflight remain required. */
export function buildReleaseTagPolicy(pipeline: Pipeline | null | undefined, stage: PipelineStage | undefined): ReleaseTagPolicy | null {
  if (!stage || !isReleasePublishStage(stage)) return null;
  const delivery = pipeline?.delivery;
  if (!pipeline || !delivery?.active || delivery.disposition !== "owner" || delivery.ownerId !== pipeline.id || delivery.publish === "disabled"
    || !delivery.target.remote || !delivery.target.branch.startsWith("refs/heads/")
    || !/^[0-9a-f]{40}$/.test(pipeline.lastPassedCommit)) {
    return { refused: "release tag requires the lane's published reviewed head and an active delivery owner" };
  }
  const reviews = pipeline.stages.flatMap(candidate => {
    if (candidate.effectiveRole.roleId !== "reviewer") return [];
    const attempt = pipeline.runs.find(run => run.stageId === candidate.id)?.attempts.filter(item => !item.historical).at(-1);
    return attempt ? [{ stage: candidate, attempt }] : [];
  });
  const latest = reviews.toSorted((a, b) => (a.attempt.completedAt ?? "").localeCompare(b.attempt.completedAt ?? "")).at(-1);
  const review = latest?.attempt;
  const reviewed = review?.reviewHeadSha ?? review?.outputBaseHead ?? review?.report?.provenance.head;
  const activation = pipeline.cursor?.stageId === stage.id ? pipeline.cursor.activatedBy : null;
  const fromReview = activation?.edge === "pass" && activation.stageId === latest?.stage.id && activation.attempt === review?.n;
  const passed = review?.state === "passed" && (reviewed === pipeline.lastPassedCommit || (!reviewed && fromReview));
  const accepted = latest && pipeline.reviewAcceptances?.some(item => item.stageId === latest.stage.id
    && item.attempt === review!.n && item.currentHead === pipeline.lastPassedCommit);
  // Preserve the controller's existing nonterminal review/fix advance. Its
  // durable pass edge and lastPassedCommit are one accepted checkpoint; a
  // report can precede the controller's commit and is no substitute for it.
  const fixStage = latest?.stage.onFail?.to;
  const fix = fixStage ? pipeline.runs.find(run => run.stageId === fixStage)?.attempts.filter(item => !item.historical).at(-1) : null;
  const repaired = review?.budgetSpent && latest?.stage.next !== null && latest?.stage.onFail
    && failEdgeExhaustion(latest.stage.onFail) === "advance" && fix?.state === "passed"
    && fix.activatedBy?.edge === "fail" && fix.activatedBy.budgetSpent === true
    && fix.activatedBy.stageId === latest.stage.id && fix.activatedBy.attempt === review.n
    && activation?.edge === "pass" && activation.stageId === fixStage && activation.attempt === fix.n;
  if (!passed && !accepted && !repaired) {
    return { refused: "release tag requires an accepted review checkpoint for the exact published head" };
  }
  return { head: pipeline.lastPassedCommit, remote: delivery.target.remote, branch: delivery.target.branch };
}
