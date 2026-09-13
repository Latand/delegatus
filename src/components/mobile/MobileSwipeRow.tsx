"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";

import { useLocale } from "@/lib/i18n";

import {
  LONG_PRESS_MS,
  SWIPE_ACTION_WIDTH,
  swipeLock,
  swipeOffset,
  swipeReleaseOpen,
  swipeRows,
  swipeVelocity,
  trackSwipe,
  type SwipeLock,
  type SwipeOpenStore,
  type SwipeSample,
} from "./swipeIntent";

/*
 * A board row that slides left under the finger and shows what can be done to
 * it (#1671). The card keeps being the row: it opens on a tap, and the wrapper
 * only moves it. Behind it, anchored to the right edge, sits the tray — one
 * 72 px button per action, an icon over one word — revealed as the card
 * moves. What the gesture means is `swipeIntent`'s to decide; this file
 * wires pointer events to it.
 *
 * A revealed button must be tapped. Nothing acts on the swipe itself.
 *
 * Two other ways reach the same actions, for a thumb that cannot do the swipe
 * and for a keyboard: a long-press opens the row's actions sheet, and focus
 * moving onto a tray button slides the card aside. The buttons are in the
 * document at all times, transparent while the card covers them, so Tab
 * reaches them from the card.
 */

export interface MobileRowAction {
  key: string;
  /** The word under the tray button. */
  label: string;
  /** The action's full name: the sheet's row and the button's accessible name. */
  name: string;
  /** What it does, in the operator's words. */
  hint: string;
  icon: ReactNode;
  tone: "neutral" | "accent" | "danger";
  run: () => void;
}

export const ROW_ACTION_TONE: Record<MobileRowAction["tone"], string> = {
  neutral: "bg-raised text-primary ring-1 ring-inset ring-border shadow-1",
  accent: "bg-accent text-white",
  danger: "bg-danger text-white",
};

interface Drag {
  pointer: number;
  x: number;
  y: number;
  /** Where the card sat when the finger landed: 0 closed, `-width` open. */
  base: number;
  lock: SwipeLock;
  offset: number;
  samples: SwipeSample[];
}

/** How long after a swipe or a long-press the click it leaves behind is ignored. */
const SWALLOW_CLICK_MS = 450;

