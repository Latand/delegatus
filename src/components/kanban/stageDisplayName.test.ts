import { expect, test } from "bun:test";

import { translate, type TFunction } from "@/lib/i18n";
import type { PipelineStage } from "@/lib/pipelines/types";

import { stageAttemptPlace, stageCardLabel, stageLabelTitle, stageLatestAttemptPlace } from "@/components/pipelines/pipelineModel";
import type { Pipeline } from "@/lib/pipelines/types";

import { pipelineTitle, stageDisplayName } from "./PipelineSection";

/* How a stage is named on a card (#1765): its own id wherever the id says more
   than the role, and the role's name wherever the id only repeats the role or
   names nothing. */

const t = ((key: string, params?: Record<string, unknown>) => translate("en", key as never, params as never)) as TFunction;
const stage = (id: string, roleId: string | null): PipelineStage =>
  ({ id, kind: "run", ...(roleId ? { role: { roleId } } : {}), prompt: "", next: null, onFail: null }) as unknown as PipelineStage;

test("a stage id that says more than the role names the stage", () => {
  expect(stageDisplayName(t, stage("critique", "reviewer"))).toBe("Critique");
  expect(stageDisplayName(t, stage("diagnose", "architect"))).toBe("Diagnose");
  expect(stageDisplayName(t, stage("build-ui", "builder"))).toBe("Build ui");
  expect(stageDisplayName(t, stage("review_plan", "reviewer"))).toBe("Review plan");
});

test("an id that only repeats the role, names nothing, or is an identifier falls back to the role", () => {
  expect(stageDisplayName(t, stage("builder", "builder"))).toBe("Builder");
  expect(stageDisplayName(t, stage("Reviewer", "reviewer"))).toBe("Reviewer");
  expect(stageDisplayName(t, stage("stage-2", "builder"))).toBe("Builder");
  expect(stageDisplayName(t, stage("step_3", "verifier"))).toBe("Verifier");
  expect(stageDisplayName(t, stage("7", "cleaner"))).toBe("Cleaner");
  expect(stageDisplayName(t, stage("0f3a9c71", "builder"))).toBe("Builder");
  expect(stageDisplayName(t, stage([
    "0f3a9c71", "4b2d", "4e15", "9a77", "2c8e5b31d640",
  ].join("-"), "builder"))).toBe("Builder");
});

test("a role-less stage keeps its id, and an unnamable one keeps whatever the chip label gives it", () => {
  expect(stageDisplayName(t, stage("handover", null))).toBe("Handover");
  expect(stageDisplayName(t, stage("", "builder"))).toBe("Builder");
});

test("a pipeline is titled by the first line of its task, and an empty task by the generic word", () => {
  const pipeline = (task: string) => ({ task }) as never;
  expect(pipelineTitle(t, pipeline("Name every pipeline row\nand the rest of the brief"))).toBe("Name every pipeline row");
  expect(pipelineTitle(t, pipeline("   \n  Leading blank lines are skipped  "))).toBe("Leading blank lines are skipped");
  expect(pipelineTitle(t, pipeline("   "))).toBe(translate("en", "kanban.pipeline"));
});

/* A stage's conversation is labelled by the stage and, once the stage ran
   twice, by which attempt it is (#1865). */

const attempt = (n: number, agentPath: string, historical = false) => ({ n, agentPath, conversationId: null, state: "passed", ...(historical ? { historical: true } : {}) });
const pipelineOf = (stageId: string, attempts: ReturnType<typeof attempt>[]): Pipeline =>
  ({ id: "p1", stages: [stage(stageId, "architect")], runs: [{ stageId, attempts }] }) as unknown as Pipeline;

test("a stage that ran once reads as its name, with no number", () => {
  const pipeline = pipelineOf("critique", [attempt(1, "/a/one.jsonl")]);
  const place = stageAttemptPlace(pipeline, "critique", { path: "/a/one.jsonl" });
  expect(place).toEqual({ attempt: 1, attempts: 1 });
  expect(stageCardLabel(t, pipeline.stages[0]!, place)).toBe("Critique");
});

test("every attempt of a stage that ran twice carries its number", () => {
  const pipeline = pipelineOf("critique", [attempt(1, "/a/one.jsonl"), attempt(2, "/a/two.jsonl")]);
  const first = stageAttemptPlace(pipeline, "critique", { path: "/a/one.jsonl" });
  const second = stageAttemptPlace(pipeline, "critique", { path: "/a/two.jsonl" });
  expect(stageCardLabel(t, pipeline.stages[0]!, first)).toBe("Critique · 1");
  expect(stageCardLabel(t, pipeline.stages[0]!, second)).toBe("Critique · 2");
  expect(stageCardLabel(t, pipeline.stages[0]!, stageLatestAttemptPlace(pipeline, "critique"))).toBe("Critique · 2");
  expect(stageLabelTitle(t, pipeline.stages[0]!, second, "Claude")).toBe("Critique, attempt 2 of 2 · Architect · Claude");
  expect(stageLabelTitle(t, pipeline.stages[0]!, first, null)).toBe("Critique, attempt 1 of 2 · Architect");
});

test("lineage-adopted history neither counts as an attempt nor gets a number", () => {
  const pipeline = pipelineOf("critique", [attempt(1, "/a/adopted.jsonl", true), attempt(2, "/a/own.jsonl")]);
  const own = stageAttemptPlace(pipeline, "critique", { path: "/a/own.jsonl" });
  expect(own).toEqual({ attempt: 1, attempts: 1 });
  expect(stageCardLabel(t, pipeline.stages[0]!, own)).toBe("Critique");
  expect(stageAttemptPlace(pipeline, "critique", { path: "/a/adopted.jsonl" }).attempt).toBeNull();
});

test("an attempt the record no longer lists draws the stage name without a number", () => {
  const pipeline = pipelineOf("critique", [attempt(1, "/a/one.jsonl"), attempt(2, "/a/two.jsonl")]);
  const gone = stageAttemptPlace(pipeline, "critique", { path: "/a/elsewhere.jsonl" });
  expect(gone).toEqual({ attempt: null, attempts: 2 });
  expect(stageCardLabel(t, pipeline.stages[0]!, gone)).toBe("Critique");
});

test("the tooltip leaves the role out where it only repeats the stage's name", () => {
  const builder = stage("builder", "builder");
  expect(stageLabelTitle(t, builder, { attempt: 1, attempts: 1 }, "Codex")).toBe("Builder · Codex");
});

test("Ukrainian says which attempt of how many", () => {
  const uk = ((key: string, params?: Record<string, unknown>) => translate("uk", key as never, params as never)) as TFunction;
  const place = { attempt: 2, attempts: 3 };
  expect(stageCardLabel(uk, stage("critique", "architect"), place)).toBe("Critique · 2");
  expect(stageLabelTitle(uk, stage("critique", "architect"), place, null)).toBe(`Critique, спроба 2 з 3 · ${translate("uk", "roleCopy.architect.name" as never)}`);
});
