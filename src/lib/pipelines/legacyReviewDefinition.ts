import type { PauseResumeActor } from "@/lib/pauseResumeActor";

import { MAX_FAIL_EDGE_ROUNDS, MAX_PIPELINE_STAGES } from "./limits";
import { graphDigest } from "./stageDigest";
import type {
  Pipeline,
  PipelineFailEdgeExhaustion,
  PipelineLegacyReviewConversion,
  PipelineLegacyReviewLimitSource,
  PipelineStage,
  PipelineStageAttempt,
} from "./types";

/*
 * Legacy review-loop definitions (docs/design/retire-flows.md §3).
 *
 * A `review-loop` stage delegated its review to an embedded flow. Stored hot
 * rows, archived rows and drafts still carry that discriminant, so readers
 * decode it through the predicates below and never drop or rewrite it. The
 * conversion into the run-stage graph is separate: a pure preview, and an
 * apply that only the explicit, revision-fenced pipeline action calls. No
 * loading, rendering, export or GET path calls either.
 */

export const LEGACY_REVIEW_LOOP_KIND = "review-loop" as const;

/** The round limit every review flow the pipeline engine created carried. */
export const LEGACY_REVIEW_FLOW_ROUND_LIMIT = 5;

/** The finite limit a refused preview offers in place of the recorded one. */
export const RECOMMENDED_REVIEW_LIMIT = 5;

export type LegacyReviewLoopStage = PipelineStage & { kind: typeof LEGACY_REVIEW_LOOP_KIND };

export function isLegacyReviewLoopStage<T extends { kind?: unknown }>(stage: T): stage is T & { kind: typeof LEGACY_REVIEW_LOOP_KIND } {
  return stage.kind === LEGACY_REVIEW_LOOP_KIND;
}

/** The shape rules a stored review-loop stage keeps: it only ever reviewed,
    declared no worktree outputs, and its flow owned every verdict, so it has
    no fail edge. */
export function legacyReviewLoopShapeValid(stage: PipelineStage): boolean {
  return stage.outputs === undefined && !stage.onFail && stage.effectiveRole.access === "read-only";
}

/** Whether a run stage's pass chain reaches the review-loop, which reviewed
    the session of such a run. Decoding does not require it: a draft written
    before the rule existed still loads, and start refuses it. */
export function legacyReviewLoopReachable(
  stages: ReadonlyArray<Pick<PipelineStage, "id" | "kind" | "next">>,
  stageId: string,
): boolean {
  const nextOf = new Map(stages.map((stage) => [stage.id, stage.next] as const));
  return stages.some((candidate) => {
    if (candidate.kind !== "run") return false;
    let cursor: string | null = candidate.next;
    for (let hops = 0; cursor !== null && hops <= stages.length; hops += 1) {
      if (cursor === stageId) return true;
      cursor = nextOf.get(cursor) ?? null;
    }
    return false;
  });
}

/** How many times a reviewer with this fail edge runs when every review
    fails, under the #1938 semantics: `advance` reads `maxRounds` as the number
    of reviews (the last one's findings go to one fix, and a new head then
    waits in needs_review for a fresh review); `park` reviews once more. */
export function reviewerActivationsForLimit(maxRounds: number, onExhausted: PipelineFailEdgeExhaustion = "advance"): number {
  return onExhausted === "advance" ? maxRounds : maxRounds + 1;
}

export type LegacyReviewConversionOptions = {
  stageId?: string;
  reviewLimit?: number;
  implementerStageId?: string;
};

export type LegacyReviewConversionContext = {
  /** The round limit recorded on the stage's latest review flow; 0 is unlimited. */
  flowRoundLimit?: number | null;
  /** The authoritative graph validator, so a preview is startable only when it holds. */
  graphError?: (stages: PipelineStage[]) => string | null;
};

export type LegacyReviewRefusalCode =
  | "no-legacy-stage"
  | "ambiguous-stage"
  | "not-legacy"
  | "stage-live"
  | "no-implementer"
  | "ambiguous-implementer"
  | "implementer-read-only"
  | "unlimited-limit"
  | "limit-out-of-range"
  | "stage-count"
  | "fixer-id"
  | "graph-invalid"
  /* Pipeline-level refusals the engine adds; the pure preview never reads them. */
  | "pipeline-settled"
  | "live-ownership"
  | "unresolved-delivery"
  | "live-flow";

export type LegacyReviewRefusal = { code: LegacyReviewRefusalCode; message: string };

