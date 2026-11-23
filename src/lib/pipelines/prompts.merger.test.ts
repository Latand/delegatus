import { expect, test } from "bun:test";
import { isMergerBatchStage } from "./prompts";
import { mergerStage } from "./mergerContract.fixture";
import { buildPipeline } from "./store";

test("merger contract requires a run, both merger identities and effective write access", () => {
  const merger = mergerStage();
  const builder = mergerStage({ role: { roleId: "builder", params: { prs: "13@reviewed" } } });
  const release = mergerStage({ role: { roleId: "deployer", params: { mode: "release" } } });
  const stages = [merger, mergerStage({ access: "read-only" }), builder,
    { ...builder, effectiveRole: merger.effectiveRole }, { ...merger, effectiveRole: builder.effectiveRole },
    release, mergerStage({ kind: "review-loop" })];
  const pipeline = buildPipeline({ id: "merger-contract", task: "Fixture merger", project: "fixture", repoDir: "/fixture",
    stages: stages.map((stage, index) => ({ ...stage, id: `stage-${index}` })),
    srcPath: null, srcConversationId: null, now: "2026-11-08T12:00:00.000Z" });
  expect(pipeline.stages.map(stage => isMergerBatchStage(stage))).toEqual([true, false, false, false, false, false, false]);
  expect(isMergerBatchStage(merger, builder.effectiveRole)).toBe(false);
  expect(isMergerBatchStage(builder, merger.effectiveRole)).toBe(false);
  expect(isMergerBatchStage(merger, stages[1]!.effectiveRole)).toBe(false);
  expect(isMergerBatchStage(stages[6]!, merger.effectiveRole)).toBe(false);
});
