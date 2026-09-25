"use client";

import { useEffect, useRef, type RefObject } from "react";

import type { TaskStatus } from "@/lib/tasks/types";

/**
 * A narrow column widens when the mouse rests in it.
 *
 * The countdown starts when the pointer comes to rest inside a column that
 * may widen. After a short grace the column carries `data-dwell`, which the
 * stylesheet draws as the cue; when the pointer has stayed within the jitter
 * tolerance for the whole dwell, the column widens. Moving further, scrolling
 * or a key restarts the count; leaving the column, a press or anything that
 * holds the pointer's attention (a drag, a menu, a dialog, a selection)
 * cancels it. A press inside a column also keeps it from arming again until
 * the pointer leaves it, so a column the operator has just narrowed by its
 * button does not widen again under the resting pointer.
 *
 * Only a mouse dwells: touch and pen never start a countdown. The cue is set
 * on the column element itself, so no pointer move re-renders the board.
 */

/** Stillness until the column widens. */
export const DWELL_MS = 1300;
/** Stillness before the cue shows, so a pointer passing through draws nothing. */
export const DWELL_CUE_MS = 350;
/** How far the pointer may drift from where it came to rest and still be resting. */
export const DWELL_JITTER_PX = 8;

export interface ColumnDwellOptions {
  /** The board draws width controls (columns mode, a project board). */
  enabled: boolean;
  /** The column is narrow and nothing pins another wide. */
  canWiden(status: TaskStatus): boolean;
  /** Something the board holds takes the pointer: a drag, a menu, a sheet. */
  busy(): boolean;
  /** Widen the column, as its Widen button does. */
  widen(status: TaskStatus): void;
}

const COLUMN = ".column[data-status]";

/** Anything outside the board's own state that also holds the pointer. */
function held(event: { buttons: number } | null): boolean {
  if (event && event.buttons !== 0) return true;
  const selection = typeof document.getSelection === "function" ? document.getSelection() : null;
  if (selection && !selection.isCollapsed && selection.toString() !== "") return true;
  return Boolean(document.querySelector("dialog[open], [aria-modal='true']"));
}

export function useColumnDwell(rootRef: RefObject<HTMLElement | null>, options: ColumnDwellOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { enabled } = options;

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    let armed: HTMLElement | null = null;
    let anchor = { x: 0, y: 0 };
    let cueTimer: ReturnType<typeof setTimeout> | null = null;
    let widenTimer: ReturnType<typeof setTimeout> | null = null;
    /* The column a press landed in: it does not arm again until the pointer leaves it. */
    let latched: HTMLElement | null = null;

    const statusOf = (column: HTMLElement) => column.dataset.status as TaskStatus;
    const may = (column: HTMLElement) => column.isConnected && !optionsRef.current.busy() && !held(null) && optionsRef.current.canWiden(statusOf(column));

    const cancel = () => {
      if (cueTimer) clearTimeout(cueTimer);
      if (widenTimer) clearTimeout(widenTimer);
      cueTimer = widenTimer = null;
      if (armed) {
        delete armed.dataset.dwell;
        armed.style.removeProperty("--kb-dwell");
      }
      armed = null;
    };
    const arm = (column: HTMLElement, x: number, y: number) => {
      cancel();
      if (!may(column)) return;
      armed = column;
      anchor = { x, y };
      cueTimer = setTimeout(() => {
        cueTimer = null;
        if (armed !== column) return;
        if (!may(column)) return cancel();
        /* The sweep runs for exactly what is left of the dwell. */
        column.style.setProperty("--kb-dwell", `${DWELL_MS - DWELL_CUE_MS}ms`);
        column.dataset.dwell = "";
      }, DWELL_CUE_MS);
      widenTimer = setTimeout(() => {
        widenTimer = null;
        if (armed !== column) return;
        const widen = may(column);
        cancel();
        if (!widen) return;
        latched = column;
        optionsRef.current.widen(statusOf(column));
      }, DWELL_MS);
    };
    const columnAt = (target: EventTarget | null) => {
      const node = target as Element | null;
      const column = typeof node?.closest === "function" ? node.closest<HTMLElement>(COLUMN) : null;
      return column && root.contains(column) ? column : null;
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return cancel();
      const column = columnAt(event.target);
      if (latched && latched !== column) latched = null;
      if (!column || column === latched) return cancel();
      if (held(event)) return cancel();
      if (armed === column && Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) <= DWELL_JITTER_PX) return;
      arm(column, event.clientX, event.clientY);
    };
    const onLeave = () => {
      latched = null;
      cancel();
    };
    const onDown = (event: PointerEvent) => {
      latched = columnAt(event.target);
      cancel();
    };
    /* Scrolling a column is reading it: the count starts again from where it stopped. */
    const onWheel = () => {
      if (armed) arm(armed, anchor.x, anchor.y);
    };
    const onKey = () => cancel();

    root.addEventListener("pointermove", onMove, { passive: true });
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("pointerdown", onDown, true);
    root.addEventListener("wheel", onWheel, { passive: true });
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onLeave);
    return () => {
      cancel();
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointerdown", onDown, true);
      root.removeEventListener("wheel", onWheel);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onLeave);
    };
  }, [enabled, rootRef]);
}
