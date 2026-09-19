"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { roleNameById } from "@/components/builderCopy";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineGraphEdit, PipelineStage, PipelineStageReportEntry, StageFinding } from "@/lib/pipelines/types";
import { attemptStateLabel, latestAttempt, pipelineStateLabel, stageChipLabel, type StageChipState } from "@/components/pipelines/pipelineModel";
import { fmtAge } from "@/components/utils";

import type { KanbanPipeline } from "./kanbanModel";
import { attemptArrivals, graphOrder, layoutGraph, operationalAttempts, routeEdge, STAGE_TONE, type GraphEdge, type PastAttempt, type ReviewRound } from "./pipelineGraph";
import { edgeCount, stageIdentity, type EdgeCount } from "./stageIdentity";
import { CountCircle, engineWord, FiredMark, identityTitle, StageIdentity } from "./identityMarks";
import { ChevronRight, MaximizeGlyph, MoreGlyph, svgProps } from "./kanbanGlyphs";
import { stageDraftable, type PipelineActionKind } from "./stagesModel";

/* A card's pipeline, as the approved prototype draws it (`renderPipeline`,
   `graph.js`, `pastAttempts`): a header with the pipeline's state and where it
   is, then either the stage graph or its one-line summary, and below the
   card's current work a quiet disclosure of what came before. */

export const GraphGlyph = () => (
  <svg {...svgProps}><rect x="3" y="4" width="6" height="5" rx="1.5" /><rect x="15" y="4" width="6" height="5" rx="1.5" /><rect x="9" y="15" width="6" height="5" rx="1.5" /><path d="M9 6.5h6M18 9v2.5a2 2 0 0 1-2 2h-1.5M6 9v2.5a2 2 0 0 0 2 2h1.5" /></svg>
);
const ListGlyph = () => (
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
function StageReportLine({ pipeline, entry, names }: {
  pipeline: Pipeline;
  entry: PipelineStageReportEntry;
  names: Map<string, string>;
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
          {findings.slice(0, SHOWN_STAGE_FINDINGS).map((finding, index) => (
            <li key={index} data-severity={finding.severity ?? "none"}>
              <span className="sev">{finding.severity ?? t("kanban.stageReport.unranked")}</span>
              <span className="text">{finding.text}</span>
            </li>
          ))}
          {findings.length > SHOWN_STAGE_FINDINGS ? (
            <li className="more">{t("kanban.stageReport.moreFindings", { count: findings.length - SHOWN_STAGE_FINDINGS })}</li>
          ) : null}
        </ul>
      ) : null}
    </>
  );
}

