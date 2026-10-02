"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { installColumnLayoutAnimation } from "./columnLayoutAnimation";

import type { TaskStatus } from "@/lib/tasks/types";

/** A mouse accumulates presence in a column, moving or resting. Short gap
 * crossings pause the count; a press latches the column until it is left.
 * Timers set the cue on the element without rendering on pointer moves. */
export const DWELL_MS = 1000;
export const DWELL_CUE_MS = 250;
export const DWELL_EXIT_MS = 150;

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
/* A menu, popover or modal open anywhere in the document, the ones a reader's
   composer portals to the body (model, mic, account, speak) included. */
const OPEN_OVERLAY = 'dialog[open], [aria-modal="true"], [role="menu"], [role="listbox"], [data-runtime-popover]';

/* A non-modal `role="dialog"` holds the pointer only while it floats over the
   page. An inline disclosure that also carries the role (the Copilot accounts
   panel in the rail footer) sits in the flow and leaves the dwell alone. */
function floats(node: Element): boolean {
  for (let element: Element | null = node; element && element !== document.body; element = element.parentElement) {
    const position = window.getComputedStyle(element).position;
    if (position === "fixed" || position === "absolute") return true;
  }
  return false;
}

/**
 * Anything outside the board's own state that also holds the pointer: a
 * selection, a menu, a popover, a dialog. It scans the document, so it runs
 * only where the dwell decides (its two timers), never per pointer move.
 */
function held(): boolean {
  const selection = typeof document.getSelection === "function" ? document.getSelection() : null;
  if (selection && !selection.isCollapsed && selection.toString() !== "") return true;
  if (document.querySelector(OPEN_OVERLAY) !== null) return true;
  for (const dialog of document.querySelectorAll('[role="dialog"]')) if (floats(dialog)) return true;
  return false;
}

export function useColumnDwell(rootRef: RefObject<HTMLElement | null>, options: ColumnDwellOptions): void {
  const optionsRef = useRef(options);
  useLayoutEffect(() => { optionsRef.current = options; });
  const { enabled } = options;

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    let armed: HTMLElement | null = null;
    const layout = installColumnLayoutAnimation(root);
    let elapsed = 0;
    let enteredAt = 0;
    let present = false;
    let exitTimer: ReturnType<typeof setTimeout> | null = null;
    let cueTimer: ReturnType<typeof setTimeout> | null = null;
    let widenTimer: ReturnType<typeof setTimeout> | null = null;
    /* The column a press landed in: it does not arm again until the pointer leaves it. */
    let latched: HTMLElement | null = null;

    const statusOf = (column: HTMLElement) => column.dataset.status as TaskStatus;
    /* What a pointer move may check: no document scan. */
    const eligible = (column: HTMLElement) => column.isConnected && optionsRef.current.canWiden(statusOf(column));
    const may = (column: HTMLElement) => eligible(column) && !optionsRef.current.busy() && !held();

    const stopTimers = () => {
      if (cueTimer) clearTimeout(cueTimer);
      if (widenTimer) clearTimeout(widenTimer);
      cueTimer = widenTimer = null;
    };
    const clearCue = () => {
      if (armed) {
        delete armed.dataset.dwell;
        armed.style.removeProperty("--kb-dwell");
      }
    };
    const cancel = () => {
      stopTimers();
      if (exitTimer) clearTimeout(exitTimer);
      exitTimer = null;
      clearCue();
      armed = null;
      elapsed = 0;
      present = false;
    };
    const resume = (column: HTMLElement) => {
      if (exitTimer) clearTimeout(exitTimer);
      exitTimer = null;
      if (present) return;
      present = true;
      enteredAt = Date.now();
      const cue = () => {
        cueTimer = null;
        if (armed !== column || !present) return;
        if (!may(column)) return cancel();
        column.style.setProperty("--kb-dwell", `${DWELL_MS - elapsed - (Date.now() - enteredAt)}ms`);
        column.dataset.dwell = "";
      };
      if (elapsed >= DWELL_CUE_MS) cue();
      else cueTimer = setTimeout(cue, DWELL_CUE_MS - elapsed);
      if (armed !== column) return;
      widenTimer = setTimeout(() => {
        widenTimer = null;
        if (armed !== column || !present) return;
        const widen = may(column);
        /* Read the old pose before removing the cue invalidates its styles. */
        if (widen) layout.prepare();
        cancel();
        if (!widen) return;
        latched = column;
        optionsRef.current.widen(statusOf(column));
      }, DWELL_MS - elapsed);
    };
    const arm = (column: HTMLElement) => {
      cancel();
      if (!eligible(column)) return;
      armed = column;
      resume(column);
    };
    const pause = () => {
      if (!armed || !present) return;
      elapsed += Date.now() - enteredAt;
      present = false;
      stopTimers();
      clearCue();
      exitTimer = setTimeout(cancel, DWELL_EXIT_MS);
    };
    const columnAt = (target: EventTarget | null) => {
      const node = target as Element | null;
      const column = typeof node?.closest === "function" ? node.closest<HTMLElement>(COLUMN) : null;
      return column && root.contains(column) ? column : null;
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.buttons !== 0 || optionsRef.current.busy()) return cancel();
      const column = columnAt(event.target);
      if (latched && latched !== column) latched = null;
      if (column === latched && column) return cancel();
      if (!column) return pause();
      if (armed === column) return resume(column);
      arm(column);
    };
    const onLeave = () => {
      latched = null;
      pause();
    };
    const onBlur = () => { latched = null; cancel(); };
    const onDown = (event: PointerEvent) => {
      latched = columnAt(event.target);
      cancel();
    };
    /* Scrolling a column is reading it: the count starts again from where it stopped. */
    const onWheel = () => {
      if (armed && present) arm(armed);
      else cancel();
    };
    const onKey = () => cancel();

    root.addEventListener("pointermove", onMove, { passive: true });
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("pointerdown", onDown, true);
    root.addEventListener("wheel", onWheel, { passive: true });
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      cancel();
      layout.dispose();
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("pointerdown", onDown, true);
      root.removeEventListener("wheel", onWheel);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [enabled, rootRef]);
}
