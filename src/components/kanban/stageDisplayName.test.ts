import { expect, test } from "bun:test";

import { translate, type TFunction } from "@/lib/i18n";
import type { PipelineStage } from "@/lib/pipelines/types";

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
