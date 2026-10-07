"use client";

import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

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
 */

/** A drag of the handle past this many pixels closes the sheet. */
export const SHEET_CLOSE_DRAG_PX = 80;

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
  full = false,
  onClose,
  children,
  receiptStore,
}: {
  name: MobileSheetName;
  title: string;
  /** A header control beside the title (the queue's «Dismiss all», the switcher's «Board ›»). */
  extra?: ReactNode;
  footer?: ReactNode;
  /** Fullscreen (the rotate / create draft): no handle, no rounded top. */
  full?: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Tests inject their own receipt store; the app uses the singleton. */
  receiptStore?: ReceiptStore;
}) {
  const { t } = useLocale();
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  useModalLayer({ containerRef: sheetRef, onClose });

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (full) return;
    /* Only the grab handle and the header's title text start a drag; a
       pointer on the × or another header control is that control's tap. */
    if (isControlTarget(event.target, event.currentTarget)) return;
    drag.current = { y: event.clientY, dy: 0 };
    const sheet = sheetRef.current;
    if (sheet) sheet.style.transition = "none";
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
    current.dy = Math.max(0, event.clientY - current.y);
    const sheet = sheetRef.current;
    if (sheet) sheet.style.transform = `translateY(${current.dy}px)`;
  };
  const settle = (close: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (close && current.dy > SHEET_CLOSE_DRAG_PX) {
      onClose();
      return;
    }
    const sheet = sheetRef.current;
    if (sheet) {
      sheet.style.transition = "transform 200ms cubic-bezier(0.2, 0, 0, 1)";
      sheet.style.transform = "";
    }
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
        className={`flex flex-col bg-raised shadow-2 outline-none transition-[transform,opacity] duration-[320ms] ease-[cubic-bezier(0.2,0,0,1)] starting:translate-y-6 starting:opacity-0 motion-reduce:transition-none ${
          full ? "h-full max-h-full rounded-none" : "max-h-[88%] rounded-t-[16px]"
        } pb-[calc(6px+env(safe-area-inset-bottom))]`}
      >
        {full ? null : (
          <div className="shrink-0 touch-none px-6 pb-0.5 pt-2" data-mobile2-grab {...handle}>
            <div className="mx-auto h-1 w-9 rounded-sm bg-strong" aria-hidden />
          </div>
        )}
        <div className="flex min-h-12 shrink-0 touch-none items-center gap-1 pl-4 pr-1" data-mobile2-sheet-header {...handle}>
          <h2 className="min-w-0 flex-1 truncate text-title font-semibold text-primary">{title}</h2>
          {extra}
          <button type="button" className={CLOSE_BUTTON} aria-label={t("mobile2.sheet.close")} data-mobile2-close onClick={onClose}>
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto pb-1" data-mobile2-sheet-body>
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
