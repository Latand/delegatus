"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { roleNameById } from "@/components/builderCopy";
import { useLocale, type TFunction } from "@/lib/i18n";
import { edgeRoundsUsed, failEdgeExhaustion, failEdgeMaxRounds } from "@/lib/pipelines/failEdgeBudget";
import type { Pipeline, PipelineGraphEdit, PipelineStage, PipelineStageReportEntry, StageFinding } from "@/lib/pipelines/types";
import { attemptStateLabel, latestAttempt, pipelineReviewHeads, pipelineStateLabel, type StageChipState } from "@/components/pipelines/pipelineModel";

/* The stage-name rule lives beside `stageChipLabel` so the phone reads it
   without pulling a kanban component (#1865). */
export { stageDisplayName, stageNames } from "@/components/pipelines/pipelineModel";
import { fmtAge } from "@/components/utils";

import type { KanbanPipeline } from "./kanbanModel";
import { attemptArrivals, graphOrder, layoutGraph, routeEdge, STAGE_TONE, wireFired, type GraphEdge, type PastAttempt, type ReviewRound } from "./pipelineGraph";
import { stageIdentity, type EdgeCount } from "./stageIdentity";
import { CountCircle, engineWord, identityTitle, StageIdentity } from "./identityMarks";
import { STAGE_MARK } from "@/components/pipelines/pipelineBlockModel";
import { ChevronRight, svgProps } from "./kanbanGlyphs";
import { stageDraftable } from "./stagesModel";

/* The pieces of a pipeline the card's lane row (`PipelineBlock`, #2072) and
   the Stages sheet share: the stage graph, the stage report and graph-edit
   lines, the fail-edge suffix, and below the card's current work a quiet
   disclosure of what came before. */

export const GraphGlyph = () => (
  <svg {...svgProps}><rect x="3" y="4" width="6" height="5" rx="1.5" /><rect x="15" y="4" width="6" height="5" rx="1.5" /><rect x="9" y="15" width="6" height="5" rx="1.5" /><path d="M9 6.5h6M18 9v2.5a2 2 0 0 1-2 2h-1.5M6 9v2.5a2 2 0 0 0 2 2h1.5" /></svg>
);
export const ListGlyph = () => (
  <svg {...svgProps}><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" fill="currentColor" /><circle cx="3.5" cy="12" r="1" fill="currentColor" /><circle cx="3.5" cy="18" r="1" fill="currentColor" /></svg>
);

/* The role glyphs of the prototype; a role it has no glyph for draws the builder's. */
export const ROLE_GLYPH: Record<string, React.ReactNode> = {
  builder: <><path d="m14.7 6.3 3 3-8.4 8.4H6.3v-3z" /><path d="m13 8 3 3" /></>,
  reviewer: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  verifier: <><path d="M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6z" /><path d="m9 12 2 2 4-4" /></>,
  architect: <><circle cx="12" cy="5" r="2" /><path d="m11 7-5 13M13 7l5 13M8 15h8" /></>,
  cleaner: <><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="12" r="2" /><path d="M6 8v8M8 6c6 0 8 2 8 4" /></>,
};

const LIVE_CHIP_STATES = new Set<StageChipState>(["running", "reviewing", "committing"]);

/** How many findings of the card's ranked list it shows before counting. */
const SHOWN_STAGE_FINDINGS = 3;

/** Who acted, by role. The conversation id it used to carry is left out (#1765):
    a raw `conversation_<uuid>` names nothing the operator reads, and the
    conversation itself is one click away on the stage's own pill. */
function actorName(t: TFunction, actor: PipelineGraphEdit["actor"]): string {
  if (actor.kind === "operator") return t("kanban.graph.editedByOperator");
  return actor.role ? roleNameById(t, actor.role) : t("kanban.actor.agent");
}

/** The title a pipeline carries on a card: the first line of the task it was
    created with. An empty one falls back to the generic word. */
export function pipelineTitle(t: TFunction, pipeline: Pipeline): string {
  const first = (pipeline.task ?? "").split("\n").map((line) => line.trim()).find(Boolean);
  return first || t("kanban.pipeline");
}

/** The latest completion a stage reported for itself, with its findings in
    severity order (graph slice 2): the role that reported, its outcome and how
    long ago (#1765). */
