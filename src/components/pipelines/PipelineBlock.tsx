"use client";

import { Link2, Settings } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useLocale, type TFunction } from "@/lib/i18n";
import type { Pipeline, PipelineStage, PipelineStageReportEntry, StageFinding } from "@/lib/pipelines/types";
import { humanizeDuration } from "@/components/turnDuration";
import { fmtAge } from "@/components/utils";
import { WorkLinkRow, WorkLinkText } from "@/components/workLinks/WorkLinkChips";
import { useWorkLinks, type WorkLinkTarget } from "@/components/workLinks/workLinksContext";
import { CountCircle, identityTitle, StageIdentity } from "@/components/kanban/identityMarks";
import type { KanbanPipeline, KanbanStageChip } from "@/components/kanban/kanbanModel";
import { ChevronDown, ChevronRight, MoreGlyph, svgProps } from "@/components/kanban/kanbanGlyphs";
import { STAGE_TONE } from "@/components/kanban/pipelineGraph";
import {
  arcTitle, GraphEditLine, GraphGlyph, graphStateWord, ListGlyph, loopArcs, PipelineGraph, pipelineProgress, pipelineTitle, ReturnSuffix, StageReportLine,
  type LoopArc,
} from "@/components/kanban/PipelineSection";
import { stageIdentity } from "@/components/kanban/stageIdentity";
import { stageDraftable, type PipelineActionKind } from "@/components/kanban/stagesModel";

