"use client";

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

/** How long one row takes to open or close. */
export const OPENING_MS = 180;

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  if (typeof matchMedia !== "function") return () => {};
  const query = matchMedia(REDUCED);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Reduced motion, or a page that cannot animate at all: the lines swap at once. */
function prefersStill(): boolean {
  if (typeof requestAnimationFrame !== "function") return true;
  return typeof matchMedia === "function" && matchMedia(REDUCED).matches;
}

/**
 * Brings an opened row whole into the scrollers that hold it: its last line
 * above the scroller's bottom edge and its head below a sticky header, and a
 * row taller than the room it has aligns its head to the top. Every scrolling
 * ancestor is adjusted from the nearest outward, then the page itself.
 */
export function revealRow(row: HTMLElement): void {
  const fit = (view: { top: number; bottom: number }, scroll: (by: number) => void) => {
    const box = row.getBoundingClientRect();
    if (box.height > view.bottom - view.top || box.top < view.top) scroll(box.top - view.top);
    else if (box.bottom > view.bottom) scroll(box.bottom - view.bottom);
  };
  for (let node = row.parentElement; node; node = node.parentElement) {
    if (!/auto|scroll/.test(window.getComputedStyle(node).overflowY) || node.scrollHeight <= node.clientHeight) continue;
    const edge = node.getBoundingClientRect();
    // A sticky header covers the top of the room the row has.
    const header = node.querySelector<HTMLElement>(":scope > header");
    const covered = header && window.getComputedStyle(header).position === "sticky" ? header.getBoundingClientRect().height : 0;
    fit({ top: edge.top + node.clientTop + covered, bottom: edge.top + node.clientTop + node.clientHeight }, (by) => { node.scrollTop += by; });
  }
  const page = document.scrollingElement;
  if (page && page.scrollHeight > page.clientHeight) fit({ top: 0, bottom: page.clientHeight }, (by) => { page.scrollTop += by; });
}

/**
 * A row's lines open and close with a short height change, so opening another
 * row reads as moving there. Under reduced motion the lines swap at once and
 * no transition is attached. A closed row is `inert`: nothing in it takes
 * focus or a press.
 *
 * The clip reaches 6 px past the left side, where actions hang so their words
 * meet the name's edge, and over the slack of a first and a last control
 * (`slack`), so a control's box never lies cut by the height change.
 */
export function AccountRowOpening({ open, phone, onOpened, children }: {
  open: boolean;
  phone: boolean;
  /** Called once the lines have their full height: at once under reduced motion, else when the height change ends. */
  onOpened?: () => void;
  children: ReactNode;
}) {
  const still = useSyncExternalStore(subscribe, prefersStill, () => false);
  const [rendered, setRendered] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const box = useRef<HTMLDivElement>(null);
  const opened = useRef(onOpened);
  useLayoutEffect(() => { opened.current = onOpened; });
  if (open && !rendered) setRendered(true);
  // Closed before it ever grew, nothing will end: it simply goes.
  if (!open && !expanded && rendered) setRendered(false);
  useLayoutEffect(() => {
    if (still || !open) return undefined;
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setExpanded(true)); });
    return () => cancelAnimationFrame(frame);
  }, [open, still]);
  // Opening ends with its height change; one that never ran ends at once.
  useLayoutEffect(() => {
    if (!open || (!still && !expanded)) return undefined;
    if (still) { opened.current?.(); return undefined; }
    let live = true;
    const running = box.current?.getAnimations?.() ?? [];
    void Promise.allSettled(running.map((animation) => animation.finished)).then(() => { if (live) opened.current?.(); });
    return () => { live = false; };
  }, [open, expanded, still]);
  // Closing ends when its own height change does, finished or dropped; one
  // that never ran ends at once.
  useLayoutEffect(() => {
    if (still || open || !rendered) return undefined;
    let live = true;
    const running = box.current?.getAnimations?.() ?? [];
    void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
      if (live) { setRendered(false); setExpanded(false); }
    });
    return () => { live = false; };
  }, [open, rendered, still]);
  if (still ? !open : !rendered) return null;
  const grown = still || (open && expanded);
  const slack = grown ? (phone ? "-mb-3 -mt-3 pb-3 pt-3" : "-mb-[5px] -mt-1 pb-[5px] pt-1") : "";
  return (
    <div
      ref={box}
      data-account-opening={grown ? "open" : "closing"}
      className={`grid ease-out ${still ? "" : "transition-[grid-template-rows]"}`}
      style={{ gridTemplateRows: grown ? "1fr" : "0fr", transitionDuration: still ? undefined : `${OPENING_MS}ms` }}
    >
      <div
        className={`pointer-events-none -ml-1.5 flex min-h-0 flex-col gap-0.5 overflow-hidden pl-1.5 [&>*]:pointer-events-auto ${phone ? "-mr-3.5 pr-3.5" : "-mr-1.5 pr-1.5"} ${slack}`}
        inert={!open}
      >
        {children}
      </div>
    </div>
  );
}
