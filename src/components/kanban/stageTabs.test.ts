import { expect, test } from "bun:test";

import { STAGE_MARK } from "@/components/pipelines/pipelineBlockModel";
import { laneRouteKey } from "@/lib/attention/routeTypes";
import { translate, type TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";

import { graphOrder } from "./pipelineGraph";
import { summarizePipeline } from "./pipelineSummary";
import { laneWaitsOn, recheckAttempts, stageTabs, tabNote } from "./stageTabs";

/* The Stages window's tab model over invented pipeline records shaped like the
   lanes the store holds (docs/design/redesign-2026-11/s2-build-brief.md §9.1).
   Stage ids are neutral; each case names the kind of lane it stands for. */

const NOW = Date.parse("2026-11-20T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const en: TFunction = ((key: string, params?: Record<string, unknown>) => translate("en", key as never, params as never)) as TFunction;
const uk: TFunction = ((key: string, params?: Record<string, unknown>) => translate("uk", key as never, params as never)) as TFunction;

const role = (roleId: string) => ({ roleId, engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null });
function stage(id: string, roleId: string, next: string | null, over: Record<string, unknown> = {}) {
  return { id, kind: "run", role: { roleId }, prompt: `Stage ${id}.`, next, onFail: null, effectiveRole: role(roleId), ...over };
}
const failTo = (to: string, maxRounds = 2, onExhausted?: string) => ({ onFail: { to, maxRounds, ...(onExhausted ? { onExhausted } : {}) } });
type Attempt = { n: number; state: string; activatedBy?: unknown; historical?: boolean };
const attempt = (n: number, state: string, over: Record<string, unknown> = {}) => ({
  n, state, effectiveRole: role("builder"), conversationId: `conversation_${n}`, agentPath: `/fixture/${n}.jsonl`, startedAt: iso(60 - n), completedAt: state === "running" ? null : iso(50 - n), activatedBy: null, ...over,
});
const failVia = (stageId: string, n: number) => ({ activatedBy: { stageId, attempt: n, edge: "fail" } });
function lane(stages: unknown[], runs: Record<string, Attempt[]> = {}, state = "running", cursor: string | null = null, extra: Record<string, unknown> = {}): Pipeline {
  return {
    id: "p-lane", task: "Fixture lane", taskIds: ["t"], project: "fixture", state, stateDetail: null, createdAt: iso(120), closedAt: null,
    stages, runs: Object.entries(runs).map(([stageId, attempts]) => ({ stageId, attempts })), cursor: cursor ? { stageId: cursor } : null, ...extra,
  } as unknown as Pipeline;
}
const tabsOf = (pipeline: Pipeline) => stageTabs(summarizePipeline(pipeline));
const ids = (pipeline: Pipeline) => tabsOf(pipeline).tabs.map((tab) => tab.stage.id);

const reviewed = (fix: ReturnType<typeof stage> = stage("fix", "builder", "review")) => [
  stage("build", "builder", "review"),
  stage("review", "reviewer", null, failTo("fix")),
  fix,
];

test("a single stage has one tab and draws no strip", () => {
  const model = tabsOf(lane([stage("integrate", "builder", null)], { integrate: [attempt(1, "running")] }, "running", "integrate"));
  expect(model.tabs.map((tab) => tab.stage.id)).toEqual(["integrate"]);
  expect(model.showStrip).toBe(false);
  expect(model.units).toHaveLength(1);
});

test("a linear lane numbers its steps in order and has no rule", () => {
  const model = tabsOf(lane([stage("apply", "builder", "verify"), stage("verify", "verifier", null)]));
  expect(model.tabs.map((tab) => [tab.stage.id, tab.kind, tab.number])).toEqual([["apply", "step", 1], ["verify", "step", 2]]);
  expect(model.rules).toEqual([]);
  expect(model.showStrip).toBe(true);
});

test("a docked fix that never ran is a conditional tab under its review, with no rule line, and reads «not needed» once the lane ended", () => {
  const record = lane(reviewed(), { build: [attempt(1, "passed")], review: [attempt(1, "passed")] }, "completed");
  const summary = summarizePipeline(record);
  const model = stageTabs(summary);
  expect(model.units.map((unit) => unit.map((tab) => tab.stage.id))).toEqual([["build"], ["review", "fix"]]);
  const fix = model.tabs[2]!;
  expect([fix.kind, fix.number, fix.anchor]).toEqual(["conditional", null, "review"]);
  expect(fix.carried).toMatchObject({ fired: 0, max: 2, shape: "dock" });
  expect(model.rules.filter((rule) => !rule.carried)).toEqual([]);
  expect(tabNote(fix, summary)).toEqual({ skipped: false, word: "notNeeded" });
  /* The same lane while it can still reach the fix. */
  const open = summarizePipeline(lane(reviewed(), { build: [attempt(1, "passed")], review: [attempt(1, "running")] }, "running", "review"));
  expect(tabNote(stageTabs(open).tabs[2]!, open).word).toBe("ifNeeded");
});

test("a docked fix that ran carries its state and one fired round", () => {
  const record = lane(reviewed(), {
    build: [attempt(1, "passed")],
    review: [attempt(1, "failed")],
    fix: [attempt(1, "running", failVia("review", 1))],
  }, "running", "fix");
  const summary = summarizePipeline(record);
  const model = stageTabs(summary);
  const fix = model.tabs[2]!;
  expect(tabNote(fix, summary).word).toBeNull();
  expect(fix.carried).toMatchObject({ fired: 1, max: 2 });
  expect(summary.views.get("fix")?.state).toBe("running");
  expect(model.rules.every((rule) => rule.carried)).toBe(true);
});

test("a fix that docks to the end or onward stays in its review's unit", () => {
  for (const fixNext of [null, "review"]) {
    const model = tabsOf(lane([stage("build", "builder", "review"), stage("review", "reviewer", "ship", failTo("fix", 1)), stage("fix", "builder", fixNext), stage("ship", "cleaner", null)]));
    expect(model.units.map((unit) => unit.map((tab) => tab.stage.id))).toEqual([["build"], ["review", "fix"], ["ship"]]);
    expect(model.tabs.find((tab) => tab.stage.id === "fix")?.carried).not.toBeNull();
  }
});

test("a return to an earlier step adds no tab, only a rule line that counts its rounds", () => {
  const record = lane([stage("build", "builder", "verify"), stage("verify", "verifier", null, failTo("build"))], {
    build: [attempt(1, "passed"), attempt(2, "running", failVia("verify", 1))],
    verify: [attempt(1, "failed")],
  }, "running", "build");
  const model = tabsOf(record);
  expect(ids(record)).toEqual(["build", "verify"]);
  expect(model.rules).toHaveLength(1);
  expect(model.rules[0]).toMatchObject({ from: "verify", to: "build", shape: "return", fired: 1, max: 2, carried: false });
});

test("a fix two reviewers share comes after the first reviewer that reaches it, which graph order does not give", () => {
  const stages = [
    stage("brief", "architect", "build"),
    stage("fix", "builder", "review"),
    stage("build", "builder", "review"),
    stage("review", "reviewer", "visual", failTo("fix")),
    stage("visual", "visual-critic", null, failTo("fix", 1, "park")),
  ];
  const record = lane(stages);
  expect(graphOrder(record).map((entry) => entry.id)).toEqual(["brief", "fix", "build", "review", "visual"]);
  expect(ids(record)).toEqual(["brief", "build", "review", "fix", "visual"]);
  const model = tabsOf(record);
  expect(model.tabs.find((tab) => tab.stage.id === "fix")).toMatchObject({ kind: "conditional", anchor: "review", sources: ["review", "visual"], carried: null });
  expect(model.rules.map((rule) => [rule.id, rule.carried])).toEqual([["review:fail:fix", false], ["visual:fail:fix", false]]);
});

test("a visual fix that returns to review sits after the visual critic, with a rule line for its budget", () => {
  const stages = [
    stage("brief", "architect", "build"),
    stage("visual-fix", "builder", "review"),
    stage("build", "builder", "review"),
    stage("review", "reviewer", "visual", failTo("fix")),
    stage("fix", "builder", "review"),
    stage("visual", "visual-critic", null, failTo("visual-fix", 2, "park")),
  ];
  const record = lane(stages);
  expect(graphOrder(record).findIndex((entry) => entry.id === "visual-fix")).toBeLessThan(graphOrder(record).findIndex((entry) => entry.id === "build"));
  expect(ids(record)).toEqual(["brief", "build", "review", "fix", "visual", "visual-fix"]);
  const model = tabsOf(record);
  expect(model.tabs.at(-1)).toMatchObject({ kind: "conditional", anchor: "visual", carried: null });
  expect(model.rules.find((rule) => rule.to === "visual-fix")).toMatchObject({ carried: false, mode: "park", max: 2 });
});

test("a fix chain hangs in order under the review that reaches it", () => {
  const model = tabsOf(lane([
    stage("build", "builder", "review"),
    stage("review", "reviewer", "visual", failTo("fix-api")),
    stage("fix-api", "builder", "fix-web"),
    stage("fix-web", "builder", "review"),
    stage("visual", "visual-critic", null, failTo("fix-web")),
  ]));
  expect(model.units.map((unit) => unit.map((tab) => tab.stage.id))).toEqual([["build"], ["review", "fix-api", "fix-web"], ["visual"]]);
});

test("a first stage that is a fail target stays step one and the rule names it", () => {
  const model = tabsOf(lane([stage("fix", "builder", "review"), stage("review", "reviewer", null, failTo("fix"))]));
  expect(model.tabs.map((tab) => [tab.stage.id, tab.kind, tab.number])).toEqual([["fix", "step", 1], ["review", "step", 2]]);
  expect(model.rules[0]).toMatchObject({ from: "review", to: "fix", carried: false });
});

test("a rule goes back only to a step that reads earlier; a conditional or detached target is forward", () => {
  const first = tabsOf(lane([stage("fix", "builder", "review"), stage("review", "reviewer", null, failTo("fix"))]));
  expect(first.rules[0]).toMatchObject({ from: "review", to: "fix", back: true });
  const returning = tabsOf(lane([stage("build", "builder", "review"), stage("review", "reviewer", "deliver", failTo("build")), stage("deliver", "cleaner", null)]));
  expect(returning.rules[0]).toMatchObject({ from: "review", to: "build", back: true });
  const conditional = tabsOf(lane([stage("build", "builder", "review"), stage("review", "reviewer", null, failTo("fix")), stage("fix", "builder", "review")]));
  expect(conditional.rules[0]).toMatchObject({ from: "review", to: "fix", back: false });
  const shared = tabsOf(lane([
    stage("build", "builder", "review"),
    stage("review", "reviewer", "visual", failTo("fix")),
    stage("visual", "visual-critic", null, failTo("fix", 1)),
    stage("fix", "builder", "review"),
  ]));
  expect(shared.rules.map((rule) => [rule.from, rule.to, rule.back])).toEqual([["review", "fix", false], ["visual", "fix", false]]);
  const detached = tabsOf(lane([stage("build", "builder", "review"), stage("review", "reviewer", null, failTo("opus-fix")), stage("opus-fix", "builder", null)]));
  expect(detached.rules[0]).toMatchObject({ back: false });
  const self = tabsOf(lane([stage("upgrade", "builder", null, failTo("upgrade"))]));
  expect(self.rules[0]).toMatchObject({ shape: "self", back: true });
});

test("stages the first stage does not reach are detached tabs after the steps, even one that passes into the chain", () => {
  const record = lane([
    stage("build", "builder", "review"),
    stage("review", "reviewer", null),
    stage("opus-fix", "builder", "review"),
    stage("recheck", "reviewer", null),
  ], { build: [attempt(1, "passed")], review: [attempt(1, "passed")] }, "completed");
  const summary = summarizePipeline(record);
  const model = stageTabs(summary);
  expect(model.tabs.map((tab) => [tab.stage.id, tab.kind, tab.number])).toEqual([["build", "step", 1], ["review", "step", 2], ["opus-fix", "detached", null], ["recheck", "detached", null]]);
  expect(tabNote(model.tabs[2]!, summary).word).toBe("notRun");
  const open = summarizePipeline(lane(record.stages as unknown[], {}, "running", "build"));
  expect(tabNote(stageTabs(open).tabs[2]!, open).word).toBe("offChain");
});

test("eight-stage lanes keep one cell per step and per detached stage", () => {
  const twoGates = lane([
    stage("rewrite", "builder", "check"),
    stage("check", "reviewer", "deliver", failTo("fix")),
    stage("fix", "builder", "check"),
    stage("deliver", "cleaner", "pk-check"),
    stage("pk-check", "reviewer", "pk-deliver", failTo("pk-fix")),
    stage("pk-fix", "builder", "pk-check"),
    stage("pk-deliver", "cleaner", null),
  ]);
  expect(tabsOf(twoGates).tabs).toHaveLength(7);
  expect(tabsOf(twoGates).units).toHaveLength(5);
  const shared = tabsOf(lane([
    stage("brief", "architect", "api"),
    stage("api", "builder", "web"),
    stage("web", "builder", "integrate"),
    stage("review", "reviewer", "visual", failTo("fix")),
    stage("integrate", "builder", "review"),
    stage("visual", "visual-critic", "recheck", failTo("fix", 1)),
    stage("recheck", "reviewer", null, failTo("fix", 1)),
    stage("fix", "builder", "review"),
  ]));
  /* The declared order puts integrate after the visual stage; the steps follow `next`. */
  expect(shared.tabs.filter((tab) => tab.kind === "step").map((tab) => tab.stage.id)).toEqual(["brief", "api", "web", "integrate", "review", "visual", "recheck"]);
  expect(shared.units).toHaveLength(7);
  expect(shared.rules).toHaveLength(3);
});

test("a conditional chain with its own loop keeps both stages under the stage that reaches it and gives the inner loop a rule", () => {
  const model = tabsOf(lane([
    stage("build", "builder", "verify-ci"),
    stage("verify-ci", "verifier", null, failTo("ci-fix")),
    stage("ci-fix", "builder", "ci-review"),
    stage("ci-review", "reviewer", "verify-ci", failTo("ci-fix")),
  ]));
  expect(model.units.map((unit) => unit.map((tab) => tab.stage.id))).toEqual([["build"], ["verify-ci", "ci-fix", "ci-review"]]);
  expect(model.rules.find((rule) => rule.from === "ci-review")).toMatchObject({ to: "ci-fix", carried: false });
});

test("a retry in place is one rule on its own stage", () => {
  const model = tabsOf(lane([stage("upgrade", "builder", null, failTo("upgrade"))]));
  expect(model.rules).toEqual([expect.objectContaining({ from: "upgrade", to: "upgrade", shape: "self", carried: false })]);
  expect(model.showStrip).toBe(false);
});

test("a skipped stage has a mark of its own, which a waiting stage does not", () => {
  const record = lane([stage("build", "builder", "review"), stage("review", "reviewer", "deliver"), stage("deliver", "cleaner", null)], {
    build: [attempt(1, "passed")], review: [attempt(1, "passed")], deliver: [attempt(1, "skipped")],
  }, "completed");
  const summary = summarizePipeline(record);
  const model = stageTabs(summary);
  expect(tabNote(model.tabs[2]!, summary).skipped).toBe(true);
  const waiting = summarizePipeline(lane(record.stages as unknown[], { build: [attempt(1, "running")] }, "running", "build"));
  expect(tabNote(stageTabs(waiting).tabs[2]!, waiting).skipped).toBe(false);
  /* Today's mark map draws both as a ring: the tab's own mark is what tells them apart. */
  expect(STAGE_MARK.skipped).toBe(STAGE_MARK.pending);
});

test("an attempt a spent budget handed back for a re-check is flagged", () => {
  const record = lane([stage("review", "reviewer", null, failTo("fix", 1)), stage("fix", "builder", "review")], {
    review: [attempt(1, "failed"), attempt(2, "passed", { activatedBy: { stageId: "fix", attempt: 1, edge: "pass", budgetRecheck: true } })],
    fix: [attempt(1, "passed", failVia("review", 1))],
  }, "completed");
  expect([...recheckAttempts(record, "review")]).toEqual([2]);
  expect([...recheckAttempts(record, "fix")]).toEqual([]);
});

/* ── Whom the lane waits on ─────────────────────────────────────────────── */

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
function waits(record: Pipeline, t: TFunction = en) {
  const summary = summarizePipeline(record);
  return laneWaitsOn(t, summary, stageTabs(summary), NOW, { nameOf: (entry) => entry.id, clock });
}
const threeStages = (state: string, cursor: string, runs: Record<string, Attempt[]>, extra: Record<string, unknown> = {}) =>
  lane([stage("brief", "architect", "build"), stage("build", "builder", "review"), stage("review", "reviewer", null)], runs, state, cursor, extra);

test("a working builder is named by role and stage, in both languages", () => {
  const record = threeStages("running", "build", { brief: [attempt(1, "passed")], build: [attempt(1, "running")] }, { stateDetail: null });
  const english = waits(record, en);
  expect(english).toMatchObject({ owner: "working", stageId: "build" });
  expect(english.words).toBe("Stage 2 of 3 · waiting on the Builder (build)");
  expect(english.detail).toContain("The Builder works on build");
  expect(english.detail).toContain("next — review");
  expect(waits(record, uk).words).toBe("Етап 2 з 3 · чекає на Білдера (build)");
});

test("a reviewer is named in its own case", () => {
  const record = threeStages("running", "review", { brief: [attempt(1, "passed")], build: [attempt(1, "passed")], review: [attempt(1, "running")] });
  expect(waits(record).words).toBe("Stage 3 of 3 · waiting on the Reviewer (review)");
});

test("a lane stopped by a refused publication says so although its stage passed", () => {
  const record = lane([stage("fix", "builder", null)], { fix: [attempt(1, "passed")] }, "needs_decision", "fix", { stateDetail: "publishing the passed stage failed: push refused" });
  const result = waits(record);
  expect(result.owner).toBe("you");
  expect(result.words).toBe("Needs your answer: the branch could not be published");
  expect(waits(record, uk).words).toContain("гілку не вдалося опублікувати");
});

test("a stop the seat owns reads differently from one the operator owns", () => {
  const record = lane([stage("fix", "builder", null)], { fix: [attempt(1, "failed", { error: "committing the passed stage: index.lock exists" })] }, "needs_decision", "fix");
  expect(waits(record).owner).toBe("you");
  record.attentionRoute = { key: laneRouteKey(record, "lane-decision"), owner: "seat", seat: "conversation_seat" };
  const seat = waits(record);
  expect(seat.owner).toBe("seat");
  expect(seat.words).toBe("The orchestrator is on it: the fix commit failed");
});

test("a lane in the CPU queue, provisioning or paused names that, not a stage's work", () => {
  const queued = lane([stage("integrate", "builder", null)], { integrate: [attempt(1, "pending")] }, "running", "integrate", {
    stateDetail: "Waiting for the CPU queue · 2nd · waited 4 min · normal priority",
  });
  expect(waits(queued).words).toContain("Waiting for the CPU queue · 2nd");
  expect(waits(lane([stage("a", "builder", null)], {}, "provisioning", null)).words).toBe("provisioning the worktree · no stage started");
  const paused = lane([stage("a", "builder", "b"), stage("b", "builder", null)], { a: [attempt(1, "passed")] }, "paused", "b", { pause: { reason: "waiting for a deploy window" } });
  expect(waits(paused).words).toBe("Stage 2 of 2 · paused · waiting for a deploy window");
});

test("a completed lane says it is done and a single-stage lane drops the position", () => {
  const done = threeStages("completed", "review", { brief: [attempt(1, "passed")], build: [attempt(1, "passed")], review: [attempt(1, "passed")] });
  expect(waits(done)).toMatchObject({ owner: "done", words: "Done", stageId: null });
  const single = lane([stage("integrate", "builder", null)], { integrate: [attempt(1, "running")] }, "running", "integrate");
  expect(waits(single).words).toBe("waiting on the Builder (integrate)");
});
