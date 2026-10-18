"use client";

import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { useModalLayer } from "@/components/modalLayer";
import { useLocale } from "@/lib/i18n";

import { MobileReceipt, type ReceiptStore } from "./MobileReceipt";
import type { MobileSheetName } from "./mobileNav";
import { Z } from "@/components/layers";

/*
 * The one sheet (docs/design/mobile-v2/README.md §2 rule 1, §3.3, §5): a
 * secondary surface opens over the current screen, takes at most 88 % of the
 * height, keeps the screen behind visible and dimmed, and closes with one tap
 * on the scrim, the ×, Escape, or a drag of its handle past 80 px — the handle
 * and the header follow the finger, and a shorter drag springs back over
 * 200 ms. It is modal in the sense `useModalLayer` already implements: Tab is
 * trapped, Escape answers, body scroll locks, focus returns to the opener.
 *
 * A sheet never creates a history entry; the navigation store (`mobileNav`)
 * says which one is open, and the shell renders it last. The receipt slot
 * inside a sheet sits between its body and its footer, the same slot the
 * screen's receipt takes between the body and the dock.
 *
 * A `pinned` block stands between the header and the body, outside the body's
 * scroller, so scrolling the body never carries it away; it bounds and scrolls
 * its own rows (the needs-you sheet's «Готово», docs/design/done-section.md §4.3).
 *
 * An `expandable` sheet has a second detent. It opens as above (the first
 * detent, at most 88 %); a pull of the handle or the header upward, or a flick,
 * grows it with the finger to nearly the full screen (the second detent, which
 * leaves the top bar and the safe area showing), where its body is the one
 * scroller. From there a drag down, or a flick, folds it back to the first
 * detent, and only from the first detent does a drag close it. A tap on the
 * handle switches between the two for a person who does not drag. On such a
 * sheet the handle is a native button (`aria-expanded`, Enter and Space), 44 px
 * high above the header; a tap and the click that follows it switch the detent
 * once, and a click with no press (Enter, Space, assistive tech) switches it too.
 */

/** A drag of the handle past this many pixels closes the sheet. */
export const SHEET_CLOSE_DRAG_PX = 80;

/** An upward drag past this many pixels opens an expandable sheet to its full height. */
export const SHEET_EXPAND_DRAG_PX = 40;

/** A release faster than this (px per ms) is a flick, whatever the distance. */
export const SHEET_FLICK_PX_PER_MS = 0.5;

/** A flick needs at least this much travel, so a twitch is not one. */
const SHEET_FLICK_MIN_PX = 12;

/** A release this long after the last move is a pause, not a flick. */
const SHEET_FLICK_WINDOW_MS = 120;

/** A drag shorter than this on the handle is a tap. */
const SHEET_TAP_PX = 6;

/** The click that follows a press of the handle came from the same press. */
const SHEET_TAP_CLICK_MS = 500;

/** The expanded detent: the screen less the safe area and the top bar (3.5 rem),
    so the bar stays visible over the scrim. The sheet's class below says the same,
    and never goes under the first detent (a landscape phone has less than that). */
const EXPANDED_HEIGHT = "calc(100% - env(safe-area-inset-top) - 3.5rem)";
const EXPANDED_CLASS = "h-[calc(100%-env(safe-area-inset-top)-3.5rem)] min-h-[88%] max-h-none";
const EXPANDED_MIN = "88%";

export type SheetDetent = "collapsed" | "expanded";

/** What a release of the handle does: `velocity` is px per ms, negative upward,
    and `dy` the drag's signed distance, negative upward. */
