"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage, PipelineStageReportEntry } from "@/lib/pipelines/types";
import { humanizeDuration } from "@/components/turnDuration";
import { fmtAge } from "@/components/utils";
import { WorkLinkRow, WorkLinkText } from "@/components/workLinks/WorkLinkChips";
import { useWorkLinks, type WorkLinkTarget } from "@/components/workLinks/workLinksContext";
import { CountCircle, identityTitle, StageIdentity } from "@/components/kanban/identityMarks";
import type { KanbanPipeline, KanbanStageChip } from "@/components/kanban/kanbanModel";
import { ChevronRight, MoreGlyph, svgProps } from "@/components/kanban/kanbanGlyphs";
import { STAGE_TONE } from "@/components/kanban/pipelineGraph";
import {
  arcTitle, GraphEditLine, GraphGlyph, graphStateWord, ListGlyph, loopArcs, PipelineGraph, pipelineProgress, pipelineTitle, ReturnSuffix, StageReportLine,
  type LoopArc,
} from "@/components/kanban/PipelineSection";
import { stageIdentity } from "@/components/kanban/stageIdentity";
import { stageDraftable, type PipelineActionKind } from "@/components/kanban/stagesModel";

import { latestAttempt, pipelineReviewHeads, pipelineStagePosition, pipelineStateLabel, stageChipLabel, stageNames, type StageChipState } from "./pipelineModel";
import {
  blockAgeSeconds, cardChain, cardChainLevels, currentChipIndex, parkedStage, pipelineAnswers, pipelineEnded, pipelineMovedAtMs, pipelineNeedsYou, pipelineReason, sameTitle, STAGE_MARK, stageFindings,
  type ChainItem, type PipelineAnswer, type PipelineAnswers, type PipelineBlockDensity,
} from "./pipelineBlockModel";

/*
 * One pipeline, drawn by one component everywhere it appears (#2072 slice 3;
 * docs/design/phone-kanban.md §3.13, docs/design/desktop-flat-cards.md §4,
 * variant B). It reads the desktop's `KanbanPipeline` summary and draws it at
 * one of three densities:
 *
 * - `card`: a board card's line. The chain folds to one line of 22 px pills,
 *   the age and the PR ride beside it as passive text, and a lane that needs
 *   the operator adds its reason in warning ink. Nothing in it is a control:
 *   the card around it is one button.
 * - `task`: a task's lane row, the desktop card's and the phone task
 *   screen's. No frame of its own, a hairline above it: a head line (title
 *   unless it is the task's, state word, age, ›), the chain with its PR and
 *   issue chips at the end, and the answer in place when the lane needs the
 *   operator.
 * - `screen`: the pipeline screen's body. The state line, the chips with
 *   "Attach", a numbered stage list with the current stage expanded and the
 *   answer inside it.
 *
 * The pill is the phone's: an outline with no fill around a mark and the
 * stage's name. The mark's shape carries the state and its colour is the
 * stage's `STAGE_TONE`, the one tone map the desktop graph reads. Who runs a
 * stage (engine, model, effort) is in the pill's tooltip, the Stages sheet
 * and the graph, not on the pill. A fail edge rides the failing pill as
 * "↺ 1/2".
 */

const LIVE = new Set<StageChipState>(["running", "reviewing", "committing"]);

/** How many findings the answer lists before counting the rest. */
const ANSWER_FINDINGS = 1;

/** The mark in front of a stage's name. */
export function StageToneMark({ state, className }: { state: StageChipState; className?: string }) {
  const shape = STAGE_MARK[state];
  return (
    <i
      className={`pmark tone-${STAGE_TONE[state]}${className ? ` ${className}` : ""}`}
      data-mark={shape}
      data-live={LIVE.has(state) ? "1" : undefined}
      aria-hidden="true"
    >
      {shape === "check" ? <svg {...svgProps} strokeWidth={3}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg> : null}
      {shape === "cross" ? <svg {...svgProps} strokeWidth={3}><path d="M17 7 7 17M7 7l10 10" /></svg> : null}
      {shape === "alert" ? <span className="pmark-bang">!</span> : null}
    </i>
  );
}