/** The latest graph edit, signed by whoever made it (graph slice 1). */
function GraphEditLine({ edit }: { edit: PipelineGraphEdit }) {
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

/** A stage id that names nothing the role does not already say. */
const GENERIC_STAGE_ID = /^(?:stage|step|s|run|task)[-_ ]?\d*$/i;
/** A stage id that is an identifier rather than a word: never drawn as a name. */
const OPAQUE_STAGE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^[0-9a-f]{8,}$|^\d+$/i;

/**
 * A stage's name: its own id where the id says more than the role — `critique`,
 * `fix`, `diagnose` — and the role's name where the id only repeats the role or
 * names nothing (`stage-2`) (#1765). Stage ids are unique inside a pipeline, so
 * two stages of one pipeline never read alike.
 */
export function stageDisplayName(t: TFunction, stage: PipelineStage): string {
  const role = stageChipLabel(t, stage);
  const words = stage.id.replace(/[-_]+/g, " ").trim();
  if (!words || GENERIC_STAGE_ID.test(stage.id) || OPAQUE_STAGE_ID.test(stage.id)) return role;
  const humanized = words[0]!.toUpperCase() + words.slice(1);
  /* An id that IS the role (however it is cased) says nothing more; a role-less
     stage falls back to its own id anyway, and reads better capitalized. */
  if (stage.role?.roleId && stage.id.toLowerCase() === stage.role.roleId.toLowerCase()) return role;
  return humanized;
}

export function stageNames(t: TFunction, pipeline: Pipeline): Map<string, string> {
  return new Map(pipeline.stages.map((stage) => [stage.id, stageDisplayName(t, stage)] as const));
}

export function pipelineProgress(t: TFunction, summary: KanbanPipeline, nameOf: (stage: PipelineStage) => string): string {
  const { pipeline, chips } = summary;
  if (pipeline.state === "provisioning") return t("kanban.progress.provisioning");
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

export function PipelineSection({ summary, open, selected, acting, onToggle, onOpenStage, onOpenSheet, onMenu }: {
  summary: KanbanPipeline;
  /** The operator's choice for this card, or null for the default: the summary. */
  open: boolean | null;
  /** Stage ids whose conversation or first message is open on the card. */
  selected: ReadonlySet<string>;
  /** The pipeline action this page sent and the server has not answered. */
  acting: PipelineActionKind | null;
  onToggle: (open: boolean) => void;
  onOpenStage: (pipeline: Pipeline, stage: PipelineStage) => void;
  onOpenSheet: (pipeline: Pipeline) => void;
  onMenu: (pipeline: Pipeline, anchor: HTMLElement) => void;
}) {
  const { t } = useLocale();
  const { pipeline } = summary;
  const names = useMemo(() => stageNames(t, pipeline), [t, pipeline]);
  const nameOf = (stage: PipelineStage) => names.get(stage.id) ?? stageChipLabel(t, stage);
  /* Every card starts on the compact summary; the detailed graph is one toggle
     away and stays open while the board is (#1695 binding correction 4, which
     supersedes the prototype's graph-by-default rule for active pipelines). */
  const showGraph = open ?? false;
  const progress = pipelineProgress(t, summary, nameOf);
  /* What this pipeline is, in its own words (#1765): several pipelines on one
     card used to draw the same generic chip, so nothing told them apart. */
  const title = pipelineTitle(t, pipeline);
  const slot = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = slot.current;
    if (!element || !showGraph) return;
    const measure = () => setAvailable(Math.floor(element.clientWidth));
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showGraph]);
  return (
    <div
      className={`stage-section ${showGraph ? "open" : "compact"}`}
      data-pipeline={pipeline.id}
      role="group"
      aria-label={t("kanban.pipelineAria", { title, progress })}
    >
      <div className="sec-head">
        <span className="ptitle" data-pipeline-title={pipeline.id} title={pipeline.task || title}>{title}</span>
        <span className="pstate-chip" data-pstate={pipeline.state}>{pipelineStateLabel(t, pipeline.state)}</span>
        <span className="progress">{progress}</span>
        {acting ? <span className="acting" role="status" data-pipeline-acting={acting}>{t(`kanban.pipelineAct.pending.${acting}`)}</span> : null}
        <span className="grow" />
        <button
          type="button"
          className="icon-btn sm"
          aria-pressed={showGraph}
          aria-label={showGraph ? t("kanban.graph.showSummary") : t("kanban.graph.showGraph")}
          title={showGraph ? t("kanban.graph.summary") : t("kanban.graph.graph")}
          data-graph-toggle={pipeline.id}
          onClick={() => onToggle(!showGraph)}
        >
          {showGraph ? <ListGlyph /> : <GraphGlyph />}
        </button>
        <button
          type="button"
          className="btn quiet expand-stages"
          aria-label={t("kanban.stages.expandAria", { count: pipeline.stages.length })}
          title={t("kanban.stages.expandTitle")}
          data-open-stages={pipeline.id}
          onClick={() => onOpenSheet(pipeline)}
        >
          <MaximizeGlyph />
          <span>{t("kanban.stages.button")}</span>
        </button>
        <button
          type="button"
          className="icon-btn sm"
          aria-label={t("kanban.pipelineAct.menu")}
          aria-haspopup="menu"
          data-pipeline-menu={pipeline.id}
          onClick={(event) => onMenu(pipeline, event.currentTarget)}
        >
          <MoreGlyph />
        </button>
      </div>
      <div className="graph-slot" ref={slot} data-graph={pipeline.id} data-open={showGraph ? "1" : "0"}>
        {showGraph ? (
          available === null ? null : <PipelineGraph summary={summary} names={names} available={available} selected={selected} onOpenStage={onOpenStage} />
        ) : (
          <PipelineChips summary={summary} nameOf={nameOf} selected={selected} onOpenStage={onOpenStage} />
        )}
      </div>
      {pipeline.stageReports?.length ? <StageReportLine pipeline={pipeline} entry={pipeline.stageReports.at(-1)!} names={names} /> : null}
      {pipeline.graphEdits?.length ? <GraphEditLine edit={pipeline.graphEdits.at(-1)!} /> : null}
    </div>
  );
}

