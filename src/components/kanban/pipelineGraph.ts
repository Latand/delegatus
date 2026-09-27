import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineEdgeKind, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import { edgeRoundsUsed } from "@/lib/pipelines/failEdgeBudget";
import { LIVE_ATTEMPT_STATES, latestAttempt, pipelineCursorActive, stageAttempts, stageChipState, type StageChipState } from "@/components/pipelines/pipelineModel";

/**
 * The stage graph a kanban card draws for its pipeline (#1695 K5a), ported from
 * the approved prototype's `graph.js`: the same topology, the same choice of
 * direction for the width available, the same orthogonal routes. Only the
 * record it reads is the product's: a stage's state is `stageChipState`, a
 * fired edge is counted from attempt `activatedBy` provenance, and review
 * rounds are the bound flow's own rounds. Nothing here is a counter the board
 * keeps.
 *
 * One rule for which attempts count, the engine's: a lineage-adopted
 * (`historical`) attempt is evidence a stage agent brought in, never the stage's
 * own work. It does not spend a retry, is not the latest attempt, is not counted
 * as an attempt and never marks an edge travelled. Its conversation stays
 * reachable, listed as a helper conversation.
 *
 * Pure: no DOM, no React. `PipelineSection.tsx` draws what this returns.
 */

export type GraphTone = "idle" | "active" | "review" | "ok" | "bad" | "needs";

export const STAGE_TONE: Record<StageChipState, GraphTone> = {
  pending: "idle",
  skipped: "idle",
  running: "active",
  committing: "active",
  reviewing: "review",
  passed: "ok",
  failed: "bad",
  needs_decision: "needs",
};

const LIVE_CHIPS: ReadonlySet<StageChipState> = new Set(["running", "reviewing", "committing", "needs_decision"]);

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: PipelineEdgeKind;
  /** The fail edge's retry budget; null on a pass edge. */
  maxRounds: number | null;
}

export function graphEdges(pipeline: Pick<Pipeline, "stages">): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const stage of pipeline.stages) {
    if (stage.next) edges.push({ id: `${stage.id}:pass:${stage.next}`, from: stage.id, to: stage.next, kind: "pass", maxRounds: null });
    if (stage.onFail?.to) edges.push({ id: `${stage.id}:fail:${stage.onFail.to}`, from: stage.id, to: stage.onFail.to, kind: "fail", maxRounds: stage.onFail.maxRounds });
  }
  return edges;
}

/** A stage's own attempts, in order: every attempt that is not lineage-adopted evidence. */
export function operationalAttempts(pipeline: Pipeline, stageId: string): PipelineStageAttempt[] {
  return stageAttempts(pipeline, stageId).filter((attempt) => !attempt.historical);
}

/** Which of the stage's own attempts attempt `n` is, counted from 1: the number
    every caption shows. The engine's `n` also counts the helper conversations
    it adopted, so it stays the key and never reaches a label. An attempt the
    record does not list as the stage's own keeps its `n`. */
export function attemptOrdinal(pipeline: Pipeline, stageId: string, n: number): number {
  const index = operationalAttempts(pipeline, stageId).findIndex((attempt) => attempt.n === n);
  return index >= 0 ? index + 1 : n;
}

/** How many times an edge fired: the distinct source attempts that activated
    its target. For a fail edge this is the engine's own spent retry budget,
    read from the engine's own function. */
export function edgeFired(pipeline: Pipeline, edge: Pick<GraphEdge, "from" | "to" | "kind">): number {
  return edgeRoundsUsed(pipeline, edge);
}

/** The attempts that should mark an edge live when they first appear: the
    stage's own attempts, each keyed once, with the edge that activated it. */
