"use client";

import { Bot, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Filter, History, ListTodo, MoreHorizontal, Plus, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Z } from "@/components/layers";
import { useSwapGuard } from "@/components/menuSwapGuard";
import { useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";

/*
 * The project board's one header bar (#1801, docs/design/board-header.md).
 *
 * One 48 px row, seven groups in reading order: where am I, what is happening,
 * one spacer, find (the search and its one filter), create, panels, more, and
 * the Viewer's attention island as the row's last item. Every control is 32 px
 * in one of three variants: outlined, pressed (`aria-pressed="true"`), and the
 * quiet icon of the ⋯ trigger. Hover only strengthens the border, so pressed
 * stays the one accent-coloured state. The kanban board draws the bar with its
 * own groups in the middle; the leaves without a board draw the same bar here,
 * with the same two ends. The board is the one desktop view, so the bar holds
 * no view switch; the list of every agent opens under its own icon.
 */

const BarIslandSlotContext = createContext<((slot: HTMLElement | null) => void) | null>(null);

/**
 * Where the Viewer's attention island sits in the document. On a project leaf
 * it is the bar's last item, in the row's own flow after ⋯: the bar's last
 * child is a slot and the island is portaled into it, so nothing is drawn over
 * the row and keyboard focus follows the order the bar is read. `island` is
 * told which of the two it is drawing. With no slot mounted (the Overview) the
 * island stays ahead of `children`, fixed to the corner as it always was.
 */
export function BarIslandProvider({ island, children }: { island: ((inRow: boolean) => ReactNode) | null; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <BarIslandSlotContext.Provider value={setSlot}>
      {slot ? null : island?.(false)}
      {children}
      {slot && island ? createPortal(island(true), slot) : null}
    </BarIslandSlotContext.Provider>
  );
}

/** The bar's last child: the island's place in the row. The slot draws no box of its own, so the island is the row's item. */
export function BarIslandSlot() {
  const setSlot = useContext(BarIslandSlotContext);
  return setSlot ? <div ref={setSlot} className="bar-slot" data-bar-island-slot="" style={{ display: "contents" }} /> : null;
}

const BoardPaneContext = createContext<((pane: HTMLElement | null) => void) | null>(null);

/**
 * Where the board's columns are, for the Viewer's needs-you panel: it docks
 * beside the board only while the columns keep room, and the columns' own
 * pane is what a seat open beside them and the Tasks panel take their width
 * out of. The kanban board hands its pane in when it mounts.
 */
export function BoardPaneProvider({ onPane, children }: { onPane: (pane: HTMLElement | null) => void; children: ReactNode }) {
  return <BoardPaneContext.Provider value={onPane}>{children}</BoardPaneContext.Provider>;
}

/** The ref the board puts on its pane. */
export function useBoardPaneRef(): ((pane: HTMLElement | null) => void) | undefined {
  return useContext(BoardPaneContext) ?? undefined;
}

/** The Viewer's "only who waits for me" board filter (F), for the bar's one filter menu. */
export interface BarNeedsFilter {
  /** False while nothing on the board waits: the filter would only dim the board. */
  available: boolean;
  active: boolean;
  toggle: () => void;
}

const BarNeedsFilterContext = createContext<BarNeedsFilter | null>(null);

export function BarNeedsFilterProvider({ value, children }: { value: BarNeedsFilter | null; children: ReactNode }) {
  return <BarNeedsFilterContext.Provider value={value}>{children}</BarNeedsFilterContext.Provider>;
}

/** At or above this width a bar that holds no board (the skeleton, the empty project) carries its
    labels and the account switches; below it they are icons and the accounts move into ⋯. */
export const BAR_WIDE_MIN = 1700;

/**
 * What the board's bar gives up, in order, when the row is short. Each step is
 * a token the bar carries in `data-fit` once it is reached, and the bar's CSS
 * reads the tokens. The search field shrinks before any step, down to the
 * width that keeps its placeholder whole, and the project name never truncates
 * while a step is left: the account switches move into ⋯, Orchestrator and
 * Tasks keep their icons, the needs-you chip keeps its dot and count, the
 * groups stand 8 px apart, and last the search may go under its placeholder.
 */
export const BAR_FIT_STEPS = ["accounts", "labels", "chip", "tight", "find"] as const;
export type BarFitStep = (typeof BAR_FIT_STEPS)[number];

function barFits(bar: HTMLElement): boolean {
  if (bar.scrollWidth > bar.clientWidth + 0.5) return false;
  const name = bar.querySelector<HTMLElement>("h1");
  /* The name has no cap of its own: it is whole while the row has room, and it is cut only once
     every step is taken and the search sits at its floor. */
  return !name || name.scrollWidth <= name.clientWidth + 0.5;
}

/**
 * Measures the bar and sets the fewest steps at which the row fits and the
 * name is whole. The attribute is set here, never by React, so a render never
 * resets it between two measurements; the returned steps let React move what
 * lives outside the row (the accounts' rows in ⋯). `deps` name what changes the
 * row's width without changing its content or its box.
 */
export function useBarFit(ref: RefObject<HTMLElement | null>, deps: readonly unknown[]): readonly BarFitStep[] {
  const [reached, setReached] = useState<readonly BarFitStep[]>([]);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    let frame = 0;
    const fit = () => {
      let count = 0;
      for (; count <= BAR_FIT_STEPS.length; count += 1) {
        bar.setAttribute("data-fit", BAR_FIT_STEPS.slice(0, count).join(" "));
        if (barFits(bar)) break;
      }
      const taken = BAR_FIT_STEPS.slice(0, Math.min(count, BAR_FIT_STEPS.length));
      setReached((was) => (was.join(" ") === taken.join(" ") ? was : taken));
    };
    fit();
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; fit(); }); };
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    resize?.observe(bar);
    /* The steps are the bar's own attribute, so attributes are not watched: only what the row holds. */
    const mutation = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
    mutation?.observe(bar, { childList: true, subtree: true, characterData: true });
    return () => { resize?.disconnect(); mutation?.disconnect(); if (frame) cancelAnimationFrame(frame); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller names what moves the row
  }, [ref, ...deps]);
  return reached;
}

