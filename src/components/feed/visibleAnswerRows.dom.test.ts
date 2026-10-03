import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { measureVisibleAnswerRows, trackVisibleAnswerRows, visibleRowArea } from "./visibleAnswerRows";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, Node: dom.Node, HTMLElement: dom.HTMLElement });

/** The part of IntersectionObserver the tracker relies on, driven by hand. */
class FakeIntersectionObserver {
  static current: FakeIntersectionObserver | null = null;
  observed = new Set<Element>();
  constructor(private readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) { FakeIntersectionObserver.current = this; }
  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() { this.observed.clear(); }
  report(rows: Element[], isIntersecting: boolean) { this.callback(rows.map((target) => ({ target, isIntersecting }))); }
}

const CLIP = { left: 0, top: 0, right: 100, bottom: 100 };
let rectReads = 0;
const nativeRects = dom.Range.prototype.getClientRects;
const nativeCaret = document.caretRangeFromPoint;
let viewport: HTMLElement;

function proseRow(index: number): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("data-tts-answer-index", String(index));
  const body = document.createElement("div");
  body.setAttribute("data-tts-body", "");
  body.append(document.createTextNode(`Answer ${index}`));
  row.append(body);
  return row;
}

function feedOf(count: number): HTMLElement[] {
  const rows = Array.from({ length: count }, (_, index) => proseRow(index));
  viewport.append(...rows);
  return rows;
}

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  rectReads = 0;
  (dom.Range.prototype as { getClientRects: () => unknown[] }).getClientRects = function () {
    rectReads += 1;
    return [{ left: 10, top: 10, right: 60, bottom: 30 }];
  };
  viewport = document.createElement("div");
  document.body.append(viewport);
  FakeIntersectionObserver.current = null;
  Object.assign(globalThis, { IntersectionObserver: FakeIntersectionObserver });
});

afterEach(() => {
  dom.Range.prototype.getClientRects = nativeRects;
  document.caretRangeFromPoint = nativeCaret;
  Object.assign(globalThis, { IntersectionObserver: undefined });
  document.body.replaceChildren();
});

test("a feed of many prose rows is measured only where rows intersect the screen", () => {
  const rows = feedOf(400);
  let changes = 0;
  const tracked = trackVisibleAnswerRows(viewport, () => { changes += 1; });
  const observer = FakeIntersectionObserver.current!;
  expect(observer.observed.size).toBe(400);
  expect(tracked.rows()).toEqual([]);

  observer.report(rows.slice(200, 203), true);
  expect(changes).toBe(1);
  const fragments = measureVisibleAnswerRows(tracked, CLIP);

  expect(fragments.map((fragment) => fragment.index).sort((a, b) => a - b)).toEqual([200, 201, 202]);
  expect(rectReads).toBe(3);
  expect(fragments.every((fragment) => fragment.area === 50 * 20)).toBe(true);

  /* Scrolled on: the rows that left drop out, the ones that arrived come in. */
  observer.report(rows.slice(200, 202), false);
  observer.report(rows.slice(203, 205), true);
  rectReads = 0;
  expect(measureVisibleAnswerRows(tracked, CLIP).map((fragment) => fragment.index).sort((a, b) => a - b)).toEqual([202, 203, 204]);
  expect(rectReads).toBe(3);
  tracked.disconnect();
});

test("rows added to the feed are observed and rows removed from it stop counting", async () => {
  const rows = feedOf(5);
  let changes = 0;
  const tracked = trackVisibleAnswerRows(viewport, () => { changes += 1; });
  const observer = FakeIntersectionObserver.current!;
  observer.report(rows, true);

  /* A page of older history prepended inside a wrapper: only that subtree is scanned. */
  const page = document.createElement("section");
  const older = [proseRow(-2), proseRow(-1)];
  page.append(...older);
  viewport.prepend(page);
  await settled();
  expect(changes).toBeGreaterThan(1);
  expect(observer.observed.has(older[0]!) && observer.observed.has(older[1]!)).toBe(true);
  expect(observer.observed.size).toBe(7);

  rows[0]!.remove();
  page.remove();
  await settled();
  expect(observer.observed.size).toBe(4);
  expect(tracked.rows().map((row) => row.dataset.ttsAnswerIndex).sort()).toEqual(["1", "2", "3", "4"]);
  tracked.disconnect();
  expect(tracked.rows()).toEqual([]);
});

test("a body-less row yields no area, and a hidden or code text node is not counted", () => {
  const bare = document.createElement("div");
  bare.setAttribute("data-tts-answer-index", "0");
  const prose = proseRow(1);
  const code = document.createElement("code");
  code.append(document.createTextNode("const x = 1"));
  prose.querySelector("[data-tts-body]")!.append(code);
  viewport.append(bare, prose);
  const tracked = trackVisibleAnswerRows(viewport, () => undefined);
  FakeIntersectionObserver.current!.report([bare, prose], true);

  const fragments = measureVisibleAnswerRows(tracked, CLIP);
  expect(fragments.find((fragment) => fragment.index === -1)?.area).toBe(0);
  expect(fragments.find((fragment) => fragment.index === 1)?.area).toBe(50 * 20);
  expect(rectReads).toBe(1);
  tracked.disconnect();
});

