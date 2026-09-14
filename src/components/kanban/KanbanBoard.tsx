"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import { selectionInOrder, viewBus } from "@/hooks/viewPresenceBus";
import { conversationIdentity, formatConversationHash } from "@/lib/accounts/identity";
import { useLocale } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { MAX_VISIBLE_PATHS } from "@/lib/view/types";
import { compactPipelineLayoutFlows, latestAttempt } from "@/components/pipelines/pipelineModel";
import type { BranchGroup } from "@/components/projectModel";
import { buildSchemeLayout, type SchemeLayout } from "@/components/scheme/layout";
import { reconcileLayoutNodes } from "@/components/scheme/layoutIdentity";
import { buildTaskBands } from "@/components/scheme/taskBands";
import { isPlacedTask } from "@/components/scheme/taskGeometry";
import { updateTask } from "@/components/tasks/taskApi";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";
import { focusHandoffBus } from "@/components/attention/focusHandoffBus";
import { cleanTitle } from "@/components/utils";

import { KanbanCard, MoreGlyph, statusLabel } from "./KanbanCard";
import { buildKanbanModel, KANBAN_STATUSES, type KanbanCard as KanbanCardModel, type KanbanModel } from "./kanbanModel";
import { KanbanMenu, KanbanPopover, useOverlay, type KanbanMenuItem } from "./kanbanMenus";
import { KanbanReceipts, useReceipts } from "./KanbanReceipts";
import { useTaskMutations, type StatusMoveOutcome, type TaskMutationPorts } from "./useTaskMutations";
import { assignmentRefFor, browserAssignmentPorts, type AssignmentPorts } from "./kanbanAssignments";
import { allCards, cardAnchors, cardOnScreen, conversationOwners, kanbanFocusIndex, readerArrived } from "./kanbanFocus";
import { closeReader, foldReader, followPaths, openReader, ReaderMemory, type OpenReader } from "./readerMemory";
import { ReaderPlacement, ReaderPortals, ReaderSlot, type ReaderView } from "./KanbanReaders";

/**
 * The desktop kanban board (#1695 K2): the approved prototype's columns and
 * cards over the project's complete task inventory.
 *
 * Cards come from the same band projection the scheme board draws
 * (`buildSchemeLayout` → `buildTaskBands`, same inputs), so identity and
 * grouping never differ between the two boards while both exist. Status moves
 * are optimistic and revision-guarded (`useTaskMutations`); every other write
 * this slice offers goes through an existing route.
 */

export type KanbanLayoutMode = "wide" | "narrow" | "scroll" | "tabs";

/** Prototype `layoutMode`, measured on the board's own width. Below 768 px the
    desktop board is tabbed; the phone layout starts below 640 px and never
    mounts this component. */
export function kanbanLayoutMode(width: number): KanbanLayoutMode {
  if (width >= 1400) return "wide";
  if (width >= 1200) return "narrow";
  if (width >= 768) return "scroll";
  return "tabs";
}

