"use client";

import { Bot, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ListTodo, MoreHorizontal, Plus } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Z } from "@/components/layers";
import { useSwapGuard } from "@/components/menuSwapGuard";
import { useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";

/*
 * The project board's one header bar (#1801, docs/design/board-header.md).
 *
 * One 48 px row, eight groups in reading order: where am I, what is happening,
 * one spacer, find, view, create, panels, more, and the Viewer's attention
 * island in the right reserve. Every control is 32 px in one of three variants:
 * outlined, pressed (`aria-pressed="true"`), and the quiet icon of the ⋯
 * trigger. Hover only strengthens the border, so pressed stays the one
 * accent-coloured state. The kanban board draws the bar with its own groups in
 * the middle; the leaves without a board draw the same bar here, with the same
 * two ends.
 */

const BarIslandSlotContext = createContext<((slot: HTMLElement | null) => void) | null>(null);

/**
 * Where the Viewer's attention island sits in the document. It is drawn fixed
 * over the bar's right reserve, after ⋯, so on a project leaf it is also placed
 * in the DOM after ⋯: the bar's last child is a slot, and the island is portaled
 * into it, which keeps keyboard focus in the order the bar is read. With no
 * slot mounted (the Overview, the phone) the island stays ahead of `children`,
 * where it always was.
 */
export function BarIslandProvider({ island, children }: { island: ReactNode; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <BarIslandSlotContext.Provider value={setSlot}>
      {slot ? null : island}
      {children}
      {slot ? createPortal(island, slot) : null}
    </BarIslandSlotContext.Provider>
  );
}

/** The bar's last child: the island's place in the tab order. It draws no box, so the row does not move. */
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

/** At or above this bar width the controls carry their labels and the account switches sit in
    the bar; below it they are icons and the accounts move into ⋯. Measured on a seeded home, the
    uk labels with two account switches and a short project name need about 1 640 px of bar
    (the island's 252 px of padding and reserve included); 1 700 leaves room for a longer name. */
export const BAR_WIDE_MIN = 1700;

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
 * The create group: `+ Task` and `+ Agent`, or one `+` opening a two-row menu
 * when the bar is narrow. `reserve` draws the same group invisible and inert on
 * the leaves that create nothing (Conversations), so the view switch and
 * everything right of it keep their x when the operator changes view.
 */
export function BarCreateGroup({ wide, task, agent, onMenu, menuOpen = false, reserve = false }: {
  wide: boolean;
  task?: { onClick: () => void; expanded: boolean } | null;
  agent?: { onClick: () => void; disabled: boolean } | null;
  /** Narrow: opens the create menu under the `+`. */
  onMenu?: (anchor: HTMLElement) => void;
  menuOpen?: boolean;
  reserve?: boolean;
}) {
  const { t } = useLocale();
  const control = `${BAR_CONTROL} ${BAR_OUTLINED} disabled:cursor-not-allowed disabled:opacity-50`;
  if (reserve) {
    return (
      <div className="invisible flex shrink-0 items-center gap-2" data-bar-group="create" data-bar-create-reserve="" aria-hidden inert>
        {wide ? (
          <>
            <span className={control}><Plus className={BAR_ICON} aria-hidden />{t("dash.task")}</span>
            <span className={control}><Plus className={BAR_ICON} aria-hidden />{t("dash.agent")}</span>
          </>
        ) : <span className={`${control} w-8 px-0`}><Plus className={BAR_ICON} aria-hidden /></span>}
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2" data-bar-group="create">
      {wide || !onMenu ? (
        <>
          {task ? (
            <button type="button" className={control} data-new-task="" data-bar-control="" aria-label={t("dash.newTask")} aria-expanded={task.expanded} onClick={task.onClick}>
              <Plus className={BAR_ICON} aria-hidden />{t("dash.task")}
            </button>
          ) : null}
          {agent ? (
            <button type="button" className={control} data-new-agent="" data-bar-control="" aria-label={t("dash.newConvo")} disabled={agent.disabled} onClick={agent.onClick}>
              <Plus className={BAR_ICON} aria-hidden />{t("dash.agent")}
            </button>
          ) : null}
        </>
      ) : (
        <button
          type="button"
          className={`${control} w-8 px-0`}
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
      )}
    </div>
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

/** The two panel switches: the orchestrator dock and the task panel. Icon only (with the count) when narrow. */
export function BarPanelToggles({ wide, orchestrator, tasks }: {
  wide: boolean;
  /** `dot`: the collapsed seat's state (#1841), drawn on the icon so it stays
      readable with the seat out of view. */
  orchestrator: { open: boolean; onToggle: () => void; dot?: { tone: string; label: string } | null } | null;
  tasks: { open: boolean; count: number; onToggle: () => void };
}) {
  const { t } = useLocale();
  return (
    <div className="flex shrink-0 items-center gap-2" data-bar-group="panels">
      {orchestrator ? (
        <button
          type="button"
          onClick={orchestrator.onToggle}
          aria-pressed={orchestrator.open}
          aria-label={t("orchPanel.toggleAria")}
          title={t("orchPanel.toggleAria")}
          data-orchestrator-toggle
          data-bar-control=""
          className={`${BAR_CONTROL} ${orchestrator.open ? BAR_PRESSED : BAR_OUTLINED} ${wide ? "" : "px-2"}`}
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
          {wide ? t("orchPanel.title") : null}
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
        className={`${BAR_CONTROL} ${tasks.open ? BAR_PRESSED : BAR_OUTLINED} ${wide ? "" : "px-2"}`}
      >
        <ListTodo className={BAR_ICON} aria-hidden />
        {wide ? t("tasks.panelTitle") : null}
        {tasks.count ? <span className="font-normal text-muted tabular-nums">{tasks.count}</span> : null}
      </button>
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
 * The same bar on the leaves the kanban board does not draw (Conversations, the
 * empty project, the loading skeleton): the project's two ends around this
 * leaf's status line, its one search, the view switch and the create group's
 * reserve.
 */
export function DashboardBar({ lead, status, find, view, create, trail }: {
  lead: (wide: boolean) => ReactNode;
  status: (wide: boolean) => ReactNode;
  find: (wide: boolean) => ReactNode;
  view: (wide: boolean) => ReactNode;
  create: (wide: boolean) => ReactNode;
  trail: (wide: boolean) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wide = useBarWide(ref);
  return (
    <div
      ref={ref}
      data-project-bar=""
      data-bar-tier={wide ? "wide" : "narrow"}
      className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-card pl-4 pr-[236px]"
    >
      <div className={`flex shrink items-center gap-2 ${wide ? "" : "min-w-12"}`} data-bar-group="where">{lead(wide)}</div>
      {status(wide)}
      <span aria-hidden className="min-w-0 flex-1" />
      {find(wide)}
      <div className="flex shrink-0 items-center gap-2 empty:hidden" data-bar-group="view">{view(wide)}</div>
      {create(wide)}
      <div className="flex shrink-0 items-center gap-4" data-bar-group="trail">{trail(wide)}</div>
      <BarIslandSlot />
    </div>
  );
}
