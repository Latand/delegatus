import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import type { Pipeline, PipelineStage, PipelineStageAttempt } from "./types";
import {
  applyLegacyReviewConversion,
  isLegacyReviewLoopStage,
  LEGACY_REVIEW_FLOW_ROUND_LIMIT,
  previewLegacyReviewConversion,
  RECOMMENDED_REVIEW_LIMIT,
  revertLegacyReviewConversion,
  reviewerActivationsForLimit,
  type LegacyReviewPreview,
} from "./legacyReviewDefinition";

/* Synthetic fixtures only: the stored shapes, never stored content. */
const role = (roleId: string | null, access: "read-only" | "read-write") => ({
  roleId, engine: "codex", model: "model-a", effort: "high", access, promptScaffold: roleId ? `${roleId} guidance` : null,
}) as PipelineStage["effectiveRole"];

function run(id: string, next: string | null, roleId = "builder", access: "read-only" | "read-write" = "read-write", over: Record<string, unknown> = {}): PipelineStage {
  return { id, kind: "run", role: { roleId }, "prompt": `${id} {{task}}`, next, onFail: null, effectiveRole: role(roleId, access), ...over } as PipelineStage;
}

function review(id: string, next: string | null, over: Record<string, unknown> = {}): PipelineStage {
  return { id, kind: "review-loop", role: { roleId: "reviewer" }, "prompt": `Review ${id}`, next, onFail: null, effectiveRole: role("reviewer", "read-only"), ...over } as PipelineStage;
}

function attempt(n: number, over: Partial<PipelineStageAttempt> = {}): PipelineStageAttempt {
  return {
    n, state: "passed", effectiveRole: role("reviewer", "read-only"), launchId: null, conversationId: `conversation-${n}`, sessionId: null,
    agentPath: null, paneId: null, flowId: `flow-${n}`, startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T01:00:00.000Z",
    input: null, activatedBy: null, output: "Approved.", verdict: { status: "pass" }, error: null, ...over,
  } as PipelineStageAttempt;
}

function definition(stages: PipelineStage[], attempts: Record<string, PipelineStageAttempt[]> = {}, over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p1", task: "Ship it", taskIds: [], project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "", baseRef: "", lastPassedCommit: "",
    stages, runs: stages.map((stage) => ({ stageId: stage.id, attempts: attempts[stage.id] ?? [] })),
    cursor: stages.length ? { stageId: stages[0]!.id, state: "pending", input: null, activatedBy: null } : null,
    state: "draft", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: "t", closedAt: null, ...over,
  } as Pipeline;
}

/** The archived draft shape: architect → builder → review-loop reviewer. */
const FIVE_DRAFT = () => definition([run("architect", "builder", "architect", "read-only"), run("builder", "reviewer"), review("reviewer", null)]);

function ok(preview: LegacyReviewPreview) {
  if (!preview.ok) throw new Error(`refused: ${preview.refusals.map((refusal) => refusal.code).join(", ")}`);
  return preview;
}

function refused(preview: LegacyReviewPreview) {
  if (preview.ok) throw new Error("expected a refusal");
  return preview;
}

describe("legacy decode type", () => {
  test("names the retired discriminant without touching the stage", () => {
    const stage = review("reviewer", null);
    const before = JSON.stringify(stage);
    expect(isLegacyReviewLoopStage(stage)).toBe(true);
    expect(isLegacyReviewLoopStage(run("builder", null))).toBe(false);
    expect(JSON.stringify(stage)).toBe(before);
  });
});

