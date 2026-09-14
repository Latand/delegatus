"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { attemptStateLabel, pipelineStateLabel, stageAttempts, stageChipLabel, type StageChipState } from "@/components/pipelines/pipelineModel";
import { fmtAge } from "@/components/utils";

import type { KanbanPipeline } from "./kanbanModel";
import { edgeFired, graphOrder, layoutGraph, routeEdge, STAGE_TONE, type GraphEdge, type PastAttempt } from "./pipelineGraph";

/* A card's pipeline, as the approved prototype draws it (`renderPipeline`,
   `graph.js`, `pastAttempts`): a header with the pipeline's state and where it
   is, then either the stage graph or its one-line summary, and below the
   card's current work a quiet disclosure of what came before. */

const svgProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const GraphGlyph = () => (
  <svg {...svgProps}><rect x="3" y="4" width="6" height="5" rx="1.5" /><rect x="15" y="4" width="6" height="5" rx="1.5" /><rect x="9" y="15" width="6" height="5" rx="1.5" /><path d="M9 6.5h6M18 9v2.5a2 2 0 0 1-2 2h-1.5M6 9v2.5a2 2 0 0 0 2 2h1.5" /></svg>
);
const ListGlyph = () => (
  <svg {...svgProps}><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" fill="currentColor" /><circle cx="3.5" cy="12" r="1" fill="currentColor" /><circle cx="3.5" cy="18" r="1" fill="currentColor" /></svg>
);
const ChevronRight = () => <svg {...svgProps} className="chev"><path d="m9 6 6 6-6 6" /></svg>;

/* The role glyphs of the prototype; a role it has no glyph for draws the builder's. */
const ROLE_GLYPH: Record<string, React.ReactNode> = {
  builder: <><path d="m14.7 6.3 3 3-8.4 8.4H6.3v-3z" /><path d="m13 8 3 3" /></>,
  reviewer: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  verifier: <><path d="M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6z" /><path d="m9 12 2 2 4-4" /></>,
  architect: <><circle cx="12" cy="5" r="2" /><path d="m11 7-5 13M13 7l5 13M8 15h8" /></>,
  cleaner: <><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="12" r="2" /><path d="M6 8v8M8 6c6 0 8 2 8 4" /></>,
};

const LIVE_CHIP_STATES = new Set<StageChipState>(["running", "reviewing", "committing"]);

/** A stage's name: its role, unless another stage of the same pipeline has that
    role too, where the stage's own id tells them apart. */
export function stageNames(t: TFunction, pipeline: Pipeline): Map<string, string> {
  const roles = pipeline.stages.map((stage) => stageChipLabel(t, stage));
  const repeated = new Set(roles.filter((label, index) => roles.indexOf(label) !== index));
  return new Map(pipeline.stages.map((stage, index) => {
    const role = roles[index]!;
    if (!repeated.has(role)) return [stage.id, role] as const;
    const words = stage.id.replace(/[-_]+/g, " ").trim();
    return [stage.id, words ? words[0]!.toUpperCase() + words.slice(1) : role] as const;
  }));
}

export function pipelineProgress(t: TFunction, summary: KanbanPipeline, nameOf: (stage: PipelineStage) => string): string {
  const { pipeline, chips } = summary;
  if (pipeline.state === "provisioning") return t("kanban.progress.provisioning");
  const needs = chips.find((chip) => chip.state === "needs_decision");
  if (needs) return t("kanban.progress.needs", { stage: nameOf(needs.stage) });
  const live = chips.find((chip) => LIVE_CHIP_STATES.has(chip.state));
  if (live) {
    const attempts = stageAttempts(pipeline, live.stage.id).length;
    const base = t("kanban.progress.live", { stage: nameOf(live.stage), state: attemptStateLabel(t, live.state) });
    return attempts > 1 ? t("kanban.progress.attempt", { progress: base, n: attempts }) : base;
  }
  if (pipeline.state === "completed") return pipelineStateLabel(t, pipeline.state);
  const failed = chips.find((chip) => chip.state === "failed");
  if (failed) return t("kanban.progress.failed", { stage: nameOf(failed.stage) });
  return pipelineStateLabel(t, pipeline.state);
}

export const graphStateWord = (t: TFunction, state: StageChipState) => t(`kanban.graphState.${state}`);

/** The pipeline states a card opens on its graph when the operator has not chosen. */
const ACTIVE_PIPELINE = new Set(["provisioning", "running", "needs_decision", "paused"]);

