import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";

import { AccountRowOpening, OPENING_MS, revealRow } from "./AccountRowOpening";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement });
installActEnv();

const frames: Array<() => void> = [];
const globals = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown; matchMedia?: unknown };
const saved = { raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame, media: globals.matchMedia };
afterEach(() => {
  frames.length = 0;
  globals.requestAnimationFrame = saved.raf;
  globals.cancelAnimationFrame = saved.caf;
  globals.matchMedia = saved.media;
  document.body.replaceChildren();
});

/** A page that can animate: frames run when the test says so; `reduced` answers the reduced-motion query. */
function animatedPage(reduced: boolean) {
  globals.requestAnimationFrame = (callback: () => void) => frames.push(callback);
  globals.cancelAnimationFrame = () => {};
  globals.matchMedia = (query: string) => ({ matches: reduced && query.includes("reduce"), addEventListener() {}, removeEventListener() {} });
}
const runFrames = async () => { await act(async () => { while (frames.length) frames.shift()!(); }); };

async function mount(open: boolean, phone = false, onOpened?: () => void) {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const render = (next: boolean) => act(async () => root.render(<AccountRowOpening open={next} phone={phone} onOpened={onOpened}><button type="button">Make default</button></AccountRowOpening>));
  await render(open);
  return { host, render, unmount: () => act(async () => root.unmount()) };
}

test("a row opens over a height change of its own and a closed row draws nothing", async () => {
  animatedPage(false);
  const view = await mount(false);
  expect(view.host.querySelector("[data-account-opening]")).toBeNull();
  await view.render(true);
  const box = () => view.host.querySelector<HTMLElement>("[data-account-opening]")!;
  // Mounted closed first, so the height change has something to run from.
  expect(box().style.gridTemplateRows).toBe("0fr");
  await runFrames();
  expect(box().style.gridTemplateRows).toBe("1fr");
  expect(box().className).toContain("transition-[grid-template-rows]");
  expect(box().style.transitionDuration).toBe(`${OPENING_MS}ms`);
  expect(box().firstElementChild?.hasAttribute("inert")).toBe(false);
  await view.unmount();
});

test("reduced motion swaps the lines at once and leaves no transition running", async () => {
  animatedPage(true);
  const view = await mount(false);
  await view.render(true);
  const box = view.host.querySelector<HTMLElement>("[data-account-opening]")!;
  expect(box.style.gridTemplateRows).toBe("1fr");
  expect(box.className).not.toContain("transition");
  expect(box.style.transitionDuration).toBe("");
  expect(frames).toHaveLength(0);
  await view.render(false);
  expect(view.host.querySelector("[data-account-opening]")).toBeNull();
  await view.unmount();
});

test("a closing row is inert while its height change runs, and the lines go when it ends", async () => {
  animatedPage(false);
  let end: () => void = () => {};
  const finished = new Promise<void>((resolve) => { end = resolve; });
  const proto = dom.HTMLElement.prototype as unknown as { getAnimations?: () => Array<{ finished: Promise<void> }> };
  proto.getAnimations = () => [{ finished }];
  try {
    const view = await mount(false);
    await view.render(true);
    await runFrames();
    await view.render(false);
    const box = view.host.querySelector<HTMLElement>("[data-account-opening]")!;
    expect(box.firstElementChild?.hasAttribute("inert")).toBe(true);
    expect(box.getAttribute("data-account-opening")).toBe("closing");
    end();
    await act(async () => { await finished; });
    expect(view.host.querySelector("[data-account-opening]")).toBeNull();
    await view.unmount();
  } finally {
    delete proto.getAnimations;
  }
});

test("the phone's clip reaches the chevron's wider column", async () => {
  animatedPage(true);
  const view = await mount(true, true);
  expect(view.host.querySelector("[data-account-opening] > div")?.className).toContain("-mr-3.5");
  await view.unmount();
});

test("a row says it has opened at once under reduced motion, and only when its height change ends otherwise", async () => {
  let opened = 0;
  animatedPage(true);
  const still = await mount(false, false, () => { opened += 1; });
  await still.render(true);
  expect(opened).toBe(1);
  await still.unmount();

  animatedPage(false);
  opened = 0;
  let end: () => void = () => {};
  const finished = new Promise<void>((resolve) => { end = resolve; });
  const proto = dom.HTMLElement.prototype as unknown as { getAnimations?: () => Array<{ finished: Promise<void> }> };
  proto.getAnimations = () => [{ finished }];
  try {
    const view = await mount(false, false, () => { opened += 1; });
    await view.render(true);
    await runFrames();
    expect(opened).toBe(0);
    end();
    await act(async () => { await finished; });
    expect(opened).toBe(1);
    await view.render(false);
    expect(opened).toBe(1);
    await view.unmount();
  } finally {
    delete proto.getAnimations;
  }
});

/** A scroller with the room it shows and a row inside it; boxes are what the page would measure. */
function scene(scroller: { top: number; height: number; scrolled: number }, row: { top: number; height: number }, header = 0) {
  const outer = document.createElement("div");
  outer.style.overflowY = "auto";
  if (header) { const bar = document.createElement("header"); bar.style.position = "sticky"; outer.append(bar); bar.getBoundingClientRect = () => ({ height: header } as DOMRect); }
  const item = document.createElement("div");
  outer.append(item);
  document.body.append(outer);
  Object.defineProperty(outer, "clientHeight", { value: scroller.height });
  Object.defineProperty(outer, "scrollHeight", { value: 5000 });
  outer.scrollTop = scroller.scrolled;
  outer.getBoundingClientRect = () => ({ top: scroller.top, bottom: scroller.top + scroller.height, height: scroller.height } as DOMRect);
  // The row moves up by whatever the scroller scrolled since it was measured.
  const start = scroller.scrolled;
  item.getBoundingClientRect = () => { const top = row.top - (outer.scrollTop - start); return { top, bottom: top + row.height, height: row.height } as DOMRect; };
  return { outer, item };
}

test("a row opened below the fold scrolls to its last line, one taller than the room aligns its head, and a whole row stays", () => {
  const below = scene({ top: 100, height: 400, scrolled: 0 }, { top: 380, height: 260 });
  revealRow(below.item);
  expect(below.outer.scrollTop).toBe(140);
  const tall = scene({ top: 100, height: 400, scrolled: 0 }, { top: 300, height: 700 });
  revealRow(tall.item);
  expect(tall.outer.scrollTop).toBe(200);
  const whole = scene({ top: 100, height: 400, scrolled: 0 }, { top: 150, height: 200 });
  revealRow(whole.item);
  expect(whole.outer.scrollTop).toBe(0);
  const covered = scene({ top: 100, height: 400, scrolled: 90 }, { top: 110, height: 100 }, 40);
  revealRow(covered.item);
  expect(covered.outer.scrollTop).toBe(90 - 30);
});
