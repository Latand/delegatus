"use client";

import { ListPlus, Maximize2, MessageSquarePlus, Minimize2, Pin } from "lucide-react";
import { Component, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";

import { selectionInOrder, viewBus } from "@/hooks/viewPresenceBus";
import { conversationIdentity, formatConversationHash } from "@/lib/accounts/identity";
import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import { isCurrentSeatConversation, type SeatRefs } from "@/lib/tasks/groupHide";
import { suggestTaskIcon } from "@/lib/tasks/taskIconSuggest";
import { TASK_PRIORITIES, type BoardTask, type TaskColor, type TaskPriority, type TaskStatus, type TaskHold } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { MAX_VISIBLE_PATHS } from "@/lib/view/types";
import { latestAttempt, pipelineStateLabel, stagePromptExtra } from "@/components/pipelines/pipelineModel";
import type { PipelineAnswer } from "@/components/pipelines/pipelineBlockModel";
import { finishesTaskOffer, toggleFinishesTask } from "@/components/pipelines/finishesTask";
import type { BranchGroup } from "@/components/projectModel";
import type { SchemeLayout } from "@/components/scheme/layout";
import { updateTask } from "@/components/tasks/taskApi";
import { TaskIcon } from "@/components/tasks/TaskIcon";
import { TaskIconPicker } from "@/components/tasks/TaskIconPicker";
import { sendDismissal } from "@/components/attention/dismissalOverlay";
import { focusHandoffBus } from "@/components/attention/focusHandoffBus";
import { isCardHandle, startCardGesture } from "./cardDrag";
import { kanbanColumnTracks, kanbanLayoutMode, kanbanLayoutModeBeside, type KanbanLayoutMode } from "./kanbanLayout";
import { KanbanColumnsSkeleton } from "@/components/skeletons";
import { reachLineText, useServerReach } from "@/hooks/serverReach";
import { useKanbanSeat } from "./kanbanSeatStore";
import { useKanbanWide, type KanbanWideState } from "./kanbanWideStore";
import { changeColumnWidth, COLUMN_LAYOUT_END } from "./columnLayoutAnimation";
import { DWELL_CUE_MS, useColumnDwell } from "./useColumnDwell";
import { cleanTitle } from "@/components/utils";
import { canHandoff } from "@/components/HandoffHandle";

import { AccountChoiceContext, ConversationAccountPopover, StageAccountPopover, useAccountChoices, type AccountTarget } from "./AccountPicker";
import { BAR_WIDE_MIN, BarCreateGroup, BarIslandSlot, useBoardPaneRef } from "@/components/ProjectBar";
import { HiddenTray } from "./HiddenTray";
import { KanbanDraftContext, KanbanTaskComposer, type KanbanDraftActions } from "./KanbanDrafts";
import type { CardEditField } from "./CardInlineText";
import { KanbanCard, resurfaceText, statusLabel, TASK_COLOR_HEX } from "./KanbanCard";
import { RemoteAgents, type RemoteAgentView } from "./RemoteAgents";
import { remoteCardsFor, useRemoteFeed, type RemoteCard } from "./remoteFeed";
import { MoreGlyph } from "./kanbanGlyphs";
import { buildKanbanModel, holdsOnlyDrafts, KANBAN_STATUSES, taskReasonFiltersOfCard, type KanbanCard as KanbanCardModel, type KanbanModel, type TaskReasonFilter } from "./kanbanModel";
import { reuseKanbanModel } from "./reuseKanbanModel";
import { useStableCallback } from "./useStableCallback";
import { BoardMenu } from "./compactMenu";
import { KanbanPopover, useOverlay, type KanbanMenuItem } from "./kanbanMenus";
import { WorkLinksPanel } from "@/components/workLinks/WorkLinkChips";
import { useWorkLinks, type WorkLinkTarget } from "@/components/workLinks/workLinksContext";
import { KanbanReceipts, useReceipts } from "./KanbanReceipts";
import { cardDismissal } from "./cardDismissal";
import { drawnTasks, useTaskMutations, type FieldEditOutcome, type StatusMoveOutcome, type TaskMutationPorts } from "./useTaskMutations";
import { assignmentRefFor, browserAssignmentPorts, dismissUnstartedLaunch, dismissUnstartedLaunches, type AssignmentPorts } from "./kanbanAssignments";
import { SeatActionWires } from "./SeatActionWires";
import { allCards, cardAnchors, cardOnScreen, conversationOwners, cssEscape, kanbanFocusIndex, readerArrived, readerShown } from "./kanbanFocus";
import { closeReader, followPaths, openReader, ReaderMemory, type OpenReader } from "./readerMemory";
import { ReaderPlacement, ReaderPortals, ReaderSlot, StopHostConfirm, type ReaderOwner, type ReaderStop, type ReaderView } from "./KanbanReaders";
import { stagePanelKey } from "./KanbanCard";
import { isLaunchedConversation, LAUNCH_HOLD_MS, launchClockMs } from "../launchedConversations";
import { cycleOpenAgent, openAgents } from "./openAgents";
import { AgentWindow, OPEN_AGENTS_SHORTCUT, OpenAgentsPill } from "./AgentWindow";
import { AgentWindowOpener } from "./agentWindowOpener";
import { readerReady, useAgentWindowGeometry, useReaderReady } from "./agentWindowGeometry";
import { operationalAttempts } from "./pipelineGraph";
import { browserPipelinePorts, type PipelinePorts } from "./pipelinePorts";
import { pipelineTitle, stageNames } from "./PipelineSection";
import { stageDraftKey, StageDrafts } from "./stageDrafts";
import { StagesSheet, type SheetPane } from "./StagesSheet";
import { clipTitle, textField, withField } from "./taskText";
import { BoardHistory, type HistoryEntry } from "./boardHistory";
import { currentStageId, draftOutcome, pipelineActionOptions, shownAttempt, stageDraftable, stageNotStarted, type PipelineActionOption } from "./stagesModel";
import { usePipelineActions } from "./usePipelineActions";
import { useBands } from "./useBands";

/**
 * The desktop kanban board (#1695 K2): the approved prototype's columns and
 * cards over the project's complete task inventory.
 *
 * Cards come from the same band projection the scheme board draws
 * (`useBands`: `buildSchemeLayout` → `buildTaskBands`, same inputs, and the
 * phone's columns read it too), so identity and
 * grouping never differ between the two boards while both exist. Status moves
 * are optimistic and revision-guarded (`useTaskMutations`); every other write
 * this slice offers goes through an existing route.
 *
 * K4b: a card's title, description and colour are edited in place, and a task
 * group is hidden with `×`, its menu, `H` or a column's bulk hide, each with
 * one Undo. All of them ride the same guarded queue. The Hidden tray lists
 * every group, empty task and closed conversation the board is not drawing,
 * and a hidden group that needs the operator again comes back with its reason.
 */

export { kanbanColumnTracks, kanbanLayoutMode, kanbanLayoutModeBeside, type KanbanLayoutMode } from "./kanbanLayout";

/**
 * Cross-project mode (#1820). Present ⇒ this board's columns carry the cards
 * of EVERY project it was fed, not one: the task projection is no longer
 * fenced to a single project, each card names its own and opens that
 * project's board, only the cards `keep` admits are shown, and the surfaces
 * that need one project to write into — «+ Task», «+ Agent», the orchestrator
 * seat, drafts — are simply not offered. Everything else, including a status
 * move (it already writes with the task's own `expectedProject`), is the
 * board a project renders.
 */
export interface KanbanOverviewScope {
  /** Display name per project key, for the label each card carries. */
  names: Readonly<Record<string, string>>;
  /** The card's label opens that project's own board. */
  onOpenProject: (project: string) => void;
  /** The cards the Overview keeps. Applied exactly where search is applied,
      so a rejected card leaves the columns and no count. */
  keep: (card: KanbanCardModel) => boolean;
}

export interface KanbanBoardProps {
  /** The board's project. Its identity too: the reader memory, the focus
      index and the loose reader key on it. The Overview passes the rail's
      own `__overview__` key and `overview` below. */
  project: string;
  /** Cross-project Overview (#1820); absent on a project's own board. */
  overview?: KanbanOverviewScope | null;
  groups: BranchGroup[];
  manual: FileEntry[];
  files: FileEntry[];
  flows: Flow[];
  reviewGroups?: Flow[];
  pipelines: Pipeline[];
  surfacePipelines?: Pipeline[];
  /** Placed tasks, for the layout pass exactly as the scheme receives them. */
  tasks: readonly BoardTask[];
  /** Every stored task of the project. */
  allTasks: readonly BoardTask[];
  drafts: string[];
  favorites?: ReadonlySet<string>;
  isolatedManualPaths?: ReadonlySet<string>;
  draftBands?: ReadonlyMap<string, string>;
  /** Board clock, epoch seconds. */
  now: number;
  loaded: boolean;
  /** The files drawn are a restored answer being confirmed (#2071): the bar
      says «updating…» beside the count. */
  updating?: boolean;
  catalogFailures: number;
  selection: ReadonlySet<string>;
  /** The Board / Conversations switch, given whether the bar is wide enough for labels. */
  viewSwitch?: ReactNode | ((wide: boolean) => ReactNode);
  /** The bar's first group (the project's name and accounts), given the bar's tier (#1801). */
  barLead?: (wide: boolean) => ReactNode;
  /** The bar's last groups (the panel toggles and the ⋯ menu), given the bar's tier (#1801). */
  barTrail?: (wide: boolean) => ReactNode;
  /** A panel beside the board and under the bar (the project's Tasks panel), so the bar spans it
      and the attention island lands over the bar instead of the panel's own header (#1801). */
  aside?: ReactNode;
  /** The orchestrator seat above the columns (#1695 K3), given the id of the
      board region its skip link lands on. */
  seat?: (boardId: string) => ReactNode;
  /** A conversation or task the Viewer was asked to open while this board
      shows: its card is revealed, and a conversation opens as a reader. */
  focus?: string | null;
  /** Which request `focus` answers. The Viewer keeps `focus` for a while
      after the open, so a second request for the same conversation (a link
      followed again) names the same path, and only this tells them apart. */
  focusNonce?: number;
  /** A reader opened: the same seen-stamp opening a conversation leaves. */
  onConversationOpened?: (path: string) => void;
  /** Conversations, the project's every conversation: for what no card draws (review decks, collapsed workers)
      and conversations this board's files do not carry. */
  onOpenConversations: () => void;
  /** «+ Agent» in the bar: a draft on a card of its own, a task in the making (K9a). */
  onNewAgent?: () => void;
  /** «+ Agent» on a card: a draft in that card, seeded with its task's text. */
  onAddAgent?: (band: { id: string; task: BoardTask | null; title: string }) => void;
  /** A draft closed from its pane. */
  onDraftClose?: (id: string) => void;
  /** A draft's launch started its conversation. */
  onDraftSpawned?: (id: string, file: FileEntry) => void;
  /** Hand a conversation to a new agent: a draft on the card that holds it. */
  onHandoff?: (file: FileEntry, cardId: string | null) => void;
  /** Retry a failed launch from its conversation's feed: a draft prefilled from the launch. */
  onSpawnRetry?: (file: FileEntry) => void;
  /** Take a conversation off the board (the `hidden` board preference); Hidden lists it with Restore. */
  onCloseConversation?: (file: FileEntry) => void;
  /** Conversations closed on this project's board (the `hidden` board
      preference); the Hidden tray lists the ones this board carries. */
  closedPaths?: readonly string[];
  /** Restore a closed conversation to the board. */
  onRestoreConversation?: (file: FileEntry) => void;
  /** The paths of the conversations open as readers on this board. An open
      reader is the operator's own act: the page keeps its conversation in its
      card when its work finishes, until the reader is closed. */
  onReadersChange?: (paths: readonly string[]) => void;
  /** The project's checkout, carried into the seat the board draws. */
  projectCwd?: string;
  /** The project's seat as its owner read it: every conversation the seat
      record names, or null while that is unknown. Required, because the board
      does not read the seat itself — the page that owns the Tasks panel does
      (#1841), and a second reader here would poll the same route twice. */
  seatRefs: SeatRefs | null;
  mutationPorts?: TaskMutationPorts;
  assignmentPorts?: AssignmentPorts;
  /** Where open readers are remembered; this browser's storage by default. */
  /** Shared geometry from the dashboard; standalone consumers derive it here. */
  layout?: SchemeLayout;
  readerStorage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** The pipeline routes; the browser's own by default. */
  pipelinePorts?: PipelinePorts;
}

/** A waiting stage open on a card: its first message, before it has a conversation. */
interface StagePanel {
  cardId: string;
  pipelineId: string;
  stageId: string;
  folded: boolean;
}

/** The Stages sheet: which card's pipeline, the stage it opened on, and what to hand focus back to. */
interface SheetTarget {
  cardId: string;
  pipelineId: string;
  focus: string | null;
  opener: HTMLElement | null;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const NO_READERS: readonly OpenReader[] = [];
const NO_REMOTE_AGENTS: readonly RemoteAgentView[] = [];
const NO_REMOTE_FOR_CARD: readonly RemoteAgentView[] = [];
/** Parts of the board's root that belong to the Viewer, where the board answers no key. */
/** Least space the full attention chip leaves the bar's ⋯ menu before it drops its label. */
const CHIP_CLEARANCE = 8;
const VIEWER_OWNED = ".kb-aside, [data-bar-group=\"where\"], [data-bar-group=\"trail\"], [data-bar-island-slot]";
const NO_CREATED: ReadonlyArray<{ task: BoardTask; basis: readonly BoardTask[] }> = [];

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether search leaves this card on the board. */
function cardMatchesShown(model: KanbanModel, card: KanbanCardModel): boolean {
  return model.columns[card.status].shown.some((shown) => shown.id === card.id) || model.unlinkedShown.some((shown) => shown.id === card.id);
}

type EditField = CardEditField;

function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V | undefined): ReadonlyMap<string, V> {
  if (value === undefined && !map.has(key)) return map;
  const next = new Map(map);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
}

const NO_EDITS: ReadonlyMap<string, never> = new Map<string, never>();

type HistoryDirection = "undo" | "redo";

/** A write's answer as a promise the history can wait on before it is known. */
function settles(): { promise: Promise<boolean>; resolve: (saved: boolean) => void } {
  let resolve!: (saved: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Presence measurement cadence while the operator is scrolling (#1546). The
    scan reads every card's rect, so it runs at most this often during a gesture
    and once more after it settles; presence is exact at rest and at worst one
    window behind while the board is moving. */
const SCROLL_MEASURE_MS = 100;
const SCROLL_SETTLE_MS = 120;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* Whether the operator's last input on the page was a key. The reader given
   the keyboard after a click, or by a link nobody pressed a key for, shows no
   focus ring. Watched for the page, so a board that mounts again still knows;
   an event a script dispatched is nobody's input. */
let keyedLast = false;
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (event) => { if (event.isTrusted) keyedLast = true; }, true);
  document.addEventListener("pointerdown", (event) => { if (event.isTrusted) keyedLast = false; }, true);
}

export function KanbanBoard(props: KanbanBoardProps) {
  const { t, locale } = useLocale();
  const { project, allTasks: storedTasks, pipelines, files, loaded, catalogFailures, selection, onOpenConversations, onConversationOpened } = props;
  const workLinks = useWorkLinks();
  const boardPaneRef = useBoardPaneRef();
  /* The bar's word on the server (#2071 D7): a reconnect in progress is a
     quiet note, a long outage the red alert it always was. */
  const reach = useServerReach();
  const reachStatus = reach.kind === "reconnecting"
    ? <span className="bar-note" data-bar-reach="reconnecting">{reachLineText(t, locale, reach)}</span>
    : catalogFailures > 0 ? <span className="bar-alert" role="alert">{t("kanban.filesFailed")}</span> : null;
  /* `+ Task` (K9a): a task this board created is drawn at once, on the tasks it was created against. The next
     tasks payload is the authority: it carries the task, or the task is gone (deleted, moved to another project)
     and so is its card. */
  const [createdTasks, setCreatedTasks] = useState<ReadonlyArray<{ task: BoardTask; basis: readonly BoardTask[] }>>(NO_CREATED);
  const allTasks = useMemo(() => {
    const fresh = createdTasks
      .filter((entry) => entry.basis === storedTasks && entry.task.project === project && !storedTasks.some((stored) => stored.id === entry.task.id))
      .map((entry) => entry.task);
    return fresh.length ? [...storedTasks, ...fresh] : storedTasks;
  }, [createdTasks, storedTasks, project]);
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- a newer payload retires what was drawn ahead of it */
    setCreatedTasks((current) => (current.some((entry) => entry.basis !== storedTasks) ? current.filter((entry) => entry.basis === storedTasks) : current));
  }, [storedTasks]);
  const storedTasksRef = useRef(storedTasks);
  storedTasksRef.current = storedTasks;
  const [composingTask, setComposingTask] = useState(false);
  const assignments = props.assignmentPorts ?? browserAssignmentPorts;
  const boardId = `kb-board-${useId().replace(/:/g, "")}`;
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let held: HTMLElement | null = null;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      clearTimeout(releaseTimer);
      held?.removeAttribute("data-note-pointer-full");
      held = null;
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      clear();
      // A keyboard-expanded note must not shrink under a neighbouring press.
      const focused = root.querySelector<HTMLElement>(".card:not(.folded):not(.has-reader):is(:focus-visible, :has(:focus-visible))");
      const full = focused?.querySelector<HTMLElement>('[data-task-note="full"]');
      if (full && getComputedStyle(full).display !== "none") {
        held = focused!;
        held.setAttribute("data-note-pointer-full", "");
      }
    };
    // Keep the pointer target in place through mouseup and the ensuing click.
    const up = () => { if (held) releaseTimer = setTimeout(clear, 0); };
    root.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("blur", clear);
    return () => {
      clear();
      root.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);
  const asideRef = useRef<HTMLDivElement>(null);
  const hasAside = Boolean(props.aside);
  const [mode, setMode] = useState<KanbanLayoutMode>("wide");
  /* The header bar's tier (#1801): labelled controls from BAR_WIDE_MIN of bar, icons below. */
  const [barWide, setBarWide] = useState(true);
  const [barWrap, setBarWrap] = useState(false);
  const [reasonsBelowBar, setReasonsBelowBar] = useState(false);
  /* The full attention chip would reach into ⋯ (measured, so it follows the locale's label and the
     digits of the count); the chip then keeps its dot and count, as it does in a compact bar. */
  const [chipCrowded, setChipCrowded] = useState(false);
  /* Even compact, the bar's groups would run into the chip with the open agents' slot in the row. */
  const [barTight, setBarTight] = useState(false);
  const [tab, setTab] = useState<TaskStatus>("assigned");
  const [query, setQuery] = useState("");
  const [reasonFilter, setReasonFilter] = useState<TaskReasonFilter | undefined>();
  const [linkQuery, setLinkQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(EMPTY_SET);
  /* The other machines' agents and lanes. On the Overview the feed
     covers every linked project, and only its lanes and hosts are drawn. */
  const remoteFeed = useRemoteFeed(props.overview ? null : project);
  const remoteAgents: readonly RemoteAgentView[] = useMemo(() => (!props.overview && remoteFeed ? remoteFeed.agents.filter((row) => row.p === project) : NO_REMOTE_AGENTS), [props.overview, remoteFeed, project]);
  /* One list per task, stable while the feed is: a card's memo reads it. */
  const remoteAgentsByTask = useMemo(() => {
    const byTask = new Map<string, RemoteAgentView[]>();
    for (const row of remoteAgents) if (row.task) byTask.set(row.task, [...(byTask.get(row.task) ?? []), row]);
    return byTask;
  }, [remoteAgents]);
  const remoteCards = useMemo(() => remoteCardsFor(allTasks, remoteFeed), [allTasks, remoteFeed]);
  const menu = useOverlay<
    { kind: "status" | "card" | "colour" | "icon"; cardId: string } | { kind: "column"; status: TaskStatus } | { kind: "tray" } | { kind: "create" } | { kind: "reader"; key: string; stop: ReaderStop } | { kind: "link"; key: string } | { kind: "stop"; key: string }
    | { kind: "pipeline"; cardId: string; pipelineId: string } | { kind: "stage"; cardId: string; pipelineId: string; stageId: string; from: "sheet" | "panel" }
    | { kind: "account"; target: AccountTarget }
    | { kind: "links"; target: WorkLinkTarget }
  >();
  const { receipts, show, dismiss } = useReceipts();

  const { controller, statuses, edits } = useTaskMutations(allTasks, props.mutationPorts);
  /* Which cards show a pipeline's graph or its summary, as the operator chose. */
  const [graphChoices, setGraphChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const toggleGraph = useCallback((cardId: string, pipelineId: string, open: boolean) => {
    setGraphChoices((current) => new Map(current).set(`${cardId}|${pipelineId}`, open));
  }, []);
  /* K5b: pipeline actions, waiting stages' first messages, and the Stages sheet. */
  const pipelinePorts = props.pipelinePorts ?? browserPipelinePorts;
  const [stageDrafts] = useState(() => new StageDrafts());
  const draftsVersion = useSyncExternalStore(stageDrafts.subscribe, stageDrafts.version, stageDrafts.version);
  const [stagePanels, setStagePanels] = useState<ReadonlyMap<string, StagePanel>>(() => new Map());
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  /* Pane folds and attempt choices outlive one opening of the sheet, as the prototype's do. */
  const [paneFolds, setPaneFolds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [paneAttempts, setPaneAttempts] = useState<ReadonlyMap<string, number>>(() => new Map());
  /* The board draws the edits it has sent ahead of the poll: a new title or
     colour at once, and a hidden group gone at once with a hide stamped now. */
  const hideStamps = useRef(new Map<string, string>());
  const effectiveTasks = useMemo(() => drawnTasks(allTasks, edits, hideStamps.current), [allTasks, edits]);
  const { bands, projection } = useBands({ ...props, allTasks: effectiveTasks });
  /* Every conversation the project's seat record names leaves the bands
     (#1841), as the page that read it reports them. Null is «not known yet»:
     the board hides nothing on a guess, and a failed read arrives here as the
     current seat alone, so work never disappears behind a record nobody could
     read. Re-keyed by what the seat names, so a fresh answer with the same
     content does not rebuild the model. */
  const seatKey = props.seatRefs ? JSON.stringify(props.seatRefs) : "";
  const seatRefs = useMemo<SeatRefs | null>(
    () => (seatKey ? (JSON.parse(seatKey) as SeatRefs) : null),
    [seatKey],
  );
  /* The orchestrator seat sits above the columns or, docked at the side,
     between the rail and them (#1841): one choice per browser. */
  const seatFrame = useKanbanSeat(project);
  const wideColumns = useKanbanWide();
  /* One column holds the wide share (#1841): Assigned, or the shelf the
     operator widened. Tabs already show one column at full width, and the
     cross-project Overview keeps its fixed shares and reads no pin. */
  const widthControls = mode !== "tabs" && !props.overview;
  const workInAssignedRef = useRef(wideColumns.workInAssigned);
  workInAssignedRef.current = wideColumns.workInAssigned;
  /* A wide shelf gives the space back when the operator goes back to work in
     Assigned: a pointer down or a focus landing on a card there. Reading,
     scrolling or opening a card inside the wide column never narrows it. */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWork = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.column[data-status="assigned"] .card')) workInAssignedRef.current();
    };
    root.addEventListener("pointerdown", onWork, true);
    root.addEventListener("focusin", onWork);
    return () => {
      root.removeEventListener("pointerdown", onWork, true);
      root.removeEventListener("focusin", onWork);
    };
  }, []);
  const renderSeat = props.seat;
  /* The seat's expand button opens the seat's conversation in the agent
     window like any agent; the button takes the keyboard back when the
     window closes. Read through a ref: the opener is defined further down. */
  const openFromSeatRef = useRef<(file: FileEntry, from: HTMLElement | null, placeholder?: string) => void>(() => {});
  const openFromSeat = useCallback((file: FileEntry, from: HTMLElement | null, placeholder?: string) => openFromSeatRef.current(file, from, placeholder), []);
  /* What the seat's composer says, kept for the same conversation's composer in the window. */
  const [seatPlaceholder, setSeatPlaceholder] = useState<{ key: string; text: string } | null>(null);
  const seatView = useMemo(() => {
    const seat = renderSeat?.(boardId) ?? null;
    return seat ? <AgentWindowOpener.Provider value={openFromSeat}>{seat}</AgentWindowOpener.Provider> : null;
  }, [renderSeat, boardId, openFromSeat]);
  const seatSide = Boolean(seatView) && seatFrame.placement === "side";
  /* The model's own clock moves in 15 s steps: it only phrases ages and
     waits, and a per-second clock would rebuild every card each tick. */
  const readerStorage = props.readerStorage === undefined ? browserStorage() : props.readerStorage;
  const memory = useMemo(() => new ReaderMemory(project, readerStorage), [project, readerStorage]);
  const openReaders = useSyncExternalStore(memory.subscribe, memory.snapshot, () => NO_READERS);
  const openReadersRef = useRef(openReaders);
  openReadersRef.current = openReaders;
  /* The readers a card holds open, for where a new draft stands (kanbanModel's `openReaders`). */
  const unfoldedReaders = useMemo(() => new Set(openReaders.filter((reader) => !reader.folded).map((reader) => reader.key)), [openReaders]);
  const modelNow = Math.floor(props.now / 15) * 15;
  /* A catalog update rebuilds the model, and a card whose content did not change
     stays the object it was, so only the cards it touched render again (#2218). */
  const previousModel = useRef<KanbanModel | null>(null);
  // eslint-disable-next-line react-hooks/refs -- Identity cache: the ref only decides which equal object is kept, never what the model holds.
  const model: KanbanModel = useMemo(() => {
    const built = buildKanbanModel({ bands, tasks: effectiveTasks, pipelines, projection, files, flows: props.flows, statusOverrides: statuses, cardFilter: props.overview?.keep, reasonFilter, seat: seatRefs, query, openReaders: unfoldedReaders, launched: isLaunchedConversation, now: modelNow });
    const shared = reuseKanbanModel(previousModel.current, built);
    previousModel.current = shared;
    return shared;
  }, [bands, effectiveTasks, pipelines, projection, files, props.flows, statuses, props.overview?.keep, reasonFilter, seatRefs, query, unfoldedReaders, modelNow]);
  const cardsById = useMemo(() => {
    const map = new Map<string, KanbanCardModel>();
    for (const status of KANBAN_STATUSES) for (const card of model.columns[status].cards) map.set(card.id, card);
    for (const card of model.unlinked) map.set(card.id, card);
    return map;
  }, [model]);
  const tasksById = useRef(new Map<string, BoardTask>());
  tasksById.current = new Map(allTasks.map((task) => [task.id, task] as const));
  const effectiveById = useRef(new Map<string, BoardTask>());
  effectiveById.current = new Map(effectiveTasks.map((task) => [task.id, task] as const));
  const filesByPath = useMemo(() => new Map(files.map((file) => [file.path, file] as const)), [files]);

  /* ── Readers: conversations open inside cards ────────────────────────── */
  const cards = useMemo(() => allCards(model), [model]);
  const owners = useMemo(() => conversationOwners(cards, files), [cards, files]);
  const anchors = useMemo(() => cardAnchors(cards, owners), [cards, owners]);
  const [placement] = useState(() => new ReaderPlacement());
  /* The agent window (docs/design/agent-window.md): every conversation opened
     on the board opens here, never inside its card. `windowAgent` is the agent
     asked for, null with the window closed; `shown` is the one in the reader,
     which follows once the agent asked for is ready, so the window never shows
     an empty reader. The window belongs to the project it was opened in: a
     project switch leaves it behind, and it does not come back on return. */
  const [windowState, setWindowState] = useState<{ project: string; agent: string | null; shown: string | null }>({ project, agent: null, shown: null });
  if (windowState.project !== project) setWindowState({ project, agent: null, shown: null });
  const requestedAgent = windowState.project === project ? windowState.agent : null;
  const shownState = windowState.project === project ? windowState.shown : null;
  const setWindow = useCallback((agent: string | null, shown?: string | null) => {
    setWindowState((current) => {
      const next = { project, agent, shown: shown === undefined ? (current.project === project ? current.shown : null) : shown };
      return next.agent === current.agent && next.shown === current.shown && next.project === current.project ? current : next;
    });
  }, [project]);
  /* Where the window and the park stand, measured onto the board. */
  useAgentWindowGeometry(rootRef);
  /* The agent the pill and Alt+J bring the window back on. */
  const lastShown = useRef<string | null>(null);
  /* Whether the agent brought in takes the keyboard: an open or a switch does,
     an attention handoff and a row's × leave focus where it is. */
  const focusOnShow = useRef(false);
  const windowAgentRef = useRef<string | null>(null);
  /* The control outside the board's cards the window was opened from (the
     seat's expand button): closing the window gives it the keyboard back. */
  const openedFrom = useRef<HTMLElement | null>(null);
  const focusAfterWindow = useCallback((fallback: string) => {
    const from = openedFrom.current;
    openedFrom.current = null;
    queueMicrotask(() => (from?.isConnected ? from : rootRef.current?.querySelector<HTMLElement>(fallback))?.focus({ preventScroll: true }));
  }, []);
  const leaveWindow = useCallback(() => {
    if (!windowAgentRef.current) return;
    setWindow(null, null);
    /* The pill brings the window back; it takes the keyboard. */
    focusAfterWindow("[data-open-agents-pill]");
  }, [setWindow, focusAfterWindow]);
  const parkRef = useCallback((park: HTMLDivElement | null) => placement.setPark(park), [placement]);
  const filesByIdentity = useMemo(() => new Map(files.map((file) => [conversationIdentity(file), file] as const)), [files]);
  /* A conversation that has left this board's files keeps its reader mounted
     on the file it was last seen as, so nothing typed into it is lost. */
  const lastSeenFiles = useRef(new Map<string, FileEntry>());

  /* ── The Stages sheet's panes ─────────────────────────────────────────── */
  const filesByConversation = useMemo(() => new Map(files.filter((file) => file.conversationId).map((file) => [file.conversationId!, file] as const)), [files]);
  /* The card's pipeline, or the same pipeline on whichever card holds it now. */
  const sheetSummary = useMemo(() => {
    if (!sheet) return null;
    const own = cardsById.get(sheet.cardId)?.pipelines.find((entry) => entry.pipeline.id === sheet.pipelineId);
    if (own) return { card: cardsById.get(sheet.cardId)!, summary: own };
    for (const card of cards) {
      const summary = card.pipelines.find((entry) => entry.pipeline.id === sheet.pipelineId);
      if (summary) return { card, summary };
    }
    return null;
  }, [sheet, cardsById, cards]);
  const sheetPanes = useMemo<SheetPane[]>(() => {
    if (!sheetSummary) return [];
    const { pipeline } = sheetSummary.summary;
    return pipeline.stages.map((stage) => {
      const key = stageDraftKey(pipeline.id, stage.id);
      const folded = paneFolds.has(key);
      const shown = shownAttempt(pipeline, stage.id, paneAttempts.get(key) ?? null);
      const file = shown ? (shown.agentPath ? filesByPath.get(shown.agentPath) : undefined) ?? (shown.conversationId ? filesByConversation.get(shown.conversationId) : undefined) ?? null : null;
      return { stage, folded, attempts: operationalAttempts(pipeline, stage.id), shown, file, readerKey: file && !folded ? conversationIdentity(file) : null };
    });
  }, [sheetSummary, paneFolds, paneAttempts, filesByPath, filesByConversation]);
  /* A conversation a pane shows is mounted in that pane, unless the agent window shows it or is bringing it in. */
  const sheetSlots = useMemo(() => new Set(sheetPanes.flatMap((pane) => (pane.readerKey && pane.readerKey !== shownState && pane.readerKey !== requestedAgent ? [pane.readerKey] : []))), [sheetPanes, shownState, requestedAgent]);

  /* A reader's owner is rebuilt with the model; while it names the same card, title and stage, the reader keeps
     the object it had, so a model rebuild does not re-render every open reader. */
  const ownerCache = useRef(new Map<string, ReaderOwner>());
  const stableOwner = (key: string, next: ReaderOwner): ReaderOwner => {
    const previous = ownerCache.current.get(key);
    if (previous && previous.cardId === next.cardId && previous.cardTitle === next.cardTitle
      && previous.stage?.pipeline === next.stage?.pipeline && previous.stage?.stage === next.stage?.stage) return previous;
    ownerCache.current.set(key, next);
    return next;
  };
  const readerViews = useMemo<ReaderView[]>(() => {
    const views: ReaderView[] = openReaders.flatMap((reader) => {
      const owner = owners.get(reader.key);
      const file = owner?.file ?? filesByIdentity.get(reader.key) ?? filesByPath.get(reader.path) ?? lastSeenFiles.current.get(reader.key);
      if (!file) return [];
      const card = owner ? cardsById.get(owner.cardId) : undefined;
      return [{
        readerKey: reader.key,
        file,
        inSheet: sheetSlots.has(reader.key),
        owner: owner && card ? stableOwner(reader.key, { cardId: card.id, cardTitle: card.titlePending ? t("kanban.untitled") : card.title, stage: owner.stage }) : null,
        ...(isCurrentSeatConversation(seatRefs, file) ? { seat: true, ...(seatPlaceholder?.key === reader.key ? { composerPlaceholder: seatPlaceholder.text } : {}) } : {}),
        /* The window is the operator's conversation window: the agent in its
           reader takes the one composer from any other place of the same
           conversation, the seat's included. */
        ...(shownState === reader.key ? { composerPrimary: true } : {}),
      }];
    });
    /* A pane's conversation no card has open is mounted for as long as the pane shows it. */
    if (sheetSummary) {
      const open = new Set(openReaders.map((reader) => reader.key));
      const { card, summary } = sheetSummary;
      for (const pane of sheetPanes) {
        if (!pane.readerKey || !pane.file || open.has(pane.readerKey)) continue;
        views.push({
          readerKey: pane.readerKey,
          file: pane.file,
          inSheet: shownState !== pane.readerKey,
          owner: stableOwner(pane.readerKey, { cardId: card.id, cardTitle: card.titlePending ? t("kanban.untitled") : card.title, stage: { pipeline: summary.pipeline, stage: pane.stage } }),
        });
      }
    }
    return views;
  }, [openReaders, owners, filesByIdentity, filesByPath, cardsById, t, shownState, sheetSlots, sheetSummary, sheetPanes, seatRefs, seatPlaceholder]);
  useEffect(() => {
    for (const view of readerViews) lastSeenFiles.current.set(view.readerKey, view.file);
  }, [readerViews]);
  /* An agent closed while it is in the reader and its neighbour has not
     read yet: it has left the list and stays in the reader until the
     neighbour can take its place, then it closes (see closeReaderFor). */
  const [closing, setClosing] = useState<{ key: string; memory: ReaderMemory } | null>(null);
  /* The agents open on the board, for the agent window's list. */
  const openNow = useMemo(() => openAgents(t, readerViews, openReaders, props.now), [t, readerViews, openReaders, props.now]);
  const windowAgents = useMemo(() => (closing ? openNow.filter((agent) => agent.key !== closing.key) : openNow), [openNow, closing]);
  const windowKeysRef = useRef<readonly string[]>([]);
  windowKeysRef.current = windowAgents.map((agent) => agent.key);
  /* The agent in the reader. One whose conversation is gone from the list
     (closed elsewhere, or its file left the board) is not shown. */
  const shown = shownState && openNow.some((agent) => agent.key === shownState) ? shownState : null;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  /* An agent asked for that is not open any more leaves the window on the
     one still shown, or closes it. */
  const requestedListed = requestedAgent !== null && windowAgents.some((agent) => agent.key === requestedAgent);
  const windowAgent = requestedListed ? requestedAgent : requestedAgent ? shown : null;
  windowAgentRef.current = windowAgent;
  const windowOpen = windowAgent !== null && shown !== null;
  if (shown) lastShown.current = shown;
  /* The agent asked for comes into the reader once its feed is ready: at once
     for one already open, after its first read for a new one. The previous
     agent stays in the reader until then, and a first open shows the window
     with its conversation. */
  const incoming = requestedListed && requestedAgent !== shown ? requestedAgent : null;
  useReaderReady(placement, incoming, useCallback((key: string) => setWindow(key, key), [setWindow]));
  /* The agent closed leaves once the reader has moved on from it: to its
     neighbour, or with the window. */
  useLayoutEffect(() => {
    if (!closing || shown === closing.key) return;
    closing.memory.update((readers) => closeReader(readers, closing.key));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the close it held is done
    setClosing(null);
  }, [closing, shown]);
  /* Escape closes the window in one press, unless the key belongs to a field,
     a menu or another dialog. Listened for on the document: the reader is a
     portal, so its key events never pass through the window in React's tree. */
  useEffect(() => {
    if (!windowAgent) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable='true'], [role='menu']")) return;
      const dialog = target?.closest?.("[role='dialog']");
      if (dialog && !dialog.hasAttribute("data-agent-window-frame")) return;
      leaveWindow();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [windowAgent, leaveWindow]);

  /* A write this browser refused leaves every reader open on this page; the
     operator is told once that they will not come back after a reload. */
  const toldUnremembered = useRef(false);
  useEffect(() => {
    if (memory.persisted()) {
      toldUnremembered.current = false;
      return;
    }
    if (toldUnremembered.current) return;
    toldUnremembered.current = true;
    show(t("kanban.readersNotRemembered", { count: openReaders.length }), undefined, { error: true });
  }, [memory, openReaders, show, t]);
  /* A conversation that moved to a new transcript keeps its reader. */
  useEffect(() => {
    memory.update((readers) => followPaths(readers, (key) => filesByIdentity.get(key)?.path ?? null));
  }, [memory, filesByIdentity]);
  /* Told before paint, so a conversation whose turn ends under an open reader is never drawn folded. */
  const readerPaths = useMemo(() => openReaders.map((reader) => filesByIdentity.get(reader.key)?.path ?? reader.path).join("\n"), [openReaders, filesByIdentity]);
  const readersChanged = useStableCallback((paths: readonly string[]) => props.onReadersChange?.(paths));
  useLayoutEffect(() => {
    readersChanged(readerPaths ? readerPaths.split("\n") : []);
  }, [readerPaths, readersChanged]);
  /* The cards mark the agents open from them; none of them hosts one. */
  const readerKeysByCard = useMemo(() => {
    const byCard = new Map<string, string[]>();
    for (const reader of openReaders) {
      const owner = owners.get(reader.key);
      if (!owner) continue;
      const keys = byCard.get(owner.cardId) ?? [];
      keys.push(reader.key);
      byCard.set(owner.cardId, keys);
    }
    return new Map([...byCard].map(([cardId, keys]) => [cardId, keys.join("\n")] as const));
  }, [openReaders, owners]);

  /* A feed position a move between the window, a pane and the park reset
     comes back before paint. */
  useLayoutEffect(() => {
    placement.restoreScrolls();
  });

  /* ── Width → layout mode ─────────────────────────────────────────────── */
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    /* The bar spans the board, its aside and a seat docked at the side; the
       columns' mode follows what those leave them (#1841). */
    const aside = asideRef.current;
    const seat = seatSide ? element.querySelector<HTMLElement>(".kb-body > .seat") : null;
    let frame = 0;
    const apply = () => {
      // The helper owns intermediate widths; measure the settled layout.
      if (element.hasAttribute("data-column-layout")) return;
      const barWidth = element.getBoundingClientRect().width;
      const beside = barWidth - (aside?.getBoundingClientRect().width ?? 0);
      const seatWidth = seat?.getBoundingClientRect().width ?? 0;
      setMode(kanbanLayoutModeBeside(beside, seatWidth));
      setBarWide(barWidth >= BAR_WIDE_MIN);
      setBarWrap(kanbanLayoutMode(barWidth) === "tabs");
      setReasonsBelowBar(barWidth < 1168);
    };
    const settled = () => {
      // Release transient layers before asking for the settled layout. This
      // read otherwise forces raster/layout in the animation's cleanup task.
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; apply(); });
    };
    apply();
    element.addEventListener(COLUMN_LAYOUT_END, settled);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null;
    observer?.observe(element);
    if (aside) observer?.observe(aside);
    if (seat) observer?.observe(seat);
    return () => { observer?.disconnect(); element.removeEventListener(COLUMN_LAYOUT_END, settled); if (frame) cancelAnimationFrame(frame); };
  }, [hasAside, seatSide]);

  /* The chip is fixed over the bar's right reserve and the bar's groups can run into it (the uk
     label is the widest). With the bar's own filters in the row, measure the chip in its full form
     against ⋯ and compact it only when they would touch. Measuring takes the attribute off and puts
     it back inside one task, so nothing is drawn between and the verdict does not depend on the
     last one. The open agents' slot is measured in the compact row the same way: where even that
     row runs into the chip, the slot is not drawn (the agents stay open, Alt+J brings the window),
     and whether it is drawn depends on the width alone, never on how many agents are open. */
  useLayoutEffect(() => {
    const bar = rootRef.current?.querySelector<HTMLElement>('.bar[data-bar="project"]');
    if (!bar) { setChipCrowded(false); setBarTight(false); return; }
    const fit = () => {
      const chip = bar.querySelector<HTMLElement>("[data-attention-count]");
      const more = bar.querySelector<HTMLElement>('[data-bar-group="more"]');
      if (!chip || !more) return;
      const touches = () => chip.getBoundingClientRect().left < more.getBoundingClientRect().right + CHIP_CLEARANCE;
      const compact = bar.hasAttribute("data-bar-compact");
      const tight = bar.hasAttribute("data-bar-tight");
      bar.removeAttribute("data-bar-tight");
      let crowded = false;
      if (!reasonsBelowBar) {
        bar.removeAttribute("data-bar-compact");
        crowded = touches();
      }
      bar.setAttribute("data-bar-compact", "");
      const squeezed = !barWrap && touches();
      if (!compact) bar.removeAttribute("data-bar-compact");
      if (tight) bar.setAttribute("data-bar-tight", "");
      setChipCrowded(crowded);
      setBarTight(squeezed);
    };
    fit();
    if (typeof ResizeObserver !== "function") return;
    const resize = new ResizeObserver(fit);
    resize.observe(bar);
    const mutation = typeof MutationObserver === "function" ? new MutationObserver(fit) : null;
    mutation?.observe(bar, { childList: true, subtree: true, characterData: true });
    return () => { resize.disconnect(); mutation?.disconnect(); };
  }, [reasonsBelowBar, barWide, barWrap, locale, hasAside, seatSide]);

  /* ── Flash, flights ──────────────────────────────────────────────────── */
  const flash = useCallback((cardId: string) => {
    const element = rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`);
    if (!element) return;
    element.classList.remove("flash");
    void element.offsetWidth;
    element.classList.add("flash");
  }, []);
  /* Launches that did not start, one row's or all of them: dismissing marks
     each row failed on the server, and the refreshed tasks take the rows
     away. A refusal (one did start after all) flashes the card. */
  const dismissLaunch = useCallback((card: KanbanCardModel, launches: readonly { launchId: string | null; conversationId: string | null }[]) => {
    if (!card.task || !launches.length) return;
    const answer = launches.length === 1 ? dismissUnstartedLaunch(card.task.id, launches[0]!) : dismissUnstartedLaunches(card.task.id, launches);
    void answer.then((result) => {
      if (!result.ok) flash(card.id);
    });
  }, [flash]);
  /* The card moves of a render fly from where the cards were (`CardFlights`). */
  const placements = useMemo(() => {
    const byCard = new Map<string, TaskStatus>();
    for (const status of KANBAN_STATUSES) for (const card of model.columns[status].shown) byCard.set(card.id, status);
    return byCard;
  }, [model]);

  /* ── Status moves ────────────────────────────────────────────────────── */
  /* Focus follows the card into its new column: the moved card is a new
     element there, so it is found again by id. The card, not the ⋯ the move
     may have come from, takes it, so [ ] S M work on it at once. */
  const pendingFocus = useRef<{ cardId: string; status: TaskStatus } | null>(null);
  const focusMoved = useCallback((cardId: string, status: TaskStatus) => {
    pendingFocus.current = { cardId, status };
  }, []);
  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    if (!wanted) return;
    const element = rootRef.current?.querySelector<HTMLElement>(`.column[data-status="${wanted.status}"] .card[data-id="${cssEscape(wanted.cardId)}"]`);
    if (!element) return;
    pendingFocus.current = null;
    /* The menu hands focus back to its anchor on close; the anchor was the old
       card, so this runs again on the next frame once that has happened. */
    element.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      if (element.isConnected && document.activeElement !== element) element.focus({ preventScroll: true });
    });
  });
  /* ── Undo and redo (#1856) ───────────────────────────────────────────── */
  /* The operator's own status moves, text edits and hides, per project and in
     memory only (boardHistory.ts). An undo or a redo is written fenced on the
     revision this board's own last write of the task produced, so a task
     someone else changed in between is refused and stays as they left it. A
     receipt's Undo, Ctrl+Z and U run the same step; each step replaces the
     receipt of the entry it answers, so a run of Ctrl+Z shows one receipt. */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a project switch starts an empty history
  const history = useMemo(() => new BoardHistory(), [project]);
  const historyRef = useRef(history);
  historyRef.current = history;
  const entryReceipts = useRef(new WeakMap<HistoryEntry, number>());
  const stepRef = useRef<(direction: HistoryDirection, chosen?: HistoryEntry) => boolean>(() => false);
  /** Undo or redo `chosen`, or the top of its stack. False when there is nothing to take, or `chosen` is not on that stack. */
  const step = useCallback((direction: HistoryDirection, chosen?: HistoryEntry) => stepRef.current(direction, chosen), []);
  const applyEntry = (entry: HistoryEntry, direction: HistoryDirection) => {
    const stacks = historyRef.current;
    /* While this write is out the entry is on neither stack. A new edit
       recorded meanwhile cleared the redo stack, so an undo must not come back
       onto it; a redo goes back onto the undo stack below that edit. */
    const epoch = stacks.epoch;
    const undoing = direction === "undo";
    const previous = entryReceipts.current.get(entry);
    if (previous !== undefined) dismiss(previous);
    const reverse = { label: t(undoing ? "kanban.redo" : "kanban.undo"), run: () => void step(undoing ? "redo" : "undo", entry) };
    /* After a redo the board says what it said after the edit itself; a
       bulk's undo counts what came back. */
    const bulk = entry.kind === "hide" && entry.tasks.length > 1;
    const said = () => entry.kind === "status"
      ? t(undoing ? "kanban.movedBack" : "kanban.moved", { title: entry.title, status: statusLabel(t, undoing ? entry.from : entry.to) })
      : entry.kind === "text"
        ? t(undoing ? "kanban.textRestored" : "kanban.edited", { title: entry.title })
        : entry.tasks.length === 1 && !(undoing && bulk)
          ? t(undoing ? "kanban.restoredReceipt" : "kanban.hiddenReceipt", { title: entry.tasks[0]!.title })
          : undoing ? t("kanban.backOnBoardMany", { count: entry.tasks.length }) : entry.text;
    let receiptId = show(said(), reverse);
    entryReceipts.current.set(entry, receiptId);
    if (entry.kind === "hide" && undoing && entry.tasks.length === 1) pendingCardFocus.current = { cardId: `task:${entry.tasks[0]!.taskId}`, fallback: null, always: true };
    const targets = entry.kind === "hide" ? entry.tasks : [{ taskId: entry.taskId, title: entry.title }];
    let chain: Promise<unknown> = Promise.resolve();
    const writes = targets.map(async (target) => {
      const raw = tasksById.current.get(target.taskId);
      /* A task that left the board was changed elsewhere, too. */
      if (!raw) return { target, kind: "conflict" as const, error: "" };
      let outcome: StatusMoveOutcome | FieldEditOutcome;
      const fence = { fenced: true, lineage: entry.lineages?.get(target.taskId) };
      if (entry.kind === "status") outcome = await controller.move(raw, undoing ? entry.from : entry.to, { ...fence, ...(Object.hasOwn(entry, "fromHold") ? { restoreHold: undoing ? entry.fromHold ?? null : entry.toHold ?? null } : {}) });
      else if (entry.kind === "text") outcome = await controller.edit(raw, { field: "text", value: undoing ? entry.before : entry.after }, fence);
      else {
        const write = controller.edit(raw, undoing ? { field: "hide", value: false } : { field: "hide", value: true, replaces: raw.groupHidden?.at ?? null }, { ...fence, after: chain });
        chain = write;
        outcome = await write;
      }
      if (outcome.kind === "saved") (entry.lineages ??= new Map()).set(target.taskId, outcome.lineage);
      return { target, kind: outcome.kind, error: outcome.kind === "failed" ? outcome.error : "" };
    });
    void Promise.all(writes).then((results) => {
      const saved = results.filter((result) => result.kind !== "conflict" && result.kind !== "failed").map((result) => result.target);
      const refused = results.filter((result) => result.kind === "conflict").map((result) => result.target);
      const failed = results.filter((result) => result.kind === "failed");
      for (const target of refused) {
        flash(`task:${target.taskId}`);
        stacks.dropTask(target.taskId);
      }
      if (entry.kind === "hide") entry.tasks = saved;
      if (saved.length) {
        if (!undoing) stacks.pushUndo(entry, epoch);
        else if (stacks.epoch === epoch) stacks.pushRedo(entry);
      }
      if (!saved.length) dismiss(receiptId);
      else if (saved.length < targets.length) {
        /* Part of a bulk came through: the receipt counts only that part. */
        dismiss(receiptId);
        receiptId = show(said(), reverse);
        entryReceipts.current.set(entry, receiptId);
      }
      if (refused.length) {
        show(refused.length === 1
          ? t(undoing ? "kanban.undoRefused" : "kanban.redoRefused", { title: refused[0]!.title })
          : t("kanban.undoRefusedMany", { count: refused.length }), undefined, { error: true });
      }
      if (failed.length) {
        /* What did not reach the server goes back where it came from, and Retry takes it again. */
        const rest: HistoryEntry = entry.kind !== "hide" ? entry : saved.length ? { ...entry, tasks: failed.map((result) => result.target) } : Object.assign(entry, { tasks: failed.map((result) => result.target) });
        /* A redo whose stack a new edit cleared has nothing to go back to and no Retry. */
        const kept = undoing || stacks.epoch === epoch;
        if (kept) {
          if (undoing) stacks.pushUndo(rest, epoch);
          else stacks.pushRedo(rest);
        }
        /* A hide names the group that stayed as it was, or counts them. */
        const error = failed[0]!.error;
        const text = entry.kind !== "hide"
          ? t(undoing ? "kanban.undoFailed" : "kanban.redoFailed", { error })
          : failed.length === 1
            ? t(undoing ? "kanban.showFailed" : "kanban.hideFailed", { title: failed[0]!.target.title, error })
            : t(undoing ? "kanban.showFailedMany" : "kanban.hideFailedMany", { count: failed.length, error });
        entryReceipts.current.set(rest, show(text, kept ? { label: t("kanban.retry"), run: () => void step(direction, rest) } : undefined, { error: true }));
      }
    });
  };
  stepRef.current = (direction, chosen) => {
    const stacks = historyRef.current;
    /* A receipt acts only while its entry is on the stack it would take from:
       the Redo of an undo, or the Retry of a failed redo, is gone once a new
       edit cleared the redo stack. */
    if (chosen && !stacks.withdraw(chosen, direction)) return false;
    const entry = chosen ?? (direction === "undo" ? stacks.takeUndo() : stacks.takeRedo());
    if (!entry) return false;
    /* An edit still being written is undone once its write has answered; one
       that did not save is skipped for the next. */
    const answered = (saved: boolean) => {
      if (saved) applyEntry(entry, direction);
      else if (!chosen) step(direction);
    };
    if (entry.saved === undefined) void entry.settled.then(answered);
    else answered(entry.saved);
    return true;
  };

  const move = useCallback((card: KanbanCardModel, to: TaskStatus, options: { focus?: boolean; hold?: Partial<TaskHold> | null } = {}) => {
    const task = card.task ? tasksById.current.get(card.task.id) ?? card.task : null;
    if (!task) return;
    const from = card.status;
    if (from === to && !Object.hasOwn(options, "hold")) return;
    const title = card.titlePending ? t("kanban.untitled") : card.title;
    const short = clipTitle(title);
    const written = settles();
    const entry: HistoryEntry = { kind: "status", taskId: task.id, title: short, from, to, fromHold: controller.holdFor(task) ?? null, toHold: null, settled: written.promise };
    historyRef.current.record(entry);
    const receiptId = show(t("kanban.moved", { title: short, status: statusLabel(t, to) }), { label: t("kanban.undo"), run: () => void step("undo", entry) });
    entryReceipts.current.set(entry, receiptId);
    if (options.focus) focusMoved(card.id, to);
    void controller.move(task, to, Object.hasOwn(options, "hold") ? { hold: options.hold } : {}).then((outcome: StatusMoveOutcome) => {
      if (outcome.kind === "saved") { entry.lineages = new Map([[task.id, outcome.lineage]]); entry.toHold = outcome.task.hold ?? null; }
      written.resolve(outcome.kind === "saved");
      /* The server already held the status: nothing of this board's is left to undo. */
      if (outcome.kind === "settled") dismiss(receiptId);
      if (outcome.kind === "failed") {
        dismiss(receiptId);
        flash(card.id);
        show(t("kanban.moveFailed", { title: short, error: outcome.error }), {
          label: t("kanban.retry"),
          run: () => {
            const current = cardsByIdRef.current.get(card.id);
            if (current) move(current, to, options);
          },
        }, { error: true });
      } else if (outcome.kind === "conflict") {
        dismiss(receiptId);
        flash(card.id);
        show(t("kanban.movedElsewhere", { title: short, status: statusLabel(t, outcome.serverStatus) }), {
          label: t("kanban.moveAnyway"),
          run: () => {
            const current = cardsByIdRef.current.get(card.id);
            if (current) move(current, to, options);
          },
        }, { error: true });
      }
    });
  }, [controller, dismiss, flash, focusMoved, show, step, t]);
  const cardsByIdRef = useRef(cardsById);
  cardsByIdRef.current = cardsById;

  const shift = useCallback((card: KanbanCardModel, delta: -1 | 1) => {
    const index = KANBAN_STATUSES.indexOf(card.status) + delta;
    const target = KANBAN_STATUSES[index];
    if (target) move(card, target, { focus: true });
  }, [move]);

  /* ── Inline title and description (prototype `startEdit`/`commitEdit`) ── */
  /* Drafts belong to the board, keyed by card, so a card that re-ranks, moves
     or re-renders keeps what the operator typed. A refused save keeps the
     draft for Retry; text an agent wrote meanwhile is offered beside it. */
  const [editing, setEditing] = useState<ReadonlyMap<string, { field: EditField; draft: string; base: string }>>(NO_EDITS);
  const [failedEdits, setFailedEdits] = useState<ReadonlyMap<string, { field: EditField; draft: string; base: string; message: string }>>(NO_EDITS);
  const [incomingEdits, setIncomingEdits] = useState<ReadonlyMap<string, { field: EditField; value: string }>>(NO_EDITS);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const failedRef = useRef(failedEdits);
  failedRef.current = failedEdits;
  const incomingRef = useRef(incomingEdits);
  incomingRef.current = incomingEdits;
  /* A card that should hold focus once React has drawn it: the card an edit
     closed on, or the next card after a hide. */
  const pendingCardFocus = useRef<{ cardId: string; fallback: TaskStatus | null; always: boolean } | null>(null);
  const shortTitle = (card: KanbanCardModel) => {
    const title = card.titlePending ? t("kanban.untitled") : card.title;
    return clipTitle(title);
  };
  const startEdit = useCallback((card: KanbanCardModel, field: EditField) => {
    const task = card.task ? effectiveById.current.get(card.task.id) : undefined;
    if (!task) return;
    const base = field === "details" ? (task.details ?? "") : textField(task.text, field);
    /* A draft a refused save kept is what the field reopens with. */
    const kept = failedRef.current.get(card.id);
    const retained = kept?.field === field ? kept : null;
    if (retained) setFailedEdits((current) => withEntry(current, card.id, undefined));
    setIncomingEdits((current) => withEntry(current, card.id, undefined));
    setEditing((current) => withEntry(current, card.id, retained
      ? { field, draft: retained.draft, base: retained.base }
      /* A borrowed title (a placeholder no agent will name) is where the
         rename starts, so accepting it as shown makes it the task's own. */
      : { field, draft: field === "title" ? (card.titlePending ? "" : card.title) : base, base }));
    if (field === "description" || field === "details") {
      setCollapsed((current) => {
        if (!current.has(card.id)) return current;
        const next = new Set(current);
        next.delete(card.id);
        return next;
      });
    }
  }, []);
  /* `base` is the field as the edit found it: a save whose stored field still
     reads `base` goes onto the stored text, whatever else moved there. */
  const saveText = useCallback(async (cardId: string, field: EditField, draft: string, base?: string): Promise<void> => {
    const card = cardsByIdRef.current.get(cardId);
    const raw = card?.task ? tasksById.current.get(card.task.id) : undefined;
    if (!card || !raw) return;
    const value = draft.trim();
    if (field === "details") {
      /* Its own field: this write carries `details` and nothing else, so the
         task's text is left exactly as stored (#1834). An empty draft clears
         it, and the card's row then disappears. */
      const stored = effectiveById.current.get(raw.id)?.details ?? raw.details ?? "";
      const found = base ?? stored;
      if (stored === value) {
        setFailedEdits((current) => withEntry(current, cardId, undefined));
        return;
      }
      setFailedEdits((current) => withEntry(current, cardId, undefined));
      const outcome: FieldEditOutcome = await controller.edit(raw, { field: "details", value });
      if (outcome.kind === "failed") {
        flash(cardId);
        setFailedEdits((current) => withEntry(current, cardId, { field, draft, base: found, message: /[.!?…]$/.test(outcome.error.trim()) ? outcome.error.trim() : `${outcome.error.trim()}.` }));
      } else if (outcome.kind === "conflict") {
        const theirs = typeof outcome.serverValue === "string" ? outcome.serverValue : "";
        if (theirs === value) return;
        setEditing((current) => withEntry(current, cardId, { field, draft, base: theirs }));
        setIncomingEdits((current) => withEntry(current, cardId, { field, value: theirs }));
      } else {
        setIncomingEdits((current) => withEntry(current, cardId, undefined));
      }
      return;
    }
    const currentText = effectiveById.current.get(raw.id)?.text ?? raw.text;
    const found = base ?? textField(currentText, field);
    if (field === "title" && !value) {
      setFailedEdits((current) => withEntry(current, cardId, { field, draft, base: found, message: t("kanban.titleRequired") }));
      return;
    }
    if (textField(currentText, field) === value && !(field === "title" && card.titlePending)) {
      setFailedEdits((current) => withEntry(current, cardId, undefined));
      return;
    }
    setFailedEdits((current) => withEntry(current, cardId, undefined));
    const sent = withField(currentText, field, value);
    const newTitle = textField(sent, "title") || t("kanban.untitled");
    const written = settles();
    const entry: HistoryEntry = { kind: "text", taskId: raw.id, title: clipTitle(newTitle), before: currentText, after: sent, settled: written.promise };
    historyRef.current.record(entry);
    const receiptId = show(t("kanban.edited", { title: entry.title }), { label: t("kanban.undo"), run: () => void step("undo", entry) });
    entryReceipts.current.set(entry, receiptId);
    const outcome: FieldEditOutcome = await controller.edit(raw, {
      field: "text",
      value: sent,
      rebase: (stored) => (textField(stored, field) === found ? withField(stored, field, value) : null),
    });
    /* A save rebased onto text an agent moved meanwhile is undone to that
       text with only this edit's part put back. */
    if (outcome.kind === "saved" && outcome.task.text !== sent) {
      entry.before = withField(outcome.task.text, field, found);
      entry.after = outcome.task.text;
    }
    if (outcome.kind === "saved") entry.lineages = new Map([[raw.id, outcome.lineage]]);
    written.resolve(outcome.kind === "saved");
    if (outcome.kind !== "saved") dismiss(receiptId);
    if (outcome.kind === "failed") {
      flash(cardId);
      setFailedEdits((current) => withEntry(current, cardId, { field, draft, base: found, message: /[.!?…]$/.test(outcome.error.trim()) ? outcome.error.trim() : `${outcome.error.trim()}.` }));
    } else if (outcome.kind === "conflict") {
      /* An agent wrote this field meanwhile: the editor comes back with the
         operator's draft, and their text beside it. */
      const theirs = textField(typeof outcome.serverValue === "string" ? outcome.serverValue : "", field);
      if (theirs === value) return;
      setEditing((current) => withEntry(current, cardId, { field, draft, base: theirs }));
      setIncomingEdits((current) => withEntry(current, cardId, { field, value: theirs }));
    } else {
      setIncomingEdits((current) => withEntry(current, cardId, undefined));
    }
  }, [controller, dismiss, flash, show, step, t]);
  const commitEdit = useCallback((cardId: string) => {
    const entry = editingRef.current.get(cardId);
    if (!entry) return;
    /* Enter or Save keeps the operator on the card; leaving the field for
       somewhere else leaves focus where they put it. */
    const editor = rootRef.current?.querySelector(`.card[data-id="${cssEscape(cardId)}"] [data-card-editor]`)?.closest(".editor");
    if (editor && editor.contains(document.activeElement)) pendingCardFocus.current = { cardId, fallback: null, always: true };
    setEditing((current) => withEntry(current, cardId, undefined));
    setIncomingEdits((current) => withEntry(current, cardId, undefined));
    void saveText(cardId, entry.field, entry.draft, entry.base);
  }, [saveText]);
  const cancelEdit = useCallback((cardId: string) => {
    pendingCardFocus.current = { cardId, fallback: null, always: true };
    setEditing((current) => withEntry(current, cardId, undefined));
    setIncomingEdits((current) => withEntry(current, cardId, undefined));
  }, []);
  const editDraft = useCallback((cardId: string, draft: string) => {
    setEditing((current) => {
      const entry = current.get(cardId);
      return entry ? withEntry(current, cardId, { ...entry, draft }) : current;
    });
  }, []);
  const focusEditor = (cardId: string) => queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"] [data-card-editor]`)?.focus());
  const retryEdit = useCallback((cardId: string) => {
    const failed = failedRef.current.get(cardId);
    if (!failed) return;
    setFailedEdits((current) => withEntry(current, cardId, undefined));
    void saveText(cardId, failed.field, failed.draft, failed.base);
  }, [saveText]);
  const discardEdit = useCallback((cardId: string) => {
    pendingCardFocus.current = { cardId, fallback: null, always: true };
    setFailedEdits((current) => withEntry(current, cardId, undefined));
  }, []);
  const takeTheirs = useCallback((cardId: string) => {
    const incoming = incomingRef.current.get(cardId);
    setIncomingEdits((current) => withEntry(current, cardId, undefined));
    if (incoming) setEditing((current) => withEntry(current, cardId, { field: incoming.field, draft: incoming.value, base: incoming.value }));
    focusEditor(cardId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusEditor reads refs only
  }, []);
  const keepMine = useCallback((cardId: string) => {
    setIncomingEdits((current) => withEntry(current, cardId, undefined));
    focusEditor(cardId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusEditor reads refs only
  }, []);
  /* A poll that brings different text into a field being edited never
     overwrites the draft: it is offered beside it, once per change. */
  useEffect(() => {
    if (!editing.size) return;
    let changed = false;
    const nextEditing = new Map(editing);
    let nextIncoming = incomingRef.current;
    for (const [cardId, entry] of editing) {
      const card = cardsByIdRef.current.get(cardId);
      const raw = card?.task ? allTasks.find((task) => task.id === card.task!.id) : undefined;
      /* A write of this device still ahead of the poll is not an agent's text. */
      if (!raw || controller.pending(raw.id)) continue;
      const shown = controller.edits().get(raw.id);
      if (entry.field === "details" ? shown?.details !== undefined : shown?.text !== undefined) continue;
      const theirs = entry.field === "details" ? (raw.details ?? "") : textField(raw.text, entry.field);
      if (theirs === entry.base) continue;
      nextEditing.set(cardId, { ...entry, base: theirs });
      changed = true;
      if (theirs !== entry.draft.trim()) nextIncoming = withEntry(nextIncoming, cardId, { field: entry.field, value: theirs });
    }
    if (!changed) return;
    setEditing(nextEditing);
    setIncomingEdits(nextIncoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the stored rows change
  }, [allTasks]);

  /* ── Colour ─────────────────────────────────────────────────────────────── */
  const setColor = useCallback((card: KanbanCardModel, color: TaskColor | null) => {
    const raw = card.task ? tasksById.current.get(card.task.id) : undefined;
    if (!raw) return;
    void controller.edit(raw, { field: "color", value: color }).then((outcome) => {
      if (outcome.kind !== "failed") return;
      flash(card.id);
      show(t("kanban.colorFailed", { title: shortTitle(card), error: outcome.error }), {
        label: t("kanban.retry"),
        run: () => {
          const current = cardsByIdRef.current.get(card.id);
          if (current) setColor(current, color);
        },
      }, { error: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shortTitle reads the card it is given
  }, [controller, flash, show, t]);

  /* ── Priority ───────────────────────────────────────────────────────────── */
  const setPriority = useCallback((card: KanbanCardModel, priority: TaskPriority) => {
    const raw = card.task ? tasksById.current.get(card.task.id) : undefined;
    if (!raw) return;
    void controller.edit(raw, { field: "priority", value: priority }).then((outcome) => {
      if (outcome.kind !== "failed") return;
      flash(card.id);
      show(t("kanban.priorityFailed", { title: shortTitle(card), error: outcome.error }), {
        label: t("kanban.retry"),
        run: () => {
          const current = cardsByIdRef.current.get(card.id);
          if (current) setPriority(current, priority);
        },
      }, { error: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shortTitle reads the card it is given
  }, [controller, flash, show, t]);

  /* ── Icon (#2102) ─────────────────────────────────────────────────────── */
  const setIcon = useCallback((card: KanbanCardModel, icon: string | null) => {
    const raw = card.task ? tasksById.current.get(card.task.id) : undefined;
    if (!raw) return;
    void controller.edit(raw, { field: "icon", value: icon }).then((outcome) => {
      if (outcome.kind !== "failed") return;
      flash(card.id);
      show(t("kanban.iconFailed", { title: shortTitle(card), error: outcome.error }), {
        label: t("kanban.retry"),
        run: () => {
          const current = cardsByIdRef.current.get(card.id);
          if (current) setIcon(current, icon);
        },
      }, { error: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shortTitle reads the card it is given
  }, [controller, flash, show, t]);
  const openIconMenu = useCallback((card: KanbanCardModel, anchor: HTMLElement) => menu.setOpen({ anchor, value: { kind: "icon", cardId: card.id } }), [menu]);

  /* ── Group hide, one card or a column's worth (prototype `hideTask`/`hideMany`) ── */
  /* Showing a hidden group again: the inverse write, through the same queue. */
  const showGroup = useCallback((taskId: string, title: string, options: { receipt?: boolean; focus?: boolean } = {}) => {
    const raw = tasksById.current.get(taskId);
    if (!raw) return;
    const receiptId = options.receipt !== false ? show(t("kanban.restoredReceipt", { title })) : null;
    if (options.focus) pendingCardFocus.current = { cardId: `task:${taskId}`, fallback: null, always: true };
    void controller.edit(raw, { field: "hide", value: false }).then((outcome) => {
      if (outcome.kind !== "failed") return;
      /* The group is hidden again: the receipt that said otherwise goes. */
      if (receiptId !== null) dismiss(receiptId);
      show(t("kanban.showFailed", { title, error: outcome.error }), { label: t("kanban.retry"), run: () => showGroup(taskId, title, options) }, { error: true });
    });
  }, [controller, dismiss, show, t]);
  /* The card focus moves to when a card leaves its column: the next one, else
     the previous, else the column's menu. */
  const neighbourOf = (cardId: string): { cardId: string; fallback: TaskStatus | null; always: boolean } | null => {
    const element = rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`);
    if (!element) return null;
    const siblings = [...(element.closest(".col-body")?.querySelectorAll<HTMLElement>(".card[data-id]") ?? [])];
    const index = siblings.indexOf(element);
    const next = siblings[index + 1] ?? siblings[index - 1];
    const status = (element.closest<HTMLElement>(".column")?.dataset.status as TaskStatus | undefined) ?? null;
    return { cardId: next?.dataset.id ?? "", fallback: status, always: element.contains(document.activeElement) };
  };
  const hideFailedReceipt = (card: KanbanCardModel, outcome: Extract<FieldEditOutcome, { kind: "failed" }>, retry: (() => void) | null) => {
    flash(card.id);
    if (outcome.code === "TASK_HIDE_PROTECTED") show(t("kanban.hideProtected", { title: shortTitle(card) }), undefined, { error: true });
    else show(t("kanban.hideFailed", { title: shortTitle(card), error: outcome.error }), retry ? { label: t("kanban.retry"), run: retry } : undefined, { error: true });
  };
  const hideCard = useCallback((card: KanbanCardModel) => {
    const raw = card.task ? tasksById.current.get(card.task.id) : undefined;
    if (!raw) return;
    const title = shortTitle(card);
    if (card.holdsSeat) {
      show(t("kanban.hideProtected", { title }), undefined, { error: true });
      return;
    }
    pendingCardFocus.current = neighbourOf(card.id);
    const text = card.working ? t("kanban.hiddenReceiptWorking", { title, count: card.working }) : t("kanban.hiddenReceipt", { title });
    const written = settles();
    const entry: HistoryEntry = { kind: "hide", text, tasks: [{ taskId: raw.id, title }], settled: written.promise };
    historyRef.current.record(entry);
    const receiptId = show(text, { label: t("kanban.undo"), run: () => void step("undo", entry) });
    entryReceipts.current.set(entry, receiptId);
    void controller.edit(raw, { field: "hide", value: true, replaces: raw.groupHidden?.at ?? null }).then((outcome) => {
      if (outcome.kind === "saved") entry.lineages = new Map([[raw.id, outcome.lineage]]);
      written.resolve(outcome.kind === "saved");
      if (outcome.kind !== "failed") return;
      dismiss(receiptId);
      hideFailedReceipt(card, outcome, () => {
        const current = cardsByIdRef.current.get(card.id);
        if (current) hideCard(current);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helpers read refs and the card they are given
  }, [controller, dismiss, show, step, t]);
  /* Dismiss (docs/design/needs-attention.md §5): the card stops flagging the
     reasons it drew, on the click, and comes back only when something newer
     asks. Nothing else moves, so the receipt's Undo is the same request with
     `undo`, and a refusal puts the card back and says why. */
  const sendCardDismissal = useCallback((card: KanbanCardModel, undo: boolean) => {
    const { target, subjects } = cardDismissal(card, undo);
    if (!subjects.length) return;
    const title = shortTitle(card);
    const receiptId = undo
      ? null
      : show(t("needs.dismissedReceipt", { title }), { label: t("kanban.undo"), run: () => void sendDismissal(target, subjects, { undo: true, surface: "desktop" }) });
    void sendDismissal(target, subjects, { undo, surface: "desktop" }).then((result) => {
      if (result.ok) {
        /* A lane parked again after the card was drawn: that decision is new,
           and it stays flagged. With nothing else cleared, there is nothing to undo. */
        if (!result.outcome.changed?.length) return;
        if (receiptId && !result.outcome.dismissed.length) dismiss(receiptId);
        show(t("needs.changedReceipt", { title }));
        return;
      }
      if (receiptId) dismiss(receiptId);
      show(t(undo ? "needs.undoFailed" : "needs.dismissFailed", { title, error: result.error }), undefined, { error: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shortTitle reads only its argument
  }, [dismiss, show, t]);
  const dismissCard = useCallback((card: KanbanCardModel) => sendCardDismissal(card, false), [sendCardDismissal]);
  const undoDismissCard = useCallback((card: KanbanCardModel) => sendCardDismissal(card, true), [sendCardDismissal]);
  /* Many groups at once: every card leaves at once, the writes go one task at
     a time, one Undo brings back every group that was hidden, and each task
     the server refuses comes back with its own receipt. Groups with a working
     agent and the seat's group are never in the list. */
  const hideMany = useCallback((cards: readonly KanbanCardModel[], text: string) => {
    const targets = cards.flatMap((card) => {
      const raw = card.task && !card.holdsSeat ? tasksById.current.get(card.task.id) : undefined;
      return raw ? [{ card, raw }] : [];
    });
    if (!targets.length) return;
    let previous: Promise<unknown> = Promise.resolve();
    const outcomes = targets.map(({ raw }) => {
      const outcome = controller.edit(raw, { field: "hide", value: true, replaces: raw.groupHidden?.at ?? null }, { after: previous });
      previous = outcome;
      return outcome;
    });
    /* One entry for the whole bulk: its Undo shows every group this hide hid,
       one write at a time. A group the server refused to hide leaves the
       entry, and each gets its own receipt. */
    const written = settles();
    const entry: HistoryEntry = { kind: "hide", text, tasks: targets.map(({ card, raw }) => ({ taskId: raw.id, title: shortTitle(card) })), settled: written.promise };
    historyRef.current.record(entry);
    const receiptId = show(text, { label: t("kanban.undo"), run: () => void step("undo", entry) });
    entryReceipts.current.set(entry, receiptId);
    void Promise.all(targets.map(({ card, raw }, index) => outcomes[index]!.then((outcome) => {
      if (outcome.kind === "saved") {
        (entry.lineages ??= new Map()).set(raw.id, outcome.lineage);
        return true;
      }
      if (entry.kind === "hide") entry.tasks = entry.tasks.filter((target) => target.taskId !== raw.id);
      if (outcome.kind === "failed") hideFailedReceipt(card, outcome, null);
      return false;
    }))).then((saved) => {
      written.resolve(saved.some(Boolean));
      if (!saved.some(Boolean)) dismiss(receiptId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helpers read refs and the cards they are given
  }, [controller, dismiss, show, step, t]);
  /* The column's own bulk hides, as its menu and the idle divider offer them. */
  const idleToHide = (column: KanbanModel["columns"][TaskStatus]) => column.shown.filter((card) => card.idle && !card.holdsSeat && card.task);
  const hideIdle = (status: TaskStatus) => {
    const idle = idleToHide(modelRef.current.columns[status]);
    hideMany(idle, t("kanban.hiddenIdle", { count: idle.length }));
  };
  useLayoutEffect(() => {
    const wanted = pendingCardFocus.current;
    if (!wanted) return;
    const root = rootRef.current;
    if (!root) return;
    const active = document.activeElement;
    /* Focus is moved only when the operator's own control went away with the
       change, or the change asked for it. */
    if (!wanted.always && active && active !== document.body && root.contains(active)) {
      pendingCardFocus.current = null;
      return;
    }
    const card = wanted.cardId ? root.querySelector<HTMLElement>(`.card[data-id="${cssEscape(wanted.cardId)}"]`) : null;
    const target = card ?? (wanted.fallback ? root.querySelector<HTMLElement>(`[data-colmenu="${wanted.fallback}"]`) : null);
    if (!target) return;
    pendingCardFocus.current = null;
    target.focus({ preventScroll: !card });
    if (card) card.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });

  /* A hidden group that something newer brought back says so once, as it
     happens; one already back when the board opened says it on its card. */
  const hiddenBefore = useRef<ReadonlySet<string>>(new Set());
  /* The first seat read is the board learning the seat, never a designation. */
  const seatKnownBefore = useRef(false);
  useEffect(() => {
    const now = new Set(model.hiddenGroups.flatMap((card) => (card.task ? [card.task.id] : [])));
    for (const { card, reason } of model.resurfaced) {
      const id = card.task?.id;
      if (!id || !hiddenBefore.current.has(id) || edits.get(id)?.hide !== undefined) continue;
      if (reason.kind === "seat" && !seatKnownBefore.current) continue;
      show(t("kanban.resurfacedReceipt", { title: shortTitle(card), reason: resurfaceText(t, reason) }));
    }
    hiddenBefore.current = now;
    seatKnownBefore.current = seatRefs !== null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the model only
  }, [model]);

  /* ── Menus ───────────────────────────────────────────────────────────── */
  const [holdEditing, setHoldEditing] = useState<string | null>(null);
  const statusItems = useCallback((card: KanbanCardModel, hints: boolean): KanbanMenuItem[] => [
    ...KANBAN_STATUSES.map((status): KanbanMenuItem => ({
      type: "radio", id: `status:${status}`, status, label: statusLabel(t, status),
      why: hints ? t(`kanban.statusHint.${status}`) : null,
      checked: card.status === status,
      onSelect: () => move(card, status, { focus: true }),
    })),
    { type: "item", id: "hold", label: t("kanban.hold.edit"), keepFocus: true, onSelect: () => setHoldEditing(card.id) },
  ], [move, t]);
  const menuFor = (): { label: string; items: KanbanMenuItem[] } | null => {
    const open = menu.open;
    if (!open) return null;
    if (open.value.kind === "create") {
      /* The task composer takes focus itself: handing it back to + raced it. */
      const items: KanbanMenuItem[] = [{ type: "item", label: t("dash.newTask"), icon: <ListPlus className="ico" aria-hidden />, keepFocus: true, onSelect: () => openNewTask() }];
      if (props.onNewAgent) {
        const onNewAgent = props.onNewAgent;
        items.push({ type: "item", label: t("dash.newConvo"), icon: <MessageSquarePlus className="ico" aria-hidden />, disabled: !loaded, onSelect: () => onNewAgent() });
      }
      return { label: t("dash.create"), items };
    }
    if (open.value.kind === "column") {
      const status = open.value.status;
      const column = model.columns[status];
      const items: KanbanMenuItem[] = [];
      if (status === "assigned") {
        const idle = idleToHide(column);
        items.push({ type: "item", id: "hideIdle", label: t("kanban.hideIdle", { count: idle.length }), why: t("kanban.hideIdleWhy"), disabled: !idle.length, keepFocus: true, onSelect: () => hideMany(idle, t("kanban.hiddenIdle", { count: idle.length })) });
      }
      if (status === "done") {
        const eligible = column.shown.filter((card) => card.task && !card.holdsSeat);
        const finished = eligible.filter((card) => card.activity === 0);
        const kept = eligible.length - finished.length;
        items.push({
          type: "item",
          id: "hideFinished",
          label: t("kanban.hideFinished", { count: finished.length }),
          why: kept ? t("kanban.hideFinishedKeeps", { count: kept }) : t("kanban.hideFinishedWhy"),
          disabled: !finished.length,
          keepFocus: true,
          onSelect: () => hideMany(finished, kept ? t("kanban.hiddenFinishedKept", { count: finished.length, kept }) : t("kanban.hiddenFinished", { count: finished.length })),
        });
      }
      items.push({
        type: "item",
        id: "showHidden",
        label: t("kanban.showHiddenTasks", { count: hiddenCount }),
        disabled: hiddenCount === 0,
        onSelect: () => {
          const pill = rootRef.current?.querySelector<HTMLElement>("[data-hidden-pill]");
          if (pill) queueMicrotask(() => menu.setOpen({ anchor: pill, value: { kind: "tray" } }));
        },
      });
      return { label: t("kanban.columnActions", { column: statusLabel(t, status) }), items };
    }
    if (open.value.kind === "tray" || open.value.kind === "link" || open.value.kind === "stop" || open.value.kind === "account" || open.value.kind === "links" || open.value.kind === "icon") return null;
    if (open.value.kind === "reader") return readerMenu(open.value.key, open.anchor, open.value.stop);
    if (open.value.kind === "pipeline" || open.value.kind === "stage") return pipelineMenu(open.value);
    const value = open.value;
    const card = cardsById.get(value.cardId);
    if (!card) return null;
    const title = card.titlePending ? t("kanban.untitled") : card.title;
    const common: KanbanMenuItem[] = [
      { type: "sep" },
      { type: "item", id: "prev", label: t("kanban.prevColumn"), kbd: "[", disabled: card.status === "inbox", onSelect: () => shift(card, -1) },
      { type: "item", id: "next", label: t("kanban.nextColumn"), kbd: "]", disabled: card.status === "done", onSelect: () => shift(card, 1) },
    ];
    if (value.kind === "status") {
      return { label: t("kanban.statusOf", { title }), items: [{ type: "head", label: t("kanban.moveTo") }, ...statusItems(card, true), ...common] };
    }
    const swatches: KanbanMenuItem = {
      type: "swatches",
      id: "colour",
      label: t("kanban.colour"),
      value: card.color,
      names: (color) => t(`kanban.color.${color ?? "none"}`),
      hex: TASK_COLOR_HEX,
      onPick: (color) => setColor(card, color),
    };
    if (value.kind === "colour") return { label: t("kanban.colour"), items: [{ type: "head", label: t("kanban.colour") }, swatches] };
    /* Only the Inbox sorts by it, so the hints say where the card goes there. */
    const priorityItems: KanbanMenuItem[] = card.task ? [
      { type: "sep" },
      { type: "head", label: t("kanban.priority") },
      ...TASK_PRIORITIES.map((priority): KanbanMenuItem => ({
        type: "radio",
        id: `priority:${priority}`,
        label: t(`kanban.priority.${priority}`),
        why: priority === "normal" ? null : t(`kanban.priorityHint.${priority}`),
        checked: card.priority === priority,
        onSelect: () => setPriority(card, priority),
      })),
    ] : [];
    /* One ⋯ per card: each lane's actions are a group here, headed by the
       lane's title when the card holds more than one. */
    const laneGroups = card.pipelines.flatMap((entry): KanbanMenuItem[] => {
      const lane = pipelineMenu({ kind: "pipeline", cardId: card.id, pipelineId: entry.pipeline.id }, true);
      if (!lane) return [];
      const head = card.pipelines.length > 1 ? pipelineTitle(t, entry.pipeline) : t("kanban.pipelineAct.menu");
      const group = `lane:${entry.pipeline.id}`;
      return [{ type: "sep" }, { type: "head", label: head, group, note: pipelineStateLabel(t, entry.pipeline.state) }, ...lane.items.filter((entryItem) => entryItem.type !== "head").map((entryItem) => ({ ...entryItem, group }))];
    });
    return {
      label: t("kanban.cardActions", { title }),
      items: [
        { type: "head", label: t("kanban.moveTo") },
        ...statusItems(card, false),
        ...priorityItems,
        { type: "sep" },
        { type: "head", label: t("kanban.colour") },
        swatches,
        { type: "sep" },
        ...(card.task ? [iconItem(card)] : []),
        { type: "item", id: "collapse", label: collapsed.has(card.id) ? t("kanban.expandCardShort") : t("kanban.collapseCardShort"), onSelect: () => toggleCollapsed(card.id) },
        { type: "item", id: "rename", label: t("kanban.rename"), kbd: "Enter", keepFocus: true, onSelect: () => startEdit(card, "title") },
        { type: "item", id: "describe", label: card.description ? t("kanban.editDescription") : t("kanban.addDescription"), kbd: "E", keepFocus: true, onSelect: () => startEdit(card, "description") },
        ...(card.task ? [linksItem({ kind: "task", id: card.task.id })] : []),
        ...laneGroups,
        { type: "sep" },
        card.holdsSeat
          ? { type: "item", id: "hide", label: t("kanban.hideFromBoard"), why: t("kanban.seatProtected"), disabled: true, onSelect: () => {} }
          : { type: "item", id: "hide", label: t("kanban.hideFromBoard"), kbd: "H", why: card.working ? t("kanban.hideWhyWorking", { count: card.working }) : t("kanban.hideWhy"), note: card.working ? t("kanban.hideNoteWorking", { count: card.working }) : t("kanban.hideNote"), keepFocus: true, onSelect: () => hideCard(card) },
      ],
    };
  };
  /* #2102: the icon picker opens from the card's own icon, where the eye goes. */
  const iconItem = (card: KanbanCardModel): KanbanMenuItem => ({
    type: "item",
    id: "icon",
    label: t("kanban.icon"),
    kbd: "I",
    keepFocus: true,
    onSelect: () => {
      const own = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-icon-menu]") ?? [])].find((element) => element.dataset.iconMenu === card.id);
      const anchor = own ?? menu.open?.anchor;
      if (anchor) queueMicrotask(() => menu.setOpen({ anchor, value: { kind: "icon", cardId: card.id } }));
    },
  });
  /* #2059: the attach form opens where the menu was, over the same anchor. */
  const linksItem = (target: WorkLinkTarget, label = t("workLinks.attach")): KanbanMenuItem => {
    const anchor = menu.open?.anchor;
    return {
      type: "item",
      id: "links",
      label,
      keepFocus: true,
      disabled: !anchor,
      onSelect: () => { if (anchor) queueMicrotask(() => menu.setOpen({ anchor, value: { kind: "links", target } })); },
    };
  };
  /* ── A pipeline's actions, and a stage's (prototype `openPipelineMenu`, pane ⋯) ─ */
  const refusalWhy = (option: PipelineActionOption): string | null => (option.refusal ? t(`kanban.pipelineAct.refusal.${option.refusal}`) : null);
  const pipelineMenu = (
    value: { kind: "pipeline"; cardId: string; pipelineId: string } | { kind: "stage"; cardId: string; pipelineId: string; stageId: string; from: "sheet" | "panel" },
    inCardMenu = false,
  ): { label: string; items: KanbanMenuItem[] } | null => {
    const card = cardsById.get(value.cardId) ?? cards.find((candidate) => candidate.pipelines.some((entry) => entry.pipeline.id === value.pipelineId));
    const summary = card?.pipelines.find((entry) => entry.pipeline.id === value.pipelineId);
    if (!card || !summary) return null;
    const { pipeline } = summary;
    const names = stageNames(t, pipeline);
    const title = card.titlePending ? t("kanban.untitled") : card.title;
    const options = new Map(pipelineActionOptions(pipeline).map((option) => [option.action, option] as const));
    const busy = acting.get(pipeline.id);
    const item = (option: PipelineActionOption, label: string, why: string | null): KanbanMenuItem => {
      const stageName = option.stageId ? names.get(option.stageId) ?? option.stageId : null;
      return {
        type: "item",
        label,
        why: busy ? t("kanban.pipelineAct.busy", { action: t(`kanban.pipelineAct.pending.${busy}`) }) : refusalWhy(option) ?? why,
        disabled: Boolean(busy) || option.refusal !== null,
        onSelect: () => startPipelineAction({ pipelineId: pipeline.id, title, action: option.action, stageId: option.stageId, stageName, expectedAttempt: option.attempt }),
      };
    };
    const retry = options.get("retry-stage")!;
    const skip = options.get("skip-stage")!;
    if (value.kind === "stage") {
      const stage = pipeline.stages.find((entry) => entry.id === value.stageId);
      if (!stage) return null;
      const name = names.get(stage.id) ?? stage.id;
      /* Retry and skip act on the stage the pipeline waits on, so a pane offers them only for that stage. */
      const forStage = (option: PipelineActionOption): PipelineActionOption => (option.refusal || option.stageId === stage.id ? option : { ...option, refusal: "other-stage" });
      const items: KanbanMenuItem[] = [{ type: "head", label: t("kanban.stages.stageMenuHead", { stage: name }) }];
      if (stageDraftable(pipeline, stage.id)) {
        const anchor = menu.open?.anchor;
        items.push({
          type: "item",
          label: t("kanban.draft.editMenu"),
          keepFocus: true,
          onSelect: () => {
            /* A folded panel opens, so the field it edits is there to take focus. */
            if (value.from === "panel") foldStagePanel(stagePanelKey(value.cardId, pipeline.id, stage.id), false);
            stageDrafts.begin(pipeline.id, stage.id, stagePromptExtra(stage.prompt));
          },
        });
        /* K6: the first turn's account, chosen in the stage's account picker. */
        if (anchor) {
          items.push({
            type: "item",
            label: t("kanban.account.menuChoose"),
            keepFocus: true,
            onSelect: () => queueMicrotask(() => menu.setOpen({ anchor, value: { kind: "account", target: { kind: "stage", pipelineId: pipeline.id, stageId: stage.id } } })),
          });
        }
      }
      items.push(
        item(forStage(retry), t("kanban.stages.retryThis"), t("kanban.pipelineAct.retryWhy")),
        item(forStage(skip), t("kanban.stages.skipThis"), t("kanban.pipelineAct.skipWhy")),
      );
      if (value.from === "panel") {
        items.push({ type: "sep" }, { type: "item", label: t("kanban.stages.showInStages"), keepFocus: true, onSelect: () => openSheet(card.id, pipeline, stage.id) });
      }
      return { label: t("kanban.stages.stageActions", { stage: name }), items };
    }
    const pauseOrResume = options.get("resume") ?? options.get("pause")!;
    const decision = retry.stageId ? names.get(retry.stageId) ?? retry.stageId : null;
    /* #2187 §6: whether this lane finishes the card's task, with the count of
       other open lanes Done would wait for, checked or not. */
    const taskId = card.task?.id ?? null;
    const finish = finishesTaskOffer(pipeline, taskId, card.pipelines.map((entry) => entry.pipeline));
    const finishItems: KanbanMenuItem[] = finish && taskId ? [{
      type: "check",
      label: t("pipelineBlock.finish.menu"),
      checked: finish.checked,
      why: t("pipelineBlock.finish.menuWhy"),
      warn: finish.open ? t("pipelineBlock.finish.menuOpen", { count: finish.open }) : null,
      disabled: Boolean(busy),
      onSelect: () => void toggleFinishesTask(pipelinePorts, pipeline, taskId, pipelineTitle(t, pipeline), t, (text, error) => show(text, undefined, error ? { error: true } : undefined)),
    }] : [];
    return {
      label: t("kanban.pipelineAct.menu"),
      items: [
        { type: "head", label: t("kanban.pipelineAct.menu") },
        { type: "item", label: t("kanban.stages.expandTitle"), keepFocus: true, onSelect: () => openSheet(card.id, pipeline) },
        /* In the card's ⋯ the task's own Attach sits a few rows up, so the lane's names what it attaches to. */
        linksItem({ kind: "pipeline", id: pipeline.id }, inCardMenu ? t("workLinks.attachPipeline") : undefined),
        item(pauseOrResume, t(`kanban.pipelineAct.label.${pauseOrResume.action}`, { title, stage: "" }), pauseOrResume.action === "pause" ? t("kanban.pipelineAct.pauseWhy") : null),
        item(retry, decision ? t("kanban.pipelineAct.retryStage", { stage: decision }) : t("kanban.pipelineAct.retryAny"), t("kanban.pipelineAct.retryWhy")),
        item(skip, decision ? t("kanban.pipelineAct.skipStage", { stage: decision }) : t("kanban.pipelineAct.skipAny"), t("kanban.pipelineAct.skipWhy")),
        ...finishItems,
        { type: "sep" },
        item(options.get("close")!, t("kanban.pipelineAct.label.close", { title, stage: "" }), t("kanban.pipelineAct.closeWhy")),
      ],
    };
  };

  /* ── A reader's actions: link, and Link / Unlink ──────────────────────── */
  const conversationName = (view: ReaderView) => cleanTitle(view.file.title ?? "", 48) || view.owner?.cardTitle || t("kanban.untitledConversation");
  const readerMenu = (key: string, anchor: HTMLElement, stop: ReaderStop): { label: string; items: KanbanMenuItem[] } | null => {
    const view = readerViews.find((candidate) => candidate.readerKey === key);
    if (!view) return null;
    const card = view.owner ? cardsById.get(view.owner.cardId) : undefined;
    const task = card?.task ?? null;
    const ref = task ? assignmentRefFor(task, view.file) : null;
    const name = conversationName(view);
    return {
      label: t("kanban.readerActions"),
      items: [
        {
          type: "item",
          id: "copyLink",
          label: t("kanban.readerCopyLink"),
          onSelect: () => {
            const link = `${location.origin}${location.pathname}${formatConversationHash({ conversationId: view.file.conversationId ?? undefined, path: view.file.path })}`;
            void navigator.clipboard?.writeText(link).then(() => show(t("kanban.linkCopied", { conversation: name })), () => undefined);
          },
        },
        ...(props.onHandoff && canHandoff(view.file) ? [{
          type: "item" as const,
          id: "handoff",
          label: t("kanban.handoff"),
          why: t("kanban.handoffWhy"),
          onSelect: () => props.onHandoff?.(view.file, view.owner?.cardId ?? null),
        }] : []),
        { type: "sep" },
        {
          type: "item",
          id: "link",
          label: t("kanban.linkToTask"),
          why: t("kanban.linkToTaskWhy"),
          note: t("kanban.linkToTaskNote"),
          onSelect: () => {
            setLinkQuery("");
            queueMicrotask(() => menu.setOpen({ anchor, value: { kind: "link", key } }));
          },
        },
        {
          type: "item",
          id: "unlink",
          label: t("kanban.unlink"),
          why: task && !ref ? t("kanban.unlinkThroughPipeline") : t("kanban.unlinkWhy"),
          disabled: !task || !ref,
          onSelect: () => {
            if (!task || !ref) return;
            const taskTitle = card?.titlePending ? t("kanban.untitled") : card?.title ?? "";
            void assignments.unlink(task.id, ref).then((answer) => {
              if (answer.ok) show(t("kanban.unlinked", { conversation: name, task: taskTitle }));
              else if (answer.status === 409) show(t("kanban.unlinkOwn", { conversation: name, task: taskTitle }), undefined, { error: true });
              else show(t("kanban.unlinkFailed", { conversation: name, error: answer.error }), undefined, { error: true });
            });
          },
        },
        ...(props.onCloseConversation ? [
          { type: "sep" as const },
          {
            type: "item" as const,
            id: "closeOnBoard",
            label: t("kanban.closeOnBoard"),
            why: t("kanban.closeOnBoardWhy"),
            onSelect: () => {
              const file = view.file;
              closeReaderFor(key);
              props.onCloseConversation?.(file);
              show(t("kanban.closedReceipt", { conversation: name }), props.onRestoreConversation ? { label: t("kanban.undo"), run: () => props.onRestoreConversation?.(file) } : undefined);
            },
          },
        ] : []),
        ...(stop.state === "hidden" ? [] : [
          { type: "sep" as const },
          {
            type: "item" as const,
            id: "stopHost",
            label: t("task.kill"),
            why: stop.state === "disabled" ? stop.reason : t("kanban.stopHostWhy"),
            disabled: stop.state === "disabled",
            onSelect: () => queueMicrotask(() => menu.setOpen({ anchor, value: { kind: "stop", key } })),
          },
        ]),
      ],
    };
  };
  const linkTo = (view: ReaderView, task: BoardTask) => {
    const name = conversationName(view);
    const taskTitle = task.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled");
    void assignments.link(task.id, view.file.path).then((answer) => {
      if (answer.ok) show(t("kanban.linked", { conversation: name, task: taskTitle }));
      else show(t("kanban.linkFailed", { conversation: name, error: answer.error }), undefined, { error: true });
    });
  };

  const openStatusMenu = useCallback((card: KanbanCardModel, anchor: HTMLElement) => menu.setOpen({ anchor, value: { kind: "status", cardId: card.id } }), [menu]);
  const openCardMenu = useCallback((card: KanbanCardModel, anchor: HTMLElement) => menu.setOpen({ anchor, value: { kind: "card", cardId: card.id } }), [menu]);
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /* ── Keyboard on a card ──────────────────────────────────────────────── */
  const onCardKey = useCallback((card: KanbanCardModel, event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const element = event.currentTarget;
    const key = event.key;
    if (key === "[" && card.task) { event.preventDefault(); shift(card, -1); }
    else if (key === "]" && card.task) { event.preventDefault(); shift(card, 1); }
    else if (key === "Enter" && card.task) { event.preventDefault(); startEdit(card, "title"); }
    else if ((key === "e" || key === "E") && card.task) { event.preventDefault(); startEdit(card, "description"); }
    else if ((key === "h" || key === "H") && card.task) { event.preventDefault(); hideCard(card); }
    else if ((key === "c" || key === "C") && card.task) {
      event.preventDefault();
      const more = element.querySelector<HTMLElement>("[data-menu]");
      if (more) menu.setOpen({ anchor: more, value: { kind: "colour", cardId: card.id } });
    }
    else if ((key === "i" || key === "I") && card.task) {
      event.preventDefault();
      const icon = element.querySelector<HTMLElement>("[data-icon-menu]");
      if (icon) openIconMenu(card, icon);
    }
    else if ((key === "s" || key === "S") && card.task) {
      /* The column names the status, so its menu opens from the card's ⋯. */
      event.preventDefault();
      const more = element.querySelector<HTMLElement>("[data-menu]");
      if (more) openStatusMenu(card, more);
    } else if ((key === "m" || key === "M") && card.task) {
      event.preventDefault();
      const more = element.querySelector<HTMLElement>("[data-menu]");
      if (more) openCardMenu(card, more);
    } else if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      const cards = [...(element.closest(".col-body")?.querySelectorAll<HTMLElement>(".card") ?? [])];
      cards[cards.indexOf(element) + (key === "ArrowDown" ? 1 : -1)]?.focus();
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      const columns = [...(rootRef.current?.querySelectorAll<HTMLElement>(".column") ?? [])];
      const target = columns[columns.indexOf(element.closest<HTMLElement>(".column")!) + (key === "ArrowRight" ? 1 : -1)];
      if (!target) return;
      const rows = [...(element.closest(".col-body")?.querySelectorAll<HTMLElement>(".card") ?? [])];
      const index = rows.indexOf(element);
      const status = target.dataset.status as TaskStatus;
      if (mode === "tabs") setTab(status);
      queueMicrotask(() => {
        const destination = [...(rootRef.current?.querySelectorAll<HTMLElement>(`.column[data-status="${status}"] .card`) ?? [])];
        (destination[Math.min(index, destination.length - 1)] ?? rootRef.current?.querySelector<HTMLElement>(`[data-colmenu="${status}"]`))?.focus();
      });
    }
  }, [mode, openCardMenu, openStatusMenu, shift, startEdit, hideCard, menu]);

  /* ── Pointer drag to a column ────────────────────────────────────────── */
  /* The whole card is the handle (cardDrag.ts): a press anywhere but a text
     field or a reader starts a drag after 8 px, and a click without movement
     does what it always did. The ghost and the hint are drawn by hand, so a
     drag renders nothing in React. */
  const draggingCard = useRef(false);
  const dragHintText = t("kanban.dragHint");
  const onCardPointerDown = useCallback((card: KanbanCardModel, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.pointerType === "touch" || !card.task || !rootRef.current) return;
    if (!isCardHandle({ target: event.target, offsetX: event.nativeEvent.offsetX })) return;
    startCardGesture({
      element: event.currentTarget,
      root: rootRef.current,
      status: card.status,
      event,
      hint: dragHintText,
      onDrop: (to) => move(card, to),
      onActive: (active) => { draggingCard.current = active; },
    });
  }, [move, dragHintText]);

  /* ── Keys: undo and redo, find ───────────────────────────────────────── */
  /* The Stages sheet stands over the board: while it is open, no key the
     board answers reaches behind it. */
  const sheetOpen = useRef(false);
  sheetOpen.current = sheet !== null;
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menu.open !== null;
  const seatToggleRef = useRef<(() => void) | null>(null);
  seatToggleRef.current = seatView ? seatFrame.toggle : null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      /* Ctrl/Cmd+Z undoes the operator's last edit, Ctrl/Cmd+Shift+Z and
         Ctrl+Y redo it (#1856). A field, the composer, a dialog or a menu keeps
         the chord for itself, and an empty stack leaves it to the browser. */
      /* A layout without Latin letters (Ukrainian gives «я» and «н» on some
         platforms) names the chord by its physical key, as J/K does. */
      const key = event.key.toLowerCase();
      const letter = /^[a-z]$/.test(key) ? key : event.code === "KeyZ" ? "z" : event.code === "KeyY" ? "y" : "";
      const chord = (event.ctrlKey || event.metaKey) && !event.altKey ? letter : "";
      const direction = chord === "z" ? (event.shiftKey ? "redo" : "undo") : chord === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey ? "redo" : null;
      if (direction) {
        if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']")) return;
        if (sheetOpen.current || menuOpenRef.current) return;
        const inside = Boolean(target && rootRef.current?.contains(target) && !target.closest(VIEWER_OWNED));
        if (!inside && target !== document.body) return;
        if (step(direction)) event.preventDefault();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      /* The bar's two ends and the island slot hold the Viewer's own controls (the project, its
         accounts, the panel toggles, ⋯ and the attention island): the board's keys stay out of
         them, as they stay out of the aside, so `/` and `u` mean there what they mean outside. */
      const inBoard = Boolean(target && rootRef.current?.contains(target) && !target.closest(VIEWER_OWNED));
      if (event.key === "/") {
        /* Outside the board `/` stays the Viewer's global search. Inside it,
           it finds a task, and the Viewer's window listener must not open
           the search palette over the field it just focused. Under the open
           sheet it does neither. */
        if (!inBoard) return;
        event.preventDefault();
        event.stopPropagation();
        if (!sheetOpen.current) rootRef.current?.querySelector<HTMLInputElement>("[data-kanban-search]")?.focus();
      } else if (event.key === "o" || event.key === "O") {
        /* `O` collapses and expands the orchestrator seat (#1841), in either
           placement, unless a sheet, a menu or a popover holds the keys. */
        if (!seatToggleRef.current || sheetOpen.current || menuOpenRef.current) return;
        if (!inBoard && target !== document.body) return;
        if (target?.closest("[role='dialog'], [role='menu']")) return;
        event.preventDefault();
        seatToggleRef.current();
      } else if (event.key === "u" || event.key === "U") {
        /* The single-key alias of Ctrl+Z, kept from before the history. */
        if (sheetOpen.current || menuOpenRef.current) return;
        if (!inBoard && target !== document.body) return;
        if (target?.closest("[role='dialog'], [role='menu']")) return;
        if (step("undo")) event.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step]);

  /* ── Opening what a card holds ───────────────────────────────────────── */
  /* The card to bring into view once React has committed. */
  const pendingReveal = useRef<{ cardId: string; focusSelector?: string } | null>(null);
  /* Going to a card leaves the agent window first, so it never stays over the
     card the operator went to. */
  const revealCard = useCallback((cardId: string, focusSelector?: string) => {
    if (windowAgentRef.current) setWindow(null, null);
    const card = cardsByIdRef.current.get(cardId);
    if (card) {
      setCollapsed((current) => {
        if (!current.has(cardId)) return current;
        const next = new Set(current);
        next.delete(cardId);
        return next;
      });
      if (query && !cardMatchesShown(modelRef.current, card)) setQuery("");
      if (modeRef.current === "tabs") setTab(card.status);
    }
    pendingReveal.current = { cardId, focusSelector };
    setRevealTick((tick) => tick + 1);
  }, [query, setWindow]);
  /* The agent each attention request's handoff opened, so that request's
     Return closes exactly that one. An agent that was already open is not the
     handoff's to touch. Any gesture of the operator's on that agent makes it
     theirs again. */
  const handoffOwned = useRef(new Map<string, { key: string }>());
  const disown = useCallback((key: string) => {
    for (const [requestId, owned] of handoffOwned.current) if (owned.key === key) handoffOwned.current.delete(requestId);
  }, []);
  /* What the seat names, for the handlers that must not re-bind on a new answer. */
  const seatRefsRef = useRef(seatRefs);
  useLayoutEffect(() => { seatRefsRef.current = seatRefs; }, [seatRefs]);
  /* Every conversation opens in the agent window and joins its list at the
     end; one already open is shown where it stands in the list. The board
     under the window does not move. */
  const openReaderFor = useCallback((file: FileEntry, options: { focus?: boolean; handoff?: boolean; landing?: boolean } = {}) => {
    const key = conversationIdentity(file);
    if (!options.handoff) disown(key);
    openedFrom.current = null;
    memory.update((readers) => openReader(readers, key, file.path));
    /* The seat's conversation is never the context the operator selected for
       its own composer, so opening it leaves the selection where it was. */
    if (!isCurrentSeatConversation(seatRefsRef.current, file)) setFocusedReader(key);
    onConversationOpened?.(file.path);
    focusOnShow.current = options.focus !== false;
    /* A launch shows its agent at once, in the commit its draft leaves the
       card, so the board settles under the window and not before it. */
    setWindow(key, options.landing ? key : undefined);
  }, [memory, onConversationOpened, disown, setWindow]);
  useLayoutEffect(() => {
    openFromSeatRef.current = (file, from, placeholder) => {
      /* Its conversation draws no tile, so the board may not have read it yet. */
      lastSeenFiles.current.set(conversationIdentity(file), file);
      if (placeholder) setSeatPlaceholder({ key: conversationIdentity(file), text: placeholder });
      openReaderFor(file);
      openedFrom.current = from;
    };
  }, [openReaderFor]);
  const [revealTick, setRevealTick] = useState(0);
  useLayoutEffect(() => {
    const wanted = pendingReveal.current;
    if (!wanted) return;
    pendingReveal.current = null;
    const target = rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(wanted.cardId)}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    if (wanted.focusSelector) target.querySelector<HTMLElement>(wanted.focusSelector)?.focus({ preventScroll: true });
  }, [revealTick]);
  /* The agent brought into the window takes the keyboard, when it was opened
     or switched to by the operator. */
  useLayoutEffect(() => {
    if (!shown || !focusOnShow.current) return;
    focusOnShow.current = false;
    const reader = placement.slotOf(shown)?.querySelector<HTMLElement>("[data-kanban-reader]");
    /* A reader that came back with its own focus (its composer, its caret) keeps it. */
    if (reader && !reader.contains(document.activeElement)) reader.focus({ preventScroll: true, ...(keyedLast ? {} : { focusVisible: false }) });
  }, [shown, placement]);
  const ownersRef = useRef(owners);
  ownersRef.current = owners;
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  const modelRef = useRef(model);
  modelRef.current = model;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  /* A conversation an attempt or a review round recorded: its reader when the
     board carries its transcript. One this board does not carry (an older
     attempt the scheme window left out) opens through the Viewer's own
     conversation link, whose resolver pins the transcript for the next poll.
     No view preference is written. */
  const openRecorded = useCallback((conversation: { path: string | null; conversationId: string | null }) => {
    const file = (conversation.path ? filesByPath.get(conversation.path) : undefined)
      ?? (conversation.conversationId ? files.find((entry) => entry.conversationId === conversation.conversationId) : undefined);
    if (file) {
      openReaderFor(file);
      return;
    }
    if (conversation.conversationId || conversation.path) {
      location.hash = formatConversationHash({ conversationId: conversation.conversationId ?? undefined, path: conversation.path ?? "" });
    }
  }, [files, filesByPath, openReaderFor]);
  /* A node or chip opens what its stage has: the latest own attempt's
     conversation, or, for a stage that has not started, its first message in
     a panel on the card (prototype `openStage`). */
  const pendingPanelFocus = useRef<string | null>(null);
  const openStage = useCallback((pipeline: Pipeline, stage: PipelineStage, cardId?: string) => {
    const attempt = latestAttempt(pipeline, stage.id);
    if (attempt) {
      openRecorded({ path: attempt.agentPath, conversationId: attempt.conversationId });
      return;
    }
    if (!cardId || !stageDraftable(pipeline, stage.id)) return;
    const key = stagePanelKey(cardId, pipeline.id, stage.id);
    setStagePanels((current) => withEntry(current, key, { cardId, pipelineId: pipeline.id, stageId: stage.id, folded: false }));
    pendingPanelFocus.current = key;
    revealCard(cardId);
  }, [openRecorded, revealCard]);
  useLayoutEffect(() => {
    const key = pendingPanelFocus.current;
    if (!key) return;
    const panel = rootRef.current?.querySelector<HTMLElement>(`[data-stage-detail="${cssEscape(key)}"]`);
    if (!panel) return;
    pendingPanelFocus.current = null;
    panel.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    panel.focus({ preventScroll: true });
  });
  const foldStagePanel = useCallback((key: string, folded: boolean) => {
    setStagePanels((current) => {
      const panel = current.get(key);
      return panel && panel.folded !== folded ? withEntry(current, key, { ...panel, folded }) : current;
    });
  }, []);
  const closeStagePanel = useCallback((key: string) => {
    const cardId = stagePanels.get(key)?.cardId;
    setStagePanels((current) => withEntry(current, key, undefined));
    if (cardId) queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`)?.focus({ preventScroll: true }));
  }, [stagePanels]);
  const openStagePanelMenu = useCallback((key: string, anchor: HTMLElement) => {
    const panel = stagePanels.get(key);
    if (panel) menu.setOpen({ anchor, value: { kind: "stage", cardId: panel.cardId, pipelineId: panel.pipelineId, stageId: panel.stageId, from: "panel" } });
  }, [stagePanels, menu]);
  /* A draft the stage's record makes moot goes, wherever it was open: the
     stage started with its words, or its words were never changed. */
  useEffect(() => {
    const byId = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline] as const));
    for (const [key, draft] of stageDrafts.entries()) {
      const pipeline = byId.get(draft.pipelineId);
      if (pipeline) stageDrafts.settleFromStage(key, pipeline);
    }
  }, [pipelines, draftsVersion, stageDrafts]);
  /* When a waiting stage starts, its panel leaves the card and the stage's
     conversation joins the agent window's list. A draft the start overtook keeps the panel, which
     says the draft was not delivered, until the operator lets it go. A panel
     whose pipeline left the board goes with it. */
  useEffect(() => {
    if (!stagePanels.size) return;
    let next = stagePanels;
    const promoted: FileEntry[] = [];
    for (const [key, panel] of stagePanels) {
      const summary = cards.flatMap((card) => card.pipelines).find((entry) => entry.pipeline.id === panel.pipelineId);
      const stage = summary?.pipeline.stages.find((entry) => entry.id === panel.stageId);
      if (!summary || !stage) {
        next = withEntry(next, key, undefined);
        continue;
      }
      const draft = stageDrafts.get(stageDraftKey(panel.pipelineId, panel.stageId));
      if (stageNotStarted(summary.pipeline, stage.id) || (draft && draftOutcome(summary.pipeline, stage.id, draft) !== "included")) continue;
      const attempt = latestAttempt(summary.pipeline, stage.id);
      const file = attempt ? (attempt.agentPath ? filesByPath.get(attempt.agentPath) : undefined) ?? (attempt.conversationId ? filesByConversation.get(attempt.conversationId) : undefined) : undefined;
      /* The attempt's conversation is not on the board yet: the panel waits for it. */
      if (!file) continue;
      next = withEntry(next, key, undefined);
      promoted.push(file);
    }
    if (next !== stagePanels) setStagePanels(next);
    if (promoted.length) {
      memory.update((readers) => promoted.reduce<OpenReader[]>((current, file) => openReader(current, conversationIdentity(file), file.path), [...readers]));
    }
  }, [stagePanels, cards, draftsVersion, stageDrafts, filesByPath, filesByConversation, memory]);
  const panelsByCard = useMemo(() => {
    const byCard = new Map<string, string[]>();
    for (const panel of stagePanels.values()) {
      const lines = byCard.get(panel.cardId) ?? [];
      lines.push(`${panel.pipelineId}\t${panel.stageId}\t${panel.folded ? "1" : "0"}`);
      byCard.set(panel.cardId, lines);
    }
    return new Map([...byCard].map(([cardId, lines]) => [cardId, lines.join("\n")] as const));
  }, [stagePanels]);

  /* ── The Stages sheet ─────────────────────────────────────────────────── */
  const openSheet = useCallback((cardId: string, pipeline: Pipeline, stageId?: string) => {
    const summary = cardsByIdRef.current.get(cardId)?.pipelines.find((entry) => entry.pipeline.id === pipeline.id);
    const focus = stageId ?? (summary ? currentStageId(summary.pipeline, summary.views) : null);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSheet({ cardId, pipelineId: pipeline.id, focus, opener });
  }, []);
  const closeSheet = useCallback(() => {
    setSheet((current) => {
      if (current) {
        const { opener, cardId, pipelineId } = current;
        /* Back to what opened the sheet, else the card's own Stages button. */
        queueMicrotask(() => {
          const root = rootRef.current;
          const card = root?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`);
          const button = card?.querySelector<HTMLElement>(`[data-open-stages="${cssEscape(pipelineId)}"]`);
          /* An opener that went to the park with its reader is not on screen to take focus. */
          const back = opener?.isConnected && opener !== document.body && root?.contains(opener) && !opener.closest(".reader-park")
            ? opener
            : button ?? card ?? root?.querySelector<HTMLElement>(".board-frame");
          back?.focus({ preventScroll: true });
        });
      }
      return null;
    });
  }, []);
  /* A pipeline no card holds any more takes its sheet with it. */
  useEffect(() => {
    if (sheet && !sheetSummary) closeSheet();
  }, [sheet, sheetSummary, closeSheet]);
  const foldPanes = useCallback((pipelineId: string, stageIds: readonly string[], folded: boolean) => {
    setPaneFolds((current) => {
      const next = new Set(current);
      for (const stageId of stageIds) {
        if (folded) next.add(stageDraftKey(pipelineId, stageId));
        else next.delete(stageDraftKey(pipelineId, stageId));
      }
      return next;
    });
  }, []);

  /* ── Pipeline actions over the pipeline route (`usePipelineActions`) ──── */
  const { acting, start: startPipelineAction } = usePipelineActions(pipelinePorts, show, t);
  /* K6: the account of a waiting stage's first turn, and of a conversation. */
  const accountChoice = useAccountChoices(pipelinePorts, show, t, useCallback((target: AccountTarget, anchor: HTMLElement) => menu.setOpen({ anchor, value: { kind: "account", target } }), [menu]));
  const actingByCard = useMemo(() => {
    const byCard = new Map<string, string>();
    if (!acting.size) return byCard;
    for (const card of cards) {
      const lines = card.pipelines.flatMap((entry) => (acting.has(entry.pipeline.id) ? [`${entry.pipeline.id}\t${acting.get(entry.pipeline.id)}`] : []));
      if (lines.length) byCard.set(card.id, lines.join("\n"));
    }
    return byCard;
  }, [acting, cards]);
  const flowsById = useMemo(() => new Map(props.flows.map((flow) => [flow.id, flow] as const)), [props.flows]);
  const openPipelineMenu = useCallback((cardId: string, pipeline: Pipeline, anchor: HTMLElement) => {
    menu.setOpen({ anchor, value: { kind: "pipeline", cardId, pipelineId: pipeline.id } });
  }, [menu]);
  /* A lane row's answer in place (#2072): the same intent the ⋯ menu sends,
     with Skip and Close held for their receipt's window. */
  const answerPipeline = useCallback((_cardId: string, title: string, pipeline: Pipeline, answer: PipelineAnswer) => {
    startPipelineAction(
      { pipelineId: pipeline.id, title, action: answer.action, stageId: answer.stageId, stageName: answer.stageName, expectedAttempt: answer.expectedAttempt },
      { hold: answer.action === "skip-stage" || answer.action === "close" },
    );
  }, [startPipelineAction]);
  const openWorkLinks = useCallback((target: WorkLinkTarget, anchor: HTMLElement) => {
    menu.setOpen({ anchor, value: { kind: "links", target } });
  }, [menu]);
  /* Closing one agent closes nothing else. Closing the one in the window
     brings its neighbour into the same reader (the next, or the previous at
     the end), so the window never leaves the screen: in the same commit when
     the neighbour has read, as it has when it waited laid out in the park.
     One that has not (never shown, or its saved tail gone) reads first, the
     way a switch does, and the agent closed stays in the reader until then,
     out of the list. The last one closes the window. */
  const closeReaderFor = useCallback((key: string) => {
    disown(key);
    const agent = windowAgentRef.current;
    const onScreen = shownRef.current;
    if (agent && (agent === key || onScreen === key)) {
      const keys = windowKeysRef.current;
      const at = keys.indexOf(key);
      const neighbour = at < 0 ? null : keys[at + 1] ?? keys[at - 1] ?? null;
      /* An agent still on its way into the reader stays asked for. */
      const next = agent === key ? neighbour : agent;
      if (onScreen === key && next && !readerReady(placement.containerOf(next))) {
        setWindow(next);
        setClosing({ key, memory });
        return;
      }
      setWindow(next, onScreen === key ? next : onScreen);
      if (!next) focusAfterWindow(".board-frame");
    }
    memory.update((readers) => closeReader(readers, key));
  }, [memory, disown, setWindow, placement, focusAfterWindow]);
  const openReaderMenu = useCallback((key: string, anchor: HTMLElement, stop: ReaderStop) => menu.setOpen({ anchor, value: { kind: "reader", key, stop } }), [menu]);

  /* A conversation the Viewer was asked to open lands in its reader. */
  const focusTarget = props.focus ?? null;
  const focusNonce = props.focusNonce;
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.startsWith("task::")) {
      const cardId = `task:${focusTarget.slice("task::".length)}`;
      if (cardsByIdRef.current.has(cardId)) revealCard(cardId);
      return;
    }
    /* A pipeline link: the card that holds the pipeline, revealed and focused. */
    if (focusTarget.startsWith("group::pipeline::")) {
      const cardId = anchorsRef.current.get(focusTarget);
      if (cardId) {
        revealCard(cardId);
        focusCard(cardId);
      }
      return;
    }
    if (focusTarget.startsWith("draft::")) {
      const id = focusTarget.slice("draft::".length);
      const holder = [...cardsByIdRef.current.values()].find((card) => card.drafts.includes(id));
      if (holder) revealCard(holder.id, `[data-kanban-draft="${cssEscape(id)}"] textarea`);
      return;
    }
    const file = filesByPath.get(focusTarget);
    if (!file) return;
    /* On its card, or, for a conversation no card holds, as a reader of its own in the window. */
    openReaderFor(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one open per request
  }, [focusTarget, focusNonce]);

  const focusCard = useCallback((cardId: string) => {
    const card = cardsById.get(cardId);
    if (card && mode === "tabs") setTab(card.status);
    queueMicrotask(() => {
      const element = rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`);
      element?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      element?.focus({ preventScroll: true });
      if (element) flash(cardId);
    });
  }, [cardsById, flash, mode]);

  /* A wire of the seat's goes to its card the way a pipeline link does. */
  const jumpToWiredCard = useCallback((taskId: string) => {
    revealCard(`task:${taskId}`);
    focusCard(`task:${taskId}`);
  }, [revealCard, focusCard]);

  /* ── Presence: what the operator can actually see ────────────────────── */
  /* A card counts as seen when it intersects its column's scroll box, the
     board and the window, in a column that is displayed (one tab at a time on
     a tabbed board). Measured after each render, on a resize, and around a
     scroll — throttled while it runs and settled once it stops. */
  /* Kept out of React state (#1546): the measurement feeds the presence report
     and nothing the board draws, so writing it into state re-rendered the board
     and every column on each scroll frame for a value no card reads. The ref
     holds it and the report runs straight from the measurement. */
  const visibleCardsRef = useRef("");
  const reportPresenceRef = useRef<() => void>(() => {});
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    let timer = 0;
    let measuredAt = 0;
    const measure = () => {
      frame = 0;
      // The final visibility scan runs after the helper releases its layers.
      if (root.hasAttribute("data-column-layout")) return;
      measuredAt = performance.now();
      const rootRect = root.getBoundingClientRect();
      const ids: string[] = [];
      root.querySelectorAll<HTMLElement>(".column[data-status]").forEach((column) => {
        if (window.getComputedStyle(column).display === "none") return;
        const body = column.querySelector<HTMLElement>(".col-body");
        if (!body) return;
        const box = body.getBoundingClientRect();
        const top = Math.max(box.top, rootRect.top, 0);
        const bottom = Math.min(box.bottom, rootRect.bottom, window.innerHeight);
        const left = Math.max(box.left, rootRect.left, 0);
        const right = Math.min(box.right, rootRect.right, window.innerWidth);
        if (bottom <= top || right <= left) return;
        body.querySelectorAll<HTMLElement>(".card[data-id]").forEach((card) => {
          const rect = card.getBoundingClientRect();
          if (rect.width > 0 && rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right) ids.push(card.dataset.id!);
        });
      });
      const next = ids.join("\n");
      if (next === visibleCardsRef.current) return;
      visibleCardsRef.current = next;
      reportPresenceRef.current();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    /* Every card's rect is read here, so measuring once per scroll frame was
       the forced layout #1546 measured. A gesture is throttled to
       SCROLL_MEASURE_MS and always settles with a final measurement
       SCROLL_SETTLE_MS after the last scroll event, so what presence reports
       once the operator stops is the same set the per-frame scan reported —
       and never more than one throttle window stale while they are moving.
       An IntersectionObserver cannot express this predicate: visibility here is
       the intersection of the card with its column body, the board and the
       viewport, and an observer carries one root. */
    const settle = () => {
      timer = 0;
      schedule();
    };
    /* The capture listener hears every scroll under the board, and the seat's
       feed and each reader pin to the bottom on every streamed event. Only a
       scroller that holds the columns (the board, its page) or a column body
       can move a card; any other scroll is ignored. */
    const movesCards = (target: EventTarget | null) =>
      !(target instanceof HTMLElement) || target.matches(".col-body") || target.querySelector(".column[data-status]") !== null;
    const onScroll = (event: Event) => {
      if (!movesCards(event.target)) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(settle, SCROLL_SETTLE_MS);
      if (performance.now() - measuredAt >= SCROLL_MEASURE_MS) schedule();
    };
    schedule();
    root.addEventListener(COLUMN_LAYOUT_END, schedule);
    root.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(root);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
      root.removeEventListener(COLUMN_LAYOUT_END, schedule);
      root.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [model, mode, tab, collapsed, openReaders]);
  /* The conversation the operator is in: the reader holding keyboard focus,
     else the one opened last, while it stays open and expanded. */
  const [focusedReader, setFocusedReader] = useState<string | null>(null);
  /* The readers that hold the seat's conversation: the focus sync and the selection skip them. */
  const seatReaderKeys = useMemo(() => new Set(readerViews.filter((view) => view.seat).map((view) => view.readerKey)), [readerViews]);
  const seatReaderKeysRef = useRef(seatReaderKeys);
  useLayoutEffect(() => { seatReaderKeysRef.current = seatReaderKeys; }, [seatReaderKeys]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const sync = () => {
      const active = document.activeElement as HTMLElement | null;
      const reader = typeof active?.closest === "function" ? active.closest<HTMLElement>("[data-kanban-reader]") : null;
      /* The seat's own conversation keeps the keyboard without becoming the selection. */
      if (reader && root.contains(reader) && !seatReaderKeysRef.current.has(reader.dataset.kanbanReader ?? "")) setFocusedReader(reader.dataset.kanbanReader ?? null);
    };
    const later = () => queueMicrotask(sync);
    root.addEventListener("focusin", sync);
    root.addEventListener("focusout", later);
    return () => {
      root.removeEventListener("focusin", sync);
      root.removeEventListener("focusout", later);
    };
  }, []);
  /* With the window open the conversation the operator is in is the one in its
     reader, whatever path brought it there and wherever focus stands, so a
     composer's selected-context line is the same for an agent after an open,
     a switch or a close. */
  const inReader = windowOpen && !seatReaderKeys.has(shown ?? "") ? shown : focusedReader;
  const focusedView = inReader ? readerViews.find((view) => view.readerKey === inReader) : undefined;

  /* ── The agent window's list ─────────────────────────────────────────── */
  /* A row, ‹ › and Alt+J / Alt+K bring their agent into the window's reader. */
  const jumpToAgent = useCallback((key: string) => {
    if (!windowKeysRef.current.includes(key)) return;
    disown(key);
    focusOnShow.current = true;
    setWindow(key);
  }, [disown, setWindow]);
  /* The pill, and Alt+J with the window closed, bring the window back on the
     agent shown last. */
  const reopenWindow = useCallback(() => {
    openedFrom.current = null;
    const keys = windowKeysRef.current;
    const back = lastShown.current && keys.includes(lastShown.current) ? lastShown.current : keys[0];
    if (back) jumpToAgent(back);
  }, [jumpToAgent]);
  const stepAgent = useCallback((step: 1 | -1) => {
    const next = cycleOpenAgent(windowKeysRef.current, windowAgentRef.current, step);
    if (next) jumpToAgent(next);
  }, [jumpToAgent]);
  const closeAllAgents = useCallback(() => {
    const keys = new Set(windowKeysRef.current);
    for (const key of keys) disown(key);
    setWindow(null, null);
    memory.update((readers) => readers.filter((reader) => !keys.has(reader.key)));
    /* The window and the pill go with the last agent; the board keeps the keyboard. */
    focusAfterWindow(".board-frame");
  }, [memory, disown, setWindow, focusAfterWindow]);
  const agentStepRef = useRef({ stepAgent, reopenWindow });
  agentStepRef.current = { stepAgent, reopenWindow };
  /* Alt+J and Alt+K walk the open agents, from inside a composer too; with
     the window closed they bring it back. Read by the key's place (`code`),
     so the chord is the same under every keyboard layout. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
      const step = event.code === OPEN_AGENTS_SHORTCUT.next ? 1 : event.code === OPEN_AGENTS_SHORTCUT.previous ? -1 : 0;
      if (!step || sheetOpen.current) return;
      const root = rootRef.current;
      if (!root?.isConnected || root.closest("[hidden], [inert]")) return;
      if (!windowKeysRef.current.length) return;
      event.preventDefault();
      menu.close(false);
      if (windowAgentRef.current) agentStepRef.current.stepAgent(step);
      else agentStepRef.current.reopenWindow();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);
  const focusedPath = focusedView?.file.path ?? null;
  /* The bus drops a report that reproduces the current slice, which is what the
     `presenceSignature` memo used to spare this effect; the measurement calls
     straight into it now, so the dedupe stays where it always was. */
  const reportPresence = useCallback(() => {
    const paths: string[] = [];
    for (const id of visibleCardsRef.current ? visibleCardsRef.current.split("\n") : []) {
      for (const member of cardsById.get(id)?.members ?? []) paths.push(member.file.path);
    }
    viewBus.reportSlice({
      mode: "scheme",
      focusedPath,
      selectedPaths: selectionInOrder(paths, selection, { includeUnordered: true }),
      visiblePaths: paths.slice(0, MAX_VISIBLE_PATHS),
      camera: null,
    });
  }, [cardsById, selection, focusedPath]);
  reportPresenceRef.current = reportPresence;
  /* Before paint: a composer's selected-context line reads this report, so the
     agent coming into the window is drawn with its line on its first frame. */
  useLayoutEffect(() => { reportPresence(); }, [reportPresence]);

  /* ── Focus handoff: the board half, without a camera (#688, C6) ──────── */
  /* Conversations no card holds resolve too: a handoff opens them in the agent window. */
  const looseAnchors = useMemo(() => new Set(files.filter((file) => !owners.has(conversationIdentity(file))).map((file) => file.path)), [files, owners]);
  const focusIndex = useMemo(() => kanbanFocusIndex(model, anchors, project, looseAnchors), [model, anchors, project, looseAnchors]);
  useEffect(() => focusHandoffBus.setBoard({
    project,
    index: focusIndex,
    moveTo: (destination) => {
      const anchor = destination.anchorKeys.find((key) => anchors.has(key));
      const cardId = anchor ? anchors.get(anchor) : undefined;
      const loosePath = !cardId ? destination.anchorKeys.find((key) => looseAnchors.has(key)) ?? (destination.path && looseAnchors.has(destination.path) ? destination.path : undefined) : undefined;
      if (!cardId && !loosePath) return false;
      /* A conversation no card holds has one surface, its reader, for `show` as for `open`. */
      const file = loosePath ? filesByPath.get(loosePath) : destination.intent === "open" && destination.path ? filesByPath.get(destination.path) : undefined;
      if (file) {
        const key = conversationIdentity(file);
        const requestId = destination.requestId ?? "";
        const before = openReadersRef.current.find((reader) => reader.key === key);
        /* A resumed move finds the agent it already opened: ownership stays as
           the first move recorded it. */
        if (!handoffOwned.current.has(requestId) && !before) handoffOwned.current.set(requestId, { key });
        openReaderFor(file, { focus: false, handoff: true });
      } else if (cardId) {
        revealCard(cardId);
      }
      return true;
    },
    restoreCamera: () => false,
    arrival: (destination) => {
      const root = rootRef.current;
      if (!root) return null;
      const loosePath = destination.anchorKeys.find((key) => looseAnchors.has(key) && !anchors.has(key)) ?? (destination.path && looseAnchors.has(destination.path) ? destination.path : undefined);
      if (loosePath) {
        const looseFile = filesByPath.get(loosePath);
        return looseFile && readerArrived(root, placement.slotOf(conversationIdentity(looseFile))) ? (destination.intent === "open" ? "reader" : "visible") : null;
      }
      const file = destination.intent === "open" && destination.path ? filesByPath.get(destination.path) : undefined;
      if (file) {
        const slot = placement.slotOf(conversationIdentity(file));
        /* In the window, the conversation is where the operator is; its feed settling makes it the reader. */
        if (readerArrived(root, slot)) return "reader";
        if (readerShown(root, slot)) return "visible";
      }
      /* The agent window covers the board: nothing under it has arrived, and a resumed handoff moves again. */
      if (windowAgentRef.current) return null;
      const anchor = destination.anchorKeys.find((key) => anchors.has(key));
      const cardId = anchor ? anchors.get(anchor) : undefined;
      return cardId && cardOnScreen(root, cardId, cssEscape) ? "visible" : null;
    },
    returnFromHandoff: (requestId) => {
      const owned = handoffOwned.current.get(requestId ?? "");
      if (!owned) return;
      handoffOwned.current.delete(requestId ?? "");
      /* The window the handoff opened goes with the agent it opened. */
      if (windowAgentRef.current === owned.key) setWindow(null, null);
      memory.update((readers) => closeReader(readers, owned.key));
    },
  }), [project, focusIndex, anchors, looseAnchors, filesByPath, openReaderFor, revealCard, memory, placement, setWindow]);

  /* ── What the board is not drawing: hidden groups, empty tasks off the
     board, and conversations closed on it ─────────────────────────────── */
  const closedFiles = useMemo(
    () => (props.onRestoreConversation ? (props.closedPaths ?? []).flatMap((path) => filesByPath.get(path) ?? []) : []),
    [props.onRestoreConversation, props.closedPaths, filesByPath],
  );
  const hiddenCount = model.hiddenGroups.length + model.offBoard.length + closedFiles.length;
  const restoreConversation = useCallback((file: FileEntry) => {
    props.onRestoreConversation?.(file);
    show(t("kanban.restoredReceipt", { title: cleanTitle(file.title ?? "", 48) || t("kanban.untitledConversation") }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handler prop is read when called
  }, [props.onRestoreConversation, show, t]);

  /* ── Show an off-board task again (existing `board` preference) ───────── */
  const showOnBoard = useCallback((task: BoardTask) => {
    const title = task.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled");
    void updateTask(task.id, { board: "shown" }).then((error) => {
      if (error) show(t("kanban.showFailed", { title, error }), undefined, { error: true });
      else show(t("kanban.shownReceipt", { title }));
    });
  }, [show, t]);

  const viewSwitch = typeof props.viewSwitch === "function" ? props.viewSwitch(barWide) : props.viewSwitch;
  /* The Overview narrows permanently, so its columns read «3 of 41» and an
     empty one says so, exactly as they do under a search. */
  const searching = query.trim().length > 0;
  const filtering = searching || Boolean(props.overview) || Boolean(reasonFilter);
  /* What an empty column says depends on WHICH narrowing emptied it: a search
     the operator typed is advice about the search, the Overview's permanent
     filter is not (#696 — a filtered-out board and a fruitless search must not
     render the same screen). Null leaves the column its own empty copy. */
  const emptyFiltered = searching
    ? { title: t("kanban.noMatch"), body: t("kanban.noMatchHint") }
    : props.overview
      ? { title: t("overview.noneWorking"), body: t("overview.noneWorkingHint") }
      : null;
  const openMenu = menuFor();
  const trayOpen = menu.open?.value.kind === "tray" ? menu.open : null;
  const linkOpen = menu.open?.value.kind === "link" ? menu.open : null;
  const stopOpen = menu.open?.value.kind === "stop" ? menu.open : null;
  const accountOpen = menu.open?.value.kind === "account" ? menu.open : null;
  const linksOpen = menu.open?.value.kind === "links" ? menu.open.value.target : null;
  const iconOpen = menu.open?.value.kind === "icon" ? menu.open : null;
  const iconCard = iconOpen && iconOpen.value.kind === "icon" ? cardsById.get(iconOpen.value.cardId) ?? null : null;
  /* The picker reads the pipeline and the conversation as the board holds them now. */
  const accountOverlay = (target: AccountTarget, anchor: HTMLElement) => {
    if (target.kind === "stage") {
      const pipeline = cards.flatMap((card) => card.pipelines).find((entry) => entry.pipeline.id === target.pipelineId)?.pipeline;
      const stage = pipeline?.stages.find((entry) => entry.id === target.stageId);
      if (!pipeline || !stage) return null;
      return <StageAccountPopover anchor={anchor} onClose={menu.close} pipeline={pipeline} stage={stage} name={stageNames(t, pipeline).get(stage.id) ?? stage.id} />;
    }
    const view = readerViews.find((candidate) => candidate.readerKey === target.readerKey);
    if (!view) return null;
    const role = view.owner?.stage ? stageNames(t, view.owner.stage.pipeline).get(view.owner.stage.stage.id) ?? null : null;
    return <ConversationAccountPopover anchor={anchor} onClose={menu.close} file={view.file} name={role ?? conversationName(view)} stageContext={view.owner?.stage ?? null} />;
  };
  const stopKey = stopOpen && stopOpen.value.kind === "stop" ? stopOpen.value.key : null;
  const stopView = stopKey ? readerViews.find((view) => view.readerKey === stopKey) ?? null : null;
  const linkKey = linkOpen && linkOpen.value.kind === "link" ? linkOpen.value.key : null;
  const linkView = linkKey ? readerViews.find((view) => view.readerKey === linkKey) ?? null : null;
  const linkOwnerTask = linkView?.owner ? cardsById.get(linkView.owner.cardId)?.task ?? null : null;
  const linkCandidates = linkView ? allTasks
    .filter((task) => task.id !== linkOwnerTask?.id && task.board !== "hidden")
    .filter((task) => !linkQuery.trim() || task.text.toLowerCase().includes(linkQuery.trim().toLowerCase()))
    .slice(0, 50) : [];
  /* A shelf column holding an agent draft widens to reading width, and so
     does Inbox while `+ Task` composes in it. An open conversation stands in
     the agent window and leaves its column's width as it was. */
  const readingStatuses = new Set<TaskStatus>();
  /* A draft in Assigned keeps the agent's minimum width. */
  const agentStatuses = new Set<TaskStatus>();
  for (const card of cardsById.values()) {
    if (card.drafts.length && card.status !== "assigned" && !collapsed.has(card.id)) readingStatuses.add(card.status);
    /* A draft holds the width its launched conversation will need, in whichever column its card stands. */
    if (card.drafts.length && !collapsed.has(card.id)) agentStatuses.add(card.status);
  }
  if (composingTask) readingStatuses.add("inbox");
  const wideShelf = widthControls ? wideColumns.wide : null;
  /* A column holding no cards at all folds to a strip beside the columns (never
     in tabs), unless it holds the wide share; a search never folds one. */
  const stripStatuses = new Set<TaskStatus>();
  if (mode !== "tabs") {
    for (const status of KANBAN_STATUSES) {
      if (status === (wideShelf ?? "assigned") || readingStatuses.has(status)) continue;
      if (model.columns[status].cards.length || (status === "inbox" && (model.unlinked.some((card) => !(holdsOnlyDrafts(card) && card.status === "assigned")) || composingTask))) continue;
      stripStatuses.add(status);
    }
  }
  const columnTracks = kanbanColumnTracks(mode, { overview: Boolean(props.overview), wide: wideShelf, reading: readingStatuses, agents: agentStatuses, strips: stripStatuses });
  const boardStyle = columnTracks ? (columnTracks as CSSProperties) : undefined;
  /* The mouse resting in a narrow column widens it, never over a pin and never
     while a drag, a menu or the Stages sheet has the pointer. */
  useColumnDwell(rootRef, {
    enabled: widthControls,
    canWiden: (status) => !wideColumns.pinned && !stripStatuses.has(status) && (wideShelf ? wideShelf !== status : status !== "assigned"),
    busy: () => menuOpenRef.current || sheetOpen.current || draggingCard.current,
    widen: wideColumns.widenIfNarrow,
  });

  /* ── K9a: + Task, + Agent and the drafts cards hold ─────────────────── */
  const openNewTask = () => {
    setComposingTask(true);
    if (mode === "tabs") setTab("inbox");
    queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>("[data-kanban-new-task]")?.scrollIntoView({ block: "nearest", behavior: "auto" }));
  };
  const closeNewTask = useCallback(() => {
    setComposingTask(false);
    queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>("[data-new-task], [data-bar-create]")?.focus({ preventScroll: true }));
  }, []);
  const taskCreated = useCallback((task: BoardTask) => {
    setComposingTask(false);
    setCreatedTasks((current) => [...current.filter((entry) => entry.task.id !== task.id), { task, basis: storedTasksRef.current }]);
    show(t("kanban.taskCreated", { title: task.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled") }));
    revealCard(`task:${task.id}`, ".title-trigger");
  }, [show, t, revealCard]);
  const addAgentRef = useRef(props.onAddAgent);
  addAgentRef.current = props.onAddAgent;
  const addAgentToCard = useCallback((card: KanbanCardModel) => addAgentRef.current?.({ id: card.id, task: card.task, title: card.title }), []);
  /* «Ask» holds the card where it was, so a folded seat opens above the viewport
     and its composer is out of sight. The receipt says the chip took and takes
     the operator to the composer when they want it. */
  const taskAsked = useCallback((project: string, chip: { title: string }) => {
    show(t("taskChip.added", { title: chip.title }), {
      label: t("taskChip.show"),
      run: () => {
        const seat = [...document.querySelectorAll<HTMLElement>("[data-kanban-seat]")].find((node) => node.getAttribute("data-kanban-seat") === project);
        const input = seat?.querySelector<HTMLElement>("textarea");
        input?.scrollIntoView({ block: "center" });
        input?.focus({ preventScroll: true });
      },
    });
  }, [show, t]);
  /* One stable callback behind the Overview's, so a card's memo never breaks
     on a fresh arrow from the page above. */
  const openProjectRef = useRef(props.overview?.onOpenProject);
  openProjectRef.current = props.overview?.onOpenProject;
  const openProject = useCallback((project: string) => openProjectRef.current?.(project), []);
  /* The dashboard hands a fresh callback on each of its renders; readers get one that stays the same. */
  const spawnRetryRef = useRef(props.onSpawnRetry);
  spawnRetryRef.current = props.onSpawnRetry;
  const spawnRetry = useCallback((file: FileEntry) => spawnRetryRef.current?.(file), []);
  const draftCloseRef = useRef(props.onDraftClose);
  draftCloseRef.current = props.onDraftClose;
  const draftSpawnedRef = useRef(props.onDraftSpawned);
  draftSpawnedRef.current = props.onDraftSpawned;
  const restoreRef = useRef(props.onRestoreConversation);
  restoreRef.current = props.onRestoreConversation;
  const draftActions = useMemo<KanbanDraftActions>(() => ({
    project,
    files,
    onClose: (id) => draftCloseRef.current?.(id),
    /* The draft stays until the card its launch becomes is on the board: the
       swap is one commit, so nothing is drawn between the two. */
    onSpawned: (id, file) => {
      if (!restoreRef.current) {
        draftSpawnedRef.current?.(id, file);
        return;
      }
      /* The pane reports the same adoption on every poll until it is gone. */
      if (launching.current.has(id) || launchedDrafts.current.has(id)) return;
      const since = launchClockMs();
      /* The conversation joins the board (so its task's card can be drawn)
         without a reader: the reader opens in the card, after the swap. */
      restoreRef.current(file);
      launching.current.set(id, { file, since });
      setLaunchTick((tick) => tick + 1);
    },
  }), [project, files]);
  const launching = useRef(new Map<string, { file: FileEntry; since: number }>());
  const launchedDrafts = useRef(new Set<string>());
  const [launchTick, setLaunchTick] = useState(0);
  /* A launch the board never shows a card for (a refused task write) still ends. */
  useEffect(() => {
    if (!launching.current.size) return;
    const timer = setTimeout(() => setLaunchTick((tick) => tick + 1), LAUNCH_HOLD_MS);
    return () => clearTimeout(timer);
  }, [launchTick]);
  useLayoutEffect(() => {
    for (const [id, entry] of launching.current) {
      const identity = conversationIdentity(entry.file);
      const landed = [...cardsById.values()].some((card) => card.task && (
        card.members.some((member) => conversationIdentity(member.file) === identity)
        || card.task.assignments.some((assignment) => assignment.conversationId === entry.file.conversationId)
      ));
      if (!landed && Date.now() - entry.since < LAUNCH_HOLD_MS) continue;
      launching.current.delete(id);
      launchedDrafts.current.add(id);
      draftCloseRef.current?.(id);
      /* The launched agent goes on in the agent window. */
      openReaderFor(files.find((file) => conversationIdentity(file) === identity) ?? entry.file, { landing: true });
    }
  });

  /* The handlers a card's memo reads. Their closures follow the catalog; the
     cards must not (#2218). */
  const cardOpenMember = useStableCallback(openReaderFor);
  const cardOpenStage = useStableCallback(openStage);
  const cardFocus = useStableCallback(focusCard);
  const cardOpenAttempt = useStableCallback(openRecorded);
  const cardOpenConversations = useStableCallback(onOpenConversations);
  const cardSaveHold = useStableCallback((card: KanbanCardModel, hold: Partial<TaskHold> | null) => {
    setHoldEditing(null);
    const hasOwner = card.task?.assignments.some(a => ["delivered", "spawning", "handoff", "linked"].includes(a.state));
    move(card, hold ? "blocked" : hasOwner ? "assigned" : "inbox", { hold, focus: true });
  });
  const cardCancelHold = useStableCallback(() => { const id = holdEditing; setHoldEditing(null); if (id) focusCard(id); });

  /* A held launch's conversation joined the board before its task did: its
     draft stands for it until the task's card swaps in, so it draws no card
     of its own meanwhile (docs/design/launch-render-polish.md §3). */
  // eslint-disable-next-line react-hooks/refs -- Read on the render the launch tick schedules; the set only narrows what is drawn.
  const heldLaunches = new Set([...launching.current.values()].map((entry) => conversationIdentity(entry.file)));
  const columnsView = KANBAN_STATUSES.map((status) => (
    <KanbanColumnView
      key={status}
      status={status}
      model={model}
      mode={mode}
      activeTab={tab}
      filtering={filtering}
      emptyFiltered={emptyFiltered}
      collapsed={collapsed}
      nowMs={modelNow * 1000}
      remoteAgents={remoteAgents}
      remoteAgentsByTask={remoteAgentsByTask}
      remoteCards={remoteCards}
      pendingIds={controller}
      editing={editing}
      failedEdits={failedEdits}
      incomingEdits={incomingEdits}
      onHideIdle={() => hideIdle(status)}
      reading={readingStatuses.has(status)}
      agent={agentStatuses.has(status)}
      strip={stripStatuses.has(status)}
      menuOpen={menu.open?.value.kind === "column" && menu.open.value.status === status}
      widths={widthControls ? { state: wideColumns, wide: wideShelf } : null}
      readerKeysByCard={readerKeysByCard}
      panelsByCard={panelsByCard}
      actingByCard={actingByCard}
      newTask={status === "inbox" && composingTask && !props.overview ? <KanbanTaskComposer project={project} onCreated={taskCreated} onCancel={closeNewTask} /> : null}
      heldLaunches={heldLaunches}
      onColumnMenu={(anchor) => menu.setOpen({ anchor, value: { kind: "column", status } })}
      cardProps={{
        onToggleCollapsed: toggleCollapsed,
        onCardMenu: openCardMenu,
        onKey: onCardKey,
        onPointerDown: onCardPointerDown,
        onOpenMember: cardOpenMember,
        onOpenStage: cardOpenStage,
        onFocusCard: cardFocus,
        onOpenConversations: cardOpenConversations,
        onStartEdit: startEdit,
        onEditDraft: editDraft,
        onCommitEdit: commitEdit,
        onCancelEdit: cancelEdit,
        onRetryEdit: retryEdit,
        onDiscardEdit: discardEdit,
        onUseTheirs: takeTheirs,
        onKeepMine: keepMine,
        onHide: hideCard,
        onDismiss: dismissCard,
        onUndoDismiss: undoDismissCard,
        holdEditingId: holdEditing,
        onSaveHold: cardSaveHold,
        onCancelHold: cardCancelHold,
        onIconMenu: openIconMenu,
        graphChoices,
        onToggleGraph: toggleGraph,
        onOpenAttempt: cardOpenAttempt,
        onDismissLaunch: dismissLaunch,
        drafts: stageDrafts,
        pipelinePorts,
        onOpenSheet: openSheet,
        onPipelineMenu: openPipelineMenu,
        onWorkLinks: openWorkLinks,
        onAnswer: answerPipeline,
        onStagePanelFold: foldStagePanel,
        onStagePanelClose: closeStagePanel,
        onStagePanelMenu: openStagePanelMenu,
        onAddAgent: props.onAddAgent ? addAgentToCard : undefined,
        onAsked: taskAsked,
        projectNames: props.overview?.names ?? null,
        onOpenProject: props.overview ? openProject : undefined,
      }}
    />
  ));
  const sheetView = sheet && sheetSummary ? (
    <StagesSheet
      key={`${sheet.cardId}|${sheet.pipelineId}`}
      title={sheetSummary.card.titlePending ? t("kanban.untitled") : sheetSummary.card.title}
      summary={sheetSummary.summary}
      panes={sheetPanes}
      flowsById={flowsById}
      initialFocus={sheet.focus}
      windowReader={shown}
      placement={placement}
      drafts={stageDrafts}
      ports={pipelinePorts}
      onFold={(stageId, folded) => foldPanes(sheet.pipelineId, [stageId], folded)}
      onFoldMany={(stageIds, folded) => foldPanes(sheet.pipelineId, stageIds, folded)}
      onChooseAttempt={(stageId, n) => setPaneAttempts((current) => withEntry(current, stageDraftKey(sheet.pipelineId, stageId), n))}
      onStageMenu={(stage, anchor) => menu.setOpen({ anchor, value: { kind: "stage", cardId: sheetSummary.card.id, pipelineId: sheet.pipelineId, stageId: stage.id, from: "sheet" } })}
      onOpenRecorded={openRecorded}
      onLeaveWindow={leaveWindow}
      onClose={closeSheet}
    />
  ) : null;

  /* The search field and the Hidden pill, shared by the project's bar and the Overview's. */
  const searchField = (group?: string) => (
    <label className="search" data-bar-group={group}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input
        type="search"
        placeholder={t("kanban.find")}
        aria-label={t("kanban.find")}
        data-kanban-search=""
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </label>
  );
  const representedReasons = [...new Set(KANBAN_STATUSES.flatMap((status) => model.columns[status].cards.flatMap(taskReasonFiltersOfCard)))];
  const reasonFilterControls = (belowBar = false) => representedReasons.length ? (
    <div className={`reason-filters${belowBar ? " reason-filter-row" : ""}`} role="group" aria-label={t("kanban.filterReasons")} data-reason-filters="">
      {representedReasons.map((reason) => (
        <button key={reason} type="button" className="reason-filter" data-reason-filter={reason} aria-pressed={reasonFilter === reason}
          onClick={() => setReasonFilter((current) => current === reason ? undefined : reason)}>
          {t(`kanban.filterReason.${reason}`)}
        </button>
      ))}
    </div>
  ) : null;
  const searchTools = (group?: string) => (
    <div className="bar-find" data-bar-group={group}>
      {searchField()}
      {props.overview || !reasonsBelowBar ? reasonFilterControls() : null}
    </div>
  );
  /* Narrow, the project's pill is icon and count, the shape Tasks has (#1801), and its name moves to the tooltip. */
  const hiddenPill = (labelled: boolean) => (
    <button
      type="button"
      className="btn hidden-pill"
      data-count={hiddenCount}
      data-hidden-pill=""
      aria-label={t("kanban.hiddenAria", { count: hiddenCount })}
      title={labelled ? undefined : t("kanban.hiddenAria", { count: hiddenCount })}
      onClick={(event) => menu.setOpen({ anchor: event.currentTarget, value: { kind: "tray" } })}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18" /><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6 0 10 8 10 8a17.7 17.7 0 0 1-3.2 4.1" /><path d="M6.6 6.6C3.9 8.5 2 12 2 12s4 8 10 8a10.9 10.9 0 0 0 4.4-.9" /></svg>
      {labelled ? <>{t("kanban.hidden")} </> : null}<span className="count num">{hiddenCount}</span>
    </button>
  );

  return (
    <AccountChoiceContext.Provider value={accountChoice}>
    <KanbanDraftContext.Provider value={draftActions}>
    <div ref={rootRef} className="kb" data-kanban-board="" data-mode={mode}>
      <CardFlights placements={placements} rootRef={rootRef} />
      {props.overview ? null : <SeatActionWires rootRef={rootRef} phone={false} seatRefs={seatRefs} tasks={storedTasks} pipelines={pipelines} files={files} onJump={jumpToWiredCard} />}
      {/* The project board's one header bar (#1801, docs/design/board-header.md): where am I, what is
          happening, one spacer, find, view, create, panels, more. The two ends are the project's own
          (`barLead`, `barTrail`); the right reserve is the Viewer's attention island. */}
      {props.overview ? (
        /* The Overview keeps the bar it had before the project board's header was put in order
           (#1801 was the project board only), and the tools wrapping under the island on its
           narrow faces. Who is working is said once, on the Overview's top line above it; who
           needs you is said once, by the attention island at the bar's right end, as on a
           project board. */
        <header className="bar" data-bar="overview">
          <span className="summary">
            <span className="num">{t("kanban.overviewTasks", { count: model.totals.onBoard })}</span>
          </span>
          {reachStatus}
          <span className="grow" />
          <div className="bar-tools">
            {searchTools()}
            {hiddenPill(true)}
            {viewSwitch ? <span className="view-switch">{viewSwitch}</span> : null}
          </div>
          {props.onNewAgent ? (
            <div className="bar-create">
              <button type="button" className="btn" data-new-agent="" aria-label={t("dash.newConvo")} disabled={!loaded} onClick={props.onNewAgent}>
                <span className="plus" aria-hidden="true">+</span> {t("dash.agent")}
              </button>
            </div>
          ) : null}
        </header>
      ) : (
        <header className="bar" data-bar="project" data-bar-tier={barWide ? "wide" : "narrow"} data-bar-wrap={barWrap ? "" : undefined} data-bar-compact={reasonsBelowBar || chipCrowded ? "" : undefined} data-bar-tight={barTight ? "" : undefined}>
          {props.barLead ? <div className="bar-slot bar-lead" data-bar-group="where">{props.barLead(barWide)}</div> : null}
          <span className="summary" data-bar-group="status">
            {reachStatus ?? (
              <>
                <span className="dot" aria-hidden="true" />
                <span className="num" data-bar-working="">{t("kanban.summaryWorking", { count: model.totals.working })}</span>
                {props.updating ? <span className="bar-note" data-bar-updating="">{t("dash.updating")}</span> : null}
              </>
            )}
          </span>
          <OpenAgentsPill count={windowAgents.length} open={windowOpen} onOpen={windowOpen ? leaveWindow : reopenWindow} />
          <span className="grow" />
          {searchTools("find")}
          <div className="bar-group" data-bar-group="view">
            {hiddenPill(barWide)}
            {viewSwitch ? <span className="bar-slot view-switch">{viewSwitch}</span> : null}
          </div>
          {/* Both creation surfaces write into this project's board. Narrow, the two are one `+`
              with a two-row menu. */}
          <div className="bar-slot">
            <BarCreateGroup
              wide={barWide}
              task={{ onClick: openNewTask, expanded: composingTask }}
              agent={props.onNewAgent ? { onClick: props.onNewAgent, disabled: !loaded } : null}
              onMenu={(anchor) => menu.setOpen({ anchor, value: { kind: "create" } })}
              menuOpen={menu.open?.value.kind === "create" || composingTask}
            />
          </div>
          {props.barTrail ? <div className="bar-slot bar-trail" data-bar-group="trail">{props.barTrail(barWide)}</div> : null}
          <BarIslandSlot />
        </header>
      )}

      {!props.overview && reasonsBelowBar ? reasonFilterControls(true) : null}

      <div className={`kb-body${seatSide ? " seat-side" : ""}`}>
      {seatSide && seatView}
      {/* The board's pane: its page, and the receipts over its foot, centred on the pane. */}
      <div className="kb-pane" ref={boardPaneRef}>
      <div className="kb-page">
      {seatSide ? null : seatView}
      <div className="board-frame" id={boardId} tabIndex={-1} aria-label={t("kanban.columns")} data-walk-anchor={props.overview ? undefined : "board"}>
      {!loaded ? (
        /* The columns it is loading, in the tracks this width gives them (#2071). */
        <KanbanColumnsSkeleton mode={mode} style={boardStyle} />
      ) : (
        /* One tree for every width: the navigation above the columns changes with the mode and the columns
           stay mounted, so crossing a breakpoint keeps every card, its draft panes and their launches. */
        <div className="scroll-wrap" data-board-wrap={mode}>
          {mode === "tabs" ? (
            <div className="tabs-nav" role="tablist" aria-label={t("kanban.columns")}>
              {KANBAN_STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  role="tab"
                  aria-selected={tab === status}
                  aria-controls={`kb-col-${status}`}
                  data-tab={status}
                  onClick={() => setTab(status)}
                >
                  {statusLabel(t, status)}
                  <span className="n num">{model.columns[status].cards.length}</span>
                </button>
              ))}
            </div>
          ) : mode === "scroll" ? (
            <div className="tabs-nav jump" aria-label={t("kanban.columns")}>
              {KANBAN_STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  aria-label={t("kanban.scrollTo", { column: statusLabel(t, status) })}
                  onClick={() => rootRef.current?.querySelector(`.column[data-status="${status}"]`)?.scrollIntoView({ inline: "start", block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" })}
                >
                  {statusLabel(t, status)}
                  <span className="n num">{model.columns[status].cards.length}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div
            className={`board${mode === "tabs" ? " tabs" : mode === "scroll" ? " scroll" : mode === "narrow" ? " narrow" : ""}${(mode === "wide" || mode === "narrow") && (readingStatuses.size || agentStatuses.size) ? " reading" : ""}`}
            data-board=""
            data-mode={mode}
            style={boardStyle}
          >
            {columnsView}
          </div>
        </div>
      )}
      </div>
      </div>
      <KanbanReceipts receipts={receipts} onDismiss={dismiss} />
      </div>
      {props.aside ? <div ref={asideRef} className="kb-aside">{props.aside}</div> : null}
      </div>
      <div ref={parkRef} className="reader-park" aria-hidden="true" />
      {sheetView}
      {/* The window's reader, and the agent it is bringing in, in a slot of
          its own under it: laid out on screen and not drawn, so its feed
          reads while the one shown stays. Keyed by agent, so the incoming
          slot becomes the shown one without moving the conversation. */}
      {shown || incoming ? (
        <AgentWindow
          agents={windowAgents}
          current={windowAgent}
          pending={!shown}
          onJump={jumpToAgent}
          onStep={stepAgent}
          onClose={closeReaderFor}
          onCloseAll={closeAllAgents}
          onLeave={leaveWindow}
        >
          {shown ? <ReaderSlot key={shown} placement={placement} readerKey={shown} /> : null}
          {incoming ? <ReaderSlot key={incoming} placement={placement} readerKey={incoming} incoming /> : null}
        </AgentWindow>
      ) : null}
      <ReaderPortals
        placement={placement}
        readers={readerViews}
        now={props.now}
        onClose={closeReaderFor}
        onLeave={leaveWindow}
        onMenu={openReaderMenu}
        onSpawnRetry={props.onSpawnRetry ? spawnRetry : undefined}
        onCloseConversation={props.onCloseConversation}
      />

      {openMenu && menu.open ? (
        <BoardMenu anchor={menu.open.anchor} label={openMenu.label} items={openMenu.items} onClose={menu.close} kind={menu.open.value.kind} />
      ) : null}
      {stopOpen && stopView ? <StopHostConfirm file={stopView.file} anchor={stopOpen.anchor} onClose={menu.close} /> : null}
      {linkOpen && linkView ? (
        <KanbanPopover
          anchor={linkOpen.anchor}
          label={t("kanban.linkPickerTitle", { conversation: conversationName(linkView) })}
          onClose={menu.close}
          initialFocus="input"
          className="link-picker"
        >
          <div className="head">{t("kanban.linkPickerTitle", { conversation: conversationName(linkView) })}</div>
          <label className="search">
            <input
              type="search"
              placeholder={t("kanban.find")}
              aria-label={t("kanban.find")}
              data-link-search=""
              value={linkQuery}
              onChange={(event) => setLinkQuery(event.target.value)}
            />
          </label>
          {linkCandidates.length ? linkCandidates.map((task) => (
            <button
              key={task.id}
              type="button"
              className="row pick"
              data-link-task={task.id}
              onClick={() => { menu.close(true); linkTo(linkView, task); }}
            >
              <span className="pill" data-status={task.status} style={{ pointerEvents: "none" }}>{statusLabel(t, task.status)}</span>
              <TaskIcon icon={task.icon} title={task.text.split(/\r?\n/, 1)[0]?.trim() ?? ""} size={14} />
              <span className="t"><span className="title">{task.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled")}</span></span>
            </button>
          )) : <p className="note">{t("kanban.linkPickerEmpty")}</p>}
          <p className="note">{t("kanban.linkPickerNote")}</p>
        </KanbanPopover>
      ) : null}
      {trayOpen ? (
        <HiddenTray
          anchor={trayOpen.anchor}
          groups={model.hiddenGroups}
          offBoard={model.offBoard}
          closed={closedFiles}
          nowMs={props.now * 1000}
          onClose={menu.close}
          onShowGroup={(card) => card.task && showGroup(card.task.id, shortTitle(card), { focus: true })}
          onShowTask={showOnBoard}
          onRestore={restoreConversation}
        />
      ) : null}
      {linksOpen && menu.open ? (
        <KanbanPopover
          anchor={menu.open.anchor}
          label={t("workLinks.listTitle")}
          onClose={menu.close}
          initialFocus="input"
          className="links-popover"
        >
          <div className="head">{t("workLinks.listTitle")}</div>
          <WorkLinksPanel target={linksOpen} resolved={workLinks.of(linksOpen)} />
        </KanbanPopover>
      ) : null}
      {iconOpen && iconCard ? (
        <KanbanPopover
          anchor={iconOpen.anchor}
          /* Opens under the icon, over its own card, never over the column beside it. */
          within={iconOpen.anchor.closest<HTMLElement>(".card")}
          label={t("kanban.iconChange", { title: shortTitle(iconCard) })}
          onClose={menu.close}
          initialFocus="input"
          className="icon-popover"
        >
          <TaskIconPicker
            value={iconCard.icon}
            suggestion={iconCard.titlePending ? null : suggestTaskIcon(iconCard.title)}
            autoFocus={false}
            onPick={(icon) => {
              menu.close(true);
              setIcon(iconCard, icon);
            }}
          />
        </KanbanPopover>
      ) : null}
      {accountOpen && accountOpen.value.kind === "account" ? accountOverlay(accountOpen.value.target, accountOpen.anchor) : null}
    </div>
    </KanbanDraftContext.Provider>
    </AccountChoiceContext.Provider>
  );
}

type CardHandlers = Pick<
  React.ComponentProps<typeof KanbanCard>,
  | "onToggleCollapsed" | "onCardMenu" | "onKey" | "onPointerDown" | "onOpenMember" | "onOpenStage" | "onFocusCard" | "onOpenConversations"
  | "onStartEdit" | "onEditDraft" | "onCommitEdit" | "onCancelEdit" | "onRetryEdit" | "onDiscardEdit" | "onUseTheirs" | "onKeepMine" | "onHide" | "onDismiss" | "onUndoDismiss" | "onIconMenu"
  | "graphChoices" | "onToggleGraph" | "onOpenAttempt" | "onDismissLaunch"
  | "drafts" | "pipelinePorts" | "onOpenSheet" | "onPipelineMenu" | "onWorkLinks" | "onAnswer" | "onStagePanelFold" | "onStagePanelClose" | "onStagePanelMenu" | "onAddAgent" | "onAsked"
  | "projectNames" | "onOpenProject" | "onSaveHold" | "onCancelHold"
> & { holdEditingId?: string | null };

function KanbanColumnView({ status, model, mode, activeTab, filtering, emptyFiltered, collapsed, nowMs, remoteAgents, remoteAgentsByTask, remoteCards, pendingIds, editing, failedEdits, incomingEdits, onHideIdle, reading, agent, strip, menuOpen, widths, readerKeysByCard, panelsByCard, actingByCard, newTask, heldLaunches, onColumnMenu, cardProps }: {
  status: TaskStatus;
  /** Which column holds the wide share and the controls that move it (#1841);
      null where every column is already full width. */
  widths: { state: KanbanWideState; wide: TaskStatus | null } | null;
  /** `+ Task`'s inline card, drawn first in Inbox. */
  newTask: ReactNode;
  /** Conversations of launches whose draft still stands for them. */
  heldLaunches: ReadonlySet<string>;
  editing: ReadonlyMap<string, { field: EditField; draft: string }>;
  failedEdits: ReadonlyMap<string, { field: EditField; draft: string; message: string }>;
  incomingEdits: ReadonlyMap<string, { field: EditField; value: string }>;
  onHideIdle: () => void;
  reading: boolean;
  /** Holds an open agent conversation, which keeps its minimum width. */
  agent: boolean;
  /** Empty: drawn as a narrow strip until a mouse rests on it, focused or dragged over. */
  strip: boolean;
  /** Its own column menu is open, which keeps an opened strip open. */
  menuOpen: boolean;
  readerKeysByCard: ReadonlyMap<string, string>;
  panelsByCard: ReadonlyMap<string, string>;
  actingByCard: ReadonlyMap<string, string>;
  model: KanbanModel;
  mode: KanbanLayoutMode;
  activeTab: TaskStatus;
  filtering: boolean;
  /** Title and body an empty column draws while a narrowing hides cards, or null. */
  emptyFiltered: { title: string; body: string } | null;
  collapsed: ReadonlySet<string>;
  nowMs: number;
  remoteAgents: readonly RemoteAgentView[];
  remoteAgentsByTask: ReadonlyMap<string, readonly RemoteAgentView[]>;
  remoteCards: ReadonlyMap<string, RemoteCard>;
  pendingIds: { pending(id: string): boolean };
  onColumnMenu: (anchor: HTMLElement) => void;
  cardProps: CardHandlers;
}) {
  const { t } = useLocale();
  const { holdEditingId, ...cardHandlers } = cardProps;
  const column = model.columns[status];
  const shown = column.shown;
  const renderCard = (card: KanbanCardModel) => (
    <KanbanCard
      key={card.id}
      card={card}
      status={card.status}
      pending={card.task ? pendingIds.pending(card.task.id) : false}
      collapsed={collapsed.has(card.id)}
      nowMs={nowMs}
      remoteAgents={card.task ? remoteAgentsByTask.get(card.task.id) ?? NO_REMOTE_FOR_CARD : NO_REMOTE_FOR_CARD}
      remote={card.task ? remoteCards.get(card.task.id) ?? null : null}
      readerKeys={readerKeysByCard.get(card.id) ?? ""}
      stagePanels={panelsByCard.get(card.id) ?? ""}
      acting={actingByCard.get(card.id) ?? ""}
      editing={editing.get(card.id) ?? null}
      failedEdit={failedEdits.get(card.id) ?? null}
      incomingEdit={incomingEdits.get(card.id) ?? null}
      {...cardHandlers}
      holdEditing={holdEditingId === card.id}
    />
  );
  // Motion ordering keeps stopped work in a trailing suffix, including
  // tasks whose finished conversations are still attached.
  let split = shown.length;
  if (status === "assigned") while (split > 0 && shown[split - 1]!.motion.key === "stopped") split -= 1;
  const active = shown.slice(0, split);
  const idle = shown.slice(split);
  const held = (card: KanbanCardModel) => !card.task && !card.drafts.length && card.members.length > 0
    && card.members.every((member) => heldLaunches.has(conversationIdentity(member.file)));
  const unlinked = status === "inbox" ? model.unlinkedShown.filter((card) => !(holdsOnlyDrafts(card) && card.status === "assigned") && !held(card)) : [];
  const drafting = status === "assigned" ? model.unlinkedShown.filter((card) => holdsOnlyDrafts(card) && card.status === "assigned") : [];
  const unboundRemote = status === "inbox" ? remoteAgents.filter((row) => !row.task) : [];
  const empty = shown.length === 0 && unlinked.length === 0 && drafting.length === 0 && unboundRemote.length === 0 && !newTask;
  /* This column holds the wide share, or gave it to a widened shelf. */
  const isWide = widths ? (widths.wide ? widths.wide === status : status === "assigned") : false;
  const gaveShare = widths !== null && widths.wide !== null && status === "assigned";
  const label = statusLabel(t, status);
  /* A strip opens under a mouse that rests on it, never under one passing
     through, so the columns beside it stay where the pointer is headed. */
  const [stripOpen, setStripOpen] = useState(false);
  const stripTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeStrip = useCallback(() => {
    if (stripTimer.current) clearTimeout(stripTimer.current);
    stripTimer.current = null;
    setStripOpen(false);
  }, []);
  useEffect(() => { if (!strip) closeStrip(); }, [strip, closeStrip]);
  useEffect(() => closeStrip, [closeStrip]);
  return (
    <section
      onPointerEnter={strip ? (event) => {
        if (event.pointerType !== "mouse" || stripTimer.current) return;
        stripTimer.current = setTimeout(() => { stripTimer.current = null; setStripOpen(true); }, DWELL_CUE_MS);
      } : undefined}
      onPointerLeave={strip ? closeStrip : undefined}
      className={`column${mode === "tabs" && activeTab === status ? " active" : ""}${reading ? " reading" : ""}${agent ? " agent" : ""}${strip ? " strip" : ""}${strip && (stripOpen || menuOpen) ? " open" : ""}${widths?.wide && isWide ? " wide" : ""}${gaveShare ? " shelf" : ""}`}
      data-wide={widths ? (isWide ? "1" : "0") : undefined}
      data-status={status}
      id={`kb-col-${status}`}
      aria-labelledby={`kb-h-${status}`}
      role={mode === "tabs" ? "tabpanel" : "region"}
    >
      <div className="col-head">
        <h2 id={`kb-h-${status}`} title={label}>{label}</h2>
        <span className="n num">{filtering ? t("kanban.columnCount", { shown: shown.length, total: column.cards.length }) : column.cards.length}</span>
        {column.working ? <span className="live num" data-count={column.working} title={t("kanban.columnWorking", { count: column.working })}><span className="ct">{t("kanban.columnWorking", { count: column.working })}</span></span> : null}
        {column.needsYou ? <span className="needs num" data-count={column.needsYou} title={t("kanban.columnNeeds", { count: column.needsYou })}><span className="ct">{t("kanban.columnNeeds", { count: column.needsYou })}</span></span> : null}
        {status === "assigned" && column.stopped ? <span className="stopped num" data-count={column.stopped} data-column-stopped={column.stopped} title={t("kanban.columnStopped", { count: column.stopped })}>{t("kanban.columnStopped", { count: column.stopped })}</span> : null}
        {status === "blocked" && column.noReason ? <span className="no-reason num" data-count={column.noReason} data-column-no-reason={column.noReason} title={t("kanban.columnNoReason", { count: column.noReason })}>{t("kanban.columnNoReason", { count: column.noReason })}</span> : null}
        <span className="spacer" />
        {widths && widths.wide === status ? (
          <button
            type="button"
            className="icon-btn col-pin"
            aria-pressed={widths.state.pinned === status}
            aria-label={t(widths.state.pinned === status ? "kanban.columnUnpin" : "kanban.columnPin")}
            title={t(widths.state.pinned === status ? "kanban.columnUnpin" : "kanban.columnPin")}
            data-col-pin={status}
            onClick={widths.state.togglePin}
          >
            <Pin aria-hidden />
          </button>
        ) : null}
        {widths && !(status === "assigned" && widths.wide === null) ? (
          <button
            type="button"
            className="icon-btn col-width"
            aria-label={isWide ? t("kanban.columnNarrow") : t("kanban.columnWiden", { column: label })}
            title={isWide ? t("kanban.columnNarrow") : t("kanban.columnWiden", { column: label })}
            data-col-width={status}
            data-col-width-action={isWide ? "narrow" : "widen"}
            onClick={(event) => changeColumnWidth(event.currentTarget, () => flushSync(() => (isWide ? widths.state.narrow() : widths.state.widen(status))))}
          >
            {isWide ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          aria-label={t("kanban.columnActions", { column: statusLabel(t, status) })}
          aria-haspopup="menu"
          data-colmenu={status}
          onClick={(event) => onColumnMenu(event.currentTarget)}
        >
          <MoreGlyph />
        </button>
      </div>
      <div className="col-body" data-status={status}>
        {newTask}
        {empty ? (
          <div className="empty">
            <strong>{emptyFiltered ? emptyFiltered.title : t(`kanban.empty.${status}.title`)}</strong>
            <span>{emptyFiltered ? emptyFiltered.body : t(`kanban.empty.${status}.body`)}</span>
          </div>
        ) : null}
        {drafting.map(renderCard)}
        {active.map(renderCard)}
        {idle.length ? (
          <>
            <div className="divider">
              <span role="separator" aria-label={t("kanban.idleAria", { count: idle.length })}>{t("kanban.idleDivider", { count: idle.length })}</span>
              {idle.some((card) => card.task && card.idle && !card.holdsSeat) ? (
                <button type="button" data-hide-idle="" title={t("kanban.hideIdleWhy")} onClick={onHideIdle}>{t("kanban.hideIdleShort")}</button>
              ) : null}
            </div>
            {idle.map(renderCard)}
          </>
        ) : null}
        {unlinked.length ? (
          <>
            <div className="divider" role="separator" title={t("kanban.notOnTaskHint")}>
              <span>{t("kanban.notOnTask", { count: unlinked.length })}</span>
            </div>
            {unlinked.map(renderCard)}
          </>
        ) : null}
        {unboundRemote.length ? <div className="remote-unbound"><RemoteAgents rows={unboundRemote} nowMs={nowMs} /></div> : null}
      </div>
    </section>
  );
}

/** A card whose column changed flies there as a clone above the board, so no
    column's scroll box clips it (prototype `fly`). */
/**
 * A card that moves to another column flies from where it was. Where it was is
 * read in `getSnapshotBeforeUpdate`, the one hook that runs once React knows
 * what changes and before it changes the DOM, so a card that stays in its
 * column is never measured. The board used to read every card's rectangle
 * after every render to learn the same thing, a forced layout of the whole
 * board for each catalog update (#2218).
 */
class CardFlights extends Component<{ placements: ReadonlyMap<string, TaskStatus>; rootRef: RefObject<HTMLElement | null> }, unknown, Map<string, DOMRect> | null> {
  getSnapshotBeforeUpdate(previous: { placements: ReadonlyMap<string, TaskStatus> }): Map<string, DOMRect> | null {
    const root = this.props.rootRef.current;
    // Column transforms own the painted geometry until their cleanup.
    if (!root || root.hasAttribute("data-column-layout") || previous.placements === this.props.placements) return null;
    let from: Map<string, DOMRect> | null = null;
    for (const [id, status] of this.props.placements) {
      const was = previous.placements.get(id);
      if (was === undefined || was === status) continue;
      const element = root.querySelector<HTMLElement>(`.card[data-id="${cssEscape(id)}"]`);
      if (element) (from ??= new Map()).set(id, element.getBoundingClientRect());
    }
    return from;
  }

  componentDidUpdate(_previous: unknown, _state: unknown, from: Map<string, DOMRect> | null) {
    const root = this.props.rootRef.current;
    if (!root || !from) return;
    const moved: Array<{ element: HTMLElement; from: DOMRect }> = [];
    for (const [id, rect] of from) {
      const element = root.querySelector<HTMLElement>(`.card[data-id="${cssEscape(id)}"]`);
      /* A card in a column that is not displayed has no box to fly to. */
      if (element && element.getBoundingClientRect().width) moved.push({ element, from: rect });
    }
    if (!moved.length) return;
    if (prefersReducedMotion() || moved.length > 6) {
      for (const { element } of moved) {
        element.classList.remove("moved-static");
        void element.offsetWidth;
        element.classList.add("moved-static");
      }
      return;
    }
    for (const { element, from: rect } of moved) fly(element, rect, root);
  }

  render() {
    return null;
  }
}

function fly(element: HTMLElement, from: DOMRect, root: HTMLElement): void {
  const destination = element.getBoundingClientRect();
  const body = element.closest(".col-body")?.getBoundingClientRect();
  let target = { left: destination.left, top: destination.top, width: destination.width, height: destination.height, offscreen: false };
  if (!destination.width) target = { left: from.left, top: from.top, width: from.width, height: 40, offscreen: true };
  else if (body && destination.top > body.bottom - 20) target = { left: destination.left, top: body.bottom - 40, width: destination.width, height: 40, offscreen: true };
  else if (body && destination.bottom < body.top + 20) target = { left: destination.left, top: body.top, width: destination.width, height: 40, offscreen: true };
  const ghost = element.cloneNode(true) as HTMLElement;
  /* An open reader stays where it is: the flight carries the card's face. */
  ghost.querySelectorAll(".reader-slot").forEach((slot) => slot.replaceChildren());
  ghost.classList.add("flying");
  ghost.classList.remove("flash", "landing", "moved-static");
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  ghost.removeAttribute("data-id");
  ghost.removeAttribute("tabindex");
  Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, maxHeight: `${Math.max(from.height, 60)}px` });
  root.appendChild(ghost);
  element.classList.add("landing");
  const duration = 420;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ghost.style.transition = `left ${duration}ms var(--ease-standard), top ${duration}ms var(--ease-standard), width ${duration}ms var(--ease-standard), max-height ${duration}ms var(--ease-standard), opacity ${duration}ms`;
    ghost.style.left = `${target.left}px`;
    ghost.style.top = `${target.top}px`;
    ghost.style.width = `${target.width}px`;
    ghost.style.maxHeight = `${Math.max(target.height, 60)}px`;
    if (target.offscreen) ghost.style.opacity = "0";
  }));
  setTimeout(() => {
    ghost.remove();
    element.classList.remove("landing", "landed");
    void element.offsetWidth;
    element.classList.add("landed");
  }, duration + 30);
}
