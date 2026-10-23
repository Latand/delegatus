import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipelineRoleLookup } from "@/lib/pipelines/roles";
import {
  decide, findingClasses, laneMetrics, proportionDifference, reviewVerdict, weeklyReport, wilson, windowReport,
  type Decision, type DecisionSample, type MetricsAttempt, type MetricsInput, type MetricsPipeline,
} from "./weeklyMetrics";

/* Slice 6 of docs/design/memory-source-switch.md: a synthetic pipeline set
   per case. All times are fixed; nothing reads a clock. The departure cases
   drive the production role-memory writers on a private state directory. */
const previousStateDir = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-weekly-metrics-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
afterAll(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});
const { roleMemoryCollection, restoreRule, deleteRule } = await import("./roleStore");
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
// A ledger whose oldest kept start precedes every fixture window.
const LEDGER = [{ at: "2026-09-01T00:00:00.000Z", engineMemory: [] }];
const input = (pipelines: MetricsPipeline[], extra: Partial<MetricsInput> = {}): MetricsInput => ({ pipelines, memory: [], imports: [], deliveries: LEDGER, ...extra });
/** A read time after every fixture window's review grace. */
const LATE = "2026-11-01T00:00:00.000Z";

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
  const left = (changedAt: string, reason: string, curated: boolean) => ({ state: "archived", reason, changedAt, departures: [{ at: changedAt, reason, curated }] });
  const memory = [
    rule("r1", left(at(TRIAL, 2), "budget", false)),
    rule("r2", { ...left(at(TRIAL, 3), "budget", true), curatedAt: at(TRIAL, 1) }),
    rule("r3", { ...left(at(TRIAL, 3), "budget", true), versionOf: "r2" }),
    rule("r4", left(at(BASE, 3), "budget", false)),
    rule("r5", { source: { origin: "seat" }, createdAt: at(TRIAL, 4) }),
    rule("r6", { source: { origin: "operator" }, createdAt: at(TRIAL, 4) }),
    rule("r7", { source: { origin: "import" }, ...left(at(TRIAL, 5), "stale", true) }),
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
  expect(windowReport(input(pipelines, { deliveries: [...LEDGER, { at: at(TRIAL, 1), engineMemory: [{ hash: "h" }] }, { at: at(TRIAL, 2), engineMemory: [] }] }), TRIAL).invalidBecause).toEqual(["engine-memory-loaded"]);
  expect(windowReport(input(pipelines, { deliveries: [...LEDGER, { at: at(BASE, 1), engineMemory: [{ hash: "h" }] }] }), TRIAL).valid).toBe(true);
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
    deliveries: [...LEDGER, { at: at(TRIAL, 1), engineMemory: [{ hash: "h" }] }],
  }), BASE, [TRIAL, second], LATE);
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

/* The baseline and one trial week whose lanes fail far more often: decisive once mature. */
function decisiveSet(): MetricsPipeline[] {
  const failing = (prefix: string, window: { from: string }, failed: number) => Array.from({ length: 12 }, (_, i) =>
    lane(`${prefix}-${i}`, [builder(1, at(window, 2 + i))], [reviewer(1, at(window, 4 + i), { verdict: { status: i < failed ? "fail" : "pass" } })]));
  return [...failing("base", BASE, 1), ...failing("trial", TRIAL, 2)];
}

test("§6.1: a review, finding or fix round after the 24-hour grace never changes a closed window", () => {
  const pipelines = trialSet();
  const before = weeklyReport(input(pipelines), BASE, [TRIAL], LATE);
  const late = (hours: number) => at(TRIAL, 168 + hours);
  // inside-grace passed its first review at +23 h; within-grace already has its rounds.
  pipelines[2].runs[0].attempts.push(builder(2, late(30), { activatedBy: { edge: "fail" } }));
  pipelines[2].runs[1].attempts.push(reviewer(2, late(29), { verdict: { status: "fail", findings: ["P1 — the restart test is missing"] } }));
  pipelines[0].runs[0].attempts.push(builder(3, late(26), { activatedBy: { edge: "fail" } }));
  pipelines[0].runs[1].attempts.push(reviewer(4, late(25), { verdict: { status: "fail", findings: ["P2 — the retry test is flaky"] } }));
  const after = weeklyReport(input(pipelines), BASE, [TRIAL], LATE);
  expect(after).toEqual(before);
  expect(after.windows[0].fixRounds.perLane.reduce((a, b) => a + b, 0)).toBe(1);
  expect(after.windows[0].repeatedClasses).toMatchObject({ repeated: 1, later: 2 });
  // The same attempts inside the grace do count.
  const inGrace = trialSet();
  inGrace[2].runs[0].attempts.push(builder(2, late(20), { activatedBy: { edge: "fail" } }));
  inGrace[2].runs[1].attempts.push(reviewer(2, late(23.5), { verdict: { status: "fail", findings: ["P1 — the restart test is missing"] } }));
  const counted = windowReport(input(inGrace), TRIAL);
  expect(counted.fixRounds.perLane.reduce((a, b) => a + b, 0)).toBe(2);
  expect(counted.repeatedClasses.later).toBe(3);
});

