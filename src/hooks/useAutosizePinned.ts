"use client";

import { useLayoutEffect } from "react";

import { caretAtEnd, clampHeight, shouldPin } from "@/lib/composerScroll";

export interface AutosizePinnedOptions {
  /** Delivery owners can retain their field while its view is dormant. */
  active?: boolean;
  /** The element `ref` currently holds, when the field can be replaced while
      this hook stays mounted; a new one is measured as it arrives. */
  field?: HTMLTextAreaElement | null;
  /** Maximum field height in pixels; beyond it the field scrolls internally. */
  maxPx: number;
  /** Minimum field height in pixels (a multi-line default before any text). */
  minPx?: number;
  /** True while a live dictation drives the field: pin to the newest words on
      every update regardless of the (readOnly) caret position. */
  pinned: boolean;
}

/**
 * Grows a textarea to fit its content up to `maxPx`, then pins the scroll to
 * the newest text so live dictation and end-of-field typing never scroll the
 * latest words out of view — while leaving the scroll untouched when the caret
 * is parked mid-text for editing. Re-measures on every `value` change (covers
 * restored drafts, dictation inserts, and typing), on a new `field`, on a
 * placeholder change while the field is empty, and on a width change.
 *
 * The shared seam behind every composer surface (`useComposer` for the pane /
 * draft / bulk / task-create composers, and the task edit field directly), so
 * the grow-and-pin behavior is identical everywhere the mic lives.
 */
export function useAutosizePinned(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  { maxPx, minPx = 0, pinned, active = true, field }: AutosizePinnedOptions,
): void {
  useLayoutEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    fit(el, maxPx, minPx, pinned);
  }, [ref, value, maxPx, minPx, pinned, active, field]);

  /* An empty field is as tall as its placeholder, and the placeholder changes
     without the value doing so: a seat whose structured host is still being
     resolved swaps «message the agent» for the longer «… reconnecting to its
     session…», which wraps to a second line on a phone. Measured only on value
     changes, the field kept the one line it had and showed the tops of the
     second line's letters over the tools row. A width change rewraps the same
     text, so it re-measures too — on the next frame, because resizing the
     field from its own resize notification is a ResizeObserver loop. */
  useLayoutEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const placeholder = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
      if (!el.value) fit(el, maxPx, minPx, pinned);
    });
    placeholder?.observe(el, { attributes: true, attributeFilter: ["placeholder"] });
    let width = el.getBoundingClientRect().width;
    let frame = 0;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      const next = el.getBoundingClientRect().width;
      if (next === width) return;
      width = next;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fit(el, maxPx, minPx, pinned));
    });
    resize?.observe(el);
    return () => {
      placeholder?.disconnect();
      resize?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ref, maxPx, minPx, pinned, active, field]);
}

function fit(el: HTMLTextAreaElement, maxPx: number, minPx: number, pinned: boolean): void {
  /* Collapsing to 0 before measuring lets the field shrink back when text is
     deleted; it also resets scrollTop, so a mid-text edit's position is
     captured first and restored after. */
  const prevTop = el.scrollTop;
  const atEnd = caretAtEnd(el.selectionStart, el.selectionEnd, el.value.length);
  /* The box the field sits in keeps its height through the measurement.
     Reading `scrollHeight` lays the page out with the field at 0px, and
     without this everything above the composer was laid out that much
     taller for that one pass: a transcript a few lines long fitted its
     scroller whole, the browser took its scroll offset to zero, and it came
     back off its tail with the "down" row drawn over a seat's 72px of
     transcript (#1734). */
  const holder = el.parentElement;
  const heldMinHeight = holder?.style.minHeight ?? "";
  if (holder) holder.style.minHeight = `${holder.getBoundingClientRect().height}px`;
  el.style.height = "0px";
  el.style.height = clampHeight(el.scrollHeight, maxPx, minPx) + "px";
  if (holder) holder.style.minHeight = heldMinHeight;
  if (shouldPin({ pinned, caretAtEnd: atEnd })) {
    el.scrollTop = el.scrollHeight;
  } else {
    el.scrollTop = prevTop;
  }
}