/* ── A fail edge in the collapsed row (#1798) ──────────────────────────────
   A fail edge is not a step of the chain, so it is not a chip in the row of
   steps. It is a return arc UNDER the row, from the failing stage back to its
   target, with the arrowhead at the target. At rest it is faint and says
   nothing: the budget is configuration, and configuration lives in the arc's
   tooltip and in the expanded graph. Once the edge has fired the arc warns and
   carries its count on itself; a spent budget turns danger, and says whether
   it stopped the lane or still has one return in flight. A row that wrapped
   drops the arcs — an arc across two lines reads as neither — and the failing
   stage's pill carries the same count as a compact suffix instead.

   Two arcs into one pill nest: the shorter edge hangs shallower and lands on
   the pill's centre, the longer hangs under it and lands a step further from
   its own source. Every head ends on the same pill edge, so nested arcs always
   converge there, and the shallow one is painted last and answers for both
   where they do. */

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
function arcTitle(t: TFunction, arc: LoopArc, from: string, to: string): string {
  const { fired, max } = arc.loop;
  if (arc.state === "rest") return t("kanban.loopRest", { from, to, max });
  return [
    t("kanban.loopTitle", { from, to, fired, max }),
    arc.state === "exhausted" ? t(arc.parked ? "kanban.loopParkedHere" : "kanban.loopParked", { from }) : null,
    arc.live ? t("kanban.loopLive", { from, to }) : null,
  ].filter(Boolean).join(" · ");
}

/* The band under the row, in px: how far below the pills the shallowest arc
   hangs, how much deeper each arc stacked under it goes, how tall the
   arrowhead at the target is, and the room the deepest arc's counter needs so
   nothing paints onto what follows the row. */
const ARC_GAP = 3;
const ARC_DIP = 11;
const ARC_STEP = 9;
const ARC_HEAD = 5;
const ARC_LABEL = 8;
/* A row of arcs that all rest reserves only the ink of the deepest curve: the
   counter's room is the counter's, and an empty band under a quiet lane is
   just dead space. */
const ARC_QUIET = 3;
/* Two edges into one stage land on one pill, so their arrowheads are fanned
   apart along it — stacked on the same point they read as one arrow. The head
   is 7 px wide, so the step leaves 4 px of clear air between two tips. */
const ARC_FAN = 11;
const ARC_HEAD_HALF = 3.5;

interface ArcPath { d: string; head: string; lx: number; ly: number; rank: number }
interface ArcBand {
  /** Serialized geometry: one compare decides whether a measurement changed. */
  key: string;
  /** The row runs over more than one line, so arcs are dropped for suffixes. */
  wrapped: boolean;
  top: number;
  height: number;
  paths: ReadonlyMap<string, ArcPath>;
}
const EMPTY_BAND: ArcBand = { key: "", wrapped: false, top: 0, height: 0, paths: new Map() };
const round = (value: number) => Math.round(value * 2) / 2;

/**
 * The arcs' geometry, from the pills' own boxes: a cubic that leaves the
 * failing pill's bottom edge, hangs under the row and comes back up into its
 * target. Arcs are stacked by the distance they span, so the short one never
 * hides under the long one and neither crosses a pill — they live entirely
 * below the line the pills sit on. A row whose pills are not all on one line
 * is reported wrapped and gets no arcs at all.
 */
