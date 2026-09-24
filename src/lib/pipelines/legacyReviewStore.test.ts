import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Pipeline, PipelineStage, PipelineStageAttempt } from "./types";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-legacy-review-store-"));
const { archiveSettledPipelines, findPipelineRecord, loadArchivedPipelines, loadPipelines, loadPipelinesForStartup, pipelineIdentity, savePipelines } = await import("./store");
const { applyLegacyReviewConversion, previewLegacyReviewConversion } = await import("./legacyReviewDefinition");

afterAll(() => fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true }));

/* Synthetic stored shapes: hot, archived and draft records carrying the
   legacy review-loop discriminant, with fields no current reader knows. */
const role = (roleId: string, access: "read-only" | "read-write") => ({ roleId, engine: "codex", model: null, effort: null, access, promptScaffold: `${roleId} guidance` }) as PipelineStage["effectiveRole"];
const run = (id: string, next: string | null, roleId = "builder", access: "read-only" | "read-write" = "read-write") =>
  ({ id, kind: "run", role: { roleId }, "prompt": `${id} {{task}}`, next, onFail: null, effectiveRole: role(roleId, access) }) as PipelineStage;
const review = (id: string, next: string | null) =>
  ({ id, kind: "review-loop", role: { roleId: "reviewer" }, "prompt": `Review ${id}`, next, onFail: null, effectiveRole: role("reviewer", "read-only"), legacyStageNote: "kept" }) as PipelineStage;
const SHA = "a".repeat(40);
const OLD = "2026-08-01T00:00:00.000Z";

function attempt(n: number, over: Partial<PipelineStageAttempt> = {}): PipelineStageAttempt {
  return {
    n, state: "passed", effectiveRole: role("reviewer", "read-only"), launchId: null, conversationId: `conversation-${n}`, sessionId: null, agentPath: null, paneId: null,
    flowId: null, startedAt: OLD, completedAt: OLD, input: null, activatedBy: null, output: "done", verdict: { status: "pass" }, error: null, ...over,
  } as PipelineStageAttempt;
}

function record(id: string, stages: PipelineStage[], attempts: Record<string, PipelineStageAttempt[]>, over: Partial<Pipeline> & Record<string, unknown>): Pipeline {
  const task = `Legacy ${id}`;
  return {
    id, task, taskIds: ["task-1"], spec: "AC", project: "demo", repoDir: "/repo", ...pipelineIdentity(id, task, "/repo"),
    baseBranch: "main", baseRef: SHA, lastPassedCommit: SHA, publication: "remote-branch", publishedCommit: SHA,
    stages, runs: stages.map((stage) => ({ stageId: stage.id, attempts: attempts[stage.id] ?? [] })),
    cursor: null, state: "closed", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: OLD, closedAt: OLD,
    ...over,
  } as Pipeline;
}

const approvedReview = attempt(1, {
  flowId: "flow-approved",
  reviewHeadSha: SHA,
  expectedReviewHeadSha: SHA,
  reviewFlowSync: { generation: "g1", roundCount: 2, implementerHeadSha: SHA, reviewerHeadSha: SHA, verdict: "APPROVE", relayState: "approved", terminalState: "approved", synchronizedAt: OLD, sourceUpdatedAt: OLD, lagMs: 0 } as never,
});

const closedLane = () => record("closed01", [run("build", "review"), review("review", null)], {
  build: [attempt(1, { effectiveRole: role("builder", "read-write"), agentPath: "/codex/build.jsonl" })],
  review: [approvedReview],
}, { decisionAnswers: [], legacyPipelineNote: { nested: [1, 2] } });

const pausedLane = () => record("paused01", [run("build", "review"), review("review", null)], {
  build: [attempt(1, { effectiveRole: role("builder", "read-write") })],
  review: [attempt(1, { state: "failed", flowId: "flow-paused", verdict: null, output: null, completedAt: null, error: "review flow paused" })],
}, { state: "needs_decision", closedAt: null, cursor: { stageId: "review", state: "reviewing", input: "built", activatedBy: { stageId: "build", attempt: 1, edge: "pass" } }, stateDetail: "review flow paused in relaying" });

function draft(id: string, stages: PipelineStage[], over: Partial<Pipeline> = {}): Pipeline {
  return record(id, stages, {}, {
    state: "draft", baseBranch: "", baseRef: "", lastPassedCommit: "", publication: undefined, publishedCommit: undefined, closedAt: null,
    cursor: stages.length ? { stageId: stages[0]!.id, state: "pending", input: null, activatedBy: null } : null, ...over,
  });
}

