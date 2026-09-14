import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineEdgeKind, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import { LIVE_ATTEMPT_STATES, latestAttempt, stageAttempts, stageChipState, type StageChipState } from "@/components/pipelines/pipelineModel";

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

/** How many times an edge fired: the stage's own attempts of its target that it
    activated. For a fail edge this is the engine's spent retry budget. */
export function edgeFired(pipeline: Pipeline, edge: Pick<GraphEdge, "from" | "to" | "kind">): number {
  return operationalAttempts(pipeline, edge.to).filter((attempt) => attempt.activatedBy?.stageId === edge.from && attempt.activatedBy.edge === edge.kind).length;
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
  /** A stage an upstream stage ran again after: it waits for its next attempt. */
  again: boolean;
  /** The state of the attempt that `again` set aside. */
  previous: StageChipState | null;
  attempts: number;
  attempt: PipelineStageAttempt | null;
  /** The review rounds of the stage's bound flow, in order. */
  rounds: ReviewRound[];
}

function passPredecessors(pipeline: Pick<Pipeline, "stages">): Map<string, string[]> {
  const predecessors = new Map(pipeline.stages.map((stage) => [stage.id, [] as string[]] as const));
  for (const stage of pipeline.stages) if (stage.next) predecessors.get(stage.next)?.push(stage.id);
  return predecessors;
}

function upstreamOf(predecessors: ReadonlyMap<string, string[]>, stageId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(predecessors.get(stageId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || id === stageId) continue;
    seen.add(id);
    stack.push(...(predecessors.get(id) ?? []));
  }
  return seen;
}

const startedMs = (attempt: PipelineStageAttempt | null): number => {
  const ms = attempt?.startedAt ? Date.parse(attempt.startedAt) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NaN;
};

export function roundsOf(attempt: PipelineStageAttempt | null, flowsById: ReadonlyMap<string, Flow>): ReviewRound[] {
  const flow = attempt?.flowId ? flowsById.get(attempt.flowId) : undefined;
  if (!flow) return [];
  return flow.rounds.map((round) => ({
    n: round.n,
    verdict: round.verdict === "APPROVE" ? "approved" : round.verdict === "REQUEST_CHANGES" ? "changes" : "open",
  }));
}

export function stageViews(pipeline: Pipeline, flowsById: ReadonlyMap<string, Flow> = new Map()): Map<string, StageView> {
  const predecessors = passPredecessors(pipeline);
  const views = new Map<string, StageView>();
  for (const stage of pipeline.stages) {
    const attempt = latestAttempt(pipeline, stage.id);
    const state = stageChipState(pipeline, stage);
    const attempts = operationalAttempts(pipeline, stage.id).length;
    const rounds = stage.kind === "review-loop" ? roundsOf(attempt, flowsById) : [];
    const mine = startedMs(attempt);
    const newerUpstream = attempt && !LIVE_CHIPS.has(state) && Number.isFinite(mine)
      && [...upstreamOf(predecessors, stage.id)].some((id) => startedMs(latestAttempt(pipeline, id)) > mine);
    views.set(stage.id, newerUpstream
      ? { state: "pending", again: true, previous: state, attempts, attempt, rounds: [] }
      : { state, again: false, previous: null, attempts, attempt, rounds });
  }
  return views;
}

/* ── Topology: back edges, layers, rows ───────────────────────────────────── */

export interface GraphTopology {
  edges: GraphEdge[];
  back: Set<string>;
  layer: Map<string, number>;
  row: Map<string, number>;
  branching: Set<string>;
  layers: number;
  rows: number;
}

