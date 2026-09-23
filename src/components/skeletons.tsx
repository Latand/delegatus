"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { useLocale, type MessageKey } from "@/lib/i18n";

import { kanbanColumnTracks, kanbanLayoutModeBeside, type KanbanLayoutMode } from "./kanban/kanbanLayout";
import { useKanbanSeat } from "./kanban/kanbanSeatStore";

/*
 * Loading placeholders in the shape of what replaces them (#2071,
 * docs/design/skeletons-and-transitions.md D3).
 *
 * Each one borrows its geometry from the component it stands in for, so the
 * swap to content is a same-place replacement with no fade and no jump: the
 * phone rows are `MobileBoard`'s cards, the desktop board is the kanban's own
 * `.kb` frame with its real column heads, the feed is bottom-anchored like
 * `LogFeed`. Section and column labels are the real, translated ones; only
 * the text that is not known yet is a bar.
 *
 * Only the bars move: a slow opacity pulse that starts after 400 ms, so a load
 * that lands sooner never pulses, and that stops under reduced motion.
 */

export const SKELETON_BAR = "skeleton-pulse rounded-[4px] bg-sunken motion-reduce:animate-none";

/** Title and meta widths, varied by row so a column of placeholders does not
    read as one repeated bar. Percentages of the row's text column. */
const TITLE_WIDTHS = [68, 58, 72, 62, 66, 60, 70, 64];
const META_WIDTHS = [42, 38, 46, 40, 44, 39, 45, 41];

function Bar({ width, height, className = "" }: { width: string; height: number; className?: string }) {
  return <span aria-hidden className={`block shrink-0 ${SKELETON_BAR} ${className}`} style={{ width, height }} />;
}