export function attemptArrivals(pipeline: Pipeline): Array<{ key: string; edgeId: string | null }> {
  return pipeline.runs.flatMap((run) => run.attempts
    .filter((attempt) => !attempt.historical)
    .map((attempt) => ({
      key: `${run.stageId}#${attempt.n}`,
      edgeId: attempt.activatedBy ? `${attempt.activatedBy.stageId}:${attempt.activatedBy.edge}:${run.stageId}` : null,
    })));
}

export interface ReviewRound {
  n: number;
  verdict: "approved" | "changes" | "open";
}

export interface StageView {
  state: StageChipState;
  /** A settled stage the lane will run again: it lies on the path ahead of
      the cursor, so it waits for its next attempt. */
  again: boolean;
  /** The state of the attempt that `again` set aside. */
  previous: StageChipState | null;
  attempts: number;
  attempt: PipelineStageAttempt | null;
  /** The review rounds of the stage's bound flow, in order. */
  rounds: ReviewRound[];
  /** The latest attempt settled and its conversation is working again (#1744):
      someone sent it more work after the stage reported. */
  rework: boolean;
}

/** Transcript paths and conversation ids whose board row is working, the
    same reading the card's «N working» counts. */
export type WorkingConversations = ReadonlySet<string>;

export function roundsOf(attempt: PipelineStageAttempt | null, flowsById: ReadonlyMap<string, Flow>): ReviewRound[] {
  const flow = attempt?.flowId ? flowsById.get(attempt.flowId) : undefined;
  if (!flow) return [];
  return flow.rounds.map((round) => ({
    n: round.n,
    verdict: round.verdict === "APPROVE" ? "approved" : round.verdict === "REQUEST_CHANGES" ? "changes" : "open",
  }));
}

const ENDED_STATES: ReadonlySet<Pipeline["state"]> = new Set(["completed", "closed", "needs_review"]);

/**
 * The stages the lane will start again, in the order it reaches them: from the
 * cursor, the stage the engine starts on a pass (`passSuccessor`): its `next`,
 * except after a fix that ran on a spent fail edge's handoff, which follows the
 * failing stage's `next`. A lane with no cursor (completed, closed, waiting for
 * review) has nothing ahead. The cursor stage itself is ahead only while the
 * lane is busy and its latest attempt is settled: the engine has moved onto it
 * and the new attempt is not recorded yet.
 */
export function pathAhead(pipeline: Pipeline): Set<string> {
  const ahead = new Set<string>();
  const cursor = pipeline.cursor;
  if (!cursor || ENDED_STATES.has(pipeline.state)) return ahead;
  const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage] as const));
  const stage = byId.get(cursor.stageId);
  if (!stage) return ahead;
  const latest = latestAttempt(pipeline, stage.id);
  const settled = !latest || !LIVE_CHIPS.has(stageChipState(pipeline, stage));
  if (pipelineCursorActive(pipeline) && settled && latest) ahead.add(stage.id);
  const activation = cursor.activatedBy ?? latest?.activatedBy ?? null;
  const handoff = activation?.edge === "fail" && activation.budgetSpent ? byId.get(activation.stageId) : undefined;
  let next: string | null = handoff ? handoff.next : stage.next;
  while (next && !ahead.has(next) && byId.has(next)) {
    ahead.add(next);
    next = byId.get(next)!.next;
  }
  return ahead;
}

export function stageViews(pipeline: Pipeline, flowsById: ReadonlyMap<string, Flow> = new Map(), working: WorkingConversations = new Set()): Map<string, StageView> {
  const ahead = pathAhead(pipeline);
  const views = new Map<string, StageView>();
  for (const stage of pipeline.stages) {
    const attempt = latestAttempt(pipeline, stage.id);
    const state = stageChipState(pipeline, stage);
    const attempts = operationalAttempts(pipeline, stage.id).length;
    const rounds = stage.kind === "review-loop" ? roundsOf(attempt, flowsById) : [];
    /* A stage the lane waits on is where it stands, whatever lies ahead. */
    const settled = Boolean(attempt) && !LIVE_CHIPS.has(state);
    /* Rework reads the attempt's own state: an attempt parked on a decision
       has ended, and its conversation working again is rework too. */
    const ended = Boolean(attempt) && !LIVE_ATTEMPT_STATES.has(attempt!.state);
    const rework = ended && Boolean((attempt!.agentPath && working.has(attempt!.agentPath)) || (attempt!.conversationId && working.has(attempt!.conversationId)));
    views.set(stage.id, settled && !rework && ahead.has(stage.id)
      ? { state: "pending", again: true, previous: state, attempts, attempt, rounds: [], rework: false }
      : { state, again: false, previous: null, attempts, attempt, rounds, rework });
  }
  return views;
}