export function sheetRelease({ detent, dy, velocity }: { detent: SheetDetent; dy: number; velocity: number }): "close" | "expand" | "collapse" | "stay" {
  const flickUp = velocity <= -SHEET_FLICK_PX_PER_MS && dy <= -SHEET_FLICK_MIN_PX;
  const flickDown = velocity >= SHEET_FLICK_PX_PER_MS && dy >= SHEET_FLICK_MIN_PX;
  if (detent === "collapsed") {
    if (dy <= -SHEET_EXPAND_DRAG_PX || flickUp) return "expand";
    return dy > SHEET_CLOSE_DRAG_PX ? "close" : "stay";
  }
  return dy > SHEET_CLOSE_DRAG_PX || flickDown ? "collapse" : "stay";
}

/** Controls a drag must never start from: a pointer that lands on one is a
    tap on it. */
const HEADER_CONTROL = "button, a[href], input, select, textarea, [role='button']";

/** True when the pointer landed on a control inside `within` (the header's ×,
    an `extra` control such as the queue's «Dismiss all»). Capturing that pointer for
    a drag would make Chromium retarget the tap's click to the capturing
    header, and the control would never fire. */
function isControlTarget(target: EventTarget | null, within: HTMLElement): boolean {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") return false;
  const control = element.closest(HEADER_CONTROL);
  return control !== null && control !== within && within.contains(control);
}

const CLOSE_BUTTON = "flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-secondary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

