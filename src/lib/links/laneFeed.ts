/**
 * Lane rows: the owner's pipelines of a linked task, as one small bounded row
 * each, riding in the agents part of `boards/sync` (docs/design/synced-task-card.md §3).
 * Every string in a row is an identifier of at most 64 ASCII characters; no
 * prompt, spec, finding text, summary, path or conversation id is ever read
 * into one.
 */
import { summarizePipeline } from "@/components/kanban/pipelineSummary";
import { pipelineMovedAtMs, stageFindings } from "@/lib/pipelines/laneReads";
import { stageIdentity } from "@/components/kanban/stageIdentity";
import { MAX_PIPELINE_STAGES, MAX_STAGE_REPORT_FINDINGS } from "@/lib/pipelines/limits";
import type { Pipeline } from "@/lib/pipelines/types";
import type { StageChipState } from "@/lib/pipelines/stageChip";
import type { BoardTask } from "@/lib/tasks/types";

export type LaneState = "provisioning" | "running" | "needs_decision" | "needs_review" | "paused" | "completed" | "closed";
export type LaneStage = {
  id: string; st: StageChipState;
  ro?: string; lp?: 1; n?: number; r?: number; b?: 1;
  f?: { to: string; max: number; u: number };
  fc?: number; e?: string; m?: string;
};
export type LaneRow = { k: string; p: string; tk: string[]; s: LaneState; at: number; g: LaneStage[] };

export const MAX_LANE_ROW_BYTES = 4_096;
export const MAX_LANES_PER_TASK = 3;
export const MAX_LANE_ROWS = 200;

const PROJECT = /^repo-[0-9a-f]{32}$/;
const KEY = /^l:[0-9a-f]{8}$/;
const STAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IDENT = /^[a-zA-Z0-9._-]{1,64}$/;
const TASK_ID = /^[0-9a-f-]{36}$/;
const LANE_STATES: ReadonlySet<string> = new Set<LaneState>(["provisioning", "running", "needs_decision", "needs_review", "paused", "completed", "closed"]);
const CHIP_STATES: ReadonlySet<string> = new Set<StageChipState>(["pending", "running", "reviewing", "committing", "passed", "failed", "needs_decision", "skipped"]);
const ENDED: ReadonlySet<string> = new Set(["completed", "closed"]);

export const isLaneKey = (key: unknown): key is string => typeof key === "string" && KEY.test(key);
const within = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const bytes = (row: unknown) => Buffer.byteLength(JSON.stringify(row));

/** One lane as its row, or null when it cannot be published whole. */
function encodeLane(pipeline: Pipeline, project: string, taskIds: string[]): LaneRow | null {
  if (!/^[0-9a-f]{8}$/.test(pipeline.id) || !LANE_STATES.has(pipeline.state)) return null;
  const at = pipelineMovedAtMs(pipeline);
  if (at === null || !Number.isSafeInteger(at) || at < 0) return null;
  if (!pipeline.stages.length || pipeline.stages.length > MAX_PIPELINE_STAGES) return null;
  const ids = pipeline.stages.map((stage) => stage.id);
  if (!ids.every((id) => STAGE_ID.test(id)) || new Set(ids).size !== ids.length) return null;
  const summary = summarizePipeline(pipeline);
  const fired = new Map(summary.loops.map((loop) => [loop.from.id, loop.fired] as const));
  const g: LaneStage[] = summary.chips.map((chip) => {
    const { stage } = chip;
    const attempts = summary.views.get(stage.id)?.attempts ?? 0;
    const findings = Math.min(stageFindings(pipeline, stage.id).length, MAX_STAGE_REPORT_FINDINGS);
    const who = stageIdentity(pipeline, stage);
    const edge = stage.onFail;
    return {
      id: stage.id,
      ...(stage.role?.roleId && STAGE_ID.test(stage.role.roleId) ? { ro: stage.role.roleId } : {}),
      ...(stage.kind === "review-loop" ? { lp: 1 as const } : {}),
      st: chip.state,
      ...(attempts > 0 ? { n: Math.min(attempts, 999) } : {}),
      ...(chip.rounds > 0 ? { r: Math.min(chip.rounds, 999) } : {}),
      ...(chip.branch ? { b: 1 as const } : {}),
      ...(edge?.to && ids.includes(edge.to) ? { f: { to: edge.to, max: Math.min(Math.max(edge.maxRounds, 1), 99), u: Math.min(fired.get(stage.id) ?? 0, 99) } } : {}),
      ...(findings > 0 ? { fc: findings } : {}),
      ...(IDENT.test(who.engine) ? { e: who.engine } : {}),
      ...(IDENT.test(who.model) ? { m: who.model } : {}),
    };
  });
  const row: LaneRow = { k: `l:${pipeline.id}`, p: project, tk: taskIds, s: pipeline.state as LaneState, at, g };
  return bytes(row) > MAX_LANE_ROW_BYTES ? null : row;
}

