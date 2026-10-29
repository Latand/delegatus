import type { EffectivePipelineRole, Pipeline, PipelineStage } from "./types";

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
    || !/^[0-9a-f]{40}$/.test(pipeline.lastPassedCommit) || pipeline.publishedCommit !== pipeline.lastPassedCommit) {
    return { refused: "release tag requires the lane's published reviewed head and an active delivery owner" };
  }
  const reviews = pipeline.stages.flatMap(candidate => {
    if (candidate.effectiveRole.roleId !== "reviewer") return [];
    const attempt = pipeline.runs.find(run => run.stageId === candidate.id)?.attempts.filter(item => !item.historical).at(-1);
    return attempt ? [attempt] : [];
  });
  const latest = reviews.toSorted((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? "")).at(-1);
  const reviewed = latest?.reviewHeadSha ?? latest?.outputBaseHead ?? latest?.report?.provenance.head;
  if (latest?.state !== "passed" || reviewed !== pipeline.lastPassedCommit) {
    return { refused: "release tag requires a successful review of the exact published head" };
  }
  return { head: pipeline.lastPassedCommit, remote: delivery.target.remote, branch: delivery.target.branch };
}