export interface KanbanBoardProps {
  project: string;
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
  catalogFailures: number;
  selection: ReadonlySet<string>;
  viewSwitch?: ReactNode;
  /** The orchestrator seat above the columns (#1695 K3), given the id of the
      board region its skip link lands on. */
  seat?: (boardId: string) => ReactNode;
  /** A conversation or task the Viewer was asked to open while this board
      shows: its card is revealed, and a conversation opens as a reader. */
  focus?: string | null;
  /** A reader opened: the same seen-stamp opening a conversation leaves. */
  onConversationOpened?: (path: string) => void;
  /** The project's full conversation catalog (the List view). */
  onOpenCatalog: () => void;
  /** The scheme board, for surfaces this board does not draw yet. */
  onOpenOnBoard: () => void;
  mutationPorts?: TaskMutationPorts;
  assignmentPorts?: AssignmentPorts;
  /** Where open readers are remembered; this browser's storage by default. */
  readerStorage?: Pick<Storage, "getItem" | "setItem"> | null;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_FLOWS: Flow[] = [];
const EMPTY_PIPELINES: Pipeline[] = [];
const EMPTY_MAP: ReadonlyMap<string, string> = new Map();
const NO_READERS: readonly OpenReader[] = [];

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/** Whether search leaves this card on the board. */
function cardMatchesShown(model: KanbanModel, card: KanbanCardModel): boolean {
  return model.columns[card.status].shown.some((shown) => shown.id === card.id) || model.unlinkedShown.some((shown) => shown.id === card.id);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useBands(props: KanbanBoardProps) {
  const { t } = useLocale();
  const { groups, manual, files, flows, reviewGroups = EMPTY_FLOWS, pipelines, surfacePipelines = EMPTY_PIPELINES, tasks, allTasks, drafts, favorites = EMPTY_SET, isolatedManualPaths = EMPTY_SET, draftBands = EMPTY_MAP, now, project } = props;
  const deckFlows = useMemo(() => (reviewGroups.length ? [...flows, ...reviewGroups] : flows), [flows, reviewGroups]);
  const layoutFlows = useMemo(() => compactPipelineLayoutFlows(pipelines, deckFlows), [pipelines, deckFlows]);
  const placedTasks = useMemo(() => tasks.filter(isPlacedTask), [tasks]);
  const previousLayout = useRef<SchemeLayout | null>(null);
  const layout = useMemo(() => {
    const built = reconcileLayoutNodes(
      previousLayout.current,
      buildSchemeLayout(groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths, placedTasks, EMPTY_SET, { now }),
    );
    previousLayout.current = built;
    return built;
  }, [groups, manual, files, layoutFlows, drafts, pipelines, surfacePipelines, favorites, isolatedManualPaths, placedTasks, now]);
  const projection = useMemo(() => projectTaskWorkflows([...allTasks], pipelines, flows, files, project), [allTasks, pipelines, flows, files, project]);
  const bands = useMemo(
    () => buildTaskBands(layout, { tasks: allTasks, projection, draftBands, untitled: t("bands.untitled"), reviewFlow: t("bands.reviewFlow") }),
    [layout, allTasks, projection, draftBands, t],
  );
  return { bands, projection };
}

export function KanbanBoard(props: KanbanBoardProps) {
  const { t } = useLocale();
  const { project, allTasks, pipelines, files, loaded, catalogFailures, selection, onOpenCatalog, onOpenOnBoard, onConversationOpened } = props;
  const assignments = props.assignmentPorts ?? browserAssignmentPorts;
  const boardId = `kb-board-${useId().replace(/:/g, "")}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<KanbanLayoutMode>("wide");
  const [tab, setTab] = useState<TaskStatus>("assigned");
  const [query, setQuery] = useState("");
  const [linkQuery, setLinkQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [dragHint, setDragHint] = useState(false);
  const menu = useOverlay<
    { kind: "status" | "card"; cardId: string } | { kind: "column"; status: TaskStatus } | { kind: "tray" } | { kind: "reader"; key: string } | { kind: "link"; key: string }
  >();
  const { receipts, show, dismiss } = useReceipts();
  const latestUndo = useRef<{ receiptId: number; run: () => void } | null>(null);
  /* `U` undoes only what a receipt on screen still offers: once that receipt
     closes, by its timer or by hand, the undo it carried is gone with it. */
  const receiptsRef = useRef(receipts);
  receiptsRef.current = receipts;
  useEffect(() => {
    if (latestUndo.current && !receipts.some((receipt) => receipt.id === latestUndo.current!.receiptId)) latestUndo.current = null;
  }, [receipts]);

  const { bands, projection } = useBands(props);
  const { controller, statuses } = useTaskMutations(allTasks, props.mutationPorts);
  /* The model's own clock moves in 15 s steps: it only phrases ages and
     waits, and a per-second clock would rebuild every card each tick. */
  const modelNow = Math.floor(props.now / 15) * 15;
  const model: KanbanModel = useMemo(
    () => buildKanbanModel({ bands, tasks: allTasks, pipelines, projection, files, statusOverrides: statuses, query, now: modelNow }),
    [bands, allTasks, pipelines, projection, files, statuses, query, modelNow],
  );
  const cardsById = useMemo(() => {
    const map = new Map<string, KanbanCardModel>();
    for (const status of KANBAN_STATUSES) for (const card of model.columns[status].cards) map.set(card.id, card);
    for (const card of model.unlinked) map.set(card.id, card);
    return map;
  }, [model]);
  const tasksById = useRef(new Map<string, BoardTask>());
  tasksById.current = new Map(allTasks.map((task) => [task.id, task] as const));
  const filesByPath = useMemo(() => new Map(files.map((file) => [file.path, file] as const)), [files]);

  /* ── Readers: conversations open inside cards ────────────────────────── */
  const cards = useMemo(() => allCards(model), [model]);
  const owners = useMemo(() => conversationOwners(cards, files), [cards, files]);
  const anchors = useMemo(() => cardAnchors(cards, owners), [cards, owners]);
  const readerStorage = props.readerStorage === undefined ? browserStorage() : props.readerStorage;
  const memory = useMemo(() => new ReaderMemory(project, readerStorage), [project, readerStorage]);
  const openReaders = useSyncExternalStore(memory.subscribe, memory.snapshot, () => NO_READERS);
  const openReadersRef = useRef(openReaders);
  openReadersRef.current = openReaders;
  const [placement] = useState(() => new ReaderPlacement());
  /* One reader at a time may take the whole window; it is the same reader,
     moved, and goes back into its card when it leaves. */
  const [fullReader, setFullReader] = useState<string | null>(null);
  const toggleFull = useCallback((key: string) => setFullReader((current) => (current === key ? null : key)), []);
  /* Escape puts it back, unless the key belongs to a field or an open menu.
     Listened for on the document: the reader is a portal, so its key events
     never pass through the overlay in React's tree. */
  useEffect(() => {
    if (!fullReader) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog']")) return;
      setFullReader(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullReader]);
  const parkRef = useCallback((park: HTMLDivElement | null) => placement.setPark(park), [placement]);
  const filesByIdentity = useMemo(() => new Map(files.map((file) => [conversationIdentity(file), file] as const)), [files]);
  /* A conversation that has left this board's files keeps its reader mounted
     on the file it was last seen as, so nothing typed into it is lost. */
  const lastSeenFiles = useRef(new Map<string, FileEntry>());
  const readerViews = useMemo<ReaderView[]>(() => openReaders.flatMap((reader) => {
    const owner = owners.get(reader.key);
    const file = owner?.file ?? filesByIdentity.get(reader.key) ?? filesByPath.get(reader.path) ?? lastSeenFiles.current.get(reader.key);
    if (!file) return [];
    const card = owner ? cardsById.get(owner.cardId) : undefined;
    return [{
      readerKey: reader.key,
      file,
      folded: reader.folded && fullReader !== reader.key,
      full: fullReader === reader.key,
      owner: owner && card ? { cardId: card.id, cardTitle: card.titlePending ? t("kanban.untitled") : card.title, stage: owner.stage } : null,
    }];
  }), [openReaders, owners, filesByIdentity, filesByPath, cardsById, t, fullReader]);
  useEffect(() => {
    for (const view of readerViews) lastSeenFiles.current.set(view.readerKey, view.file);
  }, [readerViews]);
  /* A conversation that moved to a new transcript keeps its reader. */
  useEffect(() => {
    memory.update((readers) => followPaths(readers, (key) => filesByIdentity.get(key)?.path ?? null));
  }, [memory, filesByIdentity]);
  const readerKeysByCard = useMemo(() => {
    const byCard = new Map<string, string[]>();
    for (const reader of openReaders) {
      const owner = owners.get(reader.key);
      if (!owner || reader.key === fullReader) continue;
      const keys = byCard.get(owner.cardId) ?? [];
      keys.push(reader.key);
      byCard.set(owner.cardId, keys);
    }
    return new Map([...byCard].map(([cardId, keys]) => [cardId, keys.join("\n")] as const));
  }, [openReaders, owners, fullReader]);

  /* ── Width → layout mode ─────────────────────────────────────────────── */
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const apply = () => setMode(kanbanLayoutMode(element.getBoundingClientRect().width));
    apply();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* ── Flash, flights ──────────────────────────────────────────────────── */
  const flash = useCallback((cardId: string) => {
    const element = rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`);
    if (!element) return;
    element.classList.remove("flash");
    void element.offsetWidth;
    element.classList.add("flash");
  }, []);
  const previousRects = useRef(new Map<string, { rect: DOMRect; status: string | undefined }>());
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const next = new Map<string, { rect: DOMRect; status: string | undefined }>();
    const moved: Array<{ element: HTMLElement; from: DOMRect }> = [];
    const reduce = prefersReducedMotion();
    root.querySelectorAll<HTMLElement>(".card[data-id]").forEach((element) => {
      const id = element.dataset.id!;
      const rect = element.getBoundingClientRect();
      const status = element.closest<HTMLElement>(".column")?.dataset.status;
      next.set(id, { rect, status });
      const before = previousRects.current.get(id);
      if (!before || !rect.width) return;
      if (before.status && status && before.status !== status) moved.push({ element, from: before.rect });
    });
    previousRects.current = next;
    if (!moved.length) return;
    if (reduce || moved.length > 6) {
      for (const { element } of moved) {
        element.classList.remove("moved-static");
        void element.offsetWidth;
        element.classList.add("moved-static");
      }
      return;
    }
    for (const { element, from } of moved) fly(element, from, root);
  });

  /* ── Status moves ────────────────────────────────────────────────────── */
  /* Focus follows the card into its new column: the moved card is a new
     element there, so the control the operator used is found again by id. */
  const pendingFocus = useRef<{ cardId: string; status: TaskStatus; target: "card" | "pill" } | null>(null);
  const focusMoved = useCallback((cardId: string, status: TaskStatus, target: "card" | "pill") => {
    pendingFocus.current = { cardId, status, target };
  }, []);
  useLayoutEffect(() => {
    const wanted = pendingFocus.current;
    if (!wanted) return;
    const element = rootRef.current?.querySelector<HTMLElement>(`.column[data-status="${wanted.status}"] .card[data-id="${cssEscape(wanted.cardId)}"]`);
    if (!element) return;
    pendingFocus.current = null;
    const focusable = wanted.target === "pill" ? element.querySelector<HTMLElement>(".pill") ?? element : element;
    /* The menu hands focus back to its anchor on close; the anchor was the old
       card, so this runs again on the next frame once that has happened. */
    focusable.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      if (focusable.isConnected && !focusable.contains(document.activeElement)) focusable.focus({ preventScroll: true });
    });
  });
  const move = useCallback((card: KanbanCardModel, to: TaskStatus, options: { receipt?: boolean; focus?: "card" | "pill" } = {}) => {
    const task = card.task ? tasksById.current.get(card.task.id) ?? card.task : null;
    if (!task) return;
    const from = card.status;
    if (from === to) return;
    const title = card.titlePending ? t("kanban.untitled") : card.title;
    const short = title.length > 48 ? `${title.slice(0, 46).trimEnd()}…` : title;
    const undo = () => {
      const current = cardsByIdRef.current.get(card.id);
      if (current) move(current, from, { receipt: false });
    };
    const receiptId = options.receipt === false
      ? show(t("kanban.movedBack", { title: short, status: statusLabel(t, to) }))
      : show(t("kanban.moved", { title: short, status: statusLabel(t, to) }), { label: t("kanban.undo"), run: undo });
    if (options.receipt !== false) latestUndo.current = { receiptId, run: undo };
    if (options.focus) focusMoved(card.id, to, options.focus);
    void controller.move(task, to).then((outcome: StatusMoveOutcome) => {
      if (outcome.kind === "failed") {
        dismiss(receiptId);
        if (latestUndo.current?.receiptId === receiptId) latestUndo.current = null;
        flash(card.id);
        show(t("kanban.moveFailed", { title: short, error: outcome.error }), {
          label: t("kanban.retry"),
          run: () => {
            const current = cardsByIdRef.current.get(card.id);
            if (current) move(current, to);
          },
        }, { error: true });
      } else if (outcome.kind === "conflict") {
        dismiss(receiptId);
        if (latestUndo.current?.receiptId === receiptId) latestUndo.current = null;
        flash(card.id);
        show(t("kanban.movedElsewhere", { title: short, status: statusLabel(t, outcome.serverStatus) }), {
          label: t("kanban.moveAnyway"),
          run: () => {
            const current = cardsByIdRef.current.get(card.id);
            if (current) move(current, to);
          },
        }, { error: true });
      }
    });
  }, [controller, dismiss, flash, focusMoved, show, t]);
  const cardsByIdRef = useRef(cardsById);
  cardsByIdRef.current = cardsById;

  const shift = useCallback((card: KanbanCardModel, delta: -1 | 1, focus: "card" | "pill" = "card") => {
    const index = KANBAN_STATUSES.indexOf(card.status) + delta;
    const target = KANBAN_STATUSES[index];
    if (target) move(card, target, { focus });
  }, [move]);

  /* ── Menus ───────────────────────────────────────────────────────────── */
  const statusItems = useCallback((card: KanbanCardModel, hints: boolean): KanbanMenuItem[] => KANBAN_STATUSES.map((status) => ({
    type: "radio" as const,
    status,
    label: statusLabel(t, status),
    why: hints ? t(`kanban.statusHint.${status}`) : null,
    checked: card.status === status,
    onSelect: () => move(card, status, { focus: "pill" }),
  })), [move, t]);
  const menuFor = (): { label: string; items: KanbanMenuItem[] } | null => {
    const open = menu.open;
    if (!open) return null;
    if (open.value.kind === "column") {
      const hidden = model.offBoard.length;
      return {
        label: t("kanban.columnActions", { column: statusLabel(t, open.value.status) }),
        items: [{
          type: "item",
          label: t("kanban.showHiddenTasks", { count: hidden }),
          disabled: hidden === 0,
          onSelect: () => {
            const pill = rootRef.current?.querySelector<HTMLElement>("[data-hidden-pill]");
            if (pill) queueMicrotask(() => menu.setOpen({ anchor: pill, value: { kind: "tray" } }));
          },
        }],
      };
    }
    if (open.value.kind === "tray" || open.value.kind === "link") return null;
    if (open.value.kind === "reader") return readerMenu(open.value.key, open.anchor);
    const value = open.value;
    const card = cardsById.get(value.cardId);
    if (!card) return null;
    const title = card.titlePending ? t("kanban.untitled") : card.title;
    const common: KanbanMenuItem[] = [
      { type: "sep" },
      { type: "item", label: t("kanban.prevColumn"), kbd: "[", disabled: card.status === "inbox", onSelect: () => shift(card, -1, "pill") },
      { type: "item", label: t("kanban.nextColumn"), kbd: "]", disabled: card.status === "done", onSelect: () => shift(card, 1, "pill") },
    ];
    if (value.kind === "status") {
      return { label: t("kanban.statusOf", { title }), items: [{ type: "head", label: t("kanban.moveTo") }, ...statusItems(card, true), ...common] };
    }
    return {
      label: t("kanban.cardActions", { title }),
      items: [
        { type: "head", label: t("kanban.moveTo") },
        ...statusItems(card, false),
        { type: "sep" },
        { type: "item", label: collapsed.has(card.id) ? t("kanban.expandCardShort") : t("kanban.collapseCardShort"), onSelect: () => toggleCollapsed(card.id) },
      ],
    };
  };
  /* ── A reader's actions: full pane, link, and Link / Unlink ───────────── */
  const conversationName = (view: ReaderView) => cleanTitle(view.file.title ?? "", 48) || view.owner?.cardTitle || t("kanban.untitledConversation");
  const readerMenu = (key: string, anchor: HTMLElement): { label: string; items: KanbanMenuItem[] } | null => {
    const view = readerViews.find((candidate) => candidate.readerKey === key);
    if (!view) return null;
    const card = view.owner ? cardsById.get(view.owner.cardId) : undefined;
    const task = card?.task ?? null;
    const ref = task ? assignmentRefFor(task, view.file) : null;
    const name = conversationName(view);
    return {
      label: t("kanban.readerActions"),
      items: [
        { type: "item", label: fullReader === key ? t("kanban.readerLeaveFull") : t("kanban.readerFull"), onSelect: () => toggleFull(key) },
        {
          type: "item",
          label: t("kanban.readerCopyLink"),
          onSelect: () => {
            const link = `${location.origin}${location.pathname}${formatConversationHash({ conversationId: view.file.conversationId ?? undefined, path: view.file.path })}`;
            void navigator.clipboard?.writeText(link).then(() => show(t("kanban.linkCopied", { conversation: name })), () => undefined);
          },
        },
        { type: "sep" },
        {
          type: "item",
          label: t("kanban.linkToTask"),
          why: t("kanban.linkToTaskWhy"),
          onSelect: () => {
            setLinkQuery("");
            queueMicrotask(() => menu.setOpen({ anchor, value: { kind: "link", key } }));
          },
        },
        {
          type: "item",
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
    else if ((key === "s" || key === "S") && card.task) {
      event.preventDefault();
      const pill = element.querySelector<HTMLElement>(".pill");
      if (pill) openStatusMenu(card, pill);
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
  }, [mode, openCardMenu, openStatusMenu, shift]);

  /* ── Pointer drag to a column ────────────────────────────────────────── */
  const onCardPointerDown = useCallback((card: KanbanCardModel, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.pointerType === "touch" || !card.task) return;
    if ((event.target as HTMLElement).closest("button, input, textarea, a, summary, details, .tile, .stage-section, .reader-slot")) return;
    const element = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let started = false;
    let ghost: HTMLElement | null = null;
    let over: TaskStatus | null = null;
    let overColumn: HTMLElement | null = null;
    const moveHandler = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!started) {
        if (Math.hypot(dx, dy) < 6) return;
        started = true;
        try { element.setPointerCapture(pointerId); } catch { /* capture is best-effort */ }
        element.classList.add("dragging");
        ghost = element.cloneNode(true) as HTMLElement;
        ghost.querySelectorAll(".reader-slot").forEach((slot) => slot.replaceChildren());
        ghost.classList.add("ghost");
        ghost.classList.remove("dragging");
        ghost.style.setProperty("--w", `${element.offsetWidth}px`);
        ghost.setAttribute("aria-hidden", "true");
        ghost.removeAttribute("data-id");
        rootRef.current?.appendChild(ghost);
        setDragHint(true);
      }
      const rect = element.getBoundingClientRect();
      ghost!.style.left = `${rect.left + dx}px`;
      ghost!.style.top = `${rect.top + dy}px`;
      ghost!.style.display = "none";
      const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      ghost!.style.display = "";
      /* The drop target is marked on the column element itself: a board
         re-render per pointer move would cost every card a frame. */
      const column = under?.closest<HTMLElement>(".column[data-status]") ?? null;
      if (overColumn && overColumn !== column) overColumn.classList.remove("drop");
      overColumn = column;
      over = column ? column.dataset.status as TaskStatus : null;
      if (column) column.classList.toggle("drop", over !== card.status);
    };
    const finish = (cancel: boolean) => {
      element.removeEventListener("pointermove", moveHandler);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancelled);
      document.removeEventListener("keydown", escape, true);
      if (!started) return;
      element.classList.remove("dragging");
      ghost?.remove();
      overColumn?.classList.remove("drop");
      setDragHint(false);
      if (!cancel && over && over !== card.status) move(card, over);
    };
    const up = () => finish(false);
    const cancelled = () => finish(true);
    const escape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape" && started) {
        keyEvent.stopPropagation();
        finish(true);
      }
    };
    element.addEventListener("pointermove", moveHandler);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancelled);
    document.addEventListener("keydown", escape, true);
  }, [move]);

  /* ── Keys: undo, find ────────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const inBoard = Boolean(target && rootRef.current?.contains(target));
      if (event.key === "/") {
        /* Outside the board `/` stays the Viewer's global search. Inside it,
           it finds a task, and the Viewer's window listener must not open
           the search palette over the field it just focused. */
        if (!inBoard) return;
        event.preventDefault();
        event.stopPropagation();
        rootRef.current?.querySelector<HTMLInputElement>("[data-kanban-search]")?.focus();
      } else if (event.key === "u" || event.key === "U") {
        if (!inBoard && target !== document.body) return;
        const undo = latestUndo.current;
        if (!undo || !receiptsRef.current.some((receipt) => receipt.id === undo.receiptId)) return;
        event.preventDefault();
        latestUndo.current = null;
        dismiss(undo.receiptId);
        undo.run();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dismiss]);

  /* ── Opening what a card holds ───────────────────────────────────────── */
  /* What to bring into view once React has committed: the card, and the
     reader when one was opened. */
  const pendingReveal = useRef<{ cardId: string | null; readerKey: string | null; focusReader: boolean } | null>(null);
  const revealCard = useCallback((cardId: string, readerKey: string | null = null, focusReader = false) => {
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
    pendingReveal.current = { cardId, readerKey, focusReader };
    setRevealTick((tick) => tick + 1);
  }, [query]);
  const openReaderFor = useCallback((file: FileEntry, options: { focus?: boolean } = {}) => {
    const key = conversationIdentity(file);
    memory.update((readers) => openReader(readers, key, file.path));
    setFocusedReader(key);
    onConversationOpened?.(file.path);
    const owner = ownersRef.current.get(key);
    revealCard(owner?.cardId ?? "", key, options.focus !== false);
  }, [memory, onConversationOpened, revealCard]);
  const [revealTick, setRevealTick] = useState(0);
  useLayoutEffect(() => {
    const wanted = pendingReveal.current;
    if (!wanted) return;
    pendingReveal.current = null;
    const root = rootRef.current;
    if (!root) return;
    const slot = wanted.readerKey ? placement.slotOf(wanted.readerKey) : null;
    const target = slot ?? (wanted.cardId ? root.querySelector<HTMLElement>(`.card[data-id="${cssEscape(wanted.cardId)}"]`) : null);
    if (!target) return;
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    if (slot && wanted.focusReader) slot.querySelector<HTMLElement>("[data-kanban-reader]")?.focus({ preventScroll: true });
  }, [revealTick, placement]);
  const ownersRef = useRef(owners);
  ownersRef.current = owners;
  const modelRef = useRef(model);
  modelRef.current = model;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const openStage = useCallback((pipeline: Pipeline, stage: PipelineStage) => {
    const attempt = latestAttempt(pipeline, stage.id);
    const file = (attempt?.agentPath ? filesByPath.get(attempt.agentPath) : undefined)
      ?? (attempt?.conversationId ? files.find((entry) => entry.conversationId === attempt.conversationId) : undefined);
    if (file) {
      openReaderFor(file);
      return;
    }
    /* A stage conversation this board does not carry (an older attempt the
       scheme window left out) opens through the Viewer's own conversation
       link: its resolver pins the transcript for the next poll. No view
       preference is written. */
    if (attempt?.conversationId || attempt?.agentPath) {
      location.hash = formatConversationHash({ conversationId: attempt.conversationId ?? undefined, path: attempt.agentPath ?? "" });
    }
  }, [files, filesByPath, openReaderFor]);
  const foldReaderFor = useCallback((key: string, folded: boolean) => memory.update((readers) => foldReader(readers, key, folded)), [memory]);
  const closeReaderFor = useCallback((key: string) => {
    const cardId = ownersRef.current.get(key)?.cardId;
    setFullReader((current) => (current === key ? null : current));
    memory.update((readers) => closeReader(readers, key));
    if (cardId) queueMicrotask(() => rootRef.current?.querySelector<HTMLElement>(`.card[data-id="${cssEscape(cardId)}"]`)?.focus({ preventScroll: true }));
  }, [memory]);
  const openReaderMenu = useCallback((key: string, anchor: HTMLElement) => menu.setOpen({ anchor, value: { kind: "reader", key } }), [menu]);

  /* A conversation the Viewer was asked to open lands in its reader. */
  const focusTarget = props.focus ?? null;
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.startsWith("task::")) {
      const cardId = `task:${focusTarget.slice("task::".length)}`;
      if (cardsByIdRef.current.has(cardId)) revealCard(cardId);
      return;
    }
    const file = filesByPath.get(focusTarget);
    if (!file) return;
    if (ownersRef.current.has(conversationIdentity(file))) openReaderFor(file);
    /* A conversation no card holds is shown where the Viewer can show it. */
    else onOpenOnBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one open per request
  }, [focusTarget]);

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

  /* ── Presence: what the operator can actually see ────────────────────── */
  /* A card counts as seen when it intersects its column's scroll box, the
     board and the window, in a column that is displayed (one tab at a time on
     a tabbed board). Measured after each render and on any scroll or resize
     inside the board, one frame at a time. */
  const [visibleCards, setVisibleCards] = useState("");
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
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
      setVisibleCards(ids.join("\n"));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    schedule();
    root.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(root);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      root.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [model, mode, tab, collapsed, openReaders]);
  /* The conversation the operator is in: the reader holding keyboard focus,
     else the one opened last, while it stays open and expanded. */
  const [focusedReader, setFocusedReader] = useState<string | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const sync = () => {
      const active = document.activeElement as HTMLElement | null;
      const reader = typeof active?.closest === "function" ? active.closest<HTMLElement>("[data-kanban-reader]") : null;
      if (reader && root.contains(reader)) setFocusedReader(reader.dataset.kanbanReader ?? null);
    };
    const later = () => queueMicrotask(sync);
    root.addEventListener("focusin", sync);
    root.addEventListener("focusout", later);
    return () => {
      root.removeEventListener("focusin", sync);
      root.removeEventListener("focusout", later);
    };
  }, []);
  const focusedView = focusedReader ? readerViews.find((view) => view.readerKey === focusedReader && !view.folded) : undefined;
  const focusedPath = focusedView?.file.path ?? null;
  const presenceSignature = useMemo(() => {
    const paths: string[] = [];
    for (const id of visibleCards ? visibleCards.split("\n") : []) {
      for (const member of cardsById.get(id)?.members ?? []) paths.push(member.file.path);
    }
    return paths.join("\n");
  }, [visibleCards, cardsById]);
  useEffect(() => {
    const order = presenceSignature ? presenceSignature.split("\n") : [];
    viewBus.reportSlice({
      mode: "scheme",
      focusedPath,
      selectedPaths: selectionInOrder(order, selection, { includeUnordered: true }),
      visiblePaths: order.slice(0, MAX_VISIBLE_PATHS),
      camera: null,
    });
  }, [presenceSignature, selection, focusedPath]);

  /* ── Focus handoff: the board half, without a camera (#688, C6) ──────── */
  const handoffOpened = useRef(new Set<string>());
  const focusIndex = useMemo(() => kanbanFocusIndex(model, anchors, project), [model, anchors, project]);
  useEffect(() => focusHandoffBus.setBoard({
    project,
    index: focusIndex,
    moveTo: (destination) => {
      const anchor = destination.anchorKeys.find((key) => anchors.has(key));
      const cardId = anchor ? anchors.get(anchor) : undefined;
      if (!cardId) return false;
      const file = destination.intent === "open" && destination.path ? filesByPath.get(destination.path) : undefined;
      if (file) {
        const key = conversationIdentity(file);
        if (!openReadersRef.current.some((reader) => reader.key === key && !reader.folded)) handoffOpened.current.add(key);
        openReaderFor(file, { focus: false });
      } else {
        revealCard(cardId);
      }
      return true;
    },
    restoreCamera: () => false,
    arrival: (destination) => {
      const root = rootRef.current;
      if (!root) return null;
      const file = destination.intent === "open" && destination.path ? filesByPath.get(destination.path) : undefined;
      if (file && readerArrived(root, placement.slotOf(conversationIdentity(file)))) return "reader";
      const anchor = destination.anchorKeys.find((key) => anchors.has(key));
      const cardId = anchor ? anchors.get(anchor) : undefined;
      return cardId && cardOnScreen(root, cardId, cssEscape) ? "visible" : null;
    },
    returnFromHandoff: () => {
      const opened = [...handoffOpened.current];
      handoffOpened.current.clear();
      if (opened.length) memory.update((readers) => opened.reduce<OpenReader[]>((current, key) => closeReader(current, key), [...readers]));
    },
  }), [project, focusIndex, anchors, filesByPath, openReaderFor, revealCard, memory, placement]);

  /* ── Show an off-board task again (existing `board` preference) ───────── */
  const showOnBoard = useCallback((task: BoardTask) => {
    const title = task.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled");
    void updateTask(task.id, { board: "shown" }).then((error) => {
      if (error) show(t("kanban.showFailed", { title, error }), undefined, { error: true });
      else show(t("kanban.shownReceipt", { title }));
    });
  }, [show, t]);

  const onboardCount = model.totals.onBoard;
  const hiddenCount = model.offBoard.length;
  const filtering = query.trim().length > 0;
  const openMenu = menuFor();
  const trayOpen = menu.open?.value.kind === "tray" ? menu.open : null;
  const linkOpen = menu.open?.value.kind === "link" ? menu.open : null;
  const linkKey = linkOpen && linkOpen.value.kind === "link" ? linkOpen.value.key : null;
  const linkView = linkKey ? readerViews.find((view) => view.readerKey === linkKey) ?? null : null;
  const linkOwnerTask = linkView?.owner ? cardsById.get(linkView.owner.cardId)?.task ?? null : null;
  const linkCandidates = linkView ? allTasks
    .filter((task) => task.id !== linkOwnerTask?.id && task.board !== "hidden")
    .filter((task) => !linkQuery.trim() || task.text.toLowerCase().includes(linkQuery.trim().toLowerCase()))
    .slice(0, 50) : [];
  /* A shelf column holding an open conversation widens to reading width. */
  const readingStatuses = new Set<TaskStatus>();
  for (const view of readerViews) {
    if (view.folded || !view.owner) continue;
    const card = cardsById.get(view.owner.cardId);
    if (card && card.status !== "assigned" && !collapsed.has(card.id)) readingStatuses.add(card.status);
  }
  const readingStyle = (mode === "wide" || mode === "narrow") && readingStatuses.size
    ? ({ "--c-assigned": "minmax(440px, 1fr)", ...Object.fromEntries([...readingStatuses].map((status) => [`--c-${status}`, "minmax(420px, 460px)"])) } as CSSProperties)
    : undefined;

  const columnsView = KANBAN_STATUSES.map((status) => (
    <KanbanColumnView
      key={status}
      status={status}
      model={model}
      mode={mode}
      activeTab={tab}
      filtering={filtering}
      collapsed={collapsed}
      nowMs={modelNow * 1000}
      pendingIds={controller}
      reading={readingStatuses.has(status)}
      readerKeysByCard={readerKeysByCard}
      placement={placement}
      onColumnMenu={(anchor) => menu.setOpen({ anchor, value: { kind: "column", status } })}
      cardProps={{
        onToggleCollapsed: toggleCollapsed,
        onStatusMenu: openStatusMenu,
        onCardMenu: openCardMenu,
        onKey: onCardKey,
        onPointerDown: onCardPointerDown,
        onOpenMember: openReaderFor,
        onOpenStage: openStage,
        onFocusCard: focusCard,
        onOpenCatalog,
        onOpenOnBoard,
      }}
    />
  ));

  return (
    <div ref={rootRef} className="kb" data-kanban-board="" data-mode={mode}>
      <header className="bar">
        <span className="summary">
          <span className="dot" aria-hidden="true" />
          <span className="num">{t("kanban.summaryWorking", { count: model.totals.working })}</span>
          {model.totals.needsYou ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="dot warn" aria-hidden="true" />
              <span className="num">{t("kanban.summaryNeeds", { count: model.totals.needsYou })}</span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span className="num">{t("kanban.summaryTasks", { count: onboardCount })}</span>
        </span>
        {catalogFailures > 0 ? <span className="bar-alert" role="alert">{t("kanban.filesFailed")}</span> : null}
        <span className="grow" />
        <div className="bar-tools">
          <label className="search">
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
          <button
            type="button"
            className="btn hidden-pill"
            data-count={hiddenCount}
            data-hidden-pill=""
            aria-label={t("kanban.hiddenAria", { count: hiddenCount })}
            onClick={(event) => menu.setOpen({ anchor: event.currentTarget, value: { kind: "tray" } })}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18" /><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6 0 10 8 10 8a17.7 17.7 0 0 1-3.2 4.1" /><path d="M6.6 6.6C3.9 8.5 2 12 2 12s4 8 10 8a10.9 10.9 0 0 0 4.4-.9" /></svg>
            {t("kanban.hidden")} <span className="count num">{hiddenCount}</span>
          </button>
          {props.viewSwitch ? <span className="view-switch">{props.viewSwitch}</span> : null}
        </div>
      </header>

      <div className="kb-page">
      {props.seat ? props.seat(boardId) : null}
      <div className="board-frame" id={boardId} tabIndex={-1} aria-label={t("kanban.columns")}>
      {!loaded ? (
        <div className="board-loading" role="status">{t("kanban.loading")}</div>
      ) : mode === "tabs" ? (
        <div className="board tabs" data-board="" data-mode={mode}>
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
          {columnsView}
        </div>
      ) : mode === "scroll" ? (
        <div className="scroll-wrap">
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
          <div className="board scroll" data-board="" data-mode={mode}>{columnsView}</div>
        </div>
      ) : (
        <div className={`board${mode === "narrow" ? " narrow" : ""}${readingStatuses.size ? " reading" : ""}`} data-board="" data-mode={mode} style={readingStyle}>{columnsView}</div>
      )}
      </div>
      </div>
      <div ref={parkRef} className="reader-park" hidden aria-hidden="true" />
      {fullReader && openReaders.some((reader) => reader.key === fullReader) ? (
        <div className="reader-full" data-reader-full={fullReader}>
          <ReaderSlot placement={placement} readerKey={fullReader} />
        </div>
      ) : null}
      <ReaderPortals
        placement={placement}
        readers={readerViews}
        now={props.now}
        onFold={foldReaderFor}
        onClose={closeReaderFor}
        onFull={toggleFull}
        onMenu={openReaderMenu}
      />

      {openMenu && menu.open ? (
        <KanbanMenu anchor={menu.open.anchor} label={openMenu.label} items={openMenu.items} onClose={menu.close} />
      ) : null}
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
              <span className="t"><span className="title">{task.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled")}</span></span>
            </button>
          )) : <p className="note">{t("kanban.linkPickerEmpty")}</p>}
          <p className="note">{t("kanban.linkPickerNote")}</p>
        </KanbanPopover>
      ) : null}
      {trayOpen ? (
        <KanbanPopover anchor={trayOpen.anchor} label={t("kanban.hiddenTitle")} onClose={menu.close}>
          <div className="head">{t("kanban.hiddenTitle")} <span className="n">· {hiddenCount}</span></div>
          {model.offBoard.map((task) => (
            <div key={task.id} className="row" data-hidden-task={task.id}>
              <span className="pill" data-status={task.status} style={{ pointerEvents: "none" }}>{statusLabel(t, task.status)}</span>
              <span className="t">
                <span className="title">{task.text.split(/\r?\n/, 1)[0]?.trim() || t("kanban.untitled")}</span>
                <span className="meta">{t("kanban.offBoardMeta")}</span>
              </span>
              <button type="button" className="show" onClick={() => { menu.close(false); showOnBoard(task); }}>{t("kanban.showOnBoard")}</button>
            </div>
          ))}
          <p className="note">{hiddenCount ? t("kanban.hiddenNote") : t("kanban.hiddenEmpty")}</p>
        </KanbanPopover>
      ) : null}
      {dragHint ? <div className="drag-hint">{t("kanban.dragHint")}</div> : null}
      <KanbanReceipts receipts={receipts} onDismiss={dismiss} />
    </div>
  );
}

