import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";

/** Local provenance of the lane's visual review, read at publication time. */
export type PrototypeCriticPass = {
  pipelineId: string;
  stageId: string;
  attempt: number;
  outcome: "passed" | "fixed";
  fixStageId?: string;
  fixAttempt?: number;
};

const latest = (attempts: PipelineStageAttempt[]) => attempts.filter(a => !a.historical).at(-1);

export function prototypeCriticGate(pipeline: Pipeline | null, publishingStageId: string):
  { ok: true; pass: PrototypeCriticPass } | { ok: false; missing: string } {
  if (!pipeline || !pipeline.stages.some(s => s.id === publishingStageId)) {
    return { ok: false, missing: "this caller is not a stage of a prototype lane" };
  }
  const critics = pipeline.stages.filter(s => {
    if (s.id === publishingStageId) return false;
    const attempt = latest(pipeline.runs.find(r => r.stageId === s.id)?.attempts ?? []);
    return s.effectiveRole.roleId === "visual-critic" || attempt?.effectiveRole.roleId === "visual-critic";
  });
  if (!critics.length) return { ok: false, missing: "this lane has no visual-critic stage" };
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
  `publish_prototype_review refused: a review with variants reaches the operator only after the visual critic. ${missing}. Run the lane as prototype → visual-critic (onFail proto-fix, maxRounds 2, onExhausted advance) → publish, and publish from the publish stage with a new clientRequestId. A form with questions only needs no critic. Nothing was published.`;