export function graphTopology(pipeline: Pick<Pipeline, "stages">): GraphTopology {
  const edges = graphEdges(pipeline);
  const ids = pipeline.stages.map((stage) => stage.id);
  const out = new Map(ids.map((id) => [id, [] as GraphEdge[]] as const));
  /* Pass edges first, so the pass chain defines "forward". */
  for (const edge of [...edges.filter((e) => e.kind === "pass"), ...edges.filter((e) => e.kind === "fail")]) out.get(edge.from)?.push(edge);
  const hasIncomingPass = new Set(edges.filter((edge) => edge.kind === "pass").map((edge) => edge.to));
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

  const forward = edges.filter((edge) => !back.has(edge.id) && out.has(edge.to));
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
  while (current && !main.has(current) && byId.has(current)) {
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
  const branching = new Set(ids.filter((id) => (out.get(id) ?? []).length > 1));
  return {
    edges,
    back,
    layer,
    row,
    branching,
    layers: Math.max(0, ...layer.values()) + 1,
    rows: Math.max(0, ...row.values()) + 1,
  };
}

/** Stages in graph order: by layer, then row. */
export function graphOrder(pipeline: Pick<Pipeline, "stages">, topology: GraphTopology = graphTopology(pipeline)): PipelineStage[] {
  return [...pipeline.stages].sort((a, b) => (topology.layer.get(a.id) ?? 0) - (topology.layer.get(b.id) ?? 0) || (topology.row.get(a.id) ?? 0) - (topology.row.get(b.id) ?? 0));
}

/* ── Geometry ─────────────────────────────────────────────────────────────── */

const LR = { W: 176, H: 76, gx: 68, gy: 30, pad: 18, lane: 22 };
const TB = { H: 76, gy: 46, gx: 16, pad: 12, lane: 20, laneGap: 22, minW: 176, maxW: 268, labelW: 104 };

export interface GraphBox { x: number; y: number; w: number; h: number }

export interface GraphLayout {
  dir: "LR" | "TB";
  topology: GraphTopology;
  nodes: Map<string, GraphBox>;
  lanes: Array<{ id: string; pos: number }>;
  width: number;
  height: number;
  /** Top-to-bottom too narrow for labels beside the return lane: numbered badges and a legend. */
  labelMode: "inline" | "legend";
}

/** Choose a layout for the width available. Text never shrinks: when
    left-to-right does not fit, the graph turns top-to-bottom. */
export function layoutGraph(pipeline: Pick<Pipeline, "stages">, available: number, force?: "LR" | "TB"): GraphLayout {
  const topology = graphTopology(pipeline);
  const backCount = topology.edges.filter((edge) => topology.back.has(edge.id)).length;
  const lrWidth = LR.pad * 2 + topology.layers * LR.W + (topology.layers - 1) * LR.gx + (backCount ? 16 : 0);
  const dir = force ?? (lrWidth <= available ? "LR" : "TB");
  const nodes = new Map<string, GraphBox>();
  let width: number;
  let height: number;
  let lanes: Array<{ id: string; pos: number }> = [];
  let labelMode: GraphLayout["labelMode"] = "inline";
  if (dir === "LR") {
    for (const stage of pipeline.stages) {
      nodes.set(stage.id, { x: LR.pad + (topology.layer.get(stage.id) ?? 0) * (LR.W + LR.gx), y: LR.pad + (topology.row.get(stage.id) ?? 0) * (LR.H + LR.gy), w: LR.W, h: LR.H });
    }
    const bottom = LR.pad + topology.rows * LR.H + (topology.rows - 1) * LR.gy;
    lanes = topology.edges.filter((edge) => topology.back.has(edge.id)).map((edge, index) => ({ id: edge.id, pos: bottom + 26 + index * (LR.lane + 12) }));
    width = lrWidth;
    height = (lanes.length ? lanes[lanes.length - 1]!.pos + 22 : bottom) + LR.pad;
  } else {
    const laneSpace = backCount ? TB.laneGap + backCount * TB.lane : 0;
    let w = Math.floor((available - TB.pad * 2 - (topology.rows - 1) * TB.gx - laneSpace - (backCount ? TB.labelW : 0)) / topology.rows);
    if (w < TB.minW && backCount) {
      labelMode = "legend";
      w = Math.floor((available - TB.pad * 2 - (topology.rows - 1) * TB.gx - laneSpace - 8) / topology.rows);
    }
    w = Math.max(Math.min(w, TB.maxW), 132);
    for (const stage of pipeline.stages) {
      nodes.set(stage.id, { x: TB.pad + (topology.row.get(stage.id) ?? 0) * (w + TB.gx), y: TB.pad + (topology.layer.get(stage.id) ?? 0) * (TB.H + TB.gy), w, h: TB.H });
    }
    const right = TB.pad + topology.rows * w + (topology.rows - 1) * TB.gx;
    lanes = topology.edges.filter((edge) => topology.back.has(edge.id)).map((edge, index) => ({ id: edge.id, pos: right + TB.laneGap + index * TB.lane }));
    width = right + laneSpace + (backCount && labelMode === "inline" ? TB.labelW : 8) + TB.pad;
    height = TB.pad * 2 + topology.layers * TB.H + (topology.layers - 1) * TB.gy;
  }
  return { dir, topology, nodes, lanes, width, height, labelMode };
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
  /* Top-to-bottom: pass leaves the bottom, fail leaves the right side. */
  if (edge.kind === "fail" || back) {
    const sx = a.x + a.w;
    const sy = a.y + a.h * (edge.kind === "fail" ? 0.66 : 0.5);
    const tx = b.x + b.w;
    const ty = b.y + b.h * 0.34;
    const lane = layout.lanes.find((candidate) => candidate.id === edge.id);
    if (lane) return { d: roundPath([[sx, sy], [lane.pos, sy], [lane.pos, ty], [tx + 2, ty]], 10), label: [lane.pos, (sy + ty) / 2], labelAxis: "v" };
    /* A forward fail branch into another column. */
    const bx = b.x + b.w / 2;
    return { d: roundPath([[sx, sy], [bx, sy], [bx, b.y - 2]], 10), label: [sx + (bx - sx) / 2, sy], labelAxis: "h" };
  }
  const sx = a.x + a.w / 2;
  const sy = a.y + a.h;
  const tx = b.x + b.w / 2;
  const ty = b.y;
  const my = sy + (ty - sy) / 2;
  const points: Array<[number, number]> = Math.abs(sx - tx) < 1 ? [[sx, sy], [tx, ty - 2]] : [[sx, sy], [sx, my], [tx, my], [tx, ty - 2]];
  return { d: roundPath(points, 10), label: [sx, sy + Math.min(22, (ty - sy) / 2)], labelAxis: "v" };
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
  /** For a round: the attempt whose review flow it belongs to. */
  attempt: number | null;
  /** For a round: whether the stage has rounds under more than one attempt, so
      the label must name the attempt. */
  ambiguous: boolean;
  /** The attempt's state, or the round's verdict. */
  state: string;
  verdict: string | null;
  atMs: number;
  conversation: { path: string | null; conversationId: string | null };
}

/** Work still under way: the stage is not done with it. */
const ACTIVE_ATTEMPT = (state: string) => LIVE_ATTEMPT_STATES.has(state as never) || state === "needs_decision";

/**
 * What a card's pipelines have finished, newest first: every attempt that ended
 * (the latest one too, once it ended), every review round that reached a
 * verdict or belongs to an attempt that ended, and the helper conversations
 * stage agents brought in. Work under way is left out: the latest attempt while
 * it runs or waits on a decision, and its open round. Nothing is listed twice.
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
      for (const attempt of own) {
        const active = attempt === latest && ACTIVE_ATTEMPT(attempt.state);
        if (!active) {
          rows.push({
            key: `${pipeline.id}:${stage.id}:attempt:${attempt.n}`,
            pipelineId: pipeline.id,
            stageId: stage.id,
            kind: "attempt",
            n: attempt.n,
            attempt: null,
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
            attempt: attempt.n,
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
          attempt: null,
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
