import { expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import { translate } from "@/lib/i18n";

import { attemptArrivals, attemptOrdinal, edgeFired, graphOrder, graphTopology, layoutGraph, loopShapes, operationalAttempts, pastAttempts, routeEdge, stageViews, unitMembers, wireFired } from "./pipelineGraph";
import { pastAttemptLabel } from "./PipelineSection";

/* The kanban stage graph's pure half (#1695 K5a) over invented pipeline
   records shaped like the store's: stages with `next`/`onFail`, runs of
   attempts with `activatedBy` provenance, and review flows with rounds. */

const role = (roleId: string) => ({ roleId, engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null });
function stage(id: string, roleId: string, next: string | null, over: Record<string, unknown> = {}) {
  return { id, kind: roleId === "reviewer" ? "review-loop" : "run", role: { roleId }, prompt: `Stage ${id}.`, next, onFail: null, effectiveRole: role(roleId), ...over };
}
function attempt(n: number, state: string, startedAt: string, over: Partial<PipelineStageAttempt> = {}): PipelineStageAttempt {
  return {
    n, state, effectiveRole: role("builder"), launchId: null, conversationId: `conversation_${n}_${startedAt}`, sessionId: null, agentPath: `/fixture/${n}-${startedAt}.jsonl`,
    paneId: null, flowId: null, startedAt, completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null, ...over,
  } as PipelineStageAttempt;
}
function pipeline(stages: unknown[], runs: unknown[], cursor: unknown, state = "running"): Pipeline {
  return { id: "p-search", task: "Restore search", taskIds: ["t"], project: "fixture", stages, runs, cursor, state } as unknown as Pipeline;
}

/* Implement → Review → Verify → Merge, Verify failing back to Implement. */
const retryStages = [
  stage("implement", "builder", "review"),
  stage("review", "reviewer", "verify"),
  stage("verify", "verifier", "merge", { onFail: { to: "implement", maxRounds: 2 } }),
  stage("merge", "cleaner", null),
];

test("the topology keeps the pass chain forward, folds the fail edge back to an earlier stage into its source, and draws no return wire", () => {
  const record = pipeline(retryStages, [], null);
  const topology = graphTopology(record);
  expect(topology.edges.map((edge) => edge.id)).toEqual(["implement:pass:review", "review:pass:verify", "verify:pass:merge", "verify:fail:implement"]);
  expect(topology.wires.map((edge) => edge.id)).toEqual(["implement:pass:review", "review:pass:verify", "verify:pass:merge"]);
  expect(topology.shapes.get("verify:fail:implement")).toBe("return");
  expect(topology.loops.get("verify")?.shape).toBe("return");
  expect([...topology.back]).toEqual([]);
  expect(retryStages.map((entry) => topology.layer.get(entry.id))).toEqual([0, 1, 2, 3]);
  expect(retryStages.map((entry) => topology.row.get(entry.id))).toEqual([0, 0, 0, 0]);
  /* Its only second exit is the strip: one out port, no pass label. */
  expect([...topology.branching]).toEqual([]);
  expect(graphOrder(record, topology).map((entry) => entry.id)).toEqual(["implement", "review", "verify", "merge"]);
});

test("a fail edge is a dock, a retry in place, a return or other, classified from the stages alone", () => {
  const record = pipeline([
    stage("build", "builder", "review", { onFail: { to: "build", maxRounds: 2 } }),
    stage("review", "reviewer", "verify", { onFail: { to: "review-fix", maxRounds: 3 } }),
    stage("review-fix", "builder", "review"),
    stage("verify", "verifier", "report", { onFail: { to: "diagnose", maxRounds: 1 } }),
    stage("diagnose", "architect", "archive"),
    stage("report", "cleaner", null),
    stage("archive", "cleaner", null),
  ], [], null);
  expect(Object.fromEntries(loopShapes(record))).toEqual({
    "build:fail:build": "self",
    "review:fail:review-fix": "dock",
    "verify:fail:diagnose": "other",
  });
  /* A fix stage two reviewers share is no dock: it keeps its wires. */
  const shared = pipeline([
    stage("build", "builder", "critique"),
    stage("critique", "reviewer", "review", { onFail: { to: "fix", maxRounds: 1 } }),
    stage("review", "reviewer", null, { onFail: { to: "fix", maxRounds: 1 } }),
    stage("fix", "builder", null),
  ], [], null);
  expect([...loopShapes(shared).values()]).toEqual(["other", "other"]);
});

/* Design → Build → Critique → Review, each reviewer with a fix stage of its own. */
const twoDockStages = [
  stage("design", "architect", "build"),
  stage("build", "builder", "critique"),
  stage("critique", "reviewer", "review", { onFail: { to: "critique-fix", maxRounds: 2 } }),
  stage("critique-fix", "builder", "critique"),
  stage("review", "reviewer", null, { onFail: { to: "review-fix", maxRounds: 3 } }),
  stage("review-fix", "builder", "review"),
];
const failVia = (stageId: string, n: number, budgetSpent = false) => ({ activatedBy: { stageId, attempt: n, edge: "fail" as const, ...(budgetSpent ? { budgetSpent: true as const } : {}) } });
const passVia = (stageId: string, n: number) => ({ activatedBy: { stageId, attempt: n, edge: "pass" as const } });
const at = (minute: number) => new Date(Date.UTC(2026, 8, 14, 10, minute)).toISOString();
/* Both budgets spent: Critique failed twice, Review three times, and each
   last fix handed its findings on (#1868). */
const twoDockRuns = [
  { stageId: "design", attempts: [attempt(1, "passed", at(0))] },
  { stageId: "build", attempts: [attempt(1, "passed", at(2), passVia("design", 1))] },
  { stageId: "critique", attempts: [attempt(1, "failed", at(4), passVia("build", 1)), attempt(2, "failed", at(8), passVia("critique-fix", 1))] },
  { stageId: "critique-fix", attempts: [attempt(1, "passed", at(6), failVia("critique", 1)), attempt(2, "passed", at(10), failVia("critique", 2, true))] },
  { stageId: "review", attempts: [attempt(1, "failed", at(12), passVia("critique-fix", 2)), attempt(2, "failed", at(16), passVia("review-fix", 1)), attempt(3, "failed", at(20), passVia("review-fix", 2))] },
  { stageId: "review-fix", attempts: [attempt(1, "passed", at(14), failVia("review", 1)), attempt(2, "passed", at(18), failVia("review", 2)), attempt(3, "passed", at(22), failVia("review", 3, true))] },
];

test("a fix stage docks under its reviewer and takes no column: one row wide, one column compact, never wider than the card", () => {
  const record = pipeline(twoDockStages, twoDockRuns, null, "completed");
  const topology = graphTopology(record);
  expect([...topology.docked]).toEqual([["critique-fix", "critique"], ["review-fix", "review"]]);
  expect(topology.wires.map((edge) => edge.id)).toEqual(["design:pass:build", "build:pass:critique", "critique:pass:review"]);
  expect(topology.layers).toBe(4);
  expect(topology.rows).toBe(1);
  expect(graphOrder(record, topology).map((entry) => entry.id)).toEqual(["design", "build", "critique", "critique-fix", "review", "review-fix"]);

  const wide = layoutGraph(record, 1400);
  expect(wide.dir).toBe("LR");
  /* 18·2 + 4·176 + 3·68, and one row of 76 + a 28 strip. */
  expect([wide.width, wide.height]).toEqual([944, 140]);
  expect([...wide.nodes.keys()]).toEqual(["design", "build", "critique", "review"]);
  expect(wide.strips.get("review")!.box).toEqual({ x: 18 + 3 * 244, y: 18 + 76, w: 176, h: 28 });
  expect(wide.lanes).toEqual([]);
  /* Every pass wire is one straight segment at the node's mid-height. */
  expect(routeEdge(wide, wide.topology.wires[2]!)!.d).toBe(`M${18 + 2 * 244 + 176},${18 + 38} L${18 + 3 * 244 - 2},${18 + 38}`);
  expect(layoutGraph(record, 1400, undefined, { coarse: true }).strips.get("review")!.box.h).toBe(44);

  for (const available of [300, 340, 390]) {
    const compact = layoutGraph(record, available);
    expect(compact.dir).toBe("TB");
    expect(compact.width).toBeLessThanOrEqual(available);
    expect(new Set([...compact.nodes.values()].map((box) => box.x)).size).toBe(1);
    expect(compact.lanes).toEqual([]);
  }
  /* The node takes the card's width up to 268. */
  expect(layoutGraph(record, 390).nodes.get("design")!.w).toBe(268);
  const compact = layoutGraph(record, 280);
  expect(compact.nodes.get("design")!.w).toBe(280 - 24);
  /* Critique's unit is its node and its strip; the wire leaves the strip. */
  expect(compact.nodes.get("review")!.y).toBe(12 + (76 + 46) * 2 + (76 + 28 + 46));
  expect(routeEdge(compact, compact.topology.wires[2]!)!.d.startsWith(`M${12 + (280 - 24) / 2},${compact.nodes.get("critique")!.y + 76 + 28}`)).toBe(true);
});

test("the wire leaving a unit counts the docked fix's handoff pass, which is how the lane moved on", () => {
  const record = pipeline(twoDockStages, twoDockRuns, null, "completed");
  const topology = graphTopology(record);
  const onward = topology.wires.find((edge) => edge.id === "critique:pass:review")!;
  expect(edgeFired(record, onward)).toBe(0);
  expect(wireFired(record, topology, onward)).toBe(1);
  expect(unitMembers(topology, "critique")).toEqual(["critique", "critique-fix"]);
});

test("a retry in place draws its strip only once it fired; a forward fail branch that is no dock keeps its own row and port", () => {
  const self = [stage("wp", "builder", null, { onFail: { to: "wp", maxRounds: 2 } })];
  expect(layoutGraph(pipeline(self, [], null), 1000).strips.size).toBe(0);
  const fired = pipeline(self, [{ stageId: "wp", attempts: [attempt(1, "failed", at(0)), attempt(2, "running", at(2), failVia("wp", 1))] }], { stageId: "wp", state: "running", input: null, activatedBy: null });
  expect(layoutGraph(fired, 1000).strips.get("wp")?.loop.shape).toBe("self");

  const record = pipeline([
    stage("build", "builder", "review", { onFail: { to: "diagnose", maxRounds: 1 } }),
    stage("review", "reviewer", null),
    stage("diagnose", "architect", "report"),
    stage("report", "cleaner", null),
  ], [], null);
  const layout = layoutGraph(record, 2000);
  expect(layout.topology.shapes.get("build:fail:diagnose")).toBe("other");
  expect(layout.topology.row.get("diagnose")).toBe(1);
  expect(layout.topology.back.size).toBe(0);
  const [pass, fail] = layout.topology.edges;
  expect(routeEdge(layout, pass!)!.d.startsWith(`M${18 + 176},${18 + 76 * 0.36}`)).toBe(true);
  expect(routeEdge(layout, fail!)!.d.startsWith(`M${18 + 176},${18 + 76 * 0.72}`)).toBe(true);
});

test("waits again follows the path ahead of the cursor: an ended lane has none, and a stage behind the cursor keeps its settled state", () => {
  /* Completed with both budgets spent: every node reads what it last was. */
  const completed = stageViews(pipeline(twoDockStages, twoDockRuns, null, "completed"));
  expect([...completed.values()].filter((view) => view.again)).toEqual([]);
  expect(completed.get("critique")!.state).toBe("failed");
  expect(completed.get("review")!.state).toBe("failed");
  expect(completed.get("review-fix")!.state).toBe("passed");

  /* Cut back to Review running its second attempt: Critique is behind it. */
  const cutRuns = twoDockRuns.map((run) => run.stageId === "review"
    ? { ...run, attempts: [run.attempts[0]!, attempt(2, "running", at(16), passVia("review-fix", 1))] }
    : run.stageId === "review-fix" ? { ...run, attempts: [run.attempts[0]!] } : run);
  const cut = stageViews(pipeline(twoDockStages, cutRuns, { stageId: "review", state: "running", input: null, activatedBy: passVia("review-fix", 1).activatedBy }));
  expect(cut.get("critique")).toMatchObject({ state: "failed", again: false });
  expect(cut.get("review")).toMatchObject({ state: "reviewing", again: false, attempts: 2 });

  /* A fix inside its budget runs: its reviewer waits, and says what it last was. */
  const fixingRuns = twoDockRuns.map((run) => run.stageId === "review"
    ? { ...run, attempts: [run.attempts[0]!] }
    : run.stageId === "review-fix" ? { ...run, attempts: [attempt(1, "running", at(14), failVia("review", 1))] } : run);
  const fixing = stageViews(pipeline(twoDockStages, fixingRuns, { stageId: "review-fix", state: "running", input: null, activatedBy: failVia("review", 1).activatedBy }));
  expect(fixing.get("review")).toMatchObject({ state: "pending", again: true, previous: "failed" });
  expect(fixing.get("critique")).toMatchObject({ state: "failed", again: false });

  /* The last handoff of a spent budget follows the reviewer's own pass edge,
     so the reviewer is not ahead. */
  const handoffRuns = twoDockRuns.map((run) => run.stageId === "review-fix"
    ? { ...run, attempts: [...run.attempts.slice(0, 2), attempt(3, "running", at(22), failVia("review", 3, true))] }
    : run);
  expect(stageViews(pipeline(twoDockStages, handoffRuns, { stageId: "review-fix", state: "running", input: null, activatedBy: failVia("review", 3, true).activatedBy })).get("review")).toMatchObject({ state: "failed", again: false });

  /* A lane parked on a decision at Review reads as today. */
  const parked = stageViews(pipeline(twoDockStages, twoDockRuns.map((run) => run.stageId === "review-fix" ? { ...run, attempts: run.attempts.slice(0, 2) } : run), { stageId: "review", state: "pending", input: null, activatedBy: null }, "needs_decision"));
  expect(parked.get("review")).toMatchObject({ state: "failed", again: false });

  /* A busy lane whose cursor moved onto a settled stage: that stage is next. */
  const moved = stageViews(pipeline(twoDockStages, twoDockRuns.map((run) => run.stageId === "review-fix" ? { ...run, attempts: run.attempts.slice(0, 1) } : run.stageId === "review" ? { ...run, attempts: run.attempts.slice(0, 1) } : run), { stageId: "review", state: "pending", input: null, activatedBy: passVia("review-fix", 1).activatedBy }));
  expect(moved.get("review")).toMatchObject({ state: "pending", again: true, previous: "failed" });
});

test("a settled stage whose conversation works again says so; a running one does not (#1744)", () => {
  const record = pipeline(twoDockStages, twoDockRuns, null, "completed");
  const fix = twoDockRuns.find((run) => run.stageId === "review-fix")!.attempts[2]!;
  const views = stageViews(record, new Map(), new Set([fix.agentPath!]));
  expect(views.get("review-fix")).toMatchObject({ state: "passed", rework: true });
  expect([...views.values()].filter((view) => view.rework).length).toBe(1);
  expect(stageViews(record, new Map(), new Set([fix.conversationId!])).get("review-fix")!.rework).toBe(true);

  /* An attempt parked on a decision has ended too: its conversation reworking
     reads as rework, and the stage still says it waits on a decision. */
  const parkedAttempt = attempt(1, "needs_decision", at(0), { completedAt: at(4) });
  const parked = pipeline(retryStages, [{ stageId: "implement", attempts: [parkedAttempt] }], { stageId: "implement", state: "pending", input: null, activatedBy: null }, "needs_decision");
  expect(stageViews(parked, new Map(), new Set([parkedAttempt.agentPath!])).get("implement")).toMatchObject({ state: "needs_decision", again: false, rework: true });
  expect(stageViews(parked).get("implement")).toMatchObject({ state: "needs_decision", rework: false });

  const running = pipeline(retryStages, [{ stageId: "implement", attempts: [attempt(1, "running", at(0))] }], { stageId: "implement", state: "running", input: null, activatedBy: null });
  const live = operationalAttempts(running, "implement")[0]!;
  expect(stageViews(running, new Map(), new Set([live.agentPath!])).get("implement")!.rework).toBe(false);
});

test("an edge's fired count comes from the attempts it activated; a stage an upstream stage ran again after waits for its next attempt", () => {
  const record = pipeline(retryStages, [
    { stageId: "implement", attempts: [attempt(1, "passed", "2026-09-14T10:00:00.000Z"), attempt(2, "running", "2026-09-14T11:00:00.000Z", { activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } })] },
    { stageId: "review", attempts: [attempt(1, "passed", "2026-09-14T10:20:00.000Z")] },
    { stageId: "verify", attempts: [attempt(1, "failed", "2026-09-14T10:40:00.000Z")] },
  ], { stageId: "implement", state: "running", input: null, activatedBy: null });
  expect(edgeFired(record, { from: "verify", to: "implement", kind: "fail" })).toBe(1);
  expect(edgeFired(record, { from: "review", to: "verify", kind: "pass" })).toBe(0);
  /* Implement's second attempt came through Verify's fail edge, not through any other edge into Implement. */
  expect(edgeFired(record, { from: "verify", to: "implement", kind: "pass" })).toBe(0);
  expect(edgeFired(record, { from: "review", to: "implement", kind: "fail" })).toBe(0);
  const views = stageViews(record);
  expect(views.get("implement")).toMatchObject({ state: "running", again: false, attempts: 2 });
  expect(views.get("verify")).toMatchObject({ state: "pending", again: true, previous: "failed", attempts: 1 });
  expect(views.get("review")).toMatchObject({ state: "pending", again: true, previous: "passed" });
  expect(views.get("merge")).toMatchObject({ state: "pending", again: false, attempts: 0 });

  /* Verify's second attempt is live on the cursor: it is running, whatever came before. */
  const resumed = pipeline(retryStages, [
    { stageId: "implement", attempts: [attempt(1, "passed", "2026-09-14T10:00:00.000Z"), attempt(2, "passed", "2026-09-14T11:00:00.000Z")] },
    { stageId: "review", attempts: [attempt(1, "passed", "2026-09-14T11:20:00.000Z")] },
    { stageId: "verify", attempts: [attempt(1, "failed", "2026-09-14T10:40:00.000Z"), attempt(2, "running", "2026-09-14T11:40:00.000Z")] },
  ], { stageId: "verify", state: "running", input: null, activatedBy: null });
  expect(stageViews(resumed).get("verify")).toMatchObject({ state: "running", again: false, attempts: 2 });
});

