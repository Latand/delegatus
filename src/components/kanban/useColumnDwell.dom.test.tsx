import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { TaskStatus } from "@/lib/tasks/types";

import { DWELL_CUE_MS, DWELL_JITTER_PX, DWELL_MS, useColumnDwell, type ColumnDwellOptions } from "./useColumnDwell";

/* The dwell hook over a bare board of columns, under fake timers. Only the
   hook is exercised; the board's own wiring is covered in KanbanBoard.dom. */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent,
});

const roots: Root[] = [];
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  jest.advanceTimersByTime(50);
  jest.useRealTimers();
});

function Board({ options }: { options: ColumnDwellOptions }) {
  const ref = useRef<HTMLDivElement>(null);
  useColumnDwell(ref, options);
  return (
    <div ref={ref} className="kb">
      <aside className="rail">rail</aside>
      {(["inbox", "assigned", "blocked", "done"] as const).map((status) => (
        <section key={status} className="column" data-status={status}>
          <div className="col-head"><button type="button" data-col-width={status}>widen</button></div>
          <div className="col-body"><article className="card">{status} card</article></div>
        </section>
      ))}
    </div>
  );
}

function mount(overrides: Partial<ColumnDwellOptions> = {}) {
  const widened: TaskStatus[] = [];
  const state = { busy: false, wide: "assigned" as TaskStatus, pinned: false };
  const options: ColumnDwellOptions = {
    enabled: true,
    canWiden: (status) => !state.pinned && status !== state.wide,
    busy: () => state.busy,
    widen: (status) => {
      widened.push(status);
      state.wide = status;
    },
    ...overrides,
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(<Board options={options} />));
  return { host, widened, state };
}

const column = (host: HTMLElement, status: TaskStatus) => host.querySelector<HTMLElement>(`.column[data-status="${status}"]`)!;
const inside = (host: HTMLElement, status: TaskStatus) => column(host, status).querySelector<HTMLElement>(".card")!;
const cued = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".column[data-dwell]")].map((node) => node.dataset.status);

function pointer(target: Element, type: string, x: number, y: number, extra: { pointerType?: string; buttons?: number } = {}) {
  target.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: extra.pointerType ?? "mouse", buttons: extra.buttons ?? 0 }) as unknown as Event);
}
const move = (target: Element, x: number, y: number, extra?: { pointerType?: string; buttons?: number }) => pointer(target, "pointermove", x, y, extra);
const wait = (ms: number) => jest.advanceTimersByTime(ms);

test("the thresholds are the ones the pull request states", () => {
  expect(DWELL_MS).toBe(1300);
  expect(DWELL_CUE_MS).toBe(350);
  expect(DWELL_JITTER_PX).toBe(8);
});

test("resting in a narrow column shows the cue after the grace and widens it at the threshold", () => {
  const { host, widened } = mount();
  move(inside(host, "done"), 500, 300);
  wait(DWELL_CUE_MS - 10);
  expect(cued(host)).toEqual([]);
  wait(10);
  expect(cued(host)).toEqual(["done"]);
  /* The sweep lasts exactly what is left of the dwell. */
  expect(column(host, "done").style.getPropertyValue("--kb-dwell")).toBe(`${DWELL_MS - DWELL_CUE_MS}ms`);
  wait(DWELL_MS - DWELL_CUE_MS - 1);
  expect(widened).toEqual([]);
  wait(1);
  expect(widened).toEqual(["done"]);
  expect(cued(host)).toEqual([]);
  expect(column(host, "done").style.getPropertyValue("--kb-dwell")).toBe("");
});

test("drift within the jitter tolerance keeps the count; a move past it restarts it and drops the cue", () => {
  const { host, widened } = mount();
  const card = inside(host, "blocked");
  move(card, 400, 300);
  wait(800);
  move(card, 400 + 5, 300 + 5);
  expect(cued(host)).toEqual(["blocked"]);
  wait(DWELL_MS - 800 - 100);
  /* A real move 100 ms before the threshold: the cue goes and the count starts over. */
  move(card, 400 + DWELL_JITTER_PX + 4, 300);
  expect(cued(host)).toEqual([]);
  wait(200);
  expect(widened).toEqual([]);
  wait(DWELL_MS - 200);
  expect(widened).toEqual(["blocked"]);
});

