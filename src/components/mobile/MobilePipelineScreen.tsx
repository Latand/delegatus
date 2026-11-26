"use client";

import { Boxes, Check, CircleX, ClipboardList, Eye, FileDiff, GitMerge, History, Link2, ListChecks, Pause, Play, RotateCcw, SkipForward, Undo2 } from "lucide-react";

import { ChevronLeft, ChevronRight } from "@/components/icons";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";

import { useLocale } from "@/lib/i18n";
import type { ReviewGroup as Flow } from "@/components/flows/reviewGroup";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { formatConversationHash } from "@/lib/accounts/identity";
import { cleanTitle } from "@/lib/title";

import { openReviewHistory } from "../flows/ReviewHistory";
import { reviewerBindingTargetsForRound } from "../flows/flowModel";
import type { ReceiptAction as BoardReceiptAction } from "../kanban/KanbanReceipts";
import { summarizePipeline, workingStageConversations } from "../kanban/kanbanModel";
import { operationalAttempts, pastAttempts } from "../kanban/pipelineGraph";
import { StagesSheet, type SheetPane } from "../kanban/StagesSheet";
import { ReaderPlacement, ReaderPortals, type ReaderView } from "../kanban/KanbanReaders";
import { conversationIdentity } from "@/lib/accounts/identity";
import { pastAttemptLabel, pastAttemptState, pastAttemptTone, pipelineTitle } from "../kanban/PipelineSection";
import { laneState } from "../kanban/cardState";
import { laneAnswerItems, menuAnswers } from "../kanban/laneAnswerMenu";
import { browserPipelinePorts, type PipelinePorts } from "../kanban/pipelinePorts";
import { currentStageId, pipelineActionOptions, shownAttempt, type PipelineActionKind } from "../kanban/stagesModel";
import { usePipelineActions, type PipelineActionIntent } from "../kanban/usePipelineActions";
import {
  attemptNavTarget,
  patchPipeline,
  pipelineLinkedTasks,
  resolveStageNavFile,
  stageAsksOperator,
  stageAttempts,
  stageConfigurable,
  stageNames,
  type StageNavTarget,
} from "../pipelines/pipelineModel";
import { screenCurrentStageId } from "../pipelines/pipelineBlockModel";
import { checkChoiceGroups, checkRowValue, publishingStage, usePipelineChecks, type CheckTerms } from "../pipelines/PipelineCheckSettings";
import { blockAgeSeconds, type PipelineAnswer } from "../pipelines/pipelineBlockModel";
import { StagePlaceholderPane } from "../pipelines/StagePlaceholderPane";
import type { ConversationDrafts } from "../pipelines/conversationDraftClient";
import { conversationDraftLane, DraftStartButton, DraftStartNote } from "../pipelines/DraftStageControls";
import { StageDrafts } from "../kanban/stageDrafts";
import type { StageSlot } from "../scheme/layout";
import { humanizeDuration } from "../turnDuration";
import { pipelineHiddenFromBoard } from "./mobileBoardModel";
import { RECEIPT_MS, showReceipt, type ReceiptTimers } from "./MobileReceipt";
import { WorkLinksPanel } from "@/components/workLinks/WorkLinkChips";
import { LaneReviewPhoneSheet } from "@/components/laneReview/LaneReviewPhoneSheet";
import { useWorkLinks } from "@/components/workLinks/workLinksContext";
import { MobileSheet, MobileSheetDivider, MobileSheetRow } from "./MobileSheet";
import { MobileShell, type MobileShellHost, type SheetRenderer } from "./MobileShell";
import { useMobileNav, useMobileNavStore, useMobileScreenState, useMobileScrollMemory, useSheetSelection } from "./mobileNav";
import { takeRequestedStage } from "./pipelineStageRequest";

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

/** The phone names a lane «lane» (Close lane), so its checks face does too. */
const PHONE_CHECK_TERMS: CheckTerms = { laneHeading: "mobile2.pipeline.checksLane", stageInherit: "mobile2.pipeline.checksStageInherit" };

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
    pipeline,
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

const ANSWER_ICON: Record<PipelineAnswer["action"], typeof Check> = {
  "retry-stage": RotateCcw,
  "skip-stage": SkipForward,
  "continue-review": RotateCcw,
  "accept-head": Check,
  "retry-merge": GitMerge,
  dismiss: Undo2,
  close: CircleX,
};