test("review rounds are the bound flow's rounds; Past attempts list every finished attempt and every settled round, and leave out work under way", () => {
  const firstReview = {
    id: "flow-review-1",
    rounds: [
      { n: 1, verdict: "REQUEST_CHANGES", reviewerPath: "/fixture/r1-1.jsonl", reviewerConversationId: "conversation_r1_1", startedAt: "2026-09-14T10:25:00.000Z" },
      { n: 2, verdict: null, reviewerPath: null, reviewerConversationId: null, startedAt: "2026-09-14T10:35:00.000Z" },
    ],
  } as unknown as Flow;
  const secondReview = {
    id: "flow-review-2",
    rounds: [
      { n: 1, verdict: "APPROVE", reviewerPath: "/fixture/r2-1.jsonl", reviewerConversationId: null, startedAt: "2026-09-14T11:25:00.000Z" },
      { n: 2, verdict: null, reviewerPath: null, reviewerConversationId: null, startedAt: "2026-09-14T11:35:00.000Z" },
    ],
  } as unknown as Flow;
  const record = pipeline(retryStages, [
    { stageId: "implement", attempts: [attempt(1, "failed", "2026-09-14T10:00:00.000Z", { completedAt: "2026-09-14T10:10:00.000Z", verdict: { status: "fail" } }), attempt(2, "passed", "2026-09-14T11:00:00.000Z", { completedAt: "2026-09-14T11:10:00.000Z" })] },
    { stageId: "review", attempts: [attempt(1, "failed", "2026-09-14T10:20:00.000Z", { flowId: "flow-review-1", completedAt: "2026-09-14T10:40:00.000Z" }), attempt(2, "reviewing", "2026-09-14T11:20:00.000Z", { flowId: "flow-review-2" })] },
  ], { stageId: "review", state: "reviewing", input: null, activatedBy: null });
  const flows = new Map([[firstReview.id, firstReview], [secondReview.id, secondReview]]);
  expect(stageViews(record, flows).get("review")!.rounds).toEqual([{ n: 1, verdict: "approved" }, { n: 2, verdict: "open" }]);
  expect(stageViews(record, flows).get("implement")!.rounds).toEqual([]);
  const past = pastAttempts([record], flows);
  expect(past.map((row) => [row.kind, row.stageId, row.attempt, row.n, row.state, row.ambiguous])).toEqual([
    ["round", "review", 2, 1, "APPROVE", true],
    ["attempt", "implement", null, 2, "passed", false],
    ["attempt", "review", null, 1, "failed", false],
    ["round", "review", 1, 2, "open", true],
    ["round", "review", 1, 1, "REQUEST_CHANGES", true],
    ["attempt", "implement", null, 1, "failed", false],
  ]);
  /* The reviewing attempt and its open round are work under way, listed nowhere. */
  expect(past.some((row) => row.kind === "attempt" && row.stageId === "review" && row.n === 2)).toBe(false);
  expect(past.some((row) => row.kind === "round" && row.attempt === 2 && row.n === 2)).toBe(false);
  expect(past.find((row) => row.kind === "round" && row.attempt === 1 && row.n === 1)!.conversation).toEqual({ path: "/fixture/r1-1.jsonl", conversationId: "conversation_r1_1" });
  expect(new Set(past.map((row) => row.key)).size).toBe(past.length);

  /* A stage whose latest attempt failed and waits for nothing: that attempt is history. */
  const parked = pipeline([stage("build", "builder", null)], [{ stageId: "build", attempts: [attempt(1, "failed", "2026-09-14T09:00:00.000Z")] }], null, "needs_decision");
  expect(pastAttempts([parked], new Map()).map((row) => [row.kind, row.n, row.state])).toEqual([["attempt", 1, "failed"]]);
  /* One that asks for a decision is still the stage's current work. */
  const deciding = pipeline([stage("build", "builder", null)], [{ stageId: "build", attempts: [attempt(1, "needs_decision", "2026-09-14T09:00:00.000Z")] }], null, "needs_decision");
  expect(pastAttempts([deciding], new Map())).toEqual([]);
});