export function MobileSheet({
  name,
  title,
  extra,
  footer,
  pinned,
  expandable = false,
  full = false,
  titleHidden = false,
  onClose,
  children,
  receiptStore,
}: {
  name: MobileSheetName;
  title: string;
  /** A header control beside the title (the queue's «Dismiss all», the switcher's «Board ›»). */
  extra?: ReactNode;
  footer?: ReactNode;
  /** A block pinned above the scrolling body; it caps its own height. */
  pinned?: ReactNode;
  /** A second detent at nearly full height, reached by dragging the handle up (see above). */
  expandable?: boolean;
  /** Fullscreen (the prototype review): no handle, no rounded top, the footer at the screen's foot. */
  full?: boolean;
  /** The title only names the dialog for assistive tech: the body already says what it holds. */
  titleHidden?: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Tests inject their own receipt store; the app uses the singleton. */
  receiptStore?: ReceiptStore;
}) {
  const { t } = useLocale();
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number; grab: boolean; start: number; low: number; high: number; lastY: number; lastAt: number; velocity: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressedAt = useRef<number | null>(null);
  useModalLayer({ containerRef: sheetRef, onClose });
  useEffect(() => () => { if (clearTimer.current) clearTimeout(clearTimer.current); }, []);
  const detent: SheetDetent = expandable && expanded ? "expanded" : "collapsed";

  /** The height the sheet would have with `height`, `maxHeight` and `minHeight` set, in px. */
  const measure = (sheet: HTMLElement, height: string, maxHeight: string, minHeight: string) => {
    const { height: h, maxHeight: m, minHeight: n } = sheet.style;
    sheet.style.height = height;
    sheet.style.maxHeight = maxHeight;
    sheet.style.minHeight = minHeight;
    const px = sheet.offsetHeight;
    sheet.style.height = h;
    sheet.style.maxHeight = m;
    sheet.style.minHeight = n;
    return px;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (full) return;
    /* Only the grab handle and the header's title text start a drag; a
       pointer on the × or another header control is that control's tap. */
    if (isControlTarget(event.target, event.currentTarget)) return;
    if (clearTimer.current) { clearTimeout(clearTimer.current); clearTimer.current = null; }
    pressedAt.current = null;
    const sheet = sheetRef.current;
    const grab = event.currentTarget.hasAttribute("data-mobile2-grab");
    drag.current = { y: event.clientY, dy: 0, grab, start: 0, low: 0, high: 0, lastY: event.clientY, lastAt: performance.now(), velocity: 0 };
    if (sheet) {
      sheet.style.transition = "none";
      if (expandable) {
        /* Pin the height in px so the sheet can follow the finger up and down
           between its two detents. The first detent is measured without the
           expanded class's minimum, so a short sheet folds to its own height. */
        const low = measure(sheet, "auto", "88%", "0");
        const high = Math.max(low, measure(sheet, EXPANDED_HEIGHT, "none", EXPANDED_MIN));
        const current = detent === "expanded" ? high : low;
        drag.current.low = low;
        drag.current.high = high;
        drag.current.start = current;
        sheet.style.maxHeight = "none";
        sheet.style.minHeight = "0";
        sheet.style.height = `${current}px`;
      }
    }
    const target = event.currentTarget;
    if (typeof target.setPointerCapture === "function") {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        /* A synthetic pointer without an id: the move and up still arrive here. */
      }
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    const raw = event.clientY - current.y;
    const at = performance.now();
    if (at > current.lastAt) current.velocity = (event.clientY - current.lastY) / (at - current.lastAt);
    current.lastY = event.clientY;
    current.lastAt = at;
    const sheet = sheetRef.current;
    if (!expandable) {
      current.dy = Math.max(0, raw);
      if (sheet) sheet.style.transform = `translateY(${current.dy}px)`;
      return;
    }
    current.dy = raw;
    if (!sheet) return;
    sheet.style.height = `${Math.min(current.high, Math.max(current.low, current.start - raw))}px`;
    /* Only the first detent slides off the screen (towards closing); the second shrinks to the first. */
    sheet.style.transform = detent === "collapsed" ? `translateY(${Math.max(0, raw)}px)` : "";
  };
  const settle = (release: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    const sheet = sheetRef.current;
    const spring = "transform 200ms cubic-bezier(0.2, 0, 0, 1)";
    if (!expandable) {
      if (release && current.dy > SHEET_CLOSE_DRAG_PX) {
        onClose();
        return;
      }
      if (sheet) {
        sheet.style.transition = spring;
        sheet.style.transform = "";
      }
      return;
    }
    const still = performance.now() - current.lastAt > SHEET_FLICK_WINDOW_MS;
    const tap = release && current.grab && Math.abs(current.dy) < SHEET_TAP_PX;
    /* Any press of the handle ends in a click the pointer path has already answered. */
    if (release && current.grab) pressedAt.current = performance.now();
    const outcome = !release ? "stay" : tap ? (detent === "collapsed" ? "expand" : "collapse") : sheetRelease({ detent, dy: current.dy, velocity: still ? 0 : current.velocity });
    if (outcome === "close") {
      onClose();
      return;
    }
    const next: SheetDetent = outcome === "expand" ? "expanded" : outcome === "collapse" ? "collapsed" : detent;
    if (sheet) {
      /* Run the last stretch to the detent in px, then hand the height back to the classes. */
      sheet.style.transition = "height 200ms cubic-bezier(0.2, 0, 0, 1), transform 200ms cubic-bezier(0.2, 0, 0, 1)";
      sheet.style.transform = "";
      sheet.style.height = `${next === "expanded" ? current.high : current.low}px`;
      clearTimer.current = setTimeout(() => {
        clearTimer.current = null;
        sheet.style.height = "";
        sheet.style.maxHeight = "";
        sheet.style.minHeight = "";
        sheet.style.transition = "";
      }, 220);
    }
    setExpanded(next === "expanded");
  };
  /* A press of the handle already had its answer (a tap switches the detent, a
     drag moves it); the pointer click it ends in (`detail` above 0) is not
     another. Enter, Space and a screen reader's activation arrive as a click
     with `detail` 0, and that is the keyboard's way to the switch. */
  const onGrabClick = (event: ReactMouseEvent<HTMLElement>) => {
    const pressed = pressedAt.current;
    pressedAt.current = null;
    if (event.detail > 0 && pressed !== null && performance.now() - pressed < SHEET_TAP_CLICK_MS) return;
    setExpanded(detent !== "expanded");
  };
  const onPointerUp = () => settle(true);
  const onPointerCancel = () => settle(false);
  const handle = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };

  return (
    <div
      className={`fixed inset-0 ${Z.sheet} flex flex-col justify-end bg-black/40`}
      role="presentation"
      data-mobile2-scrim
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-mobile2-sheet={name}
        data-mobile2-detent={expandable ? detent : undefined}
        className={`flex flex-col bg-raised shadow-2 outline-none transition-[transform,opacity] duration-[320ms] ease-[cubic-bezier(0.2,0,0,1)] starting:translate-y-6 starting:opacity-0 motion-reduce:transition-none ${
          full ? "h-full max-h-full rounded-none pt-[env(safe-area-inset-top)]" : detent === "expanded" ? `${EXPANDED_CLASS} rounded-t-[16px]` : "max-h-[88%] rounded-t-[16px]"
        } pb-[calc(6px+env(safe-area-inset-bottom))]`}
      >
        {full ? null : expandable ? (
          <button
            type="button"
            className="group flex h-11 w-full shrink-0 touch-none items-center justify-center px-6 outline-none"
            aria-label={t("mobile2.sheet.expand")}
            aria-expanded={detent === "expanded"}
            data-mobile2-grab
            onClick={onGrabClick}
            {...handle}
          >
            <span className="block h-1 w-9 rounded-sm bg-strong group-focus-visible:ring-2 group-focus-visible:ring-accent/60 group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-raised" aria-hidden />
          </button>
        ) : (
          <div className="shrink-0 touch-none px-6 pb-0.5 pt-2" data-mobile2-grab {...handle}>
            <div className="mx-auto h-1 w-9 rounded-sm bg-strong" aria-hidden />
          </div>
        )}
        <div className="flex min-h-12 shrink-0 touch-none items-center gap-1 pl-4 pr-1" data-mobile2-sheet-header {...handle}>
          <h2 className={titleHidden ? "sr-only" : "min-w-0 flex-1 truncate text-title font-semibold text-primary"}>{title}</h2>
          {titleHidden ? <span className="flex-1" aria-hidden /> : null}
          {extra}
          <button type="button" className={CLOSE_BUTTON} aria-label={t("mobile2.sheet.close")} data-mobile2-close onClick={onClose}>
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        {pinned}
        {/* A full sheet's body takes the height the header and the footer leave,
            so the footer stands at the foot of the screen whatever the body holds. */}
        <div className={`min-h-0 overflow-y-auto overflow-x-hidden pb-1 ${full || detent === "expanded" ? "flex-1" : ""}`} data-mobile2-sheet-body>
          {children}
        </div>
        <MobileReceipt store={receiptStore} placement="sheet" />
        {footer ? <div className="flex shrink-0 gap-2 px-4 pt-2.5">{footer}</div> : null}
      </div>
    </div>
  );
}