export function PipelineSection({ summary, workspace, open, selected, onToggle, onOpenStage }: {
  summary: KanbanPipeline;
  workspace: boolean;
  /** The operator's choice for this card, or null for the default. */
  open: boolean | null;
  /** Stage ids whose conversation is open on the card. */
  selected: ReadonlySet<string>;
  onToggle: (open: boolean) => void;
  onOpenStage: (pipeline: Pipeline, stage: PipelineStage) => void;
}) {
  const { t } = useLocale();
  const { pipeline } = summary;
  const names = useMemo(() => stageNames(t, pipeline), [t, pipeline]);
  const nameOf = (stage: PipelineStage) => names.get(stage.id) ?? stageChipLabel(t, stage);
  /* Prototype: an active pipeline of up to four stages opens on its graph in
     the workspace column; everything else starts as the summary. */
  const showGraph = open ?? (workspace && ACTIVE_PIPELINE.has(pipeline.state) && pipeline.stages.length <= 4);
  const progress = pipelineProgress(t, summary, nameOf);
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
      aria-label={t("kanban.pipelineAria", { progress })}
    >
      <div className="sec-head">
        <span className="kind">{t("kanban.pipeline")}</span>
        <span className="pstate-chip" data-pstate={pipeline.state}>{pipelineStateLabel(t, pipeline.state)}</span>
        <span className="progress">{progress}</span>
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
      </div>
      <div className="graph-slot" ref={slot} data-graph={pipeline.id} data-open={showGraph ? "1" : "0"}>
        {showGraph ? (
          available === null ? null : <PipelineGraph summary={summary} names={names} available={available} selected={selected} onOpenStage={onOpenStage} />
        ) : (
          <PipelineChips summary={summary} nameOf={nameOf} selected={selected} onOpenStage={onOpenStage} />
        )}
      </div>
    </div>
  );
}