/* The engine appends an adopted helper conversation to the stage's run with
   the next `n`, so the stage's own attempts read 1 and 3. Every caption counts
   them 1 and 2, as the graph does; the record's `n` stays the key. */
test("past attempts and rounds are numbered among the stage's own attempts, never by the record's n", () => {
  const review = { id: "flow-review-3", rounds: [{ n: 1, verdict: "APPROVE", reviewerPath: "/fixture/r3-1.jsonl", reviewerConversationId: null, startedAt: "2026-09-14T11:25:00.000Z" }] } as unknown as Flow;
  const first = { id: "flow-review-1", rounds: [{ n: 1, verdict: "REQUEST_CHANGES", reviewerPath: "/fixture/r1-1.jsonl", reviewerConversationId: null, startedAt: "2026-09-14T10:25:00.000Z" }] } as unknown as Flow;
  const record = pipeline(retryStages, [
    { stageId: "implement", attempts: [
      attempt(1, "failed", "2026-09-14T10:00:00.000Z", { completedAt: "2026-09-14T10:10:00.000Z" }),
      attempt(2, "passed", "2026-09-14T10:05:00.000Z", { historical: true, completedAt: "2026-09-14T10:08:00.000Z" }),
      attempt(3, "passed", "2026-09-14T11:00:00.000Z", { completedAt: "2026-09-14T11:10:00.000Z" }),
    ] },
    { stageId: "review", attempts: [
      attempt(1, "failed", "2026-09-14T10:20:00.000Z", { flowId: "flow-review-1", completedAt: "2026-09-14T10:40:00.000Z" }),
      attempt(2, "passed", "2026-09-14T10:30:00.000Z", { historical: true, completedAt: "2026-09-14T10:35:00.000Z" }),
      attempt(3, "passed", "2026-09-14T11:20:00.000Z", { flowId: "flow-review-3", completedAt: "2026-09-14T11:30:00.000Z" }),
    ] },
  ], null, "completed");
  const past = pastAttempts([record], new Map([[first.id, first], [review.id, review]]));
  const row = (kind: string, stageId: string, n: number) => past.find((entry) => entry.kind === kind && entry.stageId === stageId && entry.n === n && (kind !== "round" || entry.attempt === 3))!;
  expect([row("attempt", "implement", 3).ordinal, row("attempt", "implement", 3).of]).toEqual([2, 2]);
  expect(row("round", "review", 1)).toMatchObject({ attempt: 3, ordinal: 2, ambiguous: true });
  expect(past.find((entry) => entry.kind === "helper" && entry.stageId === "implement")!.ordinal).toBeNull();
  expect(attemptOrdinal(record, "implement", 3)).toBe(2);
  expect(attemptOrdinal(record, "implement", 1)).toBe(1);
  expect(attemptOrdinal(record, "verify", 4)).toBe(4);
  for (const lang of ["en", "uk"] as const) {
    const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(lang, key, params);
    expect(pastAttemptLabel(t, row("attempt", "implement", 3), "Implement")).toBe(t("kanban.stageAttempt", { stage: "Implement", n: 2 }));
    expect(pastAttemptLabel(t, row("round", "review", 1), "Review")).toBe(t("kanban.past.attemptRound", { stage: "Review", attempt: 2, n: 1 }));
  }
});

