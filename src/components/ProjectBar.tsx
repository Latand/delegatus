"use client";

import { Bot, ListTodo, MoreHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";

/*
 * The project board's one header bar (#1801, docs/design/board-header.md).
 *
 * One 48 px row, eight groups in reading order: where am I, what is happening,
 * one spacer, find, view, create, panels, more, and the Viewer's attention
 * island in the right reserve. Every control is 32 px in one of three variants:
 * outlined, pressed (`aria-pressed="true"`), and the quiet icon of the ⋯
 * trigger. The kanban board draws the bar with its own groups in the middle;
 * the leaves without a board draw the same bar here, with the same two ends.
 */

/** At or above this bar width the controls carry their labels and the account switches sit in
    the bar; below it they are icons and the accounts move into ⋯. Labelled, with two account
    switches, the groups need about 1 300 px beside the island's 252 px of padding and reserve. */
export const BAR_WIDE_MIN = 1600;

export const BAR_CONTROL =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control border px-3 text-[12px] font-semibold shadow-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
export const BAR_OUTLINED = "border-border bg-card text-primary hover:border-accent/45 hover:text-accent";
export const BAR_PRESSED = "border-accent/45 bg-accent/10 text-accent";
const BAR_QUIET =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-transparent text-secondary transition-colors hover:border-border hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

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

/** The two panel switches: the orchestrator dock and the task panel. Icon only (with the count) when narrow. */
export function BarPanelToggles({ wide, orchestrator, tasks }: {
  wide: boolean;
  orchestrator: { open: boolean; onToggle: () => void } | null;
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
          <Bot className="h-[15px] w-[15px]" aria-hidden />
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
        <ListTodo className="h-[15px] w-[15px]" aria-hidden />
        {wide ? t("tasks.panelTitle") : null}
        {tasks.count ? <span className="font-normal text-muted tabular-nums">{tasks.count}</span> : null}
      </button>
    </div>
  );
}

/**
 * The ⋯ menu: everything the bar holds that is not used every minute. Its rows
 * are the controls themselves, so a confirm or a levels panel opens in place
 * and the menu stays open until the operator leaves it. `rows` receives a
 * `close` for the rows whose action is done in one click.
 */
export function BarMoreMenu({ rows }: { rows: (close: () => void) => ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

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
        onClick={() => setOpen((was) => !was)}
        className={`${BAR_QUIET} ${open ? "border-border bg-well text-primary" : ""}`}
      >
        <MoreHorizontal className="h-[15px] w-[15px]" aria-hidden />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("dash.more")}
          data-bar-more-menu=""
          onKeyDown={(event) => { handleOverlayEscape(event, close); }}
          className="absolute right-0 top-full z-50 mt-1 flex w-64 flex-col gap-0.5 rounded-control border border-border bg-card p-1 shadow-2"
        >
          {rows(close)}
        </div>
      ) : null}
    </span>
  );
}

/** A thin rule between groups of ⋯ rows. */
export function BarMenuSeparator() {
  return <div role="separator" className="my-0.5 h-px bg-border" />;
}

/**
 * The same bar on the leaves the kanban board does not draw (Conversations, the
 * empty project, the loading skeleton): the project's two ends around this
 * leaf's status line, its one search and the view switch.
 */
export function DashboardBar({ lead, status, find, view, trail }: {
  lead: (wide: boolean) => ReactNode;
  status: ReactNode;
  find: ReactNode;
  view: (wide: boolean) => ReactNode;
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
      <div className="flex min-w-0 shrink items-center gap-2" data-bar-group="where">{lead(wide)}</div>
      {status}
      <span aria-hidden className="min-w-0 flex-1" />
      {find}
      <div className="flex shrink-0 items-center gap-2 empty:hidden" data-bar-group="view">{view(wide)}</div>
      <div className="flex shrink-0 items-center gap-2" data-bar-group="trail">{trail(wide)}</div>
    </div>
  );
}
