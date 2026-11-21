import { pipelineEnded, pipelineReason, screenCurrentStageId } from "@/components/pipelines/pipelineBlockModel";
import { humanizeDuration } from "@/components/turnDuration";
import { failEdgeExhaustion, failEdgeMaxRounds } from "@/lib/pipelines/failEdgeBudget";
import { stageFailEdgeRoundsUsed } from "@/components/pipelines/pipelineModel";
import type { TFunction } from "@/lib/i18n";
import { currentProviderWait } from "@/lib/pipelines/stageChip";
import type { Pipeline, PipelineFailEdgeExhaustion, PipelineStage } from "@/lib/pipelines/types";
import { ordinal, parseCpuQueueDetail } from "@/lib/runtime/cpuQueueText";

import { cardStatePopover, cardStateText, laneState, laneStopWhy, type CardOwner, type CardState } from "./cardState";
import type { KanbanPipeline } from "./kanbanModel";
import { loopShapes, type LoopShape } from "./pipelineGraph";

/*
 * The Stages window's tab model (#2 redesign S2, docs/design/redesign-2026-11/
 * s2-build-brief.md §3): the order the tabs read in, which stage is a step of
 * the lane and which one only runs when another fails, one rule per fail edge,
 * and who the lane waits on. Pure: no DOM, no React.
 *
 * `graphOrder` lays stages out by graph layer, which is right for a drawing
 * with wires and wrong for a sequence: a fix stage that nothing passes into
 * and that more than one stage fails into has no incoming wire, so it sorts
 * before every stage whose failure reaches it. Tabs read as a sequence, so they
 * start from the stage the engine starts the lane on and follow `next`.
 */

export type TabKind = "step" | "conditional" | "detached";

/** One fail edge of the lane, with what the board already reads for it. */
export interface StageRule {
  id: string;
  from: string;
  to: string;
  shape: LoopShape;
  fired: number;
  max: number;
  mode: PipelineFailEdgeExhaustion;
  /** The target's own tab carries this edge as round dots, so no rule line is drawn for it. */
  carried: boolean;
}

export interface StageTab {
  stage: PipelineStage;
  kind: TabKind;
  /** The step's number in the lane; null for a conditional or detached stage. */
  number: number | null;
  /** The grid cell: a step and the conditional stages anchored to it share one. */
  unit: number;
  /** For a conditional stage, the step it hangs under. */
  anchor: string | null;
  /** The stages whose fail edge reaches this stage. */
  sources: string[];
  /** The one edge this tab's round dots draw. */
  carried: StageRule | null;
}

export interface StageTabModel {
  tabs: StageTab[];
  /** The tabs by grid cell: a step then its conditional stages, then one cell per detached stage. */
  units: StageTab[][];
  rules: StageRule[];
  /** The numbered steps. */
  steps: number;
  /** One tab would repeat the pane's head, so a lane of one stage draws no strip. */
  showStrip: boolean;
}

