"use client";

import { AgentMemoryCapNote } from "@/components/AgentMemoryCapNote";
import { StageSetupResult } from "@/components/pipelines/StageSetupResult";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { openReviewHistory } from "@/components/flows/ReviewHistory";
import type { ReviewGroup as Flow } from "@/components/flows/reviewGroup";
import { browserZone, clockText } from "@/components/activity/format";
import { AnswerReport } from "@/components/pipelines/PipelineBlock";
import { parkedStage, pipelineAnswers } from "@/components/pipelines/pipelineBlockModel";
import { useLocale } from "@/lib/i18n";
import type { PipelineAttemptState, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { roleNameById } from "@/components/builderCopy";
import { stageAgentRowModel, stageCloudTaskUrl, type StageChipState } from "@/components/pipelines/pipelineModel";

import type { KanbanPipeline } from "./kanbanModel";
import { ChevronRight, CloseGlyph, MoreGlyph, svgProps } from "./kanbanGlyphs";
import { cssEscape } from "./kanbanFocus";
import { arcTitle, GraphGlyph, graphStateWord, loopArcs, PipelineGraph, ROLE_GLYPH, RoundDots, stageNames, stageRoleId, useCoarsePointer, type LoopArc } from "./PipelineSection";
import { attemptPlace, stageIdentity, valuesOf } from "./stageIdentity";
import { modelGlyphKind } from "./modelGlyph";
import { StageGlyph } from "./StageGlyph";
import { engineWord, identityTitle, StageIdentity, StagePlaceLine } from "./identityMarks";
import { layoutGraph, roundsOf, STAGE_TONE } from "./pipelineGraph";
import { laneWaitsOn, recheckAttempts, stageTabs, tabNote, type StageRule, type StageTab, type StageTabModel, type TabNote, type WaitsOn } from "./stageTabs";
import type { PipelinePorts } from "./pipelinePorts";
import { StageAccountChip } from "./AccountPicker";
import { ReaderSlot, type ReaderPlacement } from "./KanbanReaders";
import { DraftLeftover, StageDraftFeed, useStageDraft } from "./StageDraft";
import { AddStageControl, ConfigureToggle, conversationDraftLane, DraftStageConfigure } from "@/components/pipelines/DraftStageControls";
import { stageDraftKey, type StageDrafts } from "./stageDrafts";
import { draftOutcome, neverLaunched, paneFacts, pipelineEnded } from "./stagesModel";

/*
 * The Stages window (#1695 K5b, redesign S2 variant 3): the stages of one
 * pipeline as tabs over one stage. A line says whom the lane waits on, the tab
 * strip is the lane in the order the engine runs it (`stageTabs`), a stage that
 * only runs when another fails is a subordinate tab under its source, and one
 * pane under the tabs holds the selected stage's conversation as the board's
 * own reader: the same mounted conversation a card shows, moved here while the
 * stage is selected. A stage that has not started holds its first message,
 * editable until it starts. The graph is one press away.
 */

const MinusGlyph = () => <svg {...svgProps}><path d="M5 12h14" /></svg>;
const PlusGlyph = () => <svg {...svgProps}><path d="M12 5v14M5 12h14" /></svg>;
const FitGlyph = () => <svg {...svgProps}><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" /></svg>;

/** One pane as the board computed it: which attempt it shows and where that conversation lives. */
export interface SheetPane {
  stage: PipelineStage;
  /** The stage's own attempts, oldest first. */
  attempts: PipelineStageAttempt[];
  shown: PipelineStageAttempt | null;
  /** The shown attempt's conversation on this board. */
  file: FileEntry | null;
  /** Set for the selected stage only: one conversation is mounted at a time. */
  readerKey: string | null;
}

export type SheetZoom = "fit" | number;

const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.4;

/** An attempt's state as a stage chip draws it: a host still starting reads as running. */
const chipState = (state: PipelineAttemptState): StageChipState => (state === "spawning" ? "running" : state);

/** The text mark a narrow tab wears in place of the model glyph. */
const NARROW_MARK: Record<StageChipState, string> = {
  pending: "○",
  skipped: "↷",
  running: "●",
  committing: "●",
  reviewing: "●",
  passed: "✓",
  failed: "✕",
  needs_decision: "!",
};

/** The lane's tab model and what it waits on, computed once for the line, the tabs and the phone's bar. */
export function useLaneTabs(summary: KanbanPipeline, nowMs: number): { model: StageTabModel; waits: WaitsOn } {
  const { t, locale } = useLocale();
  const { pipeline } = summary;
  const names = useMemo(() => stageNames(t, pipeline), [t, pipeline]);
  const model = useMemo(() => stageTabs(summary), [summary]);
  const waits = useMemo(
    () => laneWaitsOn(t, summary, model, nowMs, { nameOf: (stage) => names.get(stage.id) ?? stage.id, clock: (ms) => clockText(ms, locale, browserZone()) }),
    [t, locale, summary, model, nowMs, names],
  );
  return { model, waits };
}

/** The head's one line: a dot in the owner's tone and whom the lane waits on. It opens a one-line explanation. */
export const WaitsOnButton = ({ waits, open, onToggle, buttonRef }: { waits: WaitsOn; open: boolean; onToggle: () => void; buttonRef?: React.Ref<HTMLButtonElement> }) => {
  const { t } = useLocale();
  return (
    <button
      ref={buttonRef}
      type="button"
      className="gs-waits"
      data-waits-on={waits.owner}
      aria-expanded={open}
      aria-label={t("kanban.stages.waits.aria", { words: waits.words })}
      onClick={onToggle}
    >
      <span className="card-state-dot" data-owner={waits.owner} aria-hidden="true" />
      <span className="gs-waits-words">{waits.words}</span>
    </button>
  );
};

export const WaitsOnPopover = ({ waits }: { waits: WaitsOn }) => (
  <div className="gs-waits-pop" role="status" data-waits-pop={waits.owner}>{waits.detail}</div>
);

export function StagesSheet(props: {
  title: string;
  summary: KanbanPipeline;
  panes: readonly SheetPane[];
  flowsById: ReadonlyMap<string, Flow>;
  /** The stage whose tab is selected. */
  selected: string | null;
  onSelect: (stageId: string) => void;
  /** Epoch ms, for the waits-on line's ages. */
  nowMs: number;
  /** `sheet`: the desktop's dialog over the board. `screen`: the phone's body, whose bar holds the title, the close and the waits-on line. */
  presentation?: "sheet" | "screen";
  /** Opened from a lane's «Graph»: the graph is shown. */
  initialGraph?: boolean;
  /** Where «Add stage» of a conversation's draft draws: the board's, or the phone's. */
  addStageVariant?: "board" | "phone";
  /** The phone's draft screen words the first message as coming from the conversation. */
  fromConversation?: boolean;
  /** The pane conversation the agent window shows, which stands there and not in its pane. */
  windowReader: string | null;
  /** The stage whose first message the agent window shows, which is edited there and not in its pane. */
  windowDraft?: string | null;
  placement: ReaderPlacement;
  drafts: StageDrafts;
  ports: PipelinePorts;
  onChooseAttempt: (stageId: string, n: number) => void;
  onStageMenu: (stage: PipelineStage, anchor: HTMLElement) => void;
  onOpenRecorded: (conversation: { path: string | null; conversationId: string | null }) => void;
  /** Close the agent window, which puts its conversation back in its pane. */
  onLeaveWindow: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const { summary, panes } = props;
  const screen = props.presentation === "screen";
  const { pipeline } = summary;
  const names = useMemo(() => stageNames(t, pipeline), [t, pipeline]);
  const { model, waits } = useLaneTabs(summary, props.nowMs);
  const arcs = useMemo(() => new Map(loopArcs(summary).map((arc) => [arc.id, arc] as const)), [summary]);
  const [graph, setGraph] = useState(() => props.initialGraph === true);
  const [zoom, setZoom] = useState<SheetZoom>("fit");
  const [waitsOpen, setWaitsOpen] = useState(false);
  const sheet = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const waitsButton = useRef<HTMLButtonElement>(null);
  const tablist = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState<number | null>(null);
  const selectedId = model.tabs.some((tab) => tab.stage.id === props.selected) ? props.selected : model.tabs[0]?.stage.id ?? null;

  /* The graph fits the width the sheet has: left to right from 640 px. */
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element || !graph) return;
    const measure = () => setCanvasWidth(Math.floor(element.clientWidth));
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [graph]);

  /* Focus lands on the selected stage's pane; closing hands it back to the board. */
  useLayoutEffect(() => {
    if (screen) return;
    const target = sheet.current?.querySelector<HTMLElement>(`.pane[data-stage="${cssEscape(selectedId ?? "")}"]`) ?? sheet.current?.querySelector<HTMLElement>("[data-sheet-close]");
    target?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);

  const step = (delta: number, edge?: "first" | "last") => {
    const at = Math.max(0, model.tabs.findIndex((tab) => tab.stage.id === selectedId));
    const index = edge === "first" ? 0 : edge === "last" ? model.tabs.length - 1 : Math.max(0, Math.min(model.tabs.length - 1, at + delta));
    const next = model.tabs[index];
    if (!next) return;
    props.onSelect(next.stage.id);
    tablist.current?.querySelector<HTMLElement>(`[data-tab-stage="${cssEscape(next.stage.id)}"]`)?.focus({ preventScroll: true });
  };

  const available = canvasWidth === null ? null : Math.max(0, canvasWidth - 24);
  const dir = canvasWidth !== null && canvasWidth >= 640 ? "LR" : "TB";
  const coarse = useCoarsePointer();
  const layout = available === null ? null : layoutGraph(pipeline, available, dir, { coarse });
  const scale = layout ? (zoom === "fit" ? Math.max(0.9, Math.min(1, available! / Math.max(1, layout.width))) : zoom) : 1;
  const changeZoom = (kind: "-" | "+" | "fit") => setZoom((current) => {
    if (kind === "fit") return "fit";
    const base = current === "fit" ? 1 : current;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number((base + (kind === "+" ? 0.1 : -0.1)).toFixed(2))));
  });

  const stepButtons = model.showStrip ? (
    <div className="lane-bar">
      <button type="button" className="icon-btn" aria-label={t("kanban.stages.previous")} data-lane-prev="" onClick={() => step(-1)}><ChevronRight flip /></button>
      <button type="button" className="icon-btn" aria-label={t("kanban.stages.next")} data-lane-next="" onClick={() => step(1)}><ChevronRight /></button>
    </div>
  ) : null;
  const graphControls = (
    <>
      <button type="button" className="btn quiet gtoggle" aria-pressed={graph} data-sheet-graph="" onClick={() => setGraph((current) => !current)}>
        <GraphGlyph />
        <span>{t("kanban.graph.graph")}</span>
      </button>
      {graph ? (
        <div className="zoom" role="group" aria-label={t("kanban.stages.zoom")}>
          <button type="button" className="icon-btn" data-zoom="-" aria-label={t("kanban.stages.zoomOut")} onClick={() => changeZoom("-")}><MinusGlyph /></button>
          <button type="button" className="icon-btn" data-zoom="fit" aria-label={t("kanban.stages.zoomFit")} onClick={() => changeZoom("fit")}><FitGlyph /></button>
          <button type="button" className="icon-btn" data-zoom="+" aria-label={t("kanban.stages.zoomIn")} onClick={() => changeZoom("+")}><PlusGlyph /></button>
        </div>
      ) : null}
    </>
  );

  const body = (
    <>
      {model.showStrip ? (
        <div
          ref={tablist}
          className="gs-tabs"
          role="tablist"
          aria-label={t("kanban.stages.navAria")}
          data-stage-tabs={model.tabs.length}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") step(1);
            else if (event.key === "ArrowLeft" || event.key === "ArrowUp") step(-1);
            else if (event.key === "Home") step(0, "first");
            else if (event.key === "End") step(0, "last");
            else return;
            event.preventDefault();
          }}
        >
          {model.units.map((unit) => (
            <div key={unit[0]!.stage.id} className="gs-unit" data-unit={unit[0]!.unit}>
              {unit.map((tab) => (
                <StageTabButton
                  key={tab.stage.id}
                  tab={tab}
                  tabs={model}
                  summary={summary}
                  names={names}
                  arcs={arcs}
                  selected={tab.stage.id === selectedId}
                  onSelect={() => props.onSelect(tab.stage.id)}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {/* A draft made from a conversation takes one more stage after its last. */}
      {conversationDraftLane(pipeline) ? <AddStageControl pipeline={pipeline} ports={props.ports} variant={props.addStageVariant ?? "board"} /> : null}
      {model.rules.some((rule) => !rule.carried) ? (
        <ul className="gs-rules" aria-label={t("kanban.stages.rules")}>
          {model.rules.filter((rule) => !rule.carried).map((rule) => (
            <li key={rule.id} className="gs-rule" data-rule={rule.id} data-rule-shape={rule.shape} data-rule-back={rule.back ? "1" : undefined} data-arc-state={arcs.get(rule.id)?.state ?? "rest"}>
              <span aria-hidden="true">↺ </span>{ruleText(t, rule, arcs.get(rule.id), names)}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="gs-body">
        {graph ? (
          <div className="gs-graph" ref={canvas} data-sheet-graph-canvas={dir}>
            {layout ? (
              <div className="gs-scale" style={{ width: `${Math.ceil(layout.width * scale)}px`, height: `${Math.ceil(layout.height * scale)}px` }} data-zoom-scale={scale}>
                <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0" }}>
                  <PipelineGraph
                    summary={summary}
                    names={names}
                    available={available!}
                    force={dir}
                    selected={new Set(selectedId ? [selectedId] : [])}
                    inView={new Set(selectedId ? [selectedId] : [])}
                    scale={scale}
                    navigate
                    onOpenStage={(_pipeline, stage) => props.onSelect(stage.id)}
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="lane" role={model.showStrip ? "tabpanel" : "region"} id={panelId(pipeline.id)} aria-labelledby={model.showStrip ? tabId(pipeline.id, selectedId ?? "") : undefined} aria-label={model.showStrip ? undefined : t("kanban.stages.laneAria")}>
          {model.tabs.map((tab, index) => {
            if (tab.stage.id !== selectedId) return null;
            const pane = panes.find((entry) => entry.stage.id === tab.stage.id);
            if (!pane) return null;
            return (
              <StagePane
                key={tab.stage.id}
                {...props}
                pane={pane}
                tab={tab}
                note={tabNote(tab, summary)}
                ruleLine={model.rules.some((rule) => rule.from === tab.stage.id && !rule.carried)}
                index={index}
                total={model.tabs.length}
                names={names}
              />
            );
          })}
        </div>
      </div>
    </>
  );

  if (screen) {
    return (
      <section ref={sheet} className="gsheet screen" data-stages-sheet={pipeline.id} data-presentation="screen">
        <WaitsOnButton waits={waits} open={waitsOpen} onToggle={() => setWaitsOpen((open) => !open)} buttonRef={waitsButton} />
        {waitsOpen ? <WaitsOnPopover waits={waits} /> : null}
        <div className="gs-tools">
          {stepButtons}
          <span className="grow" />
          {graphControls}
        </div>
        {body}
      </section>
    );
  }

  return (
    <div
      className="gsheet-scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        ref={sheet}
        className="gsheet"
        role="dialog"
        aria-label={t("kanban.stages.sheetAria", { title: props.title })}
        data-stages-sheet={pipeline.id}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          const target = event.target as HTMLElement;
          if (target.closest("input, textarea, [contenteditable='true']")) return;
          event.preventDefault();
          event.stopPropagation();
          if (waitsOpen) {
            setWaitsOpen(false);
            waitsButton.current?.focus({ preventScroll: true });
            return;
          }
          props.onClose();
        }}
      >
        <header>
          <span className="kind">{t("kanban.pipeline")}</span>
          <h2>{props.title}</h2>
          <span className="grow" />
          {stepButtons}
          {graphControls}
          <button type="button" className="icon-btn" data-sheet-close="" aria-label={t("kanban.stages.close")} onClick={props.onClose}><CloseGlyph /></button>
          <WaitsOnButton waits={waits} open={waitsOpen} onToggle={() => setWaitsOpen((open) => !open)} buttonRef={waitsButton} />
          {waitsOpen ? <WaitsOnPopover waits={waits} /> : null}
        </header>
        {body}
      </section>
    </div>
  );
}

const tabId = (pipelineId: string, stageId: string) => `gs-tab-${pipelineId}-${stageId}`;
const panelId = (pipelineId: string) => `gs-panel-${pipelineId}`;

/** A rule line's sentence: at rest what a failure does, then the arc's own words once the edge has fired. */
function ruleText(t: ReturnType<typeof useLocale>["t"], rule: StageRule, arc: LoopArc | undefined, names: ReadonlyMap<string, string>): string {
  const from = names.get(rule.from) ?? rule.from;
  const to = names.get(rule.to) ?? rule.to;
  if (arc && arc.state !== "rest") return arcTitle(t, arc, from, to);
  const key = rule.shape === "self" ? "kanban.stages.ruleRetry" : rule.back ? "kanban.stages.ruleRest" : "kanban.stages.ruleOn";
  return t(key, { from, to, fired: rule.fired, max: rule.max });
}

/** One tab: a step, or the stage that only runs when another fails, as a subordinate tab in its source's cell. */
function StageTabButton({ tab, tabs, summary, names, arcs, selected, onSelect }: {
  tab: StageTab;
  tabs: StageTabModel;
  summary: KanbanPipeline;
  names: ReadonlyMap<string, string>;
  arcs: ReadonlyMap<string, LoopArc>;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useLocale();
  const { pipeline, views } = summary;
  const { stage } = tab;
  const view = views.get(stage.id);
  const state = view?.state ?? "pending";
  const note = tabNote(tab, summary);
  const identity = stageIdentity(pipeline, stage);
  const name = names.get(stage.id) ?? stage.id;
  const word = note.word ? t(`kanban.stages.tab.${note.word}`) : note.skipped ? t("kanban.stages.tab.skipped") : graphStateWord(t, state);
  const sources = tab.sources.map((id) => names.get(id) ?? id).join(t("kanban.stages.tab.or"));
  const next = stage.next ? names.get(stage.next) ?? stage.next : null;
  const arc = tab.carried ? arcs.get(tab.carried.id) : undefined;
  const why = tab.kind === "conditional" && sources
    ? [
      t("kanban.stages.tab.onlyIf", { sources }),
      next ? t("kanban.stages.tab.thenAgain", { stage: next }) : null,
      arc ? arcTitle(t, arc, names.get(arc.loop.from.id) ?? arc.loop.from.id, name) : null,
    ].filter(Boolean).join("; ")
    : tab.kind === "detached" ? t("kanban.stages.tab.offChain") : "";
  const label = tab.kind === "step"
    ? t("kanban.stages.tab.ariaStep", { n: tab.number!, stage: name, state: word })
    : t("kanban.stages.tab.aria", { stage: name, state: word });
  return (
    <button
      type="button"
      role="tab"
      id={tabId(pipeline.id, stage.id)}
      aria-controls={panelId(pipeline.id)}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={`stab tone-${STAGE_TONE[state]}${tab.kind === "conditional" ? " stab-cond" : ""}${tab.kind === "detached" ? " stab-off" : ""}${note.skipped ? " stab-skipped" : ""}${note.word ? " stab-unreached" : ""}`}
      data-tab-stage={stage.id}
      data-tab-kind={tab.kind}
      data-tab-state={state}
      data-tab-word={note.word ?? undefined}
      title={`${why ? `${label}. ${why}` : label}. ${identityTitle(t, identity)}`}
      aria-label={`${why ? t("kanban.stages.tab.ariaWhy", { label, why }) : label}. ${identityTitle(t, identity)}`}
      onClick={onSelect}
    >
      {note.skipped ? <span className="stab-skip" aria-hidden="true">↷</span> : null}
      {tab.kind === "step" ? <span className="snum num">{tab.number}</span> : <span className="sret" aria-hidden="true">{tab.kind === "conditional" ? "↺" : "·"}</span>}
      <span className="smark" aria-hidden="true">{NARROW_MARK[state]}</span>
      <StageGlyph state={state} model={identity} motion={view?.motion} fallback="dot" className="sglyph" />
      <span className="slbl">{name}</span>
      {tab.carried ? <RoundDots fired={tab.carried.fired} max={tab.carried.max} passed={arc ? arcPassed(arc, summary) : false} running={arc?.live ?? false} /> : null}
    </button>
  );
}

/** The source passed after the fix ran: the dots end in a success dot. */
function arcPassed(arc: LoopArc, summary: KanbanPipeline): boolean {
  return arc.loop.fired > 0 && summary.views.get(arc.loop.from.id)?.state === "passed";
}

function StagePane(props: Parameters<typeof StagesSheet>[0] & {
  pane: SheetPane;
  tab: StageTab;
  note: TabNote;
  /** The stage's fail edge is a rule line under the tabs, which says it once. */
  ruleLine: boolean;
  index: number;
  total: number;
  names: ReadonlyMap<string, string>;
}) {
  const { t } = useLocale();
  const { pane, tab, note, ruleLine, index, total, names, summary } = props;
  const { pipeline, views } = summary;
  const { stage, shown, attempts } = pane;
  const nameOf = (id: string) => names.get(id) ?? id;
  const name = nameOf(stage.id);
  const view = views.get(stage.id);
  const latest = attempts.at(-1) ?? null;
  const agent = stageAgentRowModel(pipeline, stage.id);
  const cloudUrl = stageCloudTaskUrl(pipeline, stage.id);
  const state: StageChipState = shown && shown !== latest ? chipState(shown.state) : view?.state ?? "pending";
  /* An earlier attempt the pane shows is history: its glyph holds still. */
  const motion = shown && shown !== latest ? "still" : view?.motion;
  /* A stage that never ran says why it is not waiting: it runs only if another fails, or it is off the chain. */
  const word = note.word && !shown ? t(`kanban.stages.tab.${note.word}`) : graphStateWord(t, state);
  const roleId = stageRoleId(stage);
  /* The pane header says who runs the stage in full words beside the same mark
     and ladder the tab and the node draw (#1743). */
  const identity = stageIdentity(pipeline, stage);
  const engine = engineWord(shown?.effectiveRole?.engine ?? stage.effectiveRole.engine);
  /* The glyph names the model of the attempt the pane shows, which an older
     attempt may have run on another model than the stage's latest. */
  const ran = shown?.effectiveRole ? valuesOf(shown.effectiveRole) : identity;
  /* Where the attempt on show ran, and why it moved if it did: a started stage's
     conversation header has no room for the cause, so the pane says it. */
  const shownPlace = shown ? attemptPlace(shown) : null;
  const draftKey = stageDraftKey(pipeline.id, stage.id);
  const draft = useStageDraft(props.drafts, draftKey);
  /* A waiting stage of a conversation's draft opens its role and runtime in place of its first message. */
  const [configuring, setConfiguring] = useState(false);
  const glyph = <span className="pglyph" aria-hidden="true"><svg {...svgProps} strokeWidth={1.8}>{ROLE_GLYPH[roleId] ?? ROLE_GLYPH.builder}</svg></span>;
  const aria = t("kanban.stages.paneAria", { n: index + 1, total, stage: name, role: roleNameById(t, roleId), engine, state: word });
  const className = `pane tone-${STAGE_TONE[state]} role-${roleId} focus`;
  const rechecks = useMemo(() => recheckAttempts(pipeline, stage.id), [pipeline, stage.id]);
  /* What the lane stopped on is said in the stage it stopped on, in place of the bare question. */
  const answers = pipelineAnswers(pipeline, (entry) => nameOf(entry.id));
  const stopped = answers && answers.kind !== "merge" && (answers.stage?.id ?? parkedStage(pipeline)?.id) === stage.id ? answers : null;

  const facts = paneFacts(pipeline, stage, shown, view);
  const after = pipeline.stages.find((candidate) => candidate.next === stage.id);
  const bits = [
    facts.startedBy
      ? t("kanban.stages.startedBy", { stage: nameOf(facts.startedBy.stageId), edge: t(`kanban.graph.${facts.startedBy.edge}`) })
      : after ? t("kanban.stages.runsAfter", { stage: nameOf(after.id) }) : t("kanban.stages.firstStage"),
    facts.nextAttempt ? t("kanban.graph.lastWas", { state: graphStateWord(t, facts.nextAttempt) }) : null,
    facts.onFail && !ruleLine ? t("kanban.stages.onFail", { stage: nameOf(facts.onFail.to), fired: facts.onFail.fired, max: facts.onFail.max }) : null,
  ].filter(Boolean).join(" · ");
  const rounds = stage.kind === "review-loop" ? roundsOf(shown, props.flowsById) : [];
  const recorded = shown && (shown.agentPath || shown.conversationId) ? { path: shown.agentPath, conversationId: shown.conversationId } : null;

  /* A pipeline that ended before this stage launched leaves at most an attempt
     that never ran: the pane still shows the first message it never sent. */
  const neverRan = !shown || (pipelineEnded(pipeline) && attempts.every(neverLaunched));
  const outcome = draft && draft.phase !== "saving" ? draftOutcome(pipeline, stage.id, draft) : null;
  let body: React.ReactNode;
  if (neverRan && props.windowDraft === stage.id) {
    /* One editor of a first message at a time: the window's. */
    body = (
      <div className="pane-conv away" data-pane-away={draftKey}>
        <p className="pane-note">{t("kanban.stages.inFullPane")}</p>
        <button type="button" className="btn quiet" onClick={props.onLeaveWindow}>{t("kanban.stages.showHere")}</button>
      </div>
    );
  } else if (neverRan) {
    body = (
      <div className="pane-conv draft">
        <div className="ch-meta pane-id">
          <StageIdentity identity={identity} density="header" showWord glyph />
          <StageAccountChip pipeline={pipeline} stage={stage} />
          {conversationDraftLane(pipeline) ? <ConfigureToggle stage={stage} name={name} open={configuring} onToggle={() => setConfiguring((value) => !value)} /> : null}
        </div>
        {configuring && conversationDraftLane(pipeline)
          ? <div className="pane-config" data-draft-configure-pane={stage.id}><DraftStageConfigure pipeline={pipeline} stage={stage} /></div>
          : <StageDraftFeed pipeline={pipeline} stage={stage} names={names} drafts={props.drafts} ports={props.ports} fromConversation={props.fromConversation} />}
      </div>
    );
  } else if (pane.readerKey && props.windowReader === pane.readerKey) {
    body = (
      <div className="pane-conv away" data-pane-away={pane.readerKey}>
        <p className="pane-note">{t("kanban.stages.inFullPane")}</p>
        <button type="button" className="btn quiet" onClick={props.onLeaveWindow}>{t("kanban.stages.showHere")}</button>
      </div>
    );
  } else if (pane.readerKey) {
    body = (
      <div className="pane-conv">
        <ReaderSlot placement={props.placement} readerKey={pane.readerKey} />
      </div>
    );
  } else if (recorded) {
    body = (
      <div className="pane-conv away">
        <p className="pane-note">{t("kanban.stages.notOnBoard")}</p>
        <button type="button" className="btn quiet" onClick={() => props.onOpenRecorded(recorded)}>{t("kanban.past.open")}</button>
      </div>
    );
  } else {
    /* With no conversation to show, a setup the attempt ran has the pane's
       room, and the note under it is one line. */
    body = <div className={`pane-conv away${shown.setup ? " line" : ""}`}><p className="pane-note">{shown.state === "spawning" || shown.state === "pending" ? t("kanban.stages.starting") : t("kanban.graph.noConversationTitle")}</p></div>;
  }
  const setupFills = !neverRan && !pane.readerKey && !recorded;

  return (
    <section className={className} data-stage={stage.id} tabIndex={-1} role="region" aria-label={aria}>
      <div className="pane-head">
        {glyph}
        <span className="pane-title">
          <span className="pname">{tab.kind === "step" ? `${tab.number}. ` : tab.kind === "conditional" ? "↺ " : ""}{name}</span>
          {/* The column head says which stage and where it stands. Who runs it
              (engine, model, effort) is said once, by the conversation's own
              header under it or, before the stage starts, by the draft's
              identity row; the words stay in the row's title (#1743). */}
          <span className="prole" title={identityTitle(t, identity)}>
            <span className="prole-role">{roleNameById(t, roleId)}</span>
            {stage.kind === "review-loop" ? <span className="prole-kind">{t("kanban.stages.reviewLoop")}</span> : null}
          </span>
        </span>
        {/* A drawn glyph already names the model and the state, so the word
            beside it is for the eye only. */}
        <span className="pstate"><StageGlyph state={state} model={ran} motion={motion} fallback="dot" badge={false} named /><span aria-hidden={modelGlyphKind(ran.engine, ran.model) ? true : undefined}>{word}</span></span>
        <span className="spacer" />
        <button type="button" className="icon-btn sm" aria-haspopup="menu" data-pane-menu={stage.id} aria-label={t("kanban.stages.stageActions", { stage: name })} onClick={(event) => props.onStageMenu(stage, event.currentTarget)}>
          <MoreGlyph />
        </button>
      </div>
      {/* A stage that never ran says when it starts once, in its draft. */}
      {neverRan ? null : <div className="pane-sub">{bits}</div>}
      {!neverRan && shownPlace ? <StagePlaceLine place={shownPlace} /> : null}
      {agent.question ? <p className="m-0 max-h-40 shrink-0 overflow-y-auto whitespace-pre-wrap break-words text-ui text-primary" tabIndex={0} data-stage-question={stage.id}>{agent.question}</p> : null}
      {stopped ? (
        <div className="pblock pane-stop" data-pane-stop={stage.id}>
          <div className="pb-answer"><AnswerReport pipeline={pipeline} answers={stopped} names={names} nameOf={(entry) => nameOf(entry.id)} /></div>
        </div>
      ) : null}
      {agent.target ? (
        <button type="button" className="btn quiet" data-open-conversation={stage.id} onClick={() => {
          props.onClose();
          props.onOpenRecorded({ path: agent.target!.agentPath, conversationId: agent.target!.conversationId });
        }}>{t("pipelineStage.openAgent")}</button>
      ) : cloudUrl ? (
        <a className="btn quiet" data-open-cloud={stage.id} href={cloudUrl} target="_blank" rel="noopener noreferrer" aria-label={t("pipelineStage.openCloudTaskAria", { stage: name })}>{t("pipelineStage.openCloudTask")}</a>
      ) : null}
      {attempts.length > 1 ? (
        <div className="attempts" role="group" aria-label={t("kanban.stages.attempts")}>
          {/* Numbered among the stage's own attempts, as the graph numbers them;
              the engine's `n` keys the choice. */}
          {attempts.map((attempt, index) => {
            const attemptWord = [rechecks.has(attempt.n) ? t("kanban.stages.recheck") : null, graphStateWord(t, chipState(attempt.state))].filter(Boolean).join(" · ");
            return (
              <button
                key={attempt.n}
                type="button"
                aria-pressed={attempt === shown}
                className={attempt.state === "failed" ? "bad" : undefined}
                data-attempt={attempt.n}
                aria-label={t("kanban.stages.attemptAria", { n: index + 1, state: attemptWord })}
                onClick={() => props.onChooseAttempt(stage.id, attempt.n)}
              >
                {t("kanban.attemptWord", { n: index + 1 })} · {attemptWord}
              </button>
            );
          })}
        </div>
      ) : null}
      {rounds.length ? (
        <div className="rounds" aria-label={t("kanban.stages.rounds")}>
          {rounds.map((round) => (
            <button type="button" key={round.n} onClick={() => { if (shown?.flowId) openReviewHistory(shown.flowId, round.n); }} className={`rchip min-h-6 pointer-coarse:min-h-11 ${round.verdict === "approved" ? "ok" : round.verdict === "changes" ? "bad" : "open"}`}>
              {t("kanban.stages.round", { n: round.n, verdict: t(`kanban.graph.verdict.${round.verdict}`) })}
            </button>
          ))}
        </div>
      ) : null}
      {draft && (outcome === "undelivered" || (outcome === "ended-before-start" && !neverRan)) ? (
        <DraftLeftover kind={outcome === "undelivered" ? "undelivered" : "ended"} draft={draft} draftKey={draftKey} name={name} drafts={props.drafts} onOpenConversation={recorded ? () => props.onOpenRecorded(recorded) : null} />
      ) : null}
      {/* The setup result belongs to the attempt the pane shows. Above a
          conversation it takes at most half the pane, so the conversation
          keeps its room; with none, it takes what the pane has. */}
      {shown ? <StageSetupResult setup={shown.setup} worktreeDir={pipeline.worktreeDir} fit fill={setupFills} /> : null}
      <AgentMemoryCapNote cap={shown?.memoryCap} />
      {body}
    </section>
  );
}
