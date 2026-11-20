"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { placeStack, QUESTION_TOAST_PLACED, readObstacles, widthClearOfLeft } from "../soundCaptionPlacement";

/** The first line of the column: 8 px under the bar row's 48 px (`top-14`). */
const FIRST_LINE = 56;
const GAP = 8;
/** How far under its first line the toast may be moved to find a free place; with none free it stays on its first line, never down the page. */
const MAX_DROP = 96;
/** How often the page is checked for a seat header that moved under the toast, ms. */
const WATCH_MS = 250;
/** The toast's first read can precede the board's own layout: it is read again once, this long after it appeared, ms. */
const SETTLE_MS = 600;

/**
 * The column the question toast hangs in (docs/design/sound-captions.md §4). It starts where the bar row ends
 * and, where an orchestrator seat's header crosses the toast's band, under that header, so the toast never covers
 * the header's switch, Rotate or Stop host. From there it stands on the first place that covers no line of text and
 * no control (`placeStack`, within a short drop), on its own right edge. With none free, and words or a control lying under its left end,
 * it narrows to stand clear of them (`widthClearOfLeft`); with that no place either, it stays on that first line.
 *
 * `className` carries the column's layer and `top-14` for the frame before it is measured; the layer classes stay
 * in the Viewer, where the stylesheet's layer count is pinned. The place is read when the toast's size, the window
 * or the header under it change, never while a pointer or the focus is on the toast, and a move is announced to
 * the caption stack through `QUESTION_TOAST_PLACED`.
 */
export function QuestionToastColumn({ className, right, children }: { className: string; right: number; children: ReactNode }) {
  const column = useRef<HTMLDivElement | null>(null);
  const placedFor = useRef("");
  const top = useRef<number | null>(null);
  /** The width the toast was narrowed to, 0 at its own. */
  const narrow = useRef(0);

  /** The first line the toast may start on: under every seat header that crosses its band. */
  const firstLine = useCallback((width: number, height: number) => {
    const viewport = document.documentElement.clientWidth;
    const left = viewport - right - width;
    let line = FIRST_LINE;
    for (const head of document.querySelectorAll<HTMLElement>("[data-seat-head]")) {
      const box = head.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      const across = box.right > left && box.left < viewport - right;
      const down = box.bottom > FIRST_LINE && box.top < FIRST_LINE + height;
      if (across && down) line = Math.max(line, Math.ceil(box.bottom + GAP));
    }
    return line;
  }, [right]);

  const place = useCallback((again = false) => {
    const element = column.current;
    if (!element) return;
    if (element.querySelector(":hover") || element.contains(document.activeElement)) return;
    const viewport = { width: document.documentElement.clientWidth, height: window.innerHeight };
    const keyOf = (minTop: number) => JSON.stringify([element.offsetWidth, element.offsetHeight, right, viewport, minTop]);
    if (!again && placedFor.current === keyOf(firstLine(element.offsetWidth, element.offsetHeight))) return;
    /* The toast is measured at its own width; a narrower one (below) is decided afresh on every read. */
    element.style.maxWidth = "";
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    if (!width || !height) return;
    const minTop = firstLine(width, height);
    const obstacles = readObstacles(element, right, { width, skip: "[data-sound-captions]" });
    const at = (size: { width: number; height: number }) => placeStack({ viewport, right, minTop, toasts: [size], maxDrop: MAX_DROP, obstacles });
    let found = at({ width, height });
    let narrowed = false;
    if (!found.free) {
      /* Where the words it covers lie on its left (a tab's label at the foot of the header), a narrower toast, its text on two lines, stands clear of them. */
      const room = widthClearOfLeft({ viewport, right, top: minTop, size: { width, height }, obstacles });
      if (room) {
        element.style.maxWidth = `${room}px`;
        const retry = at({ width: element.offsetWidth, height: element.offsetHeight });
        if (retry.free) { found = retry; narrowed = true; } else element.style.maxWidth = "";
      }
    }
    placedFor.current = keyOf(minTop);
    /* What the toast says of itself, as the caption stack does: «free» stands over no line of text and no control. */
    element.dataset.questionToastPlacement = found.free ? "free" : "covers";
    const next = found.free ? found.top : minTop;
    const nextWidth = narrowed ? element.offsetWidth : 0;
    if (next === top.current && nextWidth === narrow.current) return;
    top.current = next;
    narrow.current = nextWidth;
    element.style.top = `${next}px`;
    window.dispatchEvent(new Event(QUESTION_TOAST_PLACED));
  }, [right, firstLine]);

  const placeRef = useRef(place);
  useLayoutEffect(() => {
    placeRef.current = place;
    place();
  });

  useEffect(() => {
    let timer = 0;
    const watch = () => {
      if (timer) return;
      timer = window.setTimeout(() => { timer = 0; placeRef.current(true); }, WATCH_MS);
    };
    const observer = new MutationObserver((records) => {
      if (records.some((record) => !column.current?.contains(record.target))) watch();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", watch);
    const settle = window.setTimeout(() => placeRef.current(true), SETTLE_MS);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", watch);
      window.clearTimeout(settle);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return (
    <div ref={column} className={className} style={{ right }}>
      {children}
    </div>
  );
}