/**
 * A lane's manual answers on the phone's sheets (docs/design/calm-task-cards-build.md
 * §4.2): the lane sheet of the task screen and the pipeline screen's ⋯. They
 * left the screens' faces; a caption says they are a manual override where
 * the orchestrator owns the lane. Nothing when the lane asks nothing.
 */
export function LaneAnswerRows({ pipeline, acting, onAnswer, close, stopLinks = false }: {
  pipeline: Pipeline;
  /** The screen shows a timeline whose stop entry carries Skip and Retry as links on a lane the seat owns. */
  stopLinks?: boolean;
  acting: PipelineActionKind | null;
  onAnswer: (pipeline: Pipeline, answer: PipelineAnswer) => void;
  close: () => void;
}) {
  const { t } = useLocale();
  const names = stageNames(t, pipeline);
  const owner = laneState(pipeline).owner;
  const all = laneAnswerItems(t, pipeline, owner, (stage) => names.get(stage.id) ?? stage.id);
  const items = stopLinks ? menuAnswers(all, owner) : all;
  if (!items.length) return null;
  return (
    <>
      <MobileSheetDivider />
      {owner === "seat" ? <p data-phone-lane-answers-caption="" className="px-4 pb-0.5 pt-1.5 text-label text-muted">{t("cardState.manualCaption")}</p> : null}
      {items.map((item) => {
        const Icon = ANSWER_ICON[item.action];
        return (
          <MobileSheetRow
            key={item.action}
            icon={<Icon className="h-[18px] w-[18px]" aria-hidden />}
            label={item.label}
            disabled={Boolean(acting)}
            onSelect={() => {
              close();
              onAnswer(pipeline, item);
            }}
            attrs={{ "data-phone-lane-answer": item.action }}
          />
        );
      })}
    </>
  );
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
  /** The first messages being edited, the board's own store; the screen keeps one when absent. */
  drafts?: StageDrafts;
  /** Drafts made from a conversation: Start at the foot of such a draft. */
  conversationDrafts?: ConversationDrafts;
}