test("leaving the column cancels, into another column or off the board", () => {
  const { host, widened } = mount();
  move(inside(host, "inbox"), 100, 300);
  wait(600);
  expect(cued(host)).toEqual(["inbox"]);
  move(host.querySelector(".rail")!, 20, 300);
  expect(cued(host)).toEqual([]);
  wait(DWELL_MS * 2);
  expect(widened).toEqual([]);

  move(inside(host, "inbox"), 100, 300);
  wait(600);
  pointer(host.querySelector(".kb")!, "pointerleave", 0, 0);
  expect(cued(host)).toEqual([]);
  wait(DWELL_MS * 2);
  expect(widened).toEqual([]);

  /* Moving on into a narrow neighbour counts afresh there. */
  move(inside(host, "inbox"), 100, 300);
  wait(600);
  move(inside(host, "done"), 900, 300);
  wait(DWELL_MS - 1);
  expect(widened).toEqual([]);
  wait(1);
  expect(widened).toEqual(["done"]);
});

test("the wide column and a pinned board never count; nor does a column that stops being narrow mid-count", () => {
  const { host, widened, state } = mount();
  move(inside(host, "assigned"), 300, 300);
  wait(DWELL_MS * 2);
  expect(cued(host)).toEqual([]);
  expect(widened).toEqual([]);

  state.pinned = true;
  move(inside(host, "done"), 900, 300);
  wait(DWELL_MS * 2);
  expect(cued(host)).toEqual([]);
  expect(widened).toEqual([]);

  state.pinned = false;
  move(inside(host, "done"), 910, 300);
  wait(600);
  expect(cued(host)).toEqual(["done"]);
  /* Widened some other way while the cue shows: the count ends without a second widen. */
  state.wide = "done";
  wait(DWELL_MS);
  expect(widened).toEqual([]);
  expect(cued(host)).toEqual([]);
});

test("a drag, a menu, a dialog or a selection suppresses it, and a cue already showing goes", () => {
  const { host, widened, state } = mount();
  const card = inside(host, "done");
  /* A drag: the button is held while the pointer moves. */
  move(card, 900, 300, { buttons: 1 });
  wait(DWELL_MS * 2);
  expect(cued(host)).toEqual([]);

  /* A menu the board holds open. */
  state.busy = true;
  move(card, 920, 300);
  wait(DWELL_MS * 2);
  expect(cued(host)).toEqual([]);
  state.busy = false;

  /* Opened while the count runs: nothing widens at the threshold. */
  move(card, 940, 300);
  wait(600);
  expect(cued(host)).toEqual(["done"]);
  state.busy = true;
  wait(DWELL_MS);
  expect(cued(host)).toEqual([]);
  state.busy = false;

  /* A modal dialog anywhere in the document. */
  const dialog = document.createElement("div");
  dialog.setAttribute("aria-modal", "true");
  document.body.appendChild(dialog);
  move(card, 960, 300);
  wait(DWELL_MS * 2);
  dialog.remove();

  /* Text selected on the card. */
  const range = document.createRange();
  range.selectNodeContents(card);
  document.getSelection()!.addRange(range);
  move(card, 980, 300);
  wait(DWELL_MS * 2);
  document.getSelection()!.removeAllRanges();
  expect(widened).toEqual([]);

  move(card, 1000, 300);
  wait(DWELL_MS);
  expect(widened).toEqual(["done"]);
});

test("a menu, popover or listbox portalled to the document suppresses it, one opened mid-count included", () => {
  const { host, widened } = mount();
  const card = inside(host, "done");
  /* The shapes a reader's composer opens on the body: the model, mic, account
     and speak menus, the runtime popover, a listbox, a non-modal popover
     floating fixed over the page. */
  const overlays: Array<[string, string, string?]> = [["role", "menu"], ["role", "listbox"], ["data-runtime-popover", ""], ["role", "dialog", "position: fixed"]];
  let x = 900;
  for (const [name, value, style] of overlays) {
    const overlay = document.createElement("div");
    overlay.setAttribute(name, value);
    if (style) overlay.setAttribute("style", style);
    document.body.appendChild(overlay);
    move(card, (x += 20), 300);
    wait(DWELL_MS * 2);
    expect(cued(host)).toEqual([]);
    expect(widened).toEqual([]);
    overlay.remove();
  }

  /* Opened while the count runs: the cue goes and nothing widens at the threshold. */
  move(card, (x += 20), 300);
  wait(600);
  expect(cued(host)).toEqual(["done"]);
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  document.body.appendChild(menu);
  wait(DWELL_MS);
  expect(cued(host)).toEqual([]);
  menu.remove();
  expect(widened).toEqual([]);

  move(card, (x += 20), 300);
  wait(DWELL_MS);
  expect(widened).toEqual(["done"]);
});

