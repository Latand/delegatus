/**
 * The microphone hint on a page: asked once per load, shown by one composer,
 * gone for the device after a dismissal or a recording started under it.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { micHintRecordingStarted, resetMicHintForTests, useMicPermissionHint } from "./useMicPermissionHint";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
let state: string | null = "prompt";
let queries = 0;
const navigatorStub = {
  userAgent: IPHONE,
  maxTouchPoints: 5,
  get permissions() {
    return state === null ? undefined : { query: async () => { queries += 1; return { state }; } };
  },
};
(dom as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false });
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: navigatorStub, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
};
const SAVED: Record<string, unknown> = {};
const HAS: Record<string, boolean> = {};
beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = OVERRIDES[key];
  }
});
afterAll(async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
});

let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  dom.document.body.replaceChildren();
  dom.localStorage.clear();
  resetMicHintForTests();
  state = "prompt";
  queries = 0;
});

function Composer({ name }: { name: string }) {
  const { hint, dismiss } = useMicPermissionHint();
  return hint ? <button data-hint={hint} data-composer={name} onClick={dismiss} /> : <span data-composer={name} />;
}
function mount(node: React.ReactNode): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(node));
  return root;
}
const settle = async () => {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const hints = () => [...dom.document.querySelectorAll("[data-hint]")].map((element) => `${element.getAttribute("data-composer")}:${element.getAttribute("data-hint")}`);

test("prompt after a prior grant: one hint for the page, on the first composer, named for the browser", async () => {
  dom.localStorage.setItem("llv_mic_granted", "1");
  mount(<><Composer name="a" /><Composer name="b" /></>);
  await settle();
  expect(hints()).toEqual(["a:iosSafari"]);
  expect(queries).toBe(1);
});

test("a first-ever visit asks the browser nothing and shows nothing", async () => {
  mount(<Composer name="a" />);
  await settle();
  expect(hints()).toEqual([]);
  expect(queries).toBe(0);
});

test("granted, denied and a missing Permissions API show nothing", async () => {
  for (const answer of ["granted", "denied", null]) {
    dom.localStorage.setItem("llv_mic_granted", "1");
    state = answer;
    const root = mount(<Composer name="a" />);
    await settle();
    expect(hints()).toEqual([]);
    flushSync(() => root.unmount());
    roots = [];
    resetMicHintForTests();
  }
});

test("a dismissal hides it and the next page load stays quiet", async () => {
  dom.localStorage.setItem("llv_mic_granted", "1");
  mount(<Composer name="a" />);
  await settle();
  flushSync(() => (dom.document.querySelector("[data-hint]") as unknown as HTMLElement).click());
  expect(hints()).toEqual([]);
  expect(dom.localStorage.getItem("llv_mic_hint_seen")).toBe("1");
  resetMicHintForTests();
  mount(<Composer name="b" />);
  await settle();
  expect(hints()).toEqual([]);
});

test("a recording started under the hint leaves it up for this page and retires it for the next", async () => {
  dom.localStorage.setItem("llv_mic_granted", "1");
  mount(<Composer name="a" />);
  await settle();
  micHintRecordingStarted();
  expect(hints()).toEqual(["a:iosSafari"]);
  expect(dom.localStorage.getItem("llv_mic_hint_seen")).toBe("1");
});

test("a recording with no hint on screen retires nothing", async () => {
  mount(<Composer name="a" />);
  await settle();
  micHintRecordingStarted();
  expect(dom.localStorage.getItem("llv_mic_hint_seen")).toBeNull();
});

test("when the composer that shows the hint leaves, the next one takes it over", async () => {
  dom.localStorage.setItem("llv_mic_granted", "1");
  const first = mount(<Composer name="a" />);
  mount(<Composer name="b" />);
  await settle();
  expect(hints()).toEqual(["a:iosSafari"]);
  flushSync(() => first.unmount());
  roots = roots.filter((root) => root !== first);
  await settle();
  expect(hints()).toEqual(["b:iosSafari"]);
});
