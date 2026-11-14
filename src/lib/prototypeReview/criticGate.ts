import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { PauseResumeActor } from "@/lib/pauseResumeActor";

/** Local provenance of the lane's visual review, read at publication time. */
export type PrototypeCriticPass = {
  pipelineId: string;
  stageId: string;
  attempt: number;
  outcome: "passed" | "fixed" | "skipped-by-operator";
  fixStageId?: string;
  fixAttempt?: number;
};

const latest = (attempts: PipelineStageAttempt[]) => attempts.filter(a => !a.historical).at(-1);
export const isVisualCriticStage = (stage: PipelineStage, attempt?: PipelineStageAttempt | null) =>
  stage.effectiveRole.roleId === "visual-critic" || attempt?.effectiveRole.roleId === "visual-critic" || attempt?.operatorCriticSkip === true;

export function visualCriticSkipRefusal(stage: PipelineStage | null, attempt: PipelineStageAttempt | null, actor: PauseResumeActor | null): string | null {
  return stage && isVisualCriticStage(stage, attempt) && actor?.kind !== "operator"
    ? `The visual-critic gate ${stage.id} cannot be skipped by an agent or an unidentified caller; retry the critic stage, or leave the skip to the operator. Nothing was skipped.`
    : null;
}

export function prototypeCriticGate(pipeline: Pipeline | null, publishingStageId: string):
  { ok: true; pass: PrototypeCriticPass } | { ok: false; missing: string } {
  if (!pipeline || !pipeline.stages.some(s => s.id === publishingStageId)) {
    return { ok: false, missing: "this caller is not a stage of a prototype lane" };
  }
  const critics = pipeline.stages.filter(s => {
    if (s.id === publishingStageId) return false;
    const attempt = latest(pipeline.runs.find(r => r.stageId === s.id)?.attempts ?? []);
    return isVisualCriticStage(s, attempt);
  });
  if (!critics.length) return { ok: false, missing: "this lane has no visual-critic stage" };
  // An operator explicitly accepts an uncritiqued prototype. Keep that
  // disclosure even if another critic passed or this attempt ran another role.
  for (const critic of critics) {
    const attempt = latest(pipeline.runs.find(r => r.stageId === critic.id)?.attempts ?? []);
    if (attempt?.state === "skipped" && attempt.operatorCriticSkip === true) {
      return { ok: true, pass: { pipelineId: pipeline.id, stageId: critic.id, attempt: attempt.n, outcome: "skipped-by-operator" } };
    }
  }
  const missing: string[] = [];
  for (const critic of critics) {
    const attempt = latest(pipeline.runs.find(r => r.stageId === critic.id)?.attempts ?? []);
    const pass = { pipelineId: pipeline.id, stageId: critic.id, attempt: attempt?.n ?? 0 };
    if (attempt && attempt.effectiveRole.roleId !== "visual-critic") {
      missing.push(`visual-critic stage ${critic.id} attempt ${attempt.n} ran as ${attempt.effectiveRole.roleId}, not visual-critic`);
      continue;
    }
    if (attempt?.state === "passed") return { ok: true, pass: { ...pass, outcome: "passed" } };
    const prefix = `visual-critic stage ${critic.id} has not passed`;
    if (attempt?.state === "failed" && attempt.verdict?.status === "fail") {
      if (critic.onFail?.onExhausted === "park") {
        missing.push(`${prefix}: its park policy requires a visual-critic pass after the fix`);
        continue;
      }
      const fixId = critic.onFail?.to;
      const fix = (pipeline.runs.find(r => r.stageId === fixId)?.attempts ?? []).findLast(fix => !fix.historical && fix.state === "passed" && fix.startedAt && attempt.completedAt
        && Number.isFinite(Date.parse(attempt.completedAt)) && Date.parse(fix.startedAt) >= Date.parse(attempt.completedAt));
      if (fixId && fix) {
        return { ok: true, pass: { ...pass, outcome: "fixed", fixStageId: fixId, fixAttempt: fix.n } };
      }
      missing.push(`${prefix}: attempt ${attempt.n} failed and fix stage ${fixId ?? "(undeclared)"} has not passed since`);
    } else {
      missing.push(`${prefix}: ${attempt ? `attempt ${attempt.n} ${attempt.verdict?.status === "needs_decision" ? "asked for a decision" : attempt.state}` : "not run yet"}`);
    }
  }
  return { ok: false, missing: missing.join("; ") };
}

export const criticRefusal = (missing: string) =>
  `publish_prototype_review refused: a review with variants requires visual-critic evidence or an explicit operator skip. ${missing}. Run the lane as prototype → visual-critic (onFail proto-fix, maxRounds 2, onExhausted park) → publish. Exhausted critic rounds park the lane and require a critic pass before publication unless the operator skips the critic. An operator skip allows publication with a skipped-critic statement. Agents cannot skip this gate; retry the critic stage, or leave the skip to the operator. Saved advance (including legacy omitted policies) or stop-after-fix policies also allow publication after the declared fix passes following the failed critic. Publish from the publish stage with a new clientRequestId. A form with questions only needs no critic. Nothing was published.`;