/* ── Loops: a fail edge folds into its source (docs/design/pipeline-graph-loops.md §3.1) ─ */

/**
 * - `dock`: the target is a dedicated fix stage: nothing passes into it, only
 *   this fail edge reaches it, it has no fail edge of its own, and its pass
 *   goes back to the source, on to the source's `next`, or nowhere. It draws
 *   as a strip under its source and takes no column.
 * - `self`: the stage retries itself.
 * - `return`: the target is an earlier stage of the pass chain.
 * - `other`: anything else keeps a wire.
 */
export type LoopShape = "dock" | "return" | "self" | "other";

export function loopShapes(pipeline: Pick<Pipeline, "stages">): Map<string, LoopShape> {
  const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage] as const));
  const passTargets = new Set(pipeline.stages.flatMap((stage) => (stage.next ? [stage.next] : [])));
  const failSources = new Map<string, number>();
  for (const stage of pipeline.stages) if (stage.onFail?.to) failSources.set(stage.onFail.to, (failSources.get(stage.onFail.to) ?? 0) + 1);
  const passReach = (from: string, to: string) => {
    const seen = new Set<string>();
    let current: string | null = from;
    while (current && !seen.has(current)) {
      if (current === to) return true;
      seen.add(current);
      current = byId.get(current)?.next ?? null;
    }
    return false;
  };
  const shapes = new Map<string, LoopShape>();
  for (const source of pipeline.stages) {
    const to = source.onFail?.to;
    if (!to) continue;
    const id = `${source.id}:fail:${to}`;
    const target = byId.get(to);
    if (!target) continue;
    if (to === source.id) shapes.set(id, "self");
    else if (
      !passTargets.has(to)
      && failSources.get(to) === 1
      && !target.onFail
      && pipeline.stages[0]?.id !== to
      && (target.next === null || target.next === source.id || target.next === source.next)
    ) shapes.set(id, "dock");
    else if (passReach(to, source.id)) shapes.set(id, "return");
    else shapes.set(id, "other");
  }
  return shapes;
}

/* ── Topology: back edges, layers, rows ───────────────────────────────────── */

export interface GraphLoop {
  edge: GraphEdge;
  shape: Exclude<LoopShape, "other">;
}

export interface GraphTopology {
  /** Every edge the pipeline declares. */
  edges: GraphEdge[];
  /** The edges drawn as wires: pass edges between units and `other` fail edges. */
  wires: GraphEdge[];
  back: Set<string>;
  layer: Map<string, number>;
  row: Map<string, number>;
  branching: Set<string>;
  layers: number;
  rows: number;
  shapes: Map<string, LoopShape>;
  /** A docked fix stage, by id, and the source it docks on. */
  docked: Map<string, string>;
  /** The loop each source folds, by source id. */
  loops: Map<string, GraphLoop>;
}

