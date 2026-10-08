import { describe, expect, test } from "bun:test";

import {
  applyHand,
  beginsPan,
  clampView,
  fitScale,
  fitSwipe,
  fitView,
  handMove,
  isDoubleTap,
  isFit,
  wheelFactor,
  zoomAbout,
  type ImageView,
  type Point,
} from "./imageGesture";

const LIMITS = { fit: 1, max: 8 };
const PICTURE = { width: 400, height: 200 };
/** Where the picture's own point `p` (from its centre, unscaled) is drawn. */
const drawn = (view: ImageView, p: Point): Point => ({ x: view.tx + p.x * view.scale, y: view.ty + p.y * view.scale });
/** The picture's own point drawn under `at`. */
const under = (view: ImageView, at: Point): Point => ({ x: (at.x - view.tx) / view.scale, y: (at.y - view.ty) / view.scale });
const hand = (...points: [number, number, number][]) => new Map(points.map(([id, x, y]) => [id, { x, y }]));

describe("only the primary button moves a picture", () => {
  const press = { pointerType: "mouse", button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

  test("the primary button with nothing held pans", () => {
    expect(beginsPan(press)).toBe(true);
  });

  test("a right click, a middle click and the back and forward buttons never pan", () => {
    for (const button of [1, 2, 3, 4]) expect(beginsPan({ ...press, button })).toBe(false);
  });

  test("a click with a modifier held never pans", () => {
    for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const) expect(beginsPan({ ...press, [key]: true })).toBe(false);
  });

  test("a finger and a pen tip pan, and a pen's barrel button does not", () => {
    expect(beginsPan({ ...press, pointerType: "touch" })).toBe(true);
    expect(beginsPan({ ...press, pointerType: "pen" })).toBe(true);
    expect(beginsPan({ ...press, pointerType: "pen", button: 2 })).toBe(false);
  });
});

describe("zoom about a point", () => {
  test("the picture's point under the cursor stays under it", () => {
    const about = { x: 120, y: -40 };
    const start = { scale: 1.5, tx: 30, ty: -10 };
    const held = under(start, about);
    const next = zoomAbout(start, 1.6, about, PICTURE, LIMITS);
    expect(next.scale).toBeCloseTo(2.4);
    expect(drawn(next, held).x).toBeCloseTo(about.x);
    expect(drawn(next, held).y).toBeCloseTo(about.y);
  });

  test("zooming in from fit keeps the point too", () => {
    const about = { x: -90, y: 55 };
    const held = under(fitView(LIMITS), about);
    const next = zoomAbout(fitView(LIMITS), 2, about, PICTURE, LIMITS);
    expect(drawn(next, held)).toEqual(about);
  });

  test("the scale stops at the largest", () => {
    expect(zoomAbout({ scale: 6, tx: 0, ty: 0 }, 4, { x: 0, y: 0 }, PICTURE, LIMITS).scale).toBe(8);
  });

  test("zooming out past fit is fit, centred", () => {
    const next = zoomAbout({ scale: 1.2, tx: 80, ty: -30 }, 0.5, { x: 150, y: 60 }, PICTURE, LIMITS);
    expect(next).toEqual(fitView(LIMITS));
    expect(isFit(next, LIMITS)).toBe(true);
  });

  test("fit is whatever the viewer's fit scale is", () => {
    const limits = { fit: 0.25, max: 16 };
    expect(zoomAbout({ scale: 0.3, tx: 10, ty: 10 }, 0.1, { x: 0, y: 0 }, PICTURE, limits)).toEqual({ scale: 0.25, tx: 0, ty: 0 });
  });
});