/** A section header inside a sheet (the prototype's `.sh`). */
export function MobileSheetSection({ children, count, className = "" }: { children: ReactNode; count?: number; className?: string }) {
  return (
    <div className={`flex min-h-[34px] items-center gap-1.5 px-4 pt-1.5 text-label font-semibold text-secondary ${className}`}>
      {children}
      {count !== undefined ? <span className="text-caption font-semibold tabular-nums text-muted">{count}</span> : null}
    </div>
  );
}

export function MobileSheetDivider() {
  return <div className="my-1.5 h-px shrink-0 bg-border" aria-hidden />;
}

/** A row of icon cells for a sheet's most frequent actions: an icon over a
    short name, with the same inset at both edges of the sheet. */
export function MobileSheetCells({ label, children, attrs }: { label?: string; children: ReactNode; attrs?: Record<`data-${string}`, string | undefined> }) {
  return <div role="group" aria-label={label} {...attrs} className="grid auto-cols-fr grid-flow-col gap-1 px-3 py-1">{children}</div>;
}

/** One cell of `MobileSheetCells`. `label` is the action's full name, read where the short caption is not enough. */
export function MobileSheetCell({ icon, caption, label, onSelect, attrs }: {
  icon: ReactNode;
  caption: string;
  label: string;
  onSelect: () => void;
  attrs?: Record<`data-${string}`, string | undefined>;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      {...attrs}
      onClick={onSelect}
      className="flex min-h-[60px] min-w-0 flex-col items-center justify-center gap-1.5 rounded-control px-1 py-2 text-center text-label font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
    >
      <span aria-hidden className="flex shrink-0 items-center justify-center text-secondary">{icon}</span>
      <span className="max-w-full truncate">{caption}</span>
    </button>
  );
}

