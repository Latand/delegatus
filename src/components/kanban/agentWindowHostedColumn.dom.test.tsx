import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";

import { hostedColumnInset } from "../shellLayout";
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
  const left = this.classList.contains("aw-reader") ? column : 0;
  return { left, right: left, top: 0, bottom: 0, width: 0, height: 0, x: left, y: 0, toJSON() {} } as DOMRect;
};

let root: Root | null = null;

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
  proto.getBoundingClientRect = original;
});
