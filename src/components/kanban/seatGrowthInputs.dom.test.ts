import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { observeSeatGrowthInputs } from "./seatGrowthInputs";

test("decoration and streaming text leave seat geometry alone while a replaced or resized form row is measured", async () => {
  const view = new Window();
  const originalResize = globalThis.ResizeObserver, originalMutation = globalThis.MutationObserver;
  const watched = new Set<Element>();
  let deliver = () => {}, calls = 0;
  class Sizes {
    constructor(callback: () => void) { deliver = callback; }
    observe(el: Element) { watched.add(el); }
    unobserve(el: Element) { watched.delete(el); }
    disconnect() { watched.clear(); }
  }
  Object.assign(globalThis, { ResizeObserver: Sizes, MutationObserver: view.MutationObserver });
  const seat = view.document.createElement("section");
  seat.innerHTML = '<div data-orchestrator-conversation><header></header><div data-composer-yields></div><form><div></div></form></div>';
  view.document.body.appendChild(seat);
  const stop = observeSeatGrowthInputs(seat as unknown as HTMLElement, () => { calls++; });
  try {
    const form = seat.querySelector("form")!, old = form.firstElementChild!;
    seat.querySelector("header")!.style.setProperty("--test-decoration", "1");
    seat.querySelector("header")!.appendChild(view.document.createElement("span"));
    seat.querySelector("[data-composer-yields]")!.textContent = "streamed text";
    await view.happyDOM.whenAsyncComplete();
    expect(calls).toBe(0);
    const next = view.document.createElement("div");
    old.replaceWith(next);
    await view.happyDOM.whenAsyncComplete();
    expect(calls).toBe(1);
    expect(watched.has(next as unknown as Element)).toBe(true);
    expect(watched.has(old as unknown as Element)).toBe(false);
    deliver();
    expect(calls).toBe(2);
  } finally {
    stop();
    Object.assign(globalThis, { ResizeObserver:originalResize, MutationObserver:originalMutation });
    await view.happyDOM.close();
  }
  expect(watched.size).toBe(0);
});

test("the observer fallback ignores unrelated decoration and follows changes inside the form", async () => {
  const view = new Window();
  const previous = { ResizeObserver:globalThis.ResizeObserver, MutationObserver:globalThis.MutationObserver };
  Object.assign(globalThis,{ ResizeObserver:undefined, MutationObserver:view.MutationObserver });
  const seat = view.document.createElement("section");
  seat.innerHTML = '<div data-orchestrator-conversation><header></header><form><div></div></form></div>';
  view.document.body.appendChild(seat);
  let calls = 0;
  const stop = observeSeatGrowthInputs(seat as unknown as HTMLElement,() => { calls++; });
  try {
    seat.querySelector("header")!.style.setProperty("--decoration","1");
    await view.happyDOM.whenAsyncComplete();
    expect(calls).toBe(0);
    seat.querySelector("form div")!.textContent = "A new row label";
    await view.happyDOM.whenAsyncComplete();
    expect(calls).toBe(1);
  } finally { stop(); Object.assign(globalThis,previous); await view.happyDOM.close(); }
});