/** A named row that opens its rows in place, under itself
    (docs/design/compact-card-menu.md): the arrow points down while it is
    closed and up once the rows are there, and the rows hang from one rule. */
export function MobileSheetFold({ id, title, value, open, onToggle, children }: {
  id: string;
  title: string;
  /** What the closed row holds, at its end (a count). */
  value?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const Arrow = open ? ChevronUp : ChevronDown;
  return (
    <div role="none">
      <button
        type="button"
        aria-expanded={open}
        data-mobile2-menu-section={id}
        onClick={onToggle}
        className="flex min-h-11 w-full items-center gap-3 px-4 text-left text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {value === undefined ? null : <span className="shrink-0 text-label font-medium tabular-nums text-muted">{value}</span>}
        <Arrow className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      </button>
      {open ? <div role="group" aria-label={title} data-mobile2-menu-body={id} className="ml-4 flex flex-col border-l border-border">{children}</div> : null}
    </div>
  );
}

/** One 44 px row inside a sheet (the prototype's `.mrow`): an icon, a label,
    one trailing element. Rows are the only place a labelled control lives on
    the phone; the bar keeps four icons at most. */
export function MobileSheetRow({
  icon,
  label,
  trailing,
  onSelect,
  selected = false,
  danger = false,
  disabled = false,
  role,
  checked,
  testId,
  attrs,
  ariaLabel,
  trailingShrinks = false,
}: {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  onSelect?: () => void;
  /** The current item (the project the board shows, the conversation open). */
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
  role?: string;
  /** A radio row announces which face is shown instead of only tinting it. */
  checked?: boolean;
  testId?: string;
  /** Harness hooks (`data-mobile2-*`) and any other data attribute. */
  attrs?: Record<`data-${string}`, string | undefined>;
  ariaLabel?: string;
  /**
   * Swap which of the two texts gives way when the row is too narrow.
   *
   * By default the LABEL truncates and the trailing slot keeps its size,
   * because a trailing slot is normally a word or a count. A row whose
   * trailing text is a whole clause has to invert that: with the slot fixed,
   * the label is crushed to nothing and the slot's own trailing marks — a
   * state dot, a chevron — are pushed off the right edge (#1681, measured at
   * 390 px, where the Ukrainian «Тікер оркестратора» never rendered at all).
   * Opt-in, so every existing row is byte-identical.
   */
  trailingShrinks?: boolean;
}) {
  return (
    <button
      type="button"
      role={role ?? (checked === undefined ? undefined : "menuitemradio")}
      aria-checked={checked}
      aria-current={selected ? "true" : undefined}
      aria-label={ariaLabel}
      disabled={disabled}
      data-testid={testId}
      {...attrs}
      onClick={onSelect}
      className={`flex min-h-11 w-full items-center gap-3 px-4 text-left text-body font-semibold active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 ${
        danger ? "text-danger" : checked ? "text-accent" : "text-primary"
      }`}
    >
      {icon ? <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center ${danger ? "text-danger" : "text-secondary"}`}>{icon}</span> : null}
      <span className={trailingShrinks ? "shrink-0 truncate" : "min-w-0 flex-1 truncate"}>{label}</span>
      {trailing ? (
        <span
          className={`ml-auto inline-flex items-center gap-1.5 text-label font-medium ${
            trailingShrinks ? "min-w-0 flex-1 justify-end" : "shrink-0"
          } ${selected ? "text-accent" : "text-muted"}`}
        >
          {trailing}
        </span>
      ) : null}
    </button>
  );
}