describe("preview", () => {
  test("the archived five-draft shape converts into a reviewer run and one dedicated fixer", () => {
    const pipeline = FIVE_DRAFT();
    (pipeline.stages[2] as Record<string, unknown>).legacyNote = "unknown field";
    const before = JSON.stringify(pipeline);
    const preview = ok(previewLegacyReviewConversion(pipeline, {}));
    /* Pure: the input record is untouched. */
    expect(JSON.stringify(pipeline)).toBe(before);
    expect(preview).toMatchObject({
      stageId: "reviewer", implementerStageId: "builder", fixerStageId: "reviewer-fix",
      reviewLimit: LEGACY_REVIEW_FLOW_ROUND_LIMIT, reviewLimitSource: "default", reviewerActivations: 5, legacyAttempts: 0,
    });
    expect(preview.stages.map((stage) => stage.id)).toEqual(["architect", "builder", "reviewer", "reviewer-fix"]);
    const [architect, builder, reviewer, fixer] = preview.stages;
    /* The reviewer keeps its id, prompt, role snapshot, pass successor and unknown fields. */
    expect(reviewer).toMatchObject({
      id: "reviewer", kind: "run", "prompt": "Review reviewer", next: null, role: { roleId: "reviewer" },
      effectiveRole: role("reviewer", "read-only"), onFail: { to: "reviewer-fix", maxRounds: 5, onExhausted: "advance" }, legacyNote: "unknown field",
    });
    /* The fixer carries the implementer's role snapshot and the findings input, then hands back to the reviewer. */
    expect(fixer).toMatchObject({ id: "reviewer-fix", kind: "run", role: { roleId: "builder" }, effectiveRole: role("builder", "read-write"), next: "reviewer", onFail: null });
    expect(fixer!.prompt).toContain("{{prev.output}}");
    expect(fixer!.prompt).toContain("{{task}}");
    /* The predecessors are unchanged; the architect is never the fix stage. */
    expect(architect).toEqual(pipeline.stages[0]!);
    expect(builder).toEqual(pipeline.stages[1]!);
    expect(preview.stages.some((stage) => stage.onFail?.to === "architect" || stage.onFail?.to === "builder")).toBe(false);
  });

  test("an empty draft has nothing to convert", () => {
    expect(refused(previewLegacyReviewConversion(definition([]), {})).refusals.map((refusal) => refusal.code)).toEqual(["no-legacy-stage"]);
    expect(refused(previewLegacyReviewConversion(definition([run("implement", null)]), {})).refusals[0]!.code).toBe("no-legacy-stage");
  });

  test("two legacy stages need the caller to name one", () => {
    const pipeline = definition([run("build", "first"), review("first", "fix"), run("fix", "second"), review("second", null)]);
    expect(refused(previewLegacyReviewConversion(pipeline, {})).refusals[0]!.code).toBe("ambiguous-stage");
    expect(ok(previewLegacyReviewConversion(pipeline, { stageId: "second" })).implementerStageId).toBe("fix");
    expect(refused(previewLegacyReviewConversion(pipeline, { stageId: "build" })).refusals[0]!.code).toBe("not-legacy");
  });

  test("multiple preceding runs are ambiguous until the caller picks the implementer; a fail-edge source never counts", () => {
    const pipeline = definition([
      run("plan", "review", "architect", "read-only"),
      run("build", "review"),
      run("probe", null, "builder", "read-write", { onFail: { to: "review", maxRounds: 2 } }),
      review("review", null),
    ]);
    const ambiguous = refused(previewLegacyReviewConversion(pipeline, {}));
    expect(ambiguous.refusals.map((refusal) => refusal.code)).toEqual(["ambiguous-implementer"]);
    expect(ambiguous.implementerCandidates).toEqual(["plan", "build"]);
    const chosen = ok(previewLegacyReviewConversion(pipeline, { implementerStageId: "build" }));
    expect(chosen.stages.find((stage) => stage.id === "review-fix")!.effectiveRole).toEqual(role("builder", "read-write"));
    /* A read-only predecessor cannot fix anything. */
    expect(refused(previewLegacyReviewConversion(pipeline, { implementerStageId: "plan" })).refusals.map((refusal) => refusal.code)).toEqual(["implementer-read-only"]);
    /* A stage that does not pass into the review is not a candidate. */
    expect(refused(previewLegacyReviewConversion(pipeline, { implementerStageId: "probe" })).refusals[0]!.code).toBe("no-implementer");
  });

  test("a review whose only predecessor is another review has no known implementer", () => {
    const pipeline = definition([run("build", "first"), review("first", "second"), review("second", null)]);
    expect(refused(previewLegacyReviewConversion(pipeline, { stageId: "second" })).refusals.map((refusal) => refusal.code)).toEqual(["no-implementer"]);
  });

  test("the fixer id is deterministic and skips every taken id", () => {
    const pipeline = definition([run("build", "review"), review("review", null), run("review-fix", null), run("review-fix-2", null)]);
    const first = ok(previewLegacyReviewConversion(pipeline, {}));
    const second = ok(previewLegacyReviewConversion(pipeline, {}));
    expect(first.fixerStageId).toBe("review-fix-3");
    expect(second.fixerStageId).toBe(first.fixerStageId);
    /* A long id stays inside the 64-character stage id bound. */
    const long = "r".repeat(64);
    const longPreview = ok(previewLegacyReviewConversion(definition([run("build", long), review(long, null)]), {}));
    expect(longPreview.fixerStageId.length).toBeLessThanOrEqual(64);
    expect(longPreview.fixerStageId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("a full graph refuses instead of overflowing the stage limit", () => {
    const stages = [run("s1", "s2"), run("s2", "s3"), run("s3", "s4"), run("s4", "s5"), run("s5", "s6"), run("s6", "s7"), run("s7", "review"), review("review", null)];
    const preview = refused(previewLegacyReviewConversion(definition(stages), {}));
    expect(preview.refusals.map((refusal) => refusal.code)).toEqual(["stage-count"]);
    expect(preview.recommendedReviewLimit).toBe(RECOMMENDED_REVIEW_LIMIT);
  });

  test("a finite flow limit N becomes N reviewer activations under advance, never a clamp", () => {
    const pipeline = FIVE_DRAFT();
    for (const limit of [1, 2, 3, 9]) {
      const preview = ok(previewLegacyReviewConversion(pipeline, {}, { flowRoundLimit: limit }));
      expect(preview).toMatchObject({ reviewLimit: limit, reviewLimitSource: "flow", reviewerActivations: limit });
      expect(preview.stages.find((stage) => stage.id === "reviewer")!.onFail).toEqual({ to: "reviewer-fix", maxRounds: limit, onExhausted: "advance" });
    }
    /* An explicit limit is the caller's edit and wins over the recorded one. */
    expect(ok(previewLegacyReviewConversion(pipeline, { reviewLimit: 2 }, { flowRoundLimit: 7 }))).toMatchObject({ reviewLimit: 2, reviewLimitSource: "request" });
    /* The counters differ: advance runs the reviewer maxRounds times, park once more. */
    expect(reviewerActivationsForLimit(4, "advance")).toBe(4);
    expect(reviewerActivationsForLimit(4, "park")).toBe(5);
  });

  test("unlimited, zero and over-bound limits are refused with a recommended finite limit", () => {
    const pipeline = FIVE_DRAFT();
    const unlimited = refused(previewLegacyReviewConversion(pipeline, {}, { flowRoundLimit: 0 }));
    expect(unlimited).toMatchObject({ reviewLimit: null, recommendedReviewLimit: 5 });
    expect(unlimited.refusals.map((refusal) => refusal.code)).toEqual(["unlimited-limit"]);
    expect(refused(previewLegacyReviewConversion(pipeline, { reviewLimit: 0 })).refusals[0]!.code).toBe("unlimited-limit");
    const over = refused(previewLegacyReviewConversion(pipeline, {}, { flowRoundLimit: 12 }));
    expect(over.refusals.map((refusal) => refusal.code)).toEqual(["limit-out-of-range"]);
    expect(over.refusals[0]!.message).toContain("12");
    expect(refused(previewLegacyReviewConversion(pipeline, { reviewLimit: 2.5 })).refusals[0]!.code).toBe("limit-out-of-range");
    /* The editable fix is the recommendation. */
    expect(ok(previewLegacyReviewConversion(pipeline, { reviewLimit: unlimited.recommendedReviewLimit }, { flowRoundLimit: 0 })).reviewLimit).toBe(5);
  });

  test("a stage with an unsettled legacy attempt is live and refused", () => {
    const pipeline = definition([run("build", "review"), review("review", null)], { review: [attempt(1, { state: "reviewing", completedAt: null, verdict: null })] }, { state: "running" });
    expect(refused(previewLegacyReviewConversion(pipeline, {})).refusals.map((refusal) => refusal.code)).toEqual(["stage-live"]);
  });

  test("an injected graph validator refusal keeps the preview unstartable", () => {
    const preview = refused(previewLegacyReviewConversion(FIVE_DRAFT(), {}, { graphError: () => "pass edges form a cycle" }));
    expect(preview.refusals).toEqual([{ code: "graph-invalid", message: "pass edges form a cycle" }]);
  });
});

describe("apply and revert", () => {
  const RECEIPT = { clientRequestId: "convert-1", expectedRevision: "a".repeat(64), actor: { kind: "operator" as const }, at: "2026-09-22T00:00:00.000Z" };

  test("settled legacy attempts stay historical and separate; an old approval does not pass the new reviewer", () => {
    const approved = attempt(1, { reviewFlowSync: { generation: "g", roundCount: 2, implementerHeadSha: "1".repeat(40), reviewerHeadSha: "1".repeat(40), verdict: "APPROVE", relayState: "approved", terminalState: "approved", synchronizedAt: "t", sourceUpdatedAt: null, lagMs: null } as never });
    const closed = attempt(2, { state: "failed", verdict: { status: "fail", findings: ["P1 — gap"] }, output: "gap" });
    const pipeline = definition([run("build", "review"), review("review", "ship"), run("ship", null)], { build: [attempt(1, { flowId: null, effectiveRole: role("builder", "read-write") })], review: [approved, closed] }, {
      state: "needs_decision",
      cursor: { stageId: "review", state: "reviewing", input: "built", activatedBy: { stageId: "build", attempt: 1, edge: "pass" } },
    });
    const original = structuredClone(pipeline);
    const preview = ok(previewLegacyReviewConversion(pipeline, {}));
    expect(preview.legacyAttempts).toBe(2);
    const conversion = applyLegacyReviewConversion(pipeline, preview, RECEIPT);

    expect(conversion).toMatchObject({ ...RECEIPT, stageId: "review", fixerStageId: "review-fix", implementerStageId: "build", reviewLimit: 5, reviewLimitSource: "default" });
    /* The immutable snapshot is the definition as it was, byte for byte. */
    expect(JSON.stringify(conversion.original.stages)).toBe(JSON.stringify(original.stages));
    expect(JSON.stringify(conversion.original.run)).toBe(JSON.stringify(original.runs[1]));
    expect(conversion.original.cursor).toEqual(original.cursor);
    expect(pipeline.legacyReviewConversions).toEqual([conversion]);
    /* The fixer run sits beside its stage, empty. */
    expect(pipeline.runs.map((item) => item.stageId)).toEqual(["build", "review", "review-fix", "ship"]);
    expect(pipeline.stages.map((item) => item.id)).toEqual(["build", "review", "review-fix", "ship"]);
    expect(pipeline.runs[2]!.attempts).toEqual([]);
    /* Old attempts keep every recorded field, and gain only the markers that keep them out of the new stage's own history. */
    const kept = pipeline.runs[1]!.attempts;
    expect(kept.map((item) => ({ ...item, historical: undefined, legacyReview: undefined }))).toEqual(original.runs[1]!.attempts.map((item) => ({ ...item, historical: undefined, legacyReview: undefined })));
    expect(kept.every((item) => item.historical === true && item.legacyReview === true)).toBe(true);
    expect(kept[0]!.flowId).toBe("flow-1");
    expect(kept[0]!.reviewFlowSync?.verdict).toBe("APPROVE");
    /* Nothing else moved: the builder's attempt and the pipeline state. */
    expect(pipeline.runs[0]).toEqual(original.runs[0]!);
    expect(pipeline.state).toBe("needs_decision");
    /* The cursor waits on the converted reviewer for an explicit retry. */
    expect(pipeline.cursor).toEqual({ stageId: "review", state: "pending", input: "built", activatedBy: { stageId: "build", attempt: 1, edge: "pass" } });
    /* The card says what moves the lane now, and revert restores what it said before. */
    expect(pipeline.stateDetail).toContain("retry it to run the new reviewer");
    expect(revertLegacyReviewConversion(pipeline, "review", { clientRequestId: "revert-1", actor: { kind: "operator" }, at: "t" }).error).toBeUndefined();
    expect(pipeline.stateDetail).toBe(original.stateDetail);
    expect(pipeline.cursor).toEqual(original.cursor);
  });

  test("an unexecuted conversion reverts to the original definition, and the snapshot stays in history", () => {
    const pipeline = FIVE_DRAFT();
    const original = structuredClone(pipeline);
    applyLegacyReviewConversion(pipeline, ok(previewLegacyReviewConversion(pipeline, {})), RECEIPT);
    const reverted = revertLegacyReviewConversion(pipeline, "reviewer", { clientRequestId: "revert-1", actor: { kind: "operator" }, at: "2026-09-22T01:00:00.000Z" });
    expect(reverted.error).toBeUndefined();
    expect(JSON.stringify(pipeline.stages)).toBe(JSON.stringify(original.stages));
    expect(JSON.stringify(pipeline.runs)).toBe(JSON.stringify(original.runs));
    expect(pipeline.cursor).toEqual(original.cursor);
    expect(pipeline.legacyReviewConversions).toHaveLength(1);
    expect(pipeline.legacyReviewConversions![0]!.reverted).toEqual({ clientRequestId: "revert-1", actor: { kind: "operator" }, at: "2026-09-22T01:00:00.000Z" });
    /* A second revert has nothing to revert. */
    expect(revertLegacyReviewConversion(pipeline, "reviewer", { clientRequestId: "revert-2", actor: { kind: "operator" }, at: "t" }).error).toContain("no conversion");
  });

  test("once a new attempt ran, or the graph was edited, the conversion is repaired forward", () => {
    const executed = FIVE_DRAFT();
    applyLegacyReviewConversion(executed, ok(previewLegacyReviewConversion(executed, {})), RECEIPT);
    executed.runs.find((item) => item.stageId === "reviewer")!.attempts.push(attempt(1, { flowId: null }));
    const before = JSON.stringify(executed);
    expect(revertLegacyReviewConversion(executed, "reviewer", { clientRequestId: "r", actor: { kind: "operator" }, at: "t" }).error).toContain("repair it forward");
    expect(JSON.stringify(executed)).toBe(before);

    const edited = FIVE_DRAFT();
    applyLegacyReviewConversion(edited, ok(previewLegacyReviewConversion(edited, {})), RECEIPT);
    edited.stages[3]!.prompt = "edited fixer";
    expect(revertLegacyReviewConversion(edited, "reviewer", { clientRequestId: "r", actor: { kind: "operator" }, at: "t" }).error).toContain("changed since");
  });
});

test("the loading path never reaches the converter", () => {
  /* Startup and every read decode legacy records; only the explicit action converts. */
  const store = fs.readFileSync(path.join(import.meta.dir, "store.ts"), "utf8");
  for (const name of ["previewLegacyReviewConversion", "applyLegacyReviewConversion", "revertLegacyReviewConversion"]) {
    expect(store).not.toContain(name);
  }
  const detailRoute = fs.readFileSync(path.join(import.meta.dir, "../../app/api/pipelines/[id]/route.ts"), "utf8");
  const listRoute = fs.readFileSync(path.join(import.meta.dir, "../../app/api/pipelines/route.ts"), "utf8");
  for (const source of [detailRoute, listRoute]) expect(source).not.toMatch(/(preview|apply|revert)LegacyReviewConversion/);
});
