"use client";

import { Boxes, CircleX, Eye, Pause, Play } from "lucide-react";

import { ChevronRight } from "@/components/icons";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";

import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { cleanTitle } from "@/lib/title";

import { reviewerBindingTargetsForRound } from "../flows/flowModel";
import type { ReceiptAction as BoardReceiptAction } from "../kanban/KanbanReceipts";
import { summarizePipeline } from "../kanban/kanbanModel";
import { pastAttempts } from "../kanban/pipelineGraph";
import { pastAttemptLabel, pastAttemptState, pastAttemptTone, pipelineTitle } from "../kanban/PipelineSection";
import { browserPipelinePorts, type PipelinePorts } from "../kanban/pipelinePorts";
import { pipelineActionOptions, type PipelineActionKind } from "../kanban/stagesModel";
import { usePipelineActions, type PipelineActionIntent } from "../kanban/usePipelineActions";
import {
  attemptNavTarget,
  latestAttempt,
  patchPipeline,
  pipelineLinkedTasks,
  resolveStageNavFile,
  stageAttempts,
  stageNames,
} from "../pipelines/pipelineModel";
import { PipelineBlock, PipelineStateLine } from "../pipelines/PipelineBlock";
import { blockAgeSeconds, type PipelineAnswer } from "../pipelines/pipelineBlockModel";
import { StagePlaceholderPane } from "../pipelines/StagePlaceholderPane";
import type { StageSlot } from "../scheme/layout";
import { humanizeDuration } from "../turnDuration";
import { nowFragment, pipelineHiddenFromBoard } from "./mobileBoardModel";
import { RECEIPT_MS, showReceipt, type ReceiptTimers } from "./MobileReceipt";
import { WorkLinksPanel } from "@/components/workLinks/WorkLinkChips";
import { useWorkLinks } from "@/components/workLinks/workLinksContext";
import { MobileSheet, MobileSheetDivider, MobileSheetRow } from "./MobileSheet";
import { MobileShell, type MobileShellHost, type SheetRenderer } from "./MobileShell";
import { useMobileNav, useMobileNavStore, useMobileScreenState, useMobileScrollMemory } from "./mobileNav";

/*
 * One pipeline on the phone: the Stages view (#2072 slice 6,
 * docs/design/phone-kanban.md §3.13), on the mobile v2 screen stack (#1439,
 * lane 7). The screen itself is documented at `MobilePipelineScreen` below;
 * this part of the file is the one store every phone surface shares for the
 * two pipeline acts the engine cannot take back.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * The two acts the engine cannot take back                                    *
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * `skip-stage` and `close` are one-way in the engine: a skip advances the
 * cursor, so `retry-stage` is refused from the state a skip leaves behind, and
 * a closed pipeline has no re-open action at all. The design still requires the
 * inverse to be in the receipt (§2 rule 9, §5: Skip → Retry stage, Archive →
 * Restore), and a button that always answers 409 is not an inverse.
 *
 * So the receipt IS the window: the tap commits the phone to the act and hands
 * the PATCH to the receipt's own four seconds. The inverse cancels it; the
 * window closing sends it, exactly as the desktop would have. Nothing else on
 * the phone defers — only these two, and only because the engine keeps no way
 * back once it has them.
 */
export type DeferredPipelineAction = "skip-stage" | "close";

export interface PendingPipelineAct {
  pipelineId: string;
  action: DeferredPipelineAction;
  /** What the window closing sends, when it is not the plain PATCH: a skip
      answered inside its stage goes through the board's own pipeline actions
      (`usePipelineActions`), which name the stage and attempt it saw (#2072). */
  send?: () => PromiseLike<void> | void;
}

export interface PendingPipelineActs {
  getState(): PendingPipelineAct | null;
  /** Every lane whose close the operator took and the server has not answered:
      the one the receipt holds, then each whose PATCH is still out (#1671).
      The same array until that set changes, so a render may read it. */
  getClosing(): readonly string[];
  subscribe(listener: () => void): () => void;
  /** Hold `act` for the receipt's window. A second act sends the first. */
  begin(act: PendingPipelineAct): void;
  /** The inverse was taken: nothing is sent. */
  cancel(): void;
  /** The window closed: send it now. */
  flush(): void;
}