export function stageTabs(summary: KanbanPipeline): StageTabModel {
  const { pipeline } = summary;
  const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage] as const));
  const shapes = loopShapes(pipeline);

  /* 1. The steps: from the stage the engine starts the lane on, along `next`. */
  const steps: PipelineStage[] = [];
  const stepIds = new Set<string>();
  for (let current: PipelineStage | undefined = pipeline.stages[0]; current && !stepIds.has(current.id); current = current.next ? byId.get(current.next) : undefined) {
    steps.push(current);
    stepIds.add(current.id);
  }

  /* 2. The conditional stages: reached from a step through a fail edge, then
     along their own edges while those stay off the steps. Each hangs under the
     earliest step whose fail edge reaches it. */
  const anchorOf = new Map<string, string>();
  const chain = new Map<string, string[]>();
  const claim = (stepId: string, first: PipelineStage | undefined) => {
    const queue = [first];
    for (let stage = queue.shift(); stage; stage = queue.shift()) {
      if (stepIds.has(stage.id) || anchorOf.has(stage.id)) continue;
      anchorOf.set(stage.id, stepId);
      chain.set(stepId, [...(chain.get(stepId) ?? []), stage.id]);
      if (stage.next) queue.push(byId.get(stage.next));
      if (stage.onFail?.to) queue.push(byId.get(stage.onFail.to));
    }
  };
  for (const step of steps) if (step.onFail?.to) claim(step.id, byId.get(step.onFail.to));

  const sourcesOf = (id: string) => pipeline.stages.filter((stage) => stage.onFail?.to === id).map((stage) => stage.id);

  /* 5. The rules: one per fail edge. */
  const rules: StageRule[] = pipeline.stages.flatMap((stage) => {
    const to = stage.onFail?.to;
    if (!stage.onFail || !to || !byId.has(to)) return [];
    const id = `${stage.id}:fail:${to}`;
    const shape = shapes.get(id) ?? "other";
    return [{
      id,
      from: stage.id,
      to,
      shape,
      fired: stageFailEdgeRoundsUsed(pipeline, stage),
      max: failEdgeMaxRounds(pipeline, stage),
      mode: failEdgeExhaustion(stage.onFail),
      carried: shape === "dock" && anchorOf.has(to) && sourcesOf(to).length === 1,
    }];
  });
  const carriedBy = new Map(rules.filter((rule) => rule.carried).map((rule) => [rule.to, rule] as const));

  /* 3 and 4. The tabs: each step with the conditional stages under it, then the detached ones. */
  const tabs: StageTab[] = [];
  const units: StageTab[][] = [];
  steps.forEach((step, index) => {
    const unit: StageTab[] = [{ stage: step, kind: "step", number: index + 1, unit: units.length, anchor: null, sources: sourcesOf(step.id), carried: null }];
    for (const id of chain.get(step.id) ?? []) {
      unit.push({ stage: byId.get(id)!, kind: "conditional", number: null, unit: units.length, anchor: step.id, sources: sourcesOf(id), carried: carriedBy.get(id) ?? null });
    }
    units.push(unit);
    tabs.push(...unit);
  });
  for (const stage of pipeline.stages) {
    if (stepIds.has(stage.id) || anchorOf.has(stage.id)) continue;
    const tab: StageTab = { stage, kind: "detached", number: null, unit: units.length, anchor: null, sources: sourcesOf(stage.id), carried: null };
    units.push([tab]);
    tabs.push(tab);
  }
  return { tabs, units, rules, steps: steps.length, showStrip: tabs.length > 1 };
}

/* ── What a tab says beyond its state ─────────────────────────────────────── */

export type TabWord = "ifNeeded" | "notNeeded" | "offChain" | "notRun";

export interface TabNote {
  /** Skipped draws its own mark; the state's ring is the one waiting stages wear. */
  skipped: boolean;
  /** The word a stage that never ran carries in place of «waiting». */
  word: TabWord | null;
}

/** Whether the lane has nothing more to start. */
const laneOver = (pipeline: Pipeline): boolean => pipelineEnded(pipeline) || pipeline.state === "needs_review";

export function tabNote(tab: StageTab, summary: KanbanPipeline): TabNote {
  const view = summary.views.get(tab.stage.id);
  const skipped = view?.state === "skipped";
  if (skipped || (view?.attempts ?? 0) > 0 || tab.kind === "step") return { skipped, word: null };
  const over = laneOver(summary.pipeline);
  if (tab.kind === "conditional") return { skipped, word: over ? "notNeeded" : "ifNeeded" };
  return { skipped, word: over ? "notRun" : "offChain" };
}

/** The attempt of a stage that a spent budget handed back for one more look. */
export function recheckAttempts(pipeline: Pipeline, stageId: string): Set<number> {
  const run = pipeline.runs.find((entry) => entry.stageId === stageId);
  return new Set((run?.attempts ?? []).filter((attempt) => !attempt.historical && attempt.activatedBy?.budgetRecheck).map((attempt) => attempt.n));
}

/** The tab a stage selects: a stage the lane stands on that is not a tab cannot occur, but a stale id falls back to the first. */
export function tabIndexOf(model: StageTabModel, stageId: string | null): number {
  const index = model.tabs.findIndex((tab) => tab.stage.id === stageId);
  return index >= 0 ? index : 0;
}

/* ── Whom the lane waits on ───────────────────────────────────────────────── */

export interface WaitsOn {
  owner: CardOwner;
  /** The one line the head says. */
  words: string;
  /** The popover's sentence. */
  detail: string;
  /** The stage the line names, if the lane stands on one. */
  stageId: string | null;
}

const WAIT_ROLE_IDS = ["builder", "reviewer", "architect", "verifier", "visual-critic", "merger", "prod-auditor", "cleaner", "deployer"] as const;
type WaitRole = (typeof WAIT_ROLE_IDS)[number];
const WAIT_ROLES: ReadonlySet<string> = new Set<string>(WAIT_ROLE_IDS);
const waitRole = (roleId: string): WaitRole | "stage" => (WAIT_ROLES.has(roleId) ? (roleId as WaitRole) : "stage");

/** The tab a stage reads as: its own number for a step, its source's for a conditional stage. */
function stageNumber(model: StageTabModel, stageId: string | null): number | null {
  const tab = model.tabs.find((candidate) => candidate.stage.id === stageId);
  if (!tab) return null;
  if (tab.kind === "step") return tab.number;
  if (tab.kind === "conditional") return model.tabs.find((candidate) => candidate.stage.id === tab.anchor)?.number ?? null;
  return null;
}

