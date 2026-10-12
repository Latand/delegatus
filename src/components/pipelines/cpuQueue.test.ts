import { expect, test } from "bun:test";
import { translate } from "@/lib/i18n/core";
import { cardWaitsForCpu, pipelineProgress } from "@/components/kanban/PipelineSection";
import type { KanbanPipeline } from "@/components/kanban/kanbanModel";

test("CPU waiting replaces the live progress caption in both card languages", () => {
  const summary = { pipeline: { state: "running", stateDetail: "Waiting for the CPU queue · 2nd · up to 7 min" }, chips: [] } as unknown as KanbanPipeline;
  expect(pipelineProgress((key, params) => translate("en", key, params), summary, stage => stage.id)).toBe("Waiting for the CPU queue · 2nd · up to 7 min");
  expect(pipelineProgress((key, params) => translate("uk", key, params), summary, stage => stage.id)).toBe("Чекає черги CPU · 2-й · до 7 хв");
  expect(cardWaitsForCpu([summary], 0)).toBe(true);
  expect(cardWaitsForCpu([summary], 1)).toBe(false);
  expect(cardWaitsForCpu([summary, { pipeline: { state: "running", stateDetail: null } } as KanbanPipeline], 0)).toBe(false);
});
