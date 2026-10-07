"use client";

import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";

/* A second press on the spot that just swapped the list is the tail of a
   double click: it is dropped for this long unless the pointer moved this far. */
export const SWAP_GUARD_MS = 1000;
export const SWAP_GUARD_PX = 4;

/** A press that swaps a whole list for another (into a page, or back out of
    one) leaves a different row, or the board, under the pointer. The second
    press of a double click lands there before anyone has read it, so until
    the pointer moves or a moment passes a press on that spot reaches nothing:
    no row, and no dismissal either. Returns what records such a press; one
    from the keyboard has no place and is never recorded. */
export function useSwapGuard(): (press?: ReactMouseEvent) => void {
  const swapped = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const kinds = ["pointermove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const;
    const guard = (event: MouseEvent) => {
      const last = swapped.current;
      if (!last) return;
      const held = performance.now() - last.at < SWAP_GUARD_MS && Math.abs(event.clientX - last.x) < SWAP_GUARD_PX && Math.abs(event.clientY - last.y) < SWAP_GUARD_PX;
      /* The pointer left the spot, or the moment passed: what is pressed next was aimed at. */
      if (!held) { if (event.type === "pointermove" || event.type === "pointerdown") swapped.current = null; return; }
      if (event.type === "pointermove") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      /* How many presses were dropped, for the driver that double-clicks every such row. */
      if (event.type === "click") document.documentElement.dataset.menuDropped = String(Number(document.documentElement.dataset.menuDropped ?? 0) + 1);
    };
    for (const kind of kinds) window.addEventListener(kind, guard, true);
    return () => { for (const kind of kinds) window.removeEventListener(kind, guard, true); };
  }, []);
  return (press) => { swapped.current = press && press.detail > 0 ? { x: press.clientX, y: press.clientY, at: performance.now() } : null; };
}