const REAL_TIMERS: ReceiptTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The PATCH a settled act issues — the desktop's own call, no phone variant. */
async function sendPipelineAct(act: PendingPipelineAct): Promise<void> {
  const fail = await patchPipeline(act.pipelineId, act.action);
  if (fail) showReceipt(fail);
}

const NO_CLOSING: readonly string[] = [];

export function createPendingPipelineActs(
  timers: ReceiptTimers = REAL_TIMERS,
  send: (act: PendingPipelineAct) => PromiseLike<void> | void = sendPipelineAct,
  windowMs: number = RECEIPT_MS,
): PendingPipelineActs {
  let current: PendingPipelineAct | null = null;
  let handle: unknown = null;
  /* A close that has gone out keeps its lane gone until it is answered: a real
     close spends seconds stopping hosts, and a row that came back meanwhile
     would read as the close undone (#1671). When a close succeeds,
     `patchPipeline` has applied the closed echo before this settles; a refused
     one brings the lane back beside the receipt that says why. */
  const sending = new Map<string, number>();
  let closing = NO_CLOSING;
  const listeners = new Set<() => void>();
  const publish = (): void => {
    const next = [...new Set([...(current?.action === "close" ? [current.pipelineId] : []), ...sending.keys()])];
    const same = next.length === closing.length && next.every((id, index) => closing[index] === id);
    if (!same) closing = next.length ? next : NO_CLOSING;
    for (const listener of listeners) listener();
  };
  const dispatch = (act: PendingPipelineAct): void => {
    const answer = act.send ? act.send() : send(act);
    if (act.action !== "close" || !answer) return;
    sending.set(act.pipelineId, (sending.get(act.pipelineId) ?? 0) + 1);
    const settle = (): void => {
      const left = (sending.get(act.pipelineId) ?? 1) - 1;
      if (left > 0) sending.set(act.pipelineId, left);
      else sending.delete(act.pipelineId);
      publish();
    };
    answer.then(settle, settle);
  };
  const take = (): PendingPipelineAct | null => {
    if (handle !== null) timers.clear(handle);
    handle = null;
    const taken = current;
    current = null;
    return taken;
  };
  return {
    getState: () => current,
    getClosing: () => closing,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(act) {
      const superseded = take();
      if (superseded) dispatch(superseded);
      current = act;
      handle = timers.set(() => {
        handle = null;
        const settled = current;
        if (!settled) return;
        current = null;
        dispatch(settled);
        publish();
      }, windowMs);
      publish();
    },
    cancel() {
      if (take()) publish();
    },
    flush() {
      const settled = take();
      if (!settled) return;
      dispatch(settled);
      publish();
    },
  };
}

/** The tab's one held act. */
export const pendingPipelineActs: PendingPipelineActs = createPendingPipelineActs();

export function usePendingPipelineAct(store: PendingPipelineActs = pendingPipelineActs): PendingPipelineAct | null {
  return useSyncExternalStore(store.subscribe, store.getState, () => null);
}

/** The lanes whose close is on its way, for every surface that lists lanes. */
export function useClosingPipelines(store: PendingPipelineActs = pendingPipelineActs): readonly string[] {
  return useSyncExternalStore(store.subscribe, store.getClosing, () => NO_CLOSING);
}


/* ────────────────────────────────────────────────────────────────────────── *
 * The screen                                                                  *
 * ────────────────────────────────────────────────────────────────────────── */

/** An action the bar's ⋯ offers for the lane. The answers to a decision or a
    spent review budget are not here: they are inside the stage they are
    about (§3.13). */
export interface MobilePipelineActionSpec {
  key: "pause" | "resume" | "archive";
  action: PipelineActionKind;
}

/** The ⋯ sheet's actions for a pipeline: pause or resume where the board's
    menu offers them, and Close lane for every lane that is not a draft or
    closed already (a finished lane leaves the phone's lists that way). */
export function mobilePipelineActions(pipeline: Pipeline): MobilePipelineActionSpec[] {
  if (pipeline.state === "draft" || pipeline.state === "closed") return [];
  const specs: MobilePipelineActionSpec[] = [];
  for (const option of pipelineActionOptions(pipeline)) {
    if (option.refusal) continue;
    if (option.action === "pause") specs.push({ key: "pause", action: "pause" });
    if (option.action === "resume") specs.push({ key: "resume", action: "resume" });
  }
  specs.push({ key: "archive", action: "close" });
  return specs;
}