function measureArcs(row: HTMLElement, chips: ReadonlyMap<string, HTMLElement>, arcs: readonly LoopArc[]): ArcBand {
  const rowRect = row.getBoundingClientRect();
  const boxes = new Map<string, { cx: number; left: number; right: number; top: number; bottom: number }>();
  for (const [id, element] of chips) {
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    boxes.set(id, {
      cx: rect.left - rowRect.left + rect.width / 2,
      left: rect.left - rowRect.left,
      right: rect.right - rowRect.left,
      top: rect.top - rowRect.top,
      bottom: rect.bottom - rowRect.top,
    });
  }
  if (!boxes.size) return EMPTY_BAND;
  const tops = [...boxes.values()].map((box) => box.top);
  if (Math.max(...tops) - Math.min(...tops) > 1) return { ...EMPTY_BAND, key: "wrapped", wrapped: true };
  const spans = arcs.flatMap((arc) => {
    const from = boxes.get(arc.loop.from.id);
    const to = boxes.get(arc.loop.to.id);
    return from && to
      ? [{ id: arc.id, target: arc.loop.to.id, from, to, fired: arc.loop.fired > 0, span: Math.abs(from.cx - to.cx) }]
      : [];
  });
  if (!spans.length) return EMPTY_BAND;
  /* Shallowest first: the short arc hangs above the long one, so neither hides
     under the other and neither crosses a pill. */
  const ranked = [...spans].sort((a, b) => a.span - b.span);
  /* Heads that share a target pill are fanned along it in the order the arcs
     hang — the shallowest on the pill's centre, each deeper one a step AWAY
     from its own source. Fanned the other way, towards the sources, the deep
     arc's rising leg cuts through the shallow arc a few pixels under the tips
     and the two read as one smudged double arrow. */
  const heads = new Map<string, number>();
  const byTarget = new Map<string, typeof ranked>();
  for (const entry of ranked) {
    const group = byTarget.get(entry.target) ?? byTarget.set(entry.target, []).get(entry.target)!;
    const toward = Math.sign(entry.from.cx - entry.to.cx) || 1;
    heads.set(entry.id, entry.to.cx - group.length * ARC_FAN * toward);
    group.push(entry);
  }
  /* A fan wider than the pill it lands on slides back onto it as one piece, so
     the clear air between two tips survives a narrow target. */
  for (const group of byTarget.values()) {
    const xs = group.map((entry) => heads.get(entry.id)!);
    const low = group[0]!.to.left + ARC_HEAD_HALF;
    const high = group[0]!.to.right - ARC_HEAD_HALF;
    const shift = Math.max(...xs) > high ? high - Math.max(...xs) : Math.min(...xs) < low ? low - Math.min(...xs) : 0;
    if (shift) for (const entry of group) heads.set(entry.id, heads.get(entry.id)! + shift);
  }
  const paths = new Map<string, ArcPath>();
  let deepest = 0;
  for (const [rank, entry] of ranked.entries()) {
    const dip = ARC_DIP + rank * ARC_STEP;
    /* A cubic hangs three quarters of the way to its control points, so the
       controls go deeper than the dip the arc is meant to have. */
    const control = round((dip * 4) / 3);
    const x1 = round(entry.from.cx);
    const x2 = round(heads.get(entry.id)!);
    /* Drawn from the arrowhead back to the failing pill, which is the same
       curve and a different dash phase: a dash pattern starts painting at the
       path's first point, so the head end is always met by ink and whatever
       gap the pattern ends on falls under the pill the arc leaves. Drawn the
       other way round the dashed arcs lose their last dash and the arrowhead
       floats free of its own line. */
    paths.set(entry.id, {
      d: `M ${x2} ${ARC_HEAD} C ${x2} ${control} ${x1} ${control} ${x1} 0`,
      head: `${x2},0 ${x2 - ARC_HEAD_HALF},${ARC_HEAD} ${x2 + ARC_HEAD_HALF},${ARC_HEAD}`,
      lx: round((x1 + x2) / 2),
      ly: dip,
      rank,
    });
    deepest = Math.max(deepest, dip);
  }
  const top = round(Math.max(...[...boxes.values()].map((box) => box.bottom)) + ARC_GAP);
  /* Only a counter needs the label room under the deepest arc, and only some
     rows have one: a lane whose edges all rest reserves the ink and no more. */
  const height = deepest + (ranked.some((entry) => entry.fired) ? ARC_LABEL : ARC_QUIET);
  return {
    key: `${top}|${height}|${[...paths].map(([id, path]) => `${id}@${path.d}`).join(";")}`,
    wrapped: false,
    top,
    height,
    paths,
  };
}