export function graphTopology(pipeline: Pick<Pipeline, "stages">): GraphTopology {
  const edges = graphEdges(pipeline);
  const shapes = loopShapes(pipeline);
  const docked = new Map<string, string>();
  const loops = new Map<string, GraphLoop>();
  for (const edge of edges) {
    const shape = shapes.get(edge.id);
    if (edge.kind !== "fail" || !shape || shape === "other") continue;
    loops.set(edge.from, { edge, shape });
    if (shape === "dock") docked.set(edge.to, edge.from);
  }
  /* A docked stage's own pass joins its source's unit: back into it, or on to
     where the source's pass goes, which the unit's outgoing wire carries. */
  const wires = edges.filter((edge) => edge.kind === "pass" ? !docked.has(edge.from) : shapes.get(edge.id) === "other");
  const ids = pipeline.stages.map((stage) => stage.id).filter((id) => !docked.has(id));
  const out = new Map(ids.map((id) => [id, [] as GraphEdge[]] as const));
  /* Pass edges first, so the pass chain defines "forward". */
  for (const edge of [...wires.filter((e) => e.kind === "pass"), ...wires.filter((e) => e.kind === "fail")]) out.get(edge.from)?.push(edge);
  const hasIncomingPass = new Set(wires.filter((edge) => edge.kind === "pass").map((edge) => edge.to));
  const roots = ids.filter((id) => !hasIncomingPass.has(id));
  const color = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const visit = (id: string) => {
    color.set(id, 1);
    for (const edge of out.get(id) ?? []) {
      const seen = color.get(edge.to);
      if (seen === 1) back.add(edge.id);
      else if (!seen && out.has(edge.to)) visit(edge.to);
    }
    color.set(id, 2);
  };
  for (const root of roots.length ? roots : ids.slice(0, 1)) if (!color.has(root)) visit(root);
  for (const id of ids) if (!color.has(id)) visit(id);

  const forward = wires.filter((edge) => !back.has(edge.id) && out.has(edge.to));
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const edge of forward) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  const queue = ids.filter((id) => indegree.get(id) === 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of forward.filter((candidate) => candidate.from === id)) {
      layer.set(edge.to, Math.max(layer.get(edge.to) ?? 0, (layer.get(id) ?? 0) + 1));
      indegree.set(edge.to, (indegree.get(edge.to) ?? 1) - 1);
      if (indegree.get(edge.to) === 0) queue.push(edge.to);
    }
  }
  /* The main pass path keeps row 0; anything reached another way steps aside. */
  const main = new Set<string>();
  const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage] as const));
  let current: string | null = roots[0] ?? ids[0] ?? null;
  while (current && !main.has(current) && byId.has(current) && !docked.has(current)) {
    main.add(current);
    current = byId.get(current)?.next ?? null;
  }
  const row = new Map<string, number>();
  const taken = new Map<number, Set<number>>();
  const order = [...ids].sort((a, b) => (layer.get(a) ?? 0) - (layer.get(b) ?? 0) || ids.indexOf(a) - ids.indexOf(b));
  for (const id of order) {
    const at = layer.get(id) ?? 0;
    const used = taken.get(at) ?? new Set<number>();
    let r = main.has(id) ? 0 : 1;
    while (used.has(r)) r += 1;
    used.add(r);
    taken.set(at, used);
    row.set(id, r);
  }
  /* A docked stage stands where its source stands. */
  for (const [fix, source] of docked) {
    layer.set(fix, layer.get(source) ?? 0);
    row.set(fix, row.get(source) ?? 0);
  }
  const branching = new Set(ids.filter((id) => (out.get(id) ?? []).length > 1));
  return {
    edges,
    wires,
    back,
    layer,
    row,
    branching,
    layers: Math.max(0, ...ids.map((id) => layer.get(id) ?? 0)) + 1,
    rows: Math.max(0, ...ids.map((id) => row.get(id) ?? 0)) + 1,
    shapes,
    docked,
    loops,
  };
}

