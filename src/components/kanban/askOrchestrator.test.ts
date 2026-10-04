import { afterEach, expect, test } from "bun:test";

import { holdCardInPlace } from "./askOrchestrator";

/* Opening or expanding the orchestrator seat moves the board under the card's
   button. The board must not jump away from the card: the scroller it lives in
   is nudged by exactly the distance the card moved. */

function fake(top: () => number, scroller: { scrollTop: number } | null) {
  return {
    getBoundingClientRect: () => ({ top: top() }),
    closest: () => scroller,
  } as unknown as HTMLElement;
}

const frames: Array<() => void> = [];
const schedule = (callback: () => void) => { frames.push(callback); };
const flush = () => { while (frames.length) frames.shift()!(); };
afterEach(() => { frames.length = 0; });

test("a card pushed down by the seat is brought back by the same distance", () => {
  let top = 300;
  const scroller = { scrollTop: 40 };
  holdCardInPlace(fake(() => top, scroller), () => { top = 620; }, schedule);
  flush();
  expect(scroller.scrollTop).toBe(40 + 320);
});

test("a card that did not move leaves the scroller alone", () => {
  const scroller = { scrollTop: 40 };
  holdCardInPlace(fake(() => 300, scroller), () => {}, schedule);
  flush();
  expect(scroller.scrollTop).toBe(40);
});

test("a card with no scroller above it is left where it is", () => {
  let top = 300;
  holdCardInPlace(fake(() => top, null), () => { top = 500; }, schedule);
  expect(() => flush()).not.toThrow();
});

test("a card that left the page is not chased", () => {
  const scroller = { scrollTop: 10 };
  let top = 300;
  const card = fake(() => top, scroller);
  holdCardInPlace(card, () => { top = Number.NaN; }, schedule);
  flush();
  expect(scroller.scrollTop).toBe(10);
});
