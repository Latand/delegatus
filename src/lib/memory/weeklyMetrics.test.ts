import { expect, test } from "bun:test";
import {
  decide, findingClasses, laneMetrics, proportionDifference, reviewVerdict, weeklyReport, wilson, windowReport,
  type Decision, type DecisionSample, type MetricsAttempt, type MetricsInput, type MetricsPipeline,
} from "./weeklyMetrics";

/* Slice 6 of docs/design/memory-source-switch.md: a synthetic pipeline set
   per case. All times are fixed; nothing reads a clock. */
const BASE = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z" };
const IMPORT = { from: "2026-10-08T00:00:00.000Z", to: "2026-10-09T00:00:00.000Z" };
const TRIAL = { from: "2026-10-09T00:00:00.000Z", to: "2026-10-16T00:00:00.000Z" };
const at = (window: { from: string }, hours: number) => new Date(Date.parse(window.from) + hours * 3600_000).toISOString();

const builder = (n: number, startedAt: string, extra: Partial<MetricsAttempt> = {}): MetricsAttempt => ({
  n, startedAt, completedAt: new Date(Date.parse(startedAt) + 3600_000).toISOString(), sessionId: `s-${startedAt}-${n}`,
  effectiveRole: { roleId: "builder", engine: "codex", model: "m1", promptScaffold: "builder scaffold" }, activatedBy: null, verdict: { status: "pass" }, ...extra,
});
const reviewer = (n: number, completedAt: string, extra: Partial<MetricsAttempt> = {}): MetricsAttempt => ({
  n, startedAt: new Date(Date.parse(completedAt) - 1800_000).toISOString(), completedAt,
  effectiveRole: { roleId: "reviewer", engine: "codex", model: "m2", promptScaffold: "reviewer scaffold" }, activatedBy: { edge: "pass" }, ...extra,
});
function lane(id: string, build: MetricsAttempt[], review: MetricsAttempt[], project = "A"): MetricsPipeline {
  return {
    id, project,
    stages: [{ id: "build", kind: "run" }, { id: "review", kind: "run", onFail: { to: "build", maxRounds: 2 } }],
    runs: [{ stageId: "build", attempts: build }, { stageId: "review", attempts: review }],
  };
}
const input = (pipelines: MetricsPipeline[], extra: Partial<MetricsInput> = {}): MetricsInput => ({ pipelines, memory: [], imports: [], deliveries: [], ...extra });

test("every verdict writer gives one first-review verdict", () => {
  expect(reviewVerdict(reviewer(1, at(TRIAL, 3), { report: { at: at(TRIAL, 3), verdict: { status: "fail", findings: ["P1 — a test is missing"] } } }))).toMatchObject({ status: "fail", findings: ["P1 — a test is missing"] });
  expect(reviewVerdict(reviewer(1, at(TRIAL, 3), { verdict: { status: "pass" } }))).toMatchObject({ status: "pass" });
  expect(reviewVerdict(reviewer(1, at(TRIAL, 3), { reviewFlowSync: { verdict: "REQUEST_CHANGES", synchronizedAt: at(TRIAL, 3) } }))).toMatchObject({ status: "fail" });
  expect(reviewVerdict(reviewer(1, at(TRIAL, 3), { reviewFlowSync: { verdict: "APPROVE" } }))).toMatchObject({ status: "pass" });
  expect(reviewVerdict(reviewer(1, at(TRIAL, 3), { state: "failed", verdict: null }))).toBeNull();
  expect(reviewVerdict(reviewer(1, at(TRIAL, 3), { verdict: { status: "needs_decision" } }))).toMatchObject({ status: "needs_decision" });
  expect(reviewVerdict(reviewer(1, at(TRIAL, 3), { verdict: { status: "needs_decision" }, decisionRequested: true }))).toMatchObject({ status: "fail" });
  expect(reviewVerdict(reviewer(1, at(TRIAL, 3), { verdict: { status: "fail", rankedFindings: [{ text: "ranked only" }] } }))?.findings).toEqual(["ranked only"]);
});