export function StageReportLine({ pipeline, entry, names, shown = SHOWN_STAGE_FINDINGS }: {
  pipeline: Pipeline;
  entry: PipelineStageReportEntry;
  names: ReadonlyMap<string, string>;
  /** How many ranked findings it lists before counting the rest. */
  shown?: number;
}) {
  const { t } = useLocale();
  const attempt = pipeline.runs
    .find((run) => run.stageId === entry.stageId)?.attempts
    .find((candidate) => candidate.n === entry.attempt) ?? null;
  const findings: StageFinding[] = attempt?.report?.verdict.rankedFindings
    ?? attempt?.verdict?.rankedFindings
    ?? (attempt?.report?.verdict.findings ?? attempt?.verdict?.findings ?? []).map((text) => ({ severity: null, text }));
  const at = Date.parse(entry.at);
  return (
    <>
      <p
        className="stage-report"
        data-stage-report={entry.seq}
        data-stage-report-actor={entry.actor.kind}
        data-stage-report-status={entry.status}
        title={entry.summary ?? ""}
      >
        {t("kanban.stageReport.line", {
          who: entry.actor.kind === "agent" && entry.actor.role
            ? roleNameById(t, entry.actor.role)
            : names.get(entry.stageId) ?? entry.stageId,
          age: Number.isFinite(at) ? fmtAge(at / 1000) : "",
          outcome: t(`kanban.stageReport.outcome.${entry.status}`),
        })}
      </p>
      {findings.length ? (
        <ul className="stage-findings" data-stage-findings={findings.length}>
          {findings.slice(0, shown).map((finding, index) => (
            <li key={index} data-severity={finding.severity ?? "none"}>
              <span className="sev">{finding.severity ?? t("kanban.stageReport.unranked")}</span>
              <span className="text">{finding.text}</span>
            </li>
          ))}
          {findings.length > shown ? (
            <li className="more">{t("kanban.stageReport.moreFindings", { count: findings.length - shown })}</li>
          ) : null}
        </ul>
      ) : null}
    </>
  );
}

/** The latest graph edit, signed by whoever made it (graph slice 1). */
export function GraphEditLine({ edit }: { edit: PipelineGraphEdit }) {
  const { t } = useLocale();
  const who = actorName(t, edit.actor);
  const change = [
    t(`kanban.graph.edit.${edit.action}`, { stage: edit.stageId ?? "" }),
    edit.effect === "pending-next-attempt" && edit.appliesFromAttempt ? t("kanban.graph.edit.nextAttempt", { n: edit.appliesFromAttempt }) : null,
  ].filter(Boolean).join(" · ");
  const at = Date.parse(edit.at);
  return (
    <p className="graph-edit" data-graph-edit={edit.seq} data-graph-edit-actor={edit.actor.kind} title={edit.summary}>
      {t("kanban.graph.edited", { who, age: Number.isFinite(at) ? fmtAge(at / 1000) : "", change })}
    </p>
  );
}

export function pipelineProgress(t: TFunction, summary: KanbanPipeline, nameOf: (stage: PipelineStage) => string): string {
  const { pipeline, chips } = summary;
  if (pipeline.state === "provisioning") return t("kanban.progress.provisioning");
  /* #1938: the spent review budget, with its verdict and both heads. */
  const review = pipelineReviewHeads(t, pipeline);
  if (review) return `${pipelineStateLabel(t, pipeline.state)} · ${review}`;
  const needs = chips.find((chip) => chip.state === "needs_decision");
  if (needs) return t("kanban.progress.needs", { stage: nameOf(needs.stage) });
  const live = chips.find((chip) => LIVE_CHIP_STATES.has(chip.state));
  if (live) {
    /* One attempt caption (#1892): «Review · 2 running». */
    const attempts = summary.views.get(live.stage.id)?.attempts ?? 0;
    const stage = attempts > 1 ? t("kanban.stageAttempt", { stage: nameOf(live.stage), n: attempts }) : nameOf(live.stage);
    return t("kanban.progress.live", { stage, state: attemptStateLabel(t, live.state) });
  }
  if (pipeline.state === "completed") return pipelineStateLabel(t, pipeline.state);
  const failed = chips.find((chip) => chip.state === "failed");
  if (failed) return t("kanban.progress.failed", { stage: nameOf(failed.stage) });
  return pipelineStateLabel(t, pipeline.state);
}

export const graphStateWord = (t: TFunction, state: StageChipState) => t(`kanban.graphState.${state}`);

export function stageRoleId(stage: PipelineStage): string {
  return stage.role?.roleId ?? (stage.kind === "review-loop" ? "reviewer" : "builder");
}

/* ── A fail edge on the lane row (#1798, #2072) ────────────────────────────
   A fail edge is not a step of the chain, so it is not a chip in the row of
   steps. Once it has fired, the failing stage's own pill carries it as a
   suffix, "↺ 1/2": the state in its colour, and a return in flight marked as
   running rather than left to read like one that is over. At rest the row
   says nothing; the budget is configuration, and it lives in the pill's
   tooltip, the Stages sheet and the graph, which still draws the edge. */

/** What the arc says at a glance: nothing, a count, or a spent budget. */
export type ArcState = "rest" | "fired" | "exhausted";

export interface LoopArc {
  loop: KanbanPipeline["loops"][number];
  /** The graph's own edge id, so the two surfaces name one edge alike. */
  id: string;
  state: ArcState;
  /** The target is running right now because this edge sent the work back. */
  live: boolean;
  /** The lane STOPPED on this edge: the budget was gone when the source failed
      again, so the pipeline is standing there waiting for the operator. The
      spent arc says what happened rather than what a further failure costs. */
  parked: boolean;
}

const RETURNED_RUNNING = new Set<StageChipState>(["running", "reviewing", "committing"]);

/** Every fail edge of a pipeline with the state its arc draws, from the data
    graph slice 5 already records (#1743) — nothing here is a new reading. */