const fiveDraft = (id: string) => draft(id, [run("architect", "builder", "architect", "read-only"), run("builder", "reviewer"), review("reviewer", null)], { hiddenAt: OLD });

test("hot legacy rows load with every recorded field, including fields no reader knows", () => {
  const rows = [closedLane(), pausedLane()];
  savePipelines(structuredClone(rows));
  const loaded = loadPipelines();
  expect(loaded.map((pipeline) => pipeline.id)).toEqual(["closed01", "paused01"]);
  for (const [index, pipeline] of loaded.entries()) {
    const original = rows[index]!;
    expect(pipeline.stages).toEqual(original.stages);
    /* Revival spells absent optional attempt fields as null; nothing recorded is lost. */
    expect(pipeline.runs).toMatchObject(original.runs);
    for (const field of ["task", "taskIds", "spec", "baseRef", "publication", "publishedCommit", "cursor", "state", "stateDetail"] as const) {
      expect(pipeline[field]).toEqual(original[field] as never);
    }
  }
  expect((loaded[0] as unknown as { legacyPipelineNote: unknown }).legacyPipelineNote).toEqual({ nested: [1, 2] });
  expect((loaded[0]!.stages[1] as unknown as { legacyStageNote: string }).legacyStageNote).toBe("kept");
  expect(loaded[0]!.runs[1]!.attempts[0]).toMatchObject({ flowId: "flow-approved", reviewFlowSync: { verdict: "APPROVE", generation: "g1" } });
  /* Reading converts nothing. */
  expect(loaded.every((pipeline) => pipeline.stages[1]!.kind === "review-loop" && pipeline.legacyReviewConversions === undefined)).toBe(true);
  expect(loadPipelinesForStartup().map((pipeline) => pipeline.id).sort()).toEqual(["closed01", "paused01"]);
});

test("archived rows and archived drafts decode through the legacy type, never skipped", async () => {
  savePipelines([closedLane(), fiveDraft("draft001"), draft("empty001", [], { hiddenAt: OLD })]);
  expect(await archiveSettledPipelines(Date.parse("2026-09-22T00:00:00.000Z"))).toBe(3);
  expect(loadPipelines()).toEqual([]);
  const archived = loadArchivedPipelines();
  expect(archived.map((pipeline) => pipeline.id).sort()).toEqual(["closed01", "draft001", "empty001"]);
  const five = findPipelineRecord("draft001")!;
  expect(five.stages.map((stage) => `${stage.id}:${stage.kind}`)).toEqual(["architect:run", "builder:run", "reviewer:review-loop"]);
  expect(findPipelineRecord("empty001")!.stages).toEqual([]);
  expect(findPipelineRecord("closed01")!.runs[1]!.attempts[0]!.reviewFlowSync?.verdict).toBe("APPROVE");
  expect(loadPipelinesForStartup().map((pipeline) => pipeline.id).sort()).toEqual(["closed01", "draft001", "empty001"]);
});

test("a draft whose review-loop no run reaches still loads, hot and archived", async () => {
  /* The shape a draft could hold before reachability was enforced on every edit. */
  const orphan = draft("orphan01", [review("review", null), run("build", null)], { hiddenAt: OLD });
  savePipelines([structuredClone(orphan)]);
  expect(loadPipelines().map((pipeline) => pipeline.id)).toEqual(["orphan01"]);
  expect(await archiveSettledPipelines(Date.parse("2026-09-22T00:00:00.000Z"))).toBe(1);
  expect(findPipelineRecord("orphan01")?.stages).toEqual(orphan.stages);
});

test("a converted record round-trips with its immutable original definition", () => {
  const pipeline = pausedLane();
  const preview = previewLegacyReviewConversion(pipeline, {});
  if (!preview.ok) throw new Error("expected a preview");
  applyLegacyReviewConversion(pipeline, preview, { clientRequestId: "convert-1", expectedRevision: "b".repeat(64), actor: { kind: "operator" }, at: "2026-09-22T00:00:00.000Z" });
  savePipelines([structuredClone(pipeline)]);
  const loaded = loadPipelines()[0]!;
  expect(loaded.legacyReviewConversions).toEqual(pipeline.legacyReviewConversions);
  expect(loaded.legacyReviewConversions![0]!.original.stages[1]!.kind).toBe("review-loop");
  expect(loaded.runs[1]!.attempts[0]).toMatchObject({ historical: true, legacyReview: true, flowId: "flow-paused" });
  /* A malformed conversion record is refused at the store, as any other field is. */
  const broken = structuredClone(pipeline);
  (broken.legacyReviewConversions![0] as { reviewLimit: number }).reviewLimit = 0;
  expect(() => savePipelines([broken])).toThrow("malformed");
});
