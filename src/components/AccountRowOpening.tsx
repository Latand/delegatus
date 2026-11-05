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
 * A row's lines open and close with a short height change, so opening another
 * row reads as moving there. Under reduced motion the lines swap at once and
 * no transition is attached. A closed row is `inert`: nothing in it takes
 * focus or a press.
 *
 * The clip reaches 6 px past the left side, where actions hang so their words
 * meet the name's edge, and over the slack of a first and a last control
 * (`slack`), so a control's box never lies cut by the height change.
 */
export function AccountRowOpening({ open, phone, children }: { open: boolean; phone: boolean; children: ReactNode }) {
  const still = useSyncExternalStore(subscribe, prefersStill, () => false);
  const [rendered, setRendered] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const box = useRef<HTMLDivElement>(null);
  if (open && !rendered) setRendered(true);
  // Closed before it ever grew, nothing will end: it simply goes.
  if (!open && !expanded && rendered) setRendered(false);
  useLayoutEffect(() => {
    if (still || !open) return undefined;
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setExpanded(true)); });
    return () => cancelAnimationFrame(frame);
  }, [open, still]);
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
