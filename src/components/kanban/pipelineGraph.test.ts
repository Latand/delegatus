import { expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";

import { attemptArrivals, edgeFired, graphOrder, graphTopology, layoutGraph, pastAttempts, routeEdge, stageViews } from "./pipelineGraph";

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

test("the topology keeps the pass chain forward, puts the fail edge back to an earlier stage in a return lane, and marks the branching stage", () => {
  const record = pipeline(retryStages, [], null);
  const topology = graphTopology(record);
  expect(topology.edges.map((edge) => edge.id)).toEqual(["implement:pass:review", "review:pass:verify", "verify:pass:merge", "verify:fail:implement"]);
  expect([...topology.back]).toEqual(["verify:fail:implement"]);
  expect(retryStages.map((entry) => topology.layer.get(entry.id))).toEqual([0, 1, 2, 3]);
  expect(retryStages.map((entry) => topology.row.get(entry.id))).toEqual([0, 0, 0, 0]);
  expect([...topology.branching]).toEqual(["verify"]);
  expect(graphOrder(record, topology).map((entry) => entry.id)).toEqual(["implement", "review", "verify", "merge"]);
});

test("left to right when it fits, top to bottom when it does not, and numbered fail labels with a legend when even that is narrow", () => {
  const record = pipeline(retryStages, [], null);
  /* 18·2 + 4·176 + 3·68 + 16 for the return lane. */
  const wide = layoutGraph(record, 960);
  expect(wide.dir).toBe("LR");
  expect(wide.width).toBe(960);
  expect(wide.nodes.get("verify")).toEqual({ x: 18 + 2 * (176 + 68), y: 18, w: 176, h: 76 });
  expect(wide.lanes).toEqual([{ id: "verify:fail:implement", pos: 18 + 76 + 26 }]);
  const back = routeEdge(wide, wide.topology.edges[3]!)!;
  expect(back.label).toEqual([(18 + 2 * 244 + 176 + 18) / 2, 120]);
  expect(back.d.startsWith(`M${18 + 2 * 244 + 176},${18 + 76 * 0.72}`)).toBe(true);

  const narrow = layoutGraph(record, 959);
  expect(narrow.dir).toBe("TB");
  expect(narrow.labelMode).toBe("inline");
  expect(narrow.nodes.get("merge")!.y).toBe(12 + 3 * (76 + 46));

  const tight = layoutGraph(record, 300);
  expect(tight.dir).toBe("TB");
  expect(tight.labelMode).toBe("legend");
  expect(tight.nodes.get("implement")!.w).toBeGreaterThanOrEqual(132);
});

test("a forward fail branch sits on its own row and a pass edge leaving a branching stage starts above the fail edge", () => {
  const record = pipeline([
    stage("build", "builder", "review", { onFail: { to: "diagnose", maxRounds: 1 } }),
    stage("review", "reviewer", null),
    stage("diagnose", "architect", null),
  ], [], null);
  const layout = layoutGraph(record, 2000);
  expect(layout.topology.row.get("diagnose")).toBe(1);
  expect(layout.topology.back.size).toBe(0);
  const [pass, fail] = layout.topology.edges;
  expect(routeEdge(layout, pass!)!.d.startsWith(`M${18 + 176},${18 + 76 * 0.36}`)).toBe(true);
  expect(routeEdge(layout, fail!)!.d.startsWith(`M${18 + 176},${18 + 76 * 0.72}`)).toBe(true);
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
