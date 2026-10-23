import { describe, expect, test } from "bun:test";

import { CLEARANCE, CONTROL_WEIGHT, placeStack, stackRects, TEXT_WEIGHT, type Obstacle } from "./soundCaptionPlacement";

const viewport = { width: 1000, height: 700 };
const toast = { width: 200, height: 56 };
const text = (x: number, y: number, width: number, height = 16): Obstacle => ({ x, y, width, height, weight: TEXT_WEIGHT });
/** Rows of text one 16 px line every 20 px down from `y`, as a feed or a card body fills a column. */
const rows = (x: number, y: number, width: number, count: number): Obstacle[] => Array.from({ length: count }, (_, row) => text(x, y + row * 20, width));
const control = (x: number, y: number, width: number, height = 28): Obstacle => ({ x, y, width, height, weight: CONTROL_WEIGHT });
const place = (toasts: number, obstacles: Obstacle[], extra: { minTop?: number; maxDrop?: number; keep?: number } = {}) =>
  placeStack({ viewport, right: 16, minTop: extra.minTop ?? 56, toasts: Array.from({ length: toasts }, () => toast), obstacles, ...(extra.maxDrop === undefined ? {} : { maxDrop: extra.maxDrop }), ...(extra.keep === undefined ? {} : { keep: extra.keep }) });

describe("sound caption placement", () => {
  test("an empty page keeps the stack on its first line", () => {
    expect(place(4, [])).toEqual({ top: 56, fold: 0, free: true });
  });

  test("a line of text under the first place moves the whole stack below it", () => {
    const line = text(800, 70, 150);
    const result = place(2, [line]);
    expect(result.free).toBe(true);
    expect(result.fold).toBe(0);
    expect(result.top).toBeGreaterThanOrEqual(line.y + line.height + CLEARANCE - 2);
    for (const rect of stackRects(viewport, 16, result.top, [toast, toast])) expect(rect.y >= line.y + line.height || rect.y + rect.height <= line.y).toBe(true);
  });

  test("a control counts like text: the stack never stands on it", () => {
    const button = control(780, 56, 180);
    const result = place(1, [button]);
    expect(result.free).toBe(true);
    expect(result.top).toBeGreaterThanOrEqual(button.y + button.height + CLEARANCE - 2);
  });

  test("text to the left of the stack's width leaves the first place free", () => {
    expect(place(1, [text(100, 60, 600)]).top).toBe(56);
  });

  test("where only the newest fits, the older toasts fold", () => {
    /* Free within the search: the 70 px over the wall. Four toasts need 248, one needs 56. */
    const result = place(4, [text(700, 130, 280, 200)], { maxDrop: 100 });
    expect(result).toEqual({ top: 56, fold: 3, free: true });
  });

  test("a page with no free place gives the newest toast the place that covers the least, and a control weighs more than text", () => {
    const wall = [text(700, 56, 280, 300), control(700, 56, 280, 24)];
    const result = place(3, wall, { maxDrop: 120 });
    expect(result.free).toBe(false);
    expect(result.fold).toBe(2);
    /* The control row is the costly part: the least-cover place is below it. */
    expect(result.top).toBeGreaterThanOrEqual(56 + 24 - CLEARANCE);
  });

  test("keep: two stops the folding at two, and the covering place is taken for them", () => {
    /* One toast fits over the wall (56 + 56 + 4 < 130) but two do not: with keep 2 the stack stays at two toasts and covers the least. */
    const wall = rows(700, 130, 280, 10);
    const one = place(4, wall, { maxDrop: 100 });
    expect(one).toEqual({ top: 56, fold: 3, free: true });
    const two = place(4, wall, { maxDrop: 100, keep: 2 });
    expect(two.free).toBe(false);
    expect(two.fold).toBe(2);
    /* The free band under the wall (it ends at 330) is past the search, so the two stay near the top. */
    expect(two.top).toBeLessThanOrEqual(56 + 100);
  });

  test("a floor above the number of toasts leaves them all", () => {
    expect(place(1, [], { keep: 2 })).toEqual({ top: 56, fold: 0, free: true });
  });

  test("the search stops at maxDrop: a free band beyond it is not taken, the stack covers the least within it", () => {
    /* Twelve rows end at 292: the free band under them is past a 100 px search, so the stack stays near the top. */
    const wall = rows(700, 56, 280, 12);
    const result = place(1, wall, { maxDrop: 100 });
    expect(result.free).toBe(false);
    expect(result.fold).toBe(0);
    expect(result.top).toBeLessThanOrEqual(56 + 100);
  });

  test("where a control and text both lie under the choices, the stack covers the text", () => {
    const wall = [...rows(700, 56, 280, 30), control(700, 100, 120)];
    const result = place(1, wall);
    expect(result.free).toBe(false);
    /* The control row at 100 weighs eight lines: the place keeps off it. */
    const [rect] = stackRects(viewport, 16, result.top, [toast]);
    expect(rect!.y >= 100 + 28 || rect!.y + rect!.height <= 100).toBe(true);
  });

  test("a short window keeps the stack inside it", () => {
    const result = placeStack({ viewport: { width: 1000, height: 150 }, right: 16, minTop: 56, toasts: [toast, toast, toast], obstacles: [] });
    /* Three toasts need 184 px, two 120: only one stays inside 150, and it is the newest. */
    expect(result).toEqual({ top: 56, fold: 2, free: true });
  });

  test("no toasts, nothing to place", () => {
    expect(place(0, [text(700, 56, 280, 300)])).toEqual({ top: 56, fold: 0, free: true });
  });
});
