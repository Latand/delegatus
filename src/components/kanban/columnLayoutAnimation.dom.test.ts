import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { COLUMN_LAYOUT_MS, installColumnLayoutAnimation } from "./columnLayoutAnimation";

let dom: Window;
beforeEach(() => {
  dom = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, { window: dom, document: dom.document });
});
const disposers: (() => void)[] = [];
afterEach(async () => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  await dom.happyDOM.waitUntilComplete();
  dom.close();
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
    return { cancel() { call.cancelled = true; }, pause() { if (call.cancelled) throw new Error("revived a cancelled effect"); }, play() {} };
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
const waitFor = async (ready: () => boolean) => {
  const deadline = performance.now() + 1000;
  while (!ready() && performance.now() < deadline) await mutations();
  expect(ready()).toBe(true);
};

test("pointer cancellation of warm-up keeps a committed native inverse until release", async () => {
  Object.defineProperty(dom, "CSSAnimation", { configurable: true, value: class {} });
  const frames = new Map<ReturnType<typeof dom.requestAnimationFrame>, FrameRequestCallback>();
  dom.requestAnimationFrame = (callback) => { const id = setImmediate(() => {}); frames.set(id, callback); return id; };
  dom.cancelAnimationFrame = (id) => { frames.delete(id); clearImmediate(id); };
  const { root, column, calls, layout } = mount();
  layout.prepare();
  column.dataset.wide = "1";
  await mutations();
  const inverse = calls.find((call) => call.node === column)!;
  expect(inverse.frames[0]!.transform).toContain("scale(0.5238095238095238, 1)");
  layout.cancelWarm();
  expect(inverse.cancelled).toBe(false);
  expect(root.hasAttribute("data-column-layout-active")).toBe(true);
  const queued = [...frames.values()]; frames.clear();
  expect(queued).toHaveLength(1);
  queued.forEach((callback) => callback(performance.now()));
  expect(calls.length).toBeGreaterThan(0);
  expect(root.dataset.columnLayout).toBe("running");
});

test("an authorized width button survives the idle preparation deadline", async () => {
  const frames = new Map<ReturnType<typeof dom.requestAnimationFrame>, FrameRequestCallback>();
  dom.requestAnimationFrame = (callback) => { const id = setImmediate(() => {}); frames.set(id, callback); return id; };
  dom.cancelAnimationFrame = (id) => { frames.delete(id); clearImmediate(id); };
  const { column, layout } = mount();
  let committed = 0;
  const next = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((callback) => callback(performance.now())); };
  layout.change(() => { committed++; column.dataset.wide = "1"; });
  next();
  expect(committed).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  for (let i = 0; i < 10 && !committed; i++) next();
  expect(committed).toBe(1);
});

test("paused inverse effects paint before play without backdating their clock", async () => {
  const originalRAF = dom.requestAnimationFrame, originalCancel = dom.cancelAnimationFrame;
  const frames = new Map<ReturnType<typeof dom.requestAnimationFrame>, FrameRequestCallback>();
  dom.requestAnimationFrame = (callback) => { const id = setImmediate(() => {}); frames.set(id, callback); return id; };
  dom.cancelAnimationFrame = (id) => { frames.delete(id); clearImmediate(id); };
  const { root, column, layout } = mount();
  let created = 0;
  let paused = 0;
  let inversePainted = false;
  const timeline = Object.getOwnPropertyDescriptor(document, "timeline");
  Object.defineProperty(document, "timeline", { configurable: true, get: () => ({ currentTime: inversePainted ? 200 : 100 }) });
  Object.defineProperty(dom.HTMLElement.prototype, "animate", { configurable: true, value(_frames: Keyframe[]) {
    expect(_frames[0]?.transform).toContain("scale("); created++;
    return { pause() { paused++; }, play() { expect(inversePainted).toBe(true); }, cancel() {}, set startTime(value: number) {
      expect(inversePainted).toBe(true); expect(value).toBeGreaterThanOrEqual(200);
    } };
  } });
  try {
    layout.prepare(); column.dataset.wide = "1";
    await mutations();
    expect(created).toBeGreaterThan(0);
    expect(paused).toBe(created);
    expect(root.dataset.columnLayout).toBe("inverted");
    const batch = [...frames.values()]; frames.clear();
    inversePainted = true;
    batch.forEach((callback) => callback(performance.now()));
    expect(created).toBeGreaterThan(0);
    expect(root.dataset.columnLayout).toBe("running");
  } finally {
    layout.dispose(); dom.requestAnimationFrame = originalRAF; dom.cancelAnimationFrame = originalCancel;
    if (timeline) Object.defineProperty(document, "timeline", timeline);
    else Reflect.deleteProperty(document, "timeline");
  }
});

