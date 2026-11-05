import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";

import { AccountRowOpening, OPENING_MS } from "./AccountRowOpening";

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

async function mount(open: boolean, phone = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const render = (next: boolean) => act(async () => root.render(<AccountRowOpening open={next} phone={phone}><button type="button">Make default</button></AccountRowOpening>));
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