interface Suffix { arc: LoopArc; title: string }

/** Who runs a stage, for the pill's tooltip and label (#1743): engine, model
    and effort left the pill for its hover, the Stages sheet and the graph. A
    record written before stages carried their resolved role names nobody. */
function whoRuns(t: TFunction, pipeline: Pipeline, stage: PipelineStage): string | null {
  return stage.effectiveRole ? identityTitle(t, stageIdentity(pipeline, stage)) : null;
}

/** Each fail edge, by the stage that fails. At rest it draws nothing and its
    sentence stays in that pill's tooltip; once it fired, the pill carries it. */
function loopSuffixes(t: TFunction, summary: KanbanPipeline, nameOf: (stage: PipelineStage) => string): Map<string, Suffix> {
  return new Map(loopArcs(summary)
    .map((arc) => [arc.loop.from.id, { arc, title: arcTitle(t, arc, nameOf(arc.loop.from), nameOf(arc.loop.to)) }] as const));
}

const drawn = (suffix: Suffix | null): suffix is Suffix => Boolean(suffix && suffix.arc.state !== "rest");

function StagePill({ pipeline, chip, name, suffix, interactive, selected, onOpen }: {
  pipeline: Pipeline;
  chip: KanbanStageChip;
  name: string;
  suffix: Suffix | null;
  /** A pill that opens the stage's conversation where it has one; on a card it is text. */
  interactive: boolean;
  selected: boolean;
  onOpen?: (pipeline: Pipeline, stage: PipelineStage) => void;
}) {
  const { t } = useLocale();
  const state = graphStateWord(t, chip.state);
  const attempt = latestAttempt(pipeline, chip.stage.id);
  const conversation = Boolean(attempt?.agentPath || attempt?.conversationId);
  const openable = interactive && Boolean(onOpen) && (conversation || stageDraftable(pipeline, chip.stage.id));
  const who = whoRuns(t, pipeline, chip.stage);
  const aria = [
    chip.rounds ? t("kanban.stageAriaRounds", { stage: name, state, count: chip.rounds }) : t("kanban.stageAria", { stage: name, state }),
    who,
    suffix?.title,
  ].filter(Boolean).join(". ");
  const hover = [[name, state, who].filter(Boolean).join(" · "), suffix?.title].filter(Boolean).join(" · ");
  const className = `pb-pill tone-${STAGE_TONE[chip.state]} st-${chip.state}${attempt ? "" : " waiting"}${chip.branch ? " side" : ""}${selected ? " selected" : ""}`;
  const body = (
    <>
      <StageToneMark state={chip.state} />
      <span className="pb-name">{chip.branch ? t("kanban.branch", { stage: name }) : name}</span>
      {chip.rounds ? <CountCircle n={chip.rounds} tone="neutral" label={t("kanban.stageAriaRounds", { stage: name, state, count: chip.rounds })} /> : null}
      {drawn(suffix) ? <ReturnSuffix arc={suffix.arc} title={suffix.title} /> : null}
    </>
  );
  return openable ? (
    <button type="button" className={className} data-stage={chip.stage.id} aria-label={aria} title={hover} onClick={() => onOpen!(pipeline, chip.stage)}>
      {body}
    </button>
  ) : (
    <span className={className} data-stage={chip.stage.id} title={hover} {...(interactive ? { role: "img", "aria-label": aria } : {})}>
      {body}
    </span>
  );
}