function trialSet(): MetricsPipeline[] {
  return [
    // stage_report fail within the grace, one fix round, then a pass.
    lane("within-grace", [builder(1, at(TRIAL, 1)), builder(2, at(TRIAL, 5), { activatedBy: { edge: "fail" } })],
      [reviewer(1, at(TRIAL, 3), { report: { at: at(TRIAL, 3), verdict: { status: "fail", findings: ["P1 — the restart path has no test", "P2 — the schema is unvalidated"] } } }),
        reviewer(2, at(TRIAL, 7), { verdict: { status: "fail", findings: ["P1 — the retry test still fails", "P3 — wording"] } }),
        reviewer(3, at(TRIAL, 9), { verdict: { status: "pass" } })]),
    // Reviewed only after the 24-hour grace: counted, not reviewed.
    lane("after-grace", [builder(1, at(TRIAL, 160))], [reviewer(1, at(TRIAL, 168 + 25), { verdict: { status: "fail" } })]),
    // Reviewed inside the grace although after the window end.
    lane("inside-grace", [builder(1, at(TRIAL, 160))], [reviewer(1, at(TRIAL, 168 + 23), { verdict: { status: "pass" } })]),
    // Started in the import window: in neither.
    lane("import-window", [builder(1, at(IMPORT, 2))], [reviewer(1, at(IMPORT, 4), { verdict: { status: "fail" } })]),
    // Fenced JSON fallback (verdict, no report) and a review-loop outcome.
    lane("fenced-json", [builder(1, at(TRIAL, 10))], [reviewer(1, at(TRIAL, 12), { verdict: { status: "pass" } })]),
    lane("review-loop", [builder(1, at(TRIAL, 20))], [reviewer(1, at(TRIAL, 22), { verdict: null, reviewFlowSync: { verdict: "REQUEST_CHANGES", synchronizedAt: at(TRIAL, 22) } })]),
    // A retried reviewer whose first attempt died without a verdict.
    lane("retried", [builder(1, at(TRIAL, 30))], [reviewer(1, at(TRIAL, 31), { state: "failed", verdict: null }), reviewer(2, at(TRIAL, 33), { verdict: { status: "pass" } })]),
    // A parked needs_decision and one routed along the fail edge.
    lane("parked", [builder(1, at(TRIAL, 40))], [reviewer(1, at(TRIAL, 42), { verdict: { status: "needs_decision" } })]),
    lane("routed", [builder(1, at(TRIAL, 50))], [reviewer(1, at(TRIAL, 52), { verdict: { status: "needs_decision" }, decisionRequested: true })], "B"),
    // A lane whose first builder attempt is a fail-edge activation alone does not start a lane.
    lane("fix-only", [builder(1, at(TRIAL, 60), { activatedBy: { edge: "fail" } })], [reviewer(1, at(TRIAL, 62), { verdict: { status: "fail" } })]),
  ];
}

test("lanes, reviews in the grace, fix rounds and repeated classes are counted per §6.1–6.2", () => {
  const report = windowReport(input(trialSet()), TRIAL);
  expect(report.lanes).toEqual({ counted: 8, reviewed: 7, excludedLegacy: 0 });
  // within-grace, review-loop and routed failed their first review.
  expect(report.failedReview).toMatchObject({ failed: 3, reviewed: 7 });
  expect(report.fixRounds.perLane.reduce((a, b) => a + b, 0)).toBe(1);
  expect(report.fixRounds.median).toBe(0);
  // Round 2 holds two findings; the tests class appeared in round 1.
  expect(report.repeatedClasses).toMatchObject({ repeated: 1, later: 2 });
  expect(report.byProject).toEqual({ A: { reviewed: 6, failed: 2 }, B: { reviewed: 1, failed: 1 } });
  const imported = windowReport(input(trialSet()), IMPORT);
  expect(imported.lanes.counted).toBe(1);
  expect(windowReport(input(trialSet()), BASE).lanes.counted).toBe(0);
});