type CardHandlers = Pick<
  React.ComponentProps<typeof KanbanCard>,
  "onToggleCollapsed" | "onStatusMenu" | "onCardMenu" | "onKey" | "onPointerDown" | "onOpenMember" | "onOpenStage" | "onFocusCard" | "onOpenCatalog" | "onOpenOnBoard"
>;

function KanbanColumnView({ status, model, mode, activeTab, filtering, collapsed, nowMs, pendingIds, reading, readerKeysByCard, placement, onColumnMenu, cardProps }: {
  status: TaskStatus;
  reading: boolean;
  readerKeysByCard: ReadonlyMap<string, string>;
  placement: ReaderPlacement;
  model: KanbanModel;
  mode: KanbanLayoutMode;
  activeTab: TaskStatus;
  filtering: boolean;
  collapsed: ReadonlySet<string>;
  nowMs: number;
  pendingIds: { pending(id: string): boolean };
  onColumnMenu: (anchor: HTMLElement) => void;
  cardProps: CardHandlers;
}) {
  const { t } = useLocale();
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
      readerKeys={readerKeysByCard.get(card.id) ?? ""}
      placement={placement}
      {...cardProps}
    />
  );
  const active = status === "assigned" ? shown.filter((card) => !card.idle) : shown;
  const idle = status === "assigned" ? shown.filter((card) => card.idle) : [];
  const unlinked = status === "inbox" ? model.unlinkedShown : [];
  const empty = shown.length === 0 && unlinked.length === 0;
  return (
    <section
      className={`column${mode === "tabs" && activeTab === status ? " active" : ""}${reading ? " reading" : ""}`}
      data-status={status}
      id={`kb-col-${status}`}
      aria-labelledby={`kb-h-${status}`}
      role={mode === "tabs" ? "tabpanel" : "region"}
    >
      <div className="col-head">
        <h2 id={`kb-h-${status}`}>{statusLabel(t, status)}</h2>
        <span className="n num">{filtering ? t("kanban.columnCount", { shown: shown.length, total: column.cards.length }) : column.cards.length}</span>
        {column.working ? <span className="live num">{t("kanban.columnWorking", { count: column.working })}</span> : null}
        {column.needsYou ? <span className="needs num">{t("kanban.columnNeeds", { count: column.needsYou })}</span> : null}
        <span className="spacer" />
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
        {empty ? (
          <div className="empty">
            <strong>{filtering ? t("kanban.noMatch") : t(`kanban.empty.${status}.title`)}</strong>
            <span>{filtering ? t("kanban.noMatchHint") : t(`kanban.empty.${status}.body`)}</span>
          </div>
        ) : null}
        {active.map(renderCard)}
        {idle.length ? (
          <>
            <div className="divider" role="separator" aria-label={t("kanban.idleAria", { count: idle.length })}>
              <span>{t("kanban.idleDivider", { count: idle.length })}</span>
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
      </div>
    </section>
  );
}

/** A card whose column changed flies there as a clone above the board, so no
    column's scroll box clips it (prototype `fly`). */
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