/** The chain as a row that wraps: the pass path joined by arrows, then the fail branches. */
function ChainPills({ summary, nameOf, suffixes, selected, onOpenStage }: {
  summary: KanbanPipeline;
  nameOf: (stage: PipelineStage) => string;
  suffixes: ReadonlyMap<string, Suffix>;
  selected: ReadonlySet<string>;
  onOpenStage?: (pipeline: Pipeline, stage: PipelineStage) => void;
}) {
  const main = summary.chips.filter((chip) => !chip.branch);
  const branches = summary.chips.filter((chip) => chip.branch);
  const pill = (chip: KanbanStageChip) => (
    <StagePill
      pipeline={summary.pipeline}
      chip={chip}
      name={nameOf(chip.stage)}
      suffix={suffixes.get(chip.stage.id) ?? null}
      interactive
      selected={selected.has(chip.stage.id)}
      onOpen={onOpenStage}
    />
  );
  return (
    <div className="pb-pills" data-chain={summary.pipeline.id}>
      {main.map((chip, index) => (
        <span key={chip.stage.id} className="pb-step">
          {index > 0 ? <span className="pb-arrow" aria-hidden="true">→</span> : null}
          {pill(chip)}
        </span>
      ))}
      {branches.map((chip) => <span key={chip.stage.id} className="pb-step">{pill(chip)}</span>)}
    </div>
  );
}

/**
 * The card's chain on one line (§3.13): the widest fold that fits, measured,
 * never cutting the current stage. A card gets its width late (the board lays
 * cards out lazily), so a new width starts the fold over. When the counted
 * fold does not fit beside the age and the PR, the chain takes the line alone,
 * they move to the line below, and the folds are tried again down to the
 * current stage alone. A name too long even for that wraps inside its pill:
 * no pill in the fold ellipsizes, so every fold that settles shows it whole.
 */
function CardLine({ summary, nameOf, suffixes, age, tail }: {
  summary: KanbanPipeline;
  nameOf: (stage: PipelineStage) => string;
  suffixes: ReadonlyMap<string, Suffix>;
  age: React.ReactNode;
  tail: React.ReactNode;
}) {
  const { t } = useLocale();
  const levels = useMemo(() => cardChainLevels(cardChain(summary)), [summary]);
  /* A chain that changed starts the fold over, as a new width does. */
  const key = `${summary.pipeline.id}|${levels.map((level) => level.map((item) => (item.kind === "stage" ? `${item.chip.stage.id}:${item.chip.state}` : `${item.kind}${item.n}`)).join(",")).join("/")}`;
  const [fit, setFit] = useState({ key, width: 0, level: 0, alone: false, wrap: false });
  const current = fit.key === key ? fit : { key, width: fit.width, level: 0, alone: false, wrap: false };
  /* The current stage alone waits for a line of its own: beside the age and
     the PR, the counts around it are worth more than the one line. */
  const lastBeside = levels.length > 1 ? levels.length - 2 : 0;
  const line = useRef<HTMLSpanElement>(null);
  const pills = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = line.current;
    if (!element) return;
    const measure = () => {
      const width = Math.round(element.clientWidth);
      setFit((previous) => (previous.width === width ? previous : { key: previous.key, width, level: 0, alone: false, wrap: false }));
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = pills.current;
    if (!element || !current.width || element.clientWidth === 0) return;
    if (element.scrollWidth <= element.clientWidth + 0.5) return;
    setFit((previous) => {
      const base = previous.key === key ? previous : { ...current };
      if (base.level < (base.alone ? levels.length - 1 : lastBeside)) return { ...base, level: base.level + 1 };
      if (!base.alone) return { ...base, level: 0, alone: true };
      return base.wrap ? base : { ...base, wrap: true };
    });
  });
  const items = levels[Math.min(current.level, levels.length - 1)]!;
  const item = (entry: ChainItem, index: number) => (
    <span key={entry.kind === "stage" ? entry.chip.stage.id : `${entry.kind}-${index}`} className="pb-step">
      {index > 0 ? <span className="pb-arrow" aria-hidden="true">→</span> : null}
      {entry.kind === "stage" ? (
        <StagePill pipeline={summary.pipeline} chip={entry.chip} name={nameOf(entry.chip.stage)} suffix={suffixes.get(entry.chip.stage.id) ?? null} interactive={false} selected={false} />
      ) : entry.kind === "passed" ? (
        <span className="pb-pill tone-ok st-passed fold" data-fold="passed" title={t("pipelineBlock.foldPassed", { count: entry.n })}>
          <StageToneMark state="passed" />
          <span className="pb-name">{entry.n}</span>
        </span>
      ) : (
        <span className="pb-pill more" data-fold="more" title={t("pipelineBlock.foldMore", { count: entry.n })}>
          <span className="pb-name">+{entry.n}</span>
        </span>
      )}
    </span>
  );
  return (
    <>
      <span className="pb-line" ref={line} data-fold-level={current.level} data-alone={current.alone ? "1" : undefined} data-wrap={current.wrap ? "1" : undefined}>
        <span className="pb-pills fold" ref={pills}>{items.map(item)}</span>
        {current.alone ? null : <>{age}<span className="pb-grow" />{tail}</>}
      </span>
      {current.alone ? <span className="pb-line sub">{age}<span className="pb-grow" />{tail}</span> : null}
    </>
  );
}

