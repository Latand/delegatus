import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";

import { hostedColumnInset, hostedWindowInset, setHostedSheetLeft } from "../shellLayout";
import { AgentWindow } from "./AgentWindow";

installActEnv();

/* The agent window publishes where its conversation column starts, which is
   the edge the document preview measures its conversation floor from. */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});

let column = 228;
const windowEdge = 8;
const columnRight = 992;
const observers: Array<() => void> = [];
class TestResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe() {
    observers.push(this.callback);
  }
  unobserve() {}
  disconnect() {
    observers.splice(0, observers.length, ...observers.filter((callback) => callback !== this.callback));
  }
}
(globalThis as { ResizeObserver: unknown }).ResizeObserver = TestResizeObserver;
/* happy-dom lays nothing out: the reader column stands where the geometry puts it. */
const proto = dom.HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect };
const original = proto.getBoundingClientRect;
proto.getBoundingClientRect = function (this: HTMLElement) {
  const reader = this.classList.contains("aw-reader");
  const left = reader ? column : this.classList.contains("agent-window") ? windowEdge : 0;
  const right = reader ? columnRight : left;
  return { left, right, top: 0, bottom: 0, width: right - left, height: 0, x: left, y: 0, toJSON() {} } as DOMRect;
};

let root: Root | null = null;

afterAll(() => {
  proto.getBoundingClientRect = original;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  dom.document.body.replaceChildren();
});

async function mount(): Promise<void> {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root!.render(
      <AgentWindow agents={[]} current={null} pending={false} onJump={() => {}} onStep={() => {}} onClose={() => {}} onCloseAll={() => {}} onLeave={() => {}}>
        <span />
      </AgentWindow>,
    );
  });
}

test("the window publishes the left edge of its conversation column and withdraws it on close", async () => {
  expect(hostedColumnInset()).toBe(0);
  await mount();
  expect(hostedColumnInset()).toBe(228);
  /* The window's own edge goes with it: where the sheet takes the column whole, the list gives way. */
  expect(hostedWindowInset()).toBe(8);

  /* A resize that moves the column (the list narrows below 1200 px) is followed. */
  column = 256;
  await act(async () => {
    for (const callback of [...observers]) callback();
  });
  expect(hostedColumnInset()).toBe(256);
  column = 228;
  await act(async () => {
    dom.dispatchEvent(new dom.Event("resize") as never);
  });
  expect(hostedColumnInset()).toBe(228);

  await act(async () => root!.unmount());
  root = null;
  expect(hostedColumnInset()).toBe(0);
  expect(hostedWindowInset()).toBe(0);
});

test("the conversation wraps at the edge of a sheet standing over the right of the column", async () => {
  const slotInset = () => (dom.document.querySelector(".aw-reader") as unknown as HTMLElement).style.getPropertyValue("--aw-sheet-inset");
  await mount();
  expect(slotInset()).toBe("");

  /* A sheet 452 px wide at a 1000 px viewport leaves the column its right 192 px to give up. */
  await act(async () => setHostedSheetLeft(800));
  expect(slotInset()).toBe("192px");
  expect(dom.document.querySelector(".aw-reader")!.hasAttribute("data-sheet-covered")).toBe(true);
  /* The sheet widens or narrows: the inset follows its edge. */
  await act(async () => setHostedSheetLeft(560));
  expect(slotInset()).toBe("432px");
  /* A sheet that took the whole column leaves it laid out as it was. */
  await act(async () => setHostedSheetLeft(8));
  expect(slotInset()).toBe("");
  await act(async () => setHostedSheetLeft(0));
  expect(slotInset()).toBe("");
  expect(dom.document.querySelector(".aw-reader")!.hasAttribute("data-sheet-covered")).toBe(false);
});