/** Stages in graph order: by layer, then row, each docked fix stage right after its source. */
export function graphOrder(pipeline: Pick<Pipeline, "stages">, topology: GraphTopology = graphTopology(pipeline)): PipelineStage[] {
  const units = pipeline.stages
    .filter((stage) => !topology.docked.has(stage.id))
    .sort((a, b) => (topology.layer.get(a.id) ?? 0) - (topology.layer.get(b.id) ?? 0) || (topology.row.get(a.id) ?? 0) - (topology.row.get(b.id) ?? 0));
  return units.flatMap((stage) => {
    const loop = topology.loops.get(stage.id);
    const fix = loop?.shape === "dock" ? pipeline.stages.find((candidate) => candidate.id === loop.edge.to) : undefined;
    return fix ? [stage, fix] : [stage];
  });
}

/** The stages whose passes the wire leaving a unit carries: the source and the
    fix stage docked on it, whose pass after a spent budget continues the lane. */
export function unitMembers(topology: GraphTopology, stageId: string): string[] {
  const loop = topology.loops.get(stageId);
  return loop?.shape === "dock" ? [stageId, loop.edge.to] : [stageId];
}

/** How often a wire fired: every attempt of its target a member of the source's
    unit activated along that kind of edge. */
export function wireFired(pipeline: Pipeline, topology: GraphTopology, edge: Pick<GraphEdge, "from" | "to" | "kind">): number {
  if (edge.kind === "fail") return edgeRoundsUsed(pipeline, edge);
  return unitMembers(topology, edge.from).reduce((sum, from) => sum + edgeRoundsUsed(pipeline, { from, to: edge.to, kind: "pass" }), 0);
}

/** Whether a source draws its loop strip. A retry in place draws one only once it fired. */
export function drawsStrip(pipeline: Pick<Pipeline, "stages"> & Partial<Pick<Pipeline, "runs">>, loop: GraphLoop | undefined): boolean {
  if (!loop) return false;
  if (loop.shape !== "self") return true;
  return Boolean(pipeline.runs) && edgeRoundsUsed(pipeline as Pipeline, loop.edge) > 0;
}

/* ── Geometry ─────────────────────────────────────────────────────────────── */

const NODE_H = 76;
const LR = { W: 176, gx: 68, gy: 30, pad: 18, lane: 22 };
const TB = { gy: 46, pad: 12, lane: 20, laneGap: 22, labelW: 84, minW: 132, maxW: 268 };
/** The loop strip under a node: 28 px, 44 px where the pointer is a finger. */
export const STRIP_H = { fine: 28, coarse: 44 } as const;

export interface GraphBox { x: number; y: number; w: number; h: number }

export interface GraphStrip {
  loop: GraphLoop;
  box: GraphBox;
}

export interface GraphLayout {
  dir: "LR" | "TB";
  topology: GraphTopology;
  /** The node of every stage that is not docked. */
  nodes: Map<string, GraphBox>;
  /** The loop strip under a node, by the source's id. */
  strips: Map<string, GraphStrip>;
  lanes: Array<{ id: string; pos: number }>;
  width: number;
  height: number;
}

/** Choose a layout for the width available. Text never shrinks: when
    left-to-right does not fit, the graph turns top-to-bottom, one column of
    units never wider than the width it has. */
