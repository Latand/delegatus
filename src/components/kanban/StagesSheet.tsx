"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Flow } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { PipelineAttemptState, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { roleNameById } from "@/components/builderCopy";
import { pipelineStateLabel, type StageChipState } from "@/components/pipelines/pipelineModel";

import type { KanbanPipeline } from "./kanbanModel";
import { GraphGlyph, graphStateWord, MoreGlyph, PipelineGraph, pipelineProgress, ROLE_GLYPH, stageNames, stageRoleId, svgProps } from "./PipelineSection";
import { graphOrder, layoutGraph, roundsOf, STAGE_TONE } from "./pipelineGraph";
import type { PipelinePorts } from "./pipelinePorts";
import { ReaderSlot, type ReaderPlacement } from "./KanbanReaders";
import { StageDraftFeed, UndeliveredDraft, useStageDraft } from "./StageDraft";
import { stageDraftKey, type StageDrafts } from "./stageDrafts";
import { paneFacts } from "./stagesModel";

/*
 * Expanded stages (#1695 K5b, prototype `renderSheet` + `renderPane`): every
 * stage of one pipeline as a pane, in graph order. A navigator of stage chips
 * and the pipeline's loops, the graph when there is room for it, and a lane of
 * panes that scrolls sideways. A started stage's pane holds the conversation
 * of the attempt it shows, as the board's own reader: the same mounted
 * conversation a card shows, moved here while the sheet is open. A stage that
 * has not started holds its first message, editable until it starts.
 */

const MinusGlyph = () => <svg {...svgProps}><path d="M5 12h14" /></svg>;
const PlusGlyph = () => <svg {...svgProps}><path d="M12 5v14M5 12h14" /></svg>;
const FitGlyph = () => <svg {...svgProps}><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" /></svg>;
const CloseGlyph = () => <svg {...svgProps}><path d="M18 6 6 18M6 6l12 12" /></svg>;
const CollapseGlyph = () => <svg {...svgProps}><path d="m17 11-5-5-5 5" /><path d="m17 18-5-5-5 5" /></svg>;
const ChevronRight = ({ flip = false }: { flip?: boolean }) => <svg {...svgProps} className={`chev${flip ? " flip" : ""}`}><path d="m9 6 6 6-6 6" /></svg>;

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/** One pane as the board computed it: which attempt it shows and where that conversation lives. */
export interface SheetPane {
  stage: PipelineStage;
  folded: boolean;
  /** The stage's own attempts, oldest first. */
  attempts: PipelineStageAttempt[];
  shown: PipelineStageAttempt | null;
  /** The shown attempt's conversation on this board. */
  file: FileEntry | null;
  readerKey: string | null;
}

export type SheetZoom = "fit" | number;

const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.4;

/** An attempt's state as a stage chip draws it: a host still starting reads as running. */
const chipState = (state: PipelineAttemptState): StageChipState => (state === "spawning" ? "running" : state);

