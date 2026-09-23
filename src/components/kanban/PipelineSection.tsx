"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { roleNameById } from "@/components/builderCopy";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineGraphEdit, PipelineStage, PipelineStageReportEntry, StageFinding } from "@/lib/pipelines/types";
import { attemptStateLabel, latestAttempt, pipelineReviewHeads, pipelineStateLabel, type StageChipState } from "@/components/pipelines/pipelineModel";

/* The stage-name rule lives beside `stageChipLabel` so the phone reads it
   without pulling a kanban component (#1865). */
export { stageDisplayName, stageNames } from "@/components/pipelines/pipelineModel";
import { fmtAge } from "@/components/utils";

import type { KanbanPipeline } from "./kanbanModel";
import { attemptArrivals, graphOrder, layoutGraph, operationalAttempts, routeEdge, STAGE_TONE, type GraphEdge, type PastAttempt, type ReviewRound } from "./pipelineGraph";
import { edgeCount, stageIdentity, type EdgeCount } from "./stageIdentity";
import { CountCircle, engineWord, FiredMark, identityTitle, StageIdentity } from "./identityMarks";
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
    const attempts = operationalAttempts(pipeline, live.stage.id).length;
    const base = t("kanban.progress.live", { stage: nameOf(live.stage), state: attemptStateLabel(t, live.state) });
    return attempts > 1 ? t("kanban.progress.attempt", { progress: base, n: attempts }) : base;
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

/** The sentence the arc keeps: at rest what the edge WOULD do, once it has
    fired what it did, and when the budget is gone what that costs the lane. */