export function layoutGraph(
  pipeline: Pick<Pipeline, "stages"> & Partial<Pick<Pipeline, "runs">>,
  available: number,
  force?: "LR" | "TB",
  options: { coarse?: boolean } = {},
): GraphLayout {
  const topology = graphTopology(pipeline);
  const stripH = options.coarse ? STRIP_H.coarse : STRIP_H.fine;
  const units = graphOrder(pipeline, topology).filter((stage) => !topology.docked.has(stage.id));
  const striped = new Set(units.filter((stage) => drawsStrip(pipeline, topology.loops.get(stage.id))).map((stage) => stage.id));
  const unitH = (id: string) => NODE_H + (striped.has(id) ? stripH : 0);
  const backWires = topology.wires.filter((edge) => topology.back.has(edge.id));
  const lrWidth = LR.pad * 2 + topology.layers * LR.W + (topology.layers - 1) * LR.gx + (backWires.length ? 16 : 0);
  const dir = force ?? (lrWidth <= available ? "LR" : "TB");
  const nodes = new Map<string, GraphBox>();
  const strips = new Map<string, GraphStrip>();
  let width: number;
  let height: number;
  let lanes: Array<{ id: string; pos: number }> = [];
  if (dir === "LR") {
    const pitch = Math.max(NODE_H, ...units.map((stage) => unitH(stage.id)));
    for (const stage of units) {
      nodes.set(stage.id, { x: LR.pad + (topology.layer.get(stage.id) ?? 0) * (LR.W + LR.gx), y: LR.pad + (topology.row.get(stage.id) ?? 0) * (pitch + LR.gy), w: LR.W, h: NODE_H });
    }
    const bottom = LR.pad + topology.rows * pitch + (topology.rows - 1) * LR.gy;
    lanes = backWires.map((edge, index) => ({ id: edge.id, pos: bottom + 26 + index * (LR.lane + 12) }));
    width = lrWidth;
    height = (lanes.length ? lanes[lanes.length - 1]!.pos + 22 : bottom) + LR.pad;
  } else {
    /* One column: a wire that does not run from one unit to the next takes a
       lane on the right, labelled beside it. */
    const index = new Map(units.map((stage, at) => [stage.id, at] as const));
    const laned = topology.wires.filter((edge) => (index.get(edge.to) ?? -1) !== (index.get(edge.from) ?? -2) + 1 || edge.kind === "fail");
    const laneSpace = laned.length ? TB.laneGap + laned.length * TB.lane + TB.labelW : 0;
    const w = Math.max(Math.min(available - TB.pad * 2 - laneSpace, TB.maxW), TB.minW);
    let y = TB.pad;
    for (const stage of units) {
      nodes.set(stage.id, { x: TB.pad, y, w, h: NODE_H });
      y += unitH(stage.id) + TB.gy;
    }
    lanes = laned.map((edge, at) => ({ id: edge.id, pos: TB.pad + w + TB.laneGap + at * TB.lane }));
    width = TB.pad * 2 + w + laneSpace;
    height = y - TB.gy + TB.pad;
  }
  for (const stage of units) {
    if (!striped.has(stage.id)) continue;
    const node = nodes.get(stage.id)!;
    strips.set(stage.id, { loop: topology.loops.get(stage.id)!, box: { x: node.x, y: node.y + node.h, w: node.w, h: stripH } });
  }
  return { dir, topology, nodes, strips, lanes, width, height };
}

/** An orthogonal polyline with rounded corners, as an SVG path. */
export function roundPath(points: ReadonlyArray<readonly [number, number]>, radius = 8): string {
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const [x0, y0] = points[index - 1]!;
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[index + 1]!;
    const d1 = Math.hypot(x1 - x0, y1 - y0);
    const d2 = Math.hypot(x2 - x1, y2 - y1);
    const k = Math.min(radius, d1 / 2, d2 / 2);
    const ax = x1 - ((x1 - x0) / (d1 || 1)) * k;
    const ay = y1 - ((y1 - y0) / (d1 || 1)) * k;
    const bx = x1 + ((x2 - x1) / (d2 || 1)) * k;
    const by = y1 + ((y2 - y1) / (d2 || 1)) * k;
    d += ` L${ax},${ay} Q${x1},${y1} ${bx},${by}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L${last[0]},${last[1]}`;
}

export interface EdgeRoute {
  d: string;
  label: [number, number];
  labelAxis: "h" | "v";
  /** The label sits beside a lane on the right rather than centred on the wire. */
  beside?: boolean;
}