/** The one-line summary: the pass path in order, then every loop and branch as
    its own chip, so a cycle is never flattened. */
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
  const chip = (entry: (typeof summary.chips)[number], index: number, branch: boolean) => {
    const label = nameOf(entry.stage);
    const state = graphStateWord(t, entry.state);
    const openable = stageAttempts(pipeline, entry.stage.id).some((attempt) => attempt.agentPath || attempt.conversationId);
    const className = `pchip tone-${STAGE_TONE[entry.state]} st-${entry.state}${branch ? " side" : ""}${selected.has(entry.stage.id) ? " selected" : ""}`;
    const body = (
      <>
        <i className="pdot" aria-hidden="true" />
        <span className="pname">{branch ? t("kanban.branch", { stage: label }) : label}</span>
        {entry.rounds ? <span className="prounds">{t("kanban.rounds", { count: entry.rounds })}</span> : null}
      </>
    );
    const aria = entry.rounds ? t("kanban.stageAriaRounds", { stage: label, state, count: entry.rounds }) : t("kanban.stageAria", { stage: label, state });
    return openable ? (
      <button key={entry.stage.id} type="button" className={className} data-stage={entry.stage.id} aria-label={aria} title={`${label} · ${state}`} onClick={() => onOpenStage(pipeline, entry.stage)}>
        {body}
      </button>
    ) : (
      <span key={entry.stage.id} className={className} data-stage={entry.stage.id} role="img" aria-label={aria} title={`${label} · ${state}`} data-index={index}>
        {body}
      </span>
    );
  };
  return (
    <div className="psummary">
      {main.map((entry, index) => (
        <span key={entry.stage.id} className="pchip-wrap">
          {index > 0 ? <span className="parrow" aria-hidden="true">→</span> : null}
          {chip(entry, index, false)}
        </span>
      ))}
      {summary.loops.map((loop) => (
        <span
          key={`${loop.from.id}->${loop.to.id}`}
          className="ploop fail"
          title={t("kanban.loopTitle", { from: nameOf(loop.from), to: nameOf(loop.to), fired: loop.fired, max: loop.max })}
        >
          {t("kanban.loop", { from: nameOf(loop.from), to: nameOf(loop.to), fired: loop.fired, max: loop.max })}
        </span>
      ))}
      {branches.map((entry, index) => chip(entry, index, true))}
    </div>
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
export function PipelineGraph({ summary, names, available, selected, onOpenStage, force }: {
  summary: KanbanPipeline;
  names: ReadonlyMap<string, string>;
  available: number;
  selected: ReadonlySet<string>;
  onOpenStage: (pipeline: Pipeline, stage: PipelineStage) => void;
  force?: "LR" | "TB";
}) {
  const { t } = useLocale();
  const { pipeline, views } = summary;
  const layout = useMemo(() => layoutGraph(pipeline, available, force), [pipeline, available, force]);
  const nameOf = (id: string) => names.get(id) ?? id;

  /* Live edges: attempts that were not here on the last render and name the
     edge that activated them. The first render marks nothing. */
  const seenAttempts = useRef<Set<string> | null>(null);
  const [live, setLive] = useState<ReadonlySet<string>>(new Set());
  const attemptKeys = pipeline.runs.flatMap((run) => run.attempts.map((attempt) => `${run.stageId}#${attempt.n}`)).join("|");
  useEffect(() => {
    const current = new Set(attemptKeys ? attemptKeys.split("|") : []);
    const before = seenAttempts.current;
    seenAttempts.current = current;
    if (!before) return;
    const fresh = new Set<string>();
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (before.has(`${run.stageId}#${attempt.n}`) || !attempt.activatedBy) continue;
        fresh.add(`${attempt.activatedBy.stageId}:${attempt.activatedBy.edge}:${run.stageId}`);
      }
    }
    if (!fresh.size) return;
    setLive(fresh);
    const timer = setTimeout(() => setLive(new Set()), LIVE_EDGE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the attempts the pipeline holds
  }, [attemptKeys]);

  const legend: Array<{ n: number; text: string }> = [];
  const labels: React.ReactNode[] = [];
  const paths: React.ReactNode[] = [];
  for (const edge of layout.topology.edges) {
    const route = routeEdge(layout, edge);
    if (!route) continue;
    const fired = edgeFired(pipeline, edge);
    const back = layout.topology.back.has(edge.id);
    const isLive = live.has(edge.id);
    paths.push(
      <path
        key={edge.id}
        d={route.d}
        className={`pedge ${edge.kind}${back ? " back" : ""}${fired ? " taken" : ""}${isLive ? " live" : ""}`}
        markerEnd="url(#kb-pg-arrow)"
        data-edge={edge.id}
      />,
    );
    const label = edgeLabel(t, edge, fired, layout.topology.branching.has(edge.from));
    if (!label) continue;
    const style = { left: `${route.label[0]}px`, top: `${route.label[1]}px` };
    if (edge.kind === "fail" && layout.dir === "TB" && layout.labelMode === "legend" && back) {
      legend.push({ n: legend.length + 1, text: t("kanban.graph.legendFail", { from: nameOf(edge.from), to: nameOf(edge.to), n: fired, max: edge.maxRounds ?? 0 }) });
      labels.push(<span key={`label-${edge.id}`} className={`pelabel ${edge.kind} badge${isLive ? " live" : ""}`} data-edge-label={edge.id} style={style} title={label.long}>{legend.length}</span>);
    } else {
      const beside = route.labelAxis === "v" && edge.kind === "fail" && back;
      labels.push(
        <span key={`label-${edge.id}`} className={`pelabel ${edge.kind}${beside ? " beside" : ""}${isLive ? " live" : ""}`} data-edge-label={edge.id} style={beside ? { left: `${route.label[0] + 8}px`, top: `${route.label[1]}px` } : style} title={label.long}>
          {edge.kind === "fail" && back ? label.long : label.short}
        </span>,
      );
    }
  }

  return (
    <div className="pgraph-box">
      <div
        className={`pgraph dir-${layout.dir}`}
        data-dir={layout.dir}
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
          const roleId = stage.role?.roleId ?? (stage.kind === "review-loop" ? "reviewer" : "builder");
          const engine = attempt?.effectiveRole.engine ?? stage.effectiveRole.engine;
          const isSelected = selected.has(stage.id);
          const rounds = view?.rounds ?? [];
          const attempts = view?.attempts ?? 0;
          const detail = view?.again ? (
            <span className="pdetail">{t("kanban.graph.nextAttempt", { state: graphStateWord(t, view.previous ?? "pending") })}</span>
          ) : rounds.length ? rounds.map((round) => (
            <span
              key={round.n}
              className={`rchip ${round.verdict === "approved" ? "ok" : round.verdict === "changes" ? "bad" : "open"}`}
              title={t("kanban.graph.roundTitle", { n: round.n, verdict: t(`kanban.graph.verdict.${round.verdict}`) })}
            >
              R{round.n} {round.verdict === "approved" ? "✓" : round.verdict === "changes" ? "✕" : "…"}
            </span>
          )) : (
            <span className="pdetail">
              {attempts
                ? stage.onFail ? t("kanban.graph.attemptRetries", { n: attempts, count: stage.onFail.maxRounds }) : t("kanban.graph.attempt", { n: attempts })
                : stage.kind === "review-loop" ? t("kanban.graph.reviewsRun") : t("kanban.graph.notStarted")}
            </span>
          );
          const aria = [
            t("kanban.graph.nodeAria", { stage: nameOf(stage.id), engine: engine === "codex" ? "Codex" : "Claude", state: word }),
            attempts ? t("kanban.graph.attempt", { n: attempts }) : "",
            rounds.length ? rounds.map((round) => t("kanban.graph.roundTitle", { n: round.n, verdict: t(`kanban.graph.verdict.${round.verdict}`) })).join(", ") : "",
            conversation ? (isSelected ? t("kanban.graph.conversationOpen") : t("kanban.graph.openConversation")) : t("kanban.graph.noConversation"),
          ].filter(Boolean).join(". ");
          return (
            <button
              key={stage.id}
              type="button"
              className={`pnode tone-${STAGE_TONE[state]} st-${state} role-${roleId}${stage.kind === "review-loop" ? " review" : ""}${isSelected ? " selected" : ""}${conversation ? "" : " no-conv"}${state === "running" || state === "reviewing" ? " pulse" : ""}`}
              data-stage={stage.id}
              style={{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` }}
              aria-pressed={isSelected}
              aria-disabled={conversation ? undefined : true}
              aria-label={aria}
              title={conversation ? undefined : state === "pending" ? t("kanban.graph.waitingTitle") : t("kanban.graph.noConversationTitle")}
              onClick={() => { if (conversation) onOpenStage(pipeline, stage); }}
            >
              <span className="pport in" aria-hidden="true" />
              {layout.topology.branching.has(stage.id) ? (
                <>
                  <span className="pport out pass" aria-hidden="true" />
                  <span className="pport out fail" aria-hidden="true" />
                </>
              ) : <span className="pport out" aria-hidden="true" />}
              <span className="prow">
                <span className="pglyph" aria-hidden="true"><svg {...svgProps} strokeWidth={1.8}>{ROLE_GLYPH[roleId] ?? ROLE_GLYPH.builder}</svg></span>
                <span className="pname">{nameOf(stage.id)}</span>
                <span className={`pengine ${engine}`} aria-hidden="true" />
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
        <ol className="plegend">
          {legend.map((entry) => (
            <li key={entry.n}><span className="pelabel badge static">{entry.n}</span><span>{entry.text}</span></li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function edgeLabel(t: TFunction, edge: GraphEdge, fired: number, branching: boolean): { short: string; long: string } | null {
  if (edge.kind === "fail") return { short: t("kanban.graph.fail"), long: t("kanban.graph.failRetry", { n: fired, max: edge.maxRounds ?? 0 }) };
  return branching ? { short: t("kanban.graph.pass"), long: t("kanban.graph.pass") } : null;
}

/** "Past attempts · N": earlier attempts and review rounds, newest first. Each
    opens its conversation when one was kept. */
export function PastAttempts({ rows, names, nowMs, onOpen }: {
  rows: readonly PastAttempt[];
  /** Stage names by pipeline id, then stage id. */
  names: ReadonlyMap<string, ReadonlyMap<string, string>>;
  nowMs: number;
  onOpen: (conversation: PastAttempt["conversation"]) => void;
}) {
  const { t } = useLocale();
  if (!rows.length) return null;
  const labelOf = (row: PastAttempt) => {
    const stage = names.get(row.pipelineId)?.get(row.stageId) ?? row.stageId;
    return row.kind === "round" ? t("kanban.past.round", { stage, n: row.n }) : t("kanban.past.attempt", { stage, n: row.n });
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
  const latest = rows[0]!;
  return (
    <details className="history" data-past-attempts={rows.length}>
      <summary aria-label={t("kanban.past.aria", { count: rows.length, label: labelOf(latest), state: stateOf(latest) })}>
        <ChevronRight />
        <span className="hl">{t("kanban.past.head", { count: rows.length })}</span>
        <span className="lbl">{t("kanban.past.last", { label: labelOf(latest), state: stateOf(latest), age: age(latest) })}</span>
      </summary>
      <p className="hnote">{t("kanban.past.note")}</p>
      <ul>
        {rows.map((row) => (
          <li key={row.key} data-past={row.key}>
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
        ))}
      </ul>
    </details>
  );
}
