import { pipelineReviewSummary, terminalReviewContinuationAvailable } from "./failEdgeBudget";
import { latestAttempt } from "./stageChip";
import type { Pipeline } from "./types";

/*
 * What kind of stop a lane stands on (docs/design/calm-task-cards-build.md
 * §5.2), read from what its producers write onto the record. Pure and
 * browser-safe, with nothing from the board's modules, so the seat tick reads
 * it too: the card picks its words by it, and the seat's wake names the class
 * before the stage's own words (§7.2).
 */

export type LaneStopKind = "question" | "review" | "unreviewed" | "commit" | "publish"
  | "capacity" | "auth" | "transport" | "provisioning" | "merge" | "other";

export interface LaneStop {
  kind: LaneStopKind;
  /** The stage the lane stopped on, or null for a merge or a lane with none. */
  stageId: string | null;
}

/** Each producer's own phrase, by the class it names. The first match wins. */
const STOP_PHRASES: ReadonlyArray<readonly [LaneStopKind, RegExp]> = [
  /* `git.ts` commitPipelineStage, and its recovery's refusal of a read-only stage's commit. */
  ["commit", /committing the passed stage|stage \S+ created a commit/i],
  /* The engine's publication park (`publicationParkDetail`). */
  ["publish", /publishing the passed stage/i],
  /* `projectBindings.ts`: an exhausted or empty binding. */
  ["capacity", /no allowed \S+ account (has capacity|is available)/i],
  ["auth", /requires authentication|authentication check failed/i],
  /* A lost or cut stage host, a spawn that never recovered. */
  ["transport", /stage host was lost|spawn recovery|transport|interrupted by a Delegatus restart/i],
];

/** A spent review budget: the engine's park for a spent fail edge
    (`routeFailedAttempt`), a legacy review flow at its round limit, or a
    reviewer that already handed its last findings on. */
const REVIEW_SPENT = /^fail-edge budget exhausted|round limit reached/;

/** The class of the cursor stage's words: its latest attempt's error, else the lane's detail. */
function phraseKind(text: string | null | undefined): LaneStopKind | null {
  if (!text) return null;
  return STOP_PHRASES.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/** The stop a lane stands on, or null when it stands on none. */
export function laneStopKind(pipeline: Pipeline): LaneStop | null {
  if (pipeline.state === "completed" && pipeline.merge?.state === "blocked") return { kind: "merge", stageId: null };
  if (pipeline.state === "needs_review") return { kind: "unreviewed", stageId: pipelineReviewSummary(pipeline)?.stageId ?? null };
  if (pipeline.state !== "needs_decision") return null;
  const stageId = pipeline.cursor?.stageId ?? null;
  const attempt = stageId ? latestAttempt(pipeline, stageId) : null;
  if (terminalReviewContinuationAvailable(pipeline) || [pipeline.stateDetail, attempt?.error].some((text) => text && REVIEW_SPENT.test(text))) return { kind: "review", stageId };
  if (attempt?.verdict?.status === "needs_decision" || attempt?.report?.verdict.status === "needs_decision") return { kind: "question", stageId };
  const kind = phraseKind(attempt?.error) ?? phraseKind(pipeline.stateDetail);
  if (kind) return { kind, stageId };
  if (!pipeline.runs.some((run) => run.attempts.length > 0)) return { kind: "provisioning", stageId };
  return { kind: "other", stageId };
}
