import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { translate, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import type { KanbanStageChip } from "@/components/kanban/kanbanModel";
import { STAGE_TONE } from "@/components/kanban/pipelineGraph";

import {
  blockAgeSeconds, cardChainLevels, currentChipIndex, pipelineAnswers, pipelineReason, sameTitle, STAGE_MARK, type ChainItem,
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

test("a decision is answered with Skip and Retry on the stage it waits on, a spent review budget with Close and One more round", () => {
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
  expect(answers.choices.map((choice) => choice.action)).toEqual(["close", "continue-review"]);
  expect(pipelineReason(t, review, nameOf)).toBe("head 9b2e7d4c unreviewed · no rounds left");

  expect(pipelineAnswers(parked({ state: "running" }), nameOf)).toBeNull();
  expect(pipelineReason(t, parked({ state: "running" }), nameOf)).toBeNull();
});