/**
 * The lane rows one link publishes: every started lane of a task that runs
 * here, in a project linked over the link. At most three a task and 200 in all,
 * open lanes before ended ones, then the newest, then the id.
 */
export function laneRowsFor(
  pipelines: () => readonly Pipeline[], tasks: readonly BoardTask[], projects: ReadonlySet<string>, owns: (task: BoardTask) => boolean,
): LaneRow[] {
  const eligible = tasks.filter((task) => projects.has(task.project) && PROJECT.test(task.project) && TASK_ID.test(task.id) && owns(task));
  if (!eligible.length) return [];
  const byId = new Map(eligible.map((task) => [task.id, task] as const));
  const candidates: LaneRow[] = [];
  for (const pipeline of pipelines()) {
    if (pipeline.state === "draft") continue;
    const served = pipeline.taskIds.flatMap((id) => byId.get(id) ?? []);
    const first = served[0];
    if (!first) continue;
    const taskIds = [...new Set(served.filter((task) => task.project === first.project).map((task) => task.id))].slice(0, 4);
    const row = encodeLane(pipeline, first.project, taskIds);
    if (row) candidates.push(row);
  }
  candidates.sort((a, b) => Number(ENDED.has(a.s)) - Number(ENDED.has(b.s)) || b.at - a.at || a.k.localeCompare(b.k));
  const perTask = new Map<string, number>();
  const kept: LaneRow[] = [];
  for (const row of candidates) {
    if (kept.length === MAX_LANE_ROWS) break;
    if (!row.tk.some((id) => (perTask.get(id) ?? 0) < MAX_LANES_PER_TASK)) continue;
    for (const id of row.tk) perTask.set(id, (perTask.get(id) ?? 0) + 1);
    kept.push(row);
  }
  return kept;
}

/** A received row projected onto the keys above, or null when any bound fails. */
export function decodeLaneRow(value: unknown, projects: ReadonlySet<string>): LaneRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || bytes(value) > MAX_LANE_ROW_BYTES) return null;
  const row = value as Record<string, unknown>;
  if (!isLaneKey(row.k) || typeof row.p !== "string" || !PROJECT.test(row.p) || !projects.has(row.p)) return null;
  if (!Array.isArray(row.tk) || !within(row.tk.length, 1, 4) || !row.tk.every((id) => typeof id === "string" && TASK_ID.test(id))) return null;
  if (typeof row.s !== "string" || !LANE_STATES.has(row.s) || !Number.isSafeInteger(row.at) || (row.at as number) < 0) return null;
  if (!Array.isArray(row.g) || !within(row.g.length, 1, MAX_PIPELINE_STAGES)) return null;
  const stages = row.g as Record<string, unknown>[];
  if (!stages.every((stage) => stage && typeof stage === "object" && !Array.isArray(stage) && typeof stage.id === "string" && STAGE_ID.test(stage.id))) return null;
  const ids = new Set(stages.map((stage) => stage.id as string));
  if (ids.size !== stages.length) return null;
  const g: LaneStage[] = [];
  for (const stage of stages) {
    if (typeof stage.st !== "string" || !CHIP_STATES.has(stage.st)) return null;
    if (stage.ro !== undefined && (typeof stage.ro !== "string" || !STAGE_ID.test(stage.ro))) return null;
    if (stage.lp !== undefined && stage.lp !== 1) return null;
    if (stage.n !== undefined && !within(stage.n, 1, 999)) return null;
    if (stage.r !== undefined && !within(stage.r, 1, 999)) return null;
    if (stage.b !== undefined && stage.b !== 1) return null;
    if (stage.fc !== undefined && !within(stage.fc, 1, MAX_STAGE_REPORT_FINDINGS)) return null;
    if (stage.e !== undefined && (typeof stage.e !== "string" || !IDENT.test(stage.e))) return null;
    if (stage.m !== undefined && (typeof stage.m !== "string" || !IDENT.test(stage.m))) return null;
    const edge = stage.f as Record<string, unknown> | undefined;
    if (edge !== undefined && (!edge || typeof edge !== "object" || typeof edge.to !== "string" || !ids.has(edge.to) || !within(edge.max, 1, 99) || !within(edge.u, 0, 99))) return null;
    g.push({
      id: stage.id as string, st: stage.st as StageChipState,
      ...(stage.ro !== undefined ? { ro: stage.ro as string } : {}), ...(stage.lp ? { lp: 1 as const } : {}),
      ...(stage.n !== undefined ? { n: stage.n as number } : {}), ...(stage.r !== undefined ? { r: stage.r as number } : {}), ...(stage.b ? { b: 1 as const } : {}),
      ...(edge ? { f: { to: edge.to as string, max: edge.max as number, u: edge.u as number } } : {}),
      ...(stage.fc !== undefined ? { fc: stage.fc as number } : {}),
      ...(stage.e !== undefined ? { e: stage.e as string } : {}), ...(stage.m !== undefined ? { m: stage.m as string } : {}),
    });
  }
  return { k: row.k, p: row.p, tk: [...row.tk as string[]], s: row.s as LaneState, at: row.at as number, g };
}
