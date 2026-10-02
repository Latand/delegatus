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
  root.querySelector<HTMLElement>(".board")!.style.gridTemplateColumns = "220px 220px 220px 420px";
  const width = () => parseFloat(column.style.width) || (column.dataset.wide === "0" ? 220 : 420);
  column.getBoundingClientRect = () => rect(column.dataset.wide === "0" ? 800 : 600, 100, width(), 600);
  card.getBoundingClientRect = () => rect(column.dataset.wide === "0" ? 812 : 612, 160, width() - 24, width() < 300 ? 180 : 120);
  body.getBoundingClientRect = () => rect(600, 150, 420, 550);
  const layout = installColumnLayoutAnimation(root);
  disposers.push(layout.dispose);
  return { root, column, card, body, calls, layout };
}

const mutations = () => new Promise<void>((resolve) => dom.setTimeout(resolve, 25));

test("width changes FLIP real columns and cards, preserve scroll, then release promotion", async () => {
  const { root, column, card, body, calls, layout } = mount();
  body.scrollTop = 75;
  layout.prepare();
  column.dataset.wide = "1";
  body.scrollTop = 95;
  await mutations();
  expect(body.scrollTop).toBe(95);
  // The old wrapping remains while the column wrapper changes its share.
  expect(column.style.width).toBe("220px");
  expect(card.getBoundingClientRect().height).toBe(180);
  const frame = calls.find((call) => call.node === column)!;
  expect(frame.frames[0]!.transform).toBe("translate(200px, 0px) scale(1, 1)");
  expect(frame.frames[1]!.transform).toBe("translate(0px, 0px) scale(1.9090909090909092, 1)");
  expect(frame.timing.duration).toBe(COLUMN_LAYOUT_MS);
  const content = calls.find((call) => call.node.id === "sample")!;
  expect(content.frames[0]!.opacity).toBe(1);
  expect(content.frames.at(-1)!.opacity).toBe(0);
  expect(root.querySelector(".kb-layout-copy")).toBeNull();
  expect(root.querySelectorAll("#sample")).toHaveLength(1);
  expect(root.dataset.columnLayout).toBe("running");
  await new Promise((resolve) => dom.setTimeout(resolve, COLUMN_LAYOUT_MS + 80));
  expect(root.querySelector(".kb-layout-copy")).toBeNull();
  expect(column.style.width).toBe("");
  expect(card.getBoundingClientRect().height).toBe(120);
  expect(root.hasAttribute("data-column-layout")).toBe(false);
  expect(root.querySelector("[data-layout-animating]")).toBeNull();
  expect(calls.some((call) => call.node === card)).toBe(true);
  expect(calls.filter((call) => call.node.id === "sample").at(-1)!.frames.at(-1)!.opacity).toBe(1);
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
  layout.prepare();
  column.dataset.wide = "1";
  await mutations();
  expect(calls.length).toBeGreaterThan(0);
  root.dispatchEvent(new dom.WheelEvent("wheel") as unknown as Event);
  expect(root.querySelector(".kb-layout-copy")).toBeNull();
  expect(calls.every((call) => call.cancelled)).toBe(true);
});

test("actual column and ancestor scroll interrupts motion; restored scroll does not", async () => {
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
    expect(root.dataset.columnLayout).toBe("running");
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

test("destination reads finish before any inverse write, and no DOM is cloned", async () => {
  const { column, card, calls, layout } = mount();
  const read = card.getBoundingClientRect.bind(card);
  let destinationReads = 0;
  card.getBoundingClientRect = () => {
    if (column.dataset.wide === "1") {
      expect(calls).toHaveLength(0);
      destinationReads++;
    }
    return read();
  };
  card.cloneNode = () => { throw new Error("width transitions must use real elements"); };
  layout.prepare();
  column.dataset.wide = "1";
  await mutations();
  expect(destinationReads).toBe(1);
  expect(calls.length).toBeGreaterThan(0);
});

test("a card brought into view by wrapping slides and fades from its clipped position", async () => {
  const { root, column, card, calls, layout } = mount();
  const original = card.getBoundingClientRect.bind(card);
  card.getBoundingClientRect = () => {
    const box = original();
    const top = box.width < 300 ? 900 : 600;
    return new dom.DOMRect(box.left, top, box.width, box.height) as unknown as DOMRect;
  };
  layout.prepare();
  column.dataset.wide = "1";
  await mutations();
  await new Promise((resolve) => dom.setTimeout(resolve, 120));
  const entering = calls.find((call) => call.node === card)!;
  expect(entering.frames[0]!.opacity).toBe(0);
  expect(entering.frames[1]!.opacity).toBe(1);
  expect(entering.frames[0]!.transform).toContain("300px");
  const glyph = calls.find((call) => call.node.id === "sample")!;
  expect(glyph.frames[0]!.transform).toContain("scale(");
  expect(glyph.frames[0]!.transform).not.toBe("scale(1, 1)");
  expect(glyph.frames[0]!.opacity).toBe(0);
  expect(glyph.frames.at(-1)!.transform).toBe("scale(1, 1)");
  expect(glyph.frames.at(-1)!.opacity).toBe(1);
  layout.dispose();
  expect(root.querySelector("[data-layout-animating]")).toBeNull();
});


test("the source grid holds through the width commit and disposal restores its inline style", async () => {
  const { root, column, layout } = mount();
  const board = root.querySelector<HTMLElement>(".board")!;
  board.style.gridTemplateColumns = "";
  const style = document.createElement("style");
  style.textContent = ".kb .board { grid-template-columns: 220px 220px 220px 420px; }";
  root.prepend(style);
  layout.prepare();
  expect(board.style.gridTemplateColumns).toBe("220px 220px 220px 420px");
  column.dataset.wide = "1";
  expect(board.style.gridTemplateColumns).toBe("220px 220px 220px 420px");
  await mutations();
  expect(board.style.gridTemplateColumns).toBe("");
  layout.dispose();
  expect(board.style.gridTemplateColumns).toBe("");
  expect(column.style.width).toBe("");
});


test("an idle control that changes no width releases its preparation on the commit frame", async () => {
  const { root, column, calls, layout } = mount();
  layout.prepare();
  expect(root.dataset.columnLayout).toBe("pending");
  expect(column.style.width).toBe("220px");
  await mutations();
  expect(root.hasAttribute("data-column-layout")).toBe(false);
  expect(column.style.width).toBe("");
  expect(calls).toHaveLength(0);
});
