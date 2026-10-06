"use client";

import { useCallback, useEffect, useState } from "react";

import { seatComposerBudget } from "@/lib/composerScroll";

/** The box a composer's budget is a share of: the conversation it is laid out
    in. The card composer's own `max-height` is written as a percentage, so the
    browser resolves it against exactly this element — its containing block —
    and the code that has to know how much room is left INSIDE that budget
    reads the same number from the same element.

    The walk skips ancestors that generate no box: a card publishes its composer
    place as a `display: contents` mount, which has no height of its own and is
    not what the percentage resolves against either. */
function conversationBox(node: HTMLElement): HTMLElement | null {
  let parent = node.parentElement;
  while (parent && parent.clientHeight === 0) parent = parent.parentElement;
  return parent;
}

/** The seat's own budget (#1734), for a box inside a surface that grows with
    its composer. `data-composer-grows` marks that surface and its `max-height`
    is the height it stops at; `data-composer-yields` marks the transcript that
    gives room up first. The rows between them that never yield are whatever
    the box holds besides those two. Growing the surface adds the same px to
    the box and takes them from the room, so the budget stands still while the
    draft is typed and moves only when the window or the seat's own height do. */
function growingBudget(box: HTMLElement, form: HTMLElement): number | null {
  const surface = box.closest<HTMLElement>("[data-composer-grows]");
  const transcript = surface ? box.querySelector<HTMLElement>("[data-composer-yields]") : null;
  if (!surface || !transcript) return null;
  const limit = parseFloat(getComputedStyle(surface).maxHeight);
  return Math.round(seatComposerBudget({
    boxHeight: box.clientHeight,
    room: Number.isFinite(limit) ? limit - surface.getBoundingClientRect().height : 0,
    rows: box.clientHeight - form.getBoundingClientRect().height - transcript.getBoundingClientRect().height,
  }));
}

/** Measure the conversation box a composer form sits in, live.

    Returns the ref to put on the form and the box's height in px — 0 until it
    has been measured, and 0 in an environment with no `ResizeObserver`, which
    is the "not measured" the ceiling falls back to the fixed cap on. The
    element is held in state rather than a ref so a form that remounts — column
    reshuffles, a dock hand-over, a dormant view coming back — re-measures the
    box it landed in.

    `budget` is what the form may take where the box is one that grows (the
    orchestrator seat), and null in a card, whose budget is a share of
    `height`. The window is read again on resize there, because the room a
    seat of a fixed height may grow into is a share of the window. */
export function useComposerBox(active: boolean): { ref: (node: HTMLFormElement | null) => void; height: number; budget: number | null } {
  const [form, setForm] = useState<HTMLElement | null>(null);
  const [measured, setMeasured] = useState<{ height: number; budget: number | null }>({ height: 0, budget: null });
  const ref = useCallback((node: HTMLFormElement | null) => { setForm(node); }, []);
  useEffect(() => {
    if (!active || !form || typeof ResizeObserver === "undefined") return;
    const box = conversationBox(form);
    if (!box) return;
    const read = () => {
      const height = box.clientHeight;
      const budget = growingBudget(box, form);
      setMeasured((previous) => (previous.height === height && previous.budget === budget ? previous : { height, budget }));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(box);
    window.addEventListener("resize", read);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [active, form]);
  return { ref, height: measured.height, budget: measured.budget };
}