const ACTION_ICON = {
  pause: Pause,
  resume: Play,
  /* Labelled «Close lane» (#1671): the row names what it does, which is stop
     the lane's agents. */
  archive: CircleX,
} as const;

/** The board's pipeline answers on the phone's receipt: the desktop's words,
    its Retry or Check again as the receipt's action, a refusal in danger. */
const phoneShow = (text: string, action?: BoardReceiptAction, options?: { error?: boolean }): number =>
  showReceipt(text, action ? { kind: "act", label: action.label, run: action.run } : null, { error: options?.error }).id;

/** A stage an act names, as the pipeline showed it. */
type ActStage = Pick<PipelineAnswer, "stageId" | "stageName" | "expectedAttempt">;

/**
 * The pipeline acts of a phone screen, the pipeline's own and the task's alike
 * (#2072 slices 5 and 6): the board's pipeline actions (`usePipelineActions`),
 * so the phone sends the requests the desktop's ⋯ menu sends, with the two acts
 * the engine cannot take back held for the receipt's window. Skip stage waits
 * out the receipt, whose inverse cancels it; Close lane too, and then
 * `onClosed` lets the screen step off a lane that has gone. Retry, One more
 * round, Pause and Resume go at once.
 */
export function usePhonePipelineActs({ ports, acts, onClosed }: {
  ports: PipelinePorts;
  acts: PendingPipelineActs;
  onClosed?: (pipeline: Pipeline) => void;
}) {
  const { t } = useLocale();
  const pending = usePendingPipelineAct(acts);
  const actions = usePipelineActions(ports, phoneShow, t);
  /* The intent the board's ⋯ menu builds: retry and skip carry the stage and
     attempt the operator saw, the lane's other actions carry none. Receipts
     name the lane; a long first line would crowd out what happened. */
  const intent = (pipeline: Pipeline, action: PipelineActionKind, stage: ActStage | null = null): PipelineActionIntent => ({
    pipelineId: pipeline.id,
    title: cleanTitle(pipelineTitle(t, pipeline), 48),
    action,
    stageId: stage?.stageId ?? null,
    stageName: stage?.stageName ?? null,
    expectedAttempt: stage?.expectedAttempt ?? null,
  });
  const closeLane = (pipeline: Pipeline): void => {
    acts.begin({ pipelineId: pipeline.id, action: "close" });
    showReceipt(t("mobile2.pipeline.archived"), { kind: "restore", run: () => acts.cancel() });
    onClosed?.(pipeline);
  };
  const answer = (pipeline: Pipeline, choice: PipelineAnswer): void => {
    if (choice.action === "close") {
      closeLane(pipeline);
      return;
    }
    const act = intent(pipeline, choice.action, choice);
    if (choice.action === "skip-stage") {
      /* Held like a close, and sent through the board's actions when the
         window closes, with the stage and attempt the operator saw. */
      acts.begin({ pipelineId: pipeline.id, action: "skip-stage", send: () => actions.start(act) });
      showReceipt(t("mobile2.pipeline.skipped"), { kind: "retryStage", run: () => acts.cancel() });
      return;
    }
    actions.start(act);
  };
  return {
    /** The act this page sent or holds for the lane, until it is answered. */
    acting: (pipeline: Pipeline): PipelineActionKind | null => actions.acting.get(pipeline.id) ?? (pending?.pipelineId === pipeline.id ? pending.action : null),
    held: (pipeline: Pipeline): boolean => pending?.pipelineId === pipeline.id,
    start: (pipeline: Pipeline, action: PipelineActionKind): void => actions.start(intent(pipeline, action)),
    closeLane,
    answer,
  };
}

/** The heading has scrolled up out of the body: the bar takes the title. */
export function useScrolledAway(target: RefObject<HTMLElement | null>, root: RefObject<HTMLElement | null>): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const element = target.current;
    if (!element || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      setAway(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0));
    }, { root: root.current, threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, root]);
  return away;
}

