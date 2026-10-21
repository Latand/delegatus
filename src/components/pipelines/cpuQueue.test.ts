import { expect, test } from "bun:test";
import { translate } from "@/lib/i18n/core";
import { cardWaitsForCpu, pipelineProgress } from "@/components/kanban/PipelineSection";
import type { KanbanPipeline } from "@/components/kanban/kanbanModel";

test("CPU waiting replaces the live progress caption in both card languages", () => {
  const summary = { pipeline: { state: "running", stateDetail: "Waiting for the CPU queue · 2nd · up to 7 min" }, chips: [] } as unknown as KanbanPipeline;
  expect(pipelineProgress((key, params) => translate("en", key, params), summary, stage => stage.id)).toBe("Waiting for the CPU queue · 2nd · up to 7 min · Normal");
  expect(pipelineProgress((key, params) => translate("uk", key, params), summary, stage => stage.id)).toBe("Чекає черги CPU · 2-й · до 7 хв · Звичайний");
  const stalled = { pipeline: { state: "running", stateDetail: "Waiting for the CPU queue · 7th · stalled for 62 min · Viewer publication: owner; owner viewer, epoch 1" }, chips: [] } as unknown as KanbanPipeline;
  expect(pipelineProgress((key, params) => translate("en", key, params), stalled, stage => stage.id)).toBe("CPU queue is stalled · 7th · nothing started for 62 min · Normal");
  expect(pipelineProgress((key, params) => translate("uk", key, params), stalled, stage => stage.id)).toBe("Черга CPU стоїть · 7-й · нічого не стартувало 62 хв · Звичайний");
  expect(cardWaitsForCpu([stalled], 0)).toBe(true);
  expect(cardWaitsForCpu([summary], 0)).toBe(true);
  expect(cardWaitsForCpu([summary], 1)).toBe(false);
  expect(cardWaitsForCpu([summary, { pipeline: { state: "running", stateDetail: null } } as KanbanPipeline], 0)).toBe(false);
});

test.each(["high", "normal", "low"] as const)("a %s waiting caption names its current priority in both languages", priority => {
  for (const lang of ["en", "uk"] as const) for (const stalled of [false, true]) {
    const summary = { pipeline: { state: "running", stateDetail: `Waiting for the CPU queue · 2nd · ${stalled ? "stalled for" : "up to"} 7 min · ${priority} priority · Viewer publication: owner; owner viewer, epoch 1` }, chips: [] } as unknown as KanbanPipeline;
    expect(pipelineProgress((key, params) => translate(lang, key, params), summary, stage => stage.id))
      .toBe(translate(lang, stalled ? "kanban.progress.cpuQueueStalled" : "kanban.progress.cpuQueue", { position: 2, ordinal: "2nd", minutes: 7, priority: translate(lang, `kanban.priority.${priority}`) }));
    expect(cardWaitsForCpu([summary], 0)).toBe(true);
  }
});