export function StagesSheet(props: {
  title: string;
  summary: KanbanPipeline;
  panes: readonly SheetPane[];
  flowsById: ReadonlyMap<string, Flow>;
  /** The stage the sheet opened on. */
  initialFocus: string | null;
  fullReader: string | null;
  placement: ReaderPlacement;
  drafts: StageDrafts;
  ports: PipelinePorts;
  onFold: (stageId: string, folded: boolean) => void;
  onFoldMany: (stageIds: readonly string[], folded: boolean) => void;
  onChooseAttempt: (stageId: string, n: number) => void;
  onStageMenu: (stage: PipelineStage, anchor: HTMLElement) => void;
  onOpenRecorded: (conversation: { path: string | null; conversationId: string | null }) => void;
  onLeaveFull: (key: string) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const { summary, panes } = props;
  const { pipeline, views } = summary;
  const names = useMemo(() => stageNames(t, pipeline), [t, pipeline]);
  const nameOf = (stage: PipelineStage) => names.get(stage.id) ?? stage.id;
  const order = useMemo(() => graphOrder(pipeline), [pipeline]);
  const [graph, setGraph] = useState(() => typeof window === "undefined" || window.innerWidth >= 700);
  const [zoom, setZoom] = useState<SheetZoom>("fit");
  const [focus, setFocus] = useState<string | null>(props.initialFocus ?? order[0]?.id ?? null);
  const [inView, setInView] = useState<ReadonlySet<string>>(new Set());
  const [firstInView, setFirstInView] = useState(0);
  const lane = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState<number | null>(null);
  const pendingScroll = useRef<{ stageId: string; smooth: boolean } | null>(props.initialFocus ? { stageId: props.initialFocus, smooth: false } : null);

  /* Which stages are in view: the navigator and the graph say it as the lane scrolls. */
  const markLane = useCallback(() => {
    const element = lane.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const seen = new Set<string>();
    let first = -1;
    element.querySelectorAll<HTMLElement>(".pane[data-stage]").forEach((pane, index) => {
      const rect = pane.getBoundingClientRect();
      if (rect.right > bounds.left + 40 && rect.left < bounds.right - 40) {
        seen.add(pane.dataset.stage!);
        if (first < 0) first = index;
      }
    });
    setInView((current) => (current.size === seen.size && [...seen].every((id) => current.has(id)) ? current : seen));
    setFirstInView(Math.max(0, first));
  }, []);

  const scrollLaneTo = useCallback((stageId: string, smooth = true) => {
    const element = lane.current;
    const pane = element?.querySelector<HTMLElement>(`.pane[data-stage="${cssEscape(stageId)}"]`);
    setFocus(stageId);
    if (!element || !pane) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({ left: Math.max(0, pane.offsetLeft - 12), behavior: smooth && !reduce ? "smooth" : "auto" });
    pane.classList.remove("pane-flash");
    void pane.offsetWidth;
    pane.classList.add("pane-flash");
    markLane();
  }, [markLane]);

  /* A folded pane opens before the lane scrolls to it. */
  const reach = (stageId: string) => {
    const pane = panes.find((entry) => entry.stage.id === stageId);
    if (pane?.folded) {
      pendingScroll.current = { stageId, smooth: true };
      setFocus(stageId);
      props.onFold(stageId, false);
    } else {
      scrollLaneTo(stageId);
    }
  };
  useLayoutEffect(() => {
    const wanted = pendingScroll.current;
    if (!wanted) return;
    pendingScroll.current = null;
    scrollLaneTo(wanted.stageId, wanted.smooth);
  });
  useEffect(() => {
    markLane();
  }, [panes, markLane]);

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

  /* Focus lands on the stage the sheet opened on; closing hands it back to the board. */
  useLayoutEffect(() => {
    const target = sheet.current?.querySelector<HTMLElement>(`.pane[data-stage="${cssEscape(focus ?? "")}"]`) ?? sheet.current?.querySelector<HTMLElement>("[data-sheet-close]");
    target?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);

  const step = (delta: number) => {
    const ids = order.map((stage) => stage.id);
    const index = Math.max(0, ids.indexOf(focus ?? ""));
    const next = ids[Math.max(0, Math.min(ids.length - 1, index + delta))];
    if (!next) return;
    scrollLaneTo(next);
    sheet.current?.querySelector<HTMLElement>(`.pane[data-stage="${cssEscape(next)}"]`)?.focus({ preventScroll: true });
  };

  const finished = panes.filter((pane) => {
    const view = views.get(pane.stage.id);
    return view && (view.state === "passed" || view.state === "skipped" || (view.again && view.previous === "passed"));
  }).map((pane) => pane.stage.id);

  const available = canvasWidth === null ? null : Math.max(0, canvasWidth - 24);
  const dir = canvasWidth !== null && canvasWidth >= 640 ? "LR" : "TB";
  const layout = available === null ? null : layoutGraph(pipeline, available, dir);
  const scale = layout ? (zoom === "fit" ? Math.max(0.9, Math.min(1, available! / Math.max(1, layout.width))) : zoom) : 1;
  const changeZoom = (kind: "-" | "+" | "fit") => setZoom((current) => {
    if (kind === "fit") return "fit";
    const base = current === "fit" ? 1 : current;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number((base + (kind === "+" ? 0.1 : -0.1)).toFixed(2))));
  });

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
          props.onClose();
        }}
      >
        <header>
          <span className="kind">{t("kanban.pipeline")}</span>
          <h2>{props.title}</h2>
          <span className="pstate-chip" data-pstate={pipeline.state}>{pipelineStateLabel(t, pipeline.state)}</span>
          <span className="progress">{t("kanban.stages.headProgress", { count: order.length, progress: pipelineProgress(t, summary, nameOf) })}</span>
          <span className="grow" />
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
          <button type="button" className="icon-btn" data-sheet-close="" aria-label={t("kanban.stages.close")} onClick={props.onClose}><CloseGlyph /></button>
        </header>

        <nav className="gs-nav" aria-label={t("kanban.stages.navAria")}>
          {order.map((stage, index) => {
            const state = views.get(stage.id)?.state ?? "pending";
            return (
              <button
                key={stage.id}
                type="button"
                className={`navchip tone-${STAGE_TONE[state]}${inView.has(stage.id) ? " in-view" : ""}`}
                data-nav-stage={stage.id}
                aria-current={focus === stage.id}
                aria-label={t("kanban.stages.navChipAria", { n: index + 1, stage: nameOf(stage), state: graphStateWord(t, state) })}
                onClick={() => reach(stage.id)}
              >
                <span className="nidx num">{index + 1}</span>
                <i className="pdot" aria-hidden="true" />
                <span className="nlbl">{nameOf(stage)}</span>
              </button>
            );
          })}
          {summary.loops.map((loop) => (
            <span key={`${loop.from.id}->${loop.to.id}`} className="ploop fail" title={t("kanban.loopTitle", { from: nameOf(loop.from), to: nameOf(loop.to), fired: loop.fired, max: loop.max })}>
              {t("kanban.loop", { from: nameOf(loop.from), to: nameOf(loop.to), fired: loop.fired, max: loop.max })}
            </span>
          ))}
        </nav>

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
                      selected={new Set(focus ? [focus] : [])}
                      inView={inView}
                      navigate
                      onOpenStage={(_pipeline, stage) => reach(stage.id)}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="lane-bar">
            <span className="pos num">{t("kanban.stages.position", { k: firstInView + 1, n: order.length })}</span>
            <span className="lane-count num">{t("kanban.stages.inView", { count: inView.size })}</span>
            <span className="grow" />
            <button type="button" className="btn quiet" data-collapse-finished="" disabled={!finished.length} onClick={() => props.onFoldMany(finished, true)}>{t("kanban.stages.collapseFinished")}</button>
            <button type="button" className="btn quiet" data-expand-all="" onClick={() => props.onFoldMany(order.map((stage) => stage.id), false)}>{t("kanban.stages.expandAll")}</button>
            <button type="button" className="icon-btn" aria-label={t("kanban.stages.previous")} data-lane-prev="" onClick={() => step(-1)}><ChevronRight flip /></button>
            <button type="button" className="icon-btn" aria-label={t("kanban.stages.next")} data-lane-next="" onClick={() => step(1)}><ChevronRight /></button>
          </div>
          <div
            ref={lane}
            className="lane"
            role="region"
            aria-label={t("kanban.stages.laneAria")}
            tabIndex={-1}
            onScroll={markLane}
            onKeyDown={(event) => {
              if ((event.target as HTMLElement).closest("input, textarea, [contenteditable='true'], [data-kanban-reader]")) return;
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              step(event.key === "ArrowRight" ? 1 : -1);
            }}
          >
            {order.map((stage, index) => {
              const pane = panes.find((entry) => entry.stage.id === stage.id);
              if (!pane) return null;
              const previous = order[index - 1];
              return (
                <PaneSlot key={stage.id} connector={index > 0 ? (previous?.next === stage.id ? "pass" : "loose") : null}>
                  <StagePane
                    {...props}
                    pane={pane}
                    index={index}
                    total={order.length}
                    names={names}
                    focused={focus === stage.id}
                  />
                </PaneSlot>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function PaneSlot({ connector, children }: { connector: "pass" | "loose" | null; children: React.ReactNode }) {
  return (
    <>
      {connector ? <span className={`lane-conn${connector === "loose" ? " loose" : ""}`} aria-hidden="true">{connector === "pass" ? "→" : "·"}</span> : null}
      {children}
    </>
  );
}

function StagePane(props: Parameters<typeof StagesSheet>[0] & {
  pane: SheetPane;
  index: number;
  total: number;
  names: ReadonlyMap<string, string>;
  focused: boolean;
}) {
  const { t } = useLocale();
  const { pane, index, total, names, summary } = props;
  const { pipeline, views } = summary;
  const { stage, shown, attempts } = pane;
  const nameOf = (id: string) => names.get(id) ?? id;
  const name = nameOf(stage.id);
  const view = views.get(stage.id);
  const latest = attempts.at(-1) ?? null;
  const state: StageChipState = shown && shown !== latest ? chipState(shown.state) : view?.state ?? "pending";
  const word = graphStateWord(t, state);
  const roleId = stageRoleId(stage);
  const engine = (shown?.effectiveRole.engine ?? stage.effectiveRole.engine) === "codex" ? "Codex" : "Claude";
  const draftKey = stageDraftKey(pipeline.id, stage.id);
  const draft = useStageDraft(props.drafts, draftKey);
  const glyph = <span className="pglyph" aria-hidden="true"><svg {...svgProps} strokeWidth={1.8}>{ROLE_GLYPH[roleId] ?? ROLE_GLYPH.builder}</svg></span>;
  const aria = t(pane.folded ? "kanban.stages.paneAriaFolded" : "kanban.stages.paneAria", { n: index + 1, total, stage: name, role: roleNameById(t, roleId), engine, state: word });
  const className = `pane tone-${STAGE_TONE[state]} role-${roleId}${pane.folded ? " folded" : ""}${props.focused ? " focus" : ""}`;

  if (pane.folded) {
    return (
      <section className={className} data-stage={stage.id} data-collapsed="1" tabIndex={-1} role="region" aria-label={aria}>
        <button type="button" className="pane-strip" data-pane-fold={stage.id} aria-label={t("kanban.stages.expandPane", { stage: name })} onClick={() => props.onFold(stage.id, false)}>
          {glyph}
          <i className="pdot" aria-hidden="true" />
          <span className="vlabel"><span className="num">{index + 1}</span> {name} · {word}</span>
        </button>
      </section>
    );
  }

  const facts = paneFacts(pipeline, stage, shown, view);
  const after = pipeline.stages.find((candidate) => candidate.next === stage.id);
  const bits = [
    facts.startedBy
      ? t("kanban.stages.startedBy", { stage: nameOf(facts.startedBy.stageId), edge: t(`kanban.graph.${facts.startedBy.edge}`) })
      : after ? t("kanban.stages.runsAfter", { stage: nameOf(after.id) }) : t("kanban.stages.firstStage"),
    facts.nextAttempt ? t("kanban.graph.nextAttempt", { state: graphStateWord(t, facts.nextAttempt) }) : null,
    facts.onFail ? t("kanban.stages.onFail", { stage: nameOf(facts.onFail.to), fired: facts.onFail.fired, max: facts.onFail.max }) : null,
  ].filter(Boolean).join(" · ");
  const rounds = stage.kind === "review-loop" ? roundsOf(shown, props.flowsById) : [];
  const recorded = shown && (shown.agentPath || shown.conversationId) ? { path: shown.agentPath, conversationId: shown.conversationId } : null;

  let body: React.ReactNode;
  if (!shown) {
    body = (
      <div className="pane-conv draft">
        <div className="ch-meta pane-id">
          <span className={`ch-engine ${stage.effectiveRole.engine}`}>{engine}</span>
          {stage.effectiveRole.model ? <span className="ch-model">{stage.effectiveRole.effort ? `${stage.effectiveRole.model} · ${stage.effectiveRole.effort}` : stage.effectiveRole.model}</span> : null}
        </div>
        <StageDraftFeed pipeline={pipeline} stage={stage} names={names} drafts={props.drafts} ports={props.ports} />
      </div>
    );
  } else if (pane.readerKey && props.fullReader === pane.readerKey) {
    body = (
      <div className="pane-conv away" data-pane-away={pane.readerKey}>
        <p className="pane-note">{t("kanban.stages.inFullPane")}</p>
        <button type="button" className="btn quiet" onClick={() => props.onLeaveFull(pane.readerKey!)}>{t("kanban.readerLeaveFull")}</button>
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
    body = <div className="pane-conv away"><p className="pane-note">{shown.state === "spawning" || shown.state === "pending" ? t("kanban.stages.starting") : t("kanban.graph.noConversationTitle")}</p></div>;
  }

  return (
    <section className={className} data-stage={stage.id} data-collapsed="0" tabIndex={-1} role="region" aria-label={aria}>
      <div className="pane-head">
        {glyph}
        <span className="pane-title">
          <span className="pname">{index + 1}. {name}</span>
          <span className="prole">{[roleNameById(t, roleId), engine, stage.kind === "review-loop" ? t("kanban.stages.reviewLoop") : null].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="pstate"><i className="pdot" aria-hidden="true" />{word}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn sm" data-pane-fold={stage.id} aria-label={t("kanban.stages.collapsePane", { stage: name })} title={t("kanban.readerCollapse")} onClick={() => props.onFold(stage.id, true)}>
          <CollapseGlyph />
        </button>
        <button type="button" className="icon-btn sm" aria-haspopup="menu" data-pane-menu={stage.id} aria-label={t("kanban.stages.stageActions", { stage: name })} onClick={(event) => props.onStageMenu(stage, event.currentTarget)}>
          <MoreGlyph />
        </button>
      </div>
      <div className="pane-sub">{bits}</div>
      {attempts.length > 1 ? (
        <div className="attempts" role="group" aria-label={t("kanban.stages.attempts")}>
          {attempts.map((attempt) => {
            const attemptWord = graphStateWord(t, chipState(attempt.state));
            return (
              <button
                key={attempt.n}
                type="button"
                aria-pressed={attempt === shown}
                className={attempt.state === "failed" ? "bad" : undefined}
                data-attempt={attempt.n}
                aria-label={t("kanban.stages.attemptAria", { n: attempt.n, state: attemptWord })}
                onClick={() => props.onChooseAttempt(stage.id, attempt.n)}
              >
                #{attempt.n} · {attemptWord}
              </button>
            );
          })}
        </div>
      ) : null}
      {rounds.length ? (
        <div className="rounds" aria-label={t("kanban.stages.rounds")}>
          {rounds.map((round) => (
            <span key={round.n} className={`rchip ${round.verdict === "approved" ? "ok" : round.verdict === "changes" ? "bad" : "open"}`}>
              {t("kanban.stages.round", { n: round.n, verdict: t(`kanban.graph.verdict.${round.verdict}`) })}
            </span>
          ))}
        </div>
      ) : null}
      {draft && shown && draft.phase !== "saving" ? (
        <UndeliveredDraft draft={draft} draftKey={draftKey} name={name} drafts={props.drafts} onOpenConversation={recorded ? () => props.onOpenRecorded(recorded) : null} />
      ) : null}
      {body}
    </section>
  );
}