export function routeEdge(layout: GraphLayout, edge: GraphEdge): EdgeRoute | null {
  const a = layout.nodes.get(edge.from);
  const b = layout.nodes.get(edge.to);
  if (!a || !b) return null;
  const branch = layout.topology.branching.has(edge.from);
  const back = layout.topology.back.has(edge.id);
  if (layout.dir === "LR") {
    const sy = a.y + (branch ? (edge.kind === "fail" ? a.h * 0.72 : a.h * 0.36) : a.h / 2);
    const sx = a.x + a.w;
    const tx = b.x;
    const ty = b.y + b.h / 2;
    if (back) {
      const lane = layout.lanes.find((candidate) => candidate.id === edge.id)!.pos;
      return { d: roundPath([[sx, sy], [sx + 18, sy], [sx + 18, lane], [tx - 18, lane], [tx - 18, ty], [tx - 2, ty]], 10), label: [(sx + tx) / 2, lane], labelAxis: "h" };
    }
    const mx = sx + (tx - sx) / 2;
    const points: Array<[number, number]> = Math.abs(sy - ty) < 1 ? [[sx, sy], [tx - 2, ty]] : [[sx, sy], [mx, sy], [mx, ty], [tx - 2, ty]];
    /* A skip edge rides above the row when a node sits in between. */
    const blocked = [...layout.nodes.entries()].some(([id, node]) => id !== edge.from && id !== edge.to && node.x > sx && node.x + node.w < tx && sy >= node.y - 4 && sy <= node.y + node.h + 4);
    if (blocked) {
      const top = Math.min(a.y, b.y) - 14;
      return { d: roundPath([[sx, sy], [sx + 14, sy], [sx + 14, top], [tx - 14, top], [tx - 14, ty], [tx - 2, ty]], 8), label: [(sx + tx) / 2, top], labelAxis: "h" };
    }
    return { d: roundPath(points, 10), label: [sx + Math.min(38, (tx - sx) / 2), sy], labelAxis: "h" };
  }
  /* Top-to-bottom: a pass to the next unit leaves the bottom of the unit;
     anything else runs in its lane on the right. */
  const lane = layout.lanes.find((candidate) => candidate.id === edge.id);
  if (lane) {
    const sx = a.x + a.w;
    const sy = a.y + a.h * (edge.kind === "fail" ? 0.66 : 0.5);
    const tx = b.x + b.w;
    const ty = b.y + b.h * 0.34;
    return { d: roundPath([[sx, sy], [lane.pos, sy], [lane.pos, ty], [tx + 2, ty]], 10), label: [lane.pos + 8, (sy + ty) / 2], labelAxis: "v", beside: true };
  }
  const bottom = a.y + a.h + (layout.strips.get(edge.from)?.box.h ?? 0);
  const x = a.x + a.w / 2;
  const ty = b.y;
  return { d: roundPath([[x, bottom], [x, ty - 2]], 10), label: [x, bottom + Math.min(22, (ty - bottom) / 2)], labelAxis: "v" };
}

/* ── Past attempts ────────────────────────────────────────────────────────── */

export interface PastAttempt {
  key: string;
  pipelineId: string;
  stageId: string;
  /** "attempt": a finished attempt of the stage; "round": a finished review round
      of one of its attempts; "helper": a conversation a stage agent brought in. */
  kind: "attempt" | "round" | "helper";
  n: number;
  /** How many own attempts the stage has, so a stage that ran once is named
      without a number. */
  of: number;
  /** For a round: the attempt whose review flow it belongs to. */
  attempt: number | null;
  /** Which of the stage's own attempts the row is, or whose round it is,
      counted from 1: the number its label shows. `n` and `attempt` stay the
      record's own numbers, which also count adopted helpers. Null for a helper. */
  ordinal: number | null;
  /** For a round: whether the stage has rounds under more than one attempt, so
      the label must name the attempt. */
  ambiguous: boolean;
  /** The attempt's state, or the round's verdict. */
  state: string;
  verdict: string | null;
  atMs: number;
  conversation: { path: string | null; conversationId: string | null };
}

