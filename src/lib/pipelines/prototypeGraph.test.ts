import { expect, test } from "bun:test";
import { buildPipeline } from "./store";
import { pipelineRoleLookup, resolvePipelineRole } from "./roles";
import type { PipelineFailEdgeExhaustion, PipelineStage } from "./types";

function prototypeGraph(policy?: PipelineFailEdgeExhaustion) {
  const stage = (id: string, next: string | null, roleId: "architect" | "visual-critic"): PipelineStage => {
    const role = { roleId };
    const resolved = resolvePipelineRole({ role }, "run", pipelineRoleLookup);
    if (!resolved.role) throw new Error(resolved.error);
    return { id, kind: "run", prompt: "{{task}}", next, role, effectiveRole: resolved.role };
  };
  const critic = stage("critic", "publish", "visual-critic");
  critic.onFail = { to: "proto-fix", maxRounds: 2, ...(policy ? { onExhausted: policy } : {}) };
  const stages = [stage("prototype", "critic", "architect"), critic,
    stage("proto-fix", "critic", "architect"), stage("publish", null, "architect")];
  return { stages, pipeline: buildPipeline({ id: "prototype-graph", task: "Compare layouts", project: "fixture",
    repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: "2026-10-30T00:00:00.000Z" }) };
}

test("the production builder composes a prototype critic fail edge that parks on exhaustion", () => {
  const { stages, pipeline } = prototypeGraph();
  expect(pipeline.stages.map(stage => [stage.id, stage.next])).toEqual([
    ["prototype", "critic"], ["critic", "publish"], ["proto-fix", "critic"], ["publish", null],
  ]);
  expect(pipeline.stages[1]!.onFail).toEqual({ to: "proto-fix", maxRounds: 2, onExhausted: "park" });
  expect(stages[1]!.onFail).toEqual({ to: "proto-fix", maxRounds: 2 });
  expect(pipeline.stages.filter(stage => stage.id !== "critic").every(stage => stage.onFail === null)).toBe(true);
});

test.each(["park", "advance", "stop-after-fix"] as const)("composition preserves an explicit critic exhaustion policy: %s", policy => {
  expect(prototypeGraph(policy).pipeline.stages[1]!.onFail).toEqual({ to: "proto-fix", maxRounds: 2, onExhausted: policy });
});

test("composition keeps other roles' fail-edge defaults", () => {
  const { stages } = prototypeGraph();
  const resolved = resolvePipelineRole({ role: { roleId: "reviewer" } }, "run", pipelineRoleLookup);
  if (!resolved.role) throw new Error(resolved.error);
  stages[1] = { ...stages[1]!, role: { roleId: "reviewer" }, effectiveRole: resolved.role };
  const pipeline = buildPipeline({ id: "review-graph", task: "Review layouts", project: "fixture", repoDir: "/repo",
    stages, srcPath: null, srcConversationId: null, now: "2026-10-30T00:00:00.000Z" });
  expect(pipeline.stages[1]!.onFail).toEqual({ to: "proto-fix", maxRounds: 2 });
});
