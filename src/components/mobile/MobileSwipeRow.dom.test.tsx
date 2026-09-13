import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";

/*
 * The board row's swipe (#1671), mounted on its own. happy-dom does no layout
 * and has no compositor, so what this pins is the contract the Chromium
 * capture measures with real touches: the card follows a horizontal drag and
 * never a vertical one, a release opens at half the tray or on a flick, the
 * lift is never a tap on the card, one row is open at a time, a long-press
 * and keyboard focus reach the same buttons, and a row that leaves the list
 * takes its open tray with it.
 */

const { MobileSwipeRow } = await import("./MobileSwipeRow");
const { createSwipeOpenStore, LONG_PRESS_MS, SWIPE_ACTION_WIDTH } = await import("./swipeIntent");

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, FocusEvent: dom.FocusEvent,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  dom.document.body.replaceChildren();
});

const WIDTH = 2 * SWIPE_ACTION_WIDTH;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const store = createSwipeOpenStore();
  const taps: string[] = [];
  const runs: string[] = [];
  const presses: string[] = [];
  const actions = (row: string) => [
    { key: "hide", label: "Hide", name: "Hide from board", hint: "The lane stays as it is.", icon: null, tone: "accent" as const, run: () => runs.push(`${row}:hide`) },
    { key: "close", label: "Close", name: "Close lane", hint: "Stops its agents.", icon: null, tone: "danger" as const, run: () => runs.push(`${row}:close`) },
  ];
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(
    <>
      {["a", "b"].map((row) => (
        <MobileSwipeRow key={row} id={row} title={`Row ${row}`} actions={actions(row)} store={store} onLongPress={() => presses.push(row)}>
          <button type="button" data-card={row} onClick={() => taps.push(row)}>Row {row}</button>
        </MobileSwipeRow>
      ))}
      <button type="button" data-outside>elsewhere</button>
    </>,
  ));
  const el = (selector: string) => container.querySelector(selector) as unknown as HTMLElement;
  return {
    store, taps, runs, presses, root, el,
    container: container as unknown as HTMLElement,
    open: (row: string) => el(`[data-mobile2-swipe-row="${row}"]`).getAttribute("data-mobile2-swipe-open"),
    card: (row: string) => el(`[data-card="${row}"]`),
    layer: (row: string) => el(`[data-mobile2-swipe-row="${row}"] [data-mobile2-swipe-card]`),
  };
}

const fire = (target: HTMLElement, type: string, x: number, y: number) => flushSync(() => {
  target.dispatchEvent(new dom.PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "touch", isPrimary: true,
  }) as unknown as Event);
});
const drag = (target: HTMLElement, points: Array<[number, number]>) => {
  fire(target, "pointerdown", ...points[0]!);
  for (const point of points.slice(1)) fire(target, "pointermove", ...point);
  fire(target, "pointerup", ...points[points.length - 1]!);
};
const tap = (target: HTMLElement) => {
  fire(target, "pointerdown", 100, 20);
  fire(target, "pointerup", 100, 20);
  flushSync(() => target.click());
};

test("a drag across past half the tray opens it, the card follows the finger, and the lift is not a tap on the card", () => {
  const h = setup();
  const card = h.card("a");
  fire(card, "pointerdown", 340, 20);
  fire(card, "pointermove", 330, 21);
  fire(card, "pointermove", 250, 22);
  /* Under the finger, with nothing easing between the finger and the card. */
  expect(h.layer("a").style.transform).toBe("translateX(-90px)");
  expect(h.layer("a").style.transition).toBe("none");
  fire(card, "pointerup", 250, 22);
  flushSync(() => card.click());
  expect(h.open("a")).toBe("true");
  expect(h.layer("a").style.transform).toBe(`translateX(-${WIDTH}px)`);
  expect(h.el('[data-mobile2-swipe-row="a"] [data-mobile2-swipe-tray]').style.opacity).toBe("1");
  expect(h.taps).toEqual([]);
});

test("a short drag springs back, and a drag that goes down the list never moves the row", () => {
  const h = setup();
  const card = h.card("a");
  drag(card, [[340, 20], [330, 20], [300, 21]]);
  expect(h.open("a")).toBeNull();
  expect(h.layer("a").style.transform).toBe("");
  /* Down first: that is the list scrolling, whatever the finger does next. */
  drag(card, [[340, 20], [342, 32], [200, 60]]);
  expect(h.layer("a").style.transform).toBe("");
  expect(h.open("a")).toBeNull();
  /* And a plain tap still opens the card. */
  tap(card);
  expect(h.taps).toEqual(["a"]);
});

