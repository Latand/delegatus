import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { kanbanFocusIndex } from "@/components/kanban/kanbanFocus";
import type { KanbanModel } from "@/components/kanban/kanbanModel";

import { ARRIVAL_PULSE_ATTRIBUTE, ARRIVAL_PULSE_MS, cancelArrivalPulse, startArrivalPulse } from "./arrivalPulse";

/*
 * Where the view was just taken (#1836 item 4). The operator asked for the
 * landed thing to glow and blink, temporarily, so a handoff is visible on a
 * board with a hundred cards on it. The mark is an attribute on the element
 * the board says it drew the anchor as, and it takes itself off.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = { window: dom, document: dom.document };
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
});
afterAll(() => {
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});
afterEach(() => { cancelArrivalPulse(); dom.document.body.replaceChildren(); });

/** A board of cards, drawn the way the kanban draws them. */
function board(...cardIds: string[]) {
  dom.document.body.innerHTML = cardIds.map((id) => `<div class="card" data-id="${id}"></div>`).join("");
  return (id: string) => dom.document.querySelector(`.card[data-id="${id}"]`)!;
}

const marked = () => [...dom.document.querySelectorAll(`[${ARRIVAL_PULSE_ATTRIBUTE}]`)]
  .map((element) => element.getAttribute("data-id"));

/** The index the kanban publishes for a board holding one lane's card. */
function laneIndex(anchors: Record<string, string>) {
  const model = { columns: { inbox: { cards: [] }, assigned: { cards: [] }, blocked: { cards: [] }, done: { cards: [] } }, unlinked: [] } as unknown as KanbanModel;
  return kanbanFocusIndex(model, new Map(Object.entries(anchors)), "demo");
}

test("the landed target is marked and unmarks itself when the time is up", () => {
  board("task:task-fresh", "task:other");
  const index = laneIndex({ "group::pipeline::pl-fresh": "task:task-fresh", "task::task-fresh": "task:task-fresh" });
  let fired: (() => void) | null = null;
  let delay = 0;

  startArrivalPulse(["group::pipeline::pl-fresh"].map((key) => index.pulseSelectorFor!(key)), {
    setTimer: (run, ms) => { fired = run; delay = ms; return 1; },
  });

  expect(marked()).toEqual(["task:task-fresh"]);
  expect(delay).toBe(ARRIVAL_PULSE_MS);

  fired!();
  expect(marked()).toEqual([]);
});

test("a lane the board drew a frame ago is marked like any other card", () => {
  /* The optimistic lane of item 1: the card exists because the record arrived
     with the request, and the pulse knows nothing about where it came from. */
  board("task:task-fresh");
  const index = laneIndex({ "task::task-fresh": "task:task-fresh" });
  startArrivalPulse([index.pulseSelectorFor!("task::task-fresh")], { setTimer: () => 1 });
  expect(marked()).toEqual(["task:task-fresh"]);
});

test("a second arrival moves the mark rather than lighting two cards", () => {
  board("task:one", "task:two");
  const index = laneIndex({ "task::one": "task:one", "task::two": "task:two" });

  startArrivalPulse([index.pulseSelectorFor!("task::one")], { setTimer: () => 1, clearTimer: () => {} });
  startArrivalPulse([index.pulseSelectorFor!("task::two")], { setTimer: () => 1, clearTimer: () => {} });

  expect(marked()).toEqual(["task:two"]);
});

test("Return takes the mark off at once", () => {
  board("task:one");
  const index = laneIndex({ "task::one": "task:one" });
  startArrivalPulse([index.pulseSelectorFor!("task::one")], { setTimer: () => 1, clearTimer: () => {} });

  cancelArrivalPulse();

  expect(marked()).toEqual([]);
});

test("an anchor this board draws nothing for marks nothing, and says so", () => {
  board("task:one");
  const index = laneIndex({ "task::one": "task:one" });
  expect(index.pulseSelectorFor!("group::pipeline::not-here")).toBeNull();
  startArrivalPulse([index.pulseSelectorFor!("group::pipeline::not-here")], { setTimer: () => 1 });
  expect(marked()).toEqual([]);
});

test("the real timer clears the mark without anything being clicked", async () => {
  board("task:one");
  const index = laneIndex({ "task::one": "task:one" });
  startArrivalPulse([index.pulseSelectorFor!("task::one")], { durationMs: 20 });
  expect(marked()).toEqual(["task:one"]);

  await new Promise((resolve) => setTimeout(resolve, 60));

  expect(marked()).toEqual([]);
});
