import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
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
afterEach(() => { cancelArrivalPulse(); dom.document.body.replaceChildren(); dom.document.head.replaceChildren(); });

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

/**
 * The stylesheet's own rules for the mark, read out of `globals.css` so this
 * probes what actually ships rather than a copy of it.
 */
function pulseRules(): string {
  const css = fs.readFileSync("src/app/globals.css", "utf8");
  const rules = css.match(/\[data-attention-pulse[^{]*\{[^}]*\}/g) ?? [];
  expect(rules.length).toBeGreaterThan(1);
  return rules.join("\n");
}

function withPulseStylesheet(): void {
  const style = dom.document.createElement("style");
  style.textContent = pulseRules();
  dom.document.head.appendChild(style);
}

test("the mark never moves what it lands on: an absolutely positioned target keeps its positioning", () => {
  /* The scheme draws its nodes and task bands `position: absolute`, placed by
     left/top and by transforms (`nodes.tsx`, `TaskBandsLayer.tsx`). A blanket
     `position: relative` on the marked element drops them into normal flow —
     the card the camera has just landed on slides away under the ring. */
  withPulseStylesheet();
  dom.document.body.innerHTML = `
    <div id="scene" style="position:relative">
      <div id="node" data-scheme-node="/a.jsonl" style="position:absolute; left:120px; top:40px; width:200px; height:80px"></div>
      <div id="band" data-scheme-band-task="task-fresh" style="position:absolute; left:0; top:0; width:400px; height:200px"></div>
      <div class="card" data-id="task:task-fresh"></div>
    </div>`;
  const node = dom.document.querySelector("#node") as unknown as HTMLElement;
  const band = dom.document.querySelector("#band") as unknown as HTMLElement;
  const card = dom.document.querySelector(".card") as unknown as HTMLElement;
  /* An element that declares no position is `static` by initial value; this
     DOM carries no UA stylesheet and answers the empty string for it. */
  const positionOf = (element: HTMLElement) => dom.getComputedStyle(element as never).position || "static";
  expect([positionOf(node), positionOf(band), positionOf(card)]).toEqual(["absolute", "absolute", "static"]);

  startArrivalPulse([`[data-scheme-node="/a.jsonl"]`, `[data-scheme-band-task="task-fresh"]`, `.card[data-id="task:task-fresh"]`], { setTimer: () => 1 });

  /* Marked, all three — and the two that were placed by the layout are still
     placed by it. Only the one that was in normal flow is lifted, where
     relative changes nothing and buys the ring its paint order. */
  expect(node.getAttribute(ARRIVAL_PULSE_ATTRIBUTE)).toBe("on");
  expect(band.getAttribute(ARRIVAL_PULSE_ATTRIBUTE)).toBe("on");
  expect(card.getAttribute(ARRIVAL_PULSE_ATTRIBUTE)).toBe("lift");
  expect([positionOf(node), positionOf(band)]).toEqual(["absolute", "absolute"]);
  expect(positionOf(card)).toBe("relative");
  expect(node.style.left).toBe("120px");
  expect(node.style.top).toBe("40px");
});

test("the ring stands on its own where the scene has stopped every animation", () => {
  /* The scheme's task scene suppresses node animation with
     `animation: none !important` while the camera is a layout. A pulse that
     lived only in the keyframes would land there and show nothing at all, so
     the ring is declared as well as animated. */
  const rules = pulseRules();
  const base = rules.match(/\[data-attention-pulse\]\[data-attention-pulse\]\s*\{[^}]*\}/)?.[0] ?? "";
  expect(base).toContain("animation: attention-arrival-pulse");
  expect(base).toContain("box-shadow:");
  /* And the positioning is asked for only by the lift, never by the mark. */
  expect(base).not.toContain("position:");
  const lift = rules.match(/\[data-attention-pulse="lift"\]\[data-attention-pulse="lift"\]\s*\{[^}]*\}/)?.[0] ?? "";
  expect(lift).toContain("position: relative");
});

test("a conversation no card holds pulses the reader pane it was opened in", () => {
  /* The board lands a loose conversation in a standalone reader (`KanbanBoard`
     opens one and reports `reader`), and that pane answers for its own path.
     Without this the operator was taken somewhere with nothing lit at all. */
  const path = "/transcripts/loose.jsonl";
  dom.document.body.innerHTML = `
    <div class="card" data-id="task:other"></div>
    <div class="reader conv" data-kanban-reader="conversation_loose" data-reader-path="${path}"></div>`;
  const index = laneIndex({ "task::other": "task:other" });
  const loose = kanbanFocusIndex(
    { columns: { inbox: { cards: [] }, assigned: { cards: [] }, blocked: { cards: [] }, done: { cards: [] } }, unlinked: [] } as unknown as KanbanModel,
    new Map([["task::other", "task:other"]]),
    "demo",
    new Set([path]),
  );
  expect(index.pulseSelectorFor!(path)).toBeNull();

  startArrivalPulse([loose.pulseSelectorFor!(path)], { setTimer: () => 1 });

  const pane = dom.document.querySelector(`[data-reader-path="${path}"]`)!;
  /* In flow, like the cards, so it takes the lift. */
  expect(pane.getAttribute(ARRIVAL_PULSE_ATTRIBUTE)).toBe("lift");
  expect(dom.document.querySelectorAll(`[${ARRIVAL_PULSE_ATTRIBUTE}]`)).toHaveLength(1);
});
