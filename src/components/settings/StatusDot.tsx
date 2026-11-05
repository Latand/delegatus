"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Z } from "@/components/layers";

export type DotTone = "ok" | "warn" | "off";

export const DOT_CLASS: Record<DotTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  off: "bg-transparent shadow-[inset_0_0_0_1.5px_var(--color-muted)]",
};

const POPOVER_WIDTH = 240;
const EDGE = 8;
/* Long enough for a pointer to cross from the dot to the popover under the row. */
const CLOSE_DELAY = 200;

/**
 * A status: a 7 px dot, and a short popover on hover, focus, click or tap
 * (the operator's rule of 2026-10-12). It floats on an opaque surface through a
 * portal at the popover layer, so it rises above the window or sheet that holds
 * it, and it takes no focus. A pointer may move onto it and read it there
 * (WCAG 1.4.13). Escape closes it alone; the next Escape reaches the window.
 * `hit` is the classes of the button's target area.
 */
export function StatusDot({ tone, note, label, hit = "h-6 w-6 justify-center", dotClass = "", anchor }: {
  tone: DotTone;
  note: string;
  /** What the status belongs to, for a screen reader. */
  label: string;
  hit?: string;
  dotClass?: string;
  /** The row the popover opens under; the button itself when absent. */
  anchor?: () => HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const hovering = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const dot = useRef<HTMLSpanElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hold = useCallback(() => { if (closing.current) clearTimeout(closing.current); closing.current = null; }, []);
  const enter = useCallback(() => { hold(); hovering.current = true; setOpen(true); }, [hold]);
  const leave = useCallback(() => {
    hold();
    hovering.current = false;
    closing.current = setTimeout(() => { closing.current = null; if (!pinned.current && !hovering.current) setOpen(false); }, CLOSE_DELAY);
  }, [hold]);
  useEffect(() => hold, [hold]);

  const measure = useCallback(() => {
    const button = trigger.current;
    const floating = popover.current;
    if (!button || !floating) return;
    const row = (anchor?.() ?? button).getBoundingClientRect();
    const glyph = (dot.current ?? button).getBoundingClientRect();
    const height = floating.offsetHeight;
    const below = row.bottom + 4;
    const top = below + height > window.innerHeight - EDGE ? Math.max(EDGE, row.top - height - 4) : below;
    const left = Math.max(EDGE, Math.min(glyph.left, window.innerWidth - EDGE - floating.offsetWidth));
    /* Placed once it can be measured, by hand: it stays hidden until then. */
    Object.assign(floating.style, { left: `${left}px`, top: `${top}px`, visibility: "visible" });
  }, [anchor]);

  useLayoutEffect(() => { if (open) measure(); }, [open, note, measure]);

  useEffect(() => {
    if (!open) return;
    const close = () => { hold(); pinned.current = false; hovering.current = false; setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || popover.current?.contains(target)) return;
      close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure, hold]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-settings-dot={tone}
        aria-label={`${label}: ${note}`}
        aria-expanded={open}
        className={`flex shrink-0 items-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${hit}`}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") enter(); }}
        onPointerLeave={(event) => { if (event.pointerType === "mouse") leave(); }}
        onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setOpen(true); }}
        onBlur={() => { if (!pinned.current && !hovering.current) setOpen(false); }}
        onClick={(event) => {
          event.stopPropagation();
          /* A mouse already opened it by hovering: its click holds it open. A tap, which has no hover, toggles. */
          if (hovering.current && !pinned.current) { pinned.current = true; setOpen(true); return; }
          const next = !open;
          pinned.current = next;
          setOpen(next);
        }}
      >
        <span ref={dot} aria-hidden className={`block h-[7px] w-[7px] rounded-full ${DOT_CLASS[tone]} ${dotClass}`} />
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div
          ref={popover}
          role="tooltip"
          data-settings-dot-popover=""
          onClick={(event) => event.stopPropagation()}
          onPointerEnter={(event) => { if (event.pointerType === "mouse") enter(); }}
          onPointerLeave={(event) => { if (event.pointerType === "mouse") leave(); }}
          style={{ left: 0, top: 0, maxWidth: POPOVER_WIDTH, visibility: "hidden" }}
          className={`fixed ${Z.popover} w-max rounded-control border border-border bg-raised px-2.5 py-1.5 text-ui font-normal leading-snug text-primary shadow-2`}
        >
          {note}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