export function loopArcs(summary: KanbanPipeline): LoopArc[] {
  return summary.loops.map((loop) => {
    const attempt = latestAttempt(summary.pipeline, loop.to.id);
    const returned = attempt?.activatedBy?.stageId === loop.from.id && attempt.activatedBy.edge === "fail";
    /* The engine parks the lane on the failing stage and leaves the cursor
       there, so a pipeline waiting for a decision AT the source of a spent
       edge is a lane that stopped on this edge — which is the state a red arc
       is most often read in. */
    return {
      loop,
      id: `${loop.from.id}:fail:${loop.to.id}`,
      state: loop.fired === 0 ? "rest" : loop.fired >= loop.max ? "exhausted" : "fired",
      live: Boolean(returned) && RETURNED_RUNNING.has(summary.views.get(loop.to.id)?.state ?? "pending"),
      parked: loop.fired >= loop.max
        && summary.pipeline.state === "needs_decision"
        && summary.pipeline.cursor?.stageId === loop.from.id,
    };
  });
}

/** What a spent fail edge costs the lane, by what its creator asked a spent
    budget to do (#2011, #2187 §3.6): the fix stage takes the last findings and
    the lane moves on, the same and the lane waits for the operator, or another
    failure parks it. */
export function spentEdgeSentence(t: TFunction, arc: LoopArc, from: string, to: string): string {
  const mode = arc.loop.from.onFail ? failEdgeExhaustion(arc.loop.from.onFail) : "advance";
  if (mode === "park") return t("kanban.loopParked", { from });
  return t(mode === "stop-after-fix" ? "kanban.loopSpentWait" : "kanban.loopSpentAdvance", { from, to });
}

/** The sentence the arc keeps: at rest what the edge WOULD do, once it has
    fired what it did, and when the budget is gone what that costs the lane. */
export function arcTitle(t: TFunction, arc: LoopArc, from: string, to: string): string {
  const { fired, max } = arc.loop;
  if (arc.state === "rest") return t("kanban.loopRest", { from, to, count: max });
  /* A lane that stopped here leads with that. It is the one thing the operator
     opened the arc to find out, and last of three clauses of budget it is read
     after everything it explains — in Ukrainian at a narrow width the note runs
     four lines and the clause lands on the last two. */
  const stopped = arc.state === "exhausted" && arc.parked;
  return [
    stopped ? t("kanban.loopParkedHere", { from }) : null,
    t("kanban.loopTitle", { from, to, fired, max }),
    arc.state === "exhausted" && !stopped ? spentEdgeSentence(t, arc, from, to) : null,
    arc.live ? t("kanban.loopLive", { from, to }) : null,
  ].filter(Boolean).join(" · ");
}

/** The fail edge on the failing stage's own pill: the return glyph and the
    count, only once the edge has fired. */
export function ReturnSuffix({ arc, title }: { arc: LoopArc; title: string }) {
  return (
    <span className="pret" title={title} data-stage-return={arc.id} data-arc-state={arc.state} data-arc-live={arc.live ? "1" : "0"} data-arc-fired={arc.loop.fired} data-arc-max={arc.loop.max}>
      <span aria-hidden="true">↺</span>
      {`${arc.loop.fired}/${arc.loop.max}`}
    </span>
  );
}

/** The Stages sheet's loop chip (#1743): the leading glyph becomes the same
    circled number the arrow draws once the edge has fired, and a spent budget
    inverts the chip so "no return left" reads without colour.

    The sheet's nav is the one surface this still belongs on — it lists what the
    graph holds, where a fail edge IS one of the things listed. The card's lane
    row carries the same edge as a suffix on the failing pill instead, because
    a chip there sits in the row of steps and reads as one (#1798).

    The chip is one line, so its parts are separate: the stage names truncate,
    and the budget — the fact the chip exists for — never does. */
export function LoopChip({ loop, from, to }: { loop: KanbanPipeline["loops"][number]; from: string; to: string }) {
  const { t } = useLocale();
  const exhausted = loop.fired >= loop.max;
  const title = [
    t("kanban.loopTitle", { from, to, fired: loop.fired, max: loop.max }),
    exhausted ? t("kanban.graph.noneLeft") : null,
  ].filter(Boolean).join(" · ");
  return (
    <span className={`ploop fail${loop.fired ? " taken" : ""}${exhausted ? " spent" : ""}`} title={title}>
      {loop.fired
        ? <CountCircle n={loop.fired} tone="fail" filled={!exhausted} label={t("kanban.graph.firedTitle", { count: loop.fired })} />
        : <span className="lglyph" aria-hidden="true">↺</span>}
      <span className="lnames">{t("kanban.loopNames", { from, to })}</span>
      <span className="lbudget">{t("kanban.loopUsed", { fired: loop.fired, max: loop.max })}</span>
      {exhausted ? <span className="lnone">{t("kanban.graph.noneLeft")}</span> : null}
    </span>
  );
}

/** How long an edge an attempt just travelled stays marked. */
const LIVE_EDGE_MS = 2_400;

/** The mark in front of a stage's name: its shape carries the state and its
    colour is the stage's `STAGE_TONE`, the one tone map the graph reads. */
/** `live` marks work in flight where the state alone does not say so: a
    settled stage whose conversation works again (#1744). */