test("§6.1: no decision before a window's review grace ends, and in-grace reviews enter the mature result", () => {
  const pipelines = trialSet();
  for (const now of [TRIAL.to, at(TRIAL, 168 + 23)]) {
    const early = weeklyReport(input(pipelines), BASE, [TRIAL], now);
    expect(early.windows[0].provisional).toBe(true);
    expect(early.decision).toMatchObject({ outcome: "pending", usedWindows: [], heldWindows: [{ index: 0, because: [`reviews-until-${at(TRIAL, 192)}`] }] });
  }
  const mature = weeklyReport(input(pipelines), BASE, [TRIAL], at(TRIAL, 192));
  expect(mature.windows[0]).toMatchObject({ provisional: false, observedUntil: at(TRIAL, 192), lanes: { reviewed: 7 } });
  expect(mature.decision.heldWindows).toEqual([]);
  // A decisive week is held as long as it is provisional, explicit windows included.
  const decisive = decisiveSet();
  expect(weeklyReport(input(decisive), BASE, [TRIAL], at(TRIAL, 191)).decision.outcome).toBe("pending");
  expect(weeklyReport(input(decisive), BASE, [TRIAL], at(TRIAL, 192)).decision.outcome).toBe("delegatus");
  // A baseline still in its own grace decides nothing either.
  expect(weeklyReport(input(decisive), BASE, [TRIAL], at(BASE, 168 + 1)).decision).toMatchObject({ outcome: "pending", reason: expect.stringContaining("baseline") });
  // A later provisional week holds an extension, never a mature decision before it.
  const second = { from: TRIAL.to, to: "2026-10-23T00:00:00.000Z" };
  const report = weeklyReport(input(decisive), BASE, [TRIAL, second], at(TRIAL, 200));
  expect(report.windows.map(window => window.provisional)).toEqual([false, true]);
  expect(report.decision).toMatchObject({ outcome: "delegatus", usedWindows: [0], heldWindows: [{ index: 1 }] });
  expect(() => weeklyReport(input(decisive), BASE, [TRIAL], "not a time")).toThrow();
});

test("§6.5: a missing or incomplete delivery ledger is unverified, never a clean week", () => {
  const decisive = decisiveSet();
  for (const unavailable of ["missing-file", "missing-table"] as const) {
    const report = weeklyReport(input(decisive, { deliveries: { unavailable } }), BASE, [TRIAL], LATE);
    expect(report.windows[0]).toMatchObject({ valid: false, invalidBecause: [], unverified: [`delivery-ledger-${unavailable}`], guards: { engineMemoryStarts: null } });
    expect(report.decision).toMatchObject({ outcome: "pending", usedWindows: [], heldWindows: [{ index: 0, because: [`delivery-ledger-${unavailable}`] }] });
  }
  // A ledger whose oldest kept start is after the window's first start cannot vouch for that start.
  const pruned = weeklyReport(input(decisive, { deliveries: [{ at: at(TRIAL, 3), engineMemory: [] }] }), BASE, [TRIAL], LATE);
  expect(pruned.windows[0].unverified).toEqual(["delivery-ledger-incomplete"]);
  expect(pruned.decision.outcome).toBe("pending");
  expect(weeklyReport(input(decisive, { deliveries: [] }), BASE, [TRIAL], LATE).decision.outcome).toBe("pending");
  // A verified empty ledger reaching back over the week decides.
  const verified = weeklyReport(input(decisive), BASE, [TRIAL], LATE);
  expect(verified.windows[0]).toMatchObject({ valid: true, unverified: [], guards: { engineMemoryStarts: 0 } });
  expect(verified.decision.outcome).toBe("delegatus");
});