test("retries of a fail edge's target spend no round: the card's counter reads the traversals (#1754)", () => {
  /* Implement's first round spawn failed and was retried twice; all three
     attempts carry the one Verify failure that activated them. */
  const activation = { stageId: "verify", attempt: 1, edge: "fail" as const };
  const record = pipeline(retryStages, [
    { stageId: "implement", attempts: [
      attempt(1, "passed", "2026-09-14T10:00:00.000Z"),
      attempt(2, "failed", "2026-09-14T11:00:00.000Z", { activatedBy: activation }),
      attempt(3, "failed", "2026-09-14T11:10:00.000Z", { activatedBy: activation }),
      attempt(4, "running", "2026-09-14T11:20:00.000Z", { activatedBy: activation }),
    ] },
    { stageId: "review", attempts: [attempt(1, "passed", "2026-09-14T10:20:00.000Z")] },
    { stageId: "verify", attempts: [attempt(1, "failed", "2026-09-14T10:40:00.000Z")] },
  ], { stageId: "implement", state: "running", input: null, activatedBy: null });
  expect(edgeFired(record, { from: "verify", to: "implement", kind: "fail" })).toBe(1);

  /* A second Verify failure is the second traversal, whatever the retries did. */
  const second = pipeline(retryStages, [
    { stageId: "implement", attempts: [
      attempt(1, "passed", "2026-09-14T10:00:00.000Z"),
      attempt(2, "passed", "2026-09-14T11:00:00.000Z", { activatedBy: activation }),
      attempt(3, "running", "2026-09-14T12:00:00.000Z", { activatedBy: { stageId: "verify", attempt: 2, edge: "fail" as const } }),
    ] },
    { stageId: "review", attempts: [attempt(1, "passed", "2026-09-14T10:20:00.000Z")] },
    { stageId: "verify", attempts: [attempt(1, "failed", "2026-09-14T10:40:00.000Z"), attempt(2, "failed", "2026-09-14T11:40:00.000Z")] },
  ], { stageId: "implement", state: "running", input: null, activatedBy: null });
  expect(edgeFired(second, { from: "verify", to: "implement", kind: "fail" })).toBe(2);
});

