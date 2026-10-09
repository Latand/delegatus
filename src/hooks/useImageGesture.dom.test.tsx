import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/*
 * The hand on a picture, through the fullscreen viewer that uses it. A right
 * click on a zoomed picture used to start a pan nothing ended: the browser's
 * menu takes the release, so the picture followed the cursor from then on.
 * happy-dom lays nothing out, so every point is read from the frame's corner
 * and no pan is clamped; the browser driver measures the rest.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  KeyboardEvent: dom.KeyboardEvent,
  ResizeObserver: dom.ResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const HAD: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
for (const key of Object.keys(OVERRIDES)) { HAD[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }

const { Lightbox } = await import("@/components/feed/Lightbox");
const { translate } = await import("@/lib/i18n");

let root: Root | null = null;
let host: HTMLElement | null = null;
let captures = 0;
const elementProto = dom.HTMLElement.prototype as unknown as { setPointerCapture: (id: number) => void };
const realCapture = elementProto.setPointerCapture;
elementProto.setPointerCapture = () => { captures += 1; };

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  captures = 0;
});

afterAll(() => {
  elementProto.setPointerCapture = realCapture;
  for (const key of Object.keys(OVERRIDES)) {
    if (HAD[key]) G[key] = SAVED[key];
    else delete G[key];
  }
});

function open(): { closed: () => number } {
  let closed = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Lightbox src="/pixel.png" alt="a screenshot" onClose={() => { closed += 1; }} />));
  return { closed: () => closed };
}

const picture = () => document.querySelector<HTMLImageElement>("[role='dialog'] img")!;
function view(): { tx: number; ty: number; scale: number } {
  const [, tx, ty, scale] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)/.exec(picture().style.transform)!;
  return { tx: Number(tx), ty: Number(ty), scale: Number(scale) };
}
function pointer(type: string, x: number, y: number, init: Record<string, unknown> = {}) {
  act(() => {
    picture().dispatchEvent(new dom.PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: x, clientY: y, ...init,
    }) as unknown as Event);
  });
}
function zoomIn() {
  act(() => document.querySelector<HTMLButtonElement>(`button[aria-label="${translate("en", "lightbox.zoomIn")}"]`)!.click());
}

test("a right click, a middle click and a modified click never pan and never capture", () => {
  open();
  zoomIn();
  const start = view();
  expect(start.scale).toBeGreaterThan(1);
  const presses = [
    { button: 2, buttons: 2 },
    { button: 1, buttons: 4 },
    { button: 0, buttons: 1, ctrlKey: true },
    { button: 0, buttons: 1, metaKey: true },
    { button: 0, buttons: 1, shiftKey: true },
    { button: 0, buttons: 1, altKey: true },
  ];
  for (const press of presses) {
    pointer("pointerdown", 100, 100, press);
    /* The menu took the release; the pointer comes back with no button held. */
    pointer("pointermove", 260, 190, { buttons: 0 });
    pointer("pointermove", 300, 240, { buttons: press.buttons });
    expect(view()).toEqual(start);
  }
  expect(captures).toBe(0);
});

test("the primary button pans a zoomed picture and the release ends it", () => {
  open();
  zoomIn();
  const start = view();
  pointer("pointerdown", 100, 100);
  expect(captures).toBe(1);
  pointer("pointermove", 130, 80);
  expect(view()).toEqual({ ...start, tx: start.tx + 30, ty: start.ty - 20 });
  pointer("pointerup", 130, 80, { buttons: 0 });
  pointer("pointermove", 400, 400, { buttons: 0 });
  expect(view()).toEqual({ ...start, tx: start.tx + 30, ty: start.ty - 20 });
});

test("a cancel, a lost capture and the window losing focus each end a pan", () => {
  open();
  zoomIn();
  for (const end of ["pointercancel", "lostpointercapture", "blur"]) {
    const start = view();
    pointer("pointerdown", 100, 100);
    pointer("pointermove", 110, 100);
    if (end === "blur") act(() => { dom.dispatchEvent(new dom.Event("blur")); });
    else pointer(end, 110, 100);
    /* The button is still down as far as the next event says. */
    pointer("pointermove", 300, 300);
    expect(view()).toEqual({ ...start, tx: start.tx + 10 });
  }
});

test("a mouse that moves with no button held is no longer panning", () => {
  open();
  zoomIn();
  const start = view();
  pointer("pointerdown", 100, 100);
  pointer("pointermove", 120, 100);
  pointer("pointermove", 300, 300, { buttons: 0 });
  pointer("pointermove", 500, 500);
  expect(view()).toEqual({ ...start, tx: start.tx + 20 });
});

test("a mouse press at fit moves nothing", () => {
  open();
  pointer("pointerdown", 100, 100);
  pointer("pointermove", 200, 160);
  expect(view()).toEqual({ tx: 0, ty: 0, scale: 1 });
  expect(captures).toBe(0);
});

test("two fingers zoom, a finger landing or lifting moves nothing, and a later touch starts clean", () => {
  open();
  const finger = (type: string, id: number, x: number, y: number) => pointer(type, x, y, { pointerId: id, pointerType: "touch", buttons: type === "pointerup" ? 0 : 1 });
  finger("pointerdown", 1, -40, 0);
  finger("pointerdown", 2, 40, 0);
  expect(view()).toEqual({ tx: 0, ty: 0, scale: 1 });
  finger("pointermove", 1, -80, 0);
  finger("pointermove", 2, 80, 0);
  expect(view()).toEqual({ tx: 0, ty: 0, scale: 2 });
  finger("pointerup", 2, 80, 0);
  expect(view()).toEqual({ tx: 0, ty: 0, scale: 2 });
  finger("pointermove", 1, -70, 15);
  expect(view()).toEqual({ tx: 10, ty: 15, scale: 2 });
  finger("pointerup", 1, -70, 15);
  /* Somewhere else entirely: the picture does not come to the finger. */
  finger("pointerdown", 3, 150, -120);
  expect(view()).toEqual({ tx: 10, ty: 15, scale: 2 });
  finger("pointermove", 3, 153, -120);
  expect(view()).toEqual({ tx: 13, ty: 15, scale: 2 });
  finger("pointerup", 3, 153, -120);
  expect(captures).toBe(0);
});

test("at fit one finger steps nowhere in a lone picture and closes on a drag down", () => {
  const viewer = open();
  const finger = (type: string, x: number, y: number, at: number) => pointer(type, x, y, { pointerType: "touch", buttons: type === "pointerup" ? 0 : 1, timeStamp: at });
  finger("pointerdown", 100, 100, 0);
  finger("pointermove", 20, 104, 50);
  expect(view()).toEqual({ tx: -80, ty: 0, scale: 1 });
  finger("pointerup", 20, 104, 100);
  expect(view()).toEqual({ tx: 0, ty: 0, scale: 1 });
  expect(viewer.closed()).toBe(0);
  finger("pointerdown", 100, 100, 1000);
  finger("pointermove", 104, 230, 1050);
  finger("pointerup", 104, 230, 1100);
  expect(viewer.closed()).toBe(1);
});