describe("clamping", () => {
  test("a pan stops with the picture's edge on the centre of its frame", () => {
    const view = clampView({ scale: 2, tx: 5000, ty: -5000 }, PICTURE, LIMITS);
    expect(view).toEqual({ scale: 2, tx: 400, ty: -200 });
  });

  test("a pan inside the reach is left alone", () => {
    const view = { scale: 2, tx: -399, ty: 199 };
    expect(clampView(view, PICTURE, LIMITS)).toEqual(view);
  });

  test("a picture at fit is never off centre", () => {
    expect(clampView({ scale: 1, tx: 300, ty: 300 }, PICTURE, LIMITS)).toEqual(fitView(LIMITS));
  });

  test("a picture that has not been measured keeps its pan", () => {
    expect(clampView({ scale: 2, tx: 900, ty: 900 }, { width: 0, height: 0 }, LIMITS)).toEqual({ scale: 2, tx: 900, ty: 900 });
  });

  test("the fit scale leaves the margin clear and never enlarges a small picture", () => {
    expect(fitScale({ width: 1600, height: 1000 }, { width: 390, height: 787 }, 12)).toBeCloseTo(366 / 1600);
    expect(fitScale({ width: 1000, height: 1600 }, { width: 824, height: 424 }, 12)).toBeCloseTo(400 / 1600);
    expect(fitScale({ width: 64, height: 64 }, { width: 390, height: 787 }, 12)).toBe(1);
    expect(fitScale({ width: 64, height: 64 }, { width: 0, height: 0 }, 12)).toBe(1);
  });
});

describe("one pointer and two", () => {
  test("one pointer carries the picture by its travel", () => {
    const move = handMove(hand([1, 10, 10]), hand([1, 35, -5]))!;
    expect(move).toEqual({ about: { x: 10, y: 10 }, dx: 25, dy: -15, factor: 1 });
    expect(applyHand({ scale: 2, tx: 0, ty: 0 }, move, PICTURE, LIMITS)).toEqual({ scale: 2, tx: 25, ty: -15 });
  });

  test("one pointer at fit moves nothing", () => {
    const move = handMove(hand([1, 10, 10]), hand([1, 90, 70]))!;
    expect(applyHand(fitView(LIMITS), move, PICTURE, LIMITS)).toEqual(fitView(LIMITS));
  });

  test("a second finger landing moves nothing", () => {
    const move = handMove(hand([1, -40, 0]), hand([1, -40, 0], [2, 40, 0]))!;
    expect(move.dx).toBe(0);
    expect(move.dy).toBe(0);
    expect(move.factor).toBe(1);
    const view = { scale: 2, tx: 14, ty: -9 };
    expect(applyHand(view, move, PICTURE, LIMITS)).toEqual(view);
  });

  test("two fingers spreading zoom about the point between them", () => {
    const about = { x: 20, y: -10 };
    const before = hand([1, -20, -10], [2, 60, -10]);
    const after = hand([1, -100, -10], [2, 140, -10]);
    const move = handMove(before, after)!;
    expect(move.about).toEqual(about);
    expect(move.factor).toBe(3);
    const held = under(fitView(LIMITS), about);
    const next = applyHand(fitView(LIMITS), move, PICTURE, LIMITS);
    expect(next.scale).toBe(3);
    expect(drawn(next, held).x).toBeCloseTo(about.x);
    expect(drawn(next, held).y).toBeCloseTo(about.y);
  });

  test("a pinch made of many small moves ends where one move would", () => {
    let pointers = hand([1, -40, 0], [2, 40, 0]);
    let view = fitView(LIMITS);
    for (let step = 1; step <= 16; step += 1) {
      const next = hand([1, -40 - step * 5, 0], [2, 40 + step * 5, 0]);
      view = applyHand(view, handMove(pointers, next)!, PICTURE, LIMITS);
      pointers = next;
    }
    expect(view.scale).toBeCloseTo(3);
    expect(view.tx).toBeCloseTo(0);
    expect(view.ty).toBeCloseTo(0);
  });

  test("two fingers travelling together carry the zoomed picture", () => {
    const move = handMove(hand([1, 0, 0], [2, 100, 0]), hand([1, 30, 20], [2, 130, 20]))!;
    expect(move.factor).toBe(1);
    expect(applyHand({ scale: 2, tx: 0, ty: 0 }, move, PICTURE, LIMITS)).toEqual({ scale: 2, tx: 30, ty: 20 });
  });

  test("a finger lifting moves nothing, and the one left carries on from where it is", () => {
    const both = hand([1, -100, 0], [2, 140, 0]);
    const left = hand([1, -100, 0]);
    const lifted = handMove(both, left)!;
    expect(lifted).toEqual({ about: { x: -100, y: 0 }, dx: 0, dy: 0, factor: 1 });
    const view = { scale: 3, tx: -40, ty: 20 };
    expect(applyHand(view, lifted, PICTURE, LIMITS)).toEqual(view);
    const carried = handMove(left, hand([1, -90, 15]))!;
    expect(applyHand(view, carried, PICTURE, LIMITS)).toEqual({ scale: 3, tx: -30, ty: 35 });
  });

  test("the first finger lifting leaves the second in charge", () => {
    const move = handMove(hand([1, 0, 0], [2, 100, 0]), hand([2, 100, 0]))!;
    expect(move).toEqual({ about: { x: 100, y: 0 }, dx: 0, dy: 0, factor: 1 });
  });

  test("a third finger is not read", () => {
    const move = handMove(hand([1, 0, 0], [2, 100, 0], [3, 50, 300]), hand([1, 0, 0], [2, 100, 0], [3, 50, 900]))!;
    expect(move).toEqual({ about: { x: 50, y: 0 }, dx: 0, dy: 0, factor: 1 });
  });

  test("no pointer held through both readings is no move", () => {
    expect(handMove(hand([1, 0, 0]), hand([2, 5, 5]))).toBeNull();
    expect(handMove(hand(), hand([1, 5, 5]))).toBeNull();
  });

  test("fingers closing past fit end at fit", () => {
    const move = handMove(hand([1, -150, 0], [2, 150, 0]), hand([1, -20, 0], [2, 20, 0]))!;
    expect(applyHand({ scale: 2, tx: 120, ty: 60 }, move, PICTURE, LIMITS)).toEqual(fitView(LIMITS));
  });
});