test("a lane with an attempt on a legacy generation is excluded from the trial", () => {
  const pipelines = trialSet();
  const legacy = pipelines[0].runs[0].attempts[0].sessionId!;
  const report = windowReport(input(pipelines, { imports: [{ kind: "import", id: "i", legacyGenerations: [legacy] }] }), TRIAL);
  expect(report.lanes).toMatchObject({ counted: 7, excludedLegacy: 1 });
  expect(report.failedReview.failed).toBe(2);
});

test("evictions of each kind, lesson answers, seat and operator rules and import dispositions", () => {
  const rule = (id: string, extra: Record<string, unknown>) => ({ kind: "rule", id, scope: "role:A:builder", state: "active", source: { origin: "stage" }, createdAt: at(BASE, 1), changedAt: at(BASE, 1), ...extra });
  const pipelines = trialSet();
  const memory = [
    rule("r1", { state: "archived", reason: "budget", changedAt: at(TRIAL, 2) }),
    rule("r2", { state: "archived", reason: "budget", changedAt: at(TRIAL, 3), curatedAt: at(TRIAL, 1) }),
    rule("r3", { state: "archived", reason: "budget", changedAt: at(TRIAL, 3), versionOf: "r2" }),
    rule("r4", { state: "archived", reason: "budget", changedAt: at(BASE, 3) }),
    rule("r5", { source: { origin: "seat" }, createdAt: at(TRIAL, 4) }),
    rule("r6", { source: { origin: "operator" }, createdAt: at(TRIAL, 4) }),
    rule("r7", { source: { origin: "import" }, state: "archived", reason: "stale", changedAt: at(TRIAL, 5) }),
    { kind: "request", pipelineId: "within-grace", stageId: "build", attempt: 1, at: at(TRIAL, 2), ruleIds: ["r9"], none: null },
    { kind: "request", pipelineId: "within-grace", stageId: "build", attempt: 2, at: at(TRIAL, 6), ruleIds: [], none: null, rewrote: "r9" },
    { kind: "request", pipelineId: "fenced-json", stageId: "build", attempt: 1, at: at(TRIAL, 11), ruleIds: [], none: "covered" },
    { kind: "request", pipelineId: "retried", stageId: "build", attempt: 1, at: at(TRIAL, 31), ruleIds: [], none: null, problem: { statement: "s", evidence: "e" } },
    { kind: "request", pipelineId: "parked", stageId: "build", attempt: 1, at: at(TRIAL, 41), ruleIds: [], none: null },
  ];
  const imports = [{ kind: "candidate", dispositions: [{ at: at(TRIAL, 1), kind: "adopt" }, { at: at(TRIAL, 2), kind: "drop", reason: "stale" }, { at: at(IMPORT, 1), kind: "drop", reason: "duplicate" }] }];
  const report = windowReport(input(pipelines, { memory, imports }), TRIAL);
  expect(report.evictions).toEqual({ neverCurated: 1, curated: 1 });
  expect(report.lessons).toEqual({ stage: { lesson: 1, none: 1, problem: 1, open: 1 }, fixRound: { rewrite: 1 }, seatRules: 1, operatorRules: 1 });
  expect(report.imports).toEqual({ adopted: 1, dropped: { stale: 1 }, adoptedArchived: 1 });
  expect(report.invalidBecause).toContain("never-curated-eviction");
});

test("load records attempts, clean share, engines, models, concurrency, limits, deploys and presets", () => {
  const pipelines = trialSet();
  const report = windowReport(input(pipelines, {
    workerLimit: { machine: { value: 30, changedAt: at(TRIAL, 100) }, history: [{ at: at(TRIAL, 100), scope: "machine", from: 15, to: 30 }] },
    deployments: [{ phase: "succeeded", updatedAt: at(TRIAL, 2) }, { phase: "failed", updatedAt: at(TRIAL, 3) }, { phase: "succeeded", updatedAt: at(BASE, 2) }],
  }), TRIAL);
  expect(report.load.attemptsStarted).toBe(20);
  expect(report.load.nonClean).toBe(10);
  expect(report.load.byEngine).toEqual({ codex: 20 });
  expect(report.load.byModel).toEqual({ m1: 10, m2: 10 });
  expect(report.load.peakConcurrent).toBe(2);
  expect(report.load.workerLimit).toEqual({ atStart: 15, changes: 1 });
  expect(report.load.deploys).toBe(1);
  expect(report.load.presets).toEqual({ builder: { "codex/m1": 10 }, reviewer: { "codex/m2": 10 } });
  expect(report.valid).toBe(true);
});

