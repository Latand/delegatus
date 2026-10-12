import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { cardComposerBudget, seatComposerBudget, TRANSCRIPT_FLOOR_SHARE } from "@/lib/composerScroll";

import { useComposerBox } from "./useComposerBox";

/*
 * The transcript's floor (operator, 2026-10-11) is a share of the conversation
 * the composer sits in: the part of the pane below its header, where the
 * transcript and the composer share one column. The hook measures that body
 * and the rows beside the composer that never yield, so the form's budget is
 * what keeps the transcript at 60% of it. happy-dom lays nothing out, so each
 * box here carries the geometry the browser would have measured.
 */

const dom = new Window({ width: 1440, height: 900 });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  getComputedStyle: dom.getComputedStyle.bind(dom),
});

/* One observer list for the whole file: a test plays a resize by calling back. */
const observed: { callback: () => void; targets: Element[] }[] = [];
class FakeResizeObserver {
  private readonly entry: { callback: () => void; targets: Element[] };
  constructor(callback: () => void) {
    this.entry = { callback, targets: [] };
    observed.push(this.entry);
  }
  observe(target: Element) { this.entry.targets.push(target); }
  unobserve() {}
  disconnect() { this.entry.targets = []; }
}
(globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;

interface Geometry { top: number; height: number }
function place(element: HTMLElement, geometry: Geometry): void {
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => geometry.height });
  element.getBoundingClientRect = () => ({
    top: geometry.top, bottom: geometry.top + geometry.height, height: geometry.height,
    left: 0, right: 600, width: 600, x: 0, y: geometry.top, toJSON: () => ({}),
  }) as DOMRect;
}

let latest: { height: number; budget: number | null } = { height: 0, budget: null };
function Probe() {
  const { ref, height, budget } = useComposerBox(true);
  /* Read at commit: flushSync runs layout effects before it returns. */
  useLayoutEffect(() => { latest = { height, budget }; });
  return <form ref={ref} data-probe-form="" />;
}

let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  observed.length = 0;
  document.body.replaceChildren();
});

/** A pane: a header, the transcript, a row beside the composer, and the composer's place.
    `status` is a row the feed keeps under its own scrollport (the turn's status line). */
function pane({ header, transcript, row, form, box, grows, status = 0 }: { header: number; transcript: number | null; row: number; form: number; box: number; grows?: { maxHeight: number }; status?: number }) {
  const surface = document.createElement("section");
  if (grows) {
    surface.setAttribute("data-composer-grows", "");
    surface.style.maxHeight = `${grows.maxHeight}px`;
  }
  const column = document.createElement("div");
  surface.append(column);
  place(surface, { top: 0, height: box });
  place(column, { top: 0, height: box });
  const head = document.createElement("header");
  place(head, { top: 0, height: header });
  column.append(head);
  let feed: HTMLElement | null = null;
  if (transcript !== null) {
    feed = document.createElement("div");
    feed.setAttribute("data-composer-yields", "");
    place(feed, { top: header, height: transcript });
    const scroller = document.createElement("div");
    scroller.setAttribute("data-log-feed-scroller", "");
    place(scroller, { top: header, height: transcript - status });
    feed.append(scroller);
    column.append(feed);
  }
  const besides = document.createElement("div");
  place(besides, { top: header + (transcript ?? 0), height: row });
  column.append(besides);
  /* The composer's place is a `display: contents` slot: no box of its own. */
  const slot = document.createElement("div");
  column.append(slot);
  document.body.append(surface);
  const root = createRoot(slot);
  roots.push(root);
  flushSync(() => root.render(<Probe />));
  const formNode = slot.querySelector<HTMLElement>("[data-probe-form]")!;
  place(formNode, { top: box - form, height: form });
  /* The first read ran before the form had its geometry; play the observer. */
  flushSync(() => { for (const entry of observed) entry.callback(); });
  return { surface, feed, formNode };
}

test("the budget is the floor's share of the conversation under the header, less the rows beside the composer", () => {
  pane({ header: 60, transcript: 440, row: 36, form: 164, box: 700 });
  expect(latest.height).toBe(700);
  /* The conversation is the 640 px under the header; the row beside the composer is 36. */
  expect(latest.budget).toBe(cardComposerBudget(640, 36));
  expect(latest.budget).toBe(Math.floor(640 * (1 - TRANSCRIPT_FLOOR_SHARE)) - 36);
});

test("a row that appears beside the composer is measured again, through the transcript it took room from", () => {
  const { feed } = pane({ header: 60, transcript: 476, row: 0, form: 164, box: 700 });
  expect(latest.budget).toBe(cardComposerBudget(640, 0));
  expect(observed.some((entry) => entry.targets.includes(feed!))).toBe(true);
  /* A 36 px row arrives: the transcript, and the feed inside it, gave it its height. */
  place(feed!, { top: 60, height: 440 });
  place(feed!.querySelector<HTMLElement>("[data-log-feed-scroller]")!, { top: 60, height: 440 });
  flushSync(() => { for (const entry of observed) if (entry.targets.includes(feed!)) entry.callback(); });
  expect(latest.budget).toBe(cardComposerBudget(640, 36));
});

test("the feed's own status row under its scrollport comes out of the composer's share too", () => {
  /* A turn is running: the feed keeps its 33 px status line under what it scrolls. */
  pane({ header: 60, transcript: 476, row: 0, form: 164, box: 700, status: 33 });
  expect(latest.budget).toBe(cardComposerBudget(640, 33));
  /* At that budget what the operator reads keeps the floor. */
  expect(640 - 33 - latest.budget!).toBeGreaterThanOrEqual(640 * TRANSCRIPT_FLOOR_SHARE);
});

test("a status row that appears inside the feed is measured again, through the scrollport that gave it room", () => {
  pane({ header: 60, transcript: 476, row: 0, form: 164, box: 700 });
  expect(latest.budget).toBe(cardComposerBudget(640, 0));
  const scroller = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
  expect(observed.some((entry) => entry.targets.includes(scroller))).toBe(true);
  place(scroller, { top: 60, height: 476 - 33 });
  flushSync(() => { for (const entry of observed) if (entry.targets.includes(scroller)) entry.callback(); });
  expect(latest.budget).toBe(cardComposerBudget(640, 33));
});

test("a seat that grows budgets against the height its grip stops at", () => {
  pane({ header: 60, transcript: 440, row: 36, form: 164, box: 700, grows: { maxHeight: 900 } });
  expect(latest.budget).toBe(seatComposerBudget({ boxHeight: 640, room: 200, rows: 36 }));
});

test("a box with no transcript to keep a floor for has no budget of its own", () => {
  pane({ header: 0, transcript: null, row: 0, form: 164, box: 700 });
  expect(latest.height).toBe(700);
  expect(latest.budget).toBeNull();
});