export type LegacyReviewPreview =
  | {
      ok: true;
      stageId: string;
      implementerStageId: string;
      fixerStageId: string;
      reviewLimit: number;
      reviewLimitSource: PipelineLegacyReviewLimitSource;
      /** Reviewer runs when every review fails, counting the final one. */
      reviewerActivations: number;
      /** Settled legacy attempts kept as history on the converted stage. */
      legacyAttempts: number;
      /** The complete converted plan, in order. */
      stages: PipelineStage[];
    }
  | {
      ok: false;
      stageId: string | null;
      refusals: LegacyReviewRefusal[];
      /** The limit the conversion would use, or null when none is finite. */
      reviewLimit: number | null;
      recommendedReviewLimit: number;
      implementerCandidates: string[];
    };

const SETTLED_ATTEMPT_STATES: ReadonlySet<PipelineStageAttempt["state"]> = new Set(["passed", "failed", "needs_decision", "skipped"]);
const STAGE_ID_MAX = 64;

function fixerPrompt(reviewId: string): string {
  return [
    `Fix the findings the ${reviewId} review reported for: {{task}}`,
    "",
    "Review findings:",
    "{{prev.output}}",
    "",
    "Address every finding in this pipeline's worktree, commit the fix, and report what changed. The review runs again on your result.",
  ].join("\n");
}

/** `<review>-fix`, then `-2`…, the first id no stage holds. */
function fixerStageId(reviewId: string, taken: ReadonlySet<string>): string | null {
  const base = `${reviewId.slice(0, STAGE_ID_MAX - "-fix-99".length)}-fix`;
  for (let index = 1; index <= 99; index += 1) {
    const id = index === 1 ? base : `${base}-${index}`;
    if (!taken.has(id)) return id;
  }
  return null;
}

function resolveLimit(options: LegacyReviewConversionOptions, context: LegacyReviewConversionContext): {
  value: number; source: PipelineLegacyReviewLimitSource;
} {
  if (options.reviewLimit !== undefined) return { value: options.reviewLimit, source: "request" };
  if (typeof context.flowRoundLimit === "number") return { value: context.flowRoundLimit, source: "flow" };
  return { value: LEGACY_REVIEW_FLOW_ROUND_LIMIT, source: "default" };
}

/**
 * Pure preview of converting one legacy review-loop stage: the reviewer
 * becomes a run stage with the old id, prompt, role and pass successor, and a
 * fail edge to one new fixer run stage that carries the implementer's role
 * snapshot and the findings input and passes back to the reviewer. Every
 * condition that would need a guess is refused, all of them at once, so the
 * caller can edit the preview instead of discovering them one by one.
 */