test("a lineage-adopted helper attempt is evidence: it spends no retry, is not the latest or counted attempt, marks no edge, and is listed as a helper conversation", () => {
  const helper = attempt(3, "passed", "2026-09-14T11:30:00.000Z", {
    historical: true,
    conversationId: "conversation_helper",
    agentPath: "/fixture/helper.jsonl",
    /* The engine copies the source attempt's provenance onto the adopted record. */
    activatedBy: { stageId: "verify", attempt: 1, edge: "fail" },
  });
  const record = pipeline(retryStages, [
    { stageId: "implement", attempts: [attempt(1, "passed", "2026-09-14T10:00:00.000Z"), attempt(2, "running", "2026-09-14T11:00:00.000Z", { activatedBy: { stageId: "verify", attempt: 1, edge: "fail" } }), helper] },
    { stageId: "review", attempts: [attempt(1, "passed", "2026-09-14T10:20:00.000Z")] },
    { stageId: "verify", attempts: [attempt(1, "failed", "2026-09-14T10:40:00.000Z")] },
  ], { stageId: "implement", state: "running", input: null, activatedBy: null });
  /* The engine's own budget (stageFailEdgeRoundsUsed) is 1: one retry left of 2. */
  expect(edgeFired(record, { from: "verify", to: "implement", kind: "fail" })).toBe(1);
  const view = stageViews(record).get("implement")!;
  expect(view.attempts).toBe(2);
  expect(view.attempt?.n).toBe(2);
  expect(view.state).toBe("running");
  expect(attemptArrivals(record).map((arrival) => arrival.key)).toEqual(["implement#1", "implement#2", "review#1", "verify#1"]);
  const past = pastAttempts([record], new Map());
  expect(past.filter((row) => row.stageId === "implement").map((row) => [row.kind, row.n])).toEqual([["helper", 1], ["attempt", 1]]);
  expect(past.find((row) => row.kind === "helper")!.conversation).toEqual({ path: "/fixture/helper.jsonl", conversationId: "conversation_helper" });
});