test("guards: an engine memory hash, a held-still change, a scaffold change and a load swing invalidate a window", () => {
  const pipelines = trialSet();
  expect(windowReport(input(pipelines, { deliveries: [{ at: at(TRIAL, 1), engineMemory: [{ hash: "h" }] }, { at: at(TRIAL, 2), engineMemory: [] }] }), TRIAL).invalidBecause).toEqual(["engine-memory-loaded"]);
  expect(windowReport(input(pipelines, { deliveries: [{ at: at(BASE, 1), engineMemory: [{ hash: "h" }] }] }), TRIAL).valid).toBe(true);
  expect(windowReport(input(pipelines, { heldChanges: [at(TRIAL, 3)] }), TRIAL).invalidBecause).toEqual(["held-still-changed"]);
  pipelines[1].runs[0].attempts[0].effectiveRole!.promptScaffold = "edited scaffold";
  expect(windowReport(input(pipelines), TRIAL).invalidBecause).toEqual(["held-still-changed"]);
  expect(windowReport(input(trialSet()), TRIAL, 10).invalidBecause).toEqual(["load-changed"]);
  expect(windowReport(input(trialSet()), TRIAL, 18).valid).toBe(true);
});

test("intervals: Wilson and the Newcombe difference", () => {
  const [low, high] = wilson(158, 335)!;
  expect(low).toBeCloseTo(0.4185, 3);
  expect(high).toBeCloseTo(0.5254, 3);
  expect(wilson(0, 0)).toBeNull();
  const difference = proportionDifference(60, 100, 40, 100)!;
  expect(difference.difference).toBeCloseTo(0.2, 6);
  expect(difference.interval[0]).toBeGreaterThan(0);
  expect(proportionDifference(45, 100, 40, 100)!.interval[0]).toBeLessThan(0);
});

const sample = (reviewed: number, failed: number, fixMean = 1, later = 100, repeated = 80): DecisionSample => ({
  reviewed, failed, fixRounds: Array.from({ length: reviewed }, (_, i) => (i % 2 ? Math.floor(fixMean) : Math.ceil(fixMean))), later, repeated,
});
const BASELINE = sample(300, 140, 1, 200, 160);
const valid = (s: DecisionSample) => ({ sample: s, valid: true });
const invalid = (s: DecisionSample) => ({ sample: s, valid: false, invalidBecause: ["engine-memory-loaded"] });

test("§6.6: Delegatus unless the failed-review rise is clear", () => {
  expect(decide(BASELINE, [valid(sample(300, 150))])).toMatchObject({ outcome: "delegatus", usedWindows: [0] });
  expect(decide(BASELINE, [valid(sample(300, 100))])).toMatchObject({ outcome: "delegatus" });
});

test("§6.6: the engines when the rise is clear and a corroborating metric rose", () => {
  expect(decide(BASELINE, [valid(sample(300, 200, 2))])).toMatchObject({ outcome: "engines", usedWindows: [0] });
  expect(decide(BASELINE, [valid(sample(300, 200, 1, 200, 195))])).toMatchObject({ outcome: "engines" });
});

test("§6.6: an inconclusive valid week extends once and the pooled primary decides", () => {
  const rise = sample(300, 200, 1, 200, 160);
  expect(decide(BASELINE, [valid(rise)])).toMatchObject({ outcome: "extend", usedWindows: [0] });
  expect(decide(BASELINE, [valid(rise), valid(sample(300, 190, 1, 200, 160))])).toMatchObject({ outcome: "engines", usedWindows: [0, 1] });
  expect(decide(BASELINE, [valid(rise), valid(sample(300, 60, 1, 200, 160))])).toMatchObject({ outcome: "delegatus", usedWindows: [0, 1] });
  // An invalid week between them is never the extension.
  expect(decide(BASELINE, [valid(rise), invalid(sample(300, 10)), valid(sample(300, 190))])).toMatchObject({ outcome: "engines", usedWindows: [0, 2] });
});