export function previewLegacyReviewConversion(
  pipeline: Pick<Pipeline, "stages" | "runs">,
  options: LegacyReviewConversionOptions,
  context: LegacyReviewConversionContext = {},
): LegacyReviewPreview {
  const refusals: LegacyReviewRefusal[] = [];
  const refuse = (stageId: string | null, reviewLimit: number | null = null, implementerCandidates: string[] = []): LegacyReviewPreview => ({
    ok: false, stageId, refusals, reviewLimit, recommendedReviewLimit: RECOMMENDED_REVIEW_LIMIT, implementerCandidates,
  });
  const legacy = pipeline.stages.filter(isLegacyReviewLoopStage);
  let review: PipelineStage | undefined;
  if (options.stageId !== undefined) {
    review = pipeline.stages.find((stage) => stage.id === options.stageId);
    if (!review || !isLegacyReviewLoopStage(review)) {
      refusals.push({ code: "not-legacy", message: `stage ${options.stageId} is not a legacy review-loop stage` });
      return refuse(options.stageId);
    }
  } else if (legacy.length === 0) {
    refusals.push({ code: "no-legacy-stage", message: "this pipeline has no legacy review-loop stage to convert" });
    return refuse(null);
  } else if (legacy.length > 1) {
    refusals.push({ code: "ambiguous-stage", message: `name the stage to convert: ${legacy.map((stage) => stage.id).join(", ")}` });
    return refuse(null);
  } else {
    review = legacy[0]!;
  }
  const stageId = review.id;

  const attempts = pipeline.runs.find((run) => run.stageId === stageId)?.attempts ?? [];
  const own = attempts.filter((attempt) => !attempt.historical);
  if (own.some((attempt) => !SETTLED_ATTEMPT_STATES.has(attempt.state) || attempt.activation)) {
    refusals.push({ code: "stage-live", message: `stage ${stageId} has a legacy review attempt that has not settled` });
  }

  /* The implementer is a run whose pass edge enters the review. Nothing is
     inferred from array order or fail edges: re-running an arbitrary
     predecessor could repeat planning or deployment. */
  const candidates = pipeline.stages.filter((stage) => stage.kind === "run" && stage.next === stageId);
  const candidateIds = candidates.map((stage) => stage.id);
  let implementer: PipelineStage | undefined;
  if (options.implementerStageId !== undefined) {
    implementer = candidates.find((stage) => stage.id === options.implementerStageId);
    if (!implementer) refusals.push({ code: "no-implementer", message: `stage ${options.implementerStageId} is not a run stage whose pass edge enters ${stageId}` });
  } else if (candidates.length === 0) {
    refusals.push({ code: "no-implementer", message: `no run stage's pass edge enters ${stageId}, so no implementer role is known for its fix stage` });
  } else if (candidates.length > 1) {
    refusals.push({ code: "ambiguous-implementer", message: `more than one run stage passes into ${stageId} (${candidateIds.join(", ")}); choose the implementer whose role the fix stage takes` });
  } else {
    implementer = candidates[0]!;
  }
  if (implementer && implementer.effectiveRole.access !== "read-write") {
    refusals.push({ code: "implementer-read-only", message: `implementer ${implementer.id} is read-only and cannot fix findings` });
  }

  const limit = resolveLimit(options, context);
  let reviewLimit: number | null = limit.value;
  if (limit.value === 0) {
    reviewLimit = null;
    refusals.push({ code: "unlimited-limit", message: `the review limit is unlimited; choose a finite limit (recommended ${RECOMMENDED_REVIEW_LIMIT})` });
  } else if (!Number.isInteger(limit.value) || limit.value < 1 || limit.value > MAX_FAIL_EDGE_ROUNDS) {
    reviewLimit = null;
    refusals.push({ code: "limit-out-of-range", message: `review limit ${limit.value} is outside 1–${MAX_FAIL_EDGE_ROUNDS} and is not clamped; choose a finite limit (recommended ${RECOMMENDED_REVIEW_LIMIT})` });
  }

  if (pipeline.stages.length + 1 > MAX_PIPELINE_STAGES) {
    refusals.push({ code: "stage-count", message: `the fix stage would make ${pipeline.stages.length + 1} stages; a pipeline holds at most ${MAX_PIPELINE_STAGES}` });
  }
  const fixerId = fixerStageId(stageId, new Set(pipeline.stages.map((stage) => stage.id)));
  if (!fixerId) refusals.push({ code: "fixer-id", message: `no free fix stage id derives from ${stageId}` });

  if (refusals.length || !implementer || !fixerId || reviewLimit === null) return refuse(stageId, reviewLimit, candidateIds);

  const reviewer: PipelineStage = {
    ...structuredClone(review),
    kind: "run",
    onFail: { to: fixerId, maxRounds: reviewLimit, onExhausted: "advance" },
  };
  const source = structuredClone(implementer);
  const fixer: PipelineStage = {
    id: fixerId,
    kind: "run",
    ...(source.role ? { role: source.role } : {}),
    ...(source.engine !== undefined ? { engine: source.engine } : {}),
    ...(source.model !== undefined ? { model: source.model } : {}),
    ...(source.effort !== undefined ? { effort: source.effort } : {}),
    ...(source.access !== undefined ? { access: source.access } : {}),
    ...(source.sandbox !== undefined ? { sandbox: source.sandbox } : {}),
    ...(source.account !== undefined ? { account: source.account } : {}),
    "prompt": fixerPrompt(stageId),
    next: stageId,
    onFail: null,
    effectiveRole: source.effectiveRole,
  };
  const stages: PipelineStage[] = [];
  for (const stage of pipeline.stages) {
    if (stage.id === stageId) stages.push(reviewer, fixer);
    else stages.push(structuredClone(stage));
  }
  const graphError = context.graphError?.(stages) ?? null;
  if (graphError) {
    refusals.push({ code: "graph-invalid", message: graphError });
    return refuse(stageId, reviewLimit, candidateIds);
  }
  return {
    ok: true,
    stageId,
    implementerStageId: implementer.id,
    fixerStageId: fixerId,
    reviewLimit,
    reviewLimitSource: limit.source,
    reviewerActivations: reviewerActivationsForLimit(reviewLimit, "advance"),
    legacyAttempts: own.length,
    stages,
  };
}