function Status({ label, className, style, children, testId }: { label: string; className: string; style?: CSSProperties; children: React.ReactNode; testId: string }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" data-skeleton={testId} className={className} style={style}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** One placeholder row of the phone board (`MobileBoard`'s CARD at min-h-14). */
export function SkeletonRow({ index, quiet = false, dot = true, compact = false }: { index: number; quiet?: boolean; dot?: boolean; compact?: boolean }) {
  return (
    <div
      aria-hidden
      data-skeleton-row=""
      className={`flex w-full items-center gap-2.5 rounded-[12px] py-2 pl-3 pr-2.5 ${compact ? "min-h-11" : "min-h-14"} ${quiet ? "bg-quiet ring-1 ring-inset ring-border" : "bg-card shadow-1"}`}
    >
      {dot ? <span className="h-2 w-2 shrink-0 rounded-full bg-sunken" /> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Bar width={`${TITLE_WIDTHS[index % TITLE_WIDTHS.length]}%`} height={12} />
        {compact ? null : <Bar width={`${META_WIDTHS[index % META_WIDTHS.length]}%`} height={10} />}
      </span>
    </div>
  );
}

/** The phone board's section header (`MobileBoard`'s Section). */
function SkeletonSection({ label, id }: { label: string; id: string }) {
  return (
    <div data-skeleton-section={id} className="flex min-h-[34px] items-center gap-1.5 px-3 pt-1.5 text-label font-semibold text-secondary">
      {label}
    </div>
  );
}

/** The seat card's placeholder: the 56 px card with its round mark. */
function SkeletonSeat() {
  return (
    <div className="px-3" aria-hidden>
      <div data-skeleton-seat="" className="flex min-h-14 items-center gap-3 rounded-[12px] bg-card px-3 py-2 shadow-1">
        <span className="h-8 w-8 shrink-0 rounded-full bg-sunken" />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Bar width="42%" height={12} />
          <Bar width="58%" height={10} />
        </span>
      </div>
    </div>
  );
}

export type BoardRowsVariant = "board" | "list" | "rail";

/**
 * Rows in the shape of the phone board and every list that uses its cards:
 * - `board`: the Orchestrator section with a seat placeholder, then Working,
 *   exactly where `MobileBoard` draws them;
 * - `list`: quiet rows only (the conversation list, the focus view's leaf,
 *   the project sheet);
 * - `rail`: 44 px rows without the state dot (the desktop rail).
 * The column runs to the bottom of its box; what does not fit is clipped.
 */
export function BoardRowsSkeleton({ variant = "board", rows = 10, className = "" }: { variant?: BoardRowsVariant; rows?: number; className?: string }) {
  const { t } = useLocale();
  const list = Array.from({ length: rows }, (_, index) => (
    <SkeletonRow key={index} index={index} quiet={variant === "list"} dot={variant !== "rail"} compact={variant === "rail"} />
  ));
  return (
    <Status
      testId={`rows-${variant}`}
      label={t(variant === "board" ? "dash.loadingBoard" : "common.loadingCap")}
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${variant === "board" ? "pb-3" : variant === "rail" ? "gap-1 px-1.5 py-1" : "gap-1.5 px-3 py-2"} ${className}`}
    >
      {variant === "board" ? (
        <>
          <SkeletonSection label={t("mobile2.board.orchestrator")} id="orchestrator" />
          <SkeletonSeat />
          <SkeletonSection label={t("mobile2.board.working")} id="working" />
          <div className="flex flex-col gap-1.5 px-3">{list}</div>
        </>
      ) : list}
    </Status>
  );
}

const KANBAN_COLUMNS = ["inbox", "assigned", "blocked", "done"] as const;
const COLUMN_LABEL: Record<(typeof KANBAN_COLUMNS)[number], MessageKey> = {
  inbox: "kanban.status.inbox",
  assigned: "kanban.status.assigned",
  blocked: "kanban.status.blocked",
  done: "kanban.status.done",
};
/** Card placeholders per column: two waiting, one assigned, none elsewhere. */
const COLUMN_CARDS: Record<(typeof KANBAN_COLUMNS)[number], number> = { inbox: 2, assigned: 1, blocked: 0, done: 0 };

function KanbanCardSkeleton({ index }: { index: number }) {
  return (
    <div aria-hidden data-skeleton-card="" className="mx-3 mb-2 flex flex-col gap-2 rounded-[10px] border border-border bg-card p-3 shadow-1">
      <Bar width={`${TITLE_WIDTHS[index % TITLE_WIDTHS.length]}%`} height={12} />
      <Bar width={`${META_WIDTHS[index % META_WIDTHS.length]}%`} height={10} />
    </div>
  );
}

/**
 * The columns of a loading kanban, inside the board frame: the navigation
 * strip the scroll and tab modes draw, then the four wells with their real
 * heads. The kanban's own loading branch and `KanbanSkeleton` both draw this.
 */
export function KanbanColumnsSkeleton({ mode, style, status = true }: { mode: KanbanLayoutMode; style?: CSSProperties; status?: boolean }) {
  const { t } = useLocale();
  return (
    <div
      className="scroll-wrap"
      data-board-wrap={mode}
      data-kanban-columns-skeleton=""
      {...(status ? { role: "status", "aria-busy": true, "aria-live": "polite" as const } : {})}
    >
      {status ? <span className="sr-only">{t("kanban.loading")}</span> : null}
      {mode === "scroll" || mode === "tabs" ? (
        <div className={`tabs-nav${mode === "scroll" ? " jump" : ""}`} aria-hidden>
          {KANBAN_COLUMNS.map((status) => (
            /* The strip's own buttons, inert: `.tabs-nav button` sizes them. */
            <button key={status} type="button" tabIndex={-1} aria-selected={mode === "tabs" ? status === "assigned" : undefined}>{t(COLUMN_LABEL[status])}</button>
          ))}
        </div>
      ) : null}
      <div className={`board${mode === "tabs" ? " tabs" : mode === "scroll" ? " scroll" : mode === "narrow" ? " narrow" : ""}`} data-mode={mode} style={style}>
        {KANBAN_COLUMNS.map((status, column) => (
          /* The tab face opens on Assigned, as the board does. */
          <section key={status} className={`column${mode === "tabs" && status === "assigned" ? " active" : ""}`} data-status={status}>
            <div className="col-head"><h2>{t(COLUMN_LABEL[status])}</h2></div>
            {Array.from({ length: COLUMN_CARDS[status] }, (_, index) => <KanbanCardSkeleton key={index} index={column * 2 + index} />)}
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * The desktop board while it loads: the kanban's own `.kb` frame, so the seat
 * sits where the seat will be (at this browser's height, fold state and
 * placement), the columns take the tracks `kanbanColumnTracks` gives the real
 * board at this width, and the heads carry their real names. The bar above is
 * the dashboard's own and is not drawn here.
 *
 * `overview` leaves the seat out, as the cross-project board does.
 */
export function KanbanSkeleton({ project = null, overview = false }: { project?: string | null; overview?: boolean }) {
  const { t } = useLocale();
  const seat = useKanbanSeat(project ?? "");
  const withSeat = !overview && project !== null;
  const side = withSeat && seat.placement === "side";
  const rootRef = useRef<HTMLDivElement>(null);
  /* The real board picks its mode from its measured width; so does this one,
     before the first paint. */
  const [mode, setMode] = useState<KanbanLayoutMode>("wide");
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const measure = () => setMode(kanbanLayoutModeBeside(node.getBoundingClientRect().width, side ? seat.width : 0));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [side, seat.width]);
  const tracks = kanbanColumnTracks(mode, { overview, wide: null, reading: new Set() });
  const seatStyle = side
    ? (seat.collapsed ? undefined : ({ "--seat-w": `${seat.width}px` } as CSSProperties))
    : seat.height !== null && !seat.collapsed ? ({ "--seat-h": `${seat.height}px` } as CSSProperties) : undefined;
  const seatView = withSeat ? (
    <section aria-hidden data-skeleton-seat="" className={`seat${side ? " side" : ""}${seat.collapsed ? " folded" : ""}`} style={seatStyle}>
      <div className="seat-head">
        <span className="h-6 w-6 shrink-0 rounded-full bg-sunken" />
        <span className="text-[13px] font-semibold text-primary">{t("orchPanel.title")}</span>
        <Bar width="96px" height={10} />
      </div>
    </section>
  ) : null;
  return (
    <div ref={rootRef} className="kb" data-kanban-skeleton="" data-mode={mode}>
      <Status testId="kanban" label={t("dash.loadingBoard")} className={`kb-body${side ? " seat-side" : ""}`}>
        {side ? seatView : null}
        <div className="kb-page">
          {side ? null : seatView}
          <div className="board-frame">
            <KanbanColumnsSkeleton mode={mode} style={tracks ? (tracks as CSSProperties) : undefined} status={false} />
          </div>
        </div>
      </Status>
    </div>
  );
}

/**
 * A conversation feed with nothing cached yet, bottom-anchored like the feed:
 * from the bottom up, an assistant block of three lines, the operator's bubble
 * on the right, and one more assistant block. The bar and the composer around
 * it are the real ones.
 */
export function FeedSkeleton({ className = "" }: { className?: string }) {
  const { t } = useLocale();
  const block = (key: string, widths: string[]) => (
    <div key={key} aria-hidden className="flex flex-col gap-2">
      {widths.map((width, index) => <Bar key={index} width={width} height={11} />)}
    </div>
  );
  return (
    <Status testId="feed" label={t("common.loadingCap")} className={`flex min-h-0 flex-1 flex-col justify-end gap-5 overflow-hidden px-4 pb-4 pt-6 ${className}`}>
      {block("earlier", ["92%", "84%", "48%"])}
      <div aria-hidden data-skeleton-bubble="" className="ml-auto flex w-[55%] flex-col gap-2 rounded-[12px] bg-card p-3 shadow-1">
        <Bar width="90%" height={11} />
        <Bar width="60%" height={11} />
      </div>
      {block("latest", ["100%", "100%", "60%"])}
    </Status>
  );
}

/** Account rows while the accounts load: a name and a meter per row. */
export function AccountRowsSkeleton({ rows = 2, className = "" }: { rows?: number; className?: string }) {
  const { t } = useLocale();
  return (
    <Status testId="accounts" label={t("common.loadingCap")} className={`flex flex-col gap-1.5 ${className}`}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden data-skeleton-account="" className="flex min-h-11 items-center gap-3 rounded-[8px] px-2">
          <Bar width={index % 2 ? "24%" : "30%"} height={11} />
          <span className="flex-1" />
          <Bar width="36%" height={6} />
        </div>
      ))}
    </Status>
  );
}

/** The title bar's placeholder while a project's name is not known yet: a
    96 × 12 px bar where the name will be, never the canonical key. */
export function TitleSkeleton() {
  return <span aria-hidden data-title-skeleton="" className={`inline-block h-3 w-24 shrink-0 align-middle ${SKELETON_BAR}`} />;
}
