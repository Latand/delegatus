import { expect, test } from "bun:test";

import {
  createSwipeOpenStore,
  swipeLock,
  swipeOffset,
  swipeReleaseOpen,
  swipeVelocity,
  trackSwipe,
  SWIPE_LOCK_PX,
} from "./swipeIntent";

/* The row swipe's decisions (#1671): what locks, where the card sits, what a
   release does, and that only one tray is ever open. */

const WIDTH = 144;

test("nothing locks under 8 px; past it the larger axis wins and a tie is a scroll", () => {
  expect(swipeLock(0, 0)).toBeNull();
  expect(swipeLock(-(SWIPE_LOCK_PX - 1), SWIPE_LOCK_PX - 1)).toBeNull();
  expect(swipeLock(-SWIPE_LOCK_PX, 2)).toBe("x");
  expect(swipeLock(SWIPE_LOCK_PX, 0)).toBe("x");
  /* A thumb heading down the list that drifts sideways is still scrolling. */
  expect(swipeLock(-6, 9)).toBe("y");
  expect(swipeLock(-20, 21)).toBe("y");
  expect(swipeLock(-12, -12)).toBe("y");
});

test("the card follows the finger, stops at rest on the right, and resists past the tray", () => {
  expect(swipeOffset(0, 30, WIDTH)).toBe(0);
  expect(swipeOffset(0, -60, WIDTH)).toBe(-60);
  expect(swipeOffset(0, -WIDTH, WIDTH)).toBe(-WIDTH);
  /* 40 px past the tray moves the card 10. */
  expect(swipeOffset(0, -(WIDTH + 40), WIDTH)).toBe(-(WIDTH + 10));
  /* From open, a drag right closes it by as much, and no further than rest. */
  expect(swipeOffset(-WIDTH, 50, WIDTH)).toBe(-(WIDTH - 50));
  expect(swipeOffset(-WIDTH, WIDTH + 30, WIDTH)).toBe(0);
});

test("a release opens at half the tray or on a leftward flick, and a rightward flick closes", () => {
  expect(swipeReleaseOpen(-(WIDTH / 2 - 1), 0, WIDTH)).toBe(false);
  expect(swipeReleaseOpen(-WIDTH / 2, 0, WIDTH)).toBe(true);
  expect(swipeReleaseOpen(-20, -0.31, WIDTH)).toBe(true);
  expect(swipeReleaseOpen(-20, -0.29, WIDTH)).toBe(false);
  expect(swipeReleaseOpen(-WIDTH, 0.31, WIDTH)).toBe(false);
});

test("release speed comes from the last 100 ms, and a burst too short to time reads as still", () => {
  let samples = trackSwipe([], { x: 300, t: 0 });
  samples = trackSwipe(samples, { x: 290, t: 4 });
  expect(swipeVelocity(samples)).toBe(0);
  samples = trackSwipe(samples, { x: 200, t: 150 });
  samples = trackSwipe(samples, { x: 170, t: 180 });
  /* The first two samples fell out of the window. */
  expect(samples.map((sample) => sample.t)).toEqual([150, 180]);
  expect(swipeVelocity(samples)).toBe(-1);
});

test("one row open at a time: opening another closes the first, and a stale close changes nothing", () => {
  const store = createSwipeOpenStore();
  const seen: Array<string | null> = [];
  const off = store.subscribe(() => seen.push(store.getState()));
  store.open("a");
  store.open("b");
  store.close("a");
  expect(store.getState()).toBe("b");
  store.close();
  expect(store.getState()).toBeNull();
  store.close("b");
  off();
  store.open("c");
  expect(seen).toEqual(["a", "b", null]);
});