test("§6.5: builder domains are separate launch variants, and an edit within one variant invalidates the week", () => {
  const scaffold = (params: Record<string, string>) => pipelineRoleLookup("builder", params)!.promptScaffold!;
  expect(scaffold({ domain: "frontend" })).not.toBe(scaffold({ domain: "general" }));
  const domainLane = (id: string, start: string, domain: string, text = scaffold({ domain })) => ({
    ...lane(id, [builder(1, start, { effectiveRole: { roleId: "builder", engine: "codex", model: "m1", promptScaffold: text } })], [reviewer(1, new Date(Date.parse(start) + 2 * 3600_000).toISOString(), { verdict: { status: "pass" } })]),
    stages: [{ id: "build", kind: "run", role: { roleId: "builder", params: { domain } } }, { id: "review", kind: "run", onFail: { to: "build", maxRounds: 2 } }],
  });
  const mixed = [domainLane("front", at(TRIAL, 1), "frontend"), domainLane("back", at(TRIAL, 2), "general"), domainLane("front-2", at(TRIAL, 3), "frontend")];
  const stable = windowReport(input(mixed), TRIAL);
  expect(stable).toMatchObject({ valid: true, invalidBecause: [], guards: { scaffolds: { builder: { variants: 2, changed: 0 } } } });
  // The frontend scaffold edited mid-week.
  const edited = windowReport(input([...mixed, domainLane("front-3", at(TRIAL, 90), "frontend", `${scaffold({ domain: "frontend" })}\nAn added rule.`)]), TRIAL);
  expect(edited).toMatchObject({ valid: false, invalidBecause: ["held-still-changed"], guards: { scaffolds: { builder: { variants: 2, changed: 1 } } } });
  // The same lanes in another project are a variant of their own.
  const elsewhere = { ...domainLane("front-b", at(TRIAL, 4), "frontend", "another project's scaffold"), project: "B" };
  expect(windowReport(input([...mixed, elsewhere]), TRIAL).valid).toBe(true);
});

const longRule = (id: string, length: number) => `${id} keeps a long rule body. `.padEnd(length, "x");
const seeded = (id: string, extra: Record<string, unknown>) => ({
  kind: "rule", id, scope: "role:A:builder", rule: longRule(id, 120), why: "A seeded rule for the weekly report.", hints: [], state: "active",
  source: { origin: "stage", project: "A", pipelineId: "seed", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "seed" },
  createdAt: at(BASE, 1), changedAt: at(BASE, 1), ...extra,
});
const evidence = (report: ReturnType<typeof windowReport>) => ({ evictions: report.evictions, imports: report.imports, guards: report.guards, valid: report.valid, invalidBecause: report.invalidBecause, unverified: report.unverified });

test("§6.5: restoring, re-archiving or evicting a rule after a closed week leaves its evictions and verdict unchanged", () => {
  const curatedAt = at(BASE, 2);
  const budget = { state: "archived", reason: "budget", changedAt: at(TRIAL, 3), departures: [{ at: at(TRIAL, 3), reason: "budget", curated: false }] };
  roleMemoryCollection(true)!.boundedPatch(16, tx => {
    tx.put(seeded("r_00000000000000c1", { rule: longRule("r_00000000000000c1", 6000), curatedAt }) as never);
    tx.put(seeded("r_00000000000000c2", { rule: longRule("r_00000000000000c2", 3900), curatedAt }) as never);
    tx.put(seeded("r_00000000000000c3", { state: "archived", reason: "stale", changedAt: at(BASE, 3), curatedAt, departures: [{ at: at(BASE, 3), reason: "stale", curated: true }] }) as never);
    // A never-curated budget archive inside the week, as an older build could leave it.
    tx.put(seeded("r_00000000000000c4", budget) as never);
    // An adopted import archived by the curator inside the week.
    tx.put(seeded("r_00000000000000c5", { source: { origin: "import", project: "A", roleId: "builder", fixRound: false, candidate: "c", occurrences: [], engine: "claude", sha256: "0".repeat(64), importId: "i" },
      state: "archived", reason: "stale", changedAt: at(TRIAL, 4), curatedAt, departures: [{ at: at(TRIAL, 4), reason: "stale", curated: true }] }) as never);
    tx.put({ kind: "scope", scope: "role:A:builder", revision: 1, active: ["r_00000000000000c1", "r_00000000000000c2"], history: [] } as never);
  });
  // Inside the week the operator returns c3, and the full scope evicts the curated c1 for budget.
  restoreRule("r_00000000000000c3", at(TRIAL, 2));
  const memory = () => roleMemoryCollection()!.snapshot() as unknown as Record<string, unknown>[];
  const read = () => windowReport(input(trialSet(), { memory: memory() }), TRIAL);
  const before = read();
  expect(before.evictions).toEqual({ neverCurated: 1, curated: 1 });
  expect(before.imports.adoptedArchived).toBe(1);
  expect(before).toMatchObject({ valid: false, invalidBecause: ["never-curated-eviction"], unverified: [] });
  // After the week: every archived rule comes back, one is removed again, and a restore evicts another.
  for (const id of ["r_00000000000000c4", "r_00000000000000c5", "r_00000000000000c1"]) restoreRule(id, at(TRIAL, 200));
  deleteRule("r_00000000000000c5", at(TRIAL, 201));
  restoreRule("r_00000000000000c5", at(TRIAL, 202));
  expect(memory().find(row => row.id === "r_00000000000000c4")).toMatchObject({ state: "active" });
  expect(evidence(read())).toEqual(evidence(before));
  const decisive = decisiveSet();
  expect(weeklyReport(input(decisive, { memory: memory() }), BASE, [TRIAL], LATE).decision.outcome).toBe("pending");
});