test("a non-modal dialog holds it only while it floats; an inline disclosure with the role does not", () => {
  const { host, widened } = mount();
  const card = inside(host, "done");
  /* A popover positioned by its wrapper, the way a portalled one sits. */
  const wrapper = document.createElement("div");
  wrapper.setAttribute("style", "position: absolute; top: 40px; left: 40px");
  const popover = document.createElement("div");
  popover.setAttribute("role", "dialog");
  wrapper.appendChild(popover);
  document.body.appendChild(wrapper);
  move(card, 900, 300);
  wait(DWELL_MS * 2);
  expect(widened).toEqual([]);
  wrapper.remove();

  /* The rail's Copilot accounts panel: role="dialog", open, in the flow. */
  const footer = document.createElement("div");
  footer.setAttribute("style", "position: relative");
  const disclosure = document.createElement("div");
  disclosure.setAttribute("role", "dialog");
  footer.appendChild(disclosure);
  host.querySelector(".rail")!.appendChild(footer);
  move(card, 920, 300);
  wait(DWELL_CUE_MS);
  expect(cued(host)).toEqual(["done"]);
  wait(DWELL_MS - DWELL_CUE_MS);
  expect(widened).toEqual(["done"]);
});

test("a pointer move never scans the document; only the dwell's timers do", () => {
  const { host, widened } = mount();
  const doc = document as unknown as Record<"querySelector" | "querySelectorAll" | "getSelection", (...args: unknown[]) => unknown>;
  const scans: string[] = [];
  const originals = { querySelector: doc.querySelector, querySelectorAll: doc.querySelectorAll, getSelection: doc.getSelection };
  for (const name of Object.keys(originals) as Array<keyof typeof originals>) {
    doc[name] = function (this: unknown, ...args: unknown[]) {
      scans.push(name);
      return originals[name].apply(this, args);
    };
  }
  try {
    /* A mouse sweeping across narrow columns, each move past the jitter. */
    for (let step = 0; step < 60; step++) move(inside(host, step % 2 ? "done" : "blocked"), 400 + step * 20, 300);
    expect(scans).toEqual([]);
    /* Resting: one look when the cue would show and one at the threshold. */
    wait(DWELL_CUE_MS);
    const atCue = scans.length;
    expect(atCue).toBeGreaterThan(0);
    wait(DWELL_MS - DWELL_CUE_MS);
    expect(scans.length).toBeGreaterThan(atCue);
    expect(widened).toEqual(["done"]);
  } finally {
    Object.assign(doc, originals);
  }
});

test("a press cancels and holds the column until the pointer leaves it; a key or a scroll restarts the count", () => {
  const { host, widened } = mount();
  const card = inside(host, "blocked");
  move(card, 600, 300);
  wait(600);
  pointer(column(host, "blocked").querySelector("button")!, "pointerdown", 600, 300);
  expect(cued(host)).toEqual([]);
  move(card, 640, 320);
  wait(DWELL_MS * 2);
  expect(widened).toEqual([]);
  /* Out and back in: it counts again. */
  move(host.querySelector(".rail")!, 20, 300);
  move(card, 600, 300);
  wait(DWELL_MS - 100);
  /* A key: the count stops until the pointer moves again. */
  document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "a", bubbles: true }) as unknown as Event);
  wait(DWELL_MS * 2);
  expect(widened).toEqual([]);
  move(card, 601, 300);
  wait(DWELL_MS - 100);
  /* A wheel over the column: reading it, so the count starts over. */
  card.dispatchEvent(new dom.WheelEvent("wheel", { bubbles: true, deltaY: 40 }) as unknown as Event);
  wait(200);
  expect(widened).toEqual([]);
  wait(DWELL_MS - 200);
  expect(widened).toEqual(["blocked"]);
});

test("touch and pen never count, and a disabled board (tabs, the Overview) never listens", () => {
  const { host, widened } = mount();
  move(inside(host, "done"), 900, 300, { pointerType: "touch" });
  wait(DWELL_MS * 2);
  move(inside(host, "done"), 900, 300, { pointerType: "pen" });
  wait(DWELL_MS * 2);
  expect(widened).toEqual([]);

  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  const off = mount({ enabled: false });
  move(inside(off.host, "done"), 900, 300);
  wait(DWELL_MS * 2);
  expect(cued(off.host)).toEqual([]);
  expect(off.widened).toEqual([]);
});