import {
  latestAttempt, pipelineReviewHeads, pipelineStagePosition, pipelineStateLabel, stageChipLabel, stageConfigurable, stageLatestAttemptPlace, stageNames, stageRoleAside,
  type StageChipState,
} from "./pipelineModel";
import {
  blockAgeSeconds, cardChain, cardChainLevels, parkedStage, pipelineAnswers, pipelineEnded, pipelineMovedAtMs, pipelineNeedsYou, pipelineReason, sameTitle, screenCurrentStageId, STAGE_MARK, stageFindings,
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
 * - `screen`: the pipeline screen's body, the phone's Stages view (slice 6).
 *   The title, the chips with "Attach", a numbered stage list with the passed
 *   stages folded, the current stage expanded with the answer inside it, and
 *   the waiting stages compact with their ⚙. Here a stage's row also carries
 *   who runs it: engine mark, model, effort and role.
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

/** The first `shown` findings, each a severity chip beside its text, then
    how many more there are. */
function FindingList({ findings, shown }: { findings: readonly StageFinding[]; shown: number }) {
  const { t } = useLocale();
  if (!findings.length) return null;
  return (
    <ul className="stage-findings" data-stage-findings={findings.length}>
      {findings.slice(0, shown).map((finding, index) => (
        <li key={index} data-severity={finding.severity ?? "none"}>
          <span className="sev">{finding.severity ?? t("kanban.stageReport.unranked")}</span>
          <span className="text">{finding.text}</span>
        </li>
      ))}
      {findings.length > shown ? <li className="more">{t("kanban.stageReport.moreFindings", { count: findings.length - shown })}</li> : null}
    </ul>
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
  return (
    <>
      {reason ? <p className="stage-report">{reason}</p> : null}
      <FindingList findings={stage ? stageFindings(pipeline, stage.id) : []} shown={ANSWER_FINDINGS} />
    </>
  );
}

/** What the lane stopped on: the review heads of a spent review budget, or
    the parked stage's report. */
function AnswerReport({ pipeline, answers, names, nameOf }: {
  pipeline: Pipeline;
  answers: PipelineAnswers;
  names: ReadonlyMap<string, string>;
  nameOf: (stage: PipelineStage) => string;
}) {
  const { t } = useLocale();
  return answers.kind === "review"
    ? <p className="review-heads" data-review-heads={pipeline.id}>{pipelineReviewHeads(t, pipeline)}</p>
    : <DecisionReport pipeline={pipeline} stage={answers.stage} names={names} nameOf={nameOf} />;
}

/** The two ways on, the quiet one first. */
function AnswerButtons({ pipeline, answers, acting, large, onAnswer }: {
  pipeline: Pipeline;
  answers: PipelineAnswers;
  acting: PipelineActionKind | null;
  /** The pipeline screen's 44 px buttons, in the phone's shorter words. */
  large: boolean;
  onAnswer: (pipeline: Pipeline, answer: PipelineAnswer) => void;
}) {
  const { t } = useLocale();
  const label = (answer: PipelineAnswer): string => {
    if (answer.action === "continue-review") return t("pipelineBlock.oneMoreRound");
    if (large) return t(answer.action === "skip-stage" ? "mobile2.pipeline.skip" : answer.action === "retry-stage" ? "mobile2.pipeline.retry" : "mobile2.pipeline.archive");
    return t(`kanban.pipelineAct.label.${answer.action}`, { stage: answer.stageName ?? "" });
  };
  return (
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
  );
}

/** The answer in place: what the lane stopped on, and the two ways on. */
function AnswerPanel({ pipeline, answers, names, nameOf, acting, large, onAnswer }: {
  pipeline: Pipeline;
  answers: PipelineAnswers;
  names: ReadonlyMap<string, string>;
  nameOf: (stage: PipelineStage) => string;
  acting: PipelineActionKind | null;
  large: boolean;
  onAnswer?: (pipeline: Pipeline, answer: PipelineAnswer) => void;
}) {
  return (
    <div className="pb-answer" data-answer={answers.kind}>
      <AnswerReport pipeline={pipeline} answers={answers} names={names} nameOf={nameOf} />
      {onAnswer ? <AnswerButtons pipeline={pipeline} answers={answers} acting={acting} large={large} onAnswer={onAnswer} /> : null}
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
  /** Task density: the answer as the phone's 44 px buttons in its shorter
      words ("Retry stage"), the phone task screen's (§3.13). The stage is
      named once, in the report line right above them. */
  largeAnswers?: boolean;
  /** Screen density: a waiting stage's ⚙, which opens its configuration. */
  onConfigureStage?: (pipeline: Pipeline, stage: PipelineStage) => void;
  /** Screen density: what the host knows about a stage's conversation, which
      is whether it can open it and the agent's latest line. Absent, the
      attempt's own ids decide and no line is drawn. */
  stageConversation?: (stage: PipelineStage) => StageConversation;
  /** Screen density: the heading, which the screen's bar watches to take the
      title once it scrolls away. */
  headingRef?: React.Ref<HTMLHeadingElement>;
  /** Screen density inside another screen (the phone task screen, #2148): no
      heading, since the screen above names the task, and no Attach, which is
      on the pipeline screen one tap away. The "Stages" line is that tap, with
      the lane's age and its ⋯ at the end. */
  embedded?: boolean;
  /** Card density: what the card adds about its other pipelines ("+1
      paused"), at the right end of the block's last line. */
  aside?: React.ReactNode;
}

export interface StageConversation {
  openable: boolean;
  latest: string | null;
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
  const opener = (
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
  );
  const acting = props.acting ? <span className="pb-acting" role="status" data-pipeline-acting={props.acting}>{t(`kanban.pipelineAct.pending.${props.acting}`)}</span> : null;
  const controls = (
    <>
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
    </>
  );
  /* One head (#2148). When the lane carries the task's own title and
     its actions live in the card's ⋯ (no `onMenu` of its own), the stage
     chain IS the head: the age and the way into the stages trail it on the
     same row, and nothing above it repeats the card. A lane with a title or a
     menu of its own keeps its head row; at 390 px the chain, the age and a
     44 px ⋯ do not fit one line. */
  const chainHead = !showTitle && !graphOpen && !props.onMenu;
  return (
    <div className="pblock" role="group" aria-label={t("kanban.pipelineAria", { title, progress })} {...root}>
      {chainHead ? null : (
        <div className="pb-head">
          {opener}
          {acting}
          <span className="pb-grow" />
          {controls}
        </div>
      )}
      {graphOpen ? (
        <>
          <GraphSlot summary={summary} names={names} selected={selected} onOpenStage={props.onOpenStage!} />
          <WorkLinkRow resolved={links} showNoPr className="pb-links end" testId={pipeline.id} onMore={props.onWorkLinks ? (anchor) => props.onWorkLinks!({ kind: "pipeline", id: pipeline.id }, anchor) : undefined} />
        </>
      ) : (
        <div className="pb-chain">
          <ChainPills summary={summary} nameOf={nameOf} suffixes={suffixes} selected={selected} onOpenStage={props.onOpenStage} />
          <WorkLinkRow resolved={links} showNoPr className="pb-links" testId={pipeline.id} onMore={props.onWorkLinks ? (anchor) => props.onWorkLinks!({ kind: "pipeline", id: pipeline.id }, anchor) : undefined} />
          {chainHead ? <span className="pb-tail">{acting}{controls}{opener}</span> : null}
        </div>
      )}
      {answers ? (
        <AnswerPanel pipeline={pipeline} answers={answers} names={names} nameOf={nameOf} acting={props.acting ?? null} large={Boolean(props.largeAnswers)} onAnswer={props.onAnswer} />
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

/** Where the lane stands, as the pipeline screen's bar says it (§3.13): the
    state word in its tone, the stage it is on — the number its row carries in
    the list below — and how long since it moved. A finished lane has no stage
    to stand on and says its age alone. */
export function PipelineStateLine({ summary, nowMs }: { summary: KanbanPipeline; nowMs: number }) {
  const { t } = useLocale();
  const { pipeline } = summary;
  const current = screenCurrentStageId(summary);
  const index = current ? summary.chips.findIndex((chip) => chip.stage.id === current) : -1;
  const { k, n } = index >= 0 ? { k: index + 1, n: summary.chips.length } : pipelineStagePosition(pipeline);
  const moved = pipelineMovedAtMs(pipeline);
  const position = t("kanban.stages.position", { k, n });
  const parts = [
    pipelineEnded(pipeline) ? null : position.charAt(0).toLocaleLowerCase() + position.slice(1),
    moved === null ? null : humanizeDuration(blockAgeSeconds((nowMs - moved) / 1000)),
  ].filter((part): part is string => Boolean(part));
  return (
    <span className="pb-stateline" data-pipeline-stateline={pipeline.id}>
      <span className="pstate-word" data-pstate={pipeline.state}>{pipelineStateLabel(t, pipeline.state)}</span>
      {parts.map((part, index) => (
        <span key={index} className="pb-statepart">
          <span className="pb-sep" aria-hidden="true">·</span>
          {part}
        </span>
      ))}
    </span>
  );
}

const ATTEMPT_LIVE: ReadonlySet<string> = new Set(["running", "reviewing", "committing"]);

/**
 * The pipeline screen's body (§3.13), the phone's Stages view: the title as
 * the heading, the chips with Attach, then the numbered stages. The passed
 * stages before the current one fold into one row that opens in place; the
 * current stage is expanded with its report, the agent's latest line, the fail
 * edges that touch it, the answer when the lane waits on it, and "Open
 * conversation"; a waiting stage is one compact row with its ⚙. Each fail edge
 * is spelled in the desktop's loop words under the list.
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
  const chips = summary.chips;
  const ended = pipelineEnded(pipeline);
  const needs = pipelineNeedsYou(pipeline);
  const parked = parkedStage(pipeline);
  const currentId = screenCurrentStageId(summary);
  const currentIndex = currentId ? chips.findIndex((chip) => chip.stage.id === currentId) : -1;
  const before = currentIndex > 0 ? chips.slice(0, currentIndex).filter((chip) => !chip.branch) : [];
  const foldPassed = before.length > 1 && before.every((chip) => chip.state === "passed" || chip.state === "skipped");
  const folded = foldPassed && !passedOpen ? new Set(before.map((chip) => chip.stage.id)) : new Set<string>();
  const selected = props.selected ?? NO_STAGES;
  const arcs = loopArcs(summary);
  const ago = (ms: number) => t("mobile2.pipeline.started", { age: humanizeDuration(blockAgeSeconds((nowMs - ms) / 1000)) });
  const conversationOf = (stage: PipelineStage): StageConversation => {
    if (props.stageConversation) return props.stageConversation(stage);
    const attempt = latestAttempt(pipeline, stage.id);
    return { openable: Boolean(attempt?.agentPath || attempt?.conversationId) || stageDraftable(pipeline, stage.id), latest: null };
  };

  /* The fail edges this stage stands in, in the loop words: the work it runs
     because another stage failed, and what its own failures spent. */
  const arcLines = (stage: PipelineStage) => arcs.flatMap((arc) => {
    const from = nameOf(arc.loop.from);
    const to = nameOf(arc.loop.to);
    if (arc.live && arc.loop.to.id === stage.id) return [{ id: arc.id, text: t("kanban.loopLive", { from, to }) }];
    if (arc.loop.from.id !== stage.id || arc.state === "rest") return [];
    if (arc.parked) return [{ id: arc.id, text: t("kanban.loopParkedHere", { from }) }];
    return [{
      id: arc.id,
      text: [t("kanban.loopNames", { from, to }), t("kanban.loopUsed", { fired: arc.loop.fired, max: arc.loop.max }), arc.state === "exhausted" ? t("kanban.graph.noneLeft") : null].filter(Boolean).join(" · "),
    }];
  });

  /* A paused lane holds its stage (§3.13): the stage draws no live tone and no
     pulse, its mark is hollow and it says the lane's word, "paused". It keeps
     its place, its expansion and its conversation; Resume is the bar's ⋯. */
  const held = (chip: KanbanStageChip): boolean => pipeline.state === "paused" && LIVE.has(chip.state);

  /* What the current stage last did: its own report for its latest attempt,
     else the attempt as it stands, "Builder running · 6m". */
  const stageNow = (chip: KanbanStageChip) => {
    const attempt = latestAttempt(pipeline, chip.stage.id);
    const report = (pipeline.stageReports ?? []).filter((entry) => entry.stageId === chip.stage.id).at(-1) ?? null;
    if (report && (!attempt || report.attempt === attempt.n)) return <StageReportLine pipeline={pipeline} entry={report} names={names} shown={ANSWER_FINDINGS} />;
    if (!attempt) return null;
    const live = ATTEMPT_LIVE.has(attempt.state);
    const at = Date.parse((live ? attempt.startedAt : attempt.completedAt ?? attempt.startedAt) ?? "");
    const age = Number.isFinite(at) ? (live ? humanizeDuration(blockAgeSeconds((nowMs - at) / 1000)) : ago(at)) : "";
    return (
      <>
        <p className="stage-report" data-stage-now={chip.stage.id}>
          {t("kanban.stageReport.line", { who: stageChipLabel(t, chip.stage), outcome: held(chip) ? pipelineStateLabel(t, pipeline.state) : graphStateWord(t, chip.state), age })}
        </p>
        <FindingList findings={stageFindings(pipeline, chip.stage.id)} shown={ANSWER_FINDINGS} />
      </>
    );
  };

  const row = (chip: KanbanStageChip, index: number) => {
    const { stage } = chip;
    const isCurrent = stage.id === currentId;
    const conversation = conversationOf(stage);
    const openable = Boolean(props.onOpenStage) && conversation.openable;
    const configurable = !conversation.openable && Boolean(props.onConfigureStage) && stageConfigurable(pipeline, stage.id);
    const suffix = suffixes.get(stage.id) ?? null;
    const name = nameOf(stage);
    /* The stage a lane that needs the operator stands on takes the lane's
       amber and its state word; its mark keeps the stage's own shape. */
    const waitsOnYou = needs && stage.id === parked?.id;
    const isHeld = held(chip);
    const shown: StageChipState = isHeld ? "pending" : chip.state;
    const tone = waitsOnYou ? "needs" : STAGE_TONE[shown];
    const state = waitsOnYou || isHeld ? pipelineStateLabel(t, pipeline.state) : graphStateWord(t, shown);
    const identity = stage.effectiveRole ? stageIdentity(pipeline, stage) : null;
    const who = whoRuns(t, pipeline, stage);
    const place = stageLatestAttemptPlace(pipeline, stage.id);
    const words = [
      stageRoleAside(t, stage),
      stage.kind === "review-loop" ? t("mobile2.pipeline.review") : null,
      place.attempt !== null && (place.attempts > 1 || isCurrent) ? t("pipelineBlock.attempt", { n: place.attempt }) : null,
    ].filter(Boolean).join(" · ");
    const aria = [t("kanban.stageAria", { stage: name, state }), who, suffix?.title].filter(Boolean).join(". ");
    const head = (
      <>
        <span className="pb-num">{index + 1}</span>
        <span className="pb-stage-main">
          <span className="pb-stage-title">
            <StageToneMark state={shown} />
            <span className="pb-name">{chip.branch ? t("kanban.branch", { stage: name }) : name}</span>
            {chip.rounds ? <CountCircle n={chip.rounds} tone="neutral" label={t("kanban.stageAriaRounds", { stage: name, state, count: chip.rounds })} /> : null}
            {suffix ? <ReturnSuffix arc={suffix.arc} title={suffix.title} /> : null}
          </span>
          {identity || words ? (
            <span className="pb-stage-ident">
              {identity ? <StageIdentity identity={identity} density="line" /> : null}
              {words ? <span className="pb-ident-words">{identity ? `· ${words}` : words}</span> : null}
            </span>
          ) : null}
        </span>
        <span className={`pb-stage-state tone-${tone}`}>{state}</span>
      </>
    );
    /* A stage that has run opens its conversation from its row, the current
       one from the "Open conversation" row under its report; a stage still
       open to configuration opens its settings. */
    const control = configurable ? (
      <button type="button" className="pb-stage-row" data-stage-configure={stage.id} aria-haspopup="dialog" aria-label={`${t("mobile2.pipeline.configure", { stage: name })}. ${aria}`} title={who ?? undefined} onClick={() => props.onConfigureStage!(pipeline, stage)}>
        {head}
        <Settings className="pb-gear" aria-hidden />
      </button>
    ) : openable && !isCurrent ? (
      <button type="button" className={`pb-stage-row${selected.has(stage.id) ? " selected" : ""}`} data-stage-open={stage.id} aria-label={`${t("mobile2.pipeline.openStage", { stage: name })}. ${aria}`} title={who ?? undefined} onClick={() => props.onOpenStage!(pipeline, stage)}>
        {head}
        <ChevronRight />
      </button>
    ) : <div className="pb-stage-row" title={who ?? undefined}>{head}</div>;
    const edges = isCurrent ? arcLines(stage) : [];
    const latest = isCurrent && ATTEMPT_LIVE.has(chip.state) ? conversation.latest : null;
    return (
      <li
        key={stage.id}
        className={`pb-stage tone-${tone}${isCurrent ? " current" : ""}`}
        data-stage={stage.id}
        data-stage-state={chip.state}
        data-stage-held={isHeld ? "1" : undefined}
        data-stage-current={isCurrent ? "1" : undefined}
      >
        {control}
        {isCurrent ? (
          <div className="pb-stage-body">
            {answers ? (
              <div className="pb-answer" data-answer={answers.kind}>
                <AnswerReport pipeline={pipeline} answers={answers} names={names} nameOf={nameOf} />
                {edges.map((edge) => <p key={edge.id} className="pb-edge" data-stage-edge={edge.id}>{`↺ ${edge.text}`}</p>)}
                {answers.kind === "review" && answers.stage ? <FindingList findings={stageFindings(pipeline, answers.stage.id)} shown={ANSWER_FINDINGS} /> : null}
                {props.onAnswer ? <AnswerButtons pipeline={pipeline} answers={answers} acting={props.acting ?? null} large onAnswer={props.onAnswer} /> : null}
              </div>
            ) : (
              <>
                {stageNow(chip)}
                {latest ? <p className="pb-latest" data-stage-latest={stage.id}>{t("pipelineBlock.latest", { text: latest })}</p> : null}
                {edges.map((edge) => <p key={edge.id} className="pb-edge" data-stage-edge={edge.id}>{`↺ ${edge.text}`}</p>)}
              </>
            )}
            {openable ? (
              <button type="button" className="pb-open-conv" data-open-conversation={stage.id} aria-label={t("mobile2.pipeline.openStage", { stage: name })} onClick={() => props.onOpenStage!(pipeline, stage)}>
                <span>{t("pipelineBlock.openConversation")}</span>
                <ChevronRight />
              </button>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };
  /* A finished lane has no current stage: what closed it is the last report. */
  const lastReport = ended ? (pipeline.stageReports ?? []).at(-1) ?? null : null;
  const moved = pipelineMovedAtMs(pipeline);
  /* The links say what the lane produced, under its title; attaching one by
     hand is rare, so it is a row of its own after the stages (#2148). */
  const hasLinks = Boolean(links?.links.length || links?.noPr);
  return (
    <section className="pblock" aria-label={t("kanban.pipelineAria", { title: pipelineTitle(t, pipeline), progress: pipelineProgress(t, summary, nameOf) })} {...props.root}>
      {props.embedded ? null : <h2 className="pb-heading" ref={props.headingRef} data-pipeline-heading={pipeline.id}>{pipelineTitle(t, pipeline)}</h2>}
      {hasLinks ? (
        <div className="pb-links-row">
          <WorkLinkRow resolved={links} showNoPr className="pb-links" testId={pipeline.id} />
        </div>
      ) : null}
      {lastReport ? <div className="pb-note"><StageReportLine pipeline={pipeline} entry={lastReport} names={names} shown={ANSWER_FINDINGS} /></div> : null}
      {props.embedded ? (
        <div className="pb-section-row">
          <button type="button" className="pb-section pb-section-open" data-open-stages={pipeline.id} data-stages-count={pipeline.stages.length} disabled={!props.onOpenStages} onClick={() => props.onOpenStages?.(pipeline)}>
            {t("mobile2.pipeline.stages")}
            <span className="pb-count">{pipeline.stages.length}</span>
            {moved === null ? null : <span className="pb-count">· {humanizeDuration(blockAgeSeconds((nowMs - moved) / 1000))}</span>}
            <ChevronRight />
          </button>
          {props.onMenu ? (
            <button type="button" className="pb-icon" aria-label={t("kanban.pipelineAct.menu")} aria-haspopup="menu" data-pipeline-menu={pipeline.id} onClick={(event) => props.onMenu!(pipeline, event.currentTarget)}>
              <MoreGlyph />
            </button>
          ) : null}
        </div>
      ) : (
        <p className="pb-section" data-stages-count={pipeline.stages.length}>
          {t("mobile2.pipeline.stages")}
          <span className="pb-count">{pipeline.stages.length}</span>
        </p>
      )}
      <ol className="pb-stages" data-chain={pipeline.id}>
        {foldPassed ? (
          <li className="pb-stage passed-fold tone-ok">
            <button
              type="button"
              className="pb-stage-row"
              aria-expanded={passedOpen}
              data-passed-fold={before.length}
              aria-label={[t("pipelineBlock.passedRow", { count: before.length }), ...before.map((chip) => nameOf(chip.stage))].join(" · ")}
              onClick={() => setPassedOpen((open) => !open)}
            >
              <span className="pb-num">{`1–${before.length}`}</span>
              <span className="pb-stage-main">
                <span className="pb-stage-title">
                  <StageToneMark state="passed" />
                  <span className="pb-name">{t("pipelineBlock.passedRow", { count: before.length })}</span>
                </span>
                <span className="pb-stage-ident"><span className="pb-ident-words">{before.map((chip) => nameOf(chip.stage)).join(" · ")}</span></span>
              </span>
              <ChevronDown />
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
      {props.onWorkLinks && !props.embedded ? (
        <button type="button" className="pb-attach" data-work-links-open={pipeline.id} onClick={(event) => props.onWorkLinks!({ kind: "pipeline", id: pipeline.id }, event.currentTarget)}>
          <Link2 className="pb-attach-icon" aria-hidden />
          <span className="pb-attach-label">{t("workLinks.attach")}</span>
          <ChevronRight />
        </button>
      ) : null}
    </section>
  );
}