test("a quick flick opens a short drag, and a quick flick back closes a long one", async () => {
  const h = setup();
  const card = h.card("a");
  fire(card, "pointerdown", 340, 20);
  fire(card, "pointermove", 330, 20);
  await sleep(40);
  fire(card, "pointermove", 300, 20);
  fire(card, "pointerup", 300, 20);
  expect(h.open("a")).toBe("true");
  fire(card, "pointerdown", 200, 20);
  fire(card, "pointermove", 210, 20);
  await sleep(40);
  fire(card, "pointermove", 240, 20);
  fire(card, "pointerup", 240, 20);
  expect(h.open("a")).toBeNull();
});

test("a tap on an open row's card puts the tray away and opens nothing; a tray button runs its action and closes", () => {
  const h = setup();
  const card = h.card("a");
  drag(card, [[340, 20], [330, 20], [180, 20]]);
  expect(h.open("a")).toBe("true");
  tap(card);
  expect(h.open("a")).toBeNull();
  expect(h.taps).toEqual([]);

  drag(card, [[340, 20], [330, 20], [180, 20]]);
  const close = h.el('[data-mobile2-swipe-row="a"] [data-mobile2-swipe-action="close"]');
  fire(close, "pointerdown", 330, 20);
  fire(close, "pointerup", 330, 20);
  flushSync(() => close.click());
  expect(h.runs).toEqual(["a:close"]);
  expect(h.open("a")).toBeNull();
  expect(h.taps).toEqual([]);
});

test("one row is open at a time, and a touch elsewhere or a scroll of the list puts it away", () => {
  const h = setup();
  drag(h.card("a"), [[340, 20], [330, 20], [180, 20]]);
  drag(h.card("b"), [[340, 80], [330, 80], [180, 80]]);
  expect(h.open("a")).toBeNull();
  expect(h.layer("a").style.transform).toBe("");
  expect(h.open("b")).toBe("true");
  fire(h.el("[data-outside]"), "pointerdown", 10, 400);
  expect(h.open("b")).toBeNull();

  drag(h.card("a"), [[340, 20], [330, 20], [180, 20]]);
  expect(h.open("a")).toBe("true");
  flushSync(() => { h.container.dispatchEvent(new dom.Event("scroll") as unknown as Event); });
  expect(h.open("a")).toBeNull();
});

test("a held press opens the actions sheet and its lift opens nothing; moving first cancels it", async () => {
  const h = setup();
  const card = h.card("a");
  fire(card, "pointerdown", 200, 20);
  await sleep(LONG_PRESS_MS + 60);
  /* The browser's own long-press menu never shows over the sheet. */
  const menu = new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  flushSync(() => { card.dispatchEvent(menu as unknown as Event); });
  expect(menu.defaultPrevented).toBe(true);
  fire(card, "pointerup", 200, 20);
  flushSync(() => card.click());
  expect(h.presses).toEqual(["a"]);
  expect(h.taps).toEqual([]);

  fire(card, "pointerdown", 200, 20);
  fire(card, "pointermove", 200, 32);
  await sleep(LONG_PRESS_MS + 60);
  fire(card, "pointerup", 200, 32);
  expect(h.presses).toEqual(["a"]);
});

test("focus on a tray button slides the card aside, Escape puts it back on the card, and every button names its effect", () => {
  const h = setup();
  const tray = h.el('[data-mobile2-swipe-row="a"] [data-mobile2-swipe-tray]');
  expect(tray.getAttribute("aria-label")).toBe(translate("en", "mobile2.board.rowActions", { title: "Row a" }));
  /* In the document while the card covers it: transparent and reachable. */
  expect(tray.className).not.toMatch(/\b(hidden|invisible)\b/);
  const buttons = Array.from(tray.querySelectorAll("[data-mobile2-swipe-action]")) as unknown as HTMLElement[];
  expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Hide from board. The lane stays as it is.",
    "Close lane. Stops its agents.",
  ]);
  expect(buttons.every((button) => button.tagName === "BUTTON" && button.className.includes("min-h-11"))).toBe(true);

  flushSync(() => buttons[0]!.focus());
  expect(h.open("a")).toBe("true");
  flushSync(() => {
    buttons[0]!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  });
  expect(h.open("a")).toBeNull();
  expect(dom.document.activeElement as unknown).toBe(h.card("a"));
});

test("a row that leaves the list takes its open tray with it", () => {
  const h = setup();
  drag(h.card("a"), [[340, 20], [330, 20], [180, 20]]);
  expect(h.store.getState()).toBe("a");
  flushSync(() => h.root.render(<></>));
  expect(h.store.getState()).toBeNull();
});