/** The report a lane that needs a decision is answered from: the parked
    stage's own report and first finding, or the reason when it filed none. */
function DecisionReport({ pipeline, stage, names, nameOf }: {
  pipeline: Pipeline;
  stage: PipelineStage | null;
  names: ReadonlyMap<string, string>;
  nameOf: (stage: PipelineStage) => string;
}) {
  const { t } = useLocale();
  const report: PipelineStageReportEntry | null = stage ? (pipeline.stageReports ?? []).filter((entry) => entry.stageId === stage.id).at(-1) ?? null : null;
  if (report) return <StageReportLine pipeline={pipeline} entry={report} names={names} shown={ANSWER_FINDINGS} />;
  const reason = pipelineReason(t, pipeline, nameOf);
  const findings = stage ? stageFindings(pipeline, stage.id) : [];
  return (
    <>
      {reason ? <p className="stage-report">{reason}</p> : null}
      {findings.length ? (
        <ul className="stage-findings" data-stage-findings={findings.length}>
          {findings.slice(0, ANSWER_FINDINGS).map((finding, index) => (
            <li key={index} data-severity={finding.severity ?? "none"}>
              <span className="sev">{finding.severity ?? t("kanban.stageReport.unranked")}</span>
              <span className="text">{finding.text}</span>
            </li>
          ))}
          {findings.length > ANSWER_FINDINGS ? <li className="more">{t("kanban.stageReport.moreFindings", { count: findings.length - ANSWER_FINDINGS })}</li> : null}
        </ul>
      ) : null}
    </>
  );
}