export function laneWaitsOn(t: TFunction, summary: KanbanPipeline, model: StageTabModel, nowMs: number, options: {
  nameOf: (stage: PipelineStage) => string;
  clock: (ms: number) => string;
}): WaitsOn {
  const { pipeline, views } = summary;
  const lane = laneState(pipeline);
  const { nameOf } = options;
  const ended = pipelineEnded(pipeline);
  const stageId = ended ? null : screenCurrentStageId(summary) ?? pipeline.cursor?.stageId ?? null;
  const stage = stageId ? pipeline.stages.find((candidate) => candidate.id === stageId) ?? null : null;
  const number = stageNumber(model, stageId);
  const position = model.showStrip && number !== null ? t("kanban.stages.position", { k: number, n: model.steps }) : null;
  const since = lane.sinceMs === null ? "" : humanizeDuration(Math.max(0, (nowMs - lane.sinceMs) / 1000));
  const state: CardState = { owner: lane.owner, subject: { kind: "lane", lane }, lanes: [lane], sinceMs: lane.sinceMs };
  const popover = cardStatePopover(t, state, since).replace(/\s+$/, "");
  const lead = (words: string): string => [position, words].filter(Boolean).join(" · ");
  const said = (words: string, detail = popover): WaitsOn => ({ owner: lane.owner, words, detail, stageId });

  /* A stop someone owes an answer to: the stop's own reason, not the stage chips', which read a passed stage as done. */
  if ((lane.owner === "you" || lane.owner === "seat") && lane.stop) {
    return said(t(lane.owner === "you" ? "cardState.you.lane" : "cardState.seat.lane", { why: laneStopWhy(t, pipeline, lane.stop) }));
  }
  if (lane.owner === "you" || lane.owner === "seat") return said(cardStateText(t, state, options.clock) ?? t(lane.owner === "you" ? "cardState.you.plain" : "cardState.seat.plain"));
  const provider = currentProviderWait(pipeline);
  if (provider) {
    const reason = pipelineReason(t, pipeline, nameOf) ?? t("pipelinePresentation.waiting");
    return said(lead(reason), reason);
  }
  if (pipeline.state === "paused") {
    const reason = pipeline.pause?.reason?.trim();
    return said(lead(reason ? t("kanban.stages.waits.pausedWhy", { reason }) : t("kanban.stages.waits.paused")), popover);
  }
  const cpu = parseCpuQueueDetail(pipeline.stateDetail);
  if (cpu) {
    const words = t(cpu.stalled ? "kanban.progress.cpuQueueStalled" : cpu.heldBy === "pressure" ? "kanban.progress.cpuPressure" : "kanban.progress.cpuQueue", {
      position: cpu.position,
      ordinal: ordinal(cpu.position),
      minutes: cpu.minutes,
      priority: t(`kanban.priority.${cpu.priority ?? "normal"}`),
    });
    return said(stage ? `${nameOf(stage)} · ${words}` : words, words);
  }
  if (pipeline.state === "provisioning") return said(t("kanban.progress.provisioning"));
  if (pipeline.state === "draft") return said(t("pipelinePresentation.waiting"));
  if (ended || pipeline.state === "needs_review" || lane.owner === "done" || lane.owner === "waiting") {
    const words = cardStateText(t, state, options.clock);
    if (words) return said(words);
    return said(t("cardState.done.plain"));
  }
  /* A stage's agent works. */
  const view = stage ? views.get(stage.id) : undefined;
  if (stage && view?.state === "committing") return said(lead(t("kanban.stages.waits.publishing", { stage: nameOf(stage) })));
  if (stage) {
    const roleId = stage.role?.roleId ?? (stage.kind === "review-loop" ? "reviewer" : "builder");
    const wait = waitRole(roleId);
    const who = t(`kanban.stages.waits.role.${wait}`);
    const ahead = stage.next ? pipeline.stages.find((candidate) => candidate.id === stage.next) ?? null : null;
    const words = t("kanban.stages.waits.on", { who, stage: nameOf(stage) });
    const detail = t(ahead ? "kanban.stages.waits.popWorking" : "kanban.stages.waits.popWorkingLast", {
      who: t(`kanban.stages.waits.roleNominative.${wait}`),
      stage: nameOf(stage),
      age: since ? t("kanban.stages.waits.age", { age: since }) : "",
      next: ahead ? nameOf(ahead) : "",
    }).replace(/\s{2,}/g, " ");
    return said(lead(words), detail);
  }
  return said(popover);
}