/** The arc layer: one group per fail edge, each carrying its own state so a
    test and a rendered frame read the same thing off the same element.

    At rest the arc is all the surface the explanation has, and 1.5 px of dashes
    is nothing to point at: the gaps between the dashes are not the arc, and a
    pixel off the curve is not the arc either. So every arc also carries a wide
    transparent stroke on its own path — that is what the pointer meets, and the
    group's title opens from it wherever along the curve the eye is.

    A title has no long-press, so the same stroke answers a tap by writing the
    sentence out under the row. Without that the arc is the one thing on a
    tablet's card that explains nothing at all. */
function ReturnArcs({ arcs, band, titles }: { arcs: readonly LoopArc[]; band: ArcBand; titles: ReadonlyMap<string, string> }) {
  const [tapped, setTapped] = useState<string | null>(null);
  /* An arc that stopped being drawn takes its own note away with it. */
  const open = tapped && arcs.some((arc) => arc.id === tapped) ? tapped : null;
  useEffect(() => {
    if (!open) return;
    const away = () => setTapped(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setTapped(null); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  /* Deepest first, so the shallow arc — the one nearer the row, and the one an
     eye follows first — is painted over the deep one and is what a pointer
     meets where the two converge into their target. Every head ends on the
     pill's own edge, so nested arcs always come within a few pixels of each
     other there, and something has to be on top. Unmeasured arcs keep the
     order they were given. */
  const ordered = [...arcs]
    .map((arc, index) => ({ arc, rank: band.paths.get(arc.id)?.rank ?? -index }))
    .sort((one, two) => two.rank - one.rank);
  return (
    <>
      <svg className="parcs" style={{ top: band.top, height: band.height }} width="100%" height={band.height} focusable="false" data-arc-layer="1">
        {ordered.map(({ arc }) => {
          const path = band.paths.get(arc.id);
          const title = titles.get(arc.id) ?? "";
          return (
            <g
              key={arc.id}
              role="img"
              aria-label={title}
              data-loop-arc={arc.id}
              data-arc-state={arc.state}
              data-arc-live={arc.live ? "1" : "0"}
              data-arc-fired={arc.loop.fired}
              data-arc-max={arc.loop.max}
            >
              <title>{title}</title>
              {path ? <path className="parc" d={path.d} /> : null}
              {path ? <polygon className="parc-head" points={path.head} /> : null}
              {arc.loop.fired ? <text className="parc-count" x={path?.lx ?? 0} y={path?.ly ?? 0}>{`${arc.loop.fired}/${arc.loop.max}`}</text> : null}
              {path ? (
                <path
                  className="parc-hit"
                  d={path.d}
                  data-arc-hit={arc.id}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setTapped((current) => (current === arc.id ? null : arc.id));
                  }}
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      {open ? (
        <span className="parc-note" role="note" data-arc-note={open} style={{ top: band.top + band.height + 2 }}>
          {titles.get(open)}
        </span>
      ) : null}
    </>
  );
}

/** The wrapped row's stand-in for an arc: the return glyph and the same count,
    on the failing stage's own pill, and only once the edge has fired. */
function ReturnSuffix({ arc, title }: { arc: LoopArc; title: string }) {
  return (
    <span className="pret" title={title} data-stage-return={arc.id} data-arc-state={arc.state} data-arc-fired={arc.loop.fired} data-arc-max={arc.loop.max}>
      <span aria-hidden="true">↺</span>
      {`${arc.loop.fired}/${arc.loop.max}`}
    </span>
  );
}

/** Registers a stage pill so the arcs can be drawn from its measured box. */
const chipRef = (boxes: React.RefObject<Map<string, HTMLElement>>, id: string) =>
  (element: HTMLElement | null) => {
    if (element) boxes.current.set(id, element);
    else boxes.current.delete(id);
  };

/** The one-line summary: the pass path in order, then the branches, with every
    fail edge drawn under the row as a return arc rather than as a chip of its
    own (#1798), so a cycle is never flattened and never reads as a step. */
function PipelineChips({ summary, nameOf, selected, onOpenStage }: {
  summary: KanbanPipeline;
  nameOf: (stage: PipelineStage) => string;
  selected: ReadonlySet<string>;
  onOpenStage: (pipeline: Pipeline, stage: PipelineStage) => void;
}) {
  const { t } = useLocale();
  const { pipeline } = summary;
  const main = summary.chips.filter((chip) => !chip.branch);
  const branches = summary.chips.filter((chip) => chip.branch);
  const arcs = useMemo(() => loopArcs(summary), [summary]);
  const titles = useMemo(
    () => new Map(arcs.map((arc) => [arc.id, arcTitle(t, arc, nameOf(arc.loop.from), nameOf(arc.loop.to))] as const)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the names and the translator come from the same render
    [arcs, t],
  );
  const row = useRef<HTMLDivElement | null>(null);
  const chipBoxes = useRef(new Map<string, HTMLElement>());
  const [band, setBand] = useState<ArcBand>(EMPTY_BAND);
  /* The arcs are the only thing here that needs the pills' boxes, so the
     measurement runs only while a fail edge exists, and re-runs when the row
     or a pill changes size. A band identical to the one on screen is dropped
     rather than set, so the padding this same measurement adds to the row
     cannot feed itself. */
  const arcKey = arcs.map((arc) => `${arc.id}:${arc.state}:${arc.live ? 1 : 0}`).join("|");
  useLayoutEffect(() => {
    const element = row.current;
    if (!element || !arcs.length) {
      setBand((previous) => (previous.key === EMPTY_BAND.key ? previous : EMPTY_BAND));
      return;
    }
    const remeasure = () => setBand((previous) => {
      const next = measureArcs(element, chipBoxes.current, arcs);
      return previous.key === next.key ? previous : next;
    });
    remeasure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(remeasure);
    observer.observe(element);
    for (const box of chipBoxes.current.values()) observer.observe(box);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the arcs the row draws
  }, [arcKey]);
  /* On a wrapped row the arc becomes a suffix on the pill of the stage that
     fails, and only once it has fired: at rest the row says nothing extra. */
  const suffixes = new Map(band.wrapped ? arcs.filter((arc) => arc.state !== "rest").map((arc) => [arc.loop.from.id, arc] as const) : []);
  const chip = (entry: (typeof summary.chips)[number], index: number, branch: boolean) => {
    const label = nameOf(entry.stage);
    const state = graphStateWord(t, entry.state);
    /* A chip opens what a click reaches: the stage's latest own attempt's conversation. */
    const current = latestAttempt(pipeline, entry.stage.id);
    const openable = Boolean(current?.agentPath || current?.conversationId) || stageDraftable(pipeline, entry.stage.id);
    const className = `pchip tone-${STAGE_TONE[entry.state]} st-${entry.state}${branch ? " side" : ""}${selected.has(entry.stage.id) ? " selected" : ""}`;
    /* Who runs it and how hard it thinks, without a word of text (#1743): the
       engine mark and the effort ladder ride the chip itself. */
    const identity = stageIdentity(pipeline, entry.stage);
    const suffix = suffixes.get(entry.stage.id) ?? null;
    const body = (
      <>
        <i className="pdot" aria-hidden="true" />
        <StageIdentity
          identity={identity}
          density="chip"
          name={<span className="pname">{branch ? t("kanban.branch", { stage: label }) : label}</span>}
        />
        {entry.rounds ? <CountCircle n={entry.rounds} tone="neutral" label={t("kanban.stageAriaRounds", { stage: label, state, count: entry.rounds })} /> : null}
        {suffix ? <ReturnSuffix arc={suffix} title={titles.get(suffix.id) ?? ""} /> : null}
      </>
    );
    const aria = [
      entry.rounds ? t("kanban.stageAriaRounds", { stage: label, state, count: entry.rounds }) : t("kanban.stageAria", { stage: label, state }),
      identityTitle(t, identity),
      suffix ? titles.get(suffix.id) : null,
    ].filter(Boolean).join(". ");
    const hover = [`${label} · ${state} · ${identityTitle(t, identity)}`, suffix ? titles.get(suffix.id) : null].filter(Boolean).join(" · ");
    return openable ? (
      <button key={entry.stage.id} ref={chipRef(chipBoxes, entry.stage.id)} type="button" className={className} data-stage={entry.stage.id} aria-label={aria} title={hover} onClick={() => onOpenStage(pipeline, entry.stage)}>
        {body}
      </button>
    ) : (
      <span key={entry.stage.id} ref={chipRef(chipBoxes, entry.stage.id)} className={className} data-stage={entry.stage.id} role="img" aria-label={aria} title={hover} data-index={index}>
        {body}
      </span>
    );
  };
  /* The row grows by the arcs' depth, and only when an arc is actually drawn. */
  const arcsDrawn = arcs.length > 0 && !band.wrapped;
  return (
    <div
      className="psummary"
      ref={row}
      data-arcs={arcs.length ? (band.wrapped ? "suffix" : "arcs") : undefined}
      style={arcsDrawn && band.height ? { paddingBottom: band.height + ARC_GAP } : undefined}
    >
      {main.map((entry, index) => (
        <span key={entry.stage.id} className="pchip-wrap">
          {index > 0 ? <span className="parrow" aria-hidden="true">→</span> : null}
          {chip(entry, index, false)}
        </span>
      ))}
      {branches.map((entry, index) => chip(entry, index, true))}
      {arcsDrawn ? <ReturnArcs arcs={arcs} band={band} titles={titles} /> : null}
    </div>
  );
}

/** The Stages sheet's loop chip (#1743): the leading glyph becomes the same
    circled number the arrow draws once the edge has fired, and a spent budget
    inverts the chip so "no return left" reads without colour.

    The sheet's nav is the one surface this still belongs on — it lists what the
    graph holds, where a fail edge IS one of the things listed. The card's
    collapsed row draws the same edge as a return arc instead, because a chip
    there sits in the row of steps and reads as one (#1798).

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
  const labelOf = (row: PastAttempt) => {
    const stage = names.get(row.pipelineId)?.get(row.stageId) ?? row.stageId;
    if (row.kind === "helper") return t("kanban.past.helper", { stage, n: row.n });
    if (row.kind === "round") return row.ambiguous ? t("kanban.past.attemptRound", { stage, attempt: row.attempt ?? 0, n: row.n }) : t("kanban.past.round", { stage, n: row.n });
    return t("kanban.past.attempt", { stage, n: row.n });
  };
  const stateOf = (row: PastAttempt) => {
    if (row.kind === "round") return t(`kanban.past.verdict.${row.state === "APPROVE" || row.state === "REQUEST_CHANGES" || row.state === "COMMENT" ? row.state : "open"}`);
    const state = attemptStateLabel(t, row.state as never);
    return row.verdict ? `${state} · ${t(`kanban.past.stageVerdict.${row.verdict as "pass" | "fail" | "needs_decision"}`)}` : state;
  };
  const tone = (row: PastAttempt) => {
    const words = `${row.state} ${row.verdict ?? ""}`;
    if (/passed|APPROVE|\bpass\b/.test(words)) return "ok";
    if (/failed|REQUEST_CHANGES|\bfail\b/.test(words)) return "bad";
    return "";
  };
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