/** The answer in place: what the lane stopped on, and the two ways on. */
function AnswerPanel({ pipeline, answers, names, nameOf, acting, large, onAnswer }: {
  pipeline: Pipeline;
  answers: PipelineAnswers;
  names: ReadonlyMap<string, string>;
  nameOf: (stage: PipelineStage) => string;
  acting: PipelineActionKind | null;
  /** The pipeline screen's 44 px buttons, in the phone's shorter words. */
  large: boolean;
  onAnswer?: (pipeline: Pipeline, answer: PipelineAnswer) => void;
}) {
  const { t } = useLocale();
  const label = (answer: PipelineAnswer): string => {
    if (answer.action === "continue-review") return t("pipelineBlock.oneMoreRound");
    if (large) return t(answer.action === "skip-stage" ? "mobile2.pipeline.skip" : answer.action === "retry-stage" ? "mobile2.pipeline.retry" : "mobile2.pipeline.archive");
    return t(`kanban.pipelineAct.label.${answer.action}`, { stage: answer.stageName ?? "" });
  };
  return (
    <div className="pb-answer" data-answer={answers.kind}>
      {answers.kind === "review"
        ? <p className="review-heads" data-review-heads={pipeline.id}>{pipelineReviewHeads(t, pipeline)}</p>
        : <DecisionReport pipeline={pipeline} stage={answers.stage} names={names} nameOf={nameOf} />}
      {onAnswer ? (
        <div className={`pb-actions${large ? " large" : ""}`}>
          {answers.choices.map((answer, index) => (
            <button
              key={answer.action}
              type="button"
              className={`pb-act${index === 1 ? " primary" : ""}`}
              data-answer-action={answer.action}
              disabled={Boolean(acting)}
              onClick={() => onAnswer(pipeline, answer)}
            >
              {label(answer)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The operator's graph, measured to the row's width (task density). */
function GraphSlot({ summary, names, selected, onOpenStage }: {
  summary: KanbanPipeline;
  names: ReadonlyMap<string, string>;
  selected: ReadonlySet<string>;
  onOpenStage: (pipeline: Pipeline, stage: PipelineStage) => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = slot.current;
    if (!element) return;
    const measure = () => setAvailable(Math.floor(element.clientWidth));
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="graph-slot pb-graph" ref={slot} data-graph={summary.pipeline.id} data-open="1">
      {available === null ? null : <PipelineGraph summary={summary} names={names} available={available} selected={selected} onOpenStage={onOpenStage} />}
    </div>
  );
}

export interface PipelineBlockProps {
  summary: KanbanPipeline;
  density: PipelineBlockDensity;
  /** The clock the ages are measured against, in ms. */
  nowMs: number;
  /** The task the block sits on: a pipeline titled like it draws no title. */
  taskTitle?: string | null;
  /** Stage ids whose conversation or first message is open where the block is. */
  selected?: ReadonlySet<string>;
  /** The pipeline action this page sent and the server has not answered. */
  acting?: PipelineActionKind | null;
  /** Task density: the operator opened the graph in place of the chain. */
  graphOpen?: boolean;
  onToggleGraph?: (open: boolean) => void;
  onOpenStage?: (pipeline: Pipeline, stage: PipelineStage) => void;
  /** The head's ›: the Stages sheet on the desktop, the pipeline screen on the phone. */
  onOpenStages?: (pipeline: Pipeline) => void;
  onMenu?: (pipeline: Pipeline, anchor: HTMLElement) => void;
  /** Every PR and issue link of the pipeline, with the attach form (#2059). */
  onWorkLinks?: (target: WorkLinkTarget, anchor: HTMLElement) => void;
  /** Answers a decision or a spent review budget in place. Absent, the block
      shows what the lane stopped on and no buttons. */
  onAnswer?: (pipeline: Pipeline, answer: PipelineAnswer) => void;
  /** Card density: what the card adds about its other pipelines ("+1
      paused"), at the right end of the block's last line. */
  aside?: React.ReactNode;
}

const NO_STAGES: ReadonlySet<string> = new Set();

export function PipelineBlock(props: PipelineBlockProps) {
  const { summary, density, nowMs } = props;
  const { t } = useLocale();
  const { pipeline } = summary;
  const names = useMemo(() => stageNames(t, pipeline), [t, pipeline]);
  const nameOf = (stage: PipelineStage) => names.get(stage.id) ?? stageChipLabel(t, stage);
  const links = useWorkLinks().of({ kind: "pipeline", id: pipeline.id });
  const suffixes = loopSuffixes(t, summary, nameOf);
  const needs = pipelineNeedsYou(pipeline);
  const moved = pipelineMovedAtMs(pipeline);
  const selected = props.selected ?? NO_STAGES;
  const title = pipelineTitle(t, pipeline);
  const progress = pipelineProgress(t, summary, nameOf);
  const answers = pipelineAnswers(pipeline, nameOf);
  const root = {
    "data-pipeline": pipeline.id,
    "data-density": density,
    "data-lane-state": pipeline.state,
    "data-needs": needs ? "1" : undefined,
  };

  if (density === "card") {
    const age = moved === null ? "" : humanizeDuration(blockAgeSeconds((nowMs - moved) / 1000));
    const text = <WorkLinkText resolved={links} testId={pipeline.id} className="pb-pr" />;
    if (pipelineEnded(pipeline)) {
      return (
        <span className="pblock" {...root}>
          <span className="pb-line ended">
            <span className="pb-ended">
              <StageToneMark state="passed" />
              {[pipelineStateLabel(t, pipeline.state), age].filter(Boolean).join(" · ")}
            </span>
            <span className="pb-grow" />
            {text}
          </span>
        </span>
      );
    }
    const reason = pipelineReason(t, pipeline, nameOf);
    /* Running says itself in the live pill; any other state that is not the
       operator's to answer says its word beside the age. */
    const word = needs || pipeline.state === "running" ? null : pipelineStateLabel(t, pipeline.state);
    const ageNode = reason ? null : <span className="pb-age">{[word, age].filter(Boolean).join(" · ")}</span>;
    const reasonLine = reason ? <span className="pb-reason" data-pipeline-reason={pipeline.id}>{[reason, age].filter(Boolean).join(" · ")}</span> : null;
    const aside = props.aside ? <span className="pb-aside" data-pipeline-aside={pipeline.id}>{props.aside}</span> : null;
    return (
      <span className="pblock" {...root}>
        <CardLine summary={summary} nameOf={nameOf} suffixes={suffixes} age={ageNode} tail={text} />
        {aside ? (
          <span className={`pb-line${reasonLine ? " reason" : " sub"}`}>{reasonLine}<span className="pb-grow" />{aside}</span>
        ) : reasonLine}
      </span>
    );
  }

  if (density === "screen") {
    return <ScreenBlock {...props} names={names} nameOf={nameOf} suffixes={suffixes} answers={answers} root={root} />;
  }

  /* Task density: the lane row. */
  const showTitle = !sameTitle(title, props.taskTitle);
  /* Running is implied by the live pill; every other state is a word in its tone. */
  const word = pipeline.state === "running" ? null : pipelineStateLabel(t, pipeline.state);
  const age = moved === null ? null : fmtAge(moved / 1000);
  const graphOpen = Boolean(props.graphOpen && props.onToggleGraph && props.onOpenStage);
  const report = !needs && pipeline.stageReports?.length ? pipeline.stageReports.at(-1)! : null;
  return (
    <div className="pblock" role="group" aria-label={t("kanban.pipelineAria", { title, progress })} {...root}>
      <div className="pb-head">
        <button
          type="button"
          className="pb-open"
          data-open-stages={pipeline.id}
          aria-label={`${t("kanban.pipelineAria", { title, progress })}. ${t("kanban.stages.expandTitle")}`}
          title={pipeline.task || title}
          disabled={!props.onOpenStages}
          onClick={() => props.onOpenStages?.(pipeline)}
        >
          {showTitle ? <span className="pb-title" data-pipeline-title={pipeline.id}>{title}</span> : null}
          <span className="pb-meta">
            {word ? <span className="pstate-word" data-pstate={pipeline.state}>{word}</span> : null}
            {word && age ? <span className="pb-sep" aria-hidden="true">·</span> : null}
            {age ? <span className="pb-when">{age}</span> : null}
          </span>
          <ChevronRight />
        </button>
        {props.acting ? <span className="pb-acting" role="status" data-pipeline-acting={props.acting}>{t(`kanban.pipelineAct.pending.${props.acting}`)}</span> : null}
        <span className="pb-grow" />
        {props.onToggleGraph && props.onOpenStage ? (
          <button
            type="button"
            className="pb-icon pb-graph-toggle"
            aria-pressed={graphOpen}
            aria-label={graphOpen ? t("kanban.graph.showSummary") : t("kanban.graph.showGraph")}
            title={graphOpen ? t("kanban.graph.summary") : t("kanban.graph.graph")}
            data-graph-toggle={pipeline.id}
            onClick={() => props.onToggleGraph!(!graphOpen)}
          >
            {graphOpen ? <ListGlyph /> : <GraphGlyph />}
          </button>
        ) : null}
        {props.onMenu ? (
          <button
            type="button"
            className="pb-icon"
            aria-label={t("kanban.pipelineAct.menu")}
            aria-haspopup="menu"
            data-pipeline-menu={pipeline.id}
            onClick={(event) => props.onMenu!(pipeline, event.currentTarget)}
          >
            <MoreGlyph />
          </button>
        ) : null}
      </div>
      {graphOpen ? (
        <>
          <GraphSlot summary={summary} names={names} selected={selected} onOpenStage={props.onOpenStage!} />
          <WorkLinkRow resolved={links} showNoPr className="pb-links end" testId={pipeline.id} onMore={props.onWorkLinks ? (anchor) => props.onWorkLinks!({ kind: "pipeline", id: pipeline.id }, anchor) : undefined} />
        </>
      ) : (
        <div className="pb-chain">
          <ChainPills summary={summary} nameOf={nameOf} suffixes={suffixes} selected={selected} onOpenStage={props.onOpenStage} />
          <WorkLinkRow resolved={links} showNoPr className="pb-links" testId={pipeline.id} onMore={props.onWorkLinks ? (anchor) => props.onWorkLinks!({ kind: "pipeline", id: pipeline.id }, anchor) : undefined} />
        </div>
      )}
      {answers ? (
        <AnswerPanel pipeline={pipeline} answers={answers} names={names} nameOf={nameOf} acting={props.acting ?? null} large={false} onAnswer={props.onAnswer} />
      ) : needs ? (
        <div className="pb-answer">
          {pipeline.state === "needs_review"
            ? <p className="review-heads" data-review-heads={pipeline.id}>{pipelineReviewHeads(t, pipeline)}</p>
            : <DecisionReport pipeline={pipeline} stage={parkedStage(pipeline)} names={names} nameOf={nameOf} />}
        </div>
      ) : null}
      {report ? <div className="pb-note"><StageReportLine pipeline={pipeline} entry={report} names={names} /></div> : null}
      {pipeline.graphEdits?.length ? <GraphEditLine edit={pipeline.graphEdits.at(-1)!} /> : null}
    </div>
  );
}

/**
 * The pipeline screen's body (§3.13): the state line, the chips with Attach,
 * the numbered stages with the passed ones before the current one folded, the
 * current one expanded with the answer inside it, and each fail edge in words.
 */
function ScreenBlock(props: PipelineBlockProps & {
  names: ReadonlyMap<string, string>;
  nameOf: (stage: PipelineStage) => string;
  suffixes: ReadonlyMap<string, Suffix>;
  answers: PipelineAnswers | null;
  root: Record<string, string | undefined>;
}) {
  const { summary, nowMs, names, nameOf, suffixes, answers } = props;
  const { t } = useLocale();
  const { pipeline } = summary;
  const links = useWorkLinks().of({ kind: "pipeline", id: pipeline.id });
  const [passedOpen, setPassedOpen] = useState(false);
  const { k, n } = pipelineStagePosition(pipeline);
  const moved = pipelineMovedAtMs(pipeline);
  const age = moved === null ? null : humanizeDuration(blockAgeSeconds((nowMs - moved) / 1000));
  const chips = summary.chips;
  const current = pipelineEnded(pipeline) ? -1 : currentChipIndex(chips);
  const parked = parkedStage(pipeline);
  const currentId = parked?.id ?? (current >= 0 ? chips[current]?.stage.id ?? null : null);
  const currentIndex = currentId ? chips.findIndex((chip) => chip.stage.id === currentId) : -1;
  const before = currentIndex > 0 ? chips.slice(0, currentIndex).filter((chip) => !chip.branch) : [];
  const foldPassed = before.length > 1 && before.every((chip) => chip.state === "passed" || chip.state === "skipped");
  const folded = foldPassed && !passedOpen ? new Set(before.map((chip) => chip.stage.id)) : new Set<string>();
  const selected = props.selected ?? NO_STAGES;
  const row = (chip: KanbanStageChip, index: number) => {
    const isCurrent = chip.stage.id === currentId;
    const attempt = latestAttempt(pipeline, chip.stage.id);
    const openable = Boolean(props.onOpenStage) && (Boolean(attempt?.agentPath || attempt?.conversationId) || stageDraftable(pipeline, chip.stage.id));
    const suffix = suffixes.get(chip.stage.id) ?? null;
    const name = nameOf(chip.stage);
    const state = graphStateWord(t, chip.state);
    const identity = chip.stage.effectiveRole ? stageIdentity(pipeline, chip.stage) : null;
    const who = whoRuns(t, pipeline, chip.stage);
    const head = (
      <>
        <span className="pb-num">{index + 1}</span>
        <StageToneMark state={chip.state} />
        <span className="pb-name">{chip.branch ? t("kanban.branch", { stage: name }) : name}</span>
        {chip.rounds ? <CountCircle n={chip.rounds} tone="neutral" label={t("kanban.stageAriaRounds", { stage: name, state, count: chip.rounds })} /> : null}
        {drawn(suffix) ? <ReturnSuffix arc={suffix.arc} title={suffix.title} /> : null}
        <span className="pb-grow" />
        <span className={`pb-stage-state tone-${STAGE_TONE[chip.state]}`}>{state}</span>
      </>
    );
    const report = isCurrent ? (pipeline.stageReports ?? []).filter((entry) => entry.stageId === chip.stage.id).at(-1) ?? null : null;
    return (
      <li
        key={chip.stage.id}
        className={`pb-stage tone-${STAGE_TONE[chip.state]}${isCurrent ? " current" : ""}`}
        data-stage={chip.stage.id}
        data-stage-state={chip.state}
        data-stage-current={isCurrent ? "1" : undefined}
      >
        {openable ? (
          <button
            type="button"
            className={`pb-stage-row${selected.has(chip.stage.id) ? " selected" : ""}`}
            aria-label={[t("kanban.stageAria", { stage: name, state }), who, drawn(suffix) ? suffix.title : null].filter(Boolean).join(". ")}
            title={who ?? undefined}
            onClick={() => props.onOpenStage!(pipeline, chip.stage)}
          >
            {head}
            <ChevronRight />
          </button>
        ) : <div className="pb-stage-row" title={who ?? undefined}>{head}</div>}
        {identity ? <span className="pb-stage-ident"><StageIdentity identity={identity} density="line" /></span> : null}
        {isCurrent ? (
          <div className="pb-stage-body">
            {answers ? (
              <AnswerPanel pipeline={pipeline} answers={answers} names={names} nameOf={nameOf} acting={props.acting ?? null} large onAnswer={props.onAnswer} />
            ) : report ? <StageReportLine pipeline={pipeline} entry={report} names={names} /> : null}
          </div>
        ) : null}
      </li>
    );
  };
  const word = pipelineStateLabel(t, pipeline.state);
  return (
    <section className="pblock" aria-label={t("kanban.pipelineAria", { title: pipelineTitle(t, pipeline), progress: pipelineProgress(t, summary, nameOf) })} {...props.root}>
      <p className="pb-stateline">
        <span className="pstate-word" data-pstate={pipeline.state}>{word}</span>
        <span className="pb-sep" aria-hidden="true">·</span>
        <span>{t("pipelineStrip.stageOf", { k, n })}</span>
        {age ? <><span className="pb-sep" aria-hidden="true">·</span><span>{age}</span></> : null}
      </p>
      <div className="pb-links-row">
        <WorkLinkRow resolved={links} showNoPr className="pb-links" testId={pipeline.id} />
        {props.onWorkLinks ? (
          <button type="button" className="pb-attach" data-work-links-open={pipeline.id} onClick={(event) => props.onWorkLinks!({ kind: "pipeline", id: pipeline.id }, event.currentTarget)}>
            {t("workLinks.attach")}
          </button>
        ) : null}
      </div>
      <ol className="pb-stages" data-chain={pipeline.id}>
        {foldPassed ? (
          <li className="pb-stage passed-fold">
            <button type="button" className="pb-stage-row" aria-expanded={passedOpen} data-passed-fold={before.length} onClick={() => setPassedOpen((open) => !open)}>
              <span className="pb-num">{before.length > 1 ? `1–${before.length}` : "1"}</span>
              <StageToneMark state="passed" />
              <span className="pb-name">{[t("pipelineBlock.passedRow", { count: before.length }), ...before.map((chip) => nameOf(chip.stage))].join(" · ")}</span>
              <span className="pb-grow" />
              <ChevronRight />
            </button>
          </li>
        ) : null}
        {chips.map((chip, index) => (folded.has(chip.stage.id) ? null : row(chip, index)))}
      </ol>
      {summary.loops.length ? (
        <ul className="pb-loops">
          {summary.loops.map((loop) => (
            <li key={`${loop.from.id}:${loop.to.id}`}>{`↺ ${t("kanban.loopRest", { from: nameOf(loop.from), to: nameOf(loop.to), max: loop.max })}`}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
