import { afterEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";

import { COLUMN_LAYOUT_MS, installColumnLayoutAnimation } from "./columnLayoutAnimation";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: dom, document: dom.document });
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  jest.useRealTimers();
});

function mount(reduce = false) {
  const root = document.createElement("div");
  root.className = "kb";
  root.innerHTML = '<div class="board"><section class="column" data-status="done" data-wide="0"><div class="col-head">Done</div><div class="col-body"><article class="card" data-id="task:sample"><button id="sample">A title that wraps</button></article></div></section></div>';
  document.body.append(root);
  const column = root.querySelector<HTMLElement>(".column")!;
  const card = root.querySelector<HTMLElement>(".card")!;
  const body = root.querySelector<HTMLElement>(".col-body")!;
  const calls: { node: HTMLElement; frames: Keyframe[]; timing: KeyframeAnimationOptions; cancelled: boolean }[] = [];
  Object.defineProperty(dom, "matchMedia", { configurable: true, value: () => ({ matches: reduce, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(dom.HTMLElement.prototype, "animate", { configurable: true, value(this: HTMLElement, frames: Keyframe[], timing: KeyframeAnimationOptions) {
    const call = { node: this, frames, timing, cancelled: false }; calls.push(call);
    return { cancel() { call.cancelled = true; }, pause() {}, play() {} };
  } });
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() {} }) as DOMRect;
  column.getBoundingClientRect = () => rect(column.dataset.wide === "0" ? 800 : 600, 100, column.dataset.wide === "0" ? 220 : 420, 600);
  card.getBoundingClientRect = () => rect(column.dataset.wide === "0" ? 812 : 612, 160, column.dataset.wide === "0" ? 196 : 396, column.dataset.wide === "0" ? 180 : 120);
  body.getBoundingClientRect = () => rect(600, 150, 420, 550);
  const layout = installColumnLayoutAnimation(root);
  disposers.push(layout.dispose);
  return { root, column, card, body, calls, layout };
}

const mutations = () => new Promise<void>((resolve) => dom.setTimeout(resolve, 0));

test("width changes FLIP cards and frozen wrapping, preserve scroll, then remove every copy", async () => {
  const { root, column, card, body, calls, layout } = mount();
  body.scrollTop = 75;
  layout.prepare();
  column.dataset.wide = "1";
  body.scrollTop = 95;
  await mutations();
  expect(body.scrollTop).toBe(75);
  const live = calls.find((call) => call.node === card)!;
  expect(live.frames[0]!.transform).toBe("translate(200px, 0px) scale(0.494949494949495, 1.5)");
  expect(live.frames[1]!.transform).toBe("none");
  expect(live.timing.duration).toBe(COLUMN_LAYOUT_MS);
  expect(calls.some((call) => call.node.classList.contains("kb-layout-frame"))).toBe(true);
  const copy = root.querySelector<HTMLElement>(".card.kb-layout-copy")!;
  expect(copy.style.width).toBe("196px");
  expect(copy.getAttribute("aria-hidden")).toBe("true");
  expect(copy.inert).toBe(true);
  expect(copy.querySelector("[id]")).toBeNull();
  const textLayers = calls.filter((call) => call.node.classList.contains("card") && call.node.classList.contains("kb-layout-copy") && !call.node.classList.contains("kb-layout-shell"));
  expect(textLayers).toHaveLength(2);
  expect(textLayers.every((call) => call.frames.every((frame) => !String(frame.transform).includes("scale")))).toBe(true);
  await new Promise((resolve) => dom.setTimeout(resolve, COLUMN_LAYOUT_MS + 80));
  expect(root.querySelector(".kb-layout-copy")).toBeNull();
  expect(card.hasAttribute("data-layout-animating")).toBe(false);
  expect(calls.every((call) => call.cancelled)).toBe(true);
});

test("reduced motion does not capture or animate and disposal leaves no pixels", async () => {
  const { root, column, card, calls, layout } = mount(true);
  card.getBoundingClientRect = () => { throw new Error("reduced motion measured a card"); };
  layout.prepare();
  column.dataset.wide = "1";
  await mutations();
  expect(calls).toHaveLength(0);
  expect(root.querySelector(".kb-layout-copy")).toBeNull();
  layout.dispose();
});

test("an unrelated render does not animate; interrupted motion cleans up immediately", async () => {
  const { root, column, calls, layout } = mount();
  layout.prepare();
  column.setAttribute("data-dwell", "");
  await mutations();
  expect(calls).toHaveLength(0);
  column.dataset.wide = "1";
  await mutations();
  expect(calls.length).toBeGreaterThan(0);
  root.dispatchEvent(new dom.WheelEvent("wheel") as unknown as Event);
  expect(root.querySelector(".kb-layout-copy")).toBeNull();
  expect(calls.every((call) => call.cancelled)).toBe(true);
});

test("actual column and ancestor scroll interrupts copies; restored scroll does not", async () => {
  for (const container of ["body", "outside", "page"]) {
    const { root, column, body, calls, layout } = mount();
    const page = document.createElement("div");
    page.className = "kb-page";
    page.append(root.querySelector(".board")!);
    root.append(page);
    body.scrollTop = 75;
    layout.prepare();
    column.dataset.wide = "1";
    body.scrollTop = 95;
    await mutations();
    // Browsers deliver the helper's own restoration as a later scroll event.
    body.dispatchEvent(new dom.Event("scroll") as unknown as Event);
    expect(root.querySelector(".kb-layout-copy")).not.toBeNull();
    const scroller = container === "outside" ? document.body : container === "page" ? page : body;
    scroller.scrollTop += 80;
    scroller.dispatchEvent(new dom.Event("scroll") as unknown as Event);
    expect(root.querySelector(".kb-layout-copy") === null).toBe(true);
    expect(calls.every((call) => call.cancelled)).toBe(true);
    layout.dispose();
    root.remove();
  }
});

test("preparing a control that keeps the width does not freeze an active transition", async () => {
  const { root, column, layout } = mount();
  layout.prepare();
  column.dataset.wide = "1";
  await mutations();
  layout.prepare();
  await new Promise((resolve) => dom.setTimeout(resolve, COLUMN_LAYOUT_MS + 80));
  expect(root.querySelector(".kb-layout-copy") === null).toBe(true);
});