test("§6.5: an archive the departure log cannot account for makes the week unverified, never clean", () => {
  const legacy = [{ kind: "rule", id: "r_00000000000000d1", scope: "role:A:builder", state: "archived", reason: "budget", source: { origin: "stage" }, createdAt: at(BASE, 1), changedAt: at(TRIAL, 2) }];
  const report = weeklyReport(input(decisiveSet(), { memory: legacy }), BASE, [TRIAL], LATE);
  expect(report.windows[0]).toMatchObject({ valid: false, invalidBecause: [], unverified: ["departure-log-incomplete"] });
  expect(report.decision).toMatchObject({ outcome: "pending", heldWindows: [{ index: 0, because: ["departure-log-incomplete"] }] });
  // A scope history entry naming an archive the rule's log does not hold, e.g. a rule since restored.
  const history = [{ kind: "rule", id: "r_00000000000000d2", scope: "role:A:builder", state: "active", source: { origin: "stage" }, createdAt: at(BASE, 1), changedAt: at(TRIAL, 90) },
    { kind: "scope", scope: "role:A:builder", active: ["r_00000000000000d2"], history: [{ revision: 2, at: at(TRIAL, 2), by: "agent", added: [], merged: [], archived: ["r_00000000000000d2"] }] }];
  expect(windowReport(input(decisiveSet(), { memory: history }), TRIAL).unverified).toEqual(["departure-log-incomplete"]);
  // History that no longer reaches back over the week cannot vouch for it.
  const pruned = [{ kind: "scope", scope: "role:A:builder", active: [], history: Array.from({ length: 10_000 }, (_, i) => ({ revision: i + 1, at: at(TRIAL, 100), by: "agent", added: [], merged: [], archived: [] })) }];
  expect(windowReport(input(decisiveSet(), { memory: pruned }), TRIAL).unverified).toEqual(["departure-log-incomplete"]);
  expect(windowReport(input(decisiveSet(), { memory: [{ ...pruned[0], history: pruned[0].history.slice(1) }] }), TRIAL).unverified).toEqual([]);
});

const presetLane = (id: string, start: string, runtime: { engine: string; model: string; effort?: string }, stage: Record<string, unknown> = {}) => ({
  ...lane(id, [builder(1, start, { effectiveRole: { roleId: "builder", ...runtime, promptScaffold: "builder scaffold" } })], [reviewer(1, new Date(Date.parse(start) + 2 * 3600_000).toISOString(), { verdict: { status: "pass" } })]),
  stages: [{ id: "build", kind: "run", role: { roleId: "builder", params: {} }, ...stage }, { id: "review", kind: "run", onFail: { to: "build", maxRounds: 2 } }],
});