export type LegacyReviewReceipt = {
  clientRequestId: string;
  expectedRevision: string;
  actor: PauseResumeActor;
  at: string;
};

/**
 * Writes an accepted preview into the record, in memory; the caller persists
 * it in the same pipeline mutation. The legacy attempts stay on the stage with
 * `historical` and `legacyReview`, so attempt numbers keep counting and no
 * reader takes an old approval for the new reviewer's own result.
 */
export function applyLegacyReviewConversion(
  pipeline: Pipeline,
  preview: Extract<LegacyReviewPreview, { ok: true }>,
  receipt: LegacyReviewReceipt,
): PipelineLegacyReviewConversion {
  const run = pipeline.runs.find((item) => item.stageId === preview.stageId);
  if (!run) throw new Error(`stage ${preview.stageId} has no run record`);
  const conversion: PipelineLegacyReviewConversion = {
    clientRequestId: receipt.clientRequestId,
    expectedRevision: receipt.expectedRevision,
    stageId: preview.stageId,
    fixerStageId: preview.fixerStageId,
    implementerStageId: preview.implementerStageId,
    reviewLimit: preview.reviewLimit,
    reviewLimitSource: preview.reviewLimitSource,
    original: {
      stages: structuredClone(pipeline.stages),
      run: structuredClone(run),
      cursor: structuredClone(pipeline.cursor),
    },
    convertedGraphDigest: graphDigest(preview.stages),
    actor: structuredClone(receipt.actor),
    at: receipt.at,
  };
  pipeline.stages = structuredClone(preview.stages);
  const runs = [];
  for (const item of pipeline.runs) {
    runs.push(item);
    if (item.stageId === preview.stageId) runs.push({ stageId: preview.fixerStageId, attempts: [] });
  }
  pipeline.runs = runs;
  for (const attempt of run.attempts) {
    if (attempt.historical) continue;
    attempt.historical = true;
    attempt.legacyReview = true;
  }
  if (pipeline.cursor?.stageId === preview.stageId) pipeline.cursor = { ...pipeline.cursor, state: "pending" };
  pipeline.legacyReviewConversions = [...(pipeline.legacyReviewConversions ?? []), conversion];
  return conversion;
}

/**
 * Restores the definition a conversion replaced, while nothing has run under
 * it and nobody edited the converted graph. Once a new attempt ran, that
 * attempt is history and the conversion is repaired forward instead.
 */
export function revertLegacyReviewConversion(
  pipeline: Pipeline,
  stageId: string,
  receipt: Omit<LegacyReviewReceipt, "expectedRevision">,
): { conversion?: PipelineLegacyReviewConversion; error?: string } {
  const conversions = pipeline.legacyReviewConversions ?? [];
  const index = conversions.findLastIndex((item) => item.stageId === stageId && !item.reverted);
  const conversion = conversions[index];
  if (!conversion) return { error: `stage ${stageId} has no conversion to revert` };
  const ran = pipeline.runs
    .filter((run) => run.stageId === conversion.stageId || run.stageId === conversion.fixerStageId)
    .some((run) => run.attempts.some((attempt) => !attempt.historical));
  if (ran) return { error: `a new attempt already ran under the conversion of ${stageId}; keep it and repair it forward` };
  if (graphDigest(pipeline.stages) !== conversion.convertedGraphDigest) {
    return { error: `the converted graph changed since ${stageId} was converted; repair it forward` };
  }
  pipeline.stages = structuredClone(conversion.original.stages);
  pipeline.runs = pipeline.runs
    .filter((run) => run.stageId !== conversion.fixerStageId)
    .map((run) => run.stageId === conversion.stageId ? structuredClone(conversion.original.run) : run);
  if (pipeline.cursor && (pipeline.cursor.stageId === conversion.stageId || pipeline.cursor.stageId === conversion.fixerStageId)) {
    pipeline.cursor = structuredClone(conversion.original.cursor);
  }
  const reverted: PipelineLegacyReviewConversion = { ...conversion, reverted: { clientRequestId: receipt.clientRequestId, actor: structuredClone(receipt.actor), at: receipt.at } };
  pipeline.legacyReviewConversions = conversions.map((item, position) => position === index ? reverted : item);
  return { conversion: reverted };
}
