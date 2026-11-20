import { describe, expect, test } from "bun:test";

import { CLEARANCE, CONTROL_WEIGHT, GRID_SLACK, NARROW_MIN, placeStack, stackRects, TEXT_WEIGHT, widthClearOfLeft, type Obstacle } from "./soundCaptionPlacement";

const viewport = { width: 1000, height: 700 };
const toast = { width: 200, height: 56 };
const text = (x: number, y: number, width: number, height = 16): Obstacle => ({ x, y, width, height, weight: TEXT_WEIGHT });
/** Rows of text one 16 px line every 20 px down from `y`, as a feed or a card body fills a column. */
const rows = (x: number, y: number, width: number, count: number): Obstacle[] => Array.from({ length: count }, (_, row) => text(x, y + row * 20, width));
const control = (x: number, y: number, width: number, height = 28): Obstacle => ({ x, y, width, height, weight: CONTROL_WEIGHT });
const place = (toasts: number, obstacles: Obstacle[], extra: { minTop?: number; maxDrop?: number; keep?: number; anywhere?: boolean } = {}) =>
  placeStack({ viewport, right: 16, minTop: extra.minTop ?? 56, toasts: Array.from({ length: toasts }, () => toast), obstacles, ...(extra.maxDrop === undefined ? {} : { maxDrop: extra.maxDrop }), ...(extra.keep === undefined ? {} : { keep: extra.keep }), anywhere: extra.anywhere ?? true });

describe("sound caption placement", () => {
  test("an empty page keeps the stack on its first line", () => {
    expect(place(4, [])).toEqual({ top: 56, fold: 0, free: true, shift: 0 });
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
    expect(result).toEqual({ top: 56, fold: 3, free: true, shift: 0 });
  });

  test("a page with no free place gives the newest toast the place that covers the least, and a control weighs more than text", () => {
    const wall = [text(700, 56, 280, 640), control(700, 56, 280, 24)];
    const result = place(3, wall, { maxDrop: 120 });
    expect(result.free).toBe(false);
    expect(result.fold).toBe(2);
    /* The control row is the costly part: the least-cover place is below it. */
    expect(result.top).toBeGreaterThanOrEqual(56 + 24 - CLEARANCE);
  });

  test("keep: before any covering place the stack folds to one, so keep 2 only sets what the covering place shows", () => {
    /* One toast fits over the wall (56 + 56 + 4 < 130), two do not. */
    const wall = rows(700, 130, 280, 10);
    expect(place(4, wall, { maxDrop: 100, keep: 2 })).toEqual({ top: 56, fold: 3, free: true, shift: 0 });
    /* A wall with no gap anywhere: the two stay and cover the least. */
    const solid = rows(700, 56, 280, 40);
    const covered = place(4, solid, { keep: 2 });
    expect(covered.free).toBe(false);
    expect(covered.fold).toBe(2);
    expect(covered.shift).toBe(0);
  });

  test("a floor above the number of toasts leaves them all", () => {
    expect(place(1, [], { keep: 2 })).toEqual({ top: 56, fold: 0, free: true, shift: 0 });
  });

  test("past maxDrop the newest toast alone takes a free band anywhere down the window before anything is covered", () => {
    /* Twelve rows end at 296: the free band under them is past a 100 px search, and one toast takes it. */
    const wall = rows(700, 56, 280, 12);
    const result = place(3, wall, { maxDrop: 100 });
    expect(result.free).toBe(true);
    expect(result.fold).toBe(2);
    expect(result.shift).toBe(0);
    expect(result.top).toBeGreaterThanOrEqual(56 + 12 * 20 + CLEARANCE - 4);
  });

  test("with no free band down the window the newest toast moves leftward, no further than the window's middle", () => {
    /* A wall of text on the right third from the first line to the window's foot; the middle of the window is free. */
    const wall = rows(720, 56, 260, 34);
    const kept = place(3, wall);
    expect(kept.free).toBe(false);
    const moved = placeStack({ viewport, right: 16, minTop: 56, toasts: [toast, toast, toast], obstacles: wall, anywhere: true, leftward: true });
    expect(moved.free).toBe(true);
    expect(moved.fold).toBe(2);
    expect(moved.shift).toBeGreaterThan(0);
    const [rect] = stackRects(viewport, 16 + moved.shift, moved.top, [toast]);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(720 - CLEARANCE + 1);
    expect(rect!.x).toBeGreaterThanOrEqual(viewport.width / 2);
  });

  test("a place left of the window's middle is never taken: the stack then covers", () => {
    /* Text across the whole right half. */
    const wall = rows(500, 56, 480, 34);
    const result = placeStack({ viewport, right: 16, minTop: 56, toasts: [toast, toast], obstacles: wall, anywhere: true, leftward: true });
    expect(result.free).toBe(false);
    expect(result.shift).toBe(0);
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
    expect(result).toEqual({ top: 56, fold: 2, free: true, shift: 0 });
  });

  test("no toasts, nothing to place", () => {
    expect(place(0, [text(700, 56, 280, 300)])).toEqual({ top: 56, fold: 0, free: true, shift: 0 });
  });
});

describe("the width a toast needs to stand clear of words on its left", () => {
  const wide = { width: 300, height: 62 };
  const input = (obstacles: Obstacle[], size = wide, top = 142) => ({ viewport, right: 16, top, size, obstacles });

  test("nothing under the toast needs no narrower toast", () => {
    expect(widthClearOfLeft(input([text(100, 400, 300)]))).toBeNull();
  });

  test("a label under the toast's left end narrows it to the label's right edge plus the clearance", () => {
    /* The toast's left edge is 684; a tab label ends at 700. */
    const room = widthClearOfLeft(input([text(640, 150, 60)]));
    expect(room).toBe(1000 - 16 - (700 + CLEARANCE + GRID_SLACK));
    expect(room!).toBeLessThan(wide.width);
  });

  test("the widest covered edge decides", () => {
    expect(widthClearOfLeft(input([text(640, 150, 60), control(650, 160, 70)]))).toBe(1000 - 16 - (720 + CLEARANCE + GRID_SLACK));
  });

  test("a line that runs far under the toast cannot be cleared by a toast of at least the narrowest width", () => {
    expect(widthClearOfLeft(input([text(640, 150, 300)]))).toBeNull();
    expect(NARROW_MIN).toBeGreaterThan(0);
  });

  test("an obstacle above or below the toast's rows is not covered", () => {
    expect(widthClearOfLeft(input([text(640, 142 + wide.height + CLEARANCE + 1, 60), text(640, 142 - CLEARANCE - 17, 60)]))).toBeNull();
  });
});