test("§6.6: an invalid first week contributes nothing, even when including it would reverse the result", () => {
  const harmful = sample(300, 250, 3, 200, 199);
  const second = sample(300, 140);
  const withInvalid = decide(BASELINE, [invalid(harmful), valid(second)]);
  const without = decide(BASELINE, [valid(second)]);
  expect(withInvalid.outcome).toBe("delegatus");
  expect({ ...withInvalid, usedWindows: withInvalid.usedWindows.map(index => index - 1), invalidWindows: [] as Decision["invalidWindows"] }).toEqual(without);
  // Counted as valid, the same week reverses the result.
  expect(decide(BASELINE, [valid(harmful), valid(second)]).outcome).toBe("engines");
});

test("§6.6: two invalid windows in a row stop and ask; separated ones do not", () => {
  expect(decide(BASELINE, [invalid(sample(300, 140)), invalid(sample(300, 140))])).toMatchObject({ outcome: "stop-and-ask", invalidWindows: [{ index: 0 }, { index: 1 }] });
  expect(decide(BASELINE, [invalid(sample(300, 140))])).toMatchObject({ outcome: "pending" });
  expect(decide(BASELINE, [])).toMatchObject({ outcome: "pending" });
  expect(decide(BASELINE, [valid(sample(0, 0))])).toMatchObject({ outcome: "pending" });
});

test("weeklyReport runs the guards against the baseline load and decides on valid windows only", () => {
  const set = trialSet();
  const baseline = trialSet().map(pipeline => shift(pipeline, -8 * 24));
  const second = { from: TRIAL.to, to: "2026-10-23T00:00:00.000Z" };
  const report = weeklyReport(input([...baseline, ...set, ...trialSet().map(pipeline => shift(pipeline, 7 * 24))], {
    deliveries: [{ at: at(TRIAL, 1), engineMemory: [{ hash: "h" }] }],
  }), BASE, [TRIAL, second]);
  expect(report.windows.map(window => window.valid)).toEqual([false, true]);
  expect(report.decision).toMatchObject({ outcome: "delegatus", usedWindows: [1], invalidWindows: [{ index: 0, because: ["engine-memory-loaded"] }] });
  expect(Math.abs(report.windows[1].guards.attemptsChange!)).toBeLessThan(0.5);
  expect(report.baseline.lanes).toMatchObject({ counted: 8, reviewed: 7 });
});

function shift(pipeline: MetricsPipeline, hours: number): MetricsPipeline {
  const move = (iso: string | null | undefined) => iso ? new Date(Date.parse(iso) + hours * 3600_000).toISOString() : undefined;
  return { ...pipeline, id: `${pipeline.id}${hours}`, runs: pipeline.runs.map(run => ({ ...run, attempts: run.attempts.map(attempt => ({
    ...attempt, startedAt: move(attempt.startedAt), completedAt: move(attempt.completedAt), sessionId: `${attempt.sessionId}${hours}`,
    ...(attempt.report ? { report: { ...attempt.report, at: move(attempt.report.at) } } : {}),
    ...(attempt.reviewFlowSync ? { reviewFlowSync: { ...attempt.reviewFlowSync, synchronizedAt: move(attempt.reviewFlowSync.synchronizedAt) } } : {}),
  })) })) };
}

test("finding classes follow the keyword table and a lane outside the window is null", () => {
  expect(findingClasses("The restart path has no test")).toEqual(["seam", "tests"]);
  expect(findingClasses("Clipped label in the dark mode frame at 390 px")).toEqual(["rendered"]);
  expect(findingClasses("wording")).toEqual([]);
  expect(laneMetrics(trialSet()[0], BASE)).toBeNull();
});