export function arcTitle(t: TFunction, arc: LoopArc, from: string, to: string): string {
  const { fired, max } = arc.loop;
  if (arc.state === "rest") return t("kanban.loopRest", { from, to, max });
  /* A lane that stopped here leads with that. It is the one thing the operator
     opened the arc to find out, and last of three clauses of budget it is read
     after everything it explains — in Ukrainian at a narrow width the note runs
     four lines and the clause lands on the last two. */
  const stopped = arc.state === "exhausted" && arc.parked;
  return [
    stopped ? t("kanban.loopParkedHere", { from }) : null,
    t("kanban.loopTitle", { from, to, fired, max }),
    arc.state === "exhausted" && !stopped ? t("kanban.loopParked", { from }) : null,
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

/**
 * The stage graph: HTML nodes over an SVG edge layer, fitted to the width it
 * has by choosing left-to-right or top-to-bottom. Pass edges are solid, fail
 * edges dashed and labelled with how often they fired; an edge back to an
 * earlier stage runs in its own lane. An edge is marked live only when a new
 * attempt arrives that it activated.
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

/** How much of itself a beside fail label still draws: the whole sentence, the
    short budget, or the circled count with the sentence in the legend. */
type BesideForm = "long" | "short" | "badge";
const NO_FORMS: Readonly<Record<string, BesideForm>> = {};

/** Registers a beside label for measurement; a label that is not beside the
    return lane has the box's whole width and is never measured. */
const besideRef = (boxes: React.RefObject<Map<string, HTMLElement>>, id: string | null) =>
  (element: HTMLElement | null) => {
    if (!id) return;
    if (element) boxes.current.set(id, element);
    else boxes.current.delete(id);
  };

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
  const { t, locale } = useLocale();
  const { pipeline, views } = summary;
  const layout = useMemo(() => layoutGraph(pipeline, available, force), [pipeline, available, force]);
  const nameOf = (id: string) => names.get(id) ?? id;
  const identityWords = CAPTION_PX * scale >= MIN_LEGIBLE_PX;

  /* A fail edge's label sits beside the return lane, in the width the layout
     reserved for it. How wide the sentence actually is depends on the language
     — Ukrainian's is half again longer than English's — and a label the box
     cuts is worse than a short one: the remaining budget was the part that went
     missing. So a beside label that does not fit steps down, measured rather
     than guessed: the full sentence, then `fail n/m`, then the circled count
     alone with the sentence moved into the legend under the graph. Each edge
     only ever steps down, so the measurement settles. */
  const labelBoxes = useRef(new Map<string, HTMLElement>());
  const fitKey = `${layout.dir}|${layout.width}|${layout.labelMode}|${locale}`;
  const [fit, setFit] = useState<{ key: string; forms: Readonly<Record<string, BesideForm>> }>({ key: fitKey, forms: {} });
  const forms = fit.key === fitKey ? fit.forms : NO_FORMS;
  useLayoutEffect(() => {
    const next: Record<string, BesideForm> = { ...forms };
    let changed = fit.key !== fitKey;
    for (const [id, element] of labelBoxes.current) {
      if (!element.isConnected || forms[id] === "badge") continue;
      if (element.offsetLeft + element.offsetWidth <= layout.width + 0.5) continue;
      next[id] = forms[id] === "short" ? "badge" : "short";
      changed = true;
    }
    if (changed) setFit({ key: fitKey, forms: next });
  });

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

  const legend: Array<{ id: string; count: EdgeCount; text: string }> = [];
  const labels: React.ReactNode[] = [];
  const paths: React.ReactNode[] = [];
  for (const edge of layout.topology.edges) {
    const route = routeEdge(layout, edge);
    if (!route) continue;
    /* One rule for what an edge did: the engine's own activation provenance,
       through `edgeCount`. A travelled edge is drawn solid in its verdict's
       colour; one that is only configured stays dashed and muted (#1743). */
    const count = edgeCount(pipeline, edge);
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
    const style = { left: `${route.label[0]}px`, top: `${route.label[1]}px` };
    const title = edgeTitle(t, edge, count, layout.topology.branching.has(edge.from));
    const beside = route.labelAxis === "v" && edge.kind === "fail" && back;
    /* Legend mode is the layout's own decision, taken before any text exists;
       the step-down below is this label's, taken from what it measured. */
    const legendMode = edge.kind === "fail" && layout.dir === "TB" && layout.labelMode === "legend" && back;
    const measured = beside && !legendMode ? edge.id : null;
    const form: BesideForm = measured ? forms[edge.id] ?? "long" : "long";
    const badgeOnly = legendMode || form === "badge";
    if (badgeOnly) {
      /* The arrow carries the count and nothing else, so a circled number means
         "times fired" here too. The row under the graph names the stages. */
      legend.push({ id: edge.id, count, text: t("kanban.graph.legendFail", { from: nameOf(edge.from), to: nameOf(edge.to), n: count.fired, max: count.max ?? 0 }) });
      if (count.travelled) {
        labels.push(
          <span
            key={`label-${edge.id}`}
            ref={besideRef(labelBoxes, measured)}
            className={`pelabel ${edge.kind} badge${count.exhausted ? " spent" : ""}${beside ? " beside" : ""}${isLive ? " live" : ""}`}
            data-edge-label={edge.id}
            data-edge-fired={count.fired}
            style={beside ? { left: `${route.label[0] + 8}px`, top: `${route.label[1]}px` } : style}
            title={title}
          >
            {/* A fail count is a filled disc; on a bare badge exhaustion is the
                ring drawn around it, not a lighter circle. */}
            <FiredMark count={count} label={t("kanban.graph.firedTitle", { count: count.fired })} />
          </span>,
        );
      }
      continue;
    }
    const long = edge.kind === "fail" && back && form === "long";
    const content = edgeContent(t, edge, count, layout.topology.branching.has(edge.from), long);
    if (!content) continue;
    labels.push(
      <span
        key={`label-${edge.id}`}
        ref={besideRef(labelBoxes, measured)}
        className={`pelabel ${edge.kind}${count.travelled ? " taken" : ""}${count.exhausted ? " spent" : ""}${beside ? " beside" : ""}${isLive ? " live" : ""}`}
        data-edge-label={edge.id}
        data-edge-fired={count.fired}
        data-edge-label-form={measured ? form : undefined}
        style={beside ? { left: `${route.label[0] + 8}px`, top: `${route.label[1]}px` } : style}
        title={title}
      >
        {content}
      </span>,
    );
  }

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
        {graphOrder(pipeline, layout.topology).map((stage) => {
          const box = layout.nodes.get(stage.id)!;
          const view = views.get(stage.id);
          const state = view?.state ?? "pending";
          const word = graphStateWord(t, state);
          const attempt = view?.attempt ?? null;
          const conversation = Boolean(attempt?.conversationId || attempt?.agentPath);
          const draftable = !attempt && stageDraftable(pipeline, stage.id);
          const openable = navigate || conversation || draftable;
          const roleId = stageRoleId(stage);
          /* Engine, model and effort of the attempt as it was actually
             launched, or the configuration, muted, when nothing has run (#1743). */
          const identity = stageIdentity(pipeline, stage);
          const isSelected = selected.has(stage.id);
          const rounds = view?.rounds ?? [];
          const attempts = view?.attempts ?? 0;
          const detail = view?.again ? (
            <span className="pdetail">{t("kanban.graph.nextAttempt", { state: graphStateWord(t, view.previous ?? "pending") })}</span>
          ) : rounds.length ? <RoundsMark rounds={rounds} /> : (
            <span className="pdetail">
              {attempts
                ? stage.onFail ? t("kanban.graph.attemptRetries", { n: attempts, count: stage.onFail.maxRounds }) : t("kanban.graph.attempt", { n: attempts })
                : stage.kind === "review-loop" ? t("kanban.graph.reviewsRun") : t("kanban.graph.notStarted")}
            </span>
          );
          const aria = [
            t("kanban.graph.nodeAria", { stage: nameOf(stage.id), engine: engineWord(identity.engine), state: word }),
            identityTitle(t, identity),
            attempts ? t("kanban.graph.attempt", { n: attempts }) : "",
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
              className={`pnode tone-${STAGE_TONE[state]} st-${state} role-${roleId}${stage.kind === "review-loop" ? " review" : ""}${isSelected ? " selected" : ""}${openable ? "" : " no-conv"}${inView?.has(stage.id) ? " in-view" : ""}${state === "running" || state === "reviewing" ? " pulse" : ""}`}
              data-stage={stage.id}
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
              ) : <span className="pport out" aria-hidden="true" />}
              <span className="prow head">
                <span className="pglyph" aria-hidden="true"><svg {...svgProps} strokeWidth={1.8}>{ROLE_GLYPH[roleId] ?? ROLE_GLYPH.builder}</svg></span>
                <span className="pname">{nameOf(stage.id)}</span>
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
      </div>
      {legend.length ? (
        <ul className="plegend">
          {legend.map((entry) => (
            <li key={entry.id} data-legend-edge={entry.id}>
              {/* The key samples the mark the arrow above it actually carries,
                  ring and all, or it explains a drawing that is not there. */}
              {entry.count.travelled
                ? <FiredMark count={entry.count} />
                : <span className="esample" aria-hidden="true" />}
              <span>{entry.text}{entry.count.exhausted ? ` · ${t("kanban.graph.noneLeft")}` : ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
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

/** What the label draws on the arrow. A travelled edge leads with the circled
    count; a configured one keeps the word it had. A pass edge that has not
    fired is labelled only where the source branches, as before. */
function edgeContent(t: TFunction, edge: GraphEdge, count: EdgeCount, branching: boolean, long: boolean): React.ReactNode | null {
  const circle = <CountCircle n={count.fired} tone={edge.kind} filled={edge.kind === "fail" && !count.exhausted} label={t("kanban.graph.firedTitle", { count: count.fired })} />;
  if (edge.kind === "pass") {
    if (count.travelled) return circle;
    return branching ? t("kanban.graph.pass") : null;
  }
  const budget = long
    ? t("kanban.graph.failUsed", { n: count.fired, max: count.max ?? 0 })
    : count.travelled ? t("kanban.graph.failUsedShort", { n: count.fired, max: count.max ?? 0 }) : t("kanban.graph.fail");
  if (!count.travelled) return budget;
  return (
    <>
      {circle}
      <span className="ebudget">{budget}{count.exhausted && long ? ` · ${t("kanban.graph.noneLeft")}` : ""}</span>
    </>
  );
}

/** A past attempt's name: the stage and which attempt, round or helper
    conversation it was. The desktop card and the phone's pipeline screen
    both list them in these words. */
export function pastAttemptLabel(t: TFunction, row: PastAttempt, stage: string): string {
  if (row.kind === "helper") return t("kanban.past.helper", { stage, n: row.n });
  if (row.kind === "round") return row.ambiguous ? t("kanban.past.attemptRound", { stage, attempt: row.attempt ?? 0, n: row.n }) : t("kanban.past.round", { stage, n: row.n });
  return t("kanban.past.attempt", { stage, n: row.n });
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
