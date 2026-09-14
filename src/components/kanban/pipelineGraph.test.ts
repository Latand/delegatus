import { expect, test } from "bun:test";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";

import { edgeFired, graphOrder, graphTopology, layoutGraph, pastAttempts, routeEdge, stageViews } from "./pipelineGraph";

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

test("review rounds are the bound flow's rounds; Past attempts are the superseded attempts and earlier rounds, newest first, with their conversations", () => {
  const flow = {
    id: "flow-review",
    rounds: [
      { n: 1, verdict: "REQUEST_CHANGES", reviewerPath: "/fixture/round-1.jsonl", reviewerConversationId: "conversation_round_1", startedAt: "2026-09-14T10:25:00.000Z" },
      { n: 2, verdict: "APPROVE", reviewerPath: "/fixture/round-2.jsonl", reviewerConversationId: null, startedAt: "2026-09-14T10:50:00.000Z" },
      { n: 3, verdict: null, reviewerPath: null, reviewerConversationId: null, startedAt: "2026-09-14T11:10:00.000Z" },
    ],
  } as unknown as Flow;
  const record = pipeline(retryStages, [
    { stageId: "implement", attempts: [attempt(1, "failed", "2026-09-14T10:00:00.000Z", { completedAt: "2026-09-14T10:10:00.000Z", verdict: { status: "fail" } }), attempt(2, "passed", "2026-09-14T11:00:00.000Z")] },
    { stageId: "review", attempts: [attempt(1, "reviewing", "2026-09-14T10:20:00.000Z", { flowId: "flow-review" })] },
  ], { stageId: "review", state: "reviewing", input: null, activatedBy: null });
  const flows = new Map([[flow.id, flow]]);
  expect(stageViews(record, flows).get("review")!.rounds).toEqual([{ n: 1, verdict: "changes" }, { n: 2, verdict: "approved" }, { n: 3, verdict: "open" }]);
  expect(stageViews(record, flows).get("implement")!.rounds).toEqual([]);
  const past = pastAttempts([record], flows);
  expect(past.map((row) => [row.kind, row.stageId, row.n, row.state, row.verdict])).toEqual([
    ["round", "review", 2, "APPROVE", null],
    ["round", "review", 1, "REQUEST_CHANGES", null],
    ["attempt", "implement", 1, "failed", "fail"],
  ]);
  expect(past[1]!.conversation).toEqual({ path: "/fixture/round-1.jsonl", conversationId: "conversation_round_1" });
  expect(past[2]!.conversation.path).toBe("/fixture/1-2026-09-14T10:00:00.000Z.jsonl");
  /* The latest attempt of every stage and the latest round are the graph's, never history. */
  expect(past.some((row) => row.kind === "attempt" && row.stageId === "implement" && row.n === 2)).toBe(false);
  expect(past.some((row) => row.kind === "round" && row.n === 3)).toBe(false);
});