test("§6.5: a builder or reviewer preset changed inside the week invalidates it and keeps it out of the decision", () => {
  const early = Array.from({ length: 6 }, (_, i) => presetLane(`early-${i}`, at(TRIAL, 1 + i), { engine: "codex", model: "m1" }));
  const later = Array.from({ length: 6 }, (_, i) => presetLane(`later-${i}`, at(TRIAL, 100 + i), { engine: "claude", model: "m3" }));
  const changed = windowReport(input([...early, ...later]), TRIAL);
  expect(changed).toMatchObject({ valid: false, invalidBecause: ["preset-changed"], guards: { presets: { builder: { variants: 1, changed: 1 }, reviewer: { variants: 1, changed: 0 } } } });
  // An effort change is a preset change too.
  const effort = windowReport(input([...early, presetLane("effort", at(TRIAL, 120), { engine: "codex", model: "m1", effort: "high" })]), TRIAL);
  expect(effort.invalidBecause).toEqual(["preset-changed"]);
  // The reviewer's preset is held still the same way.
  const reviewers = early.map((pipeline, i) => i < 3 ? pipeline : { ...pipeline, runs: [pipeline.runs[0], { stageId: "review", attempts: [reviewer(1, at(TRIAL, 10 + i), { verdict: { status: "pass" }, effectiveRole: { roleId: "reviewer", engine: "claude", model: "m4", promptScaffold: "reviewer scaffold" } })] }] });
  expect(windowReport(input(reviewers), TRIAL).guards.presets.reviewer).toEqual({ variants: 1, changed: 1 });
  const decided = weeklyReport(input([...decisiveSet(), ...early.map(pipeline => ({ ...pipeline, id: `d-${pipeline.id}` })), ...later]), BASE, [TRIAL], LATE);
  expect(decided.decision).toMatchObject({ outcome: "pending", usedWindows: [] });
  expect(decided.decision.invalidWindows.map(window => window.because.includes("preset-changed"))).toEqual([true]);
});

test("§6.5: stable distinct presets per variant stay valid", () => {
  const frontend = (id: string, start: string) => ({ ...presetLane(id, start, { engine: "claude", model: "m3" }), stages: [{ id: "build", kind: "run", role: { roleId: "builder", params: { domain: "frontend" } } }, { id: "review", kind: "run", onFail: { to: "build", maxRounds: 2 } }] });
  const general = (id: string, start: string) => presetLane(id, start, { engine: "codex", model: "m1" });
  // A stage that chose its own runtime over the preset is a variant of its own.
  const pinned = (id: string, start: string) => presetLane(id, start, { engine: "claude", model: "m5" }, { engine: "claude", model: "m5" });
  const report = windowReport(input([frontend("f1", at(TRIAL, 1)), general("g1", at(TRIAL, 2)), pinned("p1", at(TRIAL, 3)), frontend("f2", at(TRIAL, 100)), general("g2", at(TRIAL, 101)), pinned("p2", at(TRIAL, 102))]), TRIAL);
  expect(report).toMatchObject({ valid: true, invalidBecause: [], guards: { presets: { builder: { variants: 3, changed: 0 } } } });
});

test("§6.5: omitted, blank and explicit default parameters are one variant, so an edit between them is caught", () => {
  expect(pipelineRoleLookup("builder", {})!.promptScaffold).toBe(pipelineRoleLookup("builder", { domain: "general" })!.promptScaffold);
  const scaffold = pipelineRoleLookup("builder", {})!.promptScaffold!;
  const withParams = (id: string, start: string, params: Record<string, string> | undefined, text = scaffold) => ({
    ...lane(id, [builder(1, start, { effectiveRole: { roleId: "builder", engine: "codex", model: "m1", promptScaffold: text } })], [reviewer(1, new Date(Date.parse(start) + 2 * 3600_000).toISOString(), { verdict: { status: "pass" } })]),
    stages: [{ id: "build", kind: "run", role: { roleId: "builder", ...(params ? { params } : {}) } }, { id: "review", kind: "run", onFail: { to: "build", maxRounds: 2 } }],
  });
  const spellings = [withParams("omitted", at(TRIAL, 1), {}), withParams("absent", at(TRIAL, 2), undefined), withParams("blank", at(TRIAL, 3), { domain: "" }), withParams("explicit", at(TRIAL, 4), { domain: "general" })];
  expect(windowReport(input(spellings), TRIAL)).toMatchObject({ valid: true, guards: { scaffolds: { builder: { variants: 1, changed: 0 } } } });
  const edited = windowReport(input([withParams("omitted", at(TRIAL, 1), {}), withParams("explicit", at(TRIAL, 100), { domain: "general" }, `${scaffold}\nAn added rule.`)]), TRIAL);
  expect(edited).toMatchObject({ valid: false, invalidBecause: ["held-still-changed"], guards: { scaffolds: { builder: { variants: 1, changed: 1 } } } });
  // A genuinely different domain or mode stays its own variant.
  const modes = [withParams("general", at(TRIAL, 1), {}), withParams("frontend", at(TRIAL, 2), { domain: "frontend" }, pipelineRoleLookup("builder", { domain: "frontend" })!.promptScaffold!),
    withParams("fix", at(TRIAL, 3), { mode: "apply-fixes" }, pipelineRoleLookup("builder", { mode: "apply-fixes" })!.promptScaffold!)];
  expect(windowReport(input(modes), TRIAL)).toMatchObject({ valid: true, guards: { scaffolds: { builder: { variants: 3, changed: 0 } } } });
});