export function MobileSwipeRow({ id, title, actions, onLongPress, store = swipeRows, children }: {
  /** Unique across the tab: one row is open at a time, by this id. */
  id: string;
  /** The row's title, for the tray's accessible name. */
  title: string;
  actions: readonly MobileRowAction[];
  onLongPress?: () => void;
  /** Test seam: the open-row store. Production reads the tab's singleton. */
  store?: SwipeOpenStore;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const tray = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* A long-press fired and its finger is still down. */
  const pressed = useRef(false);
  const swallowUntil = useRef(0);
  const open = useSyncExternalStore(store.subscribe, () => store.getState() === id, () => false);
  const width = actions.length * SWIPE_ACTION_WIDTH;

  /* The card and the tray are written straight to the DOM: a render per
     pointer move would put React between the finger and the card. */
  const place = (offset: number, animate: boolean) => {
    const layer = card.current;
    const buttons = tray.current;
    if (!layer || !buttons) return;
    layer.style.transition = animate ? "" : "none";
    buttons.style.transition = animate ? "" : "none";
    layer.style.transform = offset ? `translateX(${offset}px)` : "";
    buttons.style.opacity = String(Math.min(1, -offset / width));
  };
  const cancelPress = () => {
    if (press.current === null) return;
    clearTimeout(press.current);
    press.current = null;
  };

  useLayoutEffect(() => {
    if (drag.current?.lock === "x") return;
    place(open ? -width : 0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- place only writes the refs
  }, [open, width]);

  /* An open tray goes away when the operator touches anything else or the list
     under it scrolls — unless focus is inside it, because a focused button
     scrolled into view is not the operator moving on. */
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node | null)) store.close(id);
    };
    const scrolled = (event: Event) => {
      const row = root.current;
      if (!row || row.contains(document.activeElement)) return;
      const scroller = event.target as Node | null;
      if (scroller && typeof scroller.contains === "function" && scroller.contains(row)) store.close(id);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scrolled, true);
    };
  }, [open, id, store]);

  /* A row that leaves the list takes its open tray with it, so the same row
     coming back (a close the server refused) comes back shut. */
  useEffect(() => () => {
    cancelPress();
    store.close(id);
  }, [id, store]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    /* A finger on a tray button is that button's tap. */
    if (tray.current?.contains(event.target as Node)) return;
    const base = open ? -width : 0;
    swallowUntil.current = 0;
    pressed.current = false;
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      base,
      lock: null,
      offset: base,
      samples: [{ x: event.clientX, t: performance.now() }],
    };
    cancelPress();
    if (!onLongPress || open) return;
    press.current = setTimeout(() => {
      press.current = null;
      const current = drag.current;
      if (!current || current.lock !== null) return;
      drag.current = null;
      pressed.current = true;
      swallowUntil.current = performance.now() + SWALLOW_CLICK_MS;
      onLongPress();
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointer) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.lock === null) {
      const lock = swipeLock(dx, dy);
      if (lock === null) return;
      cancelPress();
      if (lock === "y") {
        /* The list is scrolling: the browser owns this gesture, the row stays. */
        drag.current = null;
        return;
      }
      current.lock = lock;
      if (store.getState() !== id) store.close();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* A synthetic pointer without an id: its moves still arrive here. */
      }
    }
    current.offset = swipeOffset(current.base, dx, width);
    current.samples = trackSwipe(current.samples, { x: event.clientX, t: performance.now() });
    place(current.offset, false);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    cancelPress();
    if (pressed.current) {
      /* However long the finger stayed down after the sheet opened, its lift
         still belongs to the press, and the sheet's scrim gets no tap from it. */
      pressed.current = false;
      swallowUntil.current = performance.now() + SWALLOW_CLICK_MS;
      return;
    }
    if (!current || event.pointerId !== current.pointer) return;
    drag.current = null;
    if (current.lock === "x") {
      /* The lift that ends a swipe is not a tap on the card under it. */
      swallowUntil.current = performance.now() + SWALLOW_CLICK_MS;
      const velocity = swipeVelocity(trackSwipe(current.samples, { x: event.clientX, t: performance.now() }));
      const next = swipeReleaseOpen(current.offset, velocity, width);
      place(next ? -width : 0, true);
      if (next) store.open(id);
      else store.close(id);
      return;
    }
    if (open) {
      /* A tap on an open row's card puts the tray away and opens nothing. */
      swallowUntil.current = performance.now() + SWALLOW_CLICK_MS;
      store.close(id);
    }
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    cancelPress();
    pressed.current = false;
    if (!current || event.pointerId !== current.pointer) return;
    drag.current = null;
    if (current.lock === "x") place(open ? -width : 0, true);
  };

  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (tray.current?.contains(event.target as Node)) return;
    if (performance.now() >= swallowUntil.current) return;
    swallowUntil.current = 0;
    event.preventDefault();
    event.stopPropagation();
  };

  /* A held finger opens the actions sheet, and the browser's own menu stays shut. */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (press.current !== null || pressed.current || performance.now() < swallowUntil.current) event.preventDefault();
  };

  /* The click a lifted finger leaves behind lands on whatever is under it by
     then — the sheet a long-press just opened, or the card a swipe just moved
     — and the capture above cannot reach a scrim outside the row. Cancelling
     the touch's end is what stops the browser from making that click. A tray
     button's own tap is never cancelled. */
  const onTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (tray.current?.contains(event.target as Node)) return;
    if (event.cancelable && performance.now() < swallowUntil.current) event.preventDefault();
  };

  const onFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (tray.current?.contains(event.target as Node)) store.open(id);
  };
  const onBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && root.current?.contains(next)) return;
    if (tray.current?.contains(event.target as Node)) store.close(id);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    store.close(id);
    card.current?.querySelector<HTMLElement>("button, [href], [tabindex]")?.focus();
  };

  return (
    <div
      ref={root}
      data-mobile2-swipe-row={id}
      data-mobile2-swipe-open={open ? "true" : undefined}
      className="relative touch-pan-y select-none [-webkit-touch-callout:none]"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={onClickCapture}
      onContextMenu={onContextMenu}
      onTouchEnd={onTouchEnd}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <div
        ref={card}
        data-mobile2-swipe-card
        className="relative z-[1] transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
      >
        {children}
      </div>
      <div
        ref={tray}
        role="group"
        aria-label={t("mobile2.board.rowActions", { title })}
        data-mobile2-swipe-tray
        className="absolute inset-y-0 right-0 z-0 flex items-stretch justify-end opacity-0 transition-opacity duration-200 motion-reduce:transition-none"
        style={{ width }}
      >
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            data-mobile2-swipe-action={action.key}
            aria-label={`${action.name}. ${action.hint}`}
            className="flex min-h-11 w-[72px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-[12px] px-1 text-[11px] font-semibold leading-3 text-secondary active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
            onClick={() => {
              store.close(id);
              action.run();
            }}
          >
            <span aria-hidden className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${ROW_ACTION_TONE[action.tone]}`}>
              {action.icon}
            </span>
            <span className="max-w-full text-center [overflow-wrap:anywhere]">{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