test("width changes FLIP real columns and cards, preserve scroll, then release promotion", async () => {
  const { root, column, card, body, calls, layout } = mount();
  body.scrollTop = 75;
  layout.prepare();
  column.dataset.wide = "1";
  body.scrollTop = 95;
  await mutations();
  expect(body.scrollTop).toBe(95);
  // Reflow happens once; inverse transforms hold the original painted boxes.
  expect(column.style.width).toBe("");
  expect(card.getBoundingClientRect().height).toBe(120);
  const frame = calls.find((call) => call.node === column)!;
  expect(frame.frames[0]!.transform).toBe("translate(200px, 0px) scale(0.5238095238095238, 1)");
  expect(frame.frames[1]!.transform).toBe("translate(0px, 0px) scale(1, 1)");
  expect(frame.timing.duration).toBe(COLUMN_LAYOUT_MS);
  const content = calls.find((call) => call.node.id === "sample")!;
  expect(content.frames.every((frame) => frame.opacity === undefined)).toBe(true);
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
  expect(calls.filter((call) => call.node.id === "sample").every((call) => call.frames.every((frame) => frame.opacity === undefined))).toBe(true);
  expect(card.hasAttribute("data-layout-animating")).toBe(false);
  expect(calls.every((call) => call.cancelled)).toBe(true);
});