/** A round's other reviewer transcripts — the same-round rebindings the flow
    still names — that no attempt of the stage already opens. The same
    derivation the desktop's verdict popover lists. */
export function reviewTranscripts(pipeline: Pipeline, stage: PipelineStage, flows: readonly Flow[], files: readonly FileEntry[]): { n: number; path: string }[] {
  const attempts = stageAttempts(pipeline, stage.id);
  const flowIds = new Set(attempts.flatMap((attempt) => attempt.flowId ? [attempt.flowId] : []));
  const attemptPaths = new Set(attempts.flatMap((attempt) => attempt.agentPath ? [attempt.agentPath] : []));
  const seen = new Set<string>();
  return flows
    .filter((flow) => flowIds.has(flow.id))
    .flatMap((flow) => flow.rounds.flatMap((round) => reviewerBindingTargetsForRound(flow, round, files).flatMap(({ path }) => {
      if (attemptPaths.has(path) || seen.has(path)) return [];
      seen.add(path);
      return [{ n: round.n, path }];
    })));
}

export interface MobilePipelineScreenProps {
  pipeline: Pipeline;
  files: readonly FileEntry[];
  flows?: readonly Flow[];
  tasks?: readonly BoardTask[];
  /** Epoch seconds; the dashboard's ticking clock keeps the age honest. */
  now: number;
  host?: MobileShellHost | null;
  renderSheet?: SheetRenderer;
  /** Opening a stage's conversation is the board's own open gesture, so the
      card is stamped seen and ‹ returns here (README §3.3). */
  onOpenConversation: (file: FileEntry) => void;
  onOpenTask?: (task: BoardTask) => void;
  /** The task this screen was pushed from, which Linked tasks leaves out (§3.13). */
  cameFromTask?: string | null;
  /** Test seam: the held-act store. Production reads the tab's singleton. */
  acts?: PendingPipelineActs;
  /** Test seam: the pipeline route. Production reads the browser's. */
  ports?: PipelinePorts;
}

/**
 * One pipeline on the phone, the phone's Stages view (#2072 slice 6,
 * docs/design/phone-kanban.md §3.13; mobile v2 lane 7 before it).
 *
 * The bar says where the lane stands, «needs a decision · stage 1 of 2 · 41m»,
 * and takes the title once the body's heading scrolls away. The body is the
 * one pipeline block at screen density: the title, the PR and issue chips with
 * Attach, the numbered stages with the passed ones folded and the current one
 * expanded, the answer to a decision or a spent review budget inside the
 * stage it is about, and each fail edge in the loop words. Under it the linked
 * tasks and «Past attempts · n», which lists every finished attempt and review
 * round, as the desktop card does.
 *
 * The answers go through the board's own pipeline actions
 * (`usePipelineActions`), so the phone sends the requests the desktop's ⋯
 * menu sends: retry and skip name the stage and attempt the operator saw, and
 * One more round reads the revision first. Skip and Close are held for the
 * receipt's four seconds, whose inverse cancels them (see
 * `createPendingPipelineActs`); Retry and One more round go at once. Pause,
 * Resume and Close lane are the bar's ⋯, which also leads on to the board's
 * menu. Nothing asks for confirmation (README §2 rule 9, Q4).
 *
 * A never-run stage's ⚙ opens its configuration in a sheet, the desktop's own
 * `StagePlaceholderPane` (lane 10).
 */