export function StageToneMark({ state, className, live = false }: { state: StageChipState; className?: string; live?: boolean }) {
  const shape = STAGE_MARK[state];
  return (
    <i
      className={`pmark tone-${STAGE_TONE[state]}${className ? ` ${className}` : ""}`}
      data-mark={shape}
      data-live={live || LIVE_CHIP_STATES.has(state) ? "1" : undefined}
      aria-hidden="true"
    >
      {shape === "check" ? <svg {...svgProps} strokeWidth={3}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg> : null}
      {shape === "cross" ? <svg {...svgProps} strokeWidth={3}><path d="M17 7 7 17M7 7l10 10" /></svg> : null}
      {shape === "alert" ? <span className="pmark-bang">!</span> : null}
    </i>
  );
}

const COARSE_QUERY = "(pointer: coarse)";
const subscribeCoarse = (change: () => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(COARSE_QUERY);
  query.addEventListener?.("change", change);
  return () => query.removeEventListener?.("change", change);
};
const coarseNow = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(COARSE_QUERY).matches;

/** A finger for a pointer: the loop strip grows to a 44 px target. The graph
    and the Stages sheet's zoom both lay out with it. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeCoarse, coarseNow, () => false);
}

/** The dots a round budget draws: most dots never shrink, and a budget of more
    than six draws as `n/max`. */
const MAX_DOTS = 6;

/**
 * The rounds of a loop, one position per round of its budget: a filled danger
 * dot for each round it fired, a success dot once the source passed, an
 * accent ring on the round under way, and a hollow dot for each round left.
 * No hollow dot left is a spent budget.
 */
export function RoundDots({ fired, max, passed, running }: { fired: number; max: number; passed: boolean; running: boolean }) {
  if (max > MAX_DOTS) return <span className="sdots text" data-dots={`${fired}/${max}`}>{`${fired}/${max}`}</span>;
  /* The ring marks a round of the budget under way; past a spent budget there is none. */
  const ring = running && !passed && fired < max;
  const dots: Array<"bad" | "ok" | "next" | "left"> = [
    ...Array.from({ length: fired }, () => "bad" as const),
    ...(passed ? ["ok" as const] : []),
    ...(ring ? ["next" as const] : []),
    ...Array.from({ length: Math.max(0, max - fired - (ring ? 1 : 0)) }, () => "left" as const),
  ];
  return (
    <span className="sdots" data-dots={dots.join(" ")} aria-hidden="true">
      {dots.map((kind, index) => <i key={index} className={`sdot ${kind}`} />)}
    </span>
  );
}

/**
 * The stage graph: HTML nodes over an SVG edge layer, fitted to the width it
 * has by choosing left-to-right or top-to-bottom. Only the pass chain is drawn
 * as wires; each stage's fail edge folds into a strip under its node (the fix
 * stage docked there, "back to" an earlier stage, or a retry in place) with
 * its rounds as dots, so no return wire runs around the graph
 * (docs/design/pipeline-graph-loops.md). A travelled wire is solid with its
 * count; one only configured stays dashed. A wire or strip is marked live
 * only when a new attempt arrives that it activated.
 */
/* The identity row's text is `--text-caption`, 10 px. Below 9 px on screen it
   stops being readable, so a host that scales the whole graph (the modal's
   zoom) drops the model and effort WORDS at that point and keeps the mark and
   the effort ladder, which are shapes and survive any scale. The card draws at
   scale 1 (10 px effective) and the modal's default "fit" never goes under 0.9
   (9 px effective), so the words are dropped only when the operator zooms out
   by hand — 0.8 gives 8 px, and the floor of 0.7 gives 7 px. */
const CAPTION_PX = 10;
const MIN_LEGIBLE_PX = 9;