export const BAR_CONTROL =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control border px-3 text-[12px] font-semibold shadow-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
export const BAR_OUTLINED = "border-border bg-card text-primary hover:border-strong";
export const BAR_PRESSED = "border-accent/45 bg-accent/10 text-accent";
const BAR_QUIET =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-transparent text-secondary transition-colors hover:border-border hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

const BAR_ICON = "h-[15px] w-[15px] shrink-0";

/** A row of the ⋯ menu. */
export const BAR_MENU_ROW =
  "flex min-h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[12px] font-semibold text-primary hover:bg-well focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent";

/** Whether a bar is wide enough for labelled controls, measured on the bar itself. */
export function useBarWide(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = () => setWide(element.getBoundingClientRect().width >= BAR_WIDE_MIN);
    apply();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return wide;
}

/**
 * The create group: one `+` opening a two-row menu (a task, an agent). The
 * orchestrator creates most tasks, so creation is one control in the row.
 */
export function BarCreateGroup({ onMenu, menuOpen = false }: {
  /** Opens the create menu under the `+`. */
  onMenu: (anchor: HTMLElement) => void;
  menuOpen?: boolean;
}) {
  const { t } = useLocale();
  return (
    <div className="flex shrink-0 items-center gap-2" data-bar-group="create">
      <button
        type="button"
        className={`${BAR_CONTROL} ${menuOpen ? BAR_PRESSED : BAR_OUTLINED} w-8 px-0`}
        data-bar-create=""
        data-bar-control=""
        aria-label={t("dash.create")}
        title={t("dash.create")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => onMenu(event.currentTarget)}
      >
        <Plus className={BAR_ICON} aria-hidden />
      </button>
    </div>
  );
}

/** Closes an open popover on a press outside its container. */
function useOutsidePress(open: boolean, container: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => { if (container.current && !container.current.contains(event.target as Node)) close(); };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, container, close]);
}