/**
 * One pipeline on the phone, the phone's Stages view (#2072 slice 6,
 * docs/design/phone-kanban.md §3.13; mobile v2 lane 7 before it).
 *
 * The bar names the lane, whole. The body is the Stages window of the board
 * (`StagesSheet` at `presentation="screen"`): the line saying whom the lane
 * waits on, the stages as a grid of tabs, the rule lines of the fail edges the
 * tabs do not carry, and under them the selected stage's pane with its
 * conversation. Everything the screen used to list under the stages is a row
 * of the bar's ⋯: Attach a PR or issue, the linked tasks and «Past attempts ·
 * n» (each its own face of the sheet), and Show on board for a hidden lane.
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
  drafts: sharedDrafts,
  conversationDrafts,
}: MobilePipelineScreenProps) {
  const { t } = useLocale();
  const [ownDrafts] = useState(() => (sharedDrafts ? null : new StageDrafts()));
  const drafts = sharedDrafts ?? ownDrafts!;
  /* A draft made from a conversation (variant 3): its stages, then the first
     stage's first message with Edit, then Start at the foot. */
  const fromConversation = Boolean(conversationDrafts) && conversationDraftLane(pipeline);
  const nav = useMobileNavStore();
  const navState = useMobileNav();
  const links = useWorkLinks().of({ kind: "pipeline", id: pipeline.id });
  const flowsById = useMemo(() => new Map(flows.map((flow) => [flow.id, flow] as const)), [flows]);
  /* A settled stage whose conversation works again reads so, as on the board (#1744). */
  const working = useMemo(() => workingStageConversations([pipeline], files, now), [pipeline, files, now]);
  const summary = useMemo(() => summarizePipeline(pipeline, flowsById, working), [pipeline, flowsById, working]);
  const names = useMemo(() => stageNames(t, pipeline), [t, pipeline]);
  /* A closed lane has no screen left to stand on: Close lane goes back. */
  const lane = usePhonePipelineActs({ ports, acts, onClosed: () => nav.back() });
  const body = useRef<HTMLDivElement>(null);
  /* Back to this pipeline lands where the operator left it (#2105). */
  useMobileScrollMemory(body, { kind: "pipeline", id: pipeline.id });
  const title = pipelineTitle(t, pipeline);
  /* The stage-configuration sheet (lane 10). The nav store says a sheet is
     open (§3.3: one history entry, which Back closes); this says which stage. The pane inside is the desktop's own
     editor, so a change made from the phone is the same `override-stage`
     PATCH the board sends. */
  /* A tap on a stage that has not started, on the task screen,
     opens this screen on that stage's sheet. */
  const [configuring, setConfiguring] = useState<string | null>(() => {
    const requestedStage = takeRequestedStage(pipeline.id);
    return requestedStage && stageConfigurable(pipeline, requestedStage) ? requestedStage : null;
  });
  const openedOnStage = useRef(configuring);
  /* The selected tab is the operator's choice, kept per lane; with none the
     lane follows the stage it stands on. */
  const [chosen, setChosen] = useMobileScreenState<string>({ kind: "pipeline", id: pipeline.id }, "tab", "");
  const standing = screenCurrentStageId(summary) ?? currentStageId(pipeline, summary.views);
  const selected = chosen && pipeline.stages.some((stage) => stage.id === chosen) ? chosen : standing;
  useEffect(() => {
    if (openedOnStage.current) {
      setChosen(openedOnStage.current);
      nav.openSheet("stage");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the stage the screen opened on
  }, []);
  const configureStage = (stage: PipelineStage): void => {
    setConfiguring(stage.id);
    nav.openSheet("stage");
  };
  /* Each pane's shown attempt, and the one conversation the selected pane mounts. */
  const [picks, setPicks] = useState<ReadonlyMap<string, number>>(() => new Map());
  const panes = useMemo<SheetPane[]>(() => pipeline.stages.map((stage) => {
    const shown = shownAttempt(pipeline, stage.id, picks.get(stage.id) ?? null);
    const target = shown ? attemptNavTarget(shown) : null;
    const file = target ? resolveStageNavFile(target, files) : null;
    return { stage, attempts: operationalAttempts(pipeline, stage.id), shown, file, readerKey: file && stage.id === selected ? conversationIdentity(file) : null };
  }), [pipeline, picks, files, selected]);
  const [placement] = useState(() => new ReaderPlacement());
  const parkRef = useCallback((park: HTMLDivElement | null) => placement.setPark(park), [placement]);
  const chosenPane = panes.find((pane) => pane.readerKey && pane.file);
  const readers = useMemo<ReaderView[]>(() => (chosenPane?.file && chosenPane.readerKey
    ? [{
      readerKey: chosenPane.readerKey, file: chosenPane.file, inSheet: true, owner: { cardId: pipeline.id, cardTitle: pipelineTitle(t, pipeline), stage: { pipeline, stage: chosenPane.stage } },
      /* A stage that asked a question has its answer typed here: the composer says so. */
      ...(stageAsksOperator(pipeline, chosenPane.stage.id) ? { composerPlaceholder: t("kanban.stages.answerPlaceholder") } : {}),
    }]
    : []), [chosenPane, pipeline, t]);

  const configStage = navState.sheet === "stage" && configuring
    ? pipeline.stages.find((stage) => stage.id === configuring) ?? null
    : null;
  useSheetSelection("stage", configStage !== null);
  /* The ⋯ sheet opens on the lane's own actions; its «Board menu» row turns
     it into the board's menu, and closing it resets the face. */
  const [menuFace, setMenuFace] = useState<"pipeline" | "board" | "checks" | "tasks" | "past">("pipeline");
  useEffect(() => {
    if (navState.sheet !== "menu") setMenuFace("pipeline");
  }, [navState.sheet]);
  /* Where the lane's checks run, read each time the ⋯ sheet opens: its
     «Checks» row opens the same choices the board's ⋯ menu offers. */
  const checkStage = publishingStage(pipeline);
  const checks = usePipelineChecks(pipeline.id, checkStage, navState.sheet === "menu");

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
  const openAttempt = (target: StageNavTarget): void => {
    const file = resolveStageNavFile(target, files);
    if (file) onOpenConversation(file);
    else window.location.hash = formatConversationHash({ conversationId: target.conversationId ?? undefined, path: target.agentPath ?? "" });
  };
  const linked = pipelineLinkedTasks(pipeline, tasks, [...flows], files).filter((task) => task.id !== cameFromTask);
  const past = usePastRows(pipeline, flows, flowsById, files, names, t);

  const sheets: SheetRenderer = (name, close) => {
    if (name === "changes") return <LaneReviewPhoneSheet pipelineId={pipeline.id} onClose={close} />;
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
            {dismissed ? (
              <MobileSheetRow
                icon={<Eye className="h-[18px] w-[18px]" aria-hidden />}
                label={t("mobile2.pipeline.showOnBoard")}
                disabled={held}
                onSelect={() => {
                  close();
                  showOnBoard();
                }}
                attrs={{ "data-mobile2-pipeline-action": "showOnBoard", "data-mobile2-pipeline-patch": "undismiss" }}
              />
            ) : null}
            <LaneAnswerRows pipeline={pipeline} acting={acting} onAnswer={lane.answer} close={close} />
            {/* The lane's changed files, read-only on the phone (docs/design/lane-diff-comments.md §7). */}
            <MobileSheetRow
              icon={<FileDiff className="h-[18px] w-[18px]" aria-hidden />}
              label={t("laneReview.phoneRow")}
              onSelect={() => nav.openSheet("changes")}
              attrs={{ "data-mobile2-menu-row": "changes" }}
            />
            <MobileSheetDivider />
            <MobileSheetRow
              icon={<ListChecks className="h-[18px] w-[18px]" aria-hidden />}
              label={t("pipelineStrip.checks")}
              ariaLabel={t("pipelineStrip.checksAria", { value: checkRowValue(t, checks.read) })}
              disabled={checks.read.kind === "loading"}
              trailing={<>
                <span className={`text-caption font-semibold ${checks.read.kind === "failed" ? "text-accent" : "text-muted"}`}>{checkRowValue(t, checks.read)}</span>
                {checks.read.kind === "ready" ? <ChevronRight className="h-4 w-4" aria-hidden /> : null}
              </>}
              onSelect={() => {
                if (checks.read.kind === "failed") checks.reload();
                else if (checks.read.kind === "ready") setMenuFace("checks");
              }}
              attrs={{ "data-mobile2-menu-row": "checks", "data-pipeline-checks-row": checks.read.kind }}
            />
            {checks.read.kind === "failed" ? <p role="alert" data-pipeline-checks-error="load" className="px-4 pb-1 text-label font-semibold text-danger">{t("pipelineStrip.checksLoadFailed")}</p> : null}
            <MobileSheetRow
              icon={<Boxes className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.pipeline.boardMenu")}
              trailing={<ChevronRight className="h-4 w-4" aria-hidden />}
              onSelect={() => setMenuFace("board")}
              attrs={{ "data-mobile2-menu-row": "board" }}
            />
            <MobileSheetDivider />
            <MobileSheetRow
              icon={<Link2 className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.pipeline.attachLink")}
              onSelect={() => nav.openSheet("links")}
              attrs={{ "data-mobile2-menu-row": "links" }}
            />
            {linked.length ? (
              <MobileSheetRow
                icon={<ClipboardList className="h-[18px] w-[18px]" aria-hidden />}
                label={t("mobile2.pipeline.linkedTasks")}
                trailing={<><span className="text-caption font-semibold tabular-nums text-muted">{linked.length}</span><ChevronRight className="h-4 w-4" aria-hidden /></>}
                onSelect={() => setMenuFace("tasks")}
                attrs={{ "data-mobile2-menu-row": "tasks" }}
              />
            ) : null}
            {past.length ? (
              <MobileSheetRow
                icon={<History className="h-[18px] w-[18px]" aria-hidden />}
                label={t("kanban.past.head", { count: past.length })}
                trailing={<ChevronRight className="h-4 w-4" aria-hidden />}
                onSelect={() => setMenuFace("past")}
                attrs={{ "data-mobile2-menu-row": "past" }}
              />
            ) : null}
            <p data-mobile2-stage-caption="" className="px-4 pb-2 pt-1.5 text-label text-muted">{t("mobile2.pipeline.stageCaption")}</p>
          </div>
        </MobileSheet>
      );
    }
    if (name === "menu" && menuFace === "tasks") {
      return (
        <MobileSheet name="menu" title={t("mobile2.pipeline.linkedTasks")} onClose={close}>
          <div role="menu" aria-label={t("mobile2.pipeline.linkedTasks")} className="flex flex-col" data-mobile2-pipeline-tasks={pipeline.id}>
            <MobileSheetRow
              icon={<ChevronLeft className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.pipeline.checksBack")}
              onSelect={() => setMenuFace("pipeline")}
              attrs={{ "data-mobile2-menu-row": "back" }}
            />
            <MobileSheetDivider />
            {linked.map((task) => {
              const label = task.text.split("\n", 1)[0]?.trim() || task.id;
              return (
                <MobileSheetRow
                  key={task.id}
                  label={label}
                  ariaLabel={onOpenTask ? t("mobile2.pipeline.openTask", { label }) : undefined}
                  trailing={<span className="text-caption text-muted">{t(`tasks.status.${task.status}`)}</span>}
                  disabled={!onOpenTask}
                  onSelect={() => {
                    close();
                    onOpenTask?.(task);
                  }}
                  attrs={{ "data-mobile2-linked-task": task.id }}
                />
              );
            })}
          </div>
        </MobileSheet>
      );
    }
    if (name === "menu" && menuFace === "past") {
      return (
        <MobileSheet name="menu" title={t("kanban.past.head", { count: past.length })} onClose={close}>
          <div role="menu" aria-label={t("kanban.past.head", { count: past.length })} className="flex flex-col" data-mobile2-past={past.length}>
            <MobileSheetRow
              icon={<ChevronLeft className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.pipeline.checksBack")}
              onSelect={() => setMenuFace("pipeline")}
              attrs={{ "data-mobile2-menu-row": "back" }}
            />
            <MobileSheetDivider />
            <PastRowsList rows={past} nowMs={now * 1000} onOpenConversation={(file) => { close(); onOpenConversation(file); }} />
          </div>
        </MobileSheet>
      );
    }
    if (name === "menu" && menuFace === "checks") {
      return (
        <MobileSheet name="menu" title={t("pipelineStrip.checks")} onClose={close}>
          <div role="menu" aria-label={t("pipelineStrip.checks")} className="flex flex-col" data-mobile2-pipeline-checks={pipeline.id}>
            <MobileSheetRow
              icon={<ChevronLeft className="h-[18px] w-[18px]" aria-hidden />}
              label={t("mobile2.pipeline.checksBack")}
              onSelect={() => setMenuFace("pipeline")}
              attrs={{ "data-mobile2-menu-row": "back", "data-pipeline-checks-back": "" }}
            />
            {checks.read.kind === "ready" ? checkChoiceGroups(t, PHONE_CHECK_TERMS, checks.read.settings, checkStage ? names.get(checkStage) ?? checkStage : null).map((group) => (
              <div key={group.scope} role="group" aria-labelledby={`phone-checks-${pipeline.id}-${group.scope}`} data-pipeline-checks-group={group.scope}>
                <MobileSheetDivider />
                <p id={`phone-checks-${pipeline.id}-${group.scope}`} className="truncate px-4 pb-0.5 pt-1.5 text-label font-semibold text-secondary">{group.heading}</p>
                {group.choices.map((choice) => (
                  <MobileSheetRow
                    key={choice.key}
                    label={choice.label}
                    checked={choice.checked}
                    disabled={checks.saving}
                    trailing={choice.checked ? <Check className="h-4 w-4 text-accent" aria-hidden /> : null}
                    onSelect={() => { if (!choice.checked) void checks.save(group.scope, choice.execution); }}
                    attrs={{ "data-pipeline-checks-choice": `${group.scope}:${choice.key}` }}
                  />
                ))}
              </div>
            )) : null}
            {checks.read.kind === "failed" ? <p role="alert" data-pipeline-checks-error="load" className="px-4 py-1 text-label font-semibold text-danger">{t("pipelineStrip.checksLoadFailed")}</p> : null}
            {checks.saveFailed ? <p role="alert" data-pipeline-checks-error="save" className="px-4 py-1 text-label font-semibold text-danger">{t("pipelineStrip.checksSaveFailed")}</p> : null}
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
      <MobileSheet name="stage" title={t(stageConfigurable(pipeline, configStage.id) ? "mobile2.pipeline.configureTitle" : "mobile2.pipeline.stageMenu", { stage: names.get(configStage.id) ?? configStage.id })} onClose={close}>
        <div data-mobile2-stage-config={configStage.id} className="flex flex-col px-3 pb-3 [&_button]:min-h-11 [&_button]:min-w-11">
          {stageConfigurable(pipeline, configStage.id) ? <StagePlaceholderPane slot={slot} interactive flow /> : null}
          <StageActRows pipeline={pipeline} stage={configStage} names={names} acting={acting} onAnswer={lane.answer} close={close} />
        </div>
      </MobileSheet>
    );
  };

  /* The bar names the lane, whole: the title wraps to a second line rather than end in an ellipsis. */
  const barTitle = (
    <span className="flex min-w-0 flex-1 flex-col">
      <span data-mobile2-title-text className="line-clamp-2 min-w-0 break-words text-ui font-semibold leading-tight text-primary">{title}</span>
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
      dock={fromConversation && conversationDrafts ? (
        <div data-phone-draft-start-foot={pipeline.id} className="flex flex-col gap-1">
          <DraftStartNote pipeline={pipeline} store={conversationDrafts} drafts={drafts} ports={ports} variant="phone" />
          <DraftStartButton pipeline={pipeline} title={title} store={conversationDrafts} drafts={drafts} ports={ports} variant="phone" />
        </div>
      ) : undefined}
    >
      <div ref={body} data-mobile2-pipeline-body className="kb flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-4 pt-1">
        <StagesSheet
          presentation="screen"
          title={title}
          summary={summary}
          panes={panes}
          flowsById={flowsById}
          selected={selected}
          onSelect={setChosen}
          nowMs={now * 1000}
          windowReader={null}
          placement={placement}
          drafts={drafts}
          ports={ports}
          addStageVariant="phone"
          fromConversation={fromConversation}
          onChooseAttempt={(stageId, n) => setPicks((current) => new Map(current).set(stageId, n))}
          onStageMenu={(stage) => configureStage(stage)}
          onAnswer={lane.answer}
          acting={Boolean(acting)}
          onOpenRecorded={(target) => openAttempt({ conversationId: target.conversationId, agentPath: target.path })}
          onLeaveWindow={() => {}}
          onClose={() => {}}
        />
        <div className="reader-park" aria-hidden="true" ref={parkRef} />
        <ReaderPortals placement={placement} readers={readers} now={now} onClose={() => {}} onLeave={() => {}} onMenu={() => {}} />
      </div>
    </MobileShell>
  );
}

interface PastRow {
  archive?: { id: string; round?: number };
  key: string;
  label: string;
  state: string;
  tone: string;
  atMs: number;
  file: FileEntry | null;
}

/**
 * «Past attempts · n» (§3.13): every finished attempt and review round of the
 * lane, newest first, the rows the desktop card's own «Past attempts» lists,
 * then a round's other reviewer transcripts (lane 10). A row whose transcript
 * is in the scan opens it; one that left the scan is a statement.
 */
function usePastRows(pipeline: Pipeline, flows: readonly Flow[], flowsById: ReadonlyMap<string, Flow>, files: readonly FileEntry[], names: ReadonlyMap<string, string>, t: ReturnType<typeof useLocale>["t"]): PastRow[] {
  return useMemo(() => {
    const nameOf = (stageId: string) => names.get(stageId) ?? stageId;
    const history = pastAttempts([pipeline], flowsById);
    const archiveByStage = new Map<string, Map<number, string>>();
    for (const run of pipeline.runs) {
      const byAttempt = new Map<number, string>();
      for (const attempt of run.attempts) if (attempt.flowId) byAttempt.set(attempt.n, attempt.flowId);
      archiveByStage.set(run.stageId, byAttempt);
    }
    const listed = new Set(history.flatMap((row) => (row.conversation.path ? [row.conversation.path] : [])));
    return [
      ...history.map((row) => {
        const archiveAttempt = row.kind === "round" ? row.attempt : row.kind === "attempt" ? row.n : null;
        const archiveId = archiveAttempt != null ? archiveByStage.get(row.stageId)?.get(archiveAttempt) : null;
        return {
          archive: archiveId && (row.kind === "round" || !flowsById.has(archiveId))
            ? { id: archiveId, round: row.kind === "round" ? row.n : undefined } : undefined,
          key: row.key,
          label: pastAttemptLabel(t, row, nameOf(row.stageId)),
          state: pastAttemptState(t, row),
          tone: pastAttemptTone(row),
          atMs: row.atMs,
          file: resolveStageNavFile({ conversationId: row.conversation.conversationId, agentPath: row.conversation.path }, files),
        };
      }),
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
  }, [pipeline, flows, flowsById, files, names, t]);
}

function PastRowsList({ rows, nowMs, onOpenConversation }: { rows: readonly PastRow[]; nowMs: number; onOpenConversation: (file: FileEntry) => void }) {
  const { t } = useLocale();
  const age = (atMs: number) => (atMs ? humanizeDuration(blockAgeSeconds((nowMs - atMs) / 1000)) : "");
  return (
    <ul className="flex flex-col">
      {rows.map((row) => {
        const canOpen = Boolean(row.file || row.archive);
        const Tag = canOpen ? "button" : "div";
        return (
          <li key={row.key} className="flex items-stretch border-t border-border">
            <Tag
              {...(canOpen ? { type: "button" as const, onClick: () => {
                if (row.file) onOpenConversation(row.file);
                else if (row.archive) openReviewHistory(row.archive.id, row.archive.round);
              }, "aria-label": row.file ? t("kanban.past.openAria", { label: row.label }) : `${t("reviewHistory.open")} · ${row.label}` } : {})}
              data-mobile2-past-row={row.key}
              data-mobile2-go={row.file ? "chat" : row.archive ? "review-history" : undefined}
              data-mobile2-review-history={!row.file ? row.archive?.id : undefined}
              data-review-round={!row.file ? row.archive?.round : undefined}
              className={`flex min-h-11 min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 pr-2.5 text-left text-label tabular-nums ${canOpen ? "active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40" : ""}`}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="min-w-0 break-words text-ui font-semibold text-primary">{row.label}</span>
                <span className="min-w-0 break-words text-muted">
                  {row.state ? <span className={row.tone === "ok" ? "text-success" : row.tone === "bad" ? "text-danger" : ""}>{row.state}</span> : null}
                  {row.state && row.atMs ? " · " : ""}
                  {age(row.atMs)}
                  {row.file ? "" : `${row.state || row.atMs ? " · " : ""}${t("kanban.past.none")}`}
                </span>
              </span>
              {row.file ? <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : null}
            </Tag>
            {row.archive && row.file ? <button type="button" data-mobile2-review-history={row.archive.id} data-review-round={row.archive.round}
              aria-label={`${t("reviewHistory.open")} · ${row.label}`}
              className="min-h-11 min-w-11 shrink-0 px-2 text-ui font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
              onClick={() => openReviewHistory(row.archive!.id, row.archive!.round)}>{t("reviewHistory.open")}</button> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Retry and Skip for the stage a pane's ⋯ opened, under the refusals the board's pane menu gives them: they act on the stage the lane waits on. */
function StageActRows({ pipeline, stage, names, acting, onAnswer, close }: {
  pipeline: Pipeline;
  stage: PipelineStage;
  names: ReadonlyMap<string, string>;
  acting: PipelineActionKind | null;
  onAnswer: (pipeline: Pipeline, answer: PipelineAnswer) => void;
  close: () => void;
}) {
  const { t } = useLocale();
  const options = pipelineActionOptions(pipeline);
  const rows = (["retry-stage", "skip-stage"] as const).flatMap((action) => {
    const option = options.find((entry) => entry.action === action);
    if (!option) return [];
    const refused = Boolean(option.refusal) || option.stageId !== stage.id;
    return [{ action, option, refused }];
  });
  if (!rows.length) return null;
  return (
    <div role="menu" className="flex flex-col" data-mobile2-stage-acts={stage.id}>
      {rows.map(({ action, option, refused }) => {
        const Icon = ANSWER_ICON[action];
        return (
          <MobileSheetRow
            key={action}
            icon={<Icon className="h-[18px] w-[18px]" aria-hidden />}
            label={t(action === "retry-stage" ? "kanban.stages.retryThis" : "kanban.stages.skipThis")}
            disabled={refused || Boolean(acting)}
            onSelect={() => {
              close();
              onAnswer(pipeline, { action, stageId: stage.id, stageName: names.get(stage.id) ?? stage.id, expectedAttempt: option.attempt });
            }}
            attrs={{ "data-mobile2-stage-act": action, "data-refused": refused ? "" : undefined }}
          />
        );
      })}
    </div>
  );
}
