import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { translate, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import type { KanbanStageChip } from "@/components/kanban/kanbanModel";
import { STAGE_TONE } from "@/components/kanban/pipelineGraph";

import {
  answerLabel, blockAgeSeconds, cardChainLevels, currentChipIndex, laneMergeWord, mergeNeedsYou, mergeReasonText, pipelineAnswers, pipelineReason, reviewStop, reviewStopFindings, sameTitle, STAGE_MARK, type ChainItem,
} from "./pipelineBlockModel";
import type { StageChipState } from "./pipelineModel";

/* The one pipeline block's decisions (#2072 slice 3), pure. */

const t: TFunction = (key, params) => translate("en", key, params);
const stage = (id: string): PipelineStage => ({ id, kind: "run", role: { roleId: "builder" }, prompt: "", next: null, onFail: null }) as unknown as PipelineStage;
const chip = (id: string, state: StageChipState, branch = false): KanbanStageChip => ({ stage: stage(id), state, rounds: 0, branch });
const read = (level: ChainItem[]) => level.map((item) => (item.kind === "stage" ? item.chip.stage.id : item.kind === "passed" ? `✓${item.n}` : `+${item.n}`)).join(" ");

test("the card's chain folds in the design's order, and every fold keeps the current stage (§3.13)", () => {
  const eight = [
    chip("plan", "passed"), chip("build-api", "passed"), chip("review-api", "passed"), chip("build-ui", "running"),
    chip("review-ui", "pending"), chip("verify", "pending"), chip("docs", "pending"), chip("merge", "pending"),
  ];
  expect(cardChainLevels(eight).map(read)).toEqual([
    "plan build-api review-api build-ui review-ui verify docs merge",
    "✓3 build-ui review-ui verify docs merge",
    "✓3 build-ui review-ui +3",
    "✓3 build-ui +4",
    "build-ui",
  ]);
  /* A lane stopped on a fail branch: the counted fold counts what came before. */
  const branch = [chip("build", "failed"), chip("review", "pending"), chip("diagnose", "needs_decision", true)];
  expect(currentChipIndex(branch)).toBe(2);
  expect(cardChainLevels(branch).map(read)).toEqual(["build review diagnose", "+2 diagnose", "diagnose"]);
  /* Two stages: the whole chain, the current one with its neighbour counted, then the current one alone. */
  expect(cardChainLevels([chip("implement", "running"), chip("review", "pending")]).map(read)).toEqual(["implement review", "implement +1", "implement"]);
  expect(cardChainLevels([chip("only", "running")]).map(read)).toEqual(["only"]);
  /* The current stage alone is only ever the last fold: every level before it
     holds two items or more, which is how a card knows it waits for its own line. */
  for (const levels of [cardChainLevels(eight), cardChainLevels(branch)]) {
    expect(levels.at(-1)!.length).toBe(1);
    for (const level of levels.slice(0, -1)) expect(level.length).toBeGreaterThan(1);
  }
  for (const levels of [cardChainLevels(eight), cardChainLevels(branch)]) {
    for (const level of levels) expect(level.some((item) => item.kind === "stage" && (item.chip.state === "running" || item.chip.state === "needs_decision"))).toBe(true);
  }
});

test("an age says the unit that matters: seconds under a minute, never minutes and seconds together", () => {
  expect(blockAgeSeconds(42.4)).toBe(42);
  expect(blockAgeSeconds(41 * 60 + 1)).toBe(41 * 60);
  expect(blockAgeSeconds(3_900 + 59)).toBe(3_900);
  expect(blockAgeSeconds(-5)).toBe(0);
});

test("a pipeline titled like its task draws no title of its own", () => {
  expect(sameTitle("Restore search results after the index rebuild", "Restore  search results after the index rebuild ")).toBe(true);
  expect(sameTitle("Restore search results", "Restore search results after the index rebuild")).toBe(false);
  expect(sameTitle("Anything", null)).toBe(false);
});

/* One tone map: every stage state names a tone the desktop graph reads, a mark
   whose shape says the state without colour, and the stylesheet gives each tone
   and each state that waits on the operator exactly one colour. */
test("one tone map: STAGE_TONE, the mark's shape and the stylesheet agree for every stage and pipeline state", () => {
  const css = readFileSync(new URL("./pipelineBlock.css", import.meta.url), "utf8");
  const states = Object.keys(STAGE_TONE) as StageChipState[];
  expect([...states].sort() as string[]).toEqual(Object.keys(STAGE_MARK).sort());
  for (const state of states) {
    const tone = STAGE_TONE[state];
    expect(css).toContain(`.tone-${tone} { --stage-tone:`);
  }
  /* needs_decision is the operator's to answer: warning, and the "!" mark, never the danger cross. */
  expect(STAGE_TONE.needs_decision).toBe("needs");
  expect(STAGE_MARK.needs_decision).toBe("alert");
  expect(css).toContain(".tone-needs { --stage-tone: var(--color-warning); }");
  expect(STAGE_MARK.failed).toBe("cross");
  expect(STAGE_MARK.passed).toBe("check");
  /* Both pipeline states that wait on the operator share the warning ink (#2080). */
  expect(css).toContain('[data-pstate="needs_decision"], [data-pstate="needs_review"] { --pstate-ink: var(--color-warning); }');
  /* The desktop board's dots read the same variable instead of a colour of their own. */
  const board = readFileSync(new URL("../kanban/kanbanBoard.css", import.meta.url), "utf8");
  expect(board).toContain(".kb :is(.tone-active, .tone-review, .tone-needs) .pdot { background: var(--stage-tone);");
  expect(board).not.toMatch(/\.kb \.tone-(active|review|ok|bad|needs) \.pdot \{ background: var\(--color-/);
});

function parked(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p", task: "Stop repeated downloads", state: "needs_decision",
    stages: [{ ...stage("implement"), next: "review" }, stage("review")],
    runs: [{ stageId: "implement", attempts: [{ n: 2, state: "failed", verdict: { status: "fail", findings: ["P1 — one"], rankedFindings: [{ severity: "P1", text: "one" }] } }] }],
    cursor: { stageId: "implement", state: "running", input: null, activatedBy: null },
    ...overrides,
  } as unknown as Pipeline;
}
const nameOf = (entry: PipelineStage) => entry.id[0]!.toUpperCase() + entry.id.slice(1);

test("a decision is answered with Skip and Retry on the stage it waits on, a stop after the last fix with Accept as is and Review again", () => {
  const decision = pipelineAnswers(parked(), nameOf)!;
  expect(decision.kind).toBe("decision");
  expect(decision.choices).toEqual([
    { action: "skip-stage", stageId: "implement", stageName: "Implement", expectedAttempt: 2 },
    { action: "retry-stage", stageId: "implement", stageName: "Implement", expectedAttempt: 2 },
  ]);
  expect(pipelineReason(t, parked(), nameOf)).toBe("Implement failed · 1 finding");

  const review = parked({
    state: "needs_review", cursor: null,
    reviewPending: { stageId: "review", attempt: 1, fixStageId: "implement", fixAttempt: 2, reviewedHead: "4f1c2a9d00", currentHead: "9b2e7d4c11", verdict: "fail", findings: 1, at: "" },
  } as Partial<Pipeline>);
  const answers = pipelineAnswers(review, nameOf)!;
  expect(answers.kind).toBe("review");
  expect(answers.stage?.id).toBe("review");
  expect(answers.choices.map((choice) => choice.action)).toEqual(["accept-head", "continue-review"]);
  expect(answers.stop?.kind).toBe("stop-after-fix");
  expect(answers.choices.map((choice) => answerLabel(t, answers, choice, false))).toEqual(["Accept as is", "Review again"]);
  expect(answers.choices.map((choice) => answerLabel(t, answers, choice, true))).toEqual(["Accept as is", "Review again"]);
  expect(pipelineReason(t, review, nameOf)).toBe("Stopped after the last fix, as this pipeline asked: the fix is not reviewed.");
  /* Any other decision keeps the stage's own words. */
  expect(decision.stop).toBeNull();
  expect(decision.choices.map((choice) => answerLabel(t, decision, choice, false))).toEqual(["Skip Implement", "Retry Implement"]);
  expect(decision.choices.map((choice) => answerLabel(t, decision, choice, true))).toEqual(["Skip stage", "Retry stage"]);

  expect(pipelineAnswers(parked({ state: "running" }), nameOf)).toBeNull();
  expect(pipelineReason(t, parked({ state: "running" }), nameOf)).toBeNull();
});

/* #2187 §3.4: a lane parked on a review, by each of the table's rows. */
function parkedReview(onExhausted: "advance" | "stop-after-fix" | "park", detail: string, reviews = 3, overrides: Partial<Pipeline> = {}): Pipeline {
  const review = { ...stage("review"), onFail: { to: "implement", maxRounds: 2, onExhausted } };
  return parked({
    stages: [{ ...stage("implement"), next: "review" }, review],
    stateDetail: detail,
    cursor: { stageId: "review", state: "running", input: null, activatedBy: null },
    runs: [
      { stageId: "implement", attempts: [1, 2, 3].map((n) => ({ n, state: "passed", activatedBy: n > 1 ? { stageId: "review", attempt: n - 1, edge: "fail" } : null })) },
      { stageId: "review", attempts: Array.from({ length: reviews }, (_, index) => ({
        n: index + 1, state: "failed", effectiveRole: { access: "read-only" },
        verdict: { status: "fail", findings: ["P2 — capture misses the stage"], rankedFindings: [{ severity: "P2", text: "capture misses the stage" }] },
      })) },
    ],
    ...overrides,
  } as Partial<Pipeline>);
}

test("each review stop names its reason and its plain answers; a stop that is no review keeps Skip and Retry (#2187 §3.4)", () => {
  const park = parkedReview("park", "fail-edge budget exhausted after 2 round(s) (onExhausted: park): P2 — capture misses the stage");
  const parkAnswers = pipelineAnswers(park, nameOf)!;
  expect(parkAnswers.stop).toMatchObject({ kind: "park", rounds: 3 });
  expect(parkAnswers.choices.map((choice) => choice.action)).toEqual(["skip-stage", "retry-stage"]);
  expect(parkAnswers.choices.map((choice) => answerLabel(t, parkAnswers, choice, false))).toEqual(["Accept without review", "Review again"]);
  expect(parkAnswers.choices.map((choice) => answerLabel(t, parkAnswers, choice, true))).toEqual(["Accept without review", "Review again"]);
  expect(pipelineReason(t, park, nameOf)).toBe("Stopped: the last of 3 review rounds failed, and this pipeline stops before fixing.");
  expect(translate("uk", "pipelineBlock.stop.park", { count: 3 })).toBe("Зупинено: останній із 3 раундів ревʼю провалено, і цей пайплайн зупиняється до виправлення.");

  /* The once-per-stage rule: this reviewer already handed its last findings on. */
  const handedOn = (pipeline: Pipeline): Pipeline => ({ ...pipeline, runs: pipeline.runs.map((run) => (run.stageId === "review" ? { ...run, attempts: run.attempts.map((entry, index) => (index === 0 ? { ...entry, budgetSpent: true } : entry)) } : run)) });
  const once = handedOn(parkedReview("advance", "fail-edge budget exhausted after 2 round(s) (onExhausted: advance): P2 — capture misses the stage"));
  expect(reviewStop(once)?.kind).toBe("once");
  /* A spent edge that parked on a failure with no verdict never handed anything on: today's words. */
  expect(reviewStop(parkedReview("advance", "fail-edge budget exhausted after 2 round(s) (onExhausted: advance): host exited"))).toBeNull();
  expect(pipelineReason(t, once, nameOf)).toBe("Stopped: Review failed again after its last fix round.");

  const legacy = parked({
    stages: [{ ...stage("implement"), next: "review" }, { ...stage("review"), kind: "review-loop" }],
    stateDetail: "review loop ended in needs_decision: round limit reached",
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    runs: [{ stageId: "review", attempts: [{ n: 1, state: "failed", verdict: { status: "fail", findings: ["round limit reached", "P2 — capture misses the stage"] } }] }],
  } as Partial<Pipeline>);
  const legacyStop = reviewStop(legacy)!;
  expect(legacyStop.kind).toBe("legacy");
  expect(pipelineReason(t, legacy, nameOf)).toBe("Stopped: the older review loop ends at its round limit without a last fix.");
  /* The flow's own detail was stored as the first finding; the reason says it in words. */
  expect(reviewStopFindings(legacy, legacyStop).map((finding) => finding.text)).toEqual(["P2 — capture misses the stage"]);

  /* A read-write stage with a fail edge, a reviewer parked for another reason,
     and a legacy loop parked short of its limit keep today's words. */
  expect(reviewStop(parkedReview("park", "fail-edge budget exhausted after 2 round(s) (onExhausted: park): x", 3, {
    runs: [{ stageId: "review", attempts: [{ n: 3, state: "failed", effectiveRole: { access: "read-write" } }] }],
  } as Partial<Pipeline>))).toBeNull();
  expect(reviewStop(parkedReview("park", "reviewer asked a question"))).toBeNull();
  expect(reviewStop(parked({ ...legacy, stateDetail: "review flow paused in relaying: kickoff delivery failed", runs: [] } as Partial<Pipeline>))).toBeNull();
});

/* #2187 §4.6, §6: a completed lane's merge on the block. */
test("a completed lane's merge says its word, and a stopped one asks with two plain answers until it is cleared", () => {
  const uk: TFunction = (key, params) => translate("uk", key, params);
  const lane = (state: string, extra: Record<string, unknown> = {}) => ({
    id: "m", state: "completed", stages: [], runs: [],
    merge: { state, reason: null, blockedAt: null, updatedAt: "2026-09-25T10:00:00.000Z", ...extra },
    ...("dismissedAt" in extra ? { dismissedAt: extra.dismissedAt } : {}),
  }) as unknown as Pipeline;
  expect(["queued", "checking", "waiting-checks", "updating", "merging", "blocked", "merged", "cancelled"].map((state) => laneMergeWord(lane(state))))
    .toEqual(["waiting", "waiting", "waiting", "updating", "merging", "stopped", "merged", null]);
  expect(laneMergeWord({ ...lane("merged"), state: "running" } as Pipeline)).toBeNull();

  const stopped = lane("blocked", { reason: 'check "slow" failed', blockedAt: "2026-09-25T10:00:00.000Z" });
  expect(mergeNeedsYou(stopped)).toBe(true);
  const answers = pipelineAnswers(stopped, (entry) => entry.id)!;
  expect(answers.kind).toBe("merge");
  expect(answers.choices.map((choice) => answerLabel(t, answers, choice, false))).toEqual(["Leave the PR open", "Try the merge again"]);
  expect(answers.choices.map((choice) => answerLabel(uk, answers, choice, true))).toEqual(["Залишити PR відкритим", "Спробувати мердж ще раз"]);
  expect(mergeReasonText(t, stopped.merge!.reason)).toBe("check slow failed");
  expect(mergeReasonText(uk, "conflict with the base branch")).toBe("конфлікт з базовою гілкою");
  expect(mergeReasonText(t, "GitHub refused the merge: Head branch was modified")).toBe("GitHub refused the merge: Head branch was modified");

  /* Cleared by a dismissal made after it stopped; one made before does not count. */
  expect(mergeNeedsYou({ ...stopped, dismissedAt: "2026-09-25T10:05:00.000Z" } as Pipeline)).toBe(false);
  expect(pipelineAnswers({ ...stopped, dismissedAt: "2026-09-25T10:05:00.000Z" } as Pipeline, (entry) => entry.id)).toBeNull();
  expect(mergeNeedsYou({ ...stopped, dismissedAt: "2026-09-25T09:00:00.000Z" } as Pipeline)).toBe(true);
});