describe("one finger at fit", () => {
  test("a drag to the left asks for the next picture, to the right for the previous", () => {
    expect(fitSwipe(-80, 6)).toBe("next");
    expect(fitSwipe(80, -6)).toBe("previous");
  });

  test("a drag up or down asks to close", () => {
    expect(fitSwipe(5, 140)).toBe("close");
    expect(fitSwipe(-5, -140)).toBe("close");
  });

  test("a short drag asks for nothing", () => {
    expect(fitSwipe(-40, 0)).toBeNull();
    expect(fitSwipe(0, 70)).toBeNull();
    expect(fitSwipe(3, 3)).toBeNull();
  });
});

describe("taps and the wheel", () => {
  test("two taps close in time and place are a double tap", () => {
    expect(isDoubleTap({ x: 10, y: 10, at: 1000 }, { x: 18, y: 6, at: 1200 })).toBe(true);
    expect(isDoubleTap({ x: 10, y: 10, at: 1000 }, { x: 18, y: 6, at: 1400 })).toBe(false);
    expect(isDoubleTap({ x: 10, y: 10, at: 1000 }, { x: 90, y: 6, at: 1100 })).toBe(false);
    expect(isDoubleTap(null, { x: 0, y: 0, at: 0 })).toBe(false);
  });

  test("the wheel zooms in turning away and out turning back, by the same step", () => {
    const away = wheelFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false });
    const back = wheelFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false });
    expect(away).toBeGreaterThan(1);
    expect(away * back).toBeCloseTo(1);
  });

  test("one turn of a fast wheel is one step, in pixels or in lines", () => {
    const notch = wheelFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false });
    expect(wheelFactor({ deltaY: -900, deltaMode: 0, ctrlKey: false })).toBe(notch);
    expect(wheelFactor({ deltaY: -9, deltaMode: 1, ctrlKey: false })).toBe(notch);
  });

  test("a trackpad pinch zooms faster per pixel than a scroll", () => {
    expect(wheelFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true })).toBeGreaterThan(wheelFactor({ deltaY: -10, deltaMode: 0, ctrlKey: false }));
  });
});
