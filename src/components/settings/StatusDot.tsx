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
/* Long enough for a pointer to cross from the dot to the popover on its row. */
const CLOSE_DELAY = 300;
/* After the label's words; narrower than this and the popover lies over its own row instead. */
const AFTER_LABEL = 12;
const MIN_WIDTH = 96;

/* NodeFilter.SHOW_TEXT, which not every DOM a test runs in defines globally. */
const SHOW_TEXT = 4;

/** Every line of words under `root` that `keep` admits, as boxes on the screen. */
function textBoxes(root: Element, keep: (node: Node) => boolean): DOMRect[] {
  const boxes: DOMRect[] = [];
  const walker = document.createTreeWalker(root, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node.textContent ?? "").trim() || !keep(node) || node.parentElement?.closest("option, select, [data-settings-dot-popover]")) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const box of range.getClientRects?.() ?? []) if (box.width > 0 && box.height > 0) boxes.push(box);
  }
  return boxes;
}

/** Where the label's words end: a truncated label ends at its own box. */
function wordsEnd(label: HTMLElement): number {
  const boxes = textBoxes(label, () => true);
  const box = label.getBoundingClientRect();
  return boxes.length ? Math.min(box.right, Math.max(...boxes.map((entry) => entry.right))) : box.left;
}

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

  /*
   * The popover covers no words of another row: it opens on its own row, after the label's words (over the row's
   * own value, which it explains), or over its row from the dot on, and only where neither fits under or above it.
   * Each place is tried by its real size against the words around it; one of two lines at most.
   */
  const measure = useCallback(() => {
    const button = trigger.current;
    const floating = popover.current;
    if (!button || !floating) return;
    const rowElement = anchor?.() ?? button;
    const row = rowElement.getBoundingClientRect();
    const glyph = (dot.current ?? button).getBoundingClientRect();
    const place = (left: number, top: number, width: number) => {
      Object.assign(floating.style, { left: `${left}px`, top: `${top}px`, maxWidth: `${width}px` });
      return floating.getBoundingClientRect();
    };
    const sized = (width: number) => place(0, 0, width);
    const lines = () => new Set(textBoxes(floating, () => true).map((box) => Math.round(box.top))).size;
    const fallback = () => {
      const size = sized(POPOVER_WIDTH);
      const below = row.bottom + 4;
      const top = below + size.height > window.innerHeight - EDGE ? Math.max(EDGE, row.top - size.height - 4) : below;
      return { left: Math.max(EDGE, Math.min(glyph.left, window.innerWidth - EDGE - size.width)), top, width: POPOVER_WIDTH };
    };
    const surface = button.closest<HTMLElement>("[data-settings-scroller], [data-mobile2-sheet-body]");
    let chosen = fallback();
    if (surface && rowElement !== button) {
      const foreign = textBoxes(surface, (node) => !rowElement.contains(node));
      const label = rowElement.querySelector<HTMLElement>("[data-settings-row-label]");
      const right = Math.min(row.right - EDGE, window.innerWidth - EDGE);
      const candidates: { left: number; top: (height: number) => number; width: number }[] = [];
      if (label) {
        const box = label.getBoundingClientRect();
        const left = Math.ceil(wordsEnd(label) + AFTER_LABEL);
        candidates.push({ left, width: Math.min(POPOVER_WIDTH, Math.floor(right - left)), top: (height) => Math.round(box.top + box.height / 2 - height / 2) });
      }
      const over = Math.ceil(glyph.right + 6);
      candidates.push({ left: over, width: Math.min(POPOVER_WIDTH, Math.floor(right - over)), top: () => Math.round(row.top + 2) });
      const edge = Math.max(EDGE, Math.min(glyph.left, window.innerWidth - EDGE - POPOVER_WIDTH));
      candidates.push({ left: edge, width: POPOVER_WIDTH, top: () => Math.round(row.bottom + 4) });
      candidates.push({ left: edge, width: POPOVER_WIDTH, top: (height) => Math.round(row.top - height - 4) });
      const clear = (box: DOMRect) => box.top >= EDGE && box.bottom <= window.innerHeight - EDGE && box.right <= window.innerWidth - EDGE + 0.5
        && !foreign.some((ink) => ink.left < box.right - 0.5 && ink.right > box.left + 0.5 && ink.top < box.bottom - 0.5 && ink.bottom > box.top + 0.5);
      for (const candidate of candidates) {
        if (candidate.width < MIN_WIDTH) continue;
        const top = candidate.top(sized(candidate.width).height);
        if (lines() <= 2 && clear(place(candidate.left, top, candidate.width))) { chosen = { left: candidate.left, top, width: candidate.width }; break; }
      }
    }
    /* Placed once it can be measured, by hand: it stays hidden until then. */
    place(chosen.left, chosen.top, chosen.width);
    floating.style.visibility = "visible";
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