test("without IntersectionObserver every row is still measured, as before", () => {
  Object.assign(globalThis, { IntersectionObserver: undefined });
  feedOf(6);
  const tracked = trackVisibleAnswerRows(viewport, () => undefined);
  expect(measureVisibleAnswerRows(tracked, CLIP)).toHaveLength(6);
  expect(rectReads).toBe(6);
  tracked.disconnect();
});

test("an element whose box is outside the screen is not read; one inside it still is", () => {
  const prose = proseRow(7);
  const body = prose.querySelector("[data-tts-body]")!;
  const place = (top: number) => {
    const span = document.createElement("span");
    span.append(document.createTextNode(`at ${top}`));
    span.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 60, width: 60, height: 20 }) as DOMRect;
    body.append(span);
  };
  place(-400);
  place(10);
  place(900);
  viewport.append(prose);
  const tracked = trackVisibleAnswerRows(viewport, () => undefined);
  FakeIntersectionObserver.current!.report([prose], true);
  rectReads = 0;
  const [fragment] = measureVisibleAnswerRows(tracked, CLIP);
  /* The body's own "Answer 7" text and the span on screen; the two spans
     above and below the screen are never measured. */
  expect(rectReads).toBe(2);
  expect(fragment!.area).toBe(2 * 50 * 20);
  tracked.disconnect();
});

test("one answer of thousands of text nodes costs a bounded number of reads", () => {
  const prose = proseRow(8);
  const body = prose.querySelector("[data-tts-body]")!;
  for (let index = 0; index < 5_000; index += 1) body.append(document.createTextNode(`token ${index} `));
  viewport.append(prose);
  const tracked = trackVisibleAnswerRows(viewport, () => undefined);
  FakeIntersectionObserver.current!.report([prose], true);
  rectReads = 0;
  expect(measureVisibleAnswerRows(tracked, CLIP)[0]!.area).toBeGreaterThan(0);
  expect(rectReads).toBeLessThanOrEqual(400);
  tracked.disconnect();
});

for (const unspoken of [false, true]) {
  test(`a tall paragraph finds visible text past the read budget (unspoken=${unspoken})`, () => {
    const prose = proseRow(9);
    const body = prose.querySelector<HTMLElement>("[data-tts-body]")!;
    body.replaceChildren();
    body.getBoundingClientRect = () => ({ left: 0, right: 100, top: -10_000, bottom: 100,
      width: 100, height: 10_100 }) as DOMRect;
    for (let i = 0; i < 450; i++) {
      body.append(document.createTextNode(`offscreen ${i}`));
      const emphasis = document.createElement("strong");
      emphasis.textContent = "offscreen emphasis";
      emphasis.getBoundingClientRect = () => ({ left: 0, right: 100, top: -20, bottom: -10,
        width: 100, height: 10 }) as DOMRect;
      body.append(emphasis);
    }
    const tail = document.createElement(unspoken ? "code" : "span");
    const text = document.createTextNode("visible tail");
    tail.append(text); body.append(tail); viewport.append(prose);
    document.caretRangeFromPoint = () => {
      const caret = document.createRange(); caret.setStart(text, 0); return caret;
    };
    dom.Range.prototype.getClientRects = function () {
      rectReads++;
      return [{ left: 0, right: 100, top: this.startContainer === text ? 10 : -20,
        bottom: this.startContainer === text ? 30 : -10 }] as unknown as DOMRectList;
    };
    expect(visibleRowArea(prose, CLIP)).toBe(unspoken ? 0 : 2000);
    expect(rectReads).toBeLessThanOrEqual(400);
  });
}


test("a small visible prefix does not hide the dominant tail or count the prefix twice", () => {
  const prose = proseRow(10);
  const body = prose.querySelector<HTMLElement>("[data-tts-body]")!;
  body.replaceChildren();
  body.getBoundingClientRect = () => ({ left: 0, right: 100, top: -10_000, bottom: 100,
    width: 100, height: 10_100 }) as DOMRect;
  for (let i = 0; i < 390; i++) body.append(document.createTextNode(`offscreen ${i}`));
  const prefix = document.createTextNode("visible sliver");
  const tail = document.createTextNode("dominant visible tail");
  body.append(prefix, tail);
  const competitor = proseRow(11);
  viewport.append(prose, competitor);
  document.caretRangeFromPoint = (_x, y) => {
    const caret = document.createRange(); caret.setStart(y < 40 ? prefix : tail, 0); return caret;
  };
  dom.Range.prototype.getClientRects = function () {
    rectReads++;
    const text = this.startContainer;
    const [top, bottom] = text === prefix ? [0, 1] : text === tail ? [1, 80]
      : competitor.contains(text) ? [80, 100] : [-20, -10];
    return [{ left: 0, right: 100, top, bottom }] as unknown as DOMRectList;
  };
  const dominantArea = visibleRowArea(prose, CLIP);
  expect(dominantArea).toBe(8000);
  expect(rectReads).toBeLessThanOrEqual(400);
  expect(dominantArea).toBeGreaterThan(visibleRowArea(competitor, CLIP));
});