export function MobilePipelineScreen({
  pipeline,
  files,
  flows = [],
  tasks = [],
  now,
  host,
  renderSheet,
  onOpenConversation,
  onOpenTask,
  cameFromTask = null,
  acts = pendingPipelineActs,
  ports = browserPipelinePorts,
}: MobilePipelineScreenProps) {
  const { t } = useLocale();
  const nav = useMobileNavStore();
  const navState = useMobileNav();
  const links = useWorkLinks().of({ kind: "pipeline", id: pipeline.id });
  const flowsById = useMemo(() => new Map(flows.map((flow) => [flow.id, flow] as const)), [flows]);
  const summary = useMemo(() => summarizePipeline(pipeline, flowsById), [pipeline, flowsById]);
  const names = useMemo(() => stageNames(t, pipeline), [t, pipeline]);
  /* A closed lane has no screen left to stand on: Close lane goes back. */
  const lane = usePhonePipelineActs({ ports, acts, onClosed: () => nav.back() });
  const body = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleAway = useScrolledAway(heading, body);
  /* Back to this pipeline lands where the operator left it (#2105). */
  useMobileScrollMemory(body, { kind: "pipeline", id: pipeline.id });
  const title = pipelineTitle(t, pipeline);
  /* The stage-configuration sheet (lane 10). The nav store says a sheet is
     open (§3.3: one history entry, which Back closes); this says which stage. The pane inside is the desktop's own
     editor, so a change made from the phone is the same `override-stage`
     PATCH the board sends. */
  const [configuring, setConfiguring] = useState<string | null>(null);
  const configStage = navState.sheet === "stage" && configuring
    ? pipeline.stages.find((stage) => stage.id === configuring) ?? null
    : null;
  /* The ⋯ sheet opens on the lane's own actions; its «Board menu» row turns
     it into the board's menu, and closing it resets the face. */
  const [menuFace, setMenuFace] = useState<"pipeline" | "board">("pipeline");
  useEffect(() => {
    if (navState.sheet !== "menu") setMenuFace("pipeline");
  }, [navState.sheet]);

  const held = lane.held(pipeline);
  const acting = lane.acting(pipeline);
  /* A lane hidden from the board's queue (#1671) comes back from its own
     screen; the optimistic record puts it back in the queue on the tap. A lane
     that has parked again since its Hide is in the queue already. */
  const showOnBoard = (): void => {
    void patchPipeline(pipeline.id, "undismiss", undefined, { ...pipeline, dismissedAt: null }).then((fail) => {
      showReceipt(fail ?? t("mobile2.pipeline.shownOnBoard"));
    });
  };
  const dismissed = pipelineHiddenFromBoard(pipeline);
  const stageFile = (stage: PipelineStage): FileEntry | null => resolveStageNavFile(attemptNavTarget(latestAttempt(pipeline, stage.id)), files);
  const stageConversation = (stage: PipelineStage) => {
    const file = stageFile(stage);
    return { openable: Boolean(file), latest: file ? nowFragment(file) : null };
  };
  const openStage = (_pipeline: Pipeline, stage: PipelineStage): void => {
    const file = stageFile(stage);
    if (file) onOpenConversation(file);
  };
  const linked = pipelineLinkedTasks(pipeline, tasks, [...flows], files).filter((task) => task.id !== cameFromTask);

  const sheets: SheetRenderer = (name, close) => {
    if (name === "links") {
      return (
        <MobileSheet name="links" title={t("workLinks.listTitle")} onClose={close}>
          <div data-mobile2-links-sheet={pipeline.id} className="px-3 pb-3 [&_button]:min-h-11 [&_input]:min-h-11">
            <WorkLinksPanel target={{ kind: "pipeline", id: pipeline.id }} resolved={links} />
          </div>
        </MobileSheet>
      );
    }
    if (name === "menu" && menuFace === "pipeline") {
      return (
        <MobileSheet name="menu" title={cleanTitle(title, 90)} onClose={close}>
          <div role="menu" aria-label={cleanTitle(title, 90)} className="flex flex-col" data-mobile2-pipeline-menu={pipeline.id}>
            {mobilePipelineActions(pipeline).map((spec) => {
              const Icon = ACTION_ICON[spec.key];
              return (
                <MobileSheetRow
                  key={spec.key}
                  icon={<Icon className="h-[18px] w-[18px]" aria-hidden />}
                  label={t(`mobile2.pipeline.${spec.key}`)}
                  danger={spec.key === "archive"}
                  disabled={Boolean(acting)}
                  onSelect={() => {
                    close();
                    if (spec.key === "archive") lane.closeLane(pipeline);
                    else lane.start(pipeline, spec.action);
                  }}
                  attrs={{ "data-mobile2-pipeline-action": spec.key, "data-mobile2-pipeline-patch": spec.action }}
                />
              );
            })}
            <MobileSheetDivider />
            <MobileSheetRow
              icon={<Boxes className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.pipeline.boardMenu")}
              trailing={<ChevronRight className="h-4 w-4" aria-hidden />}
              onSelect={() => setMenuFace("board")}
              attrs={{ "data-mobile2-menu-row": "board" }}
            />
          </div>
        </MobileSheet>
      );
    }
    if (name !== "stage") return renderSheet?.(name, close) ?? null;
    if (!configStage) return null;
    const slot: StageSlot = {
      key: `pipeline-config::${pipeline.id}::${configStage.id}`,
      pipeline,
      stage: configStage,
      index: pipeline.stages.indexOf(configStage),
      total: pipeline.stages.length,
      presentation: "placeholder",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    };
    return (
      <MobileSheet name="stage" title={t("mobile2.pipeline.configureTitle", { stage: names.get(configStage.id) ?? configStage.id })} onClose={close}>
        <div data-mobile2-stage-config={configStage.id} className="flex h-[min(620px,72dvh)] min-h-0 flex-col px-3 pb-3 [&_button]:min-h-11 [&_button]:min-w-11">
          <StagePlaceholderPane slot={slot} interactive />
        </div>
      </MobileSheet>
    );
  };

  const barTitle = (
    <span className="flex min-w-0 flex-1 flex-col">
      {titleAway ? <span data-mobile2-title-text className="min-w-0 truncate text-title font-semibold leading-tight text-primary">{title}</span> : null}
      <span data-mobile2-meta className={`min-w-0 ${titleAway ? "overflow-hidden [&_.pb-stateline]:flex-nowrap [&_.pb-stateline]:text-label" : ""}`}>
        <PipelineStateLine summary={summary} nowMs={now * 1000} />
      </span>
    </span>
  );

  return (
    <MobileShell
      screen="pipeline"
      screenId={pipeline.id}
      back
      title={barTitle}
      host={host}
      renderSheet={sheets}
    >
      <div ref={body} data-mobile2-pipeline-body className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden px-3 pb-4 pt-2.5">
        {dismissed ? (
          <button
            type="button"
            data-mobile2-pipeline-action="showOnBoard"
            data-mobile2-pipeline-patch="undismiss"
            disabled={held}
            className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-[8px] bg-card px-3 text-body font-semibold text-secondary shadow-1 active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
            onClick={showOnBoard}
          >
            <Eye className="h-4 w-4 shrink-0" aria-hidden />
            {t("mobile2.pipeline.showOnBoard")}
          </button>
        ) : null}
        <PipelineBlock
          summary={summary}
          density="screen"
          nowMs={now * 1000}
          acting={acting}
          headingRef={heading}
          stageConversation={stageConversation}
          onOpenStage={openStage}
          onConfigureStage={(_pipeline, stage) => {
            setConfiguring(stage.id);
            nav.openSheet("stage");
          }}
          onWorkLinks={() => nav.openSheet("links")}
          onAnswer={lane.answer}
        />
        {linked.length ? (
          <section data-mobile2-section="tasks" className="flex shrink-0 flex-col gap-1.5">
            <h3 className="flex min-h-[30px] items-center gap-1.5 text-ui font-semibold text-secondary">
              {t("mobile2.pipeline.linkedTasks")}
              <span className="text-label font-semibold tabular-nums text-muted">{linked.length}</span>
            </h3>
            {linked.map((task) => {
              const label = task.text.split("\n", 1)[0]?.trim() || task.id;
              const Tag = onOpenTask ? "button" : "div";
              return (
                <Tag
                  key={task.id}
                  {...(onOpenTask ? { type: "button" as const, onClick: () => onOpenTask(task), "aria-label": t("mobile2.pipeline.openTask", { label }) } : {})}
                  data-mobile2-linked-task={task.id}
                  className="flex min-h-11 w-full items-center gap-2.5 rounded-[12px] bg-quiet py-2 pl-3 pr-2.5 text-left ring-1 ring-inset ring-border active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-strong" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-body font-semibold leading-[1.25] text-secondary">{label}</span>
                    <span className="truncate text-label text-muted">{t(`tasks.status.${task.status}`)}</span>
                  </span>
                  {onOpenTask ? <ChevronRight className="h-[18px] w-[18px] shrink-0 text-muted" aria-hidden /> : null}
                </Tag>
              );
            })}
          </section>
        ) : null}
        <PastAttemptsSection pipeline={pipeline} flows={flows} flowsById={flowsById} files={files} names={names} nowMs={now * 1000} onOpenConversation={onOpenConversation} />
      </div>
    </MobileShell>
  );
}

interface PastRow {
  key: string;
  label: string;
  state: string;
  tone: string;
  atMs: number;
  file: FileEntry | null;
}

/**
 * «Past attempts · n» (§3.13), the last thing on the screen: every finished
 * attempt and review round of the lane, newest first, the rows the desktop
 * card's own «Past attempts» lists, then a round's other reviewer transcripts
 * (lane 10). A row whose transcript is in the scan opens it; one that left the
 * scan is a statement. Closed, it is one 44 px row.
 */
function PastAttemptsSection({ pipeline, flows, flowsById, files, names, nowMs, onOpenConversation }: {
  pipeline: Pipeline;
  flows: readonly Flow[];
  flowsById: ReadonlyMap<string, Flow>;
  files: readonly FileEntry[];
  names: ReadonlyMap<string, string>;
  nowMs: number;
  onOpenConversation: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  /* Open or folded as the operator left it when Back returns here (#2105). */
  const [open, setOpen] = useMobileScreenState({ kind: "pipeline", id: pipeline.id }, "past", false);
  const nameOf = (stageId: string) => names.get(stageId) ?? stageId;
  const history = pastAttempts([pipeline], flowsById);
  const listed = new Set(history.flatMap((row) => (row.conversation.path ? [row.conversation.path] : [])));
  const rows: PastRow[] = [
    ...history.map((row) => ({
      key: row.key,
      label: pastAttemptLabel(t, row, nameOf(row.stageId)),
      state: pastAttemptState(t, row),
      tone: pastAttemptTone(row),
      atMs: row.atMs,
      file: resolveStageNavFile({ conversationId: row.conversation.conversationId, agentPath: row.conversation.path }, files),
    })),
    ...pipeline.stages.flatMap((stage) => reviewTranscripts(pipeline, stage, flows, files)
      .filter((transcript) => !listed.has(transcript.path))
      .map((transcript) => ({
        key: `${pipeline.id}:${stage.id}:transcript:${transcript.path}`,
        label: `${nameOf(stage.id)} · ${t("mobile2.pipeline.reviewTranscript", { n: transcript.n })}`,
        state: "",
        tone: "",
        atMs: 0,
        file: files.find((entry) => entry.path === transcript.path) ?? null,
      }))),
  ];
  if (!rows.length) return null;
  const age = (atMs: number) => (atMs ? humanizeDuration(blockAgeSeconds((nowMs - atMs) / 1000)) : "");
  return (
    <section data-mobile2-past={rows.length} className="shrink-0 overflow-hidden rounded-[12px] bg-card shadow-1">
      <button
        type="button"
        aria-expanded={open}
        data-mobile2-past-toggle
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-body font-semibold text-secondary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0 flex-1 truncate">{t("kanban.past.head", { count: rows.length })}</span>
        <ChevronRight className={`h-[18px] w-[18px] shrink-0 text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`} aria-hidden />
      </button>
      {open ? (
        <ul className="flex flex-col">
          {rows.map((row) => {
            const Tag = row.file ? "button" : "div";
            return (
              <li key={row.key} className="border-t border-border">
                <Tag
                  {...(row.file ? { type: "button" as const, onClick: () => onOpenConversation(row.file!), "aria-label": t("kanban.past.openAria", { label: row.label }) } : {})}
                  data-mobile2-past-row={row.key}
                  data-mobile2-go={row.file ? "chat" : undefined}
                  className={`flex min-h-11 w-full items-center gap-2 py-1.5 pl-3 pr-2.5 text-left text-label tabular-nums ${row.file ? "active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40" : ""}`}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="min-w-0 truncate text-ui font-semibold text-primary">{row.label}</span>
                    <span className="min-w-0 truncate text-muted">
                      {row.state ? <span className={row.tone === "ok" ? "text-success" : row.tone === "bad" ? "text-danger" : ""}>{row.state}</span> : null}
                      {row.state && row.atMs ? " · " : ""}
                      {age(row.atMs)}
                      {row.file ? "" : `${row.state || row.atMs ? " · " : ""}${t("kanban.past.none")}`}
                    </span>
                  </span>
                  {row.file ? <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : null}
                </Tag>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