/**
 * The bar's one filter, an icon joined to the search field's right end. It
 * holds what the reason chips and the island's funnel held: «Needs you» first,
 * which is the funnel and keeps its key F, then every other reason the board
 * shows with its count. The icon carries a dot while any of them narrows the
 * board.
 */
export function BarFilterMenu({ reasons, active, onPick, needs: needsRow }: {
  /** The reasons the board shows beside «Needs you», each with how many cards carry it. */
  reasons: readonly { id: string; label: string; count: number }[];
  active: string | undefined;
  onPick: (id: string | undefined) => void;
  /**
   * The «Needs you» row: its name and how many cards on the board wait. While
   * the Viewer's funnel has nothing to narrow (a card held on the operator is
   * in no queue), the row narrows the board by its own «needs-you» reason, so
   * it works whenever its count is above zero.
   */
  needs: { label: string; count: number; boardActive?: boolean; onBoardToggle?: () => void };
}) {
  const { t } = useLocale();
  const needs = useContext(BarNeedsFilterContext);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsidePress(open, container, close);
  const funnel = Boolean(needs?.available);
  const needsActive = funnel ? Boolean(needs?.active) : Boolean(needsRow.boardActive);
  const needsUsable = funnel || (needsRow.count > 0 && Boolean(needsRow.onBoardToggle)) || needsActive;
  const narrowed = Boolean(active) || Boolean(needs?.active) || Boolean(needsRow.boardActive);
  return (
    <span ref={container} className="bar-slot relative inline-flex shrink-0" data-bar-filter="" onKeyDown={open ? (event) => { handleOverlayEscape(event, () => { close(); trigger.current?.focus(); }); } : undefined}>
      <button
        ref={trigger}
        type="button"
        data-bar-control=""
        data-bar-filter-toggle=""
        data-bar-filter-active={narrowed ? "" : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={narrowed ? t("dash.filterOn") : t("dash.filter")}
        title={narrowed ? t("dash.filterOn") : t("dash.filter")}
        onClick={() => setOpen((was) => !was)}
        className={`${BAR_CONTROL} ${narrowed || open ? BAR_PRESSED : BAR_OUTLINED} relative w-8 px-0`}
      >
        <Filter className={BAR_ICON} aria-hidden />
        {narrowed ? <span className="absolute right-[5px] top-[5px] h-1.5 w-1.5 rounded-full bg-accent" data-bar-filter-dot="" aria-hidden /> : null}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={t("dash.filter")}
          data-bar-filter-menu=""
          className={`absolute right-0 top-full ${Z.popover} mt-1 flex w-64 flex-col gap-0.5 rounded-control border border-border bg-card p-1 shadow-2`}
        >
          <button type="button" role="menuitemcheckbox" aria-checked={needsActive} aria-keyshortcuts="F" disabled={!needsUsable} className={BAR_MENU_ROW} data-bar-filter-needs="" onClick={() => { if (funnel) needs?.toggle(); else needsRow.onBoardToggle?.(); }}>
            <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-warning" aria-hidden />
            <span className="min-w-0 flex-1">{needsRow.label}</span>
            <span className="font-normal tabular-nums text-muted">{needsRow.count}</span>
            <kbd className="text-[11px] font-normal text-muted">F</kbd>
            {needsActive ? <Check className={`${BAR_ICON} text-accent`} aria-hidden /> : null}
          </button>
          <div className="my-0.5 border-t border-border" />
          <div className="px-2 pb-0.5 pt-1 text-[11px] font-semibold text-muted">{t("dash.filterByReason")}</div>
          <button type="button" role="menuitemradio" aria-checked={!active} className={BAR_MENU_ROW} data-bar-filter-reason="" onClick={() => { onPick(undefined); close(); }}>
            <span className="min-w-0 flex-1">{t("dash.filterAll")}</span>
            {!active ? <Check className={`${BAR_ICON} text-accent`} aria-hidden /> : null}
          </button>
          {reasons.map((reason) => (
            <button key={reason.id} type="button" role="menuitemradio" aria-checked={active === reason.id} data-bar-filter-reason={reason.id} className={BAR_MENU_ROW} onClick={() => { onPick(active === reason.id ? undefined : reason.id); close(); }}>
              <span className="min-w-0 flex-1">{reason.label}</span>
              <span className="font-normal tabular-nums text-muted">{reason.count}</span>
              {active === reason.id ? <Check className={`${BAR_ICON} text-accent`} aria-hidden /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

/**
 * The recent agents: the last segment of the panel group, an icon with the
 * list under it. The list is every agent of the project, the newest first, so
 * the operator reaches it without leaving the board. `open` is the board's, so
 * a card's link to more conversations opens the same list.
 */
export function BarRecentAgents({ open, onOpenChange, list }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `countSlot` is the place in the list's head for how many agents there are. */
  list: (close: () => void, countSlot: HTMLElement | null) => ReactNode;
}) {
  const { t } = useLocale();
  const container = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [countSlot, setCountSlot] = useState<HTMLElement | null>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useOutsidePress(open, container, close);
  return (
    <span ref={container} className="bar-slot relative inline-flex shrink-0" data-bar-recent="" onKeyDown={open ? (event) => { handleOverlayEscape(event, () => { close(); trigger.current?.focus(); }); } : undefined}>
      <button
        ref={trigger}
        type="button"
        data-bar-control=""
        data-bar-recent-toggle=""
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("dash.recentAgents")}
        title={t("dash.recentAgents")}
        onClick={() => onOpenChange(!open)}
        className={`${BAR_CONTROL} ${open ? BAR_PRESSED : BAR_OUTLINED} w-8 px-0`}
      >
        <History className={BAR_ICON} aria-hidden />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("dash.recentAgents")}
          data-bar-recent-list=""
          className={`absolute right-0 top-full ${Z.popover} mt-1 flex max-h-[min(560px,calc(100dvh-64px))] w-[440px] max-w-[calc(100vw-32px)] flex-col rounded-control border border-border bg-card shadow-2`}
        >
          <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2.5">
            <History className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 truncate text-[12px] font-bold">{t("dash.recentAgents")}</span>
            <span ref={setCountSlot} className="inline-flex shrink-0" />
            <span aria-hidden className="min-w-0 flex-1" />
            <button type="button" className="inline-flex shrink-0 items-center rounded-[8px] border border-border bg-canvas px-1.5 py-0.5 text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" aria-label={t("common.close")} title={t("common.close")} onClick={close}>
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">{list(close, countSlot)}</div>
        </div>
      ) : null}
    </span>
  );
}

/* The seat state's colour on the Orchestrator toggle (#1841): success is
   working, warning needs you, danger failed, muted idle. */
const SEAT_DOT_TONE: Record<string, string> = {
  working: "bg-success",
  needs: "bg-warning",
  failed: "bg-danger",
  accent: "bg-accent",
  quiet: "bg-muted",
};

/**
 * The panel group, one segmented control: the orchestrator dock, the task
 * panel and, on the board, the recent agents (`tail`). Orchestrator and Tasks
 * carry their words while the row has room; the bar's `labels` step leaves
 * their icons (and the count), and the words stay in the tooltips.
 */
export function BarPanelToggles({ orchestrator, tasks, tail }: {
  /** The group's last segment: the recent agents' control. */
  tail?: ReactNode;
  /** `dot`: the collapsed seat's state (#1841), drawn on the icon so it stays
      readable with the seat out of view. */
  orchestrator: { open: boolean; onToggle: () => void; dot?: { tone: string; label: string } | null } | null;
  tasks: { open: boolean; count: number; onToggle: () => void };
}) {
  const { t } = useLocale();
  return (
    <div className="flex shrink-0 items-center" data-bar-group="panels">
      {orchestrator ? (
        <button
          type="button"
          onClick={orchestrator.onToggle}
          aria-pressed={orchestrator.open}
          aria-label={t("orchPanel.toggleAria")}
          title={t("orchPanel.toggleAria")}
          data-orchestrator-toggle
          data-bar-control=""
          className={`${BAR_CONTROL} ${orchestrator.open ? BAR_PRESSED : BAR_OUTLINED}`}
        >
          <span className="relative inline-flex">
            <Bot className={BAR_ICON} aria-hidden />
            {orchestrator.dot ? (
              <i
                className={`absolute -bottom-px -right-px h-1.5 w-1.5 rounded-full ring-1 ring-card ${SEAT_DOT_TONE[orchestrator.dot.tone] ?? "bg-muted"}`}
                data-orchestrator-toggle-dot={orchestrator.dot.tone}
                title={orchestrator.dot.label}
                aria-hidden
              />
            ) : null}
          </span>
          <span data-fit-label="">{t("orchPanel.title")}</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={tasks.onToggle}
        aria-pressed={tasks.open}
        aria-label={t("tasks.panelToggleAria")}
        title={t("tasks.panelToggleAria")}
        data-task-panel-toggle=""
        data-bar-control=""
        className={`${BAR_CONTROL} ${tasks.open ? BAR_PRESSED : BAR_OUTLINED}`}
      >
        <ListTodo className={BAR_ICON} aria-hidden />
        <span data-fit-label="">{t("tasks.panelTitle")}</span>
        {tasks.count ? <span className="font-normal text-muted tabular-nums">{tasks.count}</span> : null}
      </button>
      {tail}
    </div>
  );
}

/* Which section of the ⋯ is open, and whether it took the menu over as a page. */
const BarMenuContext = createContext<{ open: string | null; paged: boolean; show: (id: string | null, paged: boolean, press?: React.MouseEvent) => void } | null>(null);

/**
 * The ⋯ menu: everything the bar holds that is not used every minute. Its rows
 * are the controls themselves, so a confirm or a levels panel opens in place
 * and the menu stays open until the operator leaves it. `rows` receives a
 * `close` for the rows whose action is done in one click. What is used daily
 * rests as rows; the rest sits behind named sections (`BarMenuSection`), one
 * open at a time (docs/design/compact-card-menu.md).
 */
export function BarMoreMenu({ rows }: { rows: (close: () => void) => ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<{ id: string; paged: boolean } | null>(null);
  const container = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const swapped = useSwapGuard();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const show = (id: string | null, paged: boolean, press?: React.MouseEvent) => {
    /* A page replaces the list under the pointer, so the tail of a double click reaches no row of it. */
    if (paged) swapped(press);
    setSection(id ? { id, paged } : null);
  };

  return (
    <span ref={container} className="relative inline-flex shrink-0" data-bar-group="more">
      <button
        ref={trigger}
        type="button"
        data-bar-more=""
        data-bar-control=""
        aria-label={t("dash.more")}
        title={t("dash.more")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setSection(null); setOpen((was) => !was); }}
        className={`${BAR_QUIET} ${open ? "border-border bg-well text-primary" : ""}`}
      >
        <MoreHorizontal className={BAR_ICON} aria-hidden />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("dash.more")}
          data-bar-more-menu=""
          data-bar-menu-view={section?.id ?? "rest"}
          onKeyDown={(event) => { handleOverlayEscape(event, close); }}
          className={`absolute right-0 top-full ${Z.popover} mt-1 flex w-64 flex-col rounded-control border border-border bg-card p-1 shadow-2 ${MENU_RULES}`}
        >
          <BarMenuContext.Provider value={{ open: section?.id ?? null, paged: section?.paged ?? false, show }}>
            {rows(close)}
          </BarMenuContext.Provider>
        </div>
      ) : null}
    </span>
  );
}

/* A rule sits only between two groups that both drew a row: a group whose rows
   all stood down (Archive and Delete while agents run, accounts on a quiet
   project) is empty and hidden, and never leaves a rule behind. */
const MENU_RULES =
  "[&>[data-bar-menu-group]:not(:empty)~[data-bar-menu-group]:not(:empty)]:mt-1 [&>[data-bar-menu-group]:not(:empty)~[data-bar-menu-group]:not(:empty)]:border-t [&>[data-bar-menu-group]:not(:empty)~[data-bar-menu-group]:not(:empty)]:border-border [&>[data-bar-menu-group]:not(:empty)~[data-bar-menu-group]:not(:empty)]:pt-1";

/** One group of ⋯ rows. `sections` holds the menu's sections; every other group steps aside while a section is shown as a page. */
export function BarMenuGroup({ name, children }: { name: string; children: ReactNode }) {
  const menu = useContext(BarMenuContext);
  return <div role="group" data-bar-menu-group={name} className="flex flex-col gap-0.5 empty:hidden">{menu?.paged && name !== "sections" ? null : children}</div>;
}

/**
 * A named row of the ⋯ that holds rows of its own. It opens in place, its rows
 * under it, where the menu then stays short; `page` replaces the list with the
 * section and a back row, for rows that carry explanations. The rows stay
 * mounted while it is closed, so a section whose rows all stood down draws no
 * row of its own either.
 */
export function BarMenuSection({ id, title, icon, page = false, children }: { id: string; title: string; icon: ReactNode; page?: boolean; children: ReactNode }) {
  const menu = useContext(BarMenuContext);
  const open = menu?.open === id;
  const head = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  useEffect(() => {
    if (!page) return;
    if (open) back.current?.focus();
    else if (was.current) head.current?.focus();
    was.current = open;
  }, [open, page]);
  if (!menu) return <>{children}</>;
  const away = menu.paged && !open;
  return (
    <div data-bar-menu-section={id} className={`flex-col gap-0.5 [&:has(>[data-bar-menu-body]:empty)]:hidden ${away ? "hidden" : "flex"}`}>
      {open && page ? (
        <button ref={back} type="button" className={`${BAR_MENU_ROW} mb-0.5 rounded-b-none border-b border-border`} data-bar-menu-back={id} onClick={(event) => menu.show(null, true, event)}>
          <ChevronLeft className={BAR_ICON} aria-hidden /> {title}
        </button>
      ) : (
        <button
          ref={head}
          type="button"
          className={BAR_MENU_ROW}
          data-bar-menu-head={id}
          data-bar-menu-opens={page ? "page" : "place"}
          aria-haspopup={page ? "dialog" : undefined}
          aria-expanded={page ? undefined : open}
          onClick={(event) => menu.show(open ? null : id, page, event)}
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {/* A page is the arrow to the right; a section that opens in place points down, and up once its rows are under it. */}
          {page ? <ChevronRight className={`${BAR_ICON} text-muted`} aria-hidden /> : open ? <ChevronUp className={`${BAR_ICON} text-muted`} aria-hidden /> : <ChevronDown className={`${BAR_ICON} text-muted`} aria-hidden />}
        </button>
      )}
      <div data-bar-menu-body={id} className={open ? (page ? "flex flex-col gap-0.5" : "ml-[15px] flex flex-col gap-0.5 border-l border-border pl-1") : "hidden"}>{children}</div>
    </div>
  );
}

/**
 * The same bar on the leaves the kanban board does not draw (the empty project,
 * the loading skeleton): the project's two ends around this leaf's status line
 * and its one search. Its steps follow its width: under `BAR_WIDE_MIN` the
 * accounts are in ⋯ and the panel toggles are icons.
 */
export function DashboardBar({ lead, status, find, trail }: {
  lead: () => ReactNode;
  status: (wide: boolean) => ReactNode;
  find: (wide: boolean) => ReactNode;
  trail: (accountsInMenu: boolean) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wide = useBarWide(ref);
  return (
    <div
      ref={ref}
      data-project-bar=""
      data-fit={wide ? "" : "accounts labels"}
      className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-card px-4"
    >
      <div className={`flex shrink items-center gap-2 ${wide ? "" : "min-w-12"}`} data-bar-group="where">{lead()}</div>
      {status(wide)}
      <span aria-hidden className="min-w-0 flex-1" />
      {find(wide)}
      <div className="flex shrink-0 items-center gap-4" data-bar-group="trail">{trail(!wide)}</div>
      <BarIslandSlot />
    </div>
  );
}
