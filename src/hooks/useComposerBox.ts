"use client";

import { useCallback, useEffect, useState } from "react";

import { cardComposerBudget, seatComposerBudget } from "@/lib/composerScroll";

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

/** The scrollport of the feed inside a transcript, when it is a feed. */
function readableFeed(transcript: HTMLElement): HTMLElement | null {
  return transcript.querySelector<HTMLElement>("[data-log-feed-scroller]");
}

/** The form's budget, from what the box holds (2026-10-11). The transcript —
    `data-composer-yields` — keeps its floor in the part of the box it shares
    with the composer: the box below whatever sits above the transcript (a
    pane's header, a banner), which is chrome of its own. The rows between the
    transcript and the form, and any after it, never yield, so they come out of
    the composer's share rather than out of the transcript.

    In a surface that grows with its composer (the orchestrator seat, #1734),
    `data-composer-grows` marks that surface and its `max-height` is the height
    it stops at: the budget is what that height leaves, so the seat grows to
    its stop and keeps the floor there. Growing the surface adds the same px to
    the box and takes them from the room, so the budget stands still while the
    draft is typed and moves only when the window or the seat's own height do.

    What keeps the floor is what the operator reads: the feed's own
    scrollport. A row the feed holds under it (the turn's status line) never
    yields either, so it comes out of the composer's share with the others.

    Null where the box holds no transcript to keep a floor for: the card's
    share of the whole box applies there, from its height alone. */
function composerBudget(box: HTMLElement, form: HTMLElement, transcript: HTMLElement | null): number | null {
  if (!transcript) return null;
  const top = box.getBoundingClientRect().top;
  const feed = transcript.getBoundingClientRect();
  const body = box.clientHeight - Math.max(0, feed.top - top);
  const readable = readableFeed(transcript)?.getBoundingClientRect().height ?? feed.height;
  const rows = body - readable - form.getBoundingClientRect().height;
  const surface = box.closest<HTMLElement>("[data-composer-grows]");
  if (!surface) return Math.floor(cardComposerBudget(body, rows));
  const limit = parseFloat(getComputedStyle(surface).maxHeight);
  return Math.floor(seatComposerBudget({
    boxHeight: body,
    room: Number.isFinite(limit) ? limit - surface.getBoundingClientRect().height : 0,
    rows,
  }));
}

/** Measure the conversation box a composer form sits in, live.

    Returns the ref to put on the form and the box's height in px — 0 until it
    has been measured, and 0 in an environment with no `ResizeObserver`, which
    is the "not measured" the ceiling falls back to the fixed cap on. The
    element is held in state rather than a ref so a form that remounts — column
    reshuffles, a dock hand-over, a dormant view coming back — re-measures the
    box it landed in.

    `budget` is what the form may take so the transcript keeps its floor:
    measured from the box's own rows, and null where the box holds no
    transcript, whose budget is then a share of `height`. The window is read
    again on resize, because the room a seat of a fixed height may grow into
    is a share of the window. */
export function useComposerBox(active: boolean): { ref: (node: HTMLFormElement | null) => void; height: number; budget: number | null } {
  const [form, setForm] = useState<HTMLElement | null>(null);
  const [measured, setMeasured] = useState<{ height: number; budget: number | null }>({ height: 0, budget: null });
  const ref = useCallback((node: HTMLFormElement | null) => { setForm(node); }, []);
  useEffect(() => {
    if (!active || !form || typeof ResizeObserver === "undefined") return;
    const box = conversationBox(form);
    if (!box) return;
    /* A row that comes or goes beside the composer leaves the box as tall as
       it was: the transcript is what changed height, so it is observed too —
       whichever transcript the box holds at the time of the read — and so is
       its feed, which gives up the room for a row of its own. */
    let watched: HTMLElement[] = [];
    const observer = new ResizeObserver(() => read());
    const read = () => {
      const transcript = box.querySelector<HTMLElement>("[data-composer-yields]");
      const feed = transcript ? readableFeed(transcript) : null;
      const next = [transcript, feed].filter((element): element is HTMLElement => element !== null);
      if (next.length !== watched.length || next.some((element, index) => element !== watched[index])) {
        for (const element of watched) observer.unobserve(element);
        for (const element of next) observer.observe(element);
        watched = next;
      }
      const height = box.clientHeight;
      const budget = composerBudget(box, form, transcript);
      setMeasured((previous) => (previous.height === height && previous.budget === budget ? previous : { height, budget }));
    };
    observer.observe(box);
    read();
    window.addEventListener("resize", read);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [active, form]);
  return { ref, height: measured.height, budget: measured.budget };
}