export function PipelineGraph({ summary, names, available, selected, onOpenStage, force, navigate = false, inView, scale = 1 }: {
  summary: KanbanPipeline;
  names: ReadonlyMap<string, string>;
  available: number;
  selected: ReadonlySet<string>;
  onOpenStage: (pipeline: Pipeline, stage: PipelineStage) => void;
  force?: "LR" | "TB";
  /** The Stages sheet's graph: every node brings its pane into view. */
  navigate?: boolean;
  /** Stages whose pane the sheet's lane shows. */
  inView?: ReadonlySet<string>;
  /** The transform the host draws this graph under, so the node can tell how
      big its text actually lands. */
  scale?: number;
}) {
  const { t } = useLocale();
  const { pipeline, views } = summary;
  const coarse = useCoarsePointer();
  const layout = useMemo(() => layoutGraph(pipeline, available, force, { coarse }), [pipeline, available, force, coarse]);
  const nameOf = (id: string) => names.get(id) ?? id;
  const identityWords = CAPTION_PX * scale >= MIN_LEGIBLE_PX;
  const byId = new Map(pipeline.stages.map((stage) => [stage.id, stage] as const));

  /* Live edges: the stage's own attempts that were not here on the last render
     and name the edge that activated them. The first render marks nothing, and
     a lineage-adopted helper never marks anything. The mark has its own timer:
     a later change of the record neither extends nor strands it. */
  const seenAttempts = useRef<Set<string> | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [live, setLive] = useState<ReadonlySet<string>>(new Set());
  const arrivals = attemptArrivals(pipeline);
  const arrivalKey = arrivals.map((arrival) => arrival.key).join("|");
  useEffect(() => {
    const before = seenAttempts.current;
    seenAttempts.current = new Set(arrivals.map((arrival) => arrival.key));
    if (!before) return;
    const fresh = new Set(arrivals.flatMap((arrival) => (!before.has(arrival.key) && arrival.edgeId ? [arrival.edgeId] : [])));
    if (!fresh.size) return;
    setLive(fresh);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => {
      clearTimer.current = null;
      setLive(new Set());
    }, LIVE_EDGE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the attempts the pipeline holds
  }, [arrivalKey]);
  useEffect(() => () => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
  }, []);

  const labels: React.ReactNode[] = [];
  const paths: React.ReactNode[] = [];
  for (const edge of layout.topology.wires) {
    const route = routeEdge(layout, edge);
    if (!route) continue;
    /* One rule for what a wire did: the engine's own activation provenance.
       The wire leaving a unit carries the passes of its docked fix stage too,
       which is how the lane moves on after a spent budget. */
    const fired = wireFired(pipeline, layout.topology, edge);
    const max = edge.kind === "fail" ? edge.maxRounds : null;
    const count: EdgeCount = { fired, max, travelled: fired > 0, exhausted: max !== null && fired >= max };
    const back = layout.topology.back.has(edge.id);
    const isLive = live.has(edge.id);
    paths.push(
      <path
        key={edge.id}
        d={route.d}
        className={`pedge ${edge.kind}${back ? " back" : ""}${count.travelled ? " taken" : ""}${count.exhausted ? " spent" : ""}${isLive ? " live" : ""}`}
        markerEnd="url(#kb-pg-arrow)"
        data-edge={edge.id}
        data-edge-fired={count.fired}
      />,
    );
    const content = edgeContent(t, edge, count, layout.topology.branching.has(edge.from));
    if (!content) continue;
    labels.push(
      <span
        key={`label-${edge.id}`}
        className={`pelabel ${edge.kind}${count.travelled ? " taken" : ""}${count.exhausted ? " spent" : ""}${route.beside ? " beside" : ""}${isLive ? " live" : ""}`}
        data-edge-label={edge.id}
        data-edge-fired={count.fired}
        style={{ left: `${route.label[0]}px`, top: `${route.label[1]}px` }}
        title={edgeTitle(t, edge, count, layout.topology.branching.has(edge.from))}
      >
        {content}
      </span>,
    );
  }

  const arcs = new Map(loopArcs(summary).map((arc) => [arc.id, arc] as const));
  const openableStage = (stage: PipelineStage) => {
    const attempt = views.get(stage.id)?.attempt ?? null;
    const conversation = Boolean(attempt?.conversationId || attempt?.agentPath);
    const draftable = !attempt && stageDraftable(pipeline, stage.id);
    return { conversation, draftable, openable: navigate || conversation || draftable };
  };
  const trueState = (id: string): StageChipState => {
    const view = views.get(id);
    return view?.again ? view.previous ?? "pending" : view?.state ?? "pending";
  };
  /* The name a node or strip carries: the stage, and from its second own
     attempt which attempt it stands on, as a muted suffix that survives the
     name's truncation (#1865). */
  const attemptSuffix = (id: string) => {
    const attempts = views.get(id)?.attempts ?? 0;
    return attempts > 1 ? <span className="pattempt">{` · ${attempts}`}</span> : null;
  };
  const longLabel = (id: string) => {
    const attempts = views.get(id)?.attempts ?? 0;
    return attempts > 1 ? t("kanban.stageAttemptOf", { stage: nameOf(id), n: attempts, total: attempts }) : nameOf(id);
  };

  const strips = [...layout.strips.entries()].map(([sourceId, strip]) => {
    const { edge, shape } = strip.loop;
    const source = byId.get(sourceId)!;
    const target = byId.get(edge.to);
    if (!target) return null;
    const arc = arcs.get(edge.id);
    const fired = edgeRoundsUsed(pipeline, edge);
    const max = failEdgeMaxRounds(pipeline, source);
    const targetView = views.get(target.id);
    const sourceLive = LIVE_CHIP_STATES.has(views.get(sourceId)?.state ?? "pending");
    const fixLive = shape === "dock" && LIVE_CHIP_STATES.has(targetView?.state ?? "pending");
    const running = sourceLive || fixLive || Boolean(arc?.live);
    const passed = trueState(sourceId) === "passed";
    const title = arc ? arcTitle(t, arc, nameOf(sourceId), nameOf(target.id)) : "";
    const opens = shape === "self" ? null : target;
    const open = opens ? openableStage(opens) : null;
    const rework = shape === "dock" && Boolean(targetView?.rework);
    const fixState = shape === "dock" ? targetView?.state ?? "pending" : null;
    const text = shape === "dock" ? `${longLabel(target.id)}: ${graphStateWord(t, fixState!)}` : shape === "return" ? t("kanban.loop.backTo", { stage: nameOf(target.id) }) : t("kanban.loop.retry");
    const aria = [text, rework ? t("kanban.graph.workingAgain") : null, title].filter(Boolean).join(". ");
    /* The strip is the bottom of its source's card: its frame takes the
       source's tone, and a fix stage at work takes the active one. */
    const unitTone = fixLive || rework ? "active" : STAGE_TONE[views.get(sourceId)?.state ?? "pending"];
    const fixIdle = shape === "dock" && (fixState === "pending" || fixState === "skipped");
    const className = `pstrip shape-${shape} utone-${unitTone}${fixIdle ? " fix-idle" : ""}${fired ? " fired" : ""}${fired >= max && fired ? " spent" : ""}${live.has(edge.id) ? " live" : ""}${fixLive || rework || (running && shape !== "dock") ? " pulse" : ""}${opens && selected.has(opens.id) ? " selected" : ""}${open?.openable ? "" : " no-conv"}`;
    const body = (
      <>
        <span className="sglyph" aria-hidden="true">↺</span>
        {shape === "dock" ? <StageToneMark state={fixState!} /> : null}
        <span className="sname">
          {shape === "dock" ? nameOf(target.id) : text}
        </span>
        {shape === "dock" ? attemptSuffix(target.id) : null}
        {rework ? <span className="srework">{t("kanban.graph.workingAgain")}</span> : null}
        <RoundDots fired={fired} max={max} passed={passed} running={running} />
        {layout.dir === "TB" ? <span className="pport out" aria-hidden="true" /> : null}
      </>
    );
    const style = { left: `${strip.box.x}px`, top: `${strip.box.y}px`, width: `${strip.box.w}px`, height: `${strip.box.h}px` };
    const data = { "data-strip": edge.id, "data-strip-shape": shape, "data-strip-fired": fired, "data-strip-max": max };
    return opens && open?.openable ? (
      <button key={edge.id} type="button" className={className} style={style} {...data} title={title} aria-label={aria} aria-pressed={selected.has(opens.id)} onClick={() => onOpenStage(pipeline, opens)}>
        {body}
      </button>
    ) : (
      <div key={edge.id} className={className} style={style} {...data} title={title} role="img" aria-label={aria}>
        {body}
      </div>
    );
  });

  return (
    <div className="pgraph-box">
      <div
        className={`pgraph dir-${layout.dir}${identityWords ? "" : " marks-only"}`}
        data-dir={layout.dir}
        data-identity-words={identityWords ? "1" : "0"}
        style={{ width: `${layout.width}px`, height: `${layout.height}px` }}
        role="group"
        aria-label={layout.dir === "LR" ? t("kanban.graph.ariaLR") : t("kanban.graph.ariaTB")}
      >
        <svg className="pedges" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
          <defs>
            <marker id="kb-pg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M1 1 9 5 1 9z" fill="context-stroke" />
            </marker>
          </defs>
          {paths}
        </svg>
        {labels}
        {graphOrder(pipeline, layout.topology).filter((stage) => layout.nodes.has(stage.id)).map((stage) => {
          const box = layout.nodes.get(stage.id)!;
          const view = views.get(stage.id);
          const state = view?.state ?? "pending";
          const word = graphStateWord(t, state);
          const attempt = view?.attempt ?? null;
          const { conversation, draftable, openable } = openableStage(stage);
          const roleId = stageRoleId(stage);
          /* Engine, model and effort of the attempt as it was actually
             launched, or the configuration, muted, when nothing has run (#1743). */
          const identity = stageIdentity(pipeline, stage);
          const isSelected = selected.has(stage.id);
          const rounds = view?.rounds ?? [];
          const attempts = view?.attempts ?? 0;
          const rework = Boolean(view?.rework);
          /* A retry in place says so on its strip; the caption names another stage only. */
          const via = attempt?.activatedBy?.edge === "fail" && attempt.activatedBy.stageId !== stage.id && LIVE_CHIP_STATES.has(state) ? attempt.activatedBy.stageId : null;
          /* The state row's caption, first match wins (§3.4). */
          const detail = rework ? <span className="pdetail rework">{t("kanban.graph.workingAgain")}</span>
            : view?.again ? <span className="pdetail">{t("kanban.graph.lastWas", { state: graphStateWord(t, view.previous ?? "pending") })}</span>
              : rounds.length ? <RoundsMark rounds={rounds} />
                : via ? <span className="pdetail" title={t("kanban.graph.becauseTitle", { stage: longLabel(via) })}>{t("kanban.graph.because", { stage: nameOf(via) })}</span>
                  : !attempts ? <span className="pdetail">{stage.kind === "review-loop" ? t("kanban.graph.reviewsRun") : t("kanban.graph.notStarted")}</span>
                    : null;
          const hasStrip = layout.strips.has(stage.id);
          const aria = [
            t("kanban.graph.nodeAria", { stage: longLabel(stage.id), engine: engineWord(identity.engine), state: word }),
            identityTitle(t, identity),
            rework ? t("kanban.graph.workingAgain") : "",
            rounds.length ? rounds.map((round) => t("kanban.graph.roundTitle", { n: round.n, verdict: t(`kanban.graph.verdict.${round.verdict}`) })).join(", ") : "",
            navigate
              ? (isSelected ? t("kanban.stages.paneShown") : t("kanban.stages.showPane"))
              : conversation ? (isSelected ? t("kanban.graph.conversationOpen") : t("kanban.graph.openConversation"))
                : draftable ? (isSelected ? t("kanban.graph.draftOpen") : t("kanban.graph.openDraft")) : t("kanban.graph.noConversation"),
          ].filter(Boolean).join(". ");
          return (
            <button
              key={stage.id}
              type="button"
              className={`pnode tone-${STAGE_TONE[state]} st-${state} role-${roleId}${stage.kind === "review-loop" ? " review" : ""}${isSelected ? " selected" : ""}${openable ? "" : " no-conv"}${inView?.has(stage.id) ? " in-view" : ""}${state === "running" || state === "reviewing" || rework ? " pulse" : ""}${rework ? " rework" : ""}${hasStrip ? " has-strip" : ""}`}
              data-stage={stage.id}
              data-stage-again={view?.again ? "1" : undefined}
              data-stage-rework={rework ? "1" : undefined}
              style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` }}
              aria-pressed={isSelected}
              aria-disabled={openable ? undefined : true}
              aria-label={aria}
              title={openable ? undefined : state === "pending" ? t("kanban.graph.waitingTitle") : t("kanban.graph.noConversationTitle")}
              onClick={() => { if (openable) onOpenStage(pipeline, stage); }}
            >
              <span className="pport in" aria-hidden="true" />
              {layout.topology.branching.has(stage.id) ? (
                <>
                  <span className="pport out pass" aria-hidden="true" />
                  <span className="pport out fail" aria-hidden="true" />
                </>
              ) : hasStrip && layout.dir === "TB" ? null : <span className="pport out" aria-hidden="true" />}
              <span className="prow head">
                <span className="pglyph" aria-hidden="true"><svg {...svgProps} strokeWidth={1.8}>{ROLE_GLYPH[roleId] ?? ROLE_GLYPH.builder}</svg></span>
                <span className="pname">{nameOf(stage.id)}</span>
                {attemptSuffix(stage.id)}
              </span>
              <span className="prow ident">
                {/* The effort word only where the layout gave the node room for
                    it, so the identity line never pushes the state row out. */}
                <StageIdentity identity={identity} density="node" showWord={box.w >= 176} words={identityWords} />
              </span>
              <span className="prow">
                <span className="pstate"><i className="pdot" aria-hidden="true" />{word}</span>
                {detail}
              </span>
            </button>
          );
        })}
        {strips}
      </div>
    </div>
  );
}

/**
 * A review-loop stage recovers through its own flow rounds rather than a fail
 * edge, so it says how many times it went round in exactly the vocabulary the
 * arrows use (#1743): one circled number, then the latest verdict. The node's
 * label and the circle's tooltip still name every round, and Past attempts
 * lists each finished one.
 */
function RoundsMark({ rounds }: { rounds: readonly ReviewRound[] }) {
  const { t } = useLocale();
  const latest = rounds[rounds.length - 1]!;
  const each = rounds.map((round) => t("kanban.graph.roundTitle", { n: round.n, verdict: t(`kanban.graph.verdict.${round.verdict}`) })).join("\n");
  const tone = latest.verdict === "approved" ? "ok" : latest.verdict === "changes" ? "fail" : "open";
  return (
    <span className="rounds-mark" data-rounds={rounds.length} title={each}>
      <CountCircle
        n={rounds.length}
        tone={tone}
        filled={latest.verdict === "changes"}
        label={t("kanban.graph.roundsAria", { count: rounds.length, verdict: t(`kanban.graph.verdict.${latest.verdict}`) })}
      />
      <span className={`rverdict ${tone}`} aria-hidden="true">{latest.verdict === "approved" ? "✓" : latest.verdict === "changes" ? "✕" : "…"}</span>
    </span>
  );
}

/** Everything an edge label says in words, for the hover: what it is, how often
    it fired, and whether any return is left. */
function edgeTitle(t: TFunction, edge: GraphEdge, count: EdgeCount, branching: boolean): string {
  if (edge.kind === "pass") {
    return [branching ? t("kanban.graph.pass") : null, count.travelled ? t("kanban.graph.firedTitle", { count: count.fired }) : null]
      .filter(Boolean).join(" · ") || t("kanban.graph.pass");
  }
  return [
    t("kanban.graph.failUsed", { n: count.fired, max: count.max ?? 0 }),
    count.exhausted ? t("kanban.graph.noneLeft") : null,
  ].filter(Boolean).join(" · ");
}

/** What the label draws on a wire. A travelled edge leads with the circled
    count; a configured one keeps the word it had. A pass edge that has not
    fired is labelled only where the source branches. The few fail edges that
    still draw as wires carry the short budget. */
function edgeContent(t: TFunction, edge: GraphEdge, count: EdgeCount, branching: boolean): React.ReactNode | null {
  const circle = <CountCircle n={count.fired} tone={edge.kind} filled={edge.kind === "fail" && !count.exhausted} label={t("kanban.graph.firedTitle", { count: count.fired })} />;
  if (edge.kind === "pass") {
    if (count.travelled) return circle;
    return branching ? t("kanban.graph.pass") : null;
  }
  const budget = count.travelled ? t("kanban.graph.failUsedShort", { n: count.fired, max: count.max ?? 0 }) : t("kanban.graph.fail");
  if (!count.travelled) return budget;
  return (
    <>
      {circle}
      <span className="ebudget">{budget}</span>
    </>
  );
}

/** A past attempt's name: the stage and which attempt, round or helper
    conversation it was. The desktop card and the phone's pipeline screen
    both list them in these words. */
export function pastAttemptLabel(t: TFunction, row: PastAttempt, stage: string): string {
  if (row.kind === "helper") return t("kanban.past.helper", { stage, n: row.n });
  if (row.kind === "round") return row.ambiguous ? t("kanban.past.attemptRound", { stage, attempt: row.ordinal ?? row.attempt ?? 0, n: row.n }) : t("kanban.past.round", { stage, n: row.n });
  /* The label every surface gives a stage's attempt (#1865): the name alone
     for a stage that ran once, «Critique · 2» from its second attempt. */
  return row.of > 1 ? t("kanban.stageAttempt", { stage, n: row.ordinal ?? row.n }) : stage;
}

/** How a past attempt ended: the round's verdict, or the attempt's state and verdict. */
export function pastAttemptState(t: TFunction, row: PastAttempt): string {
  if (row.kind === "round") return t(`kanban.past.verdict.${row.state === "APPROVE" || row.state === "REQUEST_CHANGES" || row.state === "COMMENT" ? row.state : "open"}`);
  const state = attemptStateLabel(t, row.state as never);
  return row.verdict ? `${state} · ${t(`kanban.past.stageVerdict.${row.verdict as "pass" | "fail" | "needs_decision"}`)}` : state;
}

/** The tone of that ending: "ok", "bad", or none. */
export function pastAttemptTone(row: PastAttempt): "ok" | "bad" | "" {
  const words = `${row.state} ${row.verdict ?? ""}`;
  if (/passed|APPROVE|\bpass\b/.test(words)) return "ok";
  if (/failed|REQUEST_CHANGES|\bfail\b/.test(words)) return "bad";
  return "";
}

/** "Past attempts · N": finished attempts and review rounds, newest first, then
    the helper conversations stage agents brought in, listed as such. Each opens
    its conversation when one was kept. */
export function PastAttempts({ rows, names, nowMs, onOpen }: {
  rows: readonly PastAttempt[];
  /** Stage names by pipeline id, then stage id. */
  names: ReadonlyMap<string, ReadonlyMap<string, string>>;
  nowMs: number;
  onOpen: (conversation: PastAttempt["conversation"]) => void;
}) {
  const { t } = useLocale();
  const history = rows.filter((row) => row.kind !== "helper");
  const helpers = rows.filter((row) => row.kind === "helper");
  if (!history.length && !helpers.length) return null;
  const labelOf = (row: PastAttempt) => pastAttemptLabel(t, row, names.get(row.pipelineId)?.get(row.stageId) ?? row.stageId);
  const stateOf = (row: PastAttempt) => pastAttemptState(t, row);
  const tone = pastAttemptTone;
  const age = (row: PastAttempt) => (row.atMs ? (nowMs - row.atMs < 60_000 ? t("kanban.justNow") : fmtAge(row.atMs / 1000)) : "");
  const item = (row: PastAttempt) => (
    <li key={row.key} data-past={row.key} data-past-kind={row.kind}>
      <span className="lbl">{labelOf(row)}</span>
      <span className={`verdict ${tone(row)}`}>{stateOf(row)}</span>
      <span className="when">{age(row)}</span>
      {row.conversation.path || row.conversation.conversationId ? (
        <button type="button" className="hopen" aria-label={t("kanban.past.openAria", { label: labelOf(row) })} onClick={() => onOpen(row.conversation)}>
          {t("kanban.past.open")}
        </button>
      ) : (
        <span className="hnone">{t("kanban.past.none")}</span>
      )}
    </li>
  );
  const latest = history[0] ?? null;
  return (
    <details className="history" data-past-attempts={history.length} data-helper-conversations={helpers.length}>
      <summary aria-label={latest ? t("kanban.past.aria", { count: history.length, label: labelOf(latest), state: stateOf(latest) }) : t("kanban.past.helpersHead", { count: helpers.length })}>
        <ChevronRight />
        <span className="hl">{latest ? t("kanban.past.head", { count: history.length }) : t("kanban.past.helpersHead", { count: helpers.length })}</span>
        {latest ? <span className="lbl">{t("kanban.past.last", { label: labelOf(latest), state: stateOf(latest), age: age(latest) })}</span> : null}
      </summary>
      <p className="hnote">{t("kanban.past.note")}</p>
      {history.length ? <ul>{history.map(item)}</ul> : null}
      {helpers.length ? (
        <>
          <p className="hsub">{t("kanban.past.helpersHead", { count: helpers.length })}</p>
          <p className="hnote">{t("kanban.past.helpersNote")}</p>
          <ul data-helpers="">{helpers.map(item)}</ul>
        </>
      ) : null}
    </details>
  );
}