/** Work still under way: the stage is not done with it. A needs_decision whose
    findings the engine routed along the fail edge (#1785) is settled — the same
    `decisionRequested` mark `stageChipState` reads — so it belongs in what the
    card has finished, with its open button and its verdict line. A genuinely
    parked decision carries no mark and is still the stage's live work. */
const ACTIVE_ATTEMPT = (attempt: PipelineStageAttempt) =>
  LIVE_ATTEMPT_STATES.has(attempt.state as never)
  || (attempt.state === "needs_decision" && !attempt.decisionRequested);

/**
 * What a card's pipelines have finished, newest first: every attempt that ended
 * (the latest one too, once it ended), every review round that reached a
 * verdict or belongs to an attempt that ended, and the helper conversations
 * stage agents brought in. Work under way is left out: the latest attempt while
 * it runs or waits on a decision nobody has routed, and its open round. Nothing
 * is listed twice.
 */
export function pastAttempts(pipelines: readonly Pipeline[], flowsById: ReadonlyMap<string, Flow>): PastAttempt[] {
  const rows: PastAttempt[] = [];
  const ms = (stamp: string | null | undefined) => {
    const value = stamp ? Date.parse(stamp) : Number.NaN;
    return Number.isFinite(value) ? value : 0;
  };
  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages) {
      const own = operationalAttempts(pipeline, stage.id);
      const latest = own.at(-1) ?? null;
      const reviewAttempts = stage.kind === "review-loop"
        ? own.filter((attempt) => attempt.flowId && (flowsById.get(attempt.flowId)?.rounds.length ?? 0) > 0)
        : [];
      for (const [index, attempt] of own.entries()) {
        const active = attempt === latest && ACTIVE_ATTEMPT(attempt);
        if (!active) {
          rows.push({
            key: `${pipeline.id}:${stage.id}:attempt:${attempt.n}`,
            pipelineId: pipeline.id,
            stageId: stage.id,
            kind: "attempt",
            n: attempt.n,
            of: own.length,
            attempt: null,
            ordinal: index + 1,
            ambiguous: false,
            state: attempt.state,
            verdict: attempt.verdict?.status ?? null,
            atMs: ms(attempt.completedAt ?? attempt.startedAt),
            conversation: { path: attempt.agentPath, conversationId: attempt.conversationId },
          });
        }
        const flow = stage.kind === "review-loop" && attempt.flowId ? flowsById.get(attempt.flowId) : undefined;
        for (const round of flow?.rounds ?? []) {
          if (active && round.verdict === null) continue;
          rows.push({
            key: `${pipeline.id}:${stage.id}:attempt:${attempt.n}:round:${round.n}`,
            pipelineId: pipeline.id,
            stageId: stage.id,
            kind: "round",
            n: round.n,
            of: own.length,
            attempt: attempt.n,
            ordinal: index + 1,
            ambiguous: reviewAttempts.length > 1,
            state: round.verdict ?? "open",
            verdict: null,
            atMs: ms(round.startedAt),
            conversation: { path: round.reviewerPath, conversationId: round.reviewerConversationId ?? null },
          });
        }
      }
      stageAttempts(pipeline, stage.id).filter((attempt) => attempt.historical).forEach((helper, index) => {
        rows.push({
          key: `${pipeline.id}:${stage.id}:helper:${helper.n}`,
          pipelineId: pipeline.id,
          stageId: stage.id,
          kind: "helper",
          /* Numbered among the stage's helper conversations, never as an attempt. */
          n: index + 1,
          of: own.length,
          attempt: null,
          ordinal: null,
          ambiguous: false,
          state: helper.state,
          verdict: helper.verdict?.status ?? null,
          atMs: ms(helper.completedAt ?? helper.startedAt),
          conversation: { path: helper.agentPath, conversationId: helper.conversationId },
        });
      });
    }
  }
  return rows.sort((a, b) => b.atMs - a.atMs || a.key.localeCompare(b.key));
}