test("keyboard navigation keeps a reader reveal before its scroll event arrives", async () => {
  const { root, column, body, calls } = mount();
  body.scrollTop = 75;
  document.dispatchEvent(new dom.KeyboardEvent("keydown", { altKey: true, code: "KeyJ" }) as unknown as KeyboardEvent);
  column.dataset.wide = "1";
  body.scrollTop = 125;
  await mutations();
  expect(body.scrollTop).toBe(125);
  expect(calls).toHaveLength(0);
  expect(column.style.width).toBe("");
  expect(root.hasAttribute("data-column-layout")).toBe(false);
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

test("idle capture uses the measured border boxes without resolving skipped card sizes", () => {
  const { column, card, layout } = mount();
  card.getBoundingClientRect = () => new dom.DOMRect(812, 1200, 196, 132) as unknown as DOMRect;
  const original = dom.getComputedStyle;
  dom.getComputedStyle = (node: Parameters<typeof dom.getComputedStyle>[0]) => {
    const style = original.call(dom, node);
    return (node as unknown) === card ? new Proxy(style, { get(target, key) {
      if (key === "width" || key === "height") throw new Error("resolved a skipped card's layout size");
      return Reflect.get(target, key, target);
    } }) : style;
  };
  try {
    layout.prepare();
    expect(column.style.width).toBe("220px");
  } finally { dom.getComputedStyle = original; }
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
  expect(glyph.frames[0]!.opacity).toBeUndefined();
  expect(glyph.frames.at(-1)!.transform).toBe("scale(1, 1)");
  expect(glyph.frames.at(-1)!.opacity).toBeUndefined();
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


test("a neighbour whose width stays fixed slides as one wrapper without text effects", async () => {
  const { root, column, calls, layout } = mount();
  const board = root.querySelector<HTMLElement>(".board")!;
  board.style.gridTemplateColumns = "220px 220px 240px 420px";
  const neighbour = document.createElement("section");
  neighbour.className = "column";
  neighbour.dataset.status = "blocked";
  neighbour.dataset.wide = "0";
  neighbour.innerHTML = '<div class="col-body"><article class="card"><button>Fixed wrapping</button></article></div>';
  board.prepend(neighbour);
  const card = neighbour.querySelector<HTMLElement>(".card")!;
  const left = () => column.dataset.wide === "0" ? 500 : 300;
  neighbour.getBoundingClientRect = () => new dom.DOMRect(left(), 100, 240, 600) as unknown as DOMRect;
  neighbour.querySelector<HTMLElement>(".col-body")!.getBoundingClientRect = () => new dom.DOMRect(left(), 150, 240, 550) as unknown as DOMRect;
  card.getBoundingClientRect = () => new dom.DOMRect(left() + 12, 160, 216, 100) as unknown as DOMRect;
  layout.prepare();
  column.dataset.wide = "1";
  await mutations();
  const frame = calls.find((call) => call.node === neighbour)!;
  expect(frame.frames[0]!.transform).toBe("translate(200px, 0px) scale(1, 1)");
  expect(frame.frames[1]!.transform).toBe("translate(0px, 0px) scale(1, 1)");
  await new Promise((resolve) => dom.setTimeout(resolve, COLUMN_LAYOUT_MS + 80));
  expect(calls.filter((call) => neighbour.contains(call.node) && call.node !== neighbour)).toHaveLength(0);
  expect(neighbour.querySelector("[data-layout-animating]")).toBeNull();
  expect(neighbour.style.width).toBe("");
});


test("programmatic scrolling retains its position before the event and then interrupts motion", async () => {
  const { root, column, body, layout } = mount();
  body.scrollTop = 75;
  layout.prepare();
  column.dataset.wide = "1";
  await mutations();
  body.scrollTop = 125;
  // No scroll event yet: a caller may run earlier in the same RAF batch.
  await new Promise((resolve) => dom.setTimeout(resolve, 140));
  expect(body.scrollTop).toBe(125);
  body.dispatchEvent(new dom.Event("scroll") as unknown as Event);
  expect(root.hasAttribute("data-column-layout")).toBe(false);
  expect(column.style.width).toBe("");
});

test("live height changes survive the width effect and its cleanup", async () => {
  for (const kind of ["class", "style", "text"] as const) {
    const { root, column, card, calls, layout } = mount();
    layout.prepare();
    column.dataset.wide = "1";
    await mutations();
    const read = card.getBoundingClientRect.bind(card);
    card.getBoundingClientRect = () => {
      const rect = read();
      return new dom.DOMRect(rect.left, rect.top, rect.width, rect.width < 300 ? 240 : 160) as unknown as DOMRect;
    };
    if (kind === "class") card.classList.add("updated");
    else if (kind === "style") card.style.minHeight = "160px";
    else card.querySelector("button")!.textContent = "A longer title";
    await new Promise((resolve) => dom.setTimeout(resolve, COLUMN_LAYOUT_MS + 80));
    expect(card.getBoundingClientRect().height).toBe(160);
    expect(card.style.height).toBe("");
    expect(root.hasAttribute("data-column-layout")).toBe(false);
    expect(calls.every((call) => call.cancelled)).toBe(true);
    layout.dispose(); root.remove();
  }
});


test("warm-up retains its batched source when the commit precedes promotion completion", async () => {
  const originalRAF = dom.requestAnimationFrame, originalCancel = dom.cancelAnimationFrame;
  const frames = new Map<ReturnType<typeof dom.requestAnimationFrame>, FrameRequestCallback>();
  dom.requestAnimationFrame = (callback) => { const id = setImmediate(() => {}); frames.set(id, callback); return id; };
  dom.cancelAnimationFrame = (id) => { frames.delete(id); clearImmediate(id); };
  const { root, column, card, layout } = mount();
  card.insertAdjacentHTML("beforeend", "<span>Content</span>".repeat(16));
  const read = card.getBoundingClientRect.bind(card);
  let reads = 0;
  card.getBoundingClientRect = () => { reads++; return read(); };
  try {
    layout.warm("done");
    layout.change(() => { column.dataset.wide = "1"; });
    for (let i = 0; i < 12 && root.dataset.columnLayout !== "running"; i++) {
      const batch = [...frames.values()]; frames.clear();
      batch.forEach((callback) => callback(performance.now()));
      await mutations();
    }
    expect(root.dataset.columnLayout).toBe("running");
    expect(reads).toBe(2); // One source batch, one destination batch.
  } finally {
    layout.dispose(); dom.requestAnimationFrame = originalRAF; dom.cancelAnimationFrame = originalCancel;
  }
});

test("a live update painted during warming becomes the first inverse source pose", async () => {
  const originalRAF = dom.requestAnimationFrame;
  const originalCancel = dom.cancelAnimationFrame;
  const frames = new Map<ReturnType<typeof dom.requestAnimationFrame>, FrameRequestCallback>();
  dom.requestAnimationFrame = (callback) => { const id = setImmediate(() => {}); frames.set(id, callback); return id; };
  dom.cancelAnimationFrame = (id) => { frames.delete(id); clearImmediate(id); };
  const { root, column, card, calls, layout } = mount();
  const read = card.getBoundingClientRect.bind(card);
  let height = 180;
  card.getBoundingClientRect = () => {
    const rect = read();
    return new dom.DOMRect(rect.left, rect.top, rect.width, height) as unknown as DOMRect;
  };
  card.insertAdjacentHTML("beforeend", '<span>More text</span>'.repeat(16));
  const frame = () => {
    const batch = [...frames.values()]; frames.clear();
    batch.forEach((callback) => callback(0));
  };
  try {
    layout.warm("done"); frame();
    expect(root.dataset.columnLayout).toBe("warming");
    height = 240;
    card.querySelector("button")!.textContent = "A live title update";
    await mutations();
    layout.change(() => { column.dataset.wide = "1"; });
    for (let i = 0; i < 30 && root.dataset.columnLayout !== "running"; i++) { frame(); await mutations(); }
    expect(root.dataset.columnLayout).toBe("running");
    // The newly painted card must not shrink back to its older 180px height.
    const inverse = calls.find((call) => call.node === card);
    expect(inverse?.frames[0]?.transform ?? "none").not.toContain("0.75");
  } finally {
    layout.dispose();
    dom.requestAnimationFrame = originalRAF; dom.cancelAnimationFrame = originalCancel;
  }
});


test("a card added after warming joins the fresh source capture", async () => {
  const originalRAF = dom.requestAnimationFrame, originalCancel = dom.cancelAnimationFrame;
  const frames = new Map<ReturnType<typeof dom.requestAnimationFrame>, FrameRequestCallback>();
  dom.requestAnimationFrame = (callback) => { const id = setImmediate(() => {}); frames.set(id, callback); return id; };
  dom.cancelAnimationFrame = (id) => { frames.delete(id); clearImmediate(id); };
  const { root, column, card, calls, layout } = mount();
  const frame = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((callback) => callback(performance.now())); };
  try {
    layout.warm("done");
    for (let i = 0; i < 10 && root.dataset.columnLayout !== "pending"; i++) frame();
    expect(root.dataset.columnLayout).toBe("pending");
    const added = document.createElement("article"); added.className = "card";
    added.innerHTML = "<button>A task arriving during dwell</button>";
    added.getBoundingClientRect = () => { const rect = card.getBoundingClientRect(); return new dom.DOMRect(rect.left, 400, rect.width, 100) as unknown as DOMRect; };
    column.querySelector(".col-body")!.append(added);
    await mutations();
    layout.change(() => { column.dataset.wide = "1"; });
    for (let i = 0; i < 12 && root.dataset.columnLayout !== "running"; i++) { await mutations(); frame(); }
    expect(root.dataset.columnLayout).toBe("running");
    expect(calls.some((call) => call.node === added)).toBe(true);
    expect(calls.some((call) => call.node === added.firstElementChild)).toBe(true);
  } finally {
    layout.dispose(); dom.requestAnimationFrame = originalRAF; dom.cancelAnimationFrame = originalCancel;
  }
});

test("cards and content added during motion receive their own FLIP and counter-scales", async () => {
  const { root, column, card, calls, layout } = mount();
  layout.prepare(); column.dataset.wide = "1";
  await mutations();
  expect(root.dataset.columnLayout).toBe("running");
  // Model a currently painted compositor pose. Once the old effect is
  // cancelled, destination reads return the natural final layout again.
  const columnRect = column.getBoundingClientRect.bind(column);
  const cardRect = card.getBoundingClientRect.bind(card);
  const moving = () => calls.some((call) => call.node === column && !call.cancelled);
  column.getBoundingClientRect = () => {
    const rect = columnRect();
    return moving() ? new dom.DOMRect(rect.left + 60, rect.top, 330, rect.height) as unknown as DOMRect : rect;
  };
  card.getBoundingClientRect = () => {
    const rect = cardRect();
    return moving() ? new dom.DOMRect(rect.left + 60, rect.top, 306, rect.height) as unknown as DOMRect : rect;
  };
  const added = document.createElement("article"); added.className = "card";
  added.innerHTML = '<button id="arriving">A newly arriving task</button>';
  added.getBoundingClientRect = () => {
    const rect = card.getBoundingClientRect();
    return new dom.DOMRect(rect.left, 400, rect.width, 100) as unknown as DOMRect;
  };
  column.querySelector(".col-body")!.append(added);
  const paragraph = document.createElement("p"); paragraph.textContent = "New task details";
  card.append(paragraph);
  await waitFor(() => calls.some((call) => call.node === paragraph));
  for (const node of [added.querySelector("button")!, paragraph]) {
    const effects = calls.filter((call) => call.node === node);
    expect(effects.length).toBeGreaterThan(0);
    expect(effects[0]!.frames[0]!.transform).toContain("scale(");
    expect(node.dataset.layoutAnimating).toBe("content");
  }
  await new Promise((resolve) => dom.setTimeout(resolve, COLUMN_LAYOUT_MS + 80));
  expect(calls.some((call) => call.node === added)).toBe(true);
  expect(root.hasAttribute("data-column-layout")).toBe(false);
  expect(added.querySelector("[data-layout-animating]")).toBeNull();
});

test("a no-op control during warming releases its temporary layers", async () => {
  const originalRAF = dom.requestAnimationFrame;
  const originalCancel = dom.cancelAnimationFrame;
  const frames = new Map<ReturnType<typeof dom.requestAnimationFrame>, FrameRequestCallback>();
  dom.requestAnimationFrame = (callback) => { const id = setImmediate(() => {}); frames.set(id, callback); return id; };
  dom.cancelAnimationFrame = (id) => { frames.delete(id); clearImmediate(id); };
  const { root, column, card, layout } = mount();
  card.insertAdjacentHTML("beforeend", '<span>Visible content</span>'.repeat(16));
  const frame = () => {
    const batch = [...frames.values()]; frames.clear();
    batch.forEach((callback) => callback(0));
  };
  try {
    layout.warm("done"); frame();
    expect(root.dataset.columnLayout).toBe("warming");
    layout.change(() => {});
    for (let i = 0; i < 30; i++) { frame(); await mutations(); }
    expect(root.hasAttribute("data-column-layout")).toBe(false);
    expect(column.style.width).toBe("");
    expect(root.querySelector("[data-layout-animating]")).toBeNull();
  } finally {
    layout.dispose();
    dom.requestAnimationFrame = originalRAF; dom.cancelAnimationFrame = originalCancel;
  }
});

test("the latest width choice retires an older, longer promotion queue", async () => {
  const originalRAF = dom.requestAnimationFrame, originalCancel = dom.cancelAnimationFrame;
  const frames = new Map<ReturnType<typeof dom.requestAnimationFrame>, FrameRequestCallback>();
  dom.requestAnimationFrame = (callback) => { const id = setImmediate(() => {}); frames.set(id, callback); return id; };
  dom.cancelAnimationFrame = (id) => { frames.delete(id); clearImmediate(id); };
  const { root, layout: initial } = mount(); initial.dispose();
  const board = root.querySelector<HTMLElement>(".board")!; board.replaceChildren();
  for (const [index, status] of ["inbox", "assigned", "blocked", "done"].entries()) {
    const column = document.createElement("section"); column.className = "column";
    column.dataset.status = status; column.dataset.wide = status === "assigned" ? "1" : "0";
    column.innerHTML = '<div class="col-head"><button>Head</button></div><div class="col-body">' +
      '<article class="card"><button>Title</button><span>Footer</span></article>'.repeat(status === "inbox" ? 12 : 1) + '</div>';
    board.append(column);
    for (const node of [column, ...column.querySelectorAll<HTMLElement>(".card,.col-head,.col-body")]) {
      node.getBoundingClientRect = () => new dom.DOMRect(index * 250, node === column ? 0 : 60,
        parseFloat(column.style.width) || (column.dataset.wide === "1" ? 420 : 220),
        node === column || node.matches(".col-body") ? 650 : 70) as unknown as DOMRect;
    }
  }
  const layout = installColumnLayoutAnimation(root);
  const committed: string[] = [];
  const update = (status: string) => () => {
    committed.push(status);
    for (const column of board.querySelectorAll<HTMLElement>(".column")) column.dataset.wide = column.dataset.status === status ? "1" : "0";
  };
  const frame = async () => {
    const batch = [...frames.values()]; frames.clear();
    batch.forEach((callback) => callback(performance.now()));
    await mutations();
  };
  try {
    layout.change(update("inbox"), undefined, "inbox"); await frame(); await frame();
    layout.change(update("done"), undefined, "done");
    for (let i = 0; i < 70; i++) await frame();
    expect(committed).toEqual(["done"]);
    expect(board.querySelector<HTMLElement>('.column[data-wide="1"]')?.dataset.status).toBe("done");
    expect(root.hasAttribute("data-column-layout")).toBe(false);
  } finally {
    layout.dispose(); dom.requestAnimationFrame = originalRAF; dom.cancelAnimationFrame = originalCancel;
  }
});

test("header controls replaced by a width commit do not start a second FLIP", async () => {
  const { root, column, calls, layout } = mount();
  layout.warm("done"); await mutations();
  layout.change(() => {
    column.dataset.wide = "1";
    const pin = document.createElement("button"); pin.textContent = "Pin";
    column.querySelector(".col-head")!.append(pin);
  });
  await waitFor(() => root.dataset.columnLayout === "running");
  expect(calls.filter(({ node }) => node === column)).toHaveLength(1);
});

test("cancelling a warmed source restores widths and temporary layers", async () => {
  const { root, column, layout } = mount();
  layout.warm("done");
  await mutations();
  expect(column.style.width).toBe("220px");
  layout.cancelWarm();
  expect(column.style.width).toBe("");
  expect(root.hasAttribute("data-column-layout")).toBe(false);
  expect(root.querySelector("[data-layout-animating]")).toBeNull();
});

test("retargeting a held inverse never revives cancelled effects", async () => {
  const originalRAF = dom.requestAnimationFrame, originalCancel = dom.cancelAnimationFrame;
  const frames = new Map<ReturnType<typeof dom.requestAnimationFrame>, FrameRequestCallback>();
  dom.requestAnimationFrame = (callback) => { const id = setImmediate(() => {}); frames.set(id, callback); return id; };
  dom.cancelAnimationFrame = (id) => { frames.delete(id); clearImmediate(id); };
  const { root, column, layout } = mount();
  const frame = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((callback) => callback(0)); };
  try {
    layout.prepare(); column.dataset.wide = "1";
    await mutations();
    frame(); // Release the painted inverse; the clock starts here.
    await new Promise((resolve) => dom.setTimeout(resolve, 90));
    frame(); // A painted frame before the replacement effects.
    expect(column.style.width).toBe("");
    layout.change(() => { column.dataset.wide = "0"; });
    for (let i = 0; i < 8 && root.dataset.columnLayout !== "running"; i++) { await mutations(); frame(); }
    expect(root.dataset.columnLayout).toBe("running");
  } finally {
    layout.dispose(); dom.requestAnimationFrame = originalRAF; dom.cancelAnimationFrame = originalCancel;
  }
});

test("a four-column retarget at 32ms RAF cadence completes every reveal before cleanup", async () => {
  const originalRAF = dom.requestAnimationFrame;
  const originalCancel = dom.cancelAnimationFrame;
  const originalStyle = dom.getComputedStyle;
  dom.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 32) as unknown as ReturnType<typeof dom.requestAnimationFrame>;
  dom.cancelAnimationFrame = (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  Object.defineProperty(dom, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  type Effect = { frames: Keyframe[]; timing: KeyframeAnimationOptions; currentTime: number };
  const effects = new Map<HTMLElement, Effect>();
  const calls: { node: HTMLElement; effect: Effect }[] = [];
  Object.defineProperty(dom.HTMLElement.prototype, "animate", { configurable: true, value(this: HTMLElement, frames: Keyframe[], timing: KeyframeAnimationOptions) {
    let started = performance.now(), paused: number | null = null;
    const effect = { frames, timing, get currentTime() { return (paused ?? performance.now()) - started; } };
    effects.set(this, effect); calls.push({ node: this, effect });
    return { get currentTime() { return effect.currentTime; }, pause() { paused = performance.now(); }, play() {
      if (paused !== null) { started += performance.now() - paused; paused = null; }
    }, cancel: () => { if (effects.get(this) === effect) effects.delete(this); } };
  } });
  const root = document.createElement("div"); root.className = "kb";
  root.innerHTML = '<div class="board"></div>'; document.body.append(root);
  const board = root.firstElementChild as HTMLElement;
  const statuses = ["inbox", "assigned", "blocked", "done"];
  let wide = "assigned";
  const tracks = () => board.style.gridTemplateColumns ? board.style.gridTemplateColumns.split(" ").map(Number.parseFloat) : statuses.map((status) => status === wide ? 420 : 220);
  dom.getComputedStyle = (node: Parameters<typeof dom.getComputedStyle>[0]) => {
    const style = originalStyle.call(dom, node);
    return (node as unknown) === board ? new Proxy(style, { get(target, key) {
      if (key === "gridTemplateColumns") return tracks().map((width) => `${width}px`).join(" ");
      return Reflect.get(target, key, target);
    } }) : style;
  };
  const pose = (node: HTMLElement) => {
    const effect = effects.get(node);
    const parse = (value: Keyframe["transform"]) => {
      const transform = String(value), translate = transform.match(/translate\(([-.\d]+)px, ([-.\d]+)px\)/), scale = transform.match(/scale\(([-.\d]+), ([-.\d]+)\)/);
      return { dx: Number(translate?.[1] ?? 0), dy: Number(translate?.[2] ?? 0), sx: Number(scale?.[1] ?? 1), sy: Number(scale?.[2] ?? 1) };
    };
    if (!effect) return parse("none");
    const q = Math.max(0, Math.min(1, effect.currentTime / Number(effect.timing.duration)));
    const before = parse(effect.frames[0]!.transform), after = parse(effect.frames.at(-1)!.transform);
    return { dx: before.dx + (after.dx - before.dx) * q, dy: before.dy + (after.dy - before.dy) * q, sx: before.sx + (after.sx - before.sx) * q, sy: before.sy + (after.sy - before.sy) * q };
  };
  for (const [index, status] of statuses.entries()) {
    const column = document.createElement("section"); column.className = "column"; column.dataset.status = status; column.dataset.wide = status === wide ? "1" : "0";
    column.innerHTML = `<div class="col-body"><article class="card"><button data-owner="${status}">Sample</button></article></div>`; board.append(column);
    const layoutBox = () => { const sizes = tracks(); return new dom.DOMRect(sizes.slice(0, index).reduce((a, b) => a + b, 0) + index * 12, 100, parseFloat(column.style.width) || sizes[index], 600); };
    const rect = () => { const box = layoutBox(), p = pose(column); return new dom.DOMRect(box.left + p.dx, box.top + p.dy, box.width * p.sx, box.height * p.sy) as unknown as DOMRect; };
    column.getBoundingClientRect = rect; column.querySelector<HTMLElement>(".col-body")!.getBoundingClientRect = rect;
    const card = column.querySelector<HTMLElement>(".card")!;
    card.getBoundingClientRect = () => {
      const natural = layoutBox(), paint = rect(), own = pose(card), px = paint.width / natural.width, py = paint.height / natural.height;
      return new dom.DOMRect(paint.left + (12 + own.dx) * px, paint.top + (60 + own.dy) * py, (natural.width - 24) * px * own.sx, (natural.width < 300 ? 180 : 120) * py * own.sy) as unknown as DOMRect;
    };
  }
  const update = (next: string) => { wide = next; for (const column of board.children) (column as HTMLElement).dataset.wide = (column as HTMLElement).dataset.status === next ? "1" : "0"; };
  const layout = installColumnLayoutAnimation(root); disposers.push(layout.dispose);
  try {
    layout.prepare(); update("inbox");
    for (let i = 0; i < 200 && root.dataset.columnLayout !== "running"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(root.dataset.columnLayout).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 35));
    const cut = calls.length;
    layout.prepare(); update("done");
    await waitFor(() => calls.slice(cut).some(({ node }) => node.matches(".column")));
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const retarget = calls.slice(cut);
    expect(new Set(retarget.filter(({ node }) => node.matches(".column")).map(({ node }) => node.dataset.status))).toEqual(new Set(statuses));
    const reveals = retarget.filter(({ node, effect }) => node.hasAttribute("data-owner") && effect.frames.at(-1)!.transform === "scale(1, 1)");
    expect(new Set(reveals.map(({ node }) => node.dataset.owner))).toEqual(new Set(statuses));
    expect(reveals.every(({ effect }) => Number(effect.timing.duration) >= 80)).toBe(true);
    expect(root.hasAttribute("data-column-layout")).toBe(false);
    expect([...board.children].map((node) => (node as HTMLElement).style.width)).toEqual(["", "", "", ""]);
  } finally {
    layout.dispose(); dom.requestAnimationFrame = originalRAF; dom.cancelAnimationFrame = originalCancel; dom.getComputedStyle = originalStyle;
  }
});

test("a warmed board follows its ancestor moving before the width commit", async () => {
  const { root, column, card, calls, layout } = mount();
  const beforeColumn = column.getBoundingClientRect, beforeCard = card.getBoundingClientRect;
  let shift = 0;
  column.getBoundingClientRect = () => { const r = beforeColumn(); return new dom.DOMRect(r.left, r.top + shift, r.width, r.height) as unknown as DOMRect; };
  card.getBoundingClientRect = () => { const r = beforeCard(); return new dom.DOMRect(r.left, r.top + shift, r.width, r.height) as unknown as DOMRect; };
  layout.warm("done");
  await waitFor(() => root.dataset.columnLayout === "pending");
  shift = 40;
  layout.change(() => { column.dataset.wide = "1"; }, undefined, "done");
  await waitFor(() => calls.some((call) => call.node === column));
  expect(calls.find((call) => call.node === column)!.frames[0]!.transform).toBe("translate(200px, 0px) scale(0.5238095238095238, 1)");
});
